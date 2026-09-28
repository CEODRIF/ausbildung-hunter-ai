import { z } from "zod";

/**
 * Bump when the normalized opportunity shape changes so previously cached
 * payloads (opportunity_cache) are ignored and refreshed instead of being
 * misinterpreted. The cache key embeds this version as well.
 */
export const OPPORTUNITY_SCHEMA_VERSION = 2;

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
  page: z.coerce.number().int().min(1).max(200).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  /** Requests per-user match computation (server-side, after cache read). */
  match: z.coerce.boolean().default(false),
});
export type OpportunitySearchParams = z.infer<typeof searchParamsSchema>;

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

export interface OpportunitySearchPage {
  results: Opportunity[];
  /** Source total (or matched-within-scan count when server-side filtering). */
  total: number;
  /** True when a bounded server-side scan ended before the source did. */
  scan_truncated: boolean;
}

export interface OpportunitySearchResponse extends OpportunitySearchPage {
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
