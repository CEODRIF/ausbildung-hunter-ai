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
import { enabledAdapters } from "./adapters";
import type { NormalizedOffer } from "./adapter";
import {
  candidateFromOffer,
  companyFactsFromOffer,
  discoveryBeginnGate,
  goalPasses,
  mapToSearchParams,
  type DiscoveryOffer,
} from "./normalize";
import { companyKeyOf, isUsableCompanyName } from "./dedupe";
import { createFetchContext, type FetchContext } from "./fetch-guard";
import {
  createGuardedSiteFetcher,
  countsAsResult,
  resolveCompanyEmails,
} from "./emails";
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
  type DiscoverySourceStatus,
  type SourceReportEntry,
} from "./types";
import {
  finishDiscoveryRun,
  getDiscoveryRun,
  recordCandidates,
  recordCompany,
  recordCompanyEmail,
  setRunCounters,
  startDiscoveryRun,
} from "./runs";

/**
 * Company Discovery — the orchestrator.
 *
 * Pipeline: run (Phase 1 model) → per-goal passes over (a) the EXISTING
 * Opportunities engine (Arbeitsagentur: offers and companies ONLY — never an
 * email, §3.3) and (b) every portal adapter the access policy cleared → unique
 * companies → the multi-source public-email pass → incremental persistence.
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

  const counters = {
    foundCompanies: 0,
    offersAnalyzed: 0,
    uniqueCompanies: 0,
    duplicatesRemoved: 0,
    companiesRejected: 0,
    emailsFound: 0,
    noPublicEmail: 0,
    sourcesBlocked: 0,
    companiesProcessed: 0,
  };
  /** Company keys already counted in this run (the dedupe set). */
  const countedKeys = new Set<string>();
  /** Company keys that failed a gate so far (event counting, no rows). */
  const rejectedKeys = new Set<string>();

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

  const fetchContext =
    deps.fetchContext ??
    createFetchContext(
      deps.isPublicHost ? { isPublicHost: deps.isPublicHost } : {},
    );
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
  const adapters =
    deps.adapters ??
    enabledAdapters({
      searchClient: offerSearchClient,
      searchBudget: {
        maxQueries: limits.maxSearchQueries,
        maxResultsPerQuery: limits.maxSearchResultsPerQuery,
        maxPagesPerQuery: limits.maxSearchPagesPerQuery,
        maxPagesToFetch: limits.maxSearchPagesToFetch,
      },
      searchMeta: { beginnYear, beginnMonth },
    });
  const searchClient =
    deps.searchClient === undefined ? getWebSearchClient() : deps.searchClient;
  /** Permitted public-search attempts issued in this run (client cap aware). */
  let searchAttempts = 0;

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
  }> = [];
  /** Remaining official-site passes for the public-email resolution. */
  let emailSiteBudget = discoveryEmailSitePasses();
  let failedPasses = 0;
  let candidateBuffer: DiscoveryCandidate[] = [];
  let aborted = false;

  const flushCandidates = async (): Promise<void> => {
    if (candidateBuffer.length === 0) return;
    await recordCandidates(runId, candidateBuffer);
    candidateBuffer = [];
  };
  const flushProgress = async (): Promise<void> => {
    if (failedPasses > 0 && failedPasses === goalPasses(params.goal).length) {
      upsertSource(BA_SOURCE_ID, { status: "unavailable", candidates: delivered });
    } else {
      upsertSource(BA_SOURCE_ID, { status: "ok", candidates: delivered });
    }
    await setRunCounters(runId, userId, { ...counters }, [...sourceStatus.values()]);
  };

  const collectOffers = async (
    passGoal: "ausbildung" | "arbeit",
  ): Promise<OpportunityWindow & { offers: Opportunity[] }> => {
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
   * Ask every enabled adapter. A blocked or failing adapter marks its own
   * source entry and is then irrelevant to the rest of the run (§4.7).
   */
  const collectAdapterOffers = async (
    passGoal: "ausbildung" | "arbeit",
  ): Promise<DiscoveryOffer[]> => {
    const sp = mapToSearchParams(params, passGoal);
    const collected: DiscoveryOffer[] = [];
    for (const adapter of adapters) {
      const source = sourceById(adapter.id);
      if (!source) continue;
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

  /** The permitted public-search step for ONE company (§4.1 step 3). */
  const searchForCompany = async (
    companyName: string,
  ): Promise<{ ran: boolean; results: Array<{ content: string; sourceUrl: string }> }> => {
    if (!searchClient) return { ran: false, results: [] };
    // The provider caps its own requests per run; an attempt beyond that cap
    // would silently return [] and must never be mistaken for "nothing found".
    if (searchAttempts >= MAX_TAVILY_REQUESTS_PER_RUN) {
      return { ran: false, results: [] };
    }
    if (searchAttempts >= limits.maxTavilyQueries) {
      return { ran: false, results: [] };
    }
    searchAttempts += 1;
    try {
      const results = await searchClient.search(
        `"${companyName}" Impressum E-Mail Kontakt`,
        3,
      );
      return {
        ran: true,
        results: results.map((entry) => ({
          content: `${entry.title}\n${entry.snippet}`,
          sourceUrl: entry.url,
        })),
      };
    } catch {
      // The provider refused or failed: the step did NOT run successfully.
      return { ran: false, results: [] };
    }
  };

  const processOffers = async (
    offers: DiscoveryOffer[],
    passGoal: "ausbildung" | "arbeit",
  ): Promise<void> => {
    let sinceProgress = 0;
    for (const offer of offers) {
      if (
        counters.foundCompanies >= target ||
        counters.offersAnalyzed >= limits.maxCandidates ||
        countedKeys.size >= maxCompanies
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

      if (offer.goal !== passGoal) continue;
      if (!isUsableCompanyName(offer.companyName)) continue;

      const key = companyKeyOf(offer.companyName);
      if (countedKeys.has(key)) {
        counters.duplicatesRemoved += 1;
        continue;
      }
      if (!discoveryBeginnGate({ valid_from: offer.beginn }, params.beginn)) {
        if (!rejectedKeys.has(key)) {
          counters.companiesRejected += 1;
          rejectedKeys.add(key);
        }
        continue;
      }
      rejectedKeys.delete(key);

      // ---- the email pass, inside its own error boundary ------------------
      let resolution: Awaited<ReturnType<typeof resolveCompanyEmails>>;
      try {
        const search = offer.companyWebsite
          ? { ran: false, results: [] }
          : await searchForCompany(offer.companyName ?? "");
        const siteBudgetAvailable = emailSiteBudget > 0;
        resolution = await resolveCompanyEmails({
          companyName: offer.companyName ?? "",
          listingEmail: offer.listingEmail,
          websiteUrl: offer.companyWebsite,
          search,
          trustedPages: [],
          fetchSite: siteBudgetAvailable ? siteFetcher : null,
        });
        // Only a company that actually had a website checked spends a slot.
        if (offer.companyWebsite && siteBudgetAvailable) emailSiteBudget -= 1;
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
          requiredInspected: false,
          blocked: true,
          blockedReason: "unreachable",
          reasonCode: "source_blocked",
          primary: null,
        };
      }

      counters.companiesProcessed += 1;
      const outcome = resolution.reasonCode;
      if (outcome === "email_found") counters.emailsFound += 1;
      else if (outcome === "source_blocked" || outcome === "no_website_found")
        counters.sourcesBlocked += 1;
      else counters.noPublicEmail += 1;

      // The audit label of a rejected company. `no_website_found` is its own
      // reason (the required search step could not run); it is still an
      // OUTCOME of type source_blocked, and the two are never interchanged.
      const label =
        outcome === "no_website_found"
          ? REJECT_NO_WEBSITE
          : outcome === "source_blocked"
            ? REJECT_SOURCE_BLOCKED
            : outcome === "no_public_email"
              ? REJECT_NO_PUBLIC_EMAIL
              : "email_found";

      if (
        !countsAsResult({
          onlyPublicEmail: params.onlyPublicEmail,
          hasPublicEmail: resolution.primary !== null,
          outcome:
            outcome === "no_website_found" ? "source_blocked" : outcome,
        })
      ) {
        if (!rejectedKeys.has(key)) {
          counters.companiesRejected += 1;
          rejectedKeys.add(key);
        }
        await recordCompany(runId, {
          ...companyFactsFromOffer(offer, params, key),
          websiteUrl: offer.companyWebsite,
          websiteSourceUrl: offer.companyWebsiteSourceUrl,
          status: "rejected",
          rejectReason: label,
          emailStatus: outcome === "no_website_found" ? "source_blocked" : outcome,
        });
        await flushProgress();
        continue;
      }

      const { companyId } = await recordCompany(runId, {
        ...companyFactsFromOffer(offer, params, key),
        websiteUrl: offer.companyWebsite,
        websiteSourceUrl: offer.companyWebsiteSourceUrl,
        status: "accepted",
        emailStatus: outcome === "no_website_found" ? "source_blocked" : outcome,
      });
      if (resolution.primary) {
        try {
          await recordCompanyEmail(companyId, resolution.primary);
        } catch (error) {
          console.error(
            `[company-discovery] storing a public email failed run="${runId}" company="${companyId}"`,
            error,
          );
        }
      }
      countedKeys.add(key);
      counters.uniqueCompanies += 1;
      counters.foundCompanies += 1;
      if (offer.companyWebsite) {
        acceptedSites.push({
          websiteUrl: offer.companyWebsite,
          goal: offer.goal,
          field: params.field,
        });
      }
      sinceProgress = 0;
      await flushProgress();
    }
    if (sinceProgress > 0) await flushProgress();
  };

  try {
    const passes = goalPasses(params.goal);
    for (const passGoal of passes) {
      if (counters.foundCompanies >= target || countedKeys.size >= maxCompanies) break;
      if (await isCancelled(runId, userId)) {
        aborted = true;
        break;
      }

      // (a) Arbeitsagentur: offers and companies only (§3.3) — collect the
      //     window first (a fast read; no per-company email work yet).
      let baOffers: DiscoveryOffer[] = [];
      try {
        const { offers } = await collectOffers(passGoal);
        delivered += offers.length;
        baOffers = offers.map((opp) => discoveryOfferFromOpportunity(opp));
      } catch (error) {
        if (error instanceof BaFetchFailure) {
          failedPasses += 1;
          upsertSource(BA_SOURCE_ID, {
            status: "unavailable",
            reason: "SOURCE_UNAVAILABLE",
            candidates: delivered,
          });
        } else {
          throw error;
        }
      }

      // (b) the enabled portal adapters (including the bounded search layer),
      //     collected BEFORE the expensive per-company email resolution. On a
      //     serverless host the run shares the route's invocation budget
      //     (Vercel `maxDuration`): the email phase paces ≥1 s per host per
      //     company and runs for minutes, so a kill would otherwise strike
      //     before the search layer ever starts — and its stats would never
      //     be persisted. Collecting all offer sources first keeps the entire
      //     offer-discovery phase inside the budget, then a checkpoint
      //     persists the BA row, the adapter rows and the search stats.
      const adapterOffers = await collectAdapterOffers(passGoal);
      await flushProgress();
      if (await isCancelled(runId, userId)) {
        aborted = true;
        break;
      }

      // Per-company email resolution — processing order unchanged (BA offers
      // first, then the adapter offers) through the same funnel and dedupe
      // set; its existing per-company flushes persist the partial progress.
      await processOffers(baOffers, passGoal);
      if (aborted) break;
      await processOffers(adapterOffers, passGoal);
      if (aborted) break;
    }

    // (c) company-website offer discovery (§11): a bounded pass over the
    //     already-accepted companies that carry a verified official domain.
    //     Its offers flow through the SAME funnel (normalization → dedupe →
    //     gates → email resolution), so an already-counted company is only a
    //     duplicate, and the §4.8 outcome invariant is preserved.
    if (!aborted && acceptedSites.length > 0 && counters.foundCompanies < target) {
      const sites = acceptedSites.slice(0, limits.maxCompanySiteOfferCompanies);
      upsertSource(COMPANY_WEBSITES_LAYER.id, {
        displayName: COMPANY_WEBSITES_LAYER.displayName,
        policy: COMPANY_WEBSITES_LAYER.policy,
        category: COMPANY_WEBSITES_LAYER.category,
        status: "running",
        candidates: 0,
      });
      let siteOffersTotal = 0;
      const siteOffersByGoal: Record<"ausbildung" | "arbeit", DiscoveryOffer[]> = {
        ausbildung: [],
        arbeit: [],
      };
      for (const site of sites) {
        if (counters.foundCompanies >= target || countedKeys.size >= maxCompanies) break;
        if (await isCancelled(runId, userId)) {
          aborted = true;
          break;
        }
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
      if (!aborted) {
        await processOffers(siteOffersByGoal.ausbildung, "ausbildung");
        await processOffers(siteOffersByGoal.arbeit, "arbeit");
        upsertSource(COMPANY_WEBSITES_LAYER.id, {
          status: "ok",
          candidates: siteOffersTotal,
        });
      }
    }

    await flushCandidates();
    if (aborted) {
      return (await getDiscoveryRun(runId, userId)) ?? run0;
    }

    const found = counters.foundCompanies;
    const allPassesFailed = failedPasses === passes.length;
    const status: "completed" | "partial" | "failed" =
      found >= target
        ? "completed"
        : found > 0 || counters.companiesProcessed > 0
          ? "partial"
          : allPassesFailed
            ? "failed"
            : "partial";
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
      sources: [...sourceStatus.values()],
      error: "The discovery run failed.",
    }).catch(() => undefined);
    throw error;
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

/** Exported for tests: the outcome counters must always add up. */
export function outcomeSum(input: {
  emailsFound: number;
  noPublicEmail: number;
  sourcesBlocked: number;
}): number {
  return input.emailsFound + input.noPublicEmail + input.sourcesBlocked;
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
