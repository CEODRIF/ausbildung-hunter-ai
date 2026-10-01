import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { createAIProvider } from "@/lib/ai-provider";
import { reserveAIUsage } from "@/lib/ai-service";
import {
  fetchPublicPage,
  type FetchedPage,
  type PageFetchFailure,
  type RobotsPolicy,
} from "@/lib/web-search/fetch-page";
import {
  WebSearchError,
  type WebSearchClient,
  type WebSearchResult,
} from "@/lib/web-search";
import {
  opportunitySchema,
  type Enrichment,
  type Opportunity,
  type OpportunitySourceType,
} from "@/lib/opportunities/types";
import { normalizeOpportunityEmail } from "@/lib/opportunities/email-export";
import { classifyEmailType } from "@/lib/opportunities/enrichment/text-extract";
import {
  buildSourceQuery,
  enabledWebSources,
  hostToSourceId,
  SOURCE_CATEGORIES,
  type SourceCategory,
  type SourceDefinition,
} from "@/lib/opportunities/sources";

/**
 * Web discovery layer for AI Ausbildung Search.
 *
 * Broad, SURFACE-LEVEL discovery across publicly indexed pages via ONE
 * provider: the official Tavily Search API (see src/lib/web-search). No
 * per-site scrapers: a few broad queries return public page titles/URLs
 * (URLs come exclusively from the provider response — never invented); the
 * pages are then visited with the guarded fetcher (robots.txt respected,
 * anti-bot skipped). The AI is used in bounded batches to classify +
 * extract; everything else is deterministic. No login, no
 * CAPTCHA/anti-bot/robots bypass, no private content — blocked pages are
 * simply skipped (and counted honestly).
 */

// The category taxonomy now lives in the Source Registry (sources.ts);
// re-exported so existing consumers (UI, tests) keep working unchanged.
export type { SourceCategory } from "./sources";
export { SOURCE_CATEGORIES } from "./sources";

/** Authority used when several sources describe the same vacancy:
 *  official > company site > job portal > search snippet > social > other. */
export const SOURCE_TYPE_AUTHORITY: Record<OpportunitySourceType, number> = {
  official_source: 5,
  company_website: 4,
  job_portal: 3,
  search_engine: 2,
  social_media: 1,
  other: 0,
};

// ---------------------------------------------------------------------------
// Classification (deterministic)
// ---------------------------------------------------------------------------

export const SOCIAL_HOSTS = new Set([
  "linkedin.com",
  "instagram.com",
  "facebook.com",
  "fb.com",
  "tiktok.com",
  "youtube.com",
  "x.com",
  "twitter.com",
]);

export const PORTAL_HOSTS = new Set([
  "ausbildung.de",
  "aubi-plus.de",
  "azubiyo.de",
  "indeed.de",
  "indeed.com",
  "stepstone.de",
  "meinestadt.de",
  "xing.com",
  "gojobs.de",
  "ausbildungihrerstadt.de",
  "azubimessenger.de",
  "jobvector.de",
  "stellenanzeigen.de",
]);

/** True when a host belongs to a known job-portal / social aggregator —
 *  such URLs are never treated as a company's own website. */
export function isAggregatorHost(url: string): boolean {
  const parsed = (() => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  })();
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const domain = hostDomain(parsed.hostname);
  return (
    PORTAL_HOSTS.has(host) ||
    PORTAL_HOSTS.has(domain) ||
    SOCIAL_HOSTS.has(host) ||
    SOCIAL_HOSTS.has(domain)
  );
}

const CAREER_SIGNAL_RE =
  /karriere|stellenange|stellenanzeige|stellenmarkt|jobs?|vacanc|ausbildung|azubi|praktikum|berufseinstieg|bewerb/i;
const OPPORTUNITY_SIGNAL_RE =
  /ausbildung|stellen|job|karriere|azubi|berufseinstieg|praktikum|anler|auszubildend/i;

function hostDomain(host: string): string {
  const bare = host.toLowerCase().replace(/^www\./, "");
  const parts = bare.split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : bare;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Deterministic source-type classification of a discovered page. */
export function classifySource(
  url: string,
  titleOrPathSignals: string,
): OpportunitySourceType {
  const parsed = (() => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  })();
  if (!parsed) return "other";
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const domain = hostDomain(parsed.hostname);
  if (SOCIAL_HOSTS.has(host) || SOCIAL_HOSTS.has(domain)) return "social_media";
  if (PORTAL_HOSTS.has(host) || PORTAL_HOSTS.has(domain)) return "job_portal";
  if (
    host === "arbeitsagentur.de" ||
    domain === "arbeitsagentur.de" ||
    (/(ihk|hwk)/.test(host) && /\.de$/.test(host))
  )
    return "official_source";
  const signals = `${parsed.pathname} ${titleOrPathSignals}`.toLowerCase();
  if (CAREER_SIGNAL_RE.test(signals)) return "company_website";
  return "other";
}

// ---------------------------------------------------------------------------
// Category-scoped queries (deterministic wrapping of the AI's web queries)
// ---------------------------------------------------------------------------

const PORTAL_SITE_OPERATORS =
  "site:ausbildung.de OR site:azubiyo.de OR site:indeed.de OR site:stepstone.de OR site:meinestadt.de OR site:xing.com";
const SOCIAL_SITE_OPERATORS =
  "site:linkedin.com OR site:instagram.com OR site:facebook.com OR site:tiktok.com OR site:youtube.com";
const COMPANY_PAGE_OPERATORS =
  '(karriere OR stellenangebote OR stellenanzeige OR "jobs")';

export function buildCategoryQueries(
  webQueries: string[],
  category: SourceCategory,
): string[] {
  const queries = webQueries.map((q) => q.trim()).filter(Boolean);
  switch (category) {
    case "search_engine":
      return queries;
    case "job_portal":
      return queries.map((q) => `${q} ${PORTAL_SITE_OPERATORS}`);
    case "company_website":
      return queries.map((q) => `${q} ${COMPANY_PAGE_OPERATORS}`);
    case "social_media":
      return queries.map((q) => `${q} ${SOCIAL_SITE_OPERATORS}`);
  }
}

// ---------------------------------------------------------------------------
// Candidate collection (search provider → unique, relevant candidates)
// ---------------------------------------------------------------------------

export interface DiscoveredCandidate {
  url: string;
  title: string;
  snippet: string;
  category: SourceCategory;
  query: string;
  /** Registry id of the source that surfaced this candidate
   *  (AI Search 2.0). Unset on candidates from the legacy
   *  category-based discovery path. */
  sourceId?: string;
}

function normalizeUrlForDedupe(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      // Tracking parameters (utm_* family + common click ids) are stripped
      // so the same page with different campaign params dedupes to one URL.
      if (/^(utm_\w+|fbclid|gclid|ref|source)$/i.test(key))
        parsed.searchParams.delete(key);
    }
    const query = parsed.searchParams.toString();
    return (
      parsed.protocol +
      "//" +
      parsed.hostname.toLowerCase() +
      parsed.pathname.replace(/\/+$/, "") +
      (query ? `?${query}` : "")
    );
  } catch {
    return url;
  }
}

/** A candidate is worth a (guarded) page visit when it carries an
 *  opportunity signal in the search result, or the host is a known
 *  portal/social domain. */
function isRelevant(candidate: DiscoveredCandidate): boolean {
  const domain = hostDomain(hostOf(candidate.url));
  if (PORTAL_HOSTS.has(domain) || SOCIAL_HOSTS.has(domain)) return true;
  const haystack = `${candidate.title} ${candidate.snippet}`;
  return OPPORTUNITY_SIGNAL_RE.test(haystack);
}

/** Search one category across all its queries. Skips sources the search
 *  provider cannot reach; every failure is counted, never faked. */
export async function discoverCategory(args: {
  client: WebSearchClient;
  category: SourceCategory;
  webQueries: string[];
  perQueryResults?: number;
}): Promise<{
  candidates: DiscoveredCandidate[];
  errors: number;
  firstError: WebSearchError | null;
}> {
  const { client, category, webQueries } = args;
  const perQuery = args.perQueryResults ?? 10;
  const candidates: DiscoveredCandidate[] = [];
  const seen = new Set<string>();
  let errors = 0;
  let firstError: WebSearchError | null = null;
  for (const query of buildCategoryQueries(webQueries, category)) {
    let results;
    try {
      results = await client.search(query, perQuery);
    } catch (error) {
      // Provider-level failure for this query (key rejected, outage,
      // rate limit). Count it and continue — other queries/categories
      // may still succeed.
      if (error instanceof WebSearchError && !firstError) firstError = error;
      if (!(error instanceof WebSearchError))
        console.error("[web-search] unexpected error", error);
      errors += 1;
      continue;
    }
    for (const result of results) {
      const parsed = (() => {
        try {
          return new URL(result.url);
        } catch {
          return null;
        }
      })();
      if (!parsed || parsed.protocol !== "https:") continue;
      const domain = hostDomain(parsed.hostname);
      // Official BA results are covered by the authoritative BA pipeline.
      if (domain === "arbeitsagentur.de") continue;
      const candidate: DiscoveredCandidate = {
        url: normalizeUrlForDedupe(result.url),
        title: result.title,
        snippet: result.snippet,
        category,
        query,
      };
      if (!isRelevant(candidate)) continue;
      const key = normalizeUrlForDedupe(candidate.url);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  }
  return { candidates, errors, firstError };
}

/** Search ONE registry source across its queries. Same legal contract as
 *  discoverCategory (https-only, BA excluded, relevance filter, dedupe);
 *  every candidate carries the source's registry id. */
export async function discoverSource(args: {
  client: WebSearchClient;
  source: SourceDefinition;
  webQueries: string[];
  perQueryResults?: number;
}): Promise<{
  candidates: DiscoveredCandidate[];
  errors: number;
  firstError: WebSearchError | null;
}> {
  const { client, source, webQueries } = args;
  const perQuery = args.perQueryResults ?? 10;
  const queries = webQueries
    .map((query) => buildSourceQuery(source, query))
    .filter(Boolean);
  const candidates: DiscoveredCandidate[] = [];
  const seen = new Set<string>();
  let errors = 0;
  let firstError: WebSearchError | null = null;
  for (const query of queries) {
    let results;
    try {
      results = await client.search(query, perQuery);
    } catch (error) {
      // Provider-level failure for this query (key rejected, outage,
      // rate limit). Count it and continue — other sources may still
      // succeed. We never retry past the provider's own backoff.
      if (error instanceof WebSearchError && !firstError) firstError = error;
      if (!(error instanceof WebSearchError))
        console.error("[web-search] unexpected error", error);
      errors += 1;
      continue;
    }
    for (const result of results) {
      const parsed = (() => {
        try {
          return new URL(result.url);
        } catch {
          return null;
        }
      })();
      if (!parsed || parsed.protocol !== "https:") continue;
      const domain = hostDomain(parsed.hostname);
      // Official BA results are covered by the authoritative BA pipeline.
      if (domain === "arbeitsagentur.de") continue;
      const candidate: DiscoveredCandidate = {
        url: normalizeUrlForDedupe(result.url),
        title: result.title,
        snippet: result.snippet,
        category: source.category,
        query,
        sourceId: source.id,
      };
      if (!isRelevant(candidate)) continue;
      const key = normalizeUrlForDedupe(candidate.url);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  }
  return { candidates, errors, firstError };
}

// ---------------------------------------------------------------------------
// Verification (guarded page fetch) + bounded AI extraction
// ---------------------------------------------------------------------------

const MAX_CANDIDATES = 40;
const CHECK_CONCURRENCY = 5;
const EXTRACT_BATCH_SIZE = 15;
const EXTRACT_TEXT_CHARS = 1_500;

export interface VerifiedCandidate {
  candidate: DiscoveredCandidate;
  page: FetchedPage | null;
  source_type: OpportunitySourceType;
  failure: PageFetchFailure | null;
}

const categoryPriority: Record<SourceCategory, number> = {
  job_portal: 0,
  company_website: 1,
  search_engine: 2,
  social_media: 3,
};

/** Visit (with all guards) the unique candidates, highest priority first.
 *  A blocked/unreachable page becomes a snippet-only candidate (or is
 *  dropped if even the snippet cannot yield an opportunity). */
export async function verifyCandidates(
  candidates: DiscoveredCandidate[],
  onProgress?: (done: number, total: number) => void,
): Promise<VerifiedCandidate[]> {
  const unique = [...new Map(candidates.map((c) => [c.url, c])).values()].sort(
    (a, b) =>
      categoryPriority[a.category] - categoryPriority[b.category] ||
      (a.url < b.url ? -1 : 1),
  );
  const capped = unique.slice(0, MAX_CANDIDATES);
  const robotsCache = new Map<string, RobotsPolicy>();
  const verified: VerifiedCandidate[] = [];
  let done = 0;
  for (let start = 0; start < capped.length; start += CHECK_CONCURRENCY) {
    const batch = capped.slice(start, start + CHECK_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (candidate) => {
        const sourceType = classifySource(candidate.url, candidate.title);
        const fetched = await fetchPublicPage(candidate.url, robotsCache);
        if (fetched.ok)
          return {
            candidate,
            page: fetched.page,
            source_type: classifySource(candidate.url, fetched.page.title ?? candidate.title),
            failure: null,
          } as VerifiedCandidate;
        // Snippet-only fallback (search-engine-grade evidence): keep the
        // candidate so extraction can still try title+snippet; if that
        // yields nothing, the row is dropped (no invention).
        return {
          candidate,
          page: null,
          source_type: sourceType,
          failure: fetched.reason,
        } as VerifiedCandidate;
      }),
    );
    for (const item of results) {
      verified.push(item);
      done += 1;
    }
    onProgress?.(done, capped.length);
  }
  return verified;
}

function isRealIsoDate(value: string): boolean {
  const parsed = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parsed) return false;
  const date = new Date(Date.UTC(Number(parsed[1]), Number(parsed[2]) - 1, Number(parsed[3])));
  return (
    date.getUTCFullYear() === Number(parsed[1]) &&
    date.getUTCMonth() === Number(parsed[2]) - 1 &&
    date.getUTCDate() === Number(parsed[3])
  );
}

/** Strict extraction item. `url` MUST be one of the provided candidates
 *  (server-side cross-check — an AI-invented URL is dropped). */
const webExtractionItemSchema = z
  .object({
    url: z.string().url().max(500),
    company: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(200),
    location: z.string().trim().max(120).nullable().default(null),
    bundesland: z.string().trim().max(60).nullable().default(null),
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(isRealIsoDate, { message: "not a real calendar date" })
      .nullable()
      .default(null),
    application_deadline: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(isRealIsoDate, { message: "not a real calendar date" })
      .nullable()
      .default(null),
    email: z.string().trim().email().max(200).nullable().default(null),
    phone: z.string().trim().max(40).nullable().default(null),
    company_website: z
      .string()
      .trim()
      .url()
      .max(500)
      .nullable()
      .default(null),
    application_url: z
      .string()
      .trim()
      .url()
      .max(500)
      .nullable()
      .default(null),
    requirements: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
    /** Another provided URL that clearly describes the SAME vacancy. */
    duplicate_of_url: z.string().trim().url().max(500).nullable().default(null),
    note: z.string().trim().max(300).default(""),
  })
  .strict();
export type WebExtractionItem = z.infer<typeof webExtractionItemSchema>;

function extractionPrompt(items: Array<{
  index: number;
  url: string;
  source_type: OpportunitySourceType;
  page_title: string | null;
  meta_description: string | null;
  text: string;
}>): string {
  return `You extract Ausbildung/job opportunities from public web pages.
Below are ${items.length} discovered pages (title, meta description, beginning of the page text). For EACH page that actually documents one specific Ausbildung or job vacancy, output one object.

Rules (strict — anti-fabrication):
- "url" must be copied EXACTLY from the list (use the given URL of that page). Never output a URL that is not in the list.
- Every field must be directly supported by the provided text of THAT page. If a field is not present in the text, use null / empty.
- NEVER invent companies, roles, emails, phones, dates, or URLs. If company or vacancy title cannot be determined from the provided text, OMIT that page entirely.
- Dates as ISO YYYY-MM-DD. "start_date" = training/start start; "application_deadline" only if explicitly stated as an application deadline.
- If two listed pages clearly describe the SAME vacancy (same company + same role + same location/year), set "duplicate_of_url" on the second one to the URL of the first.
- "requirements": at most 10 short strings, only when documented.
- Social pages: only count public posts/pages that actually document a vacancy.
Return ONLY a valid JSON array of objects with exactly these keys: url, company, title, location, bundesland, start_date, application_deadline, email, phone, company_website, application_url, requirements, duplicate_of_url, note.

Pages:
${items
  .map(
    (item, i) =>
      `[${i}] url=${item.url} source_type=${item.source_type}\npage_title=${item.page_title ?? ""}\nmeta_description=${item.meta_description ?? ""}\ntext=${item.text}`,
  )
  .join("\n\n")}`;
}

/** Bounded AI extraction: batches of 15 pages, one AI call per batch,
 *  each batch a separately reserved AI quota request. Returns validated
 *  items (URLs cross-checked against the provided candidates). */
export async function extractFromPages(
  verified: VerifiedCandidate[],
  args: {
    userId: string;
    onProgress?: (done: number, total: number) => void;
  },
): Promise<{ items: WebExtractionItem[]; aiUsed: boolean }> {
  const eligible = verified.filter(
    (v) => v.page || `${v.candidate.title} ${v.candidate.snippet}`.length > 0,
  );
  const items: WebExtractionItem[] = [];
  let aiUsed = false;
  let done = 0;
  const urlSet = new Set(verified.map((v) => v.candidate.url));
  for (let start = 0; start < eligible.length; start += EXTRACT_BATCH_SIZE) {
    const batch = eligible.slice(start, start + EXTRACT_BATCH_SIZE);
    const payload = batch.map((v, index) => ({
      index,
      url: v.candidate.url,
      source_type: v.source_type,
      page_title: v.page?.title ?? v.candidate.title,
      meta_description: v.page?.metaDescription ?? null,
      text: v.page
        ? v.page.text.slice(0, EXTRACT_TEXT_CHARS)
        : `search result title: ${v.candidate.title}\nsearch result snippet: ${v.candidate.snippet}`,
    }));
    const batchItems: WebExtractionItem[] = [];
    try {
      await reserveAIUsage(args.userId);
      const response = await createAIProvider().generateText([
        { role: "user", content: extractionPrompt(payload) },
      ]);
      let jsonText = response
        .replace(/^```json\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      const startBrace = jsonText.indexOf("[");
      if (startBrace >= 0) jsonText = jsonText.slice(startBrace);
      const parsed = JSON.parse(jsonText) as unknown;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const rawItem of list) {
        const check = webExtractionItemSchema.safeParse(rawItem);
        if (!check.success) continue;
        const item = check.data;
        // Anti-fabrication anchor: the URL must be a provided candidate.
        if (!urlSet.has(normalizeUrlForDedupe(item.url)) && !urlSet.has(item.url))
          continue;
        if (
          item.duplicate_of_url &&
          !urlSet.has(normalizeUrlForDedupe(item.duplicate_of_url))
        )
          item.duplicate_of_url = null;
        batchItems.push(item);
      }
      aiUsed = true;
    } catch {
      // Transient AI failure for this batch: fall back to deterministic
      // extraction for these pages (source signals only, nothing invented).
      for (const v of batch) {
        const deterministic = deterministicExtract(v);
        if (deterministic) batchItems.push(deterministic);
      }
    }
    items.push(...batchItems);
    done += batch.length;
    args.onProgress?.(done, eligible.length);
  }
  return { items, aiUsed };
}

/** Deterministic fallback (also used when AI is unavailable): company from
 *  og:site_name (when it is not a platform name), title from the page
 *  title. Nothing else is invented — if company cannot be determined the
 *  candidate is dropped. */
const PLATFORM_SITE_NAMES = new Set([
  "linkedin",
  "instagram",
  "facebook",
  "tiktok",
  "youtube",
  "xing",
  "indeed",
  "stepstone",
  "azubiyo",
  "ausbildung",
  "meinestadt",
]);

export function deterministicExtract(
  verified: VerifiedCandidate,
): WebExtractionItem | null {
  const page = verified.page;
  const siteName =
    page?.siteName && !PLATFORM_SITE_NAMES.has(page.siteName.toLowerCase().slice(0, 10))
      ? page.siteName
      : null;
  const company = siteName || null;
  const rawTitle = page?.title || verified.candidate.title;
  const title = rawTitle
    .replace(/\s*[|–—-]\s*(?:Karriere|Stellenangebote|Jobs|Ausbildung|\.de|\.com).*$/i, "")
    .trim()
    .slice(0, 200);
  if (!company || !title) return null;
  return {
    url: verified.candidate.url,
    company,
    title,
    location: null,
    bundesland: null,
    start_date: null,
    application_deadline: null,
    email: null,
    phone: null,
    company_website: page ? verified.candidate.url : null,
    application_url: null,
    requirements: [],
    duplicate_of_url: null,
    note: "extracted from public page metadata",
  };
}

// ---------------------------------------------------------------------------
// Web candidate → normalized Opportunity
// ---------------------------------------------------------------------------

export function toOpportunity(
  item: WebExtractionItem,
  verified: VerifiedCandidate,
  goal: "ausbildung" | "arbeit",
): Opportunity {
  const digest = createHash("sha1").update(verified.candidate.url).digest("hex");
  return opportunitySchema.parse({
    id: `web:${digest.slice(0, 24)}`,
    provider: "web",
    external_id: digest.slice(0, 32),
    source_name: hostOf(verified.candidate.url) || "web",
    source_url: verified.candidate.url,
    source_type: verified.source_type,
    additional_sources: [],
    application_url: item.application_url,
    title: item.title,
    goal,
    stellenangebotsart: null,
    company_name: item.company,
    company_url: item.company_website,
    location: item.location,
    location_detail: item.bundesland
      ? {
          city: null,
          region: item.bundesland,
          country: "Deutschland",
          postal_code: null,
        }
      : null,
    distance_km: null,
    latitude: null,
    longitude: null,
    profession: null,
    alternative_professions: [],
    description: verified.page?.metaDescription
      ? verified.page.metaDescription.slice(0, 5000)
      : null,
    tasks: [],
    requirements: item.requirements,
    employment_type: null,
    home_office: null,
    career_change_friendly: null,
    salary: null,
    training_type: null,
    education_requirement: null,
    valid_from: item.start_date,
    application_deadline: item.application_deadline,
    posted_at: null,
    updated_at: null,
    retrieved_at: new Date().toISOString(),
    contact:
      item.email || item.phone
        ? { person: null, email: item.email, phone: item.phone }
        : null,
    required_skills: [],
    preferred_skills: [],
    required_languages: [],
    extracted_keywords: [],
    // AI Search 2.0: remember which registry source surfaced this page
    // (falls back to "web" for candidates from the legacy category path).
    source_ids: [verified.candidate.sourceId ?? "web"],
    match: null,
  });
}

// ---------------------------------------------------------------------------
// Multi-source dedupe (BA + web) with provenance
// ---------------------------------------------------------------------------

export function normalizeIdentity(value: string | null): string {
  if (!value) return "";
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Identity fingerprint: normalized company + title. The year stays part
 *  of the title — "… 2027" and "… 2028" are different vacancies. */
export function fingerprintOpportunity(opportunity: Opportunity): string {
  return `${normalizeIdentity(opportunity.company_name)}|${normalizeIdentity(
    opportunity.title,
  )}`;
}

/**
 * Concrete start year documented on the row — from `valid_from` when the
 * source states it, else from an explicit "20xx" year in the title. Null
 * when the source documents no year (unknown ≠ any year).
 */
export function startYearOf(opportunity: Opportunity): string | null {
  const from = opportunity.valid_from?.slice(0, 4) ?? "";
  if (/^\d{4}$/.test(from)) return from;
  const inTitle = opportunity.title.match(/\b(20\d{2})\b/);
  if (inTitle) return inTitle[1];
  return null;
}

/** Normalized city documented on the row, or null (unknown). */
export function cityOf(opportunity: Opportunity): string | null {
  const city = opportunity.location_detail?.city;
  if (!city) return null;
  const normalized = normalizeIdentity(city);
  return normalized ? normalized : null;
}

/** Registry id a row was discovered on (primary source). */
function sourceIdOf(opportunity: Opportunity): string {
  if (opportunity.provider === "arbeitsagentur") return "arbeitsagentur";
  if (opportunity.source_ids.length > 0) return opportunity.source_ids[0];
  return hostToSourceId(opportunity.source_url) ?? "web";
}

function fieldCount(opportunity: Opportunity): number {
  let count = 0;
  for (const value of Object.values(opportunity)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    count += 1;
  }
  return count;
}

export interface MergeSummary {
  merged: Opportunity[];
  /** Total input rows − resulting groups (real duplicates removed). */
  duplicatesRemoved: number;
}

/**
 * Merge BA rows + web rows into one opportunity per vacancy:
 * - groups by identity fingerprint (company + title), refined by START
 *   YEAR and CITY compatibility: two rows with the same company + title
 *   merge when their documented start years agree (or at least one is
 *   undocumented) AND their documented cities agree (or at least one is
 *   undocumented). Same vacancy, different intake year (2027 vs 2028) or
 *   different branch city (chain) stays separate.
 * - plus AI-identified duplicates (union-find over `duplicate_of_url`
 *   links within the web rows);
 * - group leader = highest source authority, then richest data, then
 *   stable id; the leader keeps the `web`/`arbeitsagentur` identity;
 * - the leader's NULL fields are back-filled from followers (real source
 *   data only); followers become `additional_sources` (provenance);
 * - `source_ids` records every registry source the vacancy was found on;
 * - `official_company_source` (and the official application URL) is set
 *   when one of the sources is the company's own career page;
 * - the `enrichment` block is seeded with merge-level provenance (email
 *   found on which public page, company website URL + evidence) — the
 *   company-enrichment pipeline extends it later.
 */
export function mergeOpportunities(args: {
  ba: Opportunity[];
  web: Opportunity[];
  aiDuplicates: Array<{ fromUrl: string; toUrl: string }>;
}): MergeSummary {
  const { ba, web, aiDuplicates } = args;
  const all = [...ba, ...web];
  // Union-find over ALL rows: same-vacancy groups are formed by
  // (a) identity fingerprints refined by year/city compatibility and
  // (b) AI-identified duplicate links between web URLs.
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    for (;;) {
      const next = parent.get(root);
      if (next === undefined || next === root) return root;
      root = next;
    }
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  all.forEach((op, index) => parent.set(String(index), String(index)));
  // (a) fingerprint + compatibility unions, scoped WITHIN each primary
  // fingerprint group (different companies/titles never merge here).
  const indexesByFingerprint = new Map<string, number[]>();
  all.forEach((op, index) => {
    const key = fingerprintOpportunity(op);
    const list = indexesByFingerprint.get(key);
    if (list) list.push(index);
    else indexesByFingerprint.set(key, [index]);
  });
  const yearOf = all.map((op) => startYearOf(op));
  const cityOfRow = all.map((op) => cityOf(op));
  for (const indexes of indexesByFingerprint.values()) {
    for (let i = 0; i < indexes.length; i += 1) {
      for (let j = i + 1; j < indexes.length; j += 1) {
        const a = indexes[i];
        const b = indexes[j];
        const yearA = yearOf[a];
        const yearB = yearOf[b];
        const yearCompatible =
          yearA === null || yearB === null || yearA === yearB;
        const cityA = cityOfRow[a];
        const cityB = cityOfRow[b];
        const cityCompatible =
          cityA === null || cityB === null || cityA === cityB;
        if (yearCompatible && cityCompatible) union(String(a), String(b));
      }
    }
  }
  const byUrl = new Map<string, string>();
  web.forEach((op, index) => byUrl.set(op.source_url, String(index)));
  for (const link of aiDuplicates) {
    const from = byUrl.get(normalizeUrlForDedupe(link.fromUrl)) ?? byUrl.get(link.fromUrl);
    const to = byUrl.get(normalizeUrlForDedupe(link.toUrl)) ?? byUrl.get(link.toUrl);
    if (from && to) union(from, to);
  }
  const groups = new Map<string, Opportunity[]>();
  all.forEach((op, index) => {
    const root = find(String(index));
    const group = groups.get(root);
    if (group) group.push(op);
    else groups.set(root, [op]);
  });

  const merged: Opportunity[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => {
      const authority =
        SOURCE_TYPE_AUTHORITY[b.source_type] -
        SOURCE_TYPE_AUTHORITY[a.source_type];
      if (authority !== 0) return authority;
      const richness = fieldCount(b) - fieldCount(a);
      if (richness !== 0) return richness;
      return a.id < b.id ? -1 : 1;
    });
    const leader = sorted[0];
    const followers = sorted.slice(1);
    const additional = followers.map((follower) => ({
      url: follower.source_url,
      source_type: follower.source_type,
      source_name: follower.source_name,
    }));
    // AI Search 2.0: every source this vacancy was found on (primary first,
    // order of the sorted group = authority order).
    const sourceIds: string[] = [];
    for (const row of sorted) {
      const id = sourceIdOf(row);
      if (!sourceIds.includes(id)) sourceIds.push(id);
    }
    // The company's own career page is among the sources → the user can
    // apply directly with the company (officialCompanySource).
    const officialCompanySource = group.some(
      (row) => row.source_type === "company_website",
    );
    const backfilled = { ...leader };
    // Set when a follower supplies the merged email (provenance = that
    // follower's public page). The leader's own email uses leader.source_url.
    let emailSource: string | null = null;
    const setIfNull = <K extends keyof Opportunity>(
      key: K,
      value: Opportunity[K] | null,
    ) => {
      if (
        (backfilled[key] === null || backfilled[key] === undefined) &&
        value !== null &&
        value !== undefined
      )
        (backfilled as Record<K, Opportunity[K]>)[key] = value;
    };
    for (const follower of followers) {
      setIfNull("company_name", follower.company_name);
      setIfNull("company_url", follower.company_url);
      setIfNull("location", follower.location);
      if (!backfilled.location_detail && follower.location_detail)
        backfilled.location_detail = follower.location_detail;
      setIfNull("valid_from", follower.valid_from);
      setIfNull("application_deadline", follower.application_deadline);
      setIfNull("application_url", follower.application_url);
      setIfNull("education_requirement", follower.education_requirement);
      setIfNull("training_type", follower.training_type);
      setIfNull("salary", follower.salary);
      setIfNull("profession", follower.profession);
      if (
        backfilled.requirements.length === 0 &&
        follower.requirements.length > 0
      )
        backfilled.requirements = follower.requirements;
      // Contact back-fill keeps the schema shape (all three keys present)
      // and records WHERE the email came from (public page provenance).
      const mergedEmail =
        backfilled.contact?.email ?? follower.contact?.email ?? null;
      const mergedPhone =
        backfilled.contact?.phone ?? follower.contact?.phone ?? null;
      const mergedPerson = backfilled.contact?.person ?? null;
      if (
        follower.contact?.email &&
        !backfilled.contact?.email &&
        mergedEmail
      ) {
        emailSource = follower.source_url;
      }
      if (mergedEmail || mergedPhone || mergedPerson)
        backfilled.contact = {
          person: mergedPerson,
          email: mergedEmail,
          phone: mergedPhone,
        };
    }
    // Official direct apply: when a company-website source publishes its
    // own application URL (same site as the posting), it wins over an
    // aggregator URL — the user should apply with the company, not a
    // portal, whenever both exist.
    if (officialCompanySource) {
      for (const follower of followers) {
        if (
          follower.source_type !== "company_website" ||
          !follower.application_url
        )
          continue;
        const sameSite =
          hostOf(follower.application_url) === hostOf(follower.source_url);
        if (!sameSite) continue;
        if (
          !backfilled.application_url ||
          hostOf(backfilled.application_url) !== hostOf(follower.application_url)
        ) {
          // The official link wins; the aggregator link is PRESERVED
          // (never discarded) for provenance + fallback.
          if (backfilled.application_url && !backfilled.aggregator_url) {
            backfilled.aggregator_url = backfilled.application_url;
          }
          backfilled.application_url = follower.application_url;
        }
        break;
      }
    }
    // Career / Ausbildung section URLs, documented by the company's own
    // posting page (real public pages only — never constructed).
    let careerUrl: string | null = null;
    let ausbildungUrl: string | null = null;
    for (const follower of followers) {
      if (follower.source_type !== "company_website") continue;
      let path = "";
      try {
        path = new URL(follower.source_url).pathname.toLowerCase();
      } catch {
        continue;
      }
      if (!careerUrl && /(karriere|stellenang|jobs?|bewerb)/.test(path))
        careerUrl = follower.source_url;
      if (!ausbildungUrl && /(ausbildung|azubi)/.test(path))
        ausbildungUrl = follower.source_url;
    }
    // Merge-level enrichment seed (provenance for what the SOURCES already
    // documented). The company-enrichment pipeline extends this block.
    const mergeEmail = backfilled.contact?.email ?? null;
    const mergeEmailValid = normalizeOpportunityEmail(mergeEmail);
    let enrichment: Enrichment | null = null;
    if (officialCompanySource || mergeEmail) {
      enrichment = {
        website_url: null,
        website_source: null,
        career_url: careerUrl,
        ausbildung_url: ausbildungUrl,
        email: mergeEmail,
        email_source: mergeEmail ? (emailSource ?? leader.source_url) : null,
        email_status: mergeEmail
          ? mergeEmailValid
            ? "found"
            : "invalid"
          : "unknown",
        email_type: mergeEmail ? classifyEmailType(mergeEmail) : null,
        phone: backfilled.contact?.phone ?? null,
        phone_source: null,
        contact_name: backfilled.contact?.person ?? null,
        contact_source: null,
        department: null,
        last_verified_at: null,
        data_confidence: null,
        official_company_source: officialCompanySource,
      };
      // Company website URL: only a NON-aggregator company_url from a
      // source row is acceptable evidence (portal "company pages" are not
      // the company's site).
      for (const row of sorted) {
        if (row.company_url && !isAggregatorHost(row.company_url)) {
          enrichment = {
            ...enrichment,
            website_url: row.company_url,
            website_source: row.source_url,
          };
          break;
        }
      }
    }
    backfilled.additional_sources = additional.slice(0, 10);
    backfilled.source_ids = sourceIds.slice(0, 10);
    backfilled.enrichment = enrichment;
    merged.push(opportunitySchema.parse(backfilled));
  }
  return {
    merged: merged.sort((a, b) => (a.id < b.id ? -1 : 1)),
    duplicatesRemoved: all.length - merged.length,
  };
}

/** Per-source outcome of one discovery run (surfaced in stats/progress). */
export interface SourceRunStatus {
  source: string;
  status: "ok" | "degraded" | "failed" | "skipped_budget";
  candidates: number;
}

/**
 * Grounding-call budget for ONE discovery run. The shared web-search client
 * is quota-metered; every call costs a credit. Allocation: one call per
 * plain web query (the general net), then ONE call per registry source in
 * priority order until the budget is exhausted. Bounded by design —
 * enrichment below uses its own, separate budget.
 */
/** Hard cap of provider (Tavily) requests for the WHOLE search operation.
 *  The provider itself enforces the same cap; this keeps the discovery loop
 *  from even attempting more (no open loop, no per-company requests). */
const MAX_DISCOVERY_CALLS = 3;
/** Results requested per broad discovery request (Tavily returns many
 *  results per request — the pipeline filters them by relevance). */
const DISCOVERY_RESULTS_PER_REQUEST = 20;

/**
 * Safe detail of the FIRST provider error of a run (AI Search 2.2) —
 * surfaced in the UI diagnostics card so the root cause (bad key vs
 * quota vs unsupported tool vs …) is visible WITHOUT opening the Vercel
 * dashboard. Every field is provider-controlled or a numeric code —
 * never the key, never a prompt, never personal data.
 */
export interface ProviderErrorDetail {
  provider: string;
  /** Model of the failed call — a search API has none, so null. */
  model: string | null;
  /** Real HTTP status (400/401/422/429/432/433/5xx) or null (network). */
  http: number | null;
  /** Provider's numeric error code, or null. */
  code: number | null;
  /** Short provider status word (UNAUTHORIZED / RATE_LIMITED / …), or null. */
  providerStatus: string | null;
  /** Controlled key-free message (safe to display). */
  message: string;
  /** The provider's OWN error text (truncated, key-scrubbed) — the literal
   *  root cause ("Unauthorized: missing or invalid API key."), shown in the
   *  UI so no dashboard access is needed to read it. */
  providerMessage: string | null;
}

function providerErrorDetail(
  provider: string,
  error: WebSearchError,
): ProviderErrorDetail {
  const raw = error.providerMessage?.replace(/\s+/g, " ").trim() ?? "";
  return {
    provider,
    model: error.model,
    http: error.status,
    code: error.code,
    providerStatus: error.providerStatus,
    message: error.message,
    providerMessage: raw ? raw.slice(0, 300) : null,
  };
}

/**
 * Full web-discovery run: broad search → verify → extract → normalize.
 *
 * BROAD discovery (Tavily, AI Search 2.4): the plan's web queries are issued
 * as at most MAX_DISCOVERY_CALLS provider requests for the whole operation —
 * each request returns MANY results, which are classified by their OWN
 * domain (Source Registry hit → that source id + category; social host →
 * social media; other portal host → job portal; anything else → possible
 * company career page). There are no per-source and no per-company
 * requests. `categoryCounts` stay the UNIQUE page counts per bucket (what
 * the user sees); `sourceCounts` report the raw per-source hits.
 * Blocked pages are counted, never faked — a page that only yields 403s
 * shows up in `failures` and yields no opportunity.
 */
export async function runWebDiscovery(args: {
  client: WebSearchClient | null;
  webQueries: string[];
  goal: "ausbildung" | "arbeit";
  userId: string;
  onCategoryResults?: (category: SourceCategory, results: number) => void;
  onSourceResults?: (sourceId: string, results: number) => void;
  onCheckProgress?: (done: number, total: number) => void;
  onExtractProgress?: (done: number, total: number) => void;
}): Promise<{
  opportunities: Opportunity[];
  categoryCounts: Record<SourceCategory, number>;
  /** Raw candidate hits per registry source id (transparent stats). */
  sourceCounts: Record<string, number>;
  /** Per-source run status (ok/degraded/failed/skipped_budget). */
  sourceStatuses: SourceRunStatus[];
  /** Grounding calls that actually succeeded (honest usage metric —
   *  the "Google / web search" number must never count attempts). */
  groundingCallsOk: number;
  verifiedCount: number;
   aiUsed: boolean;
   providerErrors: number;
   /** Detail of the first provider error (safe — no keys), or null. */
   firstProviderError: ProviderErrorDetail | null;
   failures: Partial<Record<PageFetchFailure, number>>;
   aiDuplicates: Array<{ fromUrl: string; toUrl: string }>;
 }> {
   const { client, webQueries, goal, userId } = args;
  const categoryCounts: Record<SourceCategory, number> = {
    search_engine: 0,
    job_portal: 0,
    company_website: 0,
    social_media: 0,
  };
  if (!client || webQueries.length === 0)
    return {
      opportunities: [],
      categoryCounts,
      sourceCounts: {},
      sourceStatuses: [],
      groundingCallsOk: 0,
      verifiedCount: 0,
      aiUsed: false,
      providerErrors: 0,
      firstProviderError: null,
      failures: {},
      aiDuplicates: [],
    };
  let providerErrors = 0;
  let firstProviderError: ProviderErrorDetail | null = null;
  const collected: DiscoveredCandidate[] = [];
  const sourceCounts: Record<string, number> = {};
  const sourceStatuses: SourceRunStatus[] = [];
  // Unique pages per category (a URL found by 3 portals counts once for
  // the user-facing bucket; per-source raw hits stay in sourceCounts).
  const uniqueByCategory: Record<SourceCategory, Set<string>> = {
    search_engine: new Set(),
    job_portal: new Set(),
    company_website: new Set(),
    social_media: new Set(),
  };
  const broadQueries = webQueries
    .map((query) => query.trim())
    .filter(Boolean)
    .slice(0, MAX_DISCOVERY_CALLS);

  /** Classify ONE broad-search result by its OWN domain: a registry hit
   *  keeps that source's id + category; otherwise social hosts → social
   *  media, other portal hosts → job portal, and any remaining host is a
   *  general-web hit (the "google / web search" bucket). */
  const broadCandidate = (
    result: WebSearchResult,
    query: string,
  ): DiscoveredCandidate | null => {
    let parsed: URL;
    try {
      parsed = new URL(result.url);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:") return null;
    const domain = hostDomain(parsed.hostname);
    // Official BA results are covered by the authoritative BA pipeline.
    if (domain === "arbeitsagentur.de") return null;
    const registryId = hostToSourceId(result.url);
    const source = registryId
      ? enabledWebSources().find((entry) => entry.id === registryId)
      : undefined;
    const sourceType = classifySource(result.url, result.title);
    const category: SourceCategory = source
      ? source.category
      : sourceType === "social_media"
        ? "social_media"
        : sourceType === "job_portal"
          ? "job_portal"
          : "search_engine";
    const candidate: DiscoveredCandidate = {
      url: normalizeUrlForDedupe(result.url),
      title: result.title,
      snippet: result.snippet,
      category,
      query,
      ...(registryId ? { sourceId: registryId } : {}),
    };
    return isRelevant(candidate) ? candidate : null;
  };

  let groundingCallsOk = 0;
  // Broad discovery (Tavily): at most MAX_DISCOVERY_CALLS requests for the
  // WHOLE search operation — one request per planned web query, each
  // returning many results. No per-source and no per-company request.
  for (const query of broadQueries) {
    let results: WebSearchResult[];
    try {
      results = await client.search(query, DISCOVERY_RESULTS_PER_REQUEST);
      groundingCallsOk += 1;
    } catch (error) {
      // Provider-level failure (key rejected, quota, outage): count it and
      // keep going — other queries may still succeed, BA is unaffected.
      if (error instanceof WebSearchError && !firstProviderError)
        firstProviderError = providerErrorDetail(client.name, error);
      if (!(error instanceof WebSearchError))
        console.error("[web-search] unexpected error", error);
      providerErrors += 1;
      console.warn(
        "[WEB_DISCOVERY] broad query failed: %s",
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }
    const candidates: DiscoveredCandidate[] = [];
    const seenInQuery = new Set<string>();
    for (const result of results) {
      const candidate = broadCandidate(result, query);
      if (!candidate) continue;
      const key = normalizeUrlForDedupe(candidate.url);
      if (seenInQuery.has(key)) continue;
      seenInQuery.add(key);
      candidates.push(candidate);
    }
    console.info(
      "[WEB_DISCOVERY] broad calls=1 ok=1 results=%d candidates=%d",
      results.length,
      candidates.length,
    );
    const perQueryCategories = new Map<SourceCategory, number>();
    for (const candidate of candidates) {
      uniqueByCategory[candidate.category].add(candidate.url);
      if (candidate.sourceId)
        sourceCounts[candidate.sourceId] = (sourceCounts[candidate.sourceId] ?? 0) + 1;
      perQueryCategories.set(
        candidate.category,
        (perQueryCategories.get(candidate.category) ?? 0) + 1,
      );
    }
    collected.push(...candidates);
    for (const [category, count] of perQueryCategories)
      args.onCategoryResults?.(category, count);
  }

  // Registry-source diagnostics from the broad net: a source that surfaced
  // results reports them; a source that did not was not queried
  // individually under the request budget (discovery-only phase).
  for (const source of enabledWebSources()) {
    const count = sourceCounts[source.id] ?? 0;
    sourceStatuses.push({
      source: source.id,
      status: count > 0 ? "ok" : "skipped_budget",
      candidates: count,
    });
  }
  console.info(
    "[WEB_DISCOVERY] summary groundingCallsOk=%d providerErrors=%d collected=%d",
    groundingCallsOk,
    providerErrors,
    collected.length,
  );

  for (const category of SOURCE_CATEGORIES) {
    categoryCounts[category] = uniqueByCategory[category].size;
    args.onCategoryResults?.(category, categoryCounts[category]);
  }
  const verified = await verifyCandidates(collected, args.onCheckProgress);
  const failures: Partial<Record<PageFetchFailure, number>> = {};
  for (const item of verified) {
    if (item.failure) failures[item.failure] = (failures[item.failure] ?? 0) + 1;
  }
  const { items, aiUsed } = await extractFromPages(verified, {
    userId,
    onProgress: args.onExtractProgress,
  });
  const byUrl = new Map(verified.map((v) => [v.candidate.url, v]));
  const aiDuplicates: Array<{ fromUrl: string; toUrl: string }> = [];
  const opportunities: Opportunity[] = [];
  for (const item of items) {
    const verifiedItem =
      byUrl.get(normalizeUrlForDedupe(item.url)) ??
      byUrl.get(item.url);
    if (!verifiedItem) continue;
    if (item.duplicate_of_url)
      aiDuplicates.push({
        fromUrl: item.url,
        toUrl: item.duplicate_of_url,
      });
    opportunities.push(toOpportunity(item, verifiedItem, goal));
  }
  return {
    opportunities,
    categoryCounts,
    sourceCounts,
    sourceStatuses,
    groundingCallsOk,
    verifiedCount: verified.length,
    aiUsed,
    providerErrors,
    firstProviderError,
    failures,
    aiDuplicates,
  };
}
