import { z } from "zod";

/**
 * Bump when the normalized opportunity shape changes so previously cached
 * payloads (opportunity_cache) are ignored and refreshed instead of being
 * misinterpreted. The cache key embeds this version as well.
 *
 * v3 (Phase 3): cache payloads now carry a `mode` ("upstream" | "scan"), the
 * full result `window` for scan mode (page-independent) and `exhausted`, so
 * server-side sorting/filtering can paginate without re-hitting the provider
 * on every page turn.
 */
export const OPPORTUNITY_SCHEMA_VERSION = 3;

/**
 * The BA source only exposes its first ~10,000 listings per query (verified:
 * page*size beyond 10,000 returns empty pages without an error). We cap
 * pagination at exactly this limit and surface it in the UI instead of
 * pretending deeper pages exist.
 */
export const SEARCH_SOURCE_LIMIT = 10_000;

export type OpportunitySort =
  "relevance" | "newest" | "oldest" | "salary" | "distance" | "match";

/**
 * Sort semantics (documented, deterministic):
 * - relevance: the source's native ordering (true upstream pagination).
 * - newest / oldest: by the source's publication date (posted_at); items
 *   without a documented date sort last; ties broken by stable id.
 * - salary: by the source's numeric salary amount; items without a
 *   documented salary sort last (never guessed).
 * - distance: by the source's distance in km from the searched location;
 *   items without a documented distance sort last. Requires a location.
 * - match: by the user's per-user match score (computed after the cache
 *   read; falls back to relevance when no candidate profile exists).
 * All non-relevance sorts operate on a bounded server-side window because
 * the BA REST API has no sort parameters for these fields.
 */
export const opportunitySortSchema = z.enum([
  "relevance",
  "newest",
  "oldest",
  "salary",
  "distance",
  "match",
]);

/**
 * Freshness is explicit about what the source actually supports:
 * - "today" is applied by the BA API itself (veroeffentlichtseit=1, verified).
 * - "14d" / "30d" are applied server-side on the source's publication date
 *   (datumErsteVeroeffentlichung) via a bounded scan; results may be marked
 *   scan_truncated when the scan budget ends before the source does.
 * Anything else is "any". The API never pretends to honor unsupported values.
 */
export const opportunityFreshnessSchema = z.enum([
  "any",
  "today",
  "14d",
  "30d",
]);

export const searchParamsSchema = z.object({
  goal: z.enum(["ausbildung", "arbeit"]),
  keyword: z.string().trim().max(120).default(""),
  /** Role/occupation filter. Applied server-side on the source's occupation
   *  fields (hauptberuf / alternative professions / title) — the BA REST API
   *  does not support a free-text `beruf` parameter (verified: 0 results). */
  role: z.string().trim().max(120).default(""),
  /** Company filter. Applied server-side on the source's company field — the
   *  BA REST API does not support `arbeitgeber` as a text filter (verified). */
  company: z.string().trim().max(160).default(""),
  /** City, PLZ or Bundesland. Mapped to the API's `wo` parameter. */
  location: z.string().trim().max(120).default(""),
  /** Radius in km (5–100), only applied together with a location. */
  radius: z.coerce.number().int().min(5).max(100).optional(),
  freshness: opportunityFreshnessSchema.default("any"),
  sort: opportunitySortSchema.default("relevance"),
  /** Employment filter on the source's full/part-time flags. */
  employment: z.enum(["any", "full_time", "part_time"]).default("any"),
  /** Training-type filter (Ausbildung only — the source documents
   *  ausbildungsart for training postings, not for jobs). */
  training_type: z.enum(["any", "AUSBILDUNG", "DUALES_STUDIUM"]).default("any"),
  /** Home-office filter (Ausbildung only — the source does not provide
   *  homeofficemoeglich on job postings). */
  home_office: z.enum(["any", "yes"]).default("any"),
  /** Only postings where the source documents a numeric salary. */
  salary_documented: z.coerce.boolean().default(false),
  /** Maximum distance in km (5–100), only together with a location; items
   *  without a documented distance are excluded (never guessed). */
  distance_max: z.coerce.number().int().min(5).max(100).optional(),
  /**
   * Pagination. The source only exposes its first 10,000 listings per query
   * (page*size > 10,000 returns empty pages), so page is capped at 200 and
   * pageSize at 50 (200 x 50 = 10,000).
   */
  page: z.coerce.number().int().min(1).max(200).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  /** Requests per-user match computation (server-side, after cache read). */
  match: z.coerce.boolean().default(false),
});
export type OpportunitySearchParams = z.infer<typeof searchParamsSchema>;

/** True when the search needs a bounded server-side window (post-filters
 *  and/or non-relevance sorting) instead of true upstream pagination. */
export function usesScanWindow(params: OpportunitySearchParams): boolean {
  return (
    params.role !== "" ||
    params.company !== "" ||
    params.freshness === "14d" ||
    params.freshness === "30d" ||
    params.sort !== "relevance" ||
    params.employment !== "any" ||
    params.training_type !== "any" ||
    params.home_office !== "any" ||
    params.salary_documented === true ||
    params.distance_max !== undefined
  );
}

/**
 * Cross-parameter validation/normalization. Invalid combinations are either
 * normalized (documented) or rejected with a clear error — never silently
 * ignored.
 */
export function normalizeSearchParams(
  input: OpportunitySearchParams,
): OpportunitySearchParams {
  const params: OpportunitySearchParams = { ...input };
  if (
    (params.sort === "distance" || params.distance_max !== undefined) &&
    !params.location
  ) {
    throw new Error(
      params.sort === "distance"
        ? "Distance sorting requires a location."
        : "A maximum distance requires a location.",
    );
  }
  if (params.home_office !== "any" && params.goal !== "ausbildung") {
    throw new Error(
      "Home-office filtering is only available for Ausbildung — the source does not document home office for job postings.",
    );
  }
  if (params.training_type !== "any" && params.goal !== "ausbildung") {
    throw new Error(
      "Training-type filtering is only available for Ausbildung.",
    );
  }
  // "match" sorting needs a per-user score; without a match request there is
  // no score to sort by, so it normalizes to relevance (documented).
  if (params.sort === "match" && !params.match) {
    params.sort = "relevance";
  }
  return params;
}

// ---------------------------------------------------------------------------
// Shareable URL state
// ---------------------------------------------------------------------------

/** Query-parameter names allowed in shareable search URLs. Everything else
 *  (including anything resembling identifiers/tokens) is dropped. */
const URL_STATE_KEYS = [
  "goal",
  "q",
  "role",
  "company",
  "location",
  "radius",
  "freshness",
  "sort",
  "employment",
  "training_type",
  "home_office",
  "salary",
  "distance_max",
  "page",
  "match",
] as const;

/**
 * Sanitize a raw query string into a safe, shareable search URL query.
 * Keeps only whitelisted keys, maps `q` → keyword semantics, validates every
 * value against the search schema, and drops anything invalid. Never trusts
 * the value for authorization — only for filtering.
 */
export function sanitizeSearchUrlState(
  raw: string | Record<string, string>,
): string {
  let entries: Array<[string, string]>;
  try {
    const search =
      typeof raw === "string" ? raw : `?${new URLSearchParams(raw)}`;
    const qs = search.startsWith("?") ? search.slice(1) : search;
    entries = [...new URLSearchParams(qs).entries()];
  } catch {
    return "";
  }
  const kept: Array<[string, string]> = [];
  for (const [key, value] of entries) {
    if (!(URL_STATE_KEYS as readonly string[]).includes(key)) continue;
    kept.push([key, value]);
  }
  if (kept.length === 0) return "";
  // Validate via the search schema (goal is required: only keep a valid state
  // when goal is present and valid, otherwise drop the whole state).
  const goalValue = kept.find(([key]) => key === "goal")?.[1] ?? "";
  if (goalValue !== "ausbildung" && goalValue !== "arbeit") return "";
  const candidate: Record<string, unknown> = { goal: goalValue };
  for (const [key, value] of kept) {
    if (key === "goal") continue;
    if (key === "q") candidate["keyword"] = value;
    else if (key === "salary") candidate["salary_documented"] = value === "1";
    else candidate[key] = value;
  }
  const parsed = searchParamsSchema.safeParse(candidate);
  if (!parsed.success) return "";
  // Re-serialize only the non-default values.
  const out = new URLSearchParams();
  out.set("goal", parsed.data.goal);
  if (parsed.data.keyword) out.set("q", parsed.data.keyword);
  if (parsed.data.role) out.set("role", parsed.data.role);
  if (parsed.data.company) out.set("company", parsed.data.company);
  if (parsed.data.location) out.set("location", parsed.data.location);
  if (parsed.data.radius !== undefined)
    out.set("radius", String(parsed.data.radius));
  if (parsed.data.freshness !== "any")
    out.set("freshness", parsed.data.freshness);
  if (parsed.data.sort !== "relevance") out.set("sort", parsed.data.sort);
  if (parsed.data.employment !== "any")
    out.set("employment", parsed.data.employment);
  if (parsed.data.training_type !== "any")
    out.set("training_type", parsed.data.training_type);
  if (parsed.data.home_office !== "any")
    out.set("home_office", parsed.data.home_office);
  if (parsed.data.salary_documented) out.set("salary", "1");
  if (parsed.data.distance_max !== undefined)
    out.set("distance_max", String(parsed.data.distance_max));
  if (parsed.data.page !== 1) out.set("page", String(parsed.data.page));
  if (parsed.data.match) out.set("match", "1");
  return out.toString();
}

/** Fully validated search state (server- or client-side). */
export interface SearchUrlState {
  goal: "ausbildung" | "arbeit";
  keyword: string;
  role: string;
  company: string;
  location: string;
  radius: number | null;
  freshness: "any" | "today" | "14d" | "30d";
  sort: OpportunitySort;
  employment: "any" | "full_time" | "part_time";
  training_type: "any" | "AUSBILDUNG" | "DUALES_STUDIUM";
  home_office: "any" | "yes";
  salary_documented: boolean;
  distance_max: number | null;
  page: number;
  match: boolean;
}

/** Parse + validate a (shareable) query string into search state. Invalid
 *  values normalize to defaults — never trusted for authorization. */
export function parseSearchUrlState(
  rawQuery: string,
  fallbackGoal: "ausbildung" | "arbeit",
): SearchUrlState {
  const sanitized = sanitizeSearchUrlState(rawQuery);
  const defaults: OpportunitySearchParams = {
    goal: fallbackGoal,
    keyword: "",
    role: "",
    company: "",
    location: "",
    freshness: "any",
    sort: "relevance",
    employment: "any",
    training_type: "any",
    home_office: "any",
    salary_documented: false,
    page: 1,
    pageSize: 20,
    match: true,
  };
  if (!sanitized) {
    return {
      ...defaults,
      radius: null,
      distance_max: null,
    };
  }
  const candidate: Record<string, unknown> = { goal: fallbackGoal };
  for (const [key, value] of new URLSearchParams(sanitized).entries()) {
    if (key === "q") candidate.keyword = value;
    else if (key === "salary") candidate.salary_documented = value === "1";
    else candidate[key] = value;
  }
  const parsed = searchParamsSchema.parse(candidate);
  const normalized = normalizeSearchParams(parsed);
  // The UI defaults to match ON; the API defaults to OFF. When the shareable
  // state does not mention `match`, keep the UI default (true).
  const hasMatchKey = new URLSearchParams(sanitized).has("match");
  return {
    goal: normalized.goal,
    keyword: normalized.keyword,
    role: normalized.role,
    company: normalized.company,
    location: normalized.location,
    radius: normalized.radius ?? null,
    freshness: normalized.freshness,
    sort: normalized.sort,
    employment: normalized.employment,
    training_type: normalized.training_type,
    home_office: normalized.home_office,
    salary_documented: normalized.salary_documented,
    distance_max: normalized.distance_max ?? null,
    page: normalized.page,
    match: hasMatchKey ? normalized.match : true,
  };
}

/** Serialize state back into a shareable query string (non-defaults only). */
export function serializeSearchState(state: SearchUrlState): string {
  const out = new URLSearchParams();
  out.set("goal", state.goal);
  if (state.keyword) out.set("q", state.keyword);
  if (state.role) out.set("role", state.role);
  if (state.company) out.set("company", state.company);
  if (state.location) out.set("location", state.location);
  if (state.radius !== null) out.set("radius", String(state.radius));
  if (state.freshness !== "any") out.set("freshness", state.freshness);
  if (state.sort !== "relevance") out.set("sort", state.sort);
  if (state.employment !== "any") out.set("employment", state.employment);
  if (state.training_type !== "any")
    out.set("training_type", state.training_type);
  if (state.home_office !== "any") out.set("home_office", state.home_office);
  if (state.salary_documented) out.set("salary", "1");
  if (state.distance_max !== null)
    out.set("distance_max", String(state.distance_max));
  if (state.page !== 1) out.set("page", String(state.page));
  if (!state.match) out.set("match", "0");
  return out.toString();
}

/** German school-leaving hierarchy used for Ausbildung eligibility matching. */
export const educationLevelSchema = z.enum([
  "basic",
  "intermediate",
  "advanced",
  "university",
  "unknown",
]);

export const educationRequirementSchema = z.object({
  /** Raw source value (BA: geforderterBildungsabschluss). */
  raw: z.string().min(1).max(160),
  level: educationLevelSchema,
});

/** Salary is only set when the source provides a numeric amount + unit. */
export const salarySchema = z.object({
  amount: z.number().positive().max(1_000_000),
  unit: z.enum(["hourly", "monthly"]),
  /** Derived display label built from the source numbers (de-DE format). */
  label: z.string().max(160),
});

/** Contact data extracted from the source's published description text. */
export const contactSchema = z.object({
  person: z.string().max(160).nullable(),
  email: z.string().max(254).nullable(),
  phone: z.string().max(64).nullable(),
});

export const matchSchema = z.object({
  match_score: z.number().min(0).max(100),
  matching_skills: z.array(z.string()),
  missing_skills: z.array(z.string()),
  matching_languages: z.array(z.string()),
  missing_languages: z.array(z.string()),
  education_match: z.boolean().nullable(),
  experience_match: z.boolean().nullable(),
  location_match: z.boolean().nullable(),
  role_match: z.boolean().nullable(),
  explanation: z.array(z.string()),
});

export const opportunityLocationDetailSchema = z.object({
  city: z.string().max(160).nullable(),
  region: z.string().max(160).nullable(),
  country: z.string().max(160).nullable(),
  postal_code: z.string().max(16).nullable(),
});

export const opportunitySchema = z.object({
  /** Stable identity: `${provider}:${external_id}`. */
  id: z.string().min(3).max(200),
  provider: z.string().min(1).max(60),
  external_id: z.string().min(1).max(120),
  source_name: z.string().min(1).max(160),
  /** Canonical public page of the opportunity at the source. */
  source_url: z.string().url().max(500),
  /** Where to apply: the source's application URL when published, else null. */
  application_url: z.string().url().max(500).nullable(),
  title: z.string().min(1).max(400),
  /** Authoritative classification from the source (BA: stellenangebotsart),
   *  never from browser input. */
  goal: z.enum(["ausbildung", "arbeit"]),
  /** Raw source classification value (fidelity). */
  stellenangebotsart: z.string().max(40).nullable(),
  company_name: z.string().max(200).nullable(),
  company_url: z.string().url().max(500).nullable(),
  /** Display location, e.g. "10115 Berlin" (source data). */
  location: z.string().max(200).nullable(),
  location_detail: opportunityLocationDetailSchema.nullable(),
  /** Distance in km from the searched location (source, when provided). */
  distance_km: z.number().min(0).max(5000).nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  /** Official BA occupation name (hauptberuf). */
  profession: z.string().max(200).nullable(),
  alternative_professions: z.array(z.string().max(200)).max(10),
  description: z.string().nullable(),
  /** Parsed from the source description ("Ihre Aufgaben" section). */
  tasks: z.array(z.string().max(300)).max(50),
  /** Parsed from the source description ("Anforderungen" section). */
  requirements: z.array(z.string().max(300)).max(50),
  /** Derived from the source's full/part-time flags. */
  employment_type: z.string().max(60).nullable(),
  home_office: z.boolean().nullable(),
  career_change_friendly: z.boolean().nullable(),
  salary: salarySchema.nullable(),
  /** BA: ausbildungsart (AUSBILDUNG / DUALES_STUDIUM), Ausbildung only. */
  training_type: z.string().max(60).nullable(),
  /** BA: geforderterBildungsabschluss (Ausbildung details); null = none
   *  documented or not relevant. */
  education_requirement: educationRequirementSchema.nullable(),
  /** Planned start (BA: eintrittszeitraum.von). */
  valid_from: z.string().nullable(),
  /** First published (BA: datumErsteVeroeffentlichung). */
  posted_at: z.string().nullable(),
  /** Last updated (BA: aenderungsdatum). */
  updated_at: z.string().nullable(),
  /** When this record was fetched from the source (metadata, not a fact). */
  retrieved_at: z.string(),
  contact: contactSchema.nullable(),
  /**
   * Extraction placeholders. The BA source does not reliably provide
   * structured skills/languages today; these stay empty until a verified
   * extraction pipeline fills them. They must never be guessed.
   */
  required_skills: z.array(z.string().max(120)).max(50),
  preferred_skills: z.array(z.string().max(120)).max(50),
  required_languages: z.array(z.string().max(80)).max(20),
  extracted_keywords: z.array(z.string().max(120)).max(50),
  /** Per-user match, computed server-side after cache read. Never cached. */
  match: matchSchema.nullable(),
});
export type Opportunity = z.infer<typeof opportunitySchema>;
export type OpportunitySalary = z.infer<typeof salarySchema>;
export type OpportunityContact = z.infer<typeof contactSchema>;

export type OpportunityWindowMode = "upstream" | "scan";

/** The user-independent result window the provider produced. In `upstream`
 *  mode `window` is exactly one requested page (true API pagination). In
 *  `scan` mode `window` is the bounded, filtered, sorted set from which
 *  pages are sliced server-side. */
export interface OpportunityWindow {
  mode: OpportunityWindowMode;
  window: Opportunity[];
  /** upstream: the source total (maxErgebnisse). scan: matches within the
   *  bounded window. */
  total: number;
  /** True when the bounded scan ended before the source did (scan mode). */
  scan_truncated: boolean;
  /** True when the full source result set was seen (or upstream mode). */
  exhausted: boolean;
}

export interface OpportunitySearchResponse {
  /** The requested page of results (after any per-user match computation). */
  results: Opportunity[];
  total: number;
  scan_truncated: boolean;
  mode: OpportunityWindowMode;
  /** True when the authenticated user has a candidate profile and match was
   *  requested — otherwise results carry match: null (not an empty match). */
  match_available: boolean;
}

export type CandidateForMatch = {
  goal: "ausbildung" | "arbeit";
  target_roles: Array<{ role: string }>;
  education: Array<Record<string, unknown>>;
  training: Array<{ name: string }>;
  experience: Array<{ job_title: string; responsibilities: string[] }>;
  skills: {
    technical: string[];
    software_tools: string[];
    marketing: string[];
    it: string[];
    soft: string[];
  };
  languages: Array<{ language: string; level: string | null }>;
  preferences: {
    preferred_locations: string[];
    preferred_job_titles: string[];
  };
};
