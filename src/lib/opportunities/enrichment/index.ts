import "server-only";

import { ConcurrencyLimiter } from "@/lib/concurrency";
import { type RobotsPolicy } from "@/lib/web-search/fetch-page";
import { type WebSearchClient } from "@/lib/web-search";
import { isAggregatorHost, hostOf } from "../web-discovery";
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
import {
  bestEmail,
  extractContactPerson,
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
    (company.website_url && !isAggregatorHost(company.website_url)
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
    last_verified_at:
      existing?.last_verified_at ?? company.last_verified_at ?? null,
    data_confidence: maxConfidence(
      existing?.data_confidence ?? null,
      company.data_confidence,
    ),
    official_company_source: existing?.official_company_source ?? false,
  };

  return opportunitySchema.parse({
    ...row,
    contact: email || phone || person ? { person, email, phone } : null,
    company_url: companyUrl,
    enrichment,
  });
}

/**
 * Run the enrichment stage over merged opportunities.
 *
 * - Groups rows by company key (rows without a documented company_name
 *   are skipped — identifying the company is a precondition, not a guess).
 * - Companies are processed most-vacancies-first, capped at
 *   MAX_COMPANIES_PER_RUN; the rest keep their merge-level provenance.
 * - Cache-first (memory → DB): a cached company costs zero fetches.
 * - NEVER throws: every per-company failure is contained and counted.
 */
export async function runCompanyEnrichment(
  opportunities: Opportunity[],
  args: {
    client: WebSearchClient | null;
    onProgress?: (done: number, total: number) => void;
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

  const results = new Map<string, CompanyEnrichmentRecord>();
  for (let start = 0; start < total; start += COMPANY_CONCURRENCY) {
    const batch = companies.slice(start, start + COMPANY_CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async ([key, rows]) => {
        try {
          const cached = await readCompanyCache(key);
          if (cached) return { key, record: cached };
          const record = await enrichOneCompany({
            key,
            companyName: rows[0].company_name as string,
            rows,
            client: args.client,
            robotsCache,
            pageLimiter,
            consumeDiscoveryCall: () => {
              if (discoveryCallsLeft <= 0) return false;
              discoveryCallsLeft -= 1;
              return true;
            },
          });
          await writeCompanyCache(record);
          return { key, record };
        } catch (error) {
          // Contained: one company's failure must not kill the run.
          console.warn(
            "[enrichment] company failed",
            error instanceof Error ? error.message : String(error),
          );
          return {
            key,
            record: failedRecord(key, rows[0].company_name as string),
          };
        } finally {
          done += 1;
          args.onProgress?.(done, total);
        }
      }),
    );
    for (const item of settled) results.set(item.key, item.record);
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
    phone: null,
    phone_source: null,
    contact_name: null,
    contact_source: null,
    data_confidence: null,
    last_verified_at: null,
  };
}

async function enrichOneCompany(args: {
  key: string;
  companyName: string;
  rows: Opportunity[];
  client: WebSearchClient | null;
  robotsCache: Map<string, RobotsPolicy>;
  pageLimiter: ConcurrencyLimiter;
  consumeDiscoveryCall: () => boolean;
}): Promise<CompanyEnrichmentRecord> {
  const { key, companyName, rows, client, robotsCache, pageLimiter } = args;
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
    phone: null,
    phone_source: null,
    contact_name: null,
    contact_source: null,
    data_confidence: null,
    last_verified_at: new Date().toISOString(),
  };

  // ---- COMPANY WEBSITE DISCOVERY -------------------------------------
  // 1) A source row already documents a non-aggregator company URL.
  const documented = rows.find((row) =>
    row.company_url ? !isAggregatorHost(row.company_url) : false,
  );
  let websiteUrl: string | null = null;
  if (documented?.company_url) {
    websiteUrl = documented.company_url;
    base.website_url = websiteUrl;
    // Evidence = the public page that documented the URL.
    base.website_source = documented.source_url;
  } else if (client && args.consumeDiscoveryCall()) {
    // 2) Guarded index search + content verification (never guessed).
    const discovered = await discoverCompanyWebsite(
      companyName,
      client,
      robotsCache,
      pageLimiter,
    );
    if (discovered) {
      websiteUrl = discovered.url;
      base.website_url = discovered.url;
      base.website_source = discovered.evidenceUrl;
    }
  }
  if (!websiteUrl) return base; // nothing to visit — honest nulls

  // ---- CAREER / AUSBILDUNG PAGE + CONTACT DISCOVERY -------------------
  const { pages } = await fetchCompanyPages(websiteUrl, robotsCache, pageLimiter);
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
        base.email_source = page.url;
        base.data_confidence = maxConfidence(base.data_confidence, confidence);
      }
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
        base.email_source = row.enrichment?.email_source ?? row.source_url;
        base.data_confidence = maxConfidence(
          base.data_confidence,
          POSTING_PAGE_CONFIDENCE,
        );
        break;
      }
    }
  }
  return base;
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
}

export function computeResultStats(opportunities: Opportunity[]): AiSearchStats {
  let withPublicEmail = 0;
  let withApplicationUrl = 0;
  let withOfficialSource = 0;
  for (const row of opportunities) {
    if (opportunityEmail(row) !== null) withPublicEmail += 1;
    if (row.application_url) withApplicationUrl += 1;
    if (
      row.enrichment?.official_company_source === true ||
      row.source_type === "company_website"
    )
      withOfficialSource += 1;
  }
  return {
    found: opportunities.length,
    withPublicEmail,
    withApplicationUrl,
    withOfficialSource,
  };
}
