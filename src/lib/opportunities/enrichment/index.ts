import "server-only";

import { ConcurrencyLimiter } from "@/lib/concurrency";
import { type RobotsPolicy } from "@/lib/web-search/fetch-page";
import { type WebSearchClient } from "@/lib/web-search";
import { hostOf, normalizeIdentity } from "../web-discovery";
import {
  opportunitySchema,
  type Enrichment,
  type Opportunity,
} from "../types";
import { opportunityEmail } from "../email-export";
import {
  companyKeyOf,
  readCompanyCache,
  writeCompanyCache,
  type CompanyEnrichmentRecord,
} from "./cache";
import {
  discoverCompanyWebsite,
  fetchCompanyPages,
} from "./company-site";
import { isAllowedCompanyDomain } from "../sources";
import {
  findContactSeed,
  pickCompanyEmail,
  type CompanyContactSeed,
  type ContactEmail,
} from "../company-contact";
import {
  bestEmail,
  classifyEmailType,
  extractContactPerson,
  extractDepartment,
  extractPhone,
  maxConfidence,
  pageKindConfidence,
  POSTING_PAGE_CONFIDENCE,
} from "./text-extract";

/**
 * Company enrichment pipeline (AI Search 2.0).
 *
 * JOB DISCOVERY is separate from COMPANY ENRICHMENT, CONTACT DISCOVERY and
 * EMAIL VERIFICATION — a vacancy is never lost because its source lacked
 * an email. For every merged opportunity this stage runs:
 *
 *   JOB RESULT
 *      ↓ COMPANY IDENTIFICATION        (source-documented company_name only)
 *      ↓ COMPANY WEBSITE DISCOVERY     (documented URL, else guarded index
 *                                       search + content verification)
 *      ↓ CAREER / AUSBILDUNG PAGE      (standard public paths)
 *      ↓ CONTACT DISCOVERY             (deterministic extraction only)
 *      ↓ EMAIL EXTRACTION              (never generated from the name)
 *      ↓ VERIFICATION                  (structural; "verified" requires an
 *                                       SMTP check this app does NOT run)
 *      ↓ FINAL RESULT                  (facts + provenance URLs)
 *
 * Invariants:
 * - nothing is invented: every value comes from fetched public text;
 * - existing source data is NEVER overwritten, only nulls are filled;
 * - every fact carries the URL it was read from (email_source, …);
 * - emailStatus "verified" is reserved for real SMTP verification and is
 *   never emitted by the current code;
 * - budgets: ≤ MAX_COMPANIES_PER_RUN companies, ≤ 4 pages/company,
 *   bounded concurrency, backoff on transient failures only.
 */

/** Companies enriched per run (each company = up to 4 guarded page fetches). */
export const MAX_COMPANIES_PER_RUN = 12;
const COMPANY_CONCURRENCY = 2;
const PAGE_CONCURRENCY = 4;
/** Website discovery consumes at most this many grounding calls per run. */
const MAX_WEBSITE_DISCOVERY_CALLS = 4;

export type { CompanyEnrichmentRecord };

/**
 * Apply one company's enrichment result to a single opportunity. PURE —
 * the same rule the pipeline uses, unit-testable in isolation.
 *
 * Back-fill (never overwrite):
 * - contact.email / contact.phone / contact.person: only when the row has
 *   no value yet (the SOURCE's own contact data always wins);
 * - company_url: only when null (and only for a non-aggregator website);
 * - enrichment block: merged with the merge-seeded provenance.
 */
export function applyCompanyEnrichment(
  row: Opportunity,
  company: CompanyEnrichmentRecord,
): Opportunity {
  const existing = row.enrichment;
  const contact = row.contact ?? { person: null, email: null, phone: null };
  const email = contact.email ?? company.email ?? null;
  const phone = contact.phone ?? company.phone ?? null;
  const person = contact.person ?? company.contact_name ?? null;
  const companyUrl =
    row.company_url ??
    (company.website_url && isAllowedCompanyDomain(company.website_url)
      ? company.website_url
      : null);

  // Email status — strict semantics (see EmailStatus in types.ts):
  const emailValid =
    email === null ? null : opportunityEmail({ contact: { person, email, phone } }) !== null;
  let emailStatus: Enrichment["email_status"];
  if (email === null) {
    emailStatus = company.checked ? "not_found" : (existing?.email_status ?? "unknown");
  } else if (emailValid === false) {
    emailStatus = "invalid";
  } else if (existing?.email_status === "found" || existing?.email_status === "verified") {
    emailStatus = existing.email_status; // documented by the source itself
  } else {
    emailStatus = "found"; // found on a public page (company site)
  }

  // Provenance for the email the USER sees (contact.email after back-fill):
  let emailSource: string | null = existing?.email_source ?? null;
  if (email !== null && emailSource === null) {
    if (contact.email) emailSource = row.source_url; // source-documented
    else if (company.email) emailSource = company.email_source;
  }

  const enrichment: Enrichment = {
    website_url: existing?.website_url ?? company.website_url ?? null,
    website_source: existing?.website_source ?? company.website_source ?? null,
    career_url: existing?.career_url ?? company.career_url ?? null,
    ausbildung_url: existing?.ausbildung_url ?? company.ausbildung_url ?? null,
    email,
    email_source: emailSource,
    email_status: emailStatus,
    email_type:
      email === null
        ? null
        : existing?.email_type ?? company.email_type ?? classifyEmailType(email),
    phone,
    phone_source:
      (contact.phone ? row.source_url : null) ??
      company.phone_source ??
      null,
    contact_name: person,
    contact_source:
      (contact.person ? row.source_url : null) ??
      company.contact_source ??
      null,
    department: existing?.department ?? company.department ?? null,
    last_verified_at:
      existing?.last_verified_at ?? company.last_verified_at ?? null,
    data_confidence: maxConfidence(
      existing?.data_confidence ?? null,
      company.data_confidence,
    ),
    official_company_source: existing?.official_company_source ?? false,
  };

  // An application page on the company's own domain (extracted during
  // enrichment) becomes the row's official application link when the row has
  // none — never a guessed URL.
  const officialApplyPage = company.career_url ?? existing?.career_url ?? null;
  const applicationUrl =
    row.application_url ??
    (officialApplyPage && isAllowedCompanyDomain(officialApplyPage)
      ? officialApplyPage
      : null);

  return opportunitySchema.parse({
    ...row,
    contact: email || phone || person ? { person, email, phone } : null,
    company_url: companyUrl,
    application_url: applicationUrl,
    enrichment,
  });
}

/** Honest run telemetry for UI stats + logs. Filled in-place; absent
 *  args.telemetry → the pipeline runs exactly as before (tests). */
export interface EnrichmentTelemetry {
  /** Companies actually processed (checked or cache-hit). */
  companiesEnriched: number;
  /** Grounding searches actually EXECUTED for website discovery. */
  webSearchesExecuted: number;
  /** Distinct companies with a real public email after enrichment. */
  companiesWithEmail: number;
  /** Guarded page fetches performed (budget visibility). */
  pagesFetched: number;
}

/**
 * Run the enrichment stage over the RANKED opportunities (AI Search 2.1:
 * the budget goes to the rows the user actually sees — dedupe → rank →
 * enrich top companies — instead of every raw row).
 *
 * - Groups rows by company key (rows without a documented company_name
 *   are skipped — identifying the company is a precondition, not a guess).
 * - Companies are processed most-vacancies-first, capped at
 *   MAX_COMPANIES_PER_RUN (12); the rest keep their merge provenance.
 * - Cache-first (memory → DB): a cached company costs zero fetches.
 * - NEVER throws: every per-company failure is contained and counted.
 */
export async function runCompanyEnrichment(
  opportunities: Opportunity[],
  args: {
    client: WebSearchClient | null;
    /** Contact data the discovery already read from the provider response —
     *  reused here so the official website and any published address are
     *  applied WITHOUT an extra provider request per company. */
    contactSeeds?: CompanyContactSeed[];
    onProgress?: (done: number, total: number) => void;
    /** Optional telemetry sink (UI stats + [COMPANY_ENRICHMENT] log). */
    telemetry?: EnrichmentTelemetry;
  },
): Promise<Opportunity[]> {
  if (opportunities.length === 0) return opportunities;

  // Group by company (documented name only — no identification guesses).
  const byCompany = new Map<string, Opportunity[]>();
  for (const row of opportunities) {
    if (!row.company_name) continue;
    const key = companyKeyOf(row.company_name);
    if (!key) continue;
    const list = byCompany.get(key);
    if (list) list.push(row);
    else byCompany.set(key, [row]);
  }
  const companies = [...byCompany.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_COMPANIES_PER_RUN);
  const total = companies.length;
  if (total === 0) return opportunities;

  const robotsCache = new Map<string, RobotsPolicy>();
  const pageLimiter = new ConcurrencyLimiter(PAGE_CONCURRENCY);
  let discoveryCallsLeft = MAX_WEBSITE_DISCOVERY_CALLS;
  let done = 0;
  let totalWebSearches = 0;
  let totalPagesFetched = 0;

  const results = new Map<string, CompanyEnrichmentRecord>();
  for (let start = 0; start < total; start += COMPANY_CONCURRENCY) {
    const batch = companies.slice(start, start + COMPANY_CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async ([key, rows]) => {
        try {
          const cached = await readCompanyCache(key);
          if (cached) return { key, record: cached, webSearches: 0, pagesFetched: 0 };
          const outcome = await enrichOneCompany({
            key,
            companyName: rows[0].company_name as string,
            city: rows.find((row) => row.location_detail?.city)
              ?.location_detail?.city ?? null,
            rows,
            client: args.client,
            contactSeeds: args.contactSeeds ?? [],
            robotsCache,
            pageLimiter,
            consumeDiscoveryCall: () => {
              if (discoveryCallsLeft <= 0) return false;
              discoveryCallsLeft -= 1;
              return true;
            },
          });
          await writeCompanyCache(outcome.record);
          return { key, ...outcome };
        } catch (error) {
          // Contained: one company's failure must not kill the run.
          console.warn(
            "[enrichment] company failed",
            error instanceof Error ? error.message : String(error),
          );
          return {
            key,
            record: failedRecord(key, rows[0].company_name as string),
            webSearches: 0,
            pagesFetched: 0,
          };
        } finally {
          done += 1;
          args.onProgress?.(done, total);
        }
      }),
    );
    for (const item of settled) {
      results.set(item.key, item.record);
      totalWebSearches += item.webSearches;
      totalPagesFetched += item.pagesFetched;
    }
  }

  const companiesWithEmail = new Set(
    opportunities
      .filter((row) => row.contact?.email && row.company_name)
      .map((row) => companyKeyOf(row.company_name)),
  ).size;
  console.info(
    "[COMPANY_ENRICHMENT] companies=%d websites=%d publicEmails=%d webSearches=%d pagesFetched=%d",
    total,
    [...results.values()].filter((record) => record.website_url).length,
    companiesWithEmail,
    totalWebSearches,
    totalPagesFetched,
  );
  if (args.telemetry) {
    args.telemetry.companiesEnriched = total;
    args.telemetry.webSearchesExecuted = totalWebSearches;
    args.telemetry.companiesWithEmail = companiesWithEmail;
    args.telemetry.pagesFetched = totalPagesFetched;
  }

  return opportunities.map((row) => {
    if (!row.company_name) return row;
    const key = companyKeyOf(row.company_name);
    const record = results.get(key);
    if (!record) return row;
    return applyCompanyEnrichment(row, record);
  });
}

function failedRecord(key: string, companyName: string): CompanyEnrichmentRecord {
  // checked=false: the checks could not run — status stays "unknown",
  // never a false "not_found".
  return {
    company_key: key,
    company_name: companyName,
    checked: false,
    website_url: null,
    website_source: null,
    career_url: null,
    ausbildung_url: null,
    email: null,
    email_source: null,
    email_type: null,
    phone: null,
    phone_source: null,
    contact_name: null,
    contact_source: null,
    department: null,
    data_confidence: null,
    last_verified_at: null,
  };
}

async function enrichOneCompany(args: {
  key: string;
  companyName: string;
  city: string | null;
  rows: Opportunity[];
  client: WebSearchClient | null;
  /** Contact data the discovery already read from the provider response
   *  (candidate website + published addresses) — used WITHOUT any extra
   *  provider request. */
  contactSeeds: CompanyContactSeed[];
  robotsCache: Map<string, RobotsPolicy>;
  pageLimiter: ConcurrencyLimiter;
  consumeDiscoveryCall: () => boolean;
}): Promise<{
  record: CompanyEnrichmentRecord;
  webSearches: number;
  pagesFetched: number;
}> {
  const {
    key,
    companyName,
    city,
    rows,
    client,
    contactSeeds,
    robotsCache,
    pageLimiter,
  } = args;
  const base: CompanyEnrichmentRecord = {
    company_key: key,
    company_name: companyName,
    checked: true,
    website_url: null,
    website_source: null,
    career_url: null,
    ausbildung_url: null,
    email: null,
    email_source: null,
    email_type: null,
    phone: null,
    phone_source: null,
    contact_name: null,
    contact_source: null,
    department: null,
    data_confidence: null,
    last_verified_at: new Date().toISOString(),
  };
  let webSearches = 0;
  let pagesFetched = 0;

  // ---- COMPANY WEBSITE DISCOVERY -------------------------------------
  // 1) A source row already documents a company URL that is allowed to be
  //    the company's own site (blocklist: portals, reviews, directories,
  //    public-employer portals).
  const documented = rows.find((row) =>
    row.company_url ? isAllowedCompanyDomain(row.company_url) : false,
  );
  let websiteUrl: string | null = null;
  /** Addresses the provider response already published for this company. */
  let seededEmails: ContactEmail[] = [];
  // The page an opportunity was extracted FROM is first-hand evidence: it was
  // fetched through the guards and the company name was read out of it. Its
  // origin is therefore the company's own domain — unless the host is a
  // portal/review/social/public-employer domain, which isAllowedCompanyDomain
  // already excludes (so a portal row can never become a "company website").
  /** Requirement: a company page URL (…/karriere/ausbildung/…) yields the
   *  company's ROOT domain as the official website. */
  const allowedOrigin = (url: string | null | undefined): string | null => {
    if (!url || !isAllowedCompanyDomain(url)) return null;
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  };

  const selfEvidence = (() => {
    for (const row of rows) {
      // Only a row the pipeline ALREADY classified as a page on a company's
      // own website qualifies (BA rows are official_source, portal rows are
      // job_portal) — so a portal or aggregator can never become a website.
      if (row.source_type !== "company_website") continue;
      const candidate = row.company_url ?? row.source_url;
      if (!candidate || !isAllowedCompanyDomain(candidate)) continue;
      try {
        return { origin: new URL(candidate).origin, sourceUrl: candidate };
      } catch {
        // keep looking
      }
    }
    return null;
  })();

  if (documented?.company_url) {
    websiteUrl = allowedOrigin(documented.company_url) ?? documented.company_url;
    base.website_url = websiteUrl;
    // Evidence = the public page that documented the URL.
    base.website_source = documented.source_url;
  } else if (selfEvidence) {
    websiteUrl = selfEvidence.origin;
    base.website_url = websiteUrl;
    base.website_source = selfEvidence.sourceUrl;
  } else {
    // 2) Contact seed from the provider response (no extra request): a
    //    company/career/contact page that names this company.
    const sourceHosts = new Set(
      rows
        .map((row) => row.source_url)
        .filter((url): url is string => Boolean(url))
        .map((url) => {
          try {
            return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
          } catch {
            return "";
          }
        })
        .filter(Boolean),
    );
    const seed = findContactSeed(
      companyName,
      contactSeeds,
      documented?.company_url,
      sourceHosts,
    );
    if (seed) {
      seededEmails = seed.emails;
      if (seed.websiteUrl) {
        websiteUrl = seed.websiteUrl;
        base.website_url = seed.websiteUrl;
        base.website_source = seed.sourceUrl;
      }
    }
  }
  if (!websiteUrl && client) {
    // 3) Guarded provider discovery (1-2 calls) + content verification
    //    (never a guessed domain).
    const discovered = await discoverCompanyWebsite(
      companyName,
      city,
      client,
      robotsCache,
      pageLimiter,
    );
    webSearches += discovered?.searched ?? 0;
    if (discovered) {
      websiteUrl = discovered.url;
      base.website_url = discovered.url;
      base.website_source = discovered.evidenceUrl;
    }
  }
  if (!websiteUrl)
    return { record: base, webSearches, pagesFetched }; // honest nulls

  // ---- CAREER / AUSBILDUNG PAGE + CONTACT DISCOVERY -------------------
  const { pages } = await fetchCompanyPages(websiteUrl, robotsCache, pageLimiter);
  pagesFetched += pages.length;
  const companyDomain = hostOf(websiteUrl);
  // Email: highest page-authority wins (impressum > kontakt > karriere >
  // home); within equal authority the first page in fetch order wins.
  let bestEmailRank = -1;

  for (const page of pages) {
    const confidence = pageKindConfidence(page.kind);
    if (
      page.kind === "karriere" &&
      !base.career_url &&
      hostOf(page.url) === companyDomain
    )
      base.career_url = page.url;
    if (
      page.kind === "ausbildung" &&
      !base.ausbildung_url &&
      hostOf(page.url) === companyDomain
    )
      base.ausbildung_url = page.url;

    const email = bestEmail(page.text, { companyDomain });
    if (email) {
      const rank = pageKindRank(page.kind);
      if (rank > bestEmailRank) {
        bestEmailRank = rank;
        base.email = email;
        base.email_type = classifyEmailType(email);
        base.email_source = page.url;
        base.data_confidence = maxConfidence(base.data_confidence, confidence);
      }
    }
    // Department: first page that documents one.
    if (!base.department) {
      const department = extractDepartment(page.text);
      if (department) base.department = department;
    }

    // Phone + contact person: first page that documents one (fetch order
    // is already authority-ordered: impressum, kontakt, career pages).
    if (!base.phone) {
      const phone = extractPhone(page.text);
      if (phone) {
        base.phone = phone;
        base.phone_source = page.url;
        base.data_confidence = maxConfidence(base.data_confidence, confidence);
      }
    }
    if (!base.contact_name) {
      const person = extractContactPerson(page.text);
      if (person) {
        base.contact_name = person;
        base.contact_source = page.url;
        base.data_confidence = maxConfidence(base.data_confidence, confidence);
      }
    }
  }

  // A career/application page on the company's OWN domain is a real official
  // application link (extracted, never assumed).
  if (!base.career_url) {
    const applyPage = pages.find(
      (page) =>
        hostOf(page.url) === companyDomain &&
        (/bewerbung/i.test(page.url) ||
          (page.kind === "karriere" && /bewerb/i.test(page.text.slice(0, 4000)))),
    );
    const careerPage =
      applyPage ??
      pages.find(
        (page) => hostOf(page.url) === companyDomain && page.kind === "karriere",
      );
    if (careerPage) base.career_url = careerPage.url;
  }

  // Safe per-company diagnostics: names/domains/booleans only — never an API
  // key, never an email address, never personal data.
  console.info(
    "[COMPANY_ENRICHMENT] company=%s domain=%s website=%s pages=%d email=%s applyLink=%s",
    companyName.slice(0, 60),
    companyDomain || "n/a",
    websiteUrl ? "ok" : "none",
    pages.length,
    base.email ? "yes" : "no",
    base.career_url ? "yes" : "no",
  );

  // No company page yielded an address, but the provider response may have
  // published one (title/snippet/content) — attributed and ranked by the
  // deterministic contact rules, never invented.
  if (!base.email && seededEmails.length > 0) {
    const pick = pickCompanyEmail(
      seededEmails.filter((entry) => entry.confidence !== "low"),
    );
    if (pick) {
      base.email = pick.email;
      base.email_type = classifyEmailType(pick.email);
      base.email_source = pick.sourceUrl;
      base.data_confidence = maxConfidence(base.data_confidence, "medium");
    }
  }

  // No company page yielded an email, but the row's own posting data may
  // already carry one (level-1: BA descriptions / posting pages are public
  // pages). Provenance: the merge stage recorded WHICH public page
  // documented the email (enrichment.email_source) — fall back to the row's
  // own source URL only when no seed exists.
  if (!base.email) {
    for (const row of rows) {
      const postingEmail = row.contact?.email ?? null;
      if (postingEmail) {
        base.email = postingEmail;
        base.email_type = classifyEmailType(postingEmail);
        base.email_source = row.enrichment?.email_source ?? row.source_url;
        base.data_confidence = maxConfidence(
          base.data_confidence,
          POSTING_PAGE_CONFIDENCE,
        );
        break;
      }
    }
  }
  return { record: base, webSearches, pagesFetched };
}

/** Page kind → extraction priority (impressum first). */
function pageKindRank(
  kind: "impressum" | "kontakt" | "karriere" | "ausbildung" | "home" | "other",
): number {
  switch (kind) {
    case "impressum":
      return 4;
    case "kontakt":
      return 3;
    case "karriere":
      return 2;
    case "ausbildung":
      return 2;
    case "home":
      return 1;
    default:
      return 0;
  }
}
// ---------------------------------------------------------------------------
// Result statistics (honest counters for the UI + export)
// ---------------------------------------------------------------------------

export interface AiSearchStats {
  /** Final deduplicated opportunities. */
  found: number;
  /** Rows whose SOURCES (or company-site enrichment) published a valid,
   *  non-placeholder email — the same rule the export uses. */
  withPublicEmail: number;
  /** Rows with a usable application URL. */
  withApplicationUrl: number;
  /** Rows where the company's own career page is one of the sources. */
  withOfficialSource: number;
  /** Registry sources actually queried this run (discovery budget spent). */
  sourcesSearched: number;
  /** Of those, sources that returned at least one candidate. */
  sourcesWithResults: number;
  /** Grounding searches actually EXECUTED (website + contact discovery) —
   *  never counted per attempt, only per successful call. */
  webSearchesExecuted: number;
  /** Companies whose enrichment actually ran (checked or cache-hit). */
  companiesEnriched: number;
  /** Distinct companies with a real public email after enrichment. */
  companiesWithPublicEmail: number;
  /** Rows where the OFFICIAL company website was found (enrichment). */
  officialWebsitesFound: number;
  /** Rows where the official application URL is available. */
  officialApplicationLinks: number;
}

export function computeResultStats(
  opportunities: Opportunity[],
  context: {
    sourcesSearched?: number;
    sourcesWithResults?: number;
    webSearchesExecuted?: number;
    companiesEnriched?: number;
    companiesWithPublicEmail?: number;
  } = {},
): AiSearchStats {
  let withPublicEmail = 0;
  let withApplicationUrl = 0;
  let withOfficialSource = 0;
  let officialWebsitesFound = 0;
  let officialApplicationLinks = 0;
  const companiesWithEmail = new Set<string>();
  for (const row of opportunities) {
    if (opportunityEmail(row) !== null) withPublicEmail += 1;
    if (row.application_url) withApplicationUrl += 1;
    const official =
      row.enrichment?.official_company_source === true ||
      row.source_type === "company_website";
    if (official) withOfficialSource += 1;
    if (row.enrichment?.website_url) officialWebsitesFound += 1;
    if (official && row.application_url) officialApplicationLinks += 1;
    if (
      row.company_name &&
      row.contact?.email &&
      opportunityEmail(row) !== null
    ) {
      companiesWithEmail.add(normalizeIdentity(row.company_name));
    }
  }
  return {
    found: opportunities.length,
    withPublicEmail,
    withApplicationUrl,
    withOfficialSource,
    sourcesSearched: context.sourcesSearched ?? 0,
    sourcesWithResults: context.sourcesWithResults ?? 0,
    webSearchesExecuted: context.webSearchesExecuted ?? 0,
    companiesEnriched: context.companiesEnriched ?? 0,
    companiesWithPublicEmail:
      context.companiesWithPublicEmail ?? companiesWithEmail.size,
    officialWebsitesFound,
    officialApplicationLinks,
  };
}
