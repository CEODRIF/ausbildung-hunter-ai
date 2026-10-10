import { describe, expect, it } from "vitest";

import {
  dedupKeys,
  isSameListing,
  listingFingerprint,
  listingIdFromUrl,
  normalizeUrlIdentity,
} from "@/lib/housing/web-search/dedup";

describe("normalizeUrlIdentity", () => {
  it("strips tracking params but keeps functional query params", () => {
    const base = "https://www.immobilienscout24.de/expose/123456789";
    expect(normalizeUrlIdentity(`${base}?utm_source=mail&gclid=abc&fbclid=x`)).toBe(`${base}`.replace("www.", ""));
    // A non-tracking param is identity (different search context).
    expect(normalizeUrlIdentity(`${base}?sort=price`)).not.toBe(normalizeUrlIdentity(base));
  });

  it("normalizes scheme, www, case and fragments", () => {
    const a = normalizeUrlIdentity("http://WWW.ImmobilienScout24.de/expose/123456789#ref");
    const b = normalizeUrlIdentity("https://immobilienscout24.de/expose/123456789");
    expect(a).toBe(b);
    expect(a).toBe("https://immobilienscout24.de/expose/123456789");
  });

  it("preserves PATH case (URLs are case-sensitive)", () => {
    const a = normalizeUrlIdentity("https://example.de/Angebot/X123");
    const b = normalizeUrlIdentity("https://example.de/angebot/x123");
    expect(a).not.toBe(b);
  });

  it("returns null for unparseable / non-http input", () => {
    expect(normalizeUrlIdentity("not a url")).toBeNull();
    expect(normalizeUrlIdentity("ftp://example.de/x")).toBeNull();
    expect(normalizeUrlIdentity("")).toBeNull();
  });
});

describe("listingIdFromUrl — per-portal patterns", () => {
  it("IS24 /expose/<id>", () => {
    expect(listingIdFromUrl("https://immobilienscout24.de/expose/123456789")).toBe("123456789");
  });
  it("Immowelt /expose/<id> and /objekt/<id>", () => {
    expect(listingIdFromUrl("https://www.immowelt.de/expose/123456789")).toBe("123456789");
    expect(listingIdFromUrl("https://www.immowelt.de/objekt/987654321")).toBe("987654321");
  });
  it("WG-Gesucht numeric offer id", () => {
    expect(listingIdFromUrl("https://www.wg-gesucht.de/rooms/12345678/koeln/")).toBe("12345678");
  });
  it("Kleinanzeigen ad URL (/s-…/<8+ digit id>/)", () => {
    // c20-<id> is the SEARCH-CONTEXT segment (category 20), not an ad id —
    // the ad id is the standalone numeric segment of the detail URL.
    expect(listingIdFromUrl("https://www.kleinanzeigen.de/s-anzeige/123456789/")).toBe("123456789");
    expect(listingIdFromUrl("https://www.kleinanzeigen.de/s-2-zimmer-wohnung-mieten/c20-123456789/")).toBeNull();
  });
  it("Immonet /objekt/<id>", () => {
    expect(listingIdFromUrl("https://www.immonet.de/objekt/123456789")).toBe("123456789");
  });
  it("open-data ?id= query param", () => {
    expect(listingIdFromUrl("https://open.nrw/dataset/mieten?id=1234567")).toBe("1234567");
  });
  it("returns null without an id", () => {
    expect(listingIdFromUrl("https://example.de/suche/wohnung-koeln")).toBeNull();
  });
});

describe("listingFingerprint — conservative rule 3", () => {
  const facts = (over: Record<string, unknown> = {}) => ({
    title: "Helle 2-Zi in Nippes",
    rentColdEur: 850,
    rooms: 2,
    city: "Köln",
    ...over,
  });

  it("requires a real title (≥8 chars) AND a cold rent — weak fingerprints never merge", () => {
    expect(listingFingerprint(facts({ title: "abc" }))).toBeNull();
    expect(listingFingerprint(facts({ rentColdEur: null }))).toBeNull();
    expect(listingFingerprint(facts())).not.toBeNull();
  });

  it("same facts → same fingerprint; different rent/rooms/city → different", () => {
    const base = listingFingerprint(facts())!;
    expect(listingFingerprint(facts())).toBe(base);
    expect(listingFingerprint(facts({ rentColdEur: 900 }))).not.toBe(base);
    expect(listingFingerprint(facts({ rooms: 3 }))).not.toBe(base);
    expect(listingFingerprint(facts({ city: "München" }))).not.toBe(base);
  });
});

describe("isSameListing — the three merge rules", () => {
  const url = (p: string) => `https://immobilienscout24.de${p}`;

  it("rule 1: identical normalized URL (tracking stripped)", () => {
    const a = dedupKeys(url("/expose/123456789?utm_source=x"), { title: null, rentColdEur: null, rooms: null, city: null })!;
    const b = dedupKeys("https://www.immobilienscout24.de/expose/123456789", { title: null, rentColdEur: null, rooms: null, city: null })!;
    expect(isSameListing(a, b, b.host, null)).toBe(true);
  });

  it("rule 2: same host + same portal listing id (different path shape)", () => {
    const a = dedupKeys(url("/expose/123456789"), { title: null, rentColdEur: null, rooms: null, city: null })!;
    const b = dedupKeys(url("/123456789?x=1"), { title: null, rentColdEur: null, rooms: null, city: null })!;
    // /123456789 has no listing vocabulary but the same bare id → rule 2.
    expect(isSameListing(a, b, b.host, null)).toBe(true);
  });

  it("NEVER merges two listings on the same host with different ids", () => {
    const a = dedupKeys(url("/expose/111111111"), { title: null, rentColdEur: null, rooms: null, city: null })!;
    const b = dedupKeys(url("/expose/222222222"), { title: null, rentColdEur: null, rooms: null, city: null })!;
    expect(isSameListing(a, b, b.host, "Köln")).toBe(false);
  });

  it("rule 3: same host + title + cold rent + SAME non-empty city", () => {
    const a = dedupKeys(url("/expose/111111111"), { title: "Tageswohnung, ruhig", rentColdEur: 400, rooms: 1, city: "Berlin" })!;
    const b = dedupKeys(url("/expose/222222222"), { title: "Tageswohnung, ruhig", rentColdEur: 400, rooms: 1, city: "Berlin" })!;
    expect(isSameListing(a, b, b.host, "Berlin")).toBe(true);
  });

  it("rule 3 rejects when the city is unknown or different (never merges different listings)", () => {
    const a = dedupKeys(url("/expose/111111111"), { title: "Tageswohnung, ruhig", rentColdEur: 400, rooms: 1, city: "Berlin" })!;
    const bOtherCity = dedupKeys(url("/expose/222222222"), { title: "Tageswohnung, ruhig", rentColdEur: 400, rooms: 1, city: "Hamburg" })!;
    expect(isSameListing(a, bOtherCity, bOtherCity.host, "Hamburg")).toBe(false);
    // The fingerprint itself embeds the city — different city ⇒ different fingerprint.
    const bUnknown = dedupKeys(url("/expose/333333333"), { title: "Tageswohnung, ruhig", rentColdEur: 400, rooms: 1, city: null })!;
    expect(isSameListing(a, bUnknown, bUnknown.host, null)).toBe(false);
  });

  it("different hosts never merge, even with identical fingerprints", () => {
    const a = dedupKeys("https://immowelt.de/expose/111111111", { title: "Tageswohnung, ruhig", rentColdEur: 400, rooms: 1, city: "Berlin" })!;
    const b = dedupKeys("https://immonet.de/objekt/222222222", { title: "Tageswohnung, ruhig", rentColdEur: 400, rooms: 1, city: "Berlin" })!;
    expect(isSameListing(a, b, b.host, "Berlin")).toBe(false);
  });
});
