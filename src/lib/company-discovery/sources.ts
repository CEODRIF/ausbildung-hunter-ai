/**
 * Portal source registry + fail-closed access policy.
 *
 * The 15 portals below are PRIMARILY offer sources: they identify companies
 * (and sometimes websites) and supply offers. Most of them do NOT publish an
 * employer address, so an address only ever comes from a portal listing when
 * it is literally printed in that listing — never inferred (§3.1/§3.2).
 *
 * POLICY GATE (fail-closed, §3.4). Every source carries the classification
 * established in the Phase-1 audit from a plain GET of its `robots.txt` and,
 * where readable, its terms:
 *
 *   enabled_public      public listing pages, robots allows the paths an
 *                       adapter would request, no login, no contractual
 *                       automation prohibition found  → adapter implemented
 *   enabled_official_api  a documented API/feed/official open-data endpoint
 *                       we may use                       → adapter implemented
 *   restricted          robots or the terms prohibit automated access, the
 *                       listings require a login by design, or a plain polite
 *                       request is already met with a challenge/login wall
 *                       (e.g. a bare 403)                → NO adapter
 *   unverified          could not be established          → NO adapter
 *
 * `restricted` and `unverified` sources stay REGISTERED (so every run reports
 * them honestly as `skipped_by_policy`) but are never requested. Enabling them
 * later requires an explicit owner decision backed by official API access or
 * written permission — the registry is the single place to change.
 *
 * Runtime is unaffected by this classification: even an enabled source that
 * later answers with a challenge, a login wall or a block is treated as
 * `source_blocked` by the central classifier (§4.3).
 */

/** Categories exactly as the owner listed them (§3.2), plus the internet
 *  discovery families added by the engine expansion:
 *  `search` = search engines reached ONLY through a legitimate API (§6);
 *  `company-site` = official company websites contributing their own offers (§11);
 *  `directory` = public company / chamber / register directories (§12);
 *  `platform` = professional platforms, public company/job pages only (§13). */
export type SourceCategory =
  | "ausbildung"
  | "chamber"
  | "jobs"
  | "local-jobs"
  | "government"
  | "search"
  | "company-site"
  | "directory"
  | "platform";

export type SourcePolicy =
  | "enabled_public"
  | "enabled_official_api"
  | "restricted"
  | "unverified";

export type SourceId =
  | "ausbildung-de"
  | "aubi-plus-de"
  | "azubiyo-de"
  | "azubister-de"
  | "ausbildunganzeigen-de"
  | "azubi-de"
  | "ihk-ausbildung"
  | "handwerkskammer"
  | "indeed-de"
  | "stepstone-de"
  | "jobware"
  | "monster-de"
  | "xing-jobs"
  | "linkedin-jobs"
  | "meinestadt-jobs"
  | "yourfirm"
  | "bund-de"
  | "jobboerse-de"
  | "ausbildungsmarkt-de"
  | "arbeitsagentur"
  // Internet-discovery families added by the engine expansion:
  | "search-api"
  | "search-google"
  | "search-bing"
  | "search-google-cse"
  | "directory-handwerksrolle";

export interface PortalSource {
  id: SourceId;
  /** Display name exactly as given by the owner (§3.2). */
  displayName: string;
  category: SourceCategory;
  /** Canonical domain resolved in the audit (never guessed). */
  domain: string;
  policy: SourcePolicy;
  /** Human-readable, auditable classification reason (evidence-based). */
  reason: string;
  /**
   * True only for Arbeitsagentur, which may remain an OFFER/COMPANY source but
   * is removed from the email path (§3.3). Kept explicit so no code path can
   * accidentally read an address from it.
   */
  emailAllowed: boolean;
}

/**
 * The registry. Order follows the owner's catalog (§3.2); Arbeitsagentur is
 * last because it is not one of the 15 portals.
 */
export const PORTAL_SOURCES: readonly PortalSource[] = [
  {
    id: "ausbildung-de",
    displayName: "Ausbildung.de",
    category: "ausbildung",
    domain: "ausbildung.de",
    policy: "enabled_public",
    reason:
      "robots.txt allows every path except /auth/facebook/; the terms pages returned 200 and contain no automation prohibition.",
    emailAllowed: true,
  },
  {
    id: "aubi-plus-de",
    displayName: "AUBI-plus.de",
    category: "ausbildung",
    domain: "aubi-plus.de",
    policy: "enabled_public",
    reason:
      "robots.txt allows every path for `*` (empty Disallow) and publishes a sitemap; the AGB are readable and contain no automation prohibition; the entry page and the query-free listing path returned HTTP 200 with no challenge or login marker; detail pages publish schema.org/JobPosting JSON-LD.",
    emailAllowed: true,
  },
  {
    id: "azubiyo-de",
    displayName: "Azubiyo.de",
    category: "ausbildung",
    domain: "azubiyo.de",
    policy: "unverified",
    reason:
      "robots.txt allows the listing paths, /nutzungsbedingungen and /datenschutz are readable with no automation prohibition, and the entry page returns HTTP 200 without a challenge or login. No machine-readable offer endpoint could be established, though: the listing publishes only ItemList/ListItem, not per-offer JobPosting, and no query-free detail path was found on the robots-allowed paths.",
    emailAllowed: true,
  },
  {
    id: "azubister-de",
    displayName: "Azubister.de",
    category: "ausbildung",
    domain: "azubister.de",
    policy: "restricted",
    reason:
      "robots.txt disallows exactly the paths an adapter would request for `*` (and for bingbot): /suche/, /ausbildungsplätze?, /duales-studium?, /berufe/suche?, /ausbildungsbetriebe/suche?.",
    emailAllowed: false,
  },
  {
    id: "ausbildunganzeigen-de",
    displayName: "Ausbildunganzeigen.de",
    category: "ausbildung",
    domain: "ausbildunganzeigen.de",
    policy: "restricted",
    reason:
      "robots.txt disallows every query-string URL (`Disallow: /*?`) together with /feed/ and the CMS/plugin paths, so the search/listing shape is disallowed; no query-free listing endpoint could be established.",
    emailAllowed: false,
  },
  {
    id: "azubi-de",
    displayName: "Azubi.de",
    category: "ausbildung",
    domain: "azubi.de",
    policy: "unverified",
    reason:
      "robots.txt is permissive, but /agb, /impressum and /nutzungsbedingungen all answer HTTP 405 — the terms could not be read, so the classification stays open.",
    emailAllowed: true,
  },
  {
    id: "ihk-ausbildung",
    displayName: "IHK-Börse / Meine Ausbildung in Deutschland",
    category: "chamber",
    domain: "meine-ausbildung-in-deutschland.de",
    policy: "unverified",
    reason:
      "robots.txt is absent (404) and the IHK terms were not readable during the audit; the canonical board URL could not be confirmed.",
    emailAllowed: true,
  },
  {
    id: "handwerkskammer",
    displayName: "Handwerkskammer Lehrstellenbörse",
    category: "chamber",
    domain: "hwk.de",
    policy: "unverified",
    reason:
      "hwk.de allows crawling, but the chamber site is not the Lehrstellenbörse itself — the actual board system was not confirmed during the audit.",
    emailAllowed: true,
  },
  {
    id: "indeed-de",
    displayName: "Indeed Deutschland",
    category: "jobs",
    domain: "de.indeed.com",
    policy: "restricted",
    reason:
      "robots.txt disallows the listing and detail paths an adapter would request (/job/, /viewjob, /advanced_search, /*&start=, /offers).",
    emailAllowed: false,
  },
  {
    id: "stepstone-de",
    displayName: "StepStone Deutschland",
    category: "jobs",
    domain: "stepstone.de",
    policy: "restricted",
    reason:
      "robots.txt disallows /search-results, /listing, /5/job-search-*, /jobs/*?*; its header states that any other use is strictly prohibited.",
    emailAllowed: false,
  },
  {
    id: "jobware",
    displayName: "Jobware",
    category: "jobs",
    domain: "jobware.de",
    policy: "restricted",
    reason:
      "A plain polite request to the terms page is answered with HTTP 403 (challenge/forbidden) — the wall is present before any listing is requested.",
    emailAllowed: false,
  },
  {
    id: "monster-de",
    displayName: "Monster Deutschland",
    category: "jobs",
    domain: "monster.de",
    policy: "unverified",
    reason:
      "robots.txt is not served (the request is answered with the site's consent/JS shell), so neither the policy nor the terms could be established.",
    emailAllowed: false,
  },
  {
    id: "xing-jobs",
    displayName: "XING Jobs",
    category: "platform",
    domain: "xing.com",
    policy: "restricted",
    reason:
      "robots.txt disallows /jobs/search/ and /jobs/search?* for every agent except named AI/search bots; member profiles are never a data source (§7).",
    emailAllowed: false,
  },
  {
    id: "linkedin-jobs",
    displayName: "LinkedIn Jobs",
    category: "platform",
    domain: "linkedin.com",
    policy: "restricted",
    reason:
      "robots.txt states that automated access without LinkedIn's express permission is strictly prohibited; member profiles are never a data source (§7).",
    emailAllowed: false,
  },
  {
    id: "meinestadt-jobs",
    displayName: "meinestadt.de Jobs",
    category: "local-jobs",
    domain: "meinestadt.de",
    policy: "restricted",
    reason:
      "A plain polite request to /impressum and /agb is answered with HTTP 403 — the source is walled off before any listing is requested.",
    emailAllowed: false,
  },
  {
    id: "yourfirm",
    displayName: "Yourfirm",
    category: "jobs",
    domain: "yourfirm.de",
    policy: "restricted",
    reason:
      "robots.txt disallows the whole search and job-view families (/suche/all*, /job/{inline,app,plain,full,bare,reference,xing}*) and the terms page answers HTTP 403.",
    emailAllowed: false,
  },
  {
    id: "bund-de",
    displayName: "Bund.de Stellenangebote",
    category: "government",
    domain: "service.bund.de",
    policy: "restricted",
    reason:
      "robots.txt disallows the job search the adapter would request (/Content/DE/Stellen/Suche/) and asks for a 30 s crawl delay.",
    emailAllowed: false,
  },
  {
    id: "jobboerse-de",
    displayName: "Jobbörse.de",
    category: "jobs",
    domain: "jobboerse.de",
    policy: "unverified",
    reason:
      "robots.txt is permissive, but the terms page could not be reached during the audit (no response), so no prohibition could be ruled out.",
    emailAllowed: true,
  },
  {
    id: "ausbildungsmarkt-de",
    displayName: "Ausbildungsmarkt.de",
    category: "ausbildung",
    domain: "ausbildungsmarkt.de",
    policy: "restricted",
    reason:
      "robots.txt disallows exactly the search, detail and listing paths (/suche.html*, /job.php*, /ausbildungsplatz/*).",
    emailAllowed: false,
  },
  // ---- Search engines (§6) — reached ONLY through a legitimate API --------
  {
    id: "search-api",
    displayName: "Search API (Tavily)",
    category: "search",
    domain: "api.tavily.com",
    policy: "enabled_official_api",
    reason:
      "The project already integrates the official Tavily Search API (POST api.tavily.com/search, Bearer auth, documented rate limits, a per-run request cap). It is a legitimate, documented interface — not SERP scraping — so it may drive the offer-discovery query fan-out and the existing email-lookup step. Its result URLs are normalized into the offer model, and every fetched page passes the guarded fetcher (SSRF / robots / pacing / circuit breaker / central classifier).",
    emailAllowed: false,
  },
  {
    id: "search-google",
    displayName: "Google (web search)",
    category: "search",
    domain: "google.com",
    policy: "restricted",
    reason:
      "Scraping Google's HTML search-result pages violates Google's Terms of Service and its access controls; no official interface is configured for this project, so it is registered but never requested (search goes through the permitted Tavily API instead).",
    emailAllowed: false,
  },
  {
    id: "search-bing",
    displayName: "Bing (web search)",
    category: "search",
    domain: "bing.com",
    policy: "restricted",
    reason:
      "Bing's SERP pages are not a permitted scraping target and its official Web Search API is not configured for this project; registered for audit completeness and never requested.",
    emailAllowed: false,
  },
  {
    id: "search-google-cse",
    displayName: "Google Programmable Search Engine",
    category: "search",
    domain: "programmablesearchengine.google.com",
    policy: "unverified",
    reason:
      "The Google Programmable Search Engine (CSE) is a legitimate official search API, but no CSE id / key is configured for this project, so the classification stays unverified and it is not executed.",
    emailAllowed: false,
  },
  // ---- Public directories (§12) -------------------------------------------
  {
    id: "directory-handwerksrolle",
    displayName: "Handwerksrolle (public craft register)",
    category: "directory",
    domain: "handwerksrolle.de",
    policy: "unverified",
    reason:
      "The public craft register lists employers per chamber, but a machine-readable offer endpoint and a scraping permission could not be established during the audit; registered and never requested, and never treated as an email source on its own.",
    emailAllowed: false,
  },
  {
    id: "arbeitsagentur",
    displayName: "Bundesagentur für Arbeit",
    category: "government",
    domain: "arbeitsagentur.de",
    policy: "restricted",
    reason:
      "Kept as an offer/company source only. Its contact data is protected by a challenge in practice, and §3.3 removes it entirely from the email path.",
    emailAllowed: false,
  },
] as const;

const BY_ID = new Map<string, PortalSource>(
  PORTAL_SOURCES.map((source) => [source.id, source]),
);

/** The registry entry for an id, or undefined for an unknown source. */
export function sourceById(id: string): PortalSource | undefined {
  return BY_ID.get(id);
}

/** True when an adapter may be implemented/run for this source (§3.4). */
export function isSourceEnabled(source: PortalSource): boolean {
  return (
    source.policy === "enabled_public" ||
    source.policy === "enabled_official_api"
  );
}

/** The sources an adapter is allowed to request, in registry order. */
export function enabledSources(): PortalSource[] {
  return PORTAL_SOURCES.filter(isSourceEnabled);
}

/**
 * The sources every run must report as `skipped_by_policy`: registered,
 * never requested, and NEVER counted as `no_public_email` (§3.4/§4.4).
 */
export function policySkippedSources(): PortalSource[] {
  return PORTAL_SOURCES.filter((source) => !isSourceEnabled(source));
}

/**
 * May an address published by this source be accepted? `false` for
 * Arbeitsagentur (§3.3) and for every source that is not an enabled portal.
 */
export function mayYieldEmail(sourceId: string): boolean {
  const source = BY_ID.get(sourceId);
  return source !== undefined && source.emailAllowed && isSourceEnabled(source);
}

/** True when a host belongs to one of the registered portals. */
export function isPortalHost(host: string): boolean {
  const bare = host.toLowerCase().replace(/^www\./, "");
  return PORTAL_SOURCES.some(
    (source) => bare === source.domain || bare.endsWith(`.${source.domain}`),
  );
}

/** The display name of the source that owns a host, or null. */
export function portalNameForHost(host: string): string | null {
  const bare = host.toLowerCase().replace(/^www\./, "");
  const match = PORTAL_SOURCES.find(
    (source) => bare === source.domain || bare.endsWith(`.${source.domain}`),
  );
  return match?.displayName ?? null;
}

/**
 * The "company websites" discovery LAYER (§11). It is NOT a queryable source in
 * `PORTAL_SOURCES`: it derives its targets from the companies a run already
 * discovered (each with a verified official domain), so it is deliberately kept
 * OUT of `enabledSources()` / `policySkippedSources()`, which drive the adapter
 * set and the fail-closed policy gate. The orchestrator reports it as its own
 * source row (this id / category / policy) and the UI groups it under the
 * "company websites" family.
 */
export const COMPANY_WEBSITES_LAYER = {
  id: "company-websites",
  displayName: "Company websites",
  category: "company-site" as SourceCategory,
  policy: "enabled_public" as SourcePolicy,
  reason:
    "Official company domains discovered by the run; same-site Ausbildung / Karriere / Jobs pages are fetched only through the guarded fetcher (robots-allowed, paced, circuit-broken) and their schema.org/JobPosting data is normalized into the offer model.",
} as const;

/** The registry category for a source id, or the layer's, or null. */
export function categoryForSourceId(id: string): SourceCategory | null {
  if (id === COMPANY_WEBSITES_LAYER.id) return COMPANY_WEBSITES_LAYER.category;
  return sourceById(id)?.category ?? null;
}
