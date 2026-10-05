import "server-only";

import {
  BA_SOURCE_ID,
  BaFetchFailure,
  fetchOpportunityWindowCached,
} from "@/lib/opportunities/search";
import type {
  Opportunity,
  OpportunitySearchParams,
  OpportunityWindow,
} from "@/lib/opportunities/types";
import {
  getWebSearchClient,
  MAX_TAVILY_REQUESTS_PER_RUN,
  type WebSearchClient,
} from "@/lib/web-search";
import { generateSearchQueries } from "./queries";
import { enabledAdapters } from "./adapters";
import type { NormalizedOffer, OfferSourceAdapter } from "./adapter";
import { emailConfidenceOf } from "./accept";
import {
  candidateFromOffer,
  companyFactsFromOffer,
  discoveryBeginnGate,
  goalPasses,
  mapToSearchParams,
  type DiscoveryOffer,
} from "./normalize";
import {
  companyKeyOf,
  CompanyIdentityIndex,
  isUsableCompanyName,
} from "./dedupe";
import { createCamofoxClient, type CamofoxClient } from "./camofox/client";
import {
  runBrowserDiscovery,
  type BrowserSourceResult,
} from "./camofox/browser-source";
import { crawlCompanySite } from "./camofox/deep-crawl";
import { createFetchContext, type FetchContext } from "./fetch-guard";
import {
  applicationUrlOf,
  countsAsResult,
  createGuardedSiteFetcher,
  resolveCompanyEmails,
  resolveOfficialSite,
  type OfficialSiteResolution,
} from "./emails";
import {
  ResearchPlanner,
  type ResearchMemoryStore,
} from "./planner";
import { buildCompanyEvidence, companyConfidence } from "./confidence";
import { discoverCompanySiteOffers } from "./company-site";
import {
  COMPANY_WEBSITES_LAYER,
  PORTAL_SOURCES,
  policySkippedSources,
  sourceById,
} from "./sources";
import {
  TERMINAL_RUN_STATUSES,
  discoveryEmailSitePasses,
  discoveryLimits,
  type DiscoveryCandidate,
  type DiscoveryRun,
  type DiscoveryRunParams,
  type DiscoverySourceStatus,
  type SourceReportEntry,
} from "./types";
import {
  finishDiscoveryRun,
  getDiscoveryRun,
  getResearchMemory,
  listRunCompaniesWithEmails,
  recordCandidates,
  recordCompany,
  recordCompanyEmail,
  setCompanyApplicationUrlIfMissing,
  setRunCounters,
  startDiscoveryRun,
} from "./runs";

/**
 * Company Discovery — the orchestrator.
 *
 * Pipeline: run (Phase 1 model) → per-goal passes over (a) the internet-
 * discovery layer — the bounded search adapter FIRST, checkpointed on its
 * own — then (b) the remaining portal adapters the access policy cleared,
 * then (c) the EXISTING Opportunities engine (Arbeitsagentur: offers and
 * companies ONLY — never an email, §3.3) → unique companies → the multi-
 * source public-email pass → incremental persistence. Every discovery phase
 * is checkpointed before the next one starts: on a serverless host the run
 * shares the route's invocation budget (Vercel `maxDuration`) and can be
 * killed at any instant, so the highest-value phase must reach the database
 * first — a kill may delay or drop later phases, never the search layer's
 * persisted results.
 *
 * Hard rules:
 *  - TARGET counts UNIQUE COMPANIES, never offers;
 *  - a blocked source or a failing company NEVER stops the run: every company
 *    runs inside its own error boundary and every source inside its own
 *    circuit breaker (§4.7);
 *  - outcomes stay distinct end to end: `email_found`, `no_public_email` and
 *    `source_blocked` are never merged, and a block is never reported as "no
 *    public email" (§4.4);
 *  - `restricted` / `unverified` portals are never requested. They are
 *    registered and reported as `skipped_by_policy`;
 *  - every counter written is a real, measured value, and
 *    `emailsFound + noPublicEmail + sourcesBlocked === companiesProcessed`;
 *  - cancellation is honored between work units and is never overwritten by a
 *    finish state.
 */

/**
 * Page-fetch budget for the public-email pass, per run. Env-tunable
 * (`DISCOVERY_MAX_EMAIL_SITE_PASSES`) so an operator can trade depth for
 * wall-clock without a deploy; companies beyond it are reported as
 * inconclusive (see {@link discoveryEmailSitePasses}).
 */
/** Offers processed between run re-reads (cancellation granularity). */
const CANCEL_CHECK_EVERY = 25;
/** Candidate upserts per DB round trip. */
const CANDIDATE_FLUSH_EVERY = 50;
/** Hard cap on upstream pagination pages per pass (10 × 50 = 500). */
const MAX_UPSTREAM_PAGES = 10;

/**
 * Provider queries per agentic batch. Small enough that a batch finishes
 * quickly (each batch = one checkpoint + one verification round), large
 * enough that the planner's feedback loop stays meaningful (a batch that
 * measures one query is noise, not a strategy).
 */
const AGENTIC_BATCH_SIZE = 4;

/** Audit reasons recorded with a rejected company. */
const REJECT_NO_PUBLIC_EMAIL = "no_public_email";
const REJECT_SOURCE_BLOCKED = "source_blocked";
const REJECT_NO_WEBSITE = "no_website_found";

export interface DiscoveryPipelineDeps {
  /** Window provider (BA). Injectable for tests. */
  window?: (params: OpportunitySearchParams) => Promise<OpportunityWindow>;
  /** Cancellation probe. Default: re-read the run. */
  isCancelled?: (runId: string, userId: string) => Promise<boolean>;
  /** Adapters to run. Default: every adapter the policy enabled. */
  adapters?: ReturnType<typeof enabledAdapters>;
  /** Guarded-fetch context. Default: a fresh one (per run, never shared). */
  fetchContext?: FetchContext;
  /** The permitted public-search client used for the EMAIL-lookup step. */
  searchClient?: ReturnType<typeof getWebSearchClient>;
  /**
   * The permitted public-search client used for the OFFER-discovery layer
   * (its own bounded per-run budget, independent of the email lookup).
   * Default: a fresh provider client, or null when none is configured.
   */
  offerSearchClient?: WebSearchClient | null;
  /** Test seam: does this fresh context's SSRF guard consider a host public? */
  isPublicHost?: (hostname: string) => Promise<boolean>;
  /** Test seam: the run clock (runtime budget). Default: Date.now. */
  now?: () => number;
  /**
   * The run's anti-detection browser (Camofox). Injectable for tests; default:
   * a fresh client when the engine is configured (else null → HTTP-only run,
   * exactly the legacy behavior).
   */
  camofoxClient?: CamofoxClient | null;
}

/** The host of a URL, lowercased (www stripped), or "" when unparseable. */
function hostOfUrl(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export async function runDiscoveryPipeline(
  runId: string,
  userId: string,
  deps: DiscoveryPipelineDeps = {},
): Promise<DiscoveryRun> {
  const windowFn = deps.window ?? fetchOpportunityWindowCached;
  const isCancelled =
    deps.isCancelled ??
    (async (id: string, uid: string) => {
      const run = await getDiscoveryRun(id, uid);
      return (
        run === null ||
        (TERMINAL_RUN_STATUSES.includes(run.status) && run.status !== "running")
      );
    });

  const run0 = await getDiscoveryRun(runId, userId);
  if (!run0) throw new Error("Discovery run not found.");
  if (TERMINAL_RUN_STATUSES.includes(run0.status)) return run0;

  await startDiscoveryRun(runId, userId);

  const limits = discoveryLimits();
  const params = run0.params;
  const target = Math.min(params.targetCompanies, limits.maxCandidates);
  const maxCompanies = limits.maxCompaniesToResolve;

  // ---- the checkpoint (agentic engine: continue = new batch, same run) ----
  // A fresh run starts from zero; a CONTINUE batch (POST /[runId]/continue)
  // starts from the persisted counters and rebuilds the dedupe state from the
  // companies the previous batches already stored — so an already-verified
  // company is never processed again, and the counters keep counting instead
  // of resetting. Everything read here is a real persisted row, never an
  // estimate.
  const prior = run0.progress;
  const hasCheckpoint =
    prior.foundCompanies > 0 ||
    prior.uniqueCompanies > 0 ||
    prior.companiesProcessed > 0;
  const identity = new CompanyIdentityIndex();
  /** Company keys that failed a gate so far (event counting, no rows). */
  const rejectedKeys = new Set<string>();
  /**
   * The run's RESEARCH MEMORY (agentic engine): the strategy space the
   * previous batches already built (issued queries, discovered entities,
   * per-goal planner state). A continue batch restores its planners from it —
   * it does not start the research over.
   */
  const priorMemories: ResearchMemoryStore | null = hasCheckpoint
    ? await getResearchMemory(runId, userId).catch(() => null)
    : null;
  if (hasCheckpoint) {
    const stored = await listRunCompaniesWithEmails(runId, userId);
    for (const company of stored) {
      if (company.status === "accepted") {
        identity.mark(
          company.companyKey,
          company.websiteUrl,
          company.emails[0]?.email ?? null,
        );
      } else {
        rejectedKeys.add(company.companyKey);
      }
    }
  }

  // ---- the runtime budget (a loop guard that also stops HONEST runs) ----
  // MAX_RUNTIME is enforced at the checkpoint boundaries: when it elapses the
  // remaining work stops and the run finishes from its measured counters
  // (partial). It can never produce a loop — the planner's honest exhaustion,
  // the budget gates and this clock are three independent stop conditions.
  const now = deps.now ?? Date.now;
  const runStartedAt = now();
  let runtimeExceeded = false;
  const runtimeBudgetExceeded = (): boolean => {
    if (runtimeExceeded) return true;
    if (now() - runStartedAt >= limits.maxRuntimeMs) {
      runtimeExceeded = true;
      live.currentSource = "runtime budget reached — stopping the remaining work";
      return true;
    }
    return false;
  };

  const counters = {
    foundCompanies: prior.foundCompanies,
    offersAnalyzed: prior.offersAnalyzed,
    uniqueCompanies: prior.uniqueCompanies,
    duplicatesRemoved: prior.duplicatesRemoved,
    companiesRejected: prior.companiesRejected,
    emailsFound: prior.emailsFound,
    noPublicEmail: prior.noPublicEmail,
    sourcesBlocked: prior.sourcesBlocked,
    companiesProcessed: prior.companiesProcessed,
  };

  // ---- research-engine execution stats (measured, never estimated) --------
  // A CONTINUE batch keeps counting from the persisted totals: the bases
  // below are the previous batches' measured values; this batch adds to them.
  const statsBase = {
    queriesExecuted: prior.queriesExecuted ?? 0,
    pagesInspected: prior.pagesInspected ?? 0,
    urlsDiscovered: prior.urlsDiscovered ?? 0,
    browserPages: prior.browserPages ?? 0,
    browserInteractions: prior.browserInteractions ?? 0,
    applicationsFound: prior.applicationsFound ?? 0,
    beginnConfirmed: prior.beginnConfirmed ?? 0,
  };
  /** Provider queries the search adapter issued in THIS batch. */
  let adapterQueriesIssued = 0;
  /** The provider queries the search layer actually issued (measured). The
   *  browser discovery source re-runs THESE queries in the real browser —
   *  the sources share one strategy space, they do not diverge. */
  const issuedQueries: string[] = [];
  /** Every URL the research discovered in THIS batch (search results + crawl). */
  const discoveredUrls = new Set<string>();
  /** Counted companies that got a verified application URL in THIS batch. */
  let applicationsFoundThisBatch = 0;
  /** Counted companies whose beginn year was DOCUMENTED in THIS batch. */
  let beginnConfirmedThisBatch = 0;

  // ---- live research state (the "Current query / Current source" UI) ----
  // Only the orchestrator writes it, always with the value of the step that is
  // ACTUALLY running; the UI renders it verbatim (nothing is simulated).
  const live = {
    currentQuery: null as string | null,
    currentSource: null as string | null,
    currentStrategy: null as string | null,
  };

  /**
   * The live research memory: one planner snapshot per goal pass, written on
   * every batch checkpoint. On a continue batch it is rehydrated from the
   * persisted store above (`priorMemories`) — and only ever REPLACED by a
   * newer snapshot of the same goal.
   */
  const memories: ResearchMemoryStore = { ...(priorMemories ?? {}) };

  // ---- the source report ------------------------------------------------
  const sourceStatus = new Map<string, DiscoverySourceStatus>();
  const sourceOffers = new Map<string, number>();
  const upsertSource = (
    id: string,
    patch: Partial<DiscoverySourceStatus>,
  ): void => {
    const next: DiscoverySourceStatus = sourceStatus.get(id) ?? {
      id,
      status: "skipped",
    };
    if (patch.displayName !== undefined) next.displayName = patch.displayName;
    if (patch.policy !== undefined) next.policy = patch.policy;
    if (patch.category !== undefined) next.category = patch.category;
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.reason !== undefined) next.reason = patch.reason;
    if (patch.candidates !== undefined) next.candidates = patch.candidates;
    if (patch.stats !== undefined) next.stats = patch.stats;
    sourceStatus.set(id, next);
  };
  upsertSource(BA_SOURCE_ID, { status: "running", category: "government" });
  for (const source of policySkippedSources()) {
    upsertSource(source.id, {
      displayName: source.displayName,
      policy: source.policy,
      category: source.category,
      status: "skipped_by_policy",
      reason: source.policy,
      candidates: 0,
    });
  }
  for (const source of PORTAL_SOURCES) {
    if (source.id === "arbeitsagentur") {
      upsertSource(source.id, {
        displayName: source.displayName,
        policy: source.policy,
      });
    }
  }

  // ---- the anti-detection browser (Camofox) — the run's deep-inspect tool ---
  // HTTP first, browser when needed: the guarded fetcher escalates a
  // js_protected / bot_challenge / captcha page to a rendered one through
  // this client (fail-soft — unavailable engine ⇒ the HTTP-only behavior).
  const camofox: CamofoxClient | null =
    deps.camofoxClient === undefined
      ? createCamofoxClient(
          runId,
          limits.maxBrowserPages,
          limits.maxBrowserPages * 2, // an interaction never exceeds a page load
        )
      : deps.camofoxClient;
  const fetchContext =
    deps.fetchContext ??
    createFetchContext({
      ...(deps.isPublicHost ? { isPublicHost: deps.isPublicHost } : {}),
      // Browser escalation: one rendered attempt per blocked page (the
      // client's own budget + breaker make this bounded and fail-soft).
      renderFallback: camofox
        ? async (_ctx, url) => {
            void _ctx; // host pacing was already applied by the guard
            if (!(await camofox.probe())) return null;
            return camofox.openPage(url);
          }
        : undefined,
    });
  if (camofox) {
    upsertSource("browser-camofox", {
      displayName: "Camofox Browser",
      category: "search",
      policy: "enabled_public",
      status: "running",
      candidates: 0,
    });
  }
  const siteFetcher = createGuardedSiteFetcher(fetchContext);
  // The search layer's query generator needs the run's concrete beginn context
  // (the BA-shaped criteria alone only carries "any" for date/year modes).
  const beginnYear = params.beginn.mode === "year" ? params.beginn.year : undefined;
  const beginnMonth =
    params.beginn.mode === "month" ? params.beginn.month : undefined;
  // A SEPARATE provider client for the offer-discovery layer: its own bounded
  // per-run budget (as wide as the query family budget, validated at the
  // client), independent of the email-lookup client which KEEPS the
  // historical conservative budget.
  const offerSearchClient =
    deps.offerSearchClient === undefined
      ? getWebSearchClient({ maxRequests: limits.maxSearchQueries })
      : deps.offerSearchClient;
  // The agentic loop's per-pass state: the budget callbacks below read these
  // at CALL time, so one budget serves every goal pass — each pass installs
  // its own planner before its search phase (see phase (a)).
  const plannerRef: { current: ResearchPlanner | null } = { current: null };
  const passRef: { current: "ausbildung" | "arbeit" } = { current: "ausbildung" };
  /** Offers the agentic loop already extracted this pass (candidate count). */
  let agenticExtracted = 0;
  const adapters =
    deps.adapters ??
    enabledAdapters({
      searchClient: offerSearchClient,
      searchBudget: {
        maxQueries: limits.maxSearchQueries,
        maxResultsPerQuery: limits.maxSearchResultsPerQuery,
        maxPagesPerQuery: limits.maxSearchPagesPerQuery,
        maxPagesToFetch: limits.maxSearchPagesToFetch,
        // Live research: every provider query becomes the run's "current
        // query" the moment it is issued — a real, measured value.
        // (In-memory only: the per-batch checkpoint persists it, so a
        // checkpoint can never precede the provider call that measured it.)
        onQuery: ({ query, source }) => {
          live.currentQuery = query;
          live.currentSource = sourceById(source)?.displayName ?? source;
          adapterQueriesIssued += 1; // measured: one provider request
          issuedQueries.push(query);
        },
        // Research memory for the search phase: what THIS goal pass already
        // issued/visited (fresh run: nothing; continue batch: the persisted
        // snapshot of this goal — never re-paid, never re-fetched).
        getPriorState: () => {
          const snap = memories[passRef.current];
          if (!snap) return null;
          return {
            issuedQueries: snap.issuedQueries,
            visitedUrls: snap.visitedUrls,
          };
        },
        // THE AGENTIC LOOP — plan: the Research Planner hands out the next
        // query batch (strategies refine as the run discovers roles/regions);
        // null closes the phase honestly (target reached, budget spent, the
        // runtime budget elapsed, or no unused structured combination left).
        queryProvider: () => {
          const planner = plannerRef.current;
          if (!planner) return null;
          if (counters.foundCompanies >= target) return null;
          if (identity.nameCount >= maxCompanies) return null;
          if (counters.offersAnalyzed >= limits.maxCandidates) return null;
          if (runtimeBudgetExceeded()) return null;
          return planner.nextBatch(AGENTIC_BATCH_SIZE).queries;
        },
        // THE AGENTIC LOOP — verify: each batch's freshly extracted offers
        // are verified NOW (email pass → dedupe → save) before the planner
        // plans the next batch, and the run's discoveries (role/city/state —
        // and the companies themselves) are fed back into the strategy space.
        onOffers: async (batchOffers) => {
          const before = counters.foundCompanies;
          const planner = plannerRef.current;
          const offers = batchOffers.map((offer) =>
            discoveryOfferFromListing(offer, "search-api"),
          );
          for (const offer of offers) {
            // The offer's title IS the discovered role ("Mechatroniker (Azubi)"
            // → "Mechatroniker"); city/state are the discovered geography.
            planner?.noteDiscovery({
              role: offer.title,
              city: offer.city,
              state: offer.state,
            });
            // A discovered company is a RESEARCH SUBJECT: its name + official
            // domain drive targeted follow-up queries (bounded in the planner).
            if (offer.companyName) {
              planner?.noteCompanyDiscovered({
                name: offer.companyName,
                domain: hostOfUrl(offer.companyWebsite),
              });
            }
          }
          await processOffers(offers, passRef.current);
          agenticExtracted += batchOffers.length;
          return Math.max(0, counters.foundCompanies - before);
        },
        // THE AGENTIC LOOP — evaluate + persist: one measured report per
        // completed batch (the planner's coverage signal, per query), the
        // research memory is checkpointed, and the run survives a kill.
        onBatch: (report) => {
          const planner = plannerRef.current;
          // Every URL the batch discovered/visited is a measured discovery.
          for (const visited of report.visitedUrls) discoveredUrls.add(visited);
          if (planner) {
            planner.noteVisitedUrls(report.visitedUrls);
            planner.observe(
              report.queries,
              {
                resultsSeen: report.resultsSeen,
                offersExtracted: report.offersExtracted,
                newCompanies: report.newCompanies,
              },
              report.perQuery,
            );
            live.currentSource = `Search API (Tavily) · ${
              planner.lastNote ?? ""
            }`.trim();
            live.currentStrategy = planner.lastNote;
            // The memory snapshot of THIS pass is the checkpoint.
            memories[passRef.current] = planner.snapshot();
          }
          void flushProgress().catch(() => undefined);
        },
      },
      searchMeta: { beginnYear, beginnMonth },
    });
  const searchClient =
    deps.searchClient === undefined ? getWebSearchClient() : deps.searchClient;
  /** Permitted public-search attempts issued in this run (client cap aware). */
  let searchAttempts = 0;

  /**
   * The research engine's LIVE execution stats — every value MEASURED
   * (persisted base + this batch's measured delta), never estimated:
   *  - queriesExecuted: provider queries the search adapter issued
   *    (onQuery) + the per-company email-lookup queries (searchAttempts);
   *  - pagesInspected: guarded fetches that actually returned a page
   *    (plain HTTP or browser-rendered — `ok_via_browser`);
   *  - urlsDiscovered: URLs the research found (search results + crawl);
   *  - browserPages / browserInteractions: the Camofox client's counters;
   *  - applicationsFound / beginnConfirmed: verified facts accepted this
   *    batch (an application URL on the official domain / a documented
   *    beginn year — never a guess).
   */
  const researchStats = () => ({
    queriesExecuted:
      statsBase.queriesExecuted + adapterQueriesIssued + searchAttempts,
    pagesInspected:
      statsBase.pagesInspected +
      fetchContext.attempts.filter(
        (attempt) =>
          attempt.outcome === "ok" || attempt.outcome === "ok_via_browser",
      ).length,
    urlsDiscovered: statsBase.urlsDiscovered + discoveredUrls.size,
    browserPages: statsBase.browserPages + (camofox?.pagesUsed ?? 0),
    browserInteractions:
      statsBase.browserInteractions + (camofox?.interactionsUsed ?? 0),
    applicationsFound: statsBase.applicationsFound + applicationsFoundThisBatch,
    beginnConfirmed: statsBase.beginnConfirmed + beginnConfirmedThisBatch,
  });

  let delivered = 0;
  /**
   * Accepted companies that carry a verified official website — the input of
   * the §11 company-website offer-discovery pass (frozen before it runs so a
   * company found DURING that pass is never re-inspected).
   */
  const acceptedSites: Array<{
    websiteUrl: string;
    goal: "ausbildung" | "arbeit";
    field: string;
    /** The counted company (the crawl's evidence attribution). */
    companyName: string;
    /** Its run-local company row (crawl emails corroborate it). */
    companyId: string;
  }> = [];
  /** Remaining official-site passes for the public-email resolution. */
  let emailSiteBudget = discoveryEmailSitePasses();
  let failedPasses = 0;
  /** BA's window has been collected at least once (its report row is final). */
  let baCollectedOnce = false;
  let candidateBuffer: DiscoveryCandidate[] = [];
  let aborted = false;

  const flushCandidates = async (): Promise<void> => {
    if (candidateBuffer.length === 0) return;
    await recordCandidates(runId, candidateBuffer);
    candidateBuffer = [];
  };
  const flushProgress = async (): Promise<void> => {
    // The BA row stays `running` until its window has actually been
    // collected: the early checkpoints (after the internet-discovery layer)
    // must never claim a source that has not run yet.
    if (baCollectedOnce) {
      if (failedPasses > 0 && failedPasses === goalPasses(params.goal).length) {
        upsertSource(BA_SOURCE_ID, { status: "unavailable", candidates: delivered });
      } else {
        upsertSource(BA_SOURCE_ID, { status: "ok", candidates: delivered });
      }
    }
    await setRunCounters(runId, userId, {
      ...counters,
      // The measured research-engine stats (a continue batch resumes them).
      ...researchStats(),
      currentQuery: live.currentQuery,
      currentSource: live.currentSource,
      currentStrategy: live.currentStrategy,
      // The research memory is checkpointed with the batch it belongs to —
      // a kill between batches never loses more than one unobserved batch.
      researchMemory:
        Object.keys(memories).length > 0 ? { ...memories } : null,
    }, [...sourceStatus.values()]);
  };
  /** Persist ONLY the live research state (called per provider query; a
   *  failed live-state write must never kill the run). */
  const flushLiveState = (): void => {
    setRunCounters(runId, userId, {
      currentQuery: live.currentQuery,
      currentSource: live.currentSource,
      currentStrategy: live.currentStrategy,
    }).catch(() => undefined);
  };

  const collectOffers = async (
    passGoal: "ausbildung" | "arbeit",
  ): Promise<OpportunityWindow & { offers: Opportunity[] }> => {
    // Live research: the BA window is a government source, not a provider
    // query — the "current query" goes back to null while it is collected.
    live.currentSource = "Bundesagentur für Arbeit";
    live.currentQuery = null;
    flushLiveState();
    const sp = mapToSearchParams(params, passGoal);
    const collected: Opportunity[] = [];
    let window: OpportunityWindow;
    let page = 1;
    for (;;) {
      window = await windowFn({ ...sp, page });
      collected.push(...window.window);
      if (window.mode === "scan") break;
      if (page * sp.pageSize >= window.total) break;
      if (collected.length >= limits.maxCandidates) break;
      if (page >= MAX_UPSTREAM_PAGES) break;
      page += 1;
    }
    return { ...window, offers: collected };
  };

  /**
   * Ask the selected enabled adapters. A blocked or failing adapter marks
   * its own source entry and is then irrelevant to the rest of the run
   * (§4.7). `select` lets the pipeline run one adapter group at a time and
   * checkpoint between groups — the ordering and the per-adapter behavior
   * are otherwise exactly as before.
   */
  const collectAdapterOffers = async (
    passGoal: "ausbildung" | "arbeit",
    select?: (adapter: OfferSourceAdapter) => boolean,
  ): Promise<DiscoveryOffer[]> => {
    const sp = mapToSearchParams(params, passGoal);
    const collected: DiscoveryOffer[] = [];
    for (const adapter of adapters) {
      if (select !== undefined && !select(adapter)) continue;
      const source = sourceById(adapter.id);
      if (!source) continue;
      // Live research: the source currently running is this adapter.
      // The search layer persists per QUERY (its onQuery hook) — a write
      // BEFORE its first provider call would checkpoint results that do not
      // exist yet, which the ordering contract forbids.
      live.currentSource = adapter.displayName;
      if (adapter.id !== "search-api") flushLiveState();
      try {
        const result = await adapter.searchOffers(sp, fetchContext);
        if (result.status === "ok") {
          collected.push(
            ...result.offers.map((offer) =>
              discoveryOfferFromListing(offer, adapter.id),
            ),
          );
          const total = (sourceOffers.get(adapter.id) ?? 0) + result.offers.length;
          sourceOffers.set(adapter.id, total);
          upsertSource(adapter.id, {
            displayName: adapter.displayName,
            policy: source.policy,
            category: source.category,
            status: "ok",
            candidates: total,
            ...(result.stats !== undefined ? { stats: result.stats } : {}),
          });
          if (result.offers.length === 0) {
            // An enabled source that simply has nothing for these criteria is
            // still a healthy source — never reported as blocked.
            upsertSource(adapter.id, { status: "ok", candidates: total });
          }
        } else if (result.status === "blocked") {
          upsertSource(adapter.id, {
            displayName: adapter.displayName,
            policy: source.policy,
            category: source.category,
            status: "blocked",
            reason: result.reason,
            candidates: sourceOffers.get(adapter.id) ?? 0,
          });
        } else if (result.status === "error") {
          upsertSource(adapter.id, {
            displayName: adapter.displayName,
            policy: source.policy,
            category: source.category,
            status: "error",
            reason: result.message,
            candidates: sourceOffers.get(adapter.id) ?? 0,
          });
        } else {
          // `skipped`: enabled but not runnable in this run (e.g. the search
          // provider has no configured key) — honest, not an error.
          upsertSource(adapter.id, {
            displayName: adapter.displayName,
            policy: source.policy,
            category: source.category,
            status: "skipped",
            reason: result.reason,
            candidates: 0,
          });
        }
      } catch (error) {
        // An adapter must never throw, but a run must never die if one does.
        upsertSource(adapter.id, {
          displayName: adapter.displayName,
          policy: source.policy,
          category: source.category,
          status: "error",
          reason: error instanceof Error ? error.name : "adapter_failed",
          candidates: sourceOffers.get(adapter.id) ?? 0,
        });
      }
    }
    return collected;
  };

  /**
   * The permitted public-search step for ONE company (§4.1 step 3). The
   * result CONTENT feeds the snippet-level address scan; the result URLs feed
   * official-domain resolution (fetch + name-verification) — both stay
   * within the ONE provider request.
   */
  const searchForCompany = async (
    companyName: string,
  ): Promise<{
    ran: boolean;
    results: Array<{ content: string; sourceUrl: string }>;
    urls: string[];
  }> => {
    if (!searchClient) return { ran: false, results: [], urls: [] };
    // The provider caps its own requests per run; an attempt beyond that cap
    // would silently return [] and must never be mistaken for "nothing found".
    if (searchAttempts >= MAX_TAVILY_REQUESTS_PER_RUN) {
      return { ran: false, results: [], urls: [] };
    }
    if (searchAttempts >= limits.maxTavilyQueries) {
      return { ran: false, results: [], urls: [] };
    }
    searchAttempts += 1;
    // The contact query covers the pages §4.1 step 3 expects an address on:
    // Kontakt / Impressum / Bewerbung / Karriere — one request, more surface.
    const query = `"${companyName}" Kontakt Impressum E-Mail Bewerbung`;
    live.currentQuery = query;
    live.currentSource = "public search (company email lookup)";
    flushLiveState();
    try {
      const results = await searchClient.search(query, 5);
      return {
        ran: true,
        results: results.map((entry) => ({
          content: `${entry.title}\n${entry.snippet}`,
          sourceUrl: entry.url,
        })),
        urls: results.map((entry) => entry.url),
      };
    } catch {
      // The provider refused or failed: the step did NOT run successfully.
      return { ran: false, results: [], urls: [] };
    }
  };

  const processOffers = async (
    offers: DiscoveryOffer[],
    passGoal: "ausbildung" | "arbeit",
  ): Promise<void> => {
    /**
     * The per-offer fate trace — one structured, FACT-ONLY line per offer so
     * that every offer which never became a company has a clear REJECTION
     * REASON, and every accepted one shows its evidence path. It logs, it
     * never counts: every number stays where the §4.8 invariant owns it.
     */
    const traceOffer = (
      outcome: string,
      offer: Pick<DiscoveryOffer, "title" | "companyName" | "goal" | "url"> | null,
      detail: Record<string, string | number | boolean | null> = {},
    ): void => {
      console.info(
        `[company-discovery] offer run="${runId}" outcome="${outcome}" ` +
          `company=${JSON.stringify(offer?.companyName ?? null)} ` +
          `title=${JSON.stringify(offer?.title ?? null)} ` +
          `offerGoal=${offer?.goal ?? null} passGoal=${passGoal} ` +
          `offerUrl=${JSON.stringify(offer?.url ?? null)} ${JSON.stringify(detail)}`,
      );
    };

    let sinceProgress = 0;
    for (const offer of offers) {
      if (
        // Consult the clock DIRECTLY (not the sticky flag alone): a long
        // single phase (dozens of company email passes) can outlive the
        // budget without any pass-loop boundary in between — MAX_RUNTIME
        // must stop the work, not only the planning.
        runtimeBudgetExceeded() ||
        counters.foundCompanies >= target ||
        counters.offersAnalyzed >= limits.maxCandidates ||
        identity.nameCount >= maxCompanies
      ) {
        return;
      }
      if (
        counters.offersAnalyzed % CANCEL_CHECK_EVERY === 0 &&
        (await isCancelled(runId, userId))
      ) {
        aborted = true;
        return;
      }

      counters.offersAnalyzed += 1;
      sinceProgress += 1;
      candidateBuffer.push({
        source: offer.sourceId,
        ...candidateFromOffer(offer),
      });
      if (candidateBuffer.length >= CANDIDATE_FLUSH_EVERY) await flushCandidates();

      if (offer.goal !== passGoal) {
        // The offer's documented type is outside THIS pass's scope (a regular
        // job in an Ausbildung run, …). Never a silent drop: the reason is
        // traced so a lost offer is never a mystery.
        traceOffer("goal_out_of_scope", offer, {
          offerGoal: offer.goal,
          reason: "offer type is not the pass's goal",
        });
        continue;
      }
      if (!isUsableCompanyName(offer.companyName)) {
        // A name that cannot identify an employer ("AG", a number, …) never
        // becomes a company — traced, and never invented.
        traceOffer("unusable_company_name", offer, {
          companyName: offer.companyName,
          reason: "name does not identify a real employer",
        });
        continue;
      }

      const key = companyKeyOf(offer.companyName);
      // STRONG dedupe, before the expensive email pass: the normalized name
      // key OR the company's official domain. A company found earlier under a
      // slightly different name (same website) is a duplicate — and never
      // spends a search request or a page fetch for a second time.
      const identityMatch = identity.check(key, offer.companyWebsite);
      if (identityMatch !== "new") {
        counters.duplicatesRemoved += 1;
        traceOffer("duplicate", offer, {
          matchedIdentity: identityMatch,
          reason: "company already resolved in this run",
        });
        continue;
      }
      if (!discoveryBeginnGate({ valid_from: offer.beginn }, params.beginn)) {
        if (!rejectedKeys.has(key)) {
          counters.companiesRejected += 1;
          rejectedKeys.add(key);
        }
        traceOffer("beginn_mismatch", offer, {
          validFrom: offer.beginn,
          beginnMode: params.beginn.mode,
          reason: "documented start does not satisfy the run's beginn filter",
        });
        continue;
      }
      rejectedKeys.delete(key);

      // ---- the email pass, inside its own error boundary ------------------
      // Live research: the verification phase of this company (official site
      // pages + the permitted public search for companies without a website).
      live.currentSource = "company verification (website + public search)";
      flushLiveState();
      /** The verified official site when the source gave none (null otherwise). */
      let resolvedWebsite: OfficialSiteResolution | null = null;
      let resolution: Awaited<ReturnType<typeof resolveCompanyEmails>>;
      try {
        const search = offer.companyWebsite
          ? { ran: false as const, results: [] as Array<{ content: string; sourceUrl: string }>, urls: [] as string[] }
          : await searchForCompany(offer.companyName ?? "");
        // OFFICIAL-DOMAIN RESOLUTION — Job portal → employer identity →
        // official website → contact evidence. A company the source never
        // attached a website for is resolved by FETCHING the provider's own
        // result pages for the company; a host counts as official only when
        // its page literally names the company (no name → domain guessing).
        if (!offer.companyWebsite && search.ran && search.urls.length > 0) {
          resolvedWebsite = await resolveOfficialSite({
            companyName: offer.companyName ?? "",
            urls: search.urls,
            ctx: fetchContext,
          });
        }
        const websiteUrl =
          offer.companyWebsite ?? resolvedWebsite?.websiteUrl ?? null;
        const siteBudgetAvailable = emailSiteBudget > 0;
        resolution = await resolveCompanyEmails({
          companyName: offer.companyName ?? "",
          listingEmail: offer.listingEmail,
          websiteUrl,
          search,
          trustedPages: [],
          fetchSite: siteBudgetAvailable ? siteFetcher : null,
          // The verified-domain page already fetched during resolution is
          // real evidence — extracted like any site page, never re-guessed.
          prefetchedPages: offer.companyWebsite
            ? []
            : (resolvedWebsite?.pages ?? []),
        });
        // Only a company that actually had a website checked spends a slot —
        // whether the source stated it or the resolution verified it.
        if (websiteUrl && siteBudgetAvailable) emailSiteBudget -= 1;
      } catch (error) {
        // Per-company isolation: an unexpected failure is INCONCLUSIVE, never
        // "no public email" and never an address.
        console.error(
          `[company-discovery] email resolution failed run="${runId}" company="${key}"`,
          error,
        );
        resolution = {
          emails: [],
          attempts: [],
          inspectedPages: [],
          requiredInspected: false,
          blocked: true,
          blockedReason: "unreachable",
          reasonCode: "source_blocked",
          primary: null,
          siteYear: null,
        };
      }

      // The company's VERIFIED website: the one the source stated, or the
      // one domain resolution proved (a fetched page on it literally names
      // the company). Stored, evidenced and confidence-rated as such — and
      // it is what feeds the company-websites layer for follow-up offers.
      const websiteUrl =
        offer.companyWebsite ?? resolvedWebsite?.websiteUrl ?? null;
      const websiteSourceUrl = offer.companyWebsite
        ? offer.companyWebsiteSourceUrl
        : (resolvedWebsite?.pages[0]?.url ?? null);

      counters.companiesProcessed += 1;
      const outcome = resolution.reasonCode;
      if (outcome === "email_found") counters.emailsFound += 1;
      else if (outcome === "source_blocked" || outcome === "no_website_found")
        counters.sourcesBlocked += 1;
      else counters.noPublicEmail += 1;
      traceOffer(outcome, offer, {
        website: websiteUrl,
        pagesInspected: resolution.inspectedPages.length,
        email: resolution.primary?.email ?? null,
        blockedReason: resolution.blockedReason,
      });

      // STRONG dedupe, part two: the VERIFIED public email is part of the
      // company's identity. Two listings under different names that publish
      // the same address are ONE company — the first counted one wins, the
      // second is a duplicate. (Its outcome above stays honestly counted:
      // the §4.8 invariant `found + noEmail + blocked === processed` holds.)
      if (
        identity.check(key, websiteUrl, resolution.primary?.email ?? null) !==
        "new"
      ) {
        counters.duplicatesRemoved += 1;
        await flushProgress();
        continue;
      }

      // ---- the company's research record (evidence ledger + confidence) ----
      // Everything below is a stored FACT: a page that was actually opened,
      // an address that was literally read, a URL that was actually
      // inspected. Nothing is derived from a name or a domain pattern.
      const applicationUrl = applicationUrlOf(resolution, null);
      // The STRICT final beginn decision: the discovery gate already
      // rejected documented mismatches; here "unconfirmed" (null) is settled
      // with the company's own site evidence where it exists. A concrete
      // beginn filter (year/date/month) is a USER FILTER on the result —
      // the company counts only when its start is confirmed, never guessed.
      const beginnYearConfirmed = beginnYearConfirmedOf(
        offer,
        params,
        resolution.siteYear,
      );
      const emailSourceUrls = resolution.primary
        ? [resolution.primary.sourceUrl, ...resolution.primary.sourceUrls]
            .filter((url): url is string => Boolean(url))
            .filter((url, index, all) => all.indexOf(url) === index)
        : [];
      const companyFacts = {
        offerUrl: offer.url,
        role: offer.title,
        city: offer.city,
        state: offer.state,
        beginn: offer.beginn,
        websiteUrl,
        websiteSourceUrl,
        email: resolution.primary?.email ?? null,
        emailSourceUrls,
        applicationUrl,
        checkedAt: new Date(now()).toISOString(),
      };
      const evidence = buildCompanyEvidence(companyFacts);
      const confidence = companyConfidence({
        officialDomain: websiteUrl !== null,
        training: true, // the counted offer IS the documented placement
        role: (offer.title ?? "").length > 0,
        location: offer.city !== null || offer.state !== null,
        email: resolution.primary !== null,
        application: applicationUrl !== null,
        secondSource: emailSourceUrls.length >= 2,
        // A documented start year that CONTRADICTS the run's year is a
        // conflict — recorded, and it lowers the score (never dropped).
        conflict: beginnYearConfirmed === false,
      });

      const emailCounts = countsAsResult({
        onlyPublicEmail: params.onlyPublicEmail,
        hasPublicEmail: resolution.primary !== null,
        outcome:
          outcome === "no_website_found"
            ? "source_blocked"
            : (outcome as "email_found" | "no_public_email" | "source_blocked"),
      });
      const beginnOk =
        params.beginn.mode === "from_now" || beginnYearConfirmed === true;

      if (!emailCounts || !beginnOk) {
        if (!rejectedKeys.has(key)) {
          counters.companiesRejected += 1;
          rejectedKeys.add(key);
        }
        // The audit label: the EMAIL outcome is the company's factual state
        // (kept in `emailStatus` regardless); the REJECT reason reports the
        // user-filter that failed — an email/website failure first, else the
        // beginn filter. The email failure is classified precisely into its
        // three states (never lumped together):
        //   no usable official site found  → no_website_found
        //   the source/site was blocked    → source_blocked
        //   site checked, no literal email → no_public_email
        const label = !emailCounts
          ? outcome === "no_website_found"
            ? REJECT_NO_WEBSITE
            : outcome === "source_blocked"
              ? REJECT_SOURCE_BLOCKED
              : REJECT_NO_PUBLIC_EMAIL
          : beginnYearConfirmed === false
            ? "beginn_mismatch"
            : "beginn_not_confirmed";
        await recordCompany(runId, {
          ...companyFactsFromOffer(offer, params, key),
          websiteUrl,
          websiteSourceUrl,
          status: "rejected",
          rejectReason: label,
          emailStatus: outcome === "no_website_found" ? "source_blocked" : outcome,
          // Verification facts the pass measured (never guessed):
          applicationUrl,
          beginnYearConfirmed,
          // Rejected = insufficient evidence → the score is the measured
          // (low) one, with its readable reasons.
          confidenceScore: confidence.score,
          evidence,
          confidenceReasons: confidence.reasons,
          conflict: confidence.conflict,
        });
        traceOffer("rejected", offer, {
          rejectReason: label,
          onlyPublicEmail: params.onlyPublicEmail,
          beginnConfirmed: beginnYearConfirmed,
          emailStatus: outcome,
        });
        await flushProgress();
        continue;
      }

      const { companyId } = await recordCompany(runId, {
        ...companyFactsFromOffer(offer, params, key),
        websiteUrl,
        websiteSourceUrl,
        status: "accepted",
        emailStatus: outcome === "no_website_found" ? "source_blocked" : outcome,
        // Verification facts the pass measured (never guessed):
        applicationUrl,
        beginnYearConfirmed,
        confidenceScore: confidence.score,
        evidence,
        confidenceReasons: confidence.reasons,
        conflict: confidence.conflict,
      });
      if (resolution.primary) {
        try {
          await recordCompanyEmail(companyId, {
            ...resolution.primary,
            confidence: emailConfidenceOf(resolution.primary),
          });
        } catch (error) {
          console.error(
            `[company-discovery] storing a public email failed run="${runId}" company="${companyId}"`,
            error,
          );
        }
      }
      // Register the company's FULL identity (name + domain + verified
      // email) so a later batch — same run or a continue-batch — never
      // processes it again.
      identity.mark(key, websiteUrl, resolution.primary?.email ?? null);
      counters.uniqueCompanies += 1;
      counters.foundCompanies += 1;
      // Measured verification facts (never guessed): a verified application
      // URL and a documented beginn year are counted into the run's stats.
      if (applicationUrl !== null) applicationsFoundThisBatch += 1;
      if (beginnYearConfirmed === true) beginnConfirmedThisBatch += 1;
      // A VERIFIED official site (stated or resolved) feeds the
      // company-websites layer: its own career/offer pages are scanned next
      // (HTTP pass, or the browser deep crawl when the engine is available).
      if (websiteUrl) {
        acceptedSites.push({
          websiteUrl,
          goal: offer.goal,
          field: params.field,
          companyName: offer.companyName ?? "",
          companyId,
        });
      }
      traceOffer("accepted", offer, {
        email: resolution.primary?.email ?? null,
        website: websiteUrl,
        confidence: confidence.score,
      });
      sinceProgress = 0;
      await flushProgress();
    }
    if (sinceProgress > 0) await flushProgress();
  };

  try {
    const passes = goalPasses(params.goal);
    for (const passGoal of passes) {
      if (counters.foundCompanies >= target || identity.nameCount >= maxCompanies) break;
      if (runtimeBudgetExceeded()) break;
      if (await isCancelled(runId, userId)) {
        aborted = true;
        break;
      }

      // (a) AGENTIC Internet Discovery — the research loop:
      //     Plan → Search → Inspect → Extract → Verify → Dedupe → Save →
      //     Evaluate coverage → Refine → Search again.
      //     When the run built the adapters itself (the production path),
      //     the search adapter runs the loop internally: the planner hands
      //     out query batches, each batch's offers are verified BEFORE the
      //     next batch is planned (discoveries feed the strategy), and every
      //     batch is checkpointed — a kill between batches loses nothing
      //     already verified. Injected adapters (tests, custom wiring) run
      //     their legacy single pass, and their offers are processed in (d)
      //     exactly as before.
      const agentic = deps.adapters === undefined;
      const passSeed = {
        role: params.role,
        field: params.field,
        beginnYear: beginnYear ?? null,
        goal: passGoal,
      };
      // A continue batch RESTORES this goal's planner from the run's persisted
      // research memory (same strategy space, no re-issued queries); a fresh
      // run — or a goal with no stored memory — plans from the seed.
      const planner = agentic
        ? ResearchPlanner.restore(passSeed, priorMemories?.[passGoal] ?? null)
        : null;
      plannerRef.current = planner;
      passRef.current = passGoal;
      agenticExtracted = 0;
      const searchAdapter = adapters.find((adapter) => adapter.id === "search-api");
      const searchOffers: DiscoveryOffer[] = [];
      if (searchAdapter) {
        const source = sourceById("search-api");
        if (source) {
          upsertSource("search-api", {
            displayName: source.displayName,
            policy: source.policy,
            category: source.category,
            status: "running",
            candidates: 0,
          });
          live.currentSource = source.displayName;
        }
        const sp = mapToSearchParams(params, passGoal);
        try {
          const result = await searchAdapter.searchOffers(sp, fetchContext);
          if (result.status === "ok") {
            for (const offer of result.offers) {
              searchOffers.push(discoveryOfferFromListing(offer, "search-api"));
            }
            upsertSource("search-api", {
              displayName: source?.displayName ?? "Search API (Tavily)",
              policy: source?.policy ?? "enabled_official_api",
              category: source?.category ?? "search",
              status: "ok",
              candidates: agentic ? agenticExtracted : searchOffers.length,
              stats: {
                queriesExecuted: result.stats?.queriesExecuted ?? 0,
                resultsInspected: result.stats?.resultsInspected ?? 0,
              },
            });
          } else if (result.status === "blocked") {
            upsertSource("search-api", {
              displayName: source?.displayName ?? "Search API (Tavily)",
              status: "blocked",
              reason: result.reason,
              candidates: agentic ? agenticExtracted : 0,
            });
          } else if (result.status === "error") {
            upsertSource("search-api", {
              displayName: source?.displayName ?? "Search API (Tavily)",
              status: "error",
              reason: result.message,
              candidates: agentic ? agenticExtracted : 0,
            });
          } else {
            // `skipped`: the provider is not configured — honest, not an error.
            upsertSource("search-api", {
              displayName: source?.displayName ?? "Search API (Tavily)",
              status: "skipped",
              reason: result.reason,
              candidates: 0,
            });
          }
        } catch (error) {
          // The adapter must never throw — but a run must never die if one does.
          upsertSource("search-api", {
            displayName: source?.displayName ?? "Search API (Tavily)",
            status: "error",
            reason: error instanceof Error ? error.name : "adapter_failed",
            candidates: agentic ? agenticExtracted : 0,
          });
        }
      }
      plannerRef.current = null;
      await flushProgress();
      // The runtime budget elapsed mid-pass: the remaining phases of this
      // run stop now (the finish below reports the measured counters).
      if (runtimeBudgetExceeded()) break;
      if (await isCancelled(runId, userId)) {
        aborted = true;
        break;
      }

      // (b) the remaining enabled portal adapters — collected exactly as
      //     before, now after the search checkpoint, with their own flush.
      const portalOffers = await collectAdapterOffers(
        passGoal,
        (adapter) => adapter.id !== "search-api",
      );
      await flushProgress();
      if (await isCancelled(runId, userId)) {
        aborted = true;
        break;
      }

      // (c) Arbeitsagentur: offers and companies only (§3.3) — collected
      //     AFTER the internet-discovery checkpoints, so its window (and any
      //     provider backoff) can no longer delay the persistence of the
      //     search layer's results.
      let baOffers: DiscoveryOffer[] = [];
      try {
        const { offers } = await collectOffers(passGoal);
        delivered += offers.length;
        baOffers = offers.map((opp) => discoveryOfferFromOpportunity(opp));
        baCollectedOnce = true;
      } catch (error) {
        if (error instanceof BaFetchFailure) {
          failedPasses += 1;
          baCollectedOnce = true;
          upsertSource(BA_SOURCE_ID, {
            status: "unavailable",
            reason: "SOURCE_UNAVAILABLE",
            candidates: delivered,
          });
        } else {
          throw error;
        }
      }
      await flushProgress();
      if (await isCancelled(runId, userId)) {
        aborted = true;
        break;
      }

      // (d) Per-company email resolution — BA offers first, then the portal
      //     offers, through the same funnel and dedupe set; its existing
      //     per-company flushes persist the partial progress. In agentic mode
      //     the search offers were ALREADY verified inside the loop (phase a)
      //     and must not be re-processed (the identity index would drop them
      //     as duplicates, but re-running their email pass would waste the
      //     bounded provider budget for nothing).
      await processOffers(baOffers, passGoal);
      if (aborted) break;
      await processOffers(
        [...portalOffers, ...(agentic ? [] : searchOffers)],
        passGoal,
      );
      if (aborted) break;
    }

    // (b2) BROWSER DISCOVERY (Camofox): the run's research queries executed
    //      in a REAL browser — rendered search-result pages (Google via the
    //      engine's anti-detection, DuckDuckGo/Bing as honest fallbacks),
    //      then candidate pages inspected in the same session. The offers
    //      flow through the SAME funnel (dedupe → email resolution → gates)
    //      as every other source, so nothing is double-counted and a browser
    //      failure never stops the run. Hoisted so the LATER crawl-phase
    //      source-row upsert (c) can merge it: the browser's own measured
    //      work must never be overwritten as "skipped".
    let browserDiscovery: BrowserSourceResult | null = null;
    if (
      !aborted &&
      camofox &&
      counters.foundCompanies < target &&
      identity.nameCount < maxCompanies
    ) {
      const browserLive = async (text: string): Promise<void> => {
        live.currentSource = "Camofox Browser Search";
        live.currentStrategy = text;
        flushLiveState();
      };
      const probe = await camofox.probe();
      if (!probe) {
        upsertSource("browser-camofox", {
          status: "unavailable",
          reason: camofox.unavailableReason ?? "unreachable",
        });
       } else {
        // The browser re-runs the SAME queries the planner issued for this
        // run (measured). When the search layer issued none (provider down /
        // no key), the static seed list is the fallback — the research does
        // not depend on Tavily being alive. `goal` is the offer-TYPE
        // FALLBACK only (stated types always win), so "both" runs use the
        // product's primary anchor.
        const browserGoal: "ausbildung" | "arbeit" =
          params.goal === "both" ? "ausbildung" : params.goal;
        const browserQueries =
          issuedQueries.length > 0
            ? [...new Set(issuedQueries)]
            : generateSearchQueries(
                {
                  role: params.role,
                  keyword: params.field,
                  goal: browserGoal,
                  location: "",
                  cities: [],
                },
                {},
                12,
              );
        upsertSource("browser-camofox", {
          status: "running",
          candidates: 0,
        });
        const browserOffersByGoal: Record<
          "ausbildung" | "arbeit",
          DiscoveryOffer[]
        > = { ausbildung: [], arbeit: [] };
        const browserVisited = new Set([
          ...(memories.ausbildung?.visitedUrls ?? []),
          ...(memories.arbeit?.visitedUrls ?? []),
        ]);
        const browserResult = await runBrowserDiscovery({
          camofox,
          queries: browserQueries,
          goal: browserGoal,
          field: params.field,
          knownCompanyDomains: identity.knownDomains(),
          visitedUrls: browserVisited,
          maxCandidatesPerQuery: 6,
          callbacks: {
            onOffer: (offer) => {
              browserOffersByGoal[offer.offerType ?? browserGoal].push(
                discoveryOfferFromListing(offer, "browser-camofox"),
              );
            },
            onUrlsDiscovered: (urls) => {
              for (const discovered of urls) discoveredUrls.add(discovered);
            },
            onLiveState: (text) => {
              void browserLive(text);
            },
            shouldStop: () =>
              runtimeBudgetExceeded() || counters.foundCompanies >= target,
          },
        });
        browserDiscovery = browserResult;
        await flushProgress();
        if (!aborted) {
          await processOffers(
            browserOffersByGoal.ausbildung,
            "ausbildung",
          );
          if (!aborted) {
            await processOffers(browserOffersByGoal.arbeit, "arbeit");
          }
        }
        upsertSource("browser-camofox", {
          status: browserResult.blocked ? "blocked" : "ok",
          reason:
            browserResult.blockedReason ??
            (Object.keys(browserResult.providerFailures).length > 0
              ? Object.entries(browserResult.providerFailures)
                  .map(([key, hits]) => `${key}(${hits})`)
                  .join(",")
              : undefined),
          candidates: browserResult.offersFound,
          stats: {
            queriesExecuted: browserResult.queriesExecuted,
            resultsInspected: browserResult.pagesUsed,
          },
        });
        live.currentSource = null;
        live.currentStrategy = null;
      }
    }

    // (c) company-website offer discovery (§11): a bounded pass over the
    //     already-accepted companies that carry a verified official domain.
    //     Its offers flow through the SAME funnel (normalization → dedupe →
    //     gates → email resolution), so an already-counted company is only a
    //     duplicate, and the §4.8 outcome invariant is preserved.
    if (!aborted && acceptedSites.length > 0 && counters.foundCompanies < target) {
      const sites = acceptedSites.slice(0, limits.maxCompanySiteOfferCompanies);
      // Live research: the company-websites discovery pass is running.
      live.currentSource = COMPANY_WEBSITES_LAYER.displayName;
      live.currentQuery = null;
      flushLiveState();
      upsertSource(COMPANY_WEBSITES_LAYER.id, {
        displayName: COMPANY_WEBSITES_LAYER.displayName,
        policy: COMPANY_WEBSITES_LAYER.policy,
        category: COMPANY_WEBSITES_LAYER.category,
        status: "running",
        candidates: 0,
      });
      let siteOffersTotal = 0;
      let crawlPagesTotal = 0;
      let crawlBlockedTotal = 0;
      const siteOffersByGoal: Record<"ausbildung" | "arbeit", DiscoveryOffer[]> = {
        ausbildung: [],
        arbeit: [],
      };
      for (const site of sites) {
        if (
          runtimeBudgetExceeded() ||
          counters.foundCompanies >= target ||
          identity.nameCount >= maxCompanies
        ) {
          break;
        }
        if (await isCancelled(runId, userId)) {
          aborted = true;
          break;
        }
        // ---- the DEEP crawl: browser first (JS portals, lazy listings,
        //      interactions), HTTP as the fallback when the engine is not
        //      available for this site (reliability: browser failure never
        //      stops the research, the plain-HTTP pass still runs).
        let usedBrowser = false;
        if (camofox && (await camofox.probe()) && camofox.hasPageBudget()) {
          live.currentSource = `${COMPANY_WEBSITES_LAYER.displayName} · browser deep crawl`;
          flushLiveState();
          try {
            const crawl = await crawlCompanySite(camofox, {
              websiteUrl: site.websiteUrl,
              companyName: site.companyName,
              companyDomain: hostOfUrl(site.websiteUrl) || "",
              role: params.role,
              field: params.field,
              goal: site.goal,
              limits: {
                maxDepth: limits.maxCrawlDepth,
                maxPages: limits.maxBrowserPagesPerCompany,
                maxInteractions: limits.maxBrowserInteractionsPerCompany,
                textBudget: 20_000,
              },
              callbacks: {
                onNewUrls: (urls) => {
                  for (const url of urls) discoveredUrls.add(url);
                },
                shouldStop: () =>
                  runtimeBudgetExceeded() ||
                  counters.foundCompanies >= target,
                onLiveState: (text) => {
                  live.currentStrategy = text;
                  flushLiveState();
                },
              },
              // A continue batch never re-fetches pages it already paid for.
              visitedUrls: memories[site.goal]?.visitedUrls ?? [],
            });
            usedBrowser = true;
            crawlPagesTotal += crawl.pagesFetched;
            if (crawl.blocked) crawlBlockedTotal += 1;
            siteOffersTotal += crawl.offers.length;
            for (const offer of crawl.offers) {
              const offerGoal = offer.offerType ?? site.goal;
              siteOffersByGoal[offerGoal].push(
                discoveryOfferFromListing(offer, COMPANY_WEBSITES_LAYER.id),
              );
            }
            // Crawl evidence for the ACCEPTED company itself: literally
            // published emails corroborate (idempotent) and a verified
            // application page fills the row when the email pass found none.
            for (const email of crawl.emails) {
              try {
                await recordCompanyEmail(site.companyId, email);
              } catch {
                // Corroboration must never break the run.
              }
            }
            if (crawl.applicationUrl) {
              await setCompanyApplicationUrlIfMissing(
                site.companyId,
                crawl.applicationUrl,
              ).catch(() => undefined);
            }
          } catch {
            // A crawl must never kill the run: fall through to the HTTP pass.
            usedBrowser = false;
          }
        }
        if (!usedBrowser) {
          const result = await discoverCompanySiteOffers(fetchContext, {
            websiteUrl: site.websiteUrl,
            field: site.field,
            goal: site.goal,
            maxPages: limits.maxCompanySiteOfferPages,
          });
          siteOffersTotal += result.offers.length;
          for (const offer of result.offers) {
            const offerGoal = offer.offerType ?? site.goal;
            siteOffersByGoal[offerGoal].push(
              discoveryOfferFromListing(offer, COMPANY_WEBSITES_LAYER.id),
            );
          }
        }
        await flushProgress();
      }
      if (!aborted) {
        await processOffers(siteOffersByGoal.ausbildung, "ausbildung");
        await processOffers(siteOffersByGoal.arbeit, "arbeit");
        upsertSource(COMPANY_WEBSITES_LAYER.id, {
          status: "ok",
          candidates: siteOffersTotal,
        });
        if (camofox) {
          // The browser source's honest row — MERGED across both browser
          // passes: the (b2) discovery run AND this crawl phase. The crawl
          // may be HTTP-only (b2 legitimately spent the client's shared page
          // budget), so a browser that really ran must never be reported
          // "skipped"; and a walled/blocked discovery run stays "blocked"
          // when the crawl added no browser work of its own.
          const crawlDidWork = crawlPagesTotal > 0 || crawlBlockedTotal > 0;
          const status = !camofox.available
            ? "unavailable"
            : !browserDiscovery && !crawlDidWork
              ? "skipped"
              : browserDiscovery?.blocked && !crawlDidWork
                ? "blocked"
                : "ok";
          const failureSummary = browserDiscovery
            ? Object.entries(browserDiscovery.providerFailures)
                .map(([key, hits]) => `${key}(${hits})`)
                .join(",")
            : "";
          upsertSource("browser-camofox", {
            displayName: "Camofox Browser",
            category: "search",
            policy: "enabled_public",
            status,
            reason: !camofox.available
              ? (camofox.unavailableReason ?? "browser_unavailable")
              : browserDiscovery
                ? browserDiscovery.blocked
                  ? (browserDiscovery.blockedReason ?? undefined)
                  : (failureSummary.length > 0 ? failureSummary : undefined)
                : undefined,
            candidates: browserDiscovery?.offersFound ?? 0,
            stats: {
              queriesExecuted: browserDiscovery?.queriesExecuted ?? 0,
              resultsInspected:
                (browserDiscovery?.pagesUsed ?? 0) + crawlPagesTotal,
            },
          });
        }
      }
    }

    await flushCandidates();
    if (aborted) {
      return (await getDiscoveryRun(runId, userId)) ?? run0;
    }

    const found = counters.foundCompanies;
    const status = runTerminalStatus({
      found,
      target,
      companiesProcessed: counters.companiesProcessed,
      allPassesFailed: failedPasses === passes.length,
    });
    return await finishDiscoveryRun(runId, userId, {
      status,
      foundCompanies: found,
      offersAnalyzed: counters.offersAnalyzed,
      uniqueCompanies: counters.uniqueCompanies,
      duplicatesRemoved: counters.duplicatesRemoved,
      companiesRejected: counters.companiesRejected,
      emailsFound: counters.emailsFound,
      noPublicEmail: counters.noPublicEmail,
      sourcesBlocked: counters.sourcesBlocked,
      companiesProcessed: counters.companiesProcessed,
      ...researchStats(),
      sources: [...sourceStatus.values()],
      error:
        status === "failed"
          ? "The primary source was unavailable; no companies could be collected."
          : null,
    });
  } catch (error) {
    const current = await getDiscoveryRun(runId, userId);
    if (current && TERMINAL_RUN_STATUSES.includes(current.status)) {
      return current;
    }
    await finishDiscoveryRun(runId, userId, {
      status: "failed",
      foundCompanies: counters.foundCompanies,
      offersAnalyzed: counters.offersAnalyzed,
      uniqueCompanies: counters.uniqueCompanies,
      duplicatesRemoved: counters.duplicatesRemoved,
      companiesRejected: counters.companiesRejected,
      emailsFound: counters.emailsFound,
      noPublicEmail: counters.noPublicEmail,
      sourcesBlocked: counters.sourcesBlocked,
      companiesProcessed: counters.companiesProcessed,
      ...researchStats(),
      sources: [...sourceStatus.values()],
      error: "The discovery run failed.",
    }).catch(() => undefined);
    throw error;
  } finally {
    // The run's browser session must not outlive the run (cookies, storage,
    // tabs). Best effort: a cleanup failure never changes the run's outcome.
    camofox?.destroySession().catch(() => undefined);
  }
}

/** A portal listing as an offer: everything the listing stated. */
function discoveryOfferFromListing(
  offer: NormalizedOffer,
  sourceId: string,
): DiscoveryOffer {
  return {
    candidateRef: offer.candidateRef,
    sourceId,
    sourceName: offer.offerSource,
    title: offer.role,
    companyName: offer.companyName,
    companyWebsite: offer.companyWebsite,
    companyWebsiteSourceUrl: offer.offerUrl,
    city: offer.city,
    state: offer.state,
    goal: offer.offerType ?? "ausbildung",
    beginn: offer.beginn,
    salaryLabel: offer.salary,
    url: offer.offerUrl,
    // A listing may contribute an address ONLY when it printed one (§3.1).
    listingEmail: offer.publishedEmail
      ? {
          email: offer.publishedEmail.email,
          sourceUrl: offer.offerUrl,
          evidence: offer.publishedEmail.evidence,
        }
      : null,
    listingText: offer.listingText,
  };
}

/** The BA record as an offer: companies and offers ONLY, never an email. */
function discoveryOfferFromOpportunity(opp: Opportunity): DiscoveryOffer {
  return {
    candidateRef: opp.id,
    sourceId: BA_SOURCE_ID,
    sourceName: opp.source_name ?? "Bundesagentur für Arbeit",
    title: opp.title,
    companyName: opp.company_name,
    // The engine's own company record (never BA contact data, §3.3).
    companyWebsite: opp.enrichment?.website_url ?? null,
    companyWebsiteSourceUrl: opp.enrichment?.website_source ?? null,
    city: opp.location_detail?.city ?? null,
    state: opp.location_detail?.region ?? null,
    goal: opp.goal,
    beginn: opp.valid_from ? opp.valid_from.slice(0, 10) : null,
    salaryLabel: opp.salary?.label ?? null,
    url: opp.source_url,
    // §3.3: Arbeitsagentur contributes NO address, ever — not even one its
    // description text happens to contain.
    listingEmail: null,
    listingText: null,
  };
}

/**
 * The beginn confirmation of a company — three honest states, never a
 * guess:
 *   true   the run has a CONCRETE beginn (year/month/date) and the start is
 *          DOCUMENTED in that target — in the offer itself, or (year mode)
 *          on the company's own inspected site pages;
 *   false  the start is documented, but NOT in the target;
 *   null   nothing is documented anywhere, the evidence conflicts, or the
 *          run's constraint is `from_now` (no concrete year to confirm).
 * Evidence order: the offer's documented start first; the company's own
 * site second (a site year cannot confirm a concrete date or month window).
 * Stored per company for transparency.
 */
export function beginnYearConfirmedOf(
  offer: Pick<DiscoveryOffer, "beginn">,
  params: Pick<DiscoveryRunParams, "beginn">,
  siteYear: { year: number | null; conflict: boolean } | null = null,
): boolean | null {
  const runYear =
    params.beginn.mode === "year"
      ? String(params.beginn.year)
      : params.beginn.mode === "month"
        ? params.beginn.month.slice(0, 4)
        : params.beginn.mode === "date"
          ? params.beginn.date.slice(0, 4)
          : null; // from_now: no concrete year to confirm
  if (!runYear) return null;

  // 1. The offer's own documented start is the primary evidence.
  const documentedYear = offer.beginn ? offer.beginn.slice(0, 4) : null;
  if (/^\d{4}$/.test(documentedYear ?? "")) return documentedYear === runYear;

  // 2. Undocumented in the offer: the company's OWN inspected pages are the
  //    next documented source — a start year stated in apprenticeship
  //    context (year mode only, and only when the pages do not conflict).
  if (
    params.beginn.mode === "year" &&
    siteYear &&
    !siteYear.conflict &&
    siteYear.year !== null
  ) {
    return String(siteYear.year) === runYear;
  }

  // 3. Nothing documented anywhere: UNCONFIRMED — the acceptance stage
  //    rejects with a clear reason instead of counting it.
  return null;
}

/** Exported for tests: the outcome counters must always add up. */
export function outcomeSum(input: {
  emailsFound: number;
  noPublicEmail: number;
  sourcesBlocked: number;
}): number {
  return input.emailsFound + input.noPublicEmail + input.sourcesBlocked;
}

/**
 * The run's terminal state, decided from MEASURED counters only (exported for
 * tests): reaching the target — the number of UNIQUE companies with a
 * published email — stops the run as `completed`; anything short of it is an
 * honest `partial` (or `failed` when every pass was unavailable). A continue
 * batch uses the SAME decision on the accumulated counters.
 */
export function runTerminalStatus(input: {
  found: number;
  target: number;
  companiesProcessed: number;
  allPassesFailed: boolean;
}): "completed" | "partial" | "failed" {
  if (input.found >= input.target) return "completed";
  if (input.found > 0 || input.companiesProcessed > 0) return "partial";
  return input.allPassesFailed ? "failed" : "partial";
}

/** Exported for tests/UI: the source report of a run, policy entries included. */
export function sourceReport(
  sources: DiscoverySourceStatus[],
): SourceReportEntry[] {
  return sources.map((source) => ({
    id: source.id,
    displayName: source.displayName ?? source.id,
    policy: source.policy ?? "unverified",
    category: source.category,
    status:
      source.status === "running" || source.status === "unavailable"
        ? "error"
        : (source.status as SourceReportEntry["status"]),
    reason: source.reason,
    offers: source.candidates ?? 0,
  }));
}
