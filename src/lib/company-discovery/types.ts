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
  /** Stable source id, e.g. "arbeitsagentur", "tavily". */
  id: string;
  /** ok: delivered candidates. running: in progress. unavailable: failed or
   *  blocked (the run continues without it). skipped: not part of the plan. */
  status: "ok" | "running" | "unavailable" | "skipped";
  /** Real candidate count from this source (when the source ran). */
  candidates?: number;
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
  /** Companies rejected by the quality gate (incl. no public email). */
  companiesRejected: number;
  /** Live per-source status. */
  sources: DiscoverySourceStatus[];
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
  | "offer"
  | "search_result"
  | "company_website"
  | "impressum"
  | "kontakt"
  | "karriere"
  | "ausbildung"
  | "bewerbungen";

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
export function discoveryLimits(): DiscoveryLimits {
  return {
    maxCandidates: envInt("DISCOVERY_MAX_CANDIDATES", 1000),
    maxCompaniesToResolve: envInt("DISCOVERY_MAX_COMPANIES_TO_RESOLVE", 500),
    maxConcurrent: envInt("DISCOVERY_MAX_CONCURRENT", 5),
    maxTavilyQueries: envInt("DISCOVERY_MAX_TAVILY_QUERIES", 30),
    maxPagesPerCompany: 4,
    maxRuntimeMs: envInt("DISCOVERY_MAX_RUNTIME_MS", 10 * 60 * 1000),
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
