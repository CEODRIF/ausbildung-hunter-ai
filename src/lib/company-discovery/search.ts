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
  candidateFromOpportunity,
  companyFactsFromOpportunity,
  discoveryBeginnGate,
  goalPasses,
  mapToSearchParams,
} from "./normalize";
import { companyKeyOf, isUsableCompanyName } from "./dedupe";
import {
  TERMINAL_RUN_STATUSES,
  discoveryLimits,
  type DiscoveryCandidate,
  type DiscoveryRun,
  type DiscoverySourceStatus,
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
import {
  countsAsResult,
  fetchCompanySiteTextPages,
  resolveCompanyPublicEmail,
} from "./emails";

/**
 * Page-fetch budget for the public-email pass, per run. Addresses that the
 * source already published cost nothing; only companies whose site may hold a
 * better (application/career) mailbox spend one pass. Bounded so the run stays
 * inside its serverless time budget.
 */
const MAX_EMAIL_SITE_PASSES_PER_RUN = 8;

/** Audit reason recorded when a company is dropped for lack of an address. */
const NO_PUBLIC_EMAIL_REASON = "no_public_email";

/**
 * Company Discovery — Phase 2 candidate engine (BA / Opportunities).
 *
 * Pipeline: run (Phase 1 model) → per-goal pass over the EXISTING
 * Opportunities search engine (shared cache, BA matchers: goal consistency,
 * role tokens, beginn now/month, field as `was`) → candidate offers →
 * discovery gates (usable employer name, beginn date/year, dedupe) →
 * unique companies, until the TARGET of unique companies is reached or the
 * bounded server limits are exhausted.
 *
 * Hard rules:
 *  - TARGET counts UNIQUE COMPANIES, never offers (1 offer per company at
 *    most; the rest are counted as duplicates and removed);
 *  - no email logic in this phase (Phase 5) — a company is counted when it
 *    is identified and passes the gates;
 *  - source failure (including CAPTCHA/WAF blocks, which are treated as
 *    plain source failures — NEVER bypassed) degrades the run, it does not
 *    fake results: found stays the honest number;
 *  - every counter written is a real, measured value (Phase 7 renders them
 *    without interpretation);
 *  - cancellation is honored between work units: a run that left
 *    pending/running (Stop Search) never starts a new pass, never processes
 *    a new offer, and never writes a finish state over the cancellation;
 *  - the client is never trusted: target/bounds come from the validated run
 *    row + server-side discoveryLimits(), never from request extras.
 */

export interface DiscoveryPipelineDeps {
  /** Window provider. Default: the shared Opportunities engine (cached).
   *  Injectable for tests — must emulate the engine contract (filtered,
   *  goal-consistent window; `mode` semantics). */
  window?: (params: OpportunitySearchParams) => Promise<OpportunityWindow>;
  /** Cancellation probe. Default: re-read the run; stop when it is gone or
   *  terminal. Injectable for tests. */
  isCancelled?: (runId: string, userId: string) => Promise<boolean>;
}

/** Offers processed between run re-reads (cancellation granularity). */
const CANCEL_CHECK_EVERY = 25;
/** Candidate upserts per DB round trip. */
const CANDIDATE_FLUSH_EVERY = 50;
/** Hard cap on upstream pagination pages per pass (10 × 50 = 500). */
const MAX_UPSTREAM_PAGES = 10;

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
      // Gone, or terminal: a terminal run must never be continued.
      return (
        run === null ||
        (TERMINAL_RUN_STATUSES.includes(run.status) &&
          run.status !== "running")
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
  };
  /** Company keys already counted in this run (the dedupe set). */
  const countedKeys = new Set<string>();
  /** Company keys that failed a gate so far (event counting, no rows). */
  const rejectedKeys = new Set<string>();
  const sources: DiscoverySourceStatus[] = [
    { id: BA_SOURCE_ID, status: "running" },
  ];
  let delivered = 0;
  /** Remaining official-site passes for the public-email resolution. */
  let emailSiteBudget = MAX_EMAIL_SITE_PASSES_PER_RUN;
  let failedPasses = 0;
  let candidateBuffer: DiscoveryCandidate[] = [];
  let aborted = false;

  const flushCandidates = async (): Promise<void> => {
    if (candidateBuffer.length === 0) return;
    await recordCandidates(runId, candidateBuffer);
    candidateBuffer = [];
  };
  const flushProgress = async (): Promise<void> => {
    const status: DiscoverySourceStatus["status"] =
      failedPasses > 0 && failedPasses === goalPasses(params.goal).length
        ? "unavailable"
        : "ok";
    sources[0] = { id: BA_SOURCE_ID, status, candidates: delivered };
    await setRunCounters(runId, userId, { ...counters }, sources);
  };

  const collectOffers = async (passGoal: "ausbildung" | "arbeit"): Promise<OpportunityWindow & { offers: Opportunity[] }> => {
    const sp = mapToSearchParams(params, passGoal);
    const collected: Opportunity[] = [];
    let window: OpportunityWindow;
    let page = 1;
    for (;;) {
      window = await windowFn({ ...sp, page });
      collected.push(...window.window);
      if (window.mode === "scan") break; // the scan window IS the full set
      if (page * sp.pageSize >= window.total) break; // source exhausted
      if (collected.length >= limits.maxCandidates) break; // run budget
      if (page >= MAX_UPSTREAM_PAGES) break; // hard pagination cap
      page += 1;
    }
    return { ...window, offers: collected };
  };

  const processOffers = async (
    offers: Opportunity[],
    passGoal: "ausbildung" | "arbeit",
  ): Promise<void> => {
    let sinceProgress = 0;
    for (const opp of offers) {
      // Stop conditions (target / budget / company cap / cancellation).
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
        source: BA_SOURCE_ID,
        ...candidateFromOpportunity(opp),
      });
      if (candidateBuffer.length >= CANDIDATE_FLUSH_EVERY) await flushCandidates();

      // Defense in depth: a window row whose own classification contradicts
      // the pass never counts (the engine already enforces this).
      if (opp.goal !== passGoal) continue;
      // No documented employer → the offer stays a candidate, but it can
      // never become a counted company (no invention).
      if (!isUsableCompanyName(opp.company_name)) continue;

      const key = companyKeyOf(opp.company_name);
      if (countedKeys.has(key)) {
        counters.duplicatesRemoved += 1;
        continue;
      }
      // Discovery beginn gate (date/year modes; now/month are engine-applied
      // upstream of this point). Missing documented start → rejected.
      if (!discoveryBeginnGate(opp, params.beginn)) {
        if (!rejectedKeys.has(key)) {
          counters.companiesRejected += 1;
          rejectedKeys.add(key);
        }
        continue;
      }
      // Accepted — an earlier rejection of the same company is superseded
      // (a later offer of the same company can pass where the first did not).
      rejectedKeys.delete(key);
      // Public email: resolved ONLY from what was actually published — the
      // source's own offer contact block, the engine's verified enrichment, or
      // the company's official pages. Never invented, never name-derived.
      const emailResolution = await resolveCompanyPublicEmail({
        companyName: opp.company_name ?? "",
        offer: opp,
        websiteUrl: opp.enrichment?.website_url ?? null,
        fetchPages: emailSiteBudget > 0 ? fetchCompanySiteTextPages : null,
      });
      if (emailResolution?.fetchedSite) emailSiteBudget -= 1;

      // onlyPublicEmail = true → a company without a published address is not
      // a deliverable result: it is recorded for audit but never counted, so a
      // run may end honestly PARTIAL (4 of 10) instead of inventing rows.
      if (
        !countsAsResult({
          onlyPublicEmail: params.onlyPublicEmail,
          hasPublicEmail: emailResolution !== null,
        })
      ) {
        if (!rejectedKeys.has(key)) {
          counters.companiesRejected += 1;
          rejectedKeys.add(key);
        }
        await recordCompany(runId, {
          ...companyFactsFromOpportunity(opp, params, key),
          websiteUrl: opp.enrichment?.website_url ?? null,
          websiteSourceUrl: null,
          status: "rejected",
          rejectReason: NO_PUBLIC_EMAIL_REASON,
        });
        continue;
      }

      const { companyId } = await recordCompany(runId, {
        ...companyFactsFromOpportunity(opp, params, key),
        // The engine's verified website (with its own provenance) or null.
        websiteUrl: opp.enrichment?.website_url ?? null,
        websiteSourceUrl: opp.enrichment?.website_source ?? null,
        status: "accepted",
      });
      if (emailResolution) {
        try {
          await recordCompanyEmail(
            companyId,
            emailResolution.email,
            emailResolution.sourceUrl,
            emailResolution.sourceType,
            emailResolution.confidence,
          );
        } catch (error) {
          // Storing the address is valuable but never load-bearing: a database
          // where the email table has not been migrated yet must NOT fail the
          // run (the company itself is already recorded). Logged loudly so the
          // drift is visible to operators instead of hiding.
          console.error(
            `[company-discovery] storing a public email failed run="${runId}" company="${companyId}"`,
            error,
          );
        }
      }
      countedKeys.add(key);
      counters.uniqueCompanies += 1;
      counters.foundCompanies += 1;
      sinceProgress = 0;
      await flushProgress(); // real progress per counted company
    }
    if (sinceProgress > 0) await flushProgress();
  };

  try {
    const passes = goalPasses(params.goal);
    for (const passGoal of passes) {
      if (
        counters.foundCompanies >= target ||
        countedKeys.size >= maxCompanies
      ) {
        break;
      }
      if (await isCancelled(runId, userId)) {
        aborted = true;
        break;
      }
      try {
        const { offers } = await collectOffers(passGoal);
        delivered += offers.length;
        await processOffers(offers, passGoal);
        // A cancellation observed mid-batch aborts the run immediately —
        // the next pass must never start (Stop Search contract).
        if (aborted) break;
      } catch (error) {
        // A source failure (network, timeout, 429, 5xx, or a deliberate
        // block/challenge) degrades THIS pass; the remaining pass(es) still
        // run. The failure is recorded as plain "source unavailable" — the
        // platform never attempts to bypass access controls.
        if (error instanceof BaFetchFailure) {
          failedPasses += 1;
        } else {
          throw error;
        }
      }
    }

    await flushCandidates();
    if (aborted) {
      // The run was cancelled (or is otherwise terminal) — its state is
      // authoritative; the pipeline leaves it exactly as the store holds it.
      return (await getDiscoveryRun(runId, userId)) ?? run0;
    }

    const found = counters.foundCompanies;
    const allPassesFailed = failedPasses === passes.length;
    const status: "completed" | "partial" | "failed" =
      found >= target
        ? "completed"
        : found > 0
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
      sources: [
        {
          id: BA_SOURCE_ID,
          status: allPassesFailed ? "unavailable" : "ok",
          candidates: delivered,
        },
      ],
      error:
        status === "failed"
          ? "The primary source was unavailable; no companies could be collected."
          : null,
    });
  } catch (error) {
    // Unexpected failure: record a controlled terminal state (no secrets,
    // no stack traces) unless the run is already terminal (e.g. cancelled).
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
      sources: [
        {
          id: BA_SOURCE_ID,
          status: failedPasses > 0 ? "unavailable" : "ok",
          candidates: delivered,
        },
      ],
      error: "The discovery run failed.",
    }).catch(() => undefined);
    throw error;
  }
}
