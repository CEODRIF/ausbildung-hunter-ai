/**
 * Discovery buckets (kept here — the registry owns the taxonomy;
 * web-discovery re-exports the type for backward compatibility).
 */
export type SourceCategory =
  | "search_engine"
  | "job_portal"
  | "company_website"
  | "social_media";
export const SOURCE_CATEGORIES: SourceCategory[] = [
  "search_engine",
  "job_portal",
  "company_website",
  "social_media",
];

/**
 * Source Registry (AI Search 2.0).
 *
 * A single, extensible registry of every public source the AI Ausbildung
 * Search draws from — replacing ad-hoc scraping logic scattered across
 * routes. The architecture:
 *
 *   Search Engine (AI plan)
 *      ↓
 *   Source Registry (this module)
 *      ├── arbeitsagentur adapter  (kind "api" — official REST API,
 *      │                            handled by the BA provider pipeline)
 *      ├── ausbildung.de adapter   (kind "web" — search-engine grounding
 *      ├── aubi-plus adapter       scoped to the source's domain, then a
 *      ├── azubiyo adapter         robots-aware guarded fetch; see
 *      ├── ihk / hwk / meinestadt  lib/web-search)
 *      ├── stepstone / indeed
 *      ├── company career adapter
 *      └── social media adapter
 *
 * Legal-access contract (hard rule):
 * - kind "api":     the source publishes an official API (Bundesagentur für
 *                   Arbeit Jobsuche) — used directly.
 * - kind "web":     the source has no public API. We search public search-
 *                   engine indexes scoped with `site:` operators, then visit
 *                   the returned public pages with the guarded fetcher.
 *                   robots.txt is respected; pages behind login walls,
 *                   CAPTCHAs or anti-bot challenges are SKIPPED, never
 *                   bypassed (a 403/429 is counted honestly).
 * - kind "link_only": the source does not tolerate any automated access;
 *                   the registry only offers its official search URL so the
 *                   user can open it manually.
 * - `officialSearchUrl` values are hand-verified public search pages. When
 *   unknown, the value stays null — we never invent URLs.
 *
 * Pure module: importable from server AND client (the UI needs labels).
 * To add a source, append one entry here — no other code changes needed.
 */

export type SourceKind = "api" | "web" | "link_only";

export interface SourceDefinition {
  /** Stable id used in source_ids, stats and the DB. */
  id: string;
  /** Human-readable name for the UI (localized labels can extend this). */
  label: string;
  /** How the system may legally reach this source. */
  kind: SourceKind;
  /** Discovery bucket (drives priority + UI grouping). */
  category: SourceCategory;
  /** Registrable domains for `site:` scoping (kind "web" only). */
  domains: string[];
  /** Official public search page (verified), or null when unknown. */
  officialSearchUrl: string | null;
  /**
   * Toggle to disable a source without deleting it (e.g. when it changes
   * its terms or hard-blocks all automated access). Disabled sources are
   * skipped everywhere, including stats.
   */
  enabled: boolean;
}

/**
 * The registry, in PRIORITY order (higher = searched earlier within the
 * per-run discovery budget). Job portals come first because they publish
 * Ausbildung listings with the most structured data; company career pages
 * are the next priority (they carry the official application links); public
 * social media last.
 */
export const SOURCE_REGISTRY: readonly SourceDefinition[] = [
  {
    id: "arbeitsagentur",
    label: "Arbeitsagentur",
    kind: "api",
    category: "search_engine",
    domains: ["arbeitsagentur.de"],
    officialSearchUrl: "https://www.arbeitsagentur.de/jobsuche/suche",
    enabled: true,
  },
  {
    id: "ausbildung.de",
    label: "Ausbildung.de",
    kind: "web",
    category: "job_portal",
    domains: ["ausbildung.de"],
    officialSearchUrl: "https://www.ausbildung.de/",
    enabled: true,
  },
  {
    id: "aubi-plus",
    label: "AUBI-plus",
    kind: "web",
    category: "job_portal",
    domains: ["aubi-plus.de"],
    officialSearchUrl: "https://www.aubi-plus.de/",
    enabled: true,
  },
  {
    id: "azubiyo",
    label: "Azubiyo",
    kind: "web",
    category: "job_portal",
    domains: ["azubiyo.de"],
    officialSearchUrl: "https://www.azubiyo.de/",
    enabled: true,
  },
  {
    id: "ihk",
    label: "IHK Lehrstellenbörse",
    kind: "web",
    category: "job_portal",
    domains: ["ihk.de"],
    officialSearchUrl: "https://www.ihk-lehrstellenboerse.de/",
    enabled: true,
  },
  {
    id: "hwk",
    label: "HWK / Handwerk",
    kind: "web",
    category: "job_portal",
    domains: ["hwk.de", "handwerk.de"],
    officialSearchUrl: "https://www.handwerk.de/",
    enabled: true,
  },
  {
    id: "stepstone",
    label: "StepStone",
    kind: "web",
    category: "job_portal",
    domains: ["stepstone.de"],
    officialSearchUrl: "https://www.stepstone.de/",
    enabled: true,
  },
  {
    id: "indeed",
    label: "Indeed",
    kind: "web",
    category: "job_portal",
    domains: ["indeed.de", "indeed.com"],
    officialSearchUrl: "https://de.indeed.com/",
    enabled: true,
  },
  {
    id: "meinestadt",
    label: "Meinestadt",
    kind: "web",
    category: "job_portal",
    domains: ["meinestadt.de"],
    officialSearchUrl: "https://www.meinestadt.de/",
    enabled: true,
  },
  {
    id: "stellenanzeigen",
    label: "Stellenanzeigen",
    kind: "web",
    category: "job_portal",
    domains: ["stellenanzeigen.de"],
    officialSearchUrl: "https://www.stellenanzeigen.de/",
    enabled: true,
  },
  {
    id: "gojobs",
    label: "gojobs",
    kind: "web",
    category: "job_portal",
    domains: ["gojobs.de"],
    // Not verified from the build environment — no link shown.
    officialSearchUrl: null,
    enabled: true,
  },
  {
    id: "xing",
    label: "XING",
    kind: "web",
    category: "job_portal",
    domains: ["xing.com"],
    officialSearchUrl: "https://www.xing.com/jobs",
    enabled: true,
  },
  {
    id: "company_career",
    label: "Company Career Pages",
    kind: "web",
    category: "company_website",
    domains: [],
    officialSearchUrl: null,
    enabled: true,
  },
  {
    id: "social_media",
    label: "Public Social Media",
    kind: "web",
    category: "social_media",
    domains: [],
    officialSearchUrl: null,
    enabled: true,
  },
];

const BY_ID = new Map(SOURCE_REGISTRY.map((source) => [source.id, source]));

export function getSource(id: string): SourceDefinition | null {
  return BY_ID.get(id) ?? null;
}

/** Label for a source id; unknown ids fall back to the id itself (honest). */
export function sourceLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

/** Sources the discovery loop may query (kind "web", enabled), in priority
 *  order. The BA "api" source runs through its own provider pipeline. */
export function enabledWebSources(): SourceDefinition[] {
  return SOURCE_REGISTRY.filter(
    (source) => source.kind === "web" && source.enabled,
  );
}

/**
 * Build the grounding-search query for one source and one AI web query.
 * Deterministic wrapping only — the AI's query content is passed through.
 */
export function buildSourceQuery(
  source: SourceDefinition,
  webQuery: string,
): string {
  const query = webQuery.trim();
  if (!query) return "";
  if (source.domains.length > 0) {
    const operators = source.domains
      .map((domain) => `site:${domain}`)
      .join(" OR ");
    return `${query} ${operators}`;
  }
  switch (source.category) {
    case "company_website":
      return `${query} (karriere OR stellenangebote OR stellenanzeige OR "jobs")`;
    case "social_media":
      return `${query} (site:linkedin.com OR site:instagram.com OR site:facebook.com OR site:youtube.com)`;
    default:
      return query;
  }
}

/** Registrable-domain match: host "www.azubiyo.de" → "azubiyo.de". */
function hostDomain(host: string): string {
  const bare = host.toLowerCase().replace(/^www\./, "");
  const parts = bare.split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : bare;
}

/**
 * Map a page host to the registry source that owns it (for source_ids).
 * null when no registry source claims the host (e.g. a random company
 * career page — those map to "company_career" only via source_type in the
 * merge, not by domain).
 */
export function hostToSourceId(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  const domain = hostDomain(host);
  for (const source of SOURCE_REGISTRY) {
    if (!source.enabled) continue;
    if (source.domains.includes(domain) || source.domains.includes(host))
      return source.id;
  }
  return null;
}
