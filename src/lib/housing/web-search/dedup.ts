import "server-only";

import { createHash } from "node:crypto";

/**
 * Cross-source deduplication (2026-10-10 high-coverage engine task).
 *
 * The same listing is typically discovered via Google AND Azure AND several
 * query rounds, often with tracking parameters (`?utm_source=…`, `?gclid=…`)
 * or `www.` differences. These helpers normalize identity WITHOUT ever
 * merging two DIFFERENT listings:
 *
 *   merge rule 1 — same normalized URL (strongest).
 *   merge rule 2 — same host + same extracted listing ID (portal offer
 *                  number, e.g. IS24 expose ID, WG-Gesucht offer ID).
 *   merge rule 3 — same host + same content fingerprint (normalized title
 *                  + cold rent + rooms + city). Requires the host match:
 *                  two different apartments in different cities with the
 *                  same rent must NEVER merge.
 *
 * Every candidate keeps `discovered_via` (the provider(s) that found it)
 * so the UI can show "via Google + Azure" while rendering ONE card.
 */

/** Tracking / affiliate / analytics parameters that do not change the
 *  identity of a page. Stripped during normalization. */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "gbraid",
  "gclsrc",
  "fbclid",
  "msclkid",
  "twclid",
  "li_fat_id",
  "ref",
  "referrer",
  "source",
  "src",
  "cmp",
  "campaign",
  "mailid",
  "pk_campaign",
  "pk_kwd",
  "spm",
  "scm",
  "wickedid",
  "wt_mc",
  "wt_var",
  "irclickid",
  "mc_eid",
  "mkt_tok",
  "hsa_acc",
  "hsa_cam",
  "hsa_grp",
  "hsa_ad",
  "hsa_src",
  "hsa_tgt",
  "hsa_kw",
]);

/**
 * Normalize a URL for identity purposes:
 *   - scheme forced to https, host lowercased
 *   - `www.` stripped (host identity is the registered domain)
 *   - default ports removed, trailing slash removed
 *   - PATH case preserved (URLs are case-sensitive)
 *   - tracking/analytics query params dropped, the rest kept (a search
 *     page with a different listing id in the query is a different page)
 *   - fragments dropped
 * Returns null for unparseable / non-http(s) input.
 */
export function normalizeUrlIdentity(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  let host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "") return null;
  const port = u.port;
  if (port !== "" && !(u.protocol === "https:" && port === "443") && !(u.protocol === "http:" && port === "80")) {
    host = `${host}:${port}`;
  }
  const path = u.pathname.replace(/\/+$/, "") || "";
  const params = new URLSearchParams();
  for (const [k, v] of u.searchParams.entries()) {
    if (TRACKING_PARAMS.has(k.toLowerCase())) continue;
    params.append(k, v);
  }
  const qs = params.toString();
  return `https://${host}${path}${qs ? `?${qs}` : ""}`;
}

/**
 * Extract the portal's own listing/offer ID from the URL when present
 * (the most reliable identity signal per host). Only the reviewed
 * portal families are patterned — for unreviewed hosts this returns the
 * trailing 6+ digit path segment (the same rule the URL classifier uses).
 */
export function listingIdFromUrl(raw: string): string | null {
  const n = normalizeUrlIdentity(raw);
  if (!n) return null;
  let u: URL;
  try {
    u = new URL(n);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname;

  // Reviewd portals — documented ID shapes.
  if (host === "immobilienscout24.de" || host.endsWith(".immobilienscout24.de")) {
    const m = path.match(/\/expose\/(\d{6,})/i);
    if (m) return m[1];
  }
  if (host === "immowelt.de" || host.endsWith(".immowelt.de")) {
    const m = path.match(/\/expose\/(\d{6,})/i) ?? path.match(/\/objekt\/(\d{6,})/i);
    if (m) return m[1];
  }
  if (host === "wg-gesucht.de" || host.endsWith(".wg-gesucht.de")) {
    const m = path.match(/\/(\d{6,})/i);
    if (m) return m[1];
  }
  if (host === "kleinanzeigen.de" || host.endsWith(".kleinanzeigen.de")) {
    const m = path.match(/\/(\d{8,})/i);
    if (m) return m[1];
  }
  if (host === "immonet.de" || host.endsWith(".immonet.de")) {
    const m = path.match(/\/objekt\/(\d{6,})/i);
    if (m) return m[1];
  }
  // Generic fallback (any host): trailing 6+ digit path segment.
  const tail = path.match(/\/(\d{6,})(?:[/?#-]|$)/);
  if (tail) return tail[1];
  // Query-carried ids on open-data portals (e.g. ?id=…).
  const qid = u.searchParams.get("id");
  if (qid && /^\d{6,}$/.test(qid)) return qid;
  return null;
}

/**
 * Content fingerprint — rule 3. ONLY title + hard numbers; deliberately
 * excludes price-only or area-only similarity (two different flats can
 * share a rent). Returns null when there is not enough signal (title or
 * rent missing) — a weak fingerprint never merges.
 */
export function listingFingerprint(input: {
  title: string | null;
  rentColdEur: number | null;
  rooms: number | null;
  city: string | null;
}): string | null {
  const title = (input.title ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (title.length < 8) return null;
  if (input.rentColdEur == null) return null;
  const h = createHash("sha1")
    .update(`${title}|${input.rentColdEur}|${input.rooms ?? "?"}|${(input.city ?? "").toLowerCase()}`)
    .digest("hex");
  return h.slice(0, 24);
}

export interface DedupKey {
  normUrl: string;
  host: string;
  listingId: string | null;
  fingerprint: string | null;
}

/** Compute all identity keys for one candidate URL + facts. */
export function dedupKeys(url: string, facts: {
  title: string | null;
  rentColdEur: number | null;
  rooms: number | null;
  city: string | null;
}): DedupKey | null {
  const normUrl = normalizeUrlIdentity(url);
  if (!normUrl) return null;
  let host = "";
  try {
    host = new URL(normUrl).hostname;
  } catch {
    return null;
  }
  return {
    normUrl,
    host,
    listingId: listingIdFromUrl(normUrl),
    fingerprint: listingFingerprint(facts),
  };
}

/**
 * Decide whether a NEW candidate is the SAME listing as an existing one.
 * Conservative by construction (see the three rules in the module header).
 */
export function isSameListing(
  a: DedupKey,
  b: DedupKey,
  bHost: string,
  bCity: string | null,
): boolean {
  if (a.normUrl === b.normUrl) return true; // rule 1
  if (a.listingId && a.listingId === b.listingId && a.host === b.host) return true; // rule 2
  // rule 3 — same host + same fingerprint + same (non-empty) city
  if (
    a.fingerprint &&
    a.fingerprint === b.fingerprint &&
    a.host === bHost &&
    bCity != null &&
    bCity.trim() !== ""
  ) {
    return true;
  }
  return false;
}
