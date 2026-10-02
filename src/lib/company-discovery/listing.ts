/**
 * Listing parsing — turns ONE fetched portal page into offers.
 *
 * Pure and deterministic: it takes HTML that was already fetched through the
 * guarded fetcher and maps only what the listing states. Missing facts stay
 * `null` (never inferred) and a listing that cannot be understood yields an
 * empty array — never a fabricated offer (§3.5).
 *
 * Structured data first: portals overwhelmingly publish
 * `schema.org/JobPosting` as JSON-LD, which is a documented, machine-readable
 * statement by the publisher itself. A microdata fallback (`itemprop`) covers
 * pages that mark up `hiringOrganization` inline. There is deliberately NO
 * heuristic that invents a company from a heading, and no site-specific
 * selector list that a redesign could silently turn into wrong data.
 */

import { htmlToText } from "@/lib/web-search/fetch-page";
import { acceptEmailsFromContent } from "./accept";
import type { NormalizedOffer } from "./adapter";
import { isPortalHost } from "./sources";

export interface ListingPageInput {
  html: string;
  /** The URL the page was fetched from (provenance of every offer). */
  pageUrl: string;
  /** Portal display name, stored as `offerSource`. */
  offerSource: string;
  /** Source id, part of the candidate identity. */
  sourceId: string;
  /** The run's field; recorded as context only when the listing states none. */
  field: string | null;
  /** The offer type this adapter pass targets (scope guard, §3.2). */
  goal: "ausbildung" | "arbeit";
}

/** Deterministic 32-bit FNV-1a — a stable candidate identity, no crypto need. */
export function stableRef(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Every `application/ld+json` block of a page, parsed defensively. */
export function jsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re =
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // A malformed block is ignored — never repaired, never guessed at.
    }
  }
  return blocks;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Depth-first walk that yields every object node of a JSON-LD document. */
function walkNodes(node: unknown, out: JsonRecord[] = []): JsonRecord[] {
  if (Array.isArray(node)) {
    for (const entry of node) walkNodes(entry, out);
    return out;
  }
  if (!isRecord(node)) return out;
  out.push(node);
  for (const value of Object.values(node)) walkNodes(value, out);
  return out;
}

function hasType(node: JsonRecord, type: string): boolean {
  const value = node["@type"];
  if (typeof value === "string") return value.toLowerCase() === type.toLowerCase();
  if (Array.isArray(value)) {
    return value.some(
      (entry) => typeof entry === "string" && entry.toLowerCase() === type.toLowerCase(),
    );
  }
  return false;
}

function stringOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

/** `YYYY-MM-DD` or null — a documented start, never a derived one. */
function isoDateOf(value: unknown): string | null {
  const raw = stringOf(value);
  if (!raw) return null;
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const parsed = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** A human label for a `baseSalary`, built only from stated parts. */
function salaryLabelOf(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const currency =
    stringOf(value["currency"]) ??
    (isRecord(value["value"]) ? stringOf(value["value"]["currency"]) : null);
  const inner = isRecord(value["value"]) ? value["value"] : value;
  const amount = inner["value"] ?? inner["minValue"];
  const unit = stringOf(inner["unitText"]);
  const parts: string[] = [];
  if (amount !== undefined && amount !== null && `${amount}`.trim() !== "") {
    parts.push(`${amount}`);
  }
  if (currency) parts.push(currency);
  if (unit) parts.push(unit);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** The employmentType → offer type mapping (stated values only). */
function offerTypeOf(value: unknown): "ausbildung" | "arbeit" | null {
  const values = Array.isArray(value) ? value : [value];
  const stated = values
    .map((entry) => (typeof entry === "string" ? entry.toLowerCase() : ""))
    .filter(Boolean);
  if (stated.length === 0) return null;
  if (
    stated.some((entry) =>
      ["apprenticeship", "internship", "ausbildung", "azubi", "trainee"].includes(entry),
    )
  ) {
    return "ausbildung";
  }
  if (
    stated.some((entry) =>
      ["full_time", "part_time", "contractor", "temporary", "arbeitsverhältnis"].includes(
        entry,
      ),
    )
  ) {
    return "arbeit";
  }
  return null;
}

interface AddressParts {
  city: string | null;
  state: string | null;
}

function addressPartsOf(value: unknown): AddressParts {
  const locations = Array.isArray(value) ? value : [value];
  for (const location of locations) {
    if (!isRecord(location)) continue;
    const address = isRecord(location["address"]) ? location["address"] : location;
    const city = stringOf(address["addressLocality"]);
    const state = stringOf(address["addressRegion"]);
    if (city || state) return { city, state };
  }
  return { city: null, state: null };
}

/** The company website, but only when the listing links a non-portal host. */
function companyWebsiteOf(value: unknown): string | null {
  const candidates: string[] = [];
  const push = (raw: unknown): void => {
    if (isRecord(raw)) {
      for (const key of ["url", "sameAs", "@id"]) candidates.push(...asStrings(raw[key]));
      return;
    }
    candidates.push(...asStrings(raw));
  };
  push(value);
  for (const candidate of candidates) {
    if (!/^https?:\/\//i.test(candidate)) continue;
    let host: string;
    try {
      host = new URL(candidate).hostname;
    } catch {
      continue;
    }
    if (isPortalHost(host)) continue;
    return candidate;
  }
  return null;
}

function asStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => (typeof entry === "string" ? [entry] : []));
  }
  return [];
}

/**
 * Parse one listing page. Offers without a stated company name are dropped:
 * they could never become a counted company, and inventing a name is exactly
 * what this feature must not do.
 */
export function parseListingPage(input: ListingPageInput): NormalizedOffer[] {
  const pageText = htmlToText(input.html);
  const nodes = jsonLdBlocks(input.html).flatMap((block) => walkNodes(block));
  const postings = nodes.filter((node) => hasType(node, "JobPosting"));

  const offers: NormalizedOffer[] = [];
  const seen = new Set<string>();

  for (const posting of postings) {
    const organization = isRecord(posting["hiringOrganization"])
      ? posting["hiringOrganization"]
      : null;
    const companyName = organization ? stringOf(organization["name"]) : null;
    if (!companyName) continue; // no stated employer → not a usable offer

    const statedType = offerTypeOf(posting["employmentType"]);
    const offerType = statedType ?? input.goal;

    const role = stringOf(posting["title"]);
    const offerUrl = stringOf(posting["url"]) ?? input.pageUrl;
    const website = companyWebsiteOf(organization?.["sameAs"] ?? organization?.["url"]);
    const address = addressPartsOf(posting["jobLocation"]);
    const beginn = isoDateOf(posting["jobStartDate"]);
    const salary = salaryLabelOf(posting["baseSalary"]);

    // The listing's own text is the literal-presence base (§4.2a): the JSON-LD
    // of THIS posting plus its description.
    const listingBlock = `${JSON.stringify(posting)}\n${input.pageUrl}`;
    const accepted = acceptEmailsFromContent({
      text: listingBlock,
      sourceUrl: input.pageUrl,
      sourceType: "job_listing",
      companyName,
      companyDomain: website ? new URL(website).hostname : null,
    })[0];

    const candidateRef = `${input.sourceId}:${stableRef(
      `${offerUrl}|${companyName}|${role ?? ""}`,
    )}`;
    if (seen.has(candidateRef)) continue;
    seen.add(candidateRef);

    offers.push({
      companyName,
      companyWebsite: website,
      role,
      field: input.field,
      city: address.city,
      state: address.state,
      offerType,
      beginn,
      salary,
      offerSource: input.offerSource,
      offerUrl,
      publishedEmail: accepted
        ? { email: accepted.email, evidence: accepted.evidenceSnippet }
        : null,
      listingText: listingBlock || pageText,
      candidateRef,
    });
  }

  if (offers.length > 0) return offers;

  // Microdata fallback: some boards mark up `hiringOrganization` inline
  // instead of emitting JSON-LD. Only explicitly labelled names are read.
  return parseMicrodataOffers(input, pageText);
}

function parseMicrodataOffers(
  input: ListingPageInput,
  pageText: string,
): NormalizedOffer[] {
  const offers: NormalizedOffer[] = [];
  const re =
    /itemprop\s*=\s*["']hiringOrganization["'][\s\S]{0,600}?itemprop\s*=\s*["']name["'][^>]*>([^<]{2,200})</gi;
  let match: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((match = re.exec(input.html)) !== null) {
    const companyName = match[1].replace(/\s+/g, " ").trim();
    if (companyName.length < 2) continue;
    const accepted = acceptEmailsFromContent({
      text: pageText,
      sourceUrl: input.pageUrl,
      sourceType: "job_listing",
      companyName,
    })[0];
    const candidateRef = `${input.sourceId}:${stableRef(`${input.pageUrl}|${companyName}`)}`;
    if (seen.has(candidateRef)) continue;
    seen.add(candidateRef);
    offers.push({
      companyName,
      companyWebsite: null,
      role: null,
      field: input.field,
      city: null,
      state: null,
      offerType: input.goal,
      beginn: null,
      salary: null,
      offerSource: input.offerSource,
      offerUrl: input.pageUrl,
      publishedEmail: accepted
        ? { email: accepted.email, evidence: accepted.evidenceSnippet }
        : null,
      listingText: pageText,
      candidateRef,
    });
  }
  return offers;
}
