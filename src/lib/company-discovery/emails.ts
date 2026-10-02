import "server-only";

import {
  emailsFromPageText,
  isFreeMailDomain,
  roleOfLocalPart,
} from "@/lib/opportunities/company-contact";
import { emailDedupeKey, normalizeOpportunityEmail } from "@/lib/opportunities/email-export";
import type { Opportunity } from "@/lib/opportunities/types";
import type { DiscoveryEmailSource } from "./types";

/**
 * Public-email discovery for Company Discovery.
 *
 * Hard rule: an address is only ever reported when it was ACTUALLY PUBLISHED —
 * either in the source's own offer contact block or on a page of the company's
 * official website. Nothing is derived from the company name, nothing is
 * guessed (`info@company.de` is NEVER produced), and a failed or blocked fetch
 * yields "no public email found" instead of a fabricated address.
 *
 * Sources, in the order they are used:
 *   1. `offer`            — the contact address the source itself published in
 *                           the offer description (`opportunity.contact.email`,
 *                           normalized by the shared rules that already reject
 *                           placeholders like "keine Angabe").
 *   2. `impressum` / `kontakt` / `karriere` / `ausbildung` / `company_website`
 *                           — addresses read verbatim from the fetched pages
 *                           of the company's own domain, attributably to that
 *                           company, and ONLY when the page domain matches the
 *                           address domain (no third-party address is presented
 *                           as the company's).
 *
 * Which website is fetched is itself evidence-based: the URL comes from the
 * engine's verified enrichment (`opportunity.enrichment.website_url`) or from
 * the domain of an address the employer published — never from a name guess.
 */

/** Maximum pages fetched per company (root + contact/career pages). */
export const MAX_EMAIL_PAGES_PER_COMPANY = 3;

export type PublicEmailConfidence = "high" | "medium" | "low";

/** One address with the provenance the database stores. */
export interface PublicEmailResolution {
  email: string;
  /** The exact public page the address was read from (null for offer rows). */
  sourceUrl: string | null;
  sourceType: DiscoveryEmailSource;
  confidence: PublicEmailConfidence;
  /** True when the official-site pass actually ran for this company. */
  fetchedSite: boolean;
}

/** A page of the company's site, reduced to what extraction needs. */
export interface CompanySiteTextPage {
  url: string;
  kind: string;
  text: string;
}

/**
 * Fetches the public pages of a company website (guarded: robots, SSRF,
 * anti-bot, bounded). Injected so the extraction rules are testable without
 * touching the network; the default implementation is the real guarded
 * fetcher used by the enrichment layers.
 */
export type CompanySitePagesFetcher = (
  websiteUrl: string,
) => Promise<CompanySiteTextPage[]>;

/** Real fetcher: the SAME guarded, bounded page stack the enrichment uses. */
export const fetchCompanySiteTextPages: CompanySitePagesFetcher = async (
  websiteUrl,
) => {
  const [{ fetchCompanyPages }, { ConcurrencyLimiter }] = await Promise.all([
    import("@/lib/opportunities/enrichment/company-site"),
    import("@/lib/concurrency"),
  ]);
  const { pages } = await fetchCompanyPages(
    websiteUrl,
    new Map(),
    new ConcurrencyLimiter(2),
  );
  return pages.map((page) => ({
    url: page.url,
    kind: page.kind,
    text: page.text,
  }));
};

/** Page kind → the provenance value stored with the address. */
const SOURCE_BY_PAGE_KIND: Record<string, DiscoveryEmailSource> = {
  impressum: "impressum",
  kontakt: "kontakt",
  karriere: "karriere",
  ausbildung: "ausbildung",
  bewerbungen: "bewerbungen",
};

const CONFIDENCE_RANK: Record<PublicEmailConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * The address the source published in the offer itself. This is the same
 * normalization the AI-Search export uses, so "keine Angabe", "n/a" and
 * malformed values can never leak into a result.
 */
export function offerEmailCandidate(
  offer: Pick<Opportunity, "contact" | "source_url">,
): PublicEmailResolution | null {
  const email = normalizeOpportunityEmail(offer.contact?.email ?? null);
  if (!email) return null;
  return {
    email,
    sourceUrl: null,
    sourceType: "offer",
    confidence: "medium",
    fetchedSite: false,
  };
}

/**
 * An address the shared engine already read from a PUBLIC page during
 * enrichment (`opportunity.enrichment.email`, never generated). It carries the
 * page it was read from as evidence.
 */
export function enrichedEmailCandidate(
  offer: Pick<Opportunity, "enrichment">,
): PublicEmailResolution | null {
  const email = normalizeOpportunityEmail(offer.enrichment?.email ?? null);
  if (!email) return null;
  return {
    email,
    sourceUrl: offer.enrichment?.website_source ?? null,
    sourceType: "search_result",
    confidence: "medium",
    fetchedSite: false,
  };
}

/**
 * A website worth checking, derived from an address the EMPLOYER published —
 * never from the company name. Free mail providers are not a company site.
 */
export function companyWebsiteFromPublishedEmail(
  email: string | null | undefined,
): string | null {
  if (!email) return null;
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain || !domain.includes(".") || isFreeMailDomain(domain)) return null;
  if (!/^[a-z0-9.-]+$/.test(domain)) return null;
  return `https://${domain}`;
}

/**
 * Addresses found on the company's OWN pages: only same-domain addresses are
 * kept (an address printed on the company's site under a different domain is
 * not this company's contact), deduped by address with the strongest
 * confidence kept.
 */
export function websiteEmailCandidates(input: {
  pages: CompanySiteTextPage[];
  companyName: string;
}): PublicEmailResolution[] {
  const byEmail = new Map<string, PublicEmailResolution>();
  for (const page of input.pages) {
    const found = emailsFromPageText({
      text: page.text,
      sourceUrl: page.url,
      companyName: input.companyName,
    });
    for (const entry of found) {
      if (!entry.sameDomain) continue;
      const key = emailDedupeKey(entry.email);
      const sourceType = SOURCE_BY_PAGE_KIND[page.kind] ?? "company_website";
      // A role mailbox on the company's own contact/career page is the
      // strongest signal there is; anything else on the site is medium.
      const confidence: PublicEmailConfidence =
        roleOfLocalPart(entry.email.split("@")[0] ?? "") === "application" &&
        sourceType !== "company_website"
          ? "high"
          : "medium";
      const candidate: PublicEmailResolution = {
        email: entry.email,
        sourceUrl: entry.sourceUrl,
        sourceType,
        confidence,
        fetchedSite: true,
      };
      const existing = byEmail.get(key);
      if (!existing || CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[existing.confidence])
        byEmail.set(key, candidate);
    }
  }
  return [...byEmail.values()];
}

/**
 * Deterministic priority pick (mirrors the shared email rules):
 *   1. application/career mailbox (bewerbung@, karriere@, ausbildung@, jobs@)
 *   2. general company mailbox (info@, kontakt@, mail@ …)
 *   3. any other address on the company's own domain
 * Ties break on confidence, then in favour of the company's own page over the
 * offer text.
 */
export function pickPublicEmail(
  candidates: PublicEmailResolution[],
): PublicEmailResolution | null {
  let best: PublicEmailResolution | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const role = roleOfLocalPart(candidate.email.split("@")[0] ?? "");
    let score = role === "application" ? 60 : role === "general" ? 40 : 20;
    score += CONFIDENCE_RANK[candidate.confidence];
    if (candidate.sourceType === "offer") score -= 1;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/**
 * The counting rule behind `onlyPublicEmail`:
 *   true  → only companies with a PUBLISHED address are results, so a run may
 *           honestly end PARTIAL (4 of 10) instead of padding the list;
 *   false → companies without an address are results too, and the UI states
 *           "No public email found" for them.
 * A missing address never silently removes a company when the user asked for
 * all of them.
 */
export function countsAsResult(input: {
  onlyPublicEmail: boolean;
  hasPublicEmail: boolean;
}): boolean {
  if (!input.onlyPublicEmail) return true;
  return input.hasPublicEmail;
}

/**
 * Resolve ONE public email for a company.
 *
 * Returns null when nothing was published — the caller renders
 * "No public email found" and never invents an address.
 *
 * The official-site pass only runs when it can change the outcome (no usable
 * offer address) and only while the run still has fetch budget
 * (`fetchPages === null` means exhausted), so a run stays inside its
 * serverless time budget.
 */
export async function resolveCompanyPublicEmail(input: {
  companyName: string;
  offer: Pick<Opportunity, "contact" | "source_url" | "enrichment">;
  /** Verified website of the company (engine enrichment), or null. */
  websiteUrl: string | null;
  /** null = the run's page-fetch budget is exhausted (no site pass). */
  fetchPages: CompanySitePagesFetcher | null;
  maxPages?: number;
}): Promise<PublicEmailResolution | null> {
  const published = [
    offerEmailCandidate(input.offer),
    enrichedEmailCandidate(input.offer),
  ].filter((candidate): candidate is PublicEmailResolution => candidate !== null);
  // Where to look without guessing: the website the engine verified, or the
  // domain of an address the EMPLOYER published. A company name is never
  // turned into a host.
  const website =
    input.websiteUrl ??
    published
      .map((candidate) => companyWebsiteFromPublishedEmail(candidate.email))
      .find((url) => url !== null) ??
    null;

  let siteCandidates: PublicEmailResolution[] = [];
  if (website && input.fetchPages) {
    try {
      const pages = await input.fetchPages(website);
      siteCandidates = websiteEmailCandidates({
        pages: pages.slice(0, input.maxPages ?? MAX_EMAIL_PAGES_PER_COMPANY),
        companyName: input.companyName,
      });
    } catch {
      // A blocked/failed fetch is not an address — report nothing, invent
      // nothing, and let the caller keep the company as "no public email".
      siteCandidates = [];
    }
  }

  // The company's own page beats a text-only source on a tie (published, live,
  // attributable); a text source remains the answer when the site yielded
  // none. No candidate at all → null → "No public email found".
  return pickPublicEmail([...siteCandidates, ...published]);
}
