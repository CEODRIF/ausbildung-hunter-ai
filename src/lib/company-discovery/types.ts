/**
 * Company & Email Discovery — domain model.
 *
 * The discovery engine collects UNIQUE GERMAN COMPANIES with a PUBLICLY
 * PUBLISHED contact email for the user's field/role — not a page of offers.
 *
 * Core invariant (non-negotiable):
 *   TARGET = unique companies with a public email.
 *   100 offers of one company = 1 result (when it has a public email).
 *
 * This module is PURE (no server-only, no env access at import time) so it
 * is imported by both the client (form + validation) and the server
 * (orchestration, persistence, export). Runtime configuration lives in
 * `discoveryLimits()` and is only called server-side.
 *
 * Reuse map (existing systems this model plugs into — see Phase plan):
 *   - candidate offers     → src/lib/opportunities (BA provider + types)
 *   - company enrichment   → src/lib/opportunities/enrichment (cache, pages,
 *                            website discovery, deterministic email rules)
 *   - web discovery        → src/lib/web-search (Tavily client + guarded
 *                            page fetcher with robots/SSRF/anti-bot guards)
 *   - credits              → charge_search_credits RPC (target ∈ 10/25/50/100)
 */

import { z } from "zod";
import { enabledSources, type SourceCategory } from "./sources";

// ---------------------------------------------------------------------------
// Target (unique companies with a public email — NEVER a number of offers)
// ---------------------------------------------------------------------------

/** Lower bound of the target (matches the credit-charge allow-list floor). */
export const DISCOVERY_TARGET_MIN = 10;
/** Upper bound of the target a single run may request. */
export const DISCOVERY_TARGET_MAX = 500;
/** Default target when the user leaves the field untouched. */
export const DISCOVERY_TARGET_DEFAULT = 100;

// ---------------------------------------------------------------------------
// Goal / offer type
// ---------------------------------------------------------------------------

/** What the user is looking for. `both` runs two independent source passes
 *  (Ausbildung + Job) — a result always carries exactly one concrete type. */
export type DiscoveryGoal = "ausbildung" | "arbeit" | "both";

export const discoveryGoalSchema = z.enum(["ausbildung", "arbeit", "both"]);

// ---------------------------------------------------------------------------
// Beginn (planned start) — a DISTINCT dimension from "published since"
// ---------------------------------------------------------------------------

/**
 * Planned-start constraint. All concrete modes require a DOCUMENTED start
 * (BA: eintrittszeitraum.von / valid_from) — an offer without a documented
 * start is rejected when a concrete mode is selected (never guessed).
 */
export type DiscoveryBeginn =
  | { mode: "from_now" }
  | { mode: "date"; date: string } // YYYY-MM-DD
  | { mode: "month"; month: string } // YYYY-MM
  | { mode: "year"; year: number };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

export const discoveryBeginnSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("from_now") }),
  z.object({
    mode: z.literal("date"),
    date: z.string().regex(DATE_RE, "Expected YYYY-MM-DD"),
  }),
  z.object({
    mode: z.literal("month"),
    month: z.string().regex(MONTH_RE, "Expected YYYY-MM"),
  }),
  z.object({
    mode: z.literal("year"),
    year: z.number().int().min(2024).max(2100),
  }),
]);

// ---------------------------------------------------------------------------
// Run parameters
// ---------------------------------------------------------------------------

/**
 * Curated field suggestions (UI datalist + discovery query seeds).
 * Free text is always allowed — the list is a convenience, not a whitelist.
 * Values are the real search terms used against the German sources.
 */
export const DISCOVERY_FIELD_SUGGESTIONS: readonly string[] = [
  "Marketing / E-Commerce",
  "Kaufmann im E-Commerce",
  "IT / Informatik",
  "Büro / Verwaltung",
  "Logistik / Supply Chain",
  "Gesundheit / Pflege",
  "Technik / Handwerk",
  "Handel / Einzelhandel",
  "Finanzen / Rechnungswesen",
  "Tourismus / Hotellerie",
];

/**
 * The validated input of one discovery run.
 *
 * - `field`: the broader area (relevance + discovery queries).
 * - `role`:  the concrete occupation (e.g. "Kaufmann im E-Commerce") —
 *            mapped to the BA search term server-side.
 * - `targetCompanies`: how many UNIQUE companies (with a public email when
 *            `onlyPublicEmail` is true) the run must find before stopping.
 *            This is NOT a number of offers.
 */
export const discoveryRunParamsSchema = z.object({
  field: z.string().trim().min(1, "field_required").max(120),
  role: z.string().trim().min(1, "role_required").max(160),
  beginn: discoveryBeginnSchema,
  goal: discoveryGoalSchema.default("ausbildung"),
  targetCompanies: z
    .number()
    .int()
    .min(DISCOVERY_TARGET_MIN)
    .max(DISCOVERY_TARGET_MAX)
    .default(DISCOVERY_TARGET_DEFAULT),
  /** When true (default) a company only counts — and only appears in the
   *  Excel — with a publicly published email. When false the run collects
   *  unique companies and marks which ones have no public email. */
  onlyPublicEmail: z.boolean().default(true),
});
export type DiscoveryRunParams = z.infer<typeof discoveryRunParamsSchema>;

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

/** Run states (mirrors the `discovery_runs.status` check constraint). */
export type DiscoveryRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "partial"
  | "cancelled"
  | "failed";

export const discoveryRunStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "partial",
  "cancelled",
  "failed",
]);

/** Terminal states — a run in one of these never starts (more) work. */
export const TERMINAL_RUN_STATUSES: readonly DiscoveryRunStatus[] = [
  "completed",
  "partial",
  "cancelled",
  "failed",
] as const;

/**
 * Per-source live status for the progress UI. Honest counters only:
 * `candidates` is the number of real candidate offers the source actually
 * yielded in this run (0/undefined before the source ran).
 */
export interface DiscoverySourceStatus {
  /** Stable source id, e.g. "arbeitsagentur", "ausbildung-de". */
  id: string;
  /** Human-readable name for the source report (registry displayName). */
  displayName?: string;
  /** The access-policy classification the registry assigned (§3.4). */
  policy?: SourceReportEntry["policy"];
  /** The source family for the report / UI (registry `category`). */
  category?: SourceCategory;
  /** ok: delivered candidates. running: in progress. unavailable: failed.
   *  blocked: an access control answered (reason says which). error: technical
   *  failure after bounded retries. skipped_by_policy: registered but never
   *  requested. `skipped`: not part of the plan. */
  status:
    | "ok"
    | "running"
    | "unavailable"
    | "skipped"
    | "blocked"
    | "skipped_by_policy"
    | "error";
  /** Reason code for blocked/error (machine-readable, §4.4). */
  reason?: string;
  /** Real candidate count from this source (when the source ran). */
  candidates?: number;
  /**
   * Layer-specific execution stats (the search layer only). Persisted inside
   * the sources jsonb — no migration. `queriesExecuted` is the number of
   * provider queries actually issued; `resultsInspected` the number of result
   * pages fetched AND parsed (blocked pages are NOT inspected).
   */
  stats?: { queriesExecuted: number; resultsInspected: number };
}

/**
 * REAL run progress — every number comes from the run state, never from a
 * timer or a fixed script. The client renders exactly what the server
 * reports; nothing is interpolated or faked.
 */
export interface DiscoveryProgress {
  status: DiscoveryRunStatus;
  /** The requested target (unique companies with a public email). */
  targetCompanies: number;
  /** Counted results: unique companies that met the quality gate. */
  foundCompanies: number;
  /** Candidate offers actually fetched + normalized so far. */
  offersAnalyzed: number;
  /** Distinct companies identified after dedupe so far. */
  uniqueCompanies: number;
  /** Offers dropped because their company was already counted. */
  duplicatesRemoved: number;
  /** Companies rejected by the quality gate (beginn, offer type, …). */
  companiesRejected: number;
  /** Companies whose outcome is `email_found` (§4.8). */
  emailsFound: number;
  /** Companies whose outcome is `no_public_email` — every required source was
   *  inspected successfully and published no address (§4.4). NEVER a block. */
  noPublicEmail: number;
  /** Companies whose outcome is `source_blocked` (§4.4) — a required source
   *  refused, so the outcome is INCONCLUSIVE, not "no public email". */
  sourcesBlocked: number;
  /** Live per-source status. */
  sources: DiscoverySourceStatus[];
  /** Companies whose email outcome was resolved in the run (§4.8). Exposed
   *  read-only (the column is migration-dependent → 0 on older rows). */
  companiesProcessed: number;
  /**
   * Live research state (agentic engine): the provider query currently being
   * executed by the search layer, or the last one it executed (null before
   * the first query / on a database without the column). The UI shows it as
   * "Current query" — a real measured value, never a simulated one.
   */
  currentQuery: string | null;
  /**
   * Live research state (agentic engine): the source currently running (the
   * search layer while it issues queries, "arbeitsagentur" while the BA
   * window is collected, …) — null when nothing is running or on an older
   * row.
   */
  currentSource: string | null;
  /**
   * Live research state (agentic engine): the strategy the planner is
   * currently executing (its rendered note — a real measured decision, never
   * invented) — null before the first batch or on an older row.
   */
  currentStrategy: string | null;
}

/**
 * One counted result of a discovery run: exactly ONE unique company.
 *
 * Provenance is mandatory: `emailSourceUrl` is the public page the address
 * was read from (null whenever email is null), `offerUrl` is the source
 * page the company was discovered through. `email` is never generated from
 * the company name and never verified by sending anything.
 */
export type DiscoveryEmailSource =
  // The vocabulary of the target model (§4.5).
  | "job_listing"
  | "official_site_impressum"
  | "official_site_contact"
  | "official_site_career"
  | "official_site_jobs"
  | "official_site_ausbildung"
  | "official_site_contact_person"
  | "official_site_other"
  | "search_result"
  | "trusted_public_page"
  // Values shipped by the first release. Still accepted so already-stored rows
  // stay readable, and still written for pages that map onto them 1:1.
  | "offer"
  | "company_website"
  | "impressum"
  | "kontakt"
  | "karriere"
  | "ausbildung"
  | "bewerbungen";

/** The three company-level outcomes (§4.4) — never merged with each other. */
export type DiscoveryEmailOutcome =
  | "email_found"
  | "no_public_email"
  | "source_blocked";

export const DISCOVERY_EMAIL_OUTCOMES: readonly DiscoveryEmailOutcome[] = [
  "email_found",
  "no_public_email",
  "source_blocked",
] as const;

/**
 * One access attempt against a source/host, kept for explainability: which
 * host, which URL, why it ended, and with which HTTP status (§4.4).
 */
export interface SourceAttempt {
  /** Registrable host (per-host circuit breaker granularity). */
  host: string;
  url: string | null;
  /** `ok`, a blocked reason, or a technical failure (`error`). */
  outcome: string;
  status: number | null;
  at: string;
}

/** Per-portal outcome of ONE run — the source report (§4.8). */
export interface SourceReportEntry {
  id: string;
  displayName: string;
  policy: "enabled_public" | "enabled_official_api" | "restricted" | "unverified";
  /** The source family (registry `category`); optional for legacy rows. */
  category?: SourceCategory;
  status: "ok" | "blocked" | "skipped_by_policy" | "skipped" | "error";
  /** Machine reason for `blocked` / `error`. */
  reason?: string;
  /** Real number of offers this source yielded in the run. */
  offers: number;
}

export interface DiscoveredCompany {
  /** Stable identity key (normalized company name) — unique per run. */
  companyKey: string;
  companyName: string;
  /** Public email, or null (then the row is a rejected/unqualified company
   *  and is NOT counted towards the target). */
  email: string | null;
  /** The public page the email was read from. */
  emailSourceUrl: string | null;
  /** Where the email was found (ordered source list). */
  emailSourceType: DiscoveryEmailSource | null;
  emailConfidence: "high" | "medium" | "low" | null;
  /** The company's OWN official website (portals/directories excluded by
   *  the existing domain guard), or null when not identified. */
  websiteUrl: string | null;
  /** Evidence page proving the website belongs to the company. */
  websiteSourceUrl: string | null;
  /** The concrete occupation the counted offer documented. */
  role: string | null;
  /** The run's field (relevance context). */
  field: string;
  /** Concrete offer type of the counted offer (goal "both" resolves one of
   *  these per company). */
  offerType: "ausbildung" | "arbeit";
  city: string | null;
  state: string | null;
  /** Documented planned start (ISO date) of the counted offer, or null. */
  beginn: string | null;
  /** Salary label as documented by the source (de-DE), or null. */
  salaryLabel: string | null;
  /** Human-readable source name of the counting offer. */
  offerSource: string | null;
  /** Public URL of the counting offer. */
  offerUrl: string | null;
  /** When the company was first counted for this run (UTC ISO). */
  discoveredAt: string;
}

/** A raw candidate offer (pre-dedupe) as collected by a source connector. */
export interface DiscoveryCandidate {
  /** Stable offer identity, e.g. "arbeitsagentur:123" or a content hash. */
  candidateRef: string;
  /** Source id that yielded the candidate. */
  source: string;
  title: string | null;
  /** Source-documented company name — null when the source names none
   *  (such a candidate can never become a counted company). */
  companyName: string | null;
  city: string | null;
  goal: "ausbildung" | "arbeit";
  /** Documented planned start, or null. */
  beginn: string | null;
  salaryLabel: string | null;
  url: string | null;
}

/** The full run object as served to the client. */
export interface DiscoveryRun {
  runId: string;
  status: DiscoveryRunStatus;
  params: DiscoveryRunParams;
  progress: DiscoveryProgress;
  /** Credits charged for this run (0 until the orchestration phase wires
   *  charge_search_credits). */
  creditsCharged: number;
  /** Controlled, user-safe error message when status === "failed". */
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// ---------------------------------------------------------------------------
// Server-side safety limits (configurable — never hardcoded in the UI)
// ---------------------------------------------------------------------------

/**
 * Bounded resources for ONE run. Defaults are conservative; every value can
 * be raised via a server environment variable (operational tuning without a
 * deploy of code). The UI never displays these numbers.
 */
export interface DiscoveryLimits {
  /** Maximum candidate offers to fetch/normalize in the run. */
  maxCandidates: number;
  /** Maximum distinct companies to resolve (website + email) in the run. */
  maxCompaniesToResolve: number;
  /** Bounded concurrency for page fetches / company resolution. */
  maxConcurrent: number;
  /** Maximum Tavily search requests across the whole run. */
  maxTavilyQueries: number;
  /** Maximum guarded page fetches per company (matches the existing
   *  enrichment guard — kept identical on purpose). */
  maxPagesPerCompany: number;
  /** Hard wall-clock budget for the run. */
  maxRuntimeMs: number;
  // ---- Internet discovery fan-out (§17) — the search radius, NOT volume ----
  /** Structured search-engine QUERIES (families) for the OFFER-discovery
   *  layer. Default 12 (target 10–15), hard cap 20. */
  maxSearchQueries: number;
  /** Result URLs considered per search query (the provider hard-caps 20).
   *  Default 10, hard cap 20. */
  maxSearchResultsPerQuery: number;
  /** Offer pages fetched for ONE search query. Default 5, hard cap 10. */
  maxSearchPagesPerQuery: number;
  /** Total offer pages fetched across ALL search queries (global safety).
   *  Default 20, hard cap 60. */
  maxSearchPagesToFetch: number;
  /** Company-site offer discovery: how many accepted companies are inspected.
   *  Default 12 (target 10–15), hard cap 20. */
  maxCompanySiteOfferCompanies: number;
  /** Company-site offer discovery: pages fetched per company INCLUDING the
   *  homepage (homepage + offer links / known paths). Default 6, hard cap 8. */
  maxCompanySiteOfferPages: number;
}

/**
 * The hard ceilings of the internet-discovery fan-out. Environment values are
 * CLAMPED into these (§14: "prevent unreasonable values") — a misconfigured
 * host can enlarge the radius within reason, never remove the bound.
 */
export const DISCOVERY_FANOUT_CAPS = {
  maxSearchQueries: 20,
  maxSearchResultsPerQuery: 20,
  maxSearchPagesPerQuery: 10,
  maxSearchPagesToFetch: 60,
  maxCompanySiteOfferCompanies: 20,
  maxCompanySiteOfferPages: 8,
} as const;

/** Positive integer from an env var, clamped into `[1, cap]`, else fallback. */
function envIntClamped(name: string, fallback: number, cap: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1)
    return fallback;
  return Math.min(value, cap);
}

/** Positive integer from an env var, or the fallback. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

/**
 * Server-side ONLY — reads process.env. Do not call from client components.
 * (The rest of this module is pure and client-safe.)
 */
/**
 * Server-side ONLY — the per-run page budget for the public-email pass.
 * Companies beyond it are NOT inspected; their outcome is reported as
 * `source_blocked` (inconclusive) rather than as "no public email", because an
 * uninspected source must never be presented as a checked one (§4.4).
 */
export function discoveryEmailSitePasses(): number {
  return envInt("DISCOVERY_MAX_EMAIL_SITE_PASSES", 8);
}

export function discoveryLimits(): DiscoveryLimits {
  return {
    maxCandidates: envInt("DISCOVERY_MAX_CANDIDATES", 1000),
    maxCompaniesToResolve: envInt("DISCOVERY_MAX_COMPANIES_TO_RESOLVE", 500),
    maxConcurrent: envInt("DISCOVERY_MAX_CONCURRENT", 5),
    maxTavilyQueries: envInt("DISCOVERY_MAX_TAVILY_QUERIES", 30),
    maxPagesPerCompany: 4,
    maxRuntimeMs: envInt("DISCOVERY_MAX_RUNTIME_MS", 10 * 60 * 1000),
    // The internet-discovery radius: enlarged, but every value is clamped into
    // its hard cap (DISCOVERY_FANOUT_CAPS) — a bad env value can never remove
    // the bound.
    maxSearchQueries: envIntClamped(
      "DISCOVERY_MAX_SEARCH_QUERIES",
      12,
      DISCOVERY_FANOUT_CAPS.maxSearchQueries,
    ),
    maxSearchResultsPerQuery: envIntClamped(
      "DISCOVERY_MAX_SEARCH_RESULTS_PER_QUERY",
      10,
      DISCOVERY_FANOUT_CAPS.maxSearchResultsPerQuery,
    ),
    maxSearchPagesPerQuery: envIntClamped(
      "DISCOVERY_MAX_SEARCH_PAGES_PER_QUERY",
      5,
      DISCOVERY_FANOUT_CAPS.maxSearchPagesPerQuery,
    ),
    maxSearchPagesToFetch: envIntClamped(
      "DISCOVERY_MAX_SEARCH_PAGES_TO_FETCH",
      20,
      DISCOVERY_FANOUT_CAPS.maxSearchPagesToFetch,
    ),
    maxCompanySiteOfferCompanies: envIntClamped(
      "DISCOVERY_MAX_COMPANY_SITE_COMPANIES",
      12,
      DISCOVERY_FANOUT_CAPS.maxCompanySiteOfferCompanies,
    ),
    maxCompanySiteOfferPages: envIntClamped(
      "DISCOVERY_MAX_COMPANY_SITE_PAGES",
      6,
      DISCOVERY_FANOUT_CAPS.maxCompanySiteOfferPages,
    ),
  };
}

/**
 * The exported fan-out configuration (§17). A single, named view of how wide a
 * run may reach — the search RADIUS, not the volume. Every value is either a
 * real registry count or an env-tunable limit, so the numbers are honest and
 * auditable; `maxRequestsPerHost` mirrors the fetcher's one-request-per-host
 * concurrency that keeps a host never hit in parallel.
 */
export interface DiscoveryFanout {
  /** How many enabled sources may execute in one run (registry-derived). */
  maxEnabledSourcesPerRun: number;
  /** Structured search queries (families) issued for the offer layer. */
  maxSearchQueriesPerRun: number;
  maxResultsPerQuery: number;
  /** Offer pages fetched for one search query. */
  maxSearchPagesPerQuery: number;
  /** Offer pages fetched across all queries (global safety bound). */
  maxSearchPagesPerRun: number;
  /** Accepted companies inspected by the company-site offer pass. */
  maxCompanySiteCompaniesPerRun: number;
  /** Pages fetched per company by the company-site offer pass (incl. homepage). */
  maxCompanySitePagesPerCompany: number;
  maxCompaniesPerRun: number;
  /** Pages fetched per company by the PUBLIC-EMAIL pass (kept conservative). */
  maxPagesPerCompany: number;
  maxConcurrentCompanies: number;
  /** One in-flight request per host (the fetcher's `MAX_HOST_CONCURRENCY`). */
  maxRequestsPerHost: number;
  /** Minimum spacing between two requests to the same host, in ms. */
  minHostDelayMs: number;
  /** Per-request timeout of the discovery fetcher, in ms. */
  requestTimeoutMs: number;
}

export function discoveryFanout(): DiscoveryFanout {
  const limits = discoveryLimits();
  return {
    maxEnabledSourcesPerRun: enabledSources().length,
    maxSearchQueriesPerRun: limits.maxSearchQueries,
    maxResultsPerQuery: limits.maxSearchResultsPerQuery,
    maxSearchPagesPerQuery: limits.maxSearchPagesPerQuery,
    maxSearchPagesPerRun: limits.maxSearchPagesToFetch,
    maxCompanySiteCompaniesPerRun: limits.maxCompanySiteOfferCompanies,
    maxCompanySitePagesPerCompany: limits.maxCompanySiteOfferPages,
    maxCompaniesPerRun: limits.maxCompaniesToResolve,
    maxPagesPerCompany: limits.maxPagesPerCompany,
    maxConcurrentCompanies: limits.maxConcurrent,
    maxRequestsPerHost: 1,
    // Mirror the fetcher's named constants (fetch-guard is server-only and
    // must not be imported here — this module stays client-safe):
    // MIN_HOST_INTERVAL_MS / REQUEST_TIMEOUT_MS.
    minHostDelayMs: 1_000,
    requestTimeoutMs: 10_000,
  };
}

// ---------------------------------------------------------------------------
// Presentation helpers (pure — shared by UI + export)
// ---------------------------------------------------------------------------

/** Human label for a beginn constraint (server-localized by the caller via
 *  the i18n keys; this returns the machine value for badges). */
export function beginnLabelOf(beginn: DiscoveryBeginn): string {
  switch (beginn.mode) {
    case "from_now":
      return "from_now";
    case "date":
      return beginn.date;
    case "month":
      return beginn.month;
    case "year":
      return String(beginn.year);
  }
}

/** True when the beginn constraint requires a documented start date. */
export function beginnRequiresDocumentedStart(
  beginn: DiscoveryBeginn,
): boolean {
  return beginn.mode === "date" || beginn.mode === "month" || beginn.mode === "year";
}
