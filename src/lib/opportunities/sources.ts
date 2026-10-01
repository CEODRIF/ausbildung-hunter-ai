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
  * per-run discovery budget). Order is tuned so the highest-value sources
  * stay inside the budget even in the worst case (4 plain queries → only
  * 12 source calls): the big Ausbildung/job portals first (most structured
  * listings), then company career pages (they carry the OFFICIAL
  * application links + contact data — the enrichment gold source), then the
  * public-employer portal, then the smaller regional portals; gojobs/XING
  * and public social media last (least useful for applying). A profile can
  * still raise HWK/IHK/Bund further via prioritizeSources().
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
    id: "company_career",
    label: "Company Career Pages",
    kind: "web",
    category: "company_website",
    domains: [],
    officialSearchUrl: null,
    enabled: true,
  },
  {
    id: "bund",
    label: "Öffentlicher Dienst (Bund)",
    kind: "web",
    category: "job_portal",
    domains: ["service.bund.de", "wir-sind-bund.de"],
    officialSearchUrl: "https://www.wir-sind-bund.de/",
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
    id: "azubi",
    label: "Azubi.de",
    kind: "web",
    category: "job_portal",
    domains: ["azubi.de"],
    officialSearchUrl: "https://www.azubi.de/",
    enabled: true,
  },
  {
    id: "meine_ausbildung",
    label: "Meine Ausbildung in Deutschland",
    kind: "web",
    category: "job_portal",
    domains: ["meine-ausbildung-in-deutschland.de"],
    officialSearchUrl: "https://www.meine-ausbildung-in-deutschland.de/",
    enabled: true,
  },
  {
    id: "lehrstellen_radar",
    label: "Lehrstellen-Radar",
    kind: "web",
    category: "job_portal",
    domains: ["lehrstellen-radar.de"],
    officialSearchUrl: "https://www.lehrstellen-radar.de/",
    enabled: true,
  },
  {
    id: "ausbildung_nrw",
    label: "Ausbildung.NRW",
    kind: "web",
    category: "job_portal",
    domains: ["ausbildung.nrw"],
    officialSearchUrl: "https://www.ausbildung.nrw/",
    enabled: true,
  },
  {
    id: "ausbildungsatlas",
    label: "Der Ausbildungsatlas",
    kind: "web",
    category: "job_portal",
    domains: ["derausbildungsatlas.de"],
    officialSearchUrl: "https://www.derausbildungsatlas.de/",
    enabled: true,
  },
  {
    id: "hallo_beruf",
    label: "Hallo Beruf",
    kind: "web",
    category: "job_portal",
    domains: ["hallo-beruf.de"],
    officialSearchUrl: "https://www.hallo-beruf.de/",
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

/**
 * Hosts that can NEVER be a company's official website — job portals,
 * company-review sites, business directories and public-employer portals.
 * They are legitimate DISCOVERY sources (how we find the job), but a
 * website discovered on one of them is a portal page, not the company.
 * (kununu/glassdoor/northdata/… are company-info sites, not the company.)
 */
export const BLOCKED_COMPANY_DOMAINS = [
  // discovery/job portals (registry domains + extras)
  "arbeitsagentur.de",
  "ausbildung.de",
  "aubi-plus.de",
  "azubiyo.de",
  "azubi.de",
  "meine-ausbildung-in-deutschland.de",
  "lehrstellen-radar.de",
  "ausbildung.nrw",
  "derausbildungsatlas.de",
  "hallo-beruf.de",
  "ihk.de",
  "ihk-lehrstellenboerse.de",
  "hwk.de",
  "handwerk.de",
  "stepstone.de",
  "indeed.de",
  "indeed.com",
  "meinestadt.de",
  "stellenanzeigen.de",
  "gojobs.de",
  "xing.com",
  "ausbildungihrerstadt.de",
  "azubimessenger.de",
  "jobvector.de",
  "service.bund.de",
  "wir-sind-bund.de",
  "bund.de",
  // company review / directory / data sites
  "kununu.com",
  "glassdoor.com",
  "northdata.de",
  "firmenwissen.de",
  "gelbe-seiten.de",
  "wer-weiss-was.de",
  "companyhouse.de",
  "handelsregister.de",
  // social
  "facebook.com",
  "linkedin.com",
  "instagram.com",
  "youtube.com",
  "tiktok.com",
] as const;

/** True when a URL's host may plausibly be the company's own website
 *  (i.e. it is NOT a known portal / review / directory / social host). */
export function isAllowedCompanyDomain(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  const bare = host.toLowerCase().replace(/^www\./, "");
  const domain = hostDomain(bare);
  for (const blocked of BLOCKED_COMPANY_DOMAINS) {
    if (domain === blocked || bare === blocked || bare.endsWith(`.${blocked}`))
      return false;
  }
  return true;
}

/**
 * Deterministic per-profile source prioritization (AI Search 2.1).
 *
 * The registry order is the default priority; a profile's keywords can
 * raise clearly relevant source groups (they keep their relative order,
 * the rest follows unchanged). This is a transparency rule, not a guess:
 * - Mechatronik / Handwerk / Elektro / Kälte… → HWK / Handwerk first
 *   (craft professions are primarily trained in the Handwerk).
 * - öffentlicher Dienst / Verwaltung / Behörde / Stadt / Feuerwehr…
 *   → public-employer portals first (Bund, Behörden).
 * - kaufmännisch (Kaufmann, Büro, Marketing, E-Commerce, Controlling,
 *   Buchhaltung, Personal, Vertrieb…) → IHK + company career pages first
 *   (office professions are predominantly IHK-regulated / company sites).
 */
export function prioritizeSources(profileText: string): string[] {
  const text = profileText.toLowerCase();
  const craft =
    /(mechatronik|handwerk|elektro|elektriker|kälte|klimatisier|dreh-?techn|zulassungs-|instandhalt|kessel|sanitär|heizungs-|tischler|schlosser|metallbauer|fliesen|maler|dachdecker|bäcker|fleisch|kfm\.? für das handwerk)/.test(
      text,
    );
  const publicSector =
    /(öffentlic|oeffentlic|verwaltung|behörde|behoerde|kommunal|landkreis|stadtrat|feuerwehr|polizei|justiz|zoll|beamten|bund (job|dienst)|wir-sind-bund)/.test(
      text,
    );
  const office =
    /(kaufmann|kauffrau|büro|buro|marketing|e-?commerce|controlling|buchhalt|personal|vertrieb|buchhaltung|buromanagement|digital|online marketing|seo|social media|eventkaufmann|versicherungskaufmann)/.test(
      text,
    );

  const raised = new Set<string>();
  if (craft) raised.add("hwk");
  if (publicSector) raised.add("bund");
  if (office) {
    raised.add("ihk");
    raised.add("company_career");
  }
  const base = enabledWebSources().map((source) => source.id);
  // Stable reorder: raised ids first (registry order among themselves),
  // then the remaining ids in registry order.
  const reordered = [
    ...base.filter((id) => raised.has(id)),
    ...base.filter((id) => !raised.has(id)),
  ];
  return reordered;
}
