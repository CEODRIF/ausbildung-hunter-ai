import { describe, expect, it } from "vitest";

import { parseModelListings } from "@/lib/housing/web-search/parse-model-listings";

const item = (over: Record<string, unknown> = {}) => ({
  url: "https://www.immobilienscout24.de/expose/123456789",
  title: "2-Zimmer-Wohnung in Köln-Ehrenfeld",
  city: "Köln",
  rent_cold_eur: 850,
  rent_warm_eur: 1050,
  additional_costs_eur: null,
  rooms: 2,
  living_area_sqm: 55,
  floor: "2. OG",
  available_from: "2026-12-01",
  furnished: false,
  source: "ImmoScout24",
  ...over,
});

describe("parseModelListings — the strict JSON contract", () => {
  it("parses a plain JSON array with all fields", () => {
    const res = parseModelListings(JSON.stringify([item(), item({ url: "https://www.immowelt.de/expose/555555555" })]));
    expect(res.parsed).toBe(true);
    expect(res.truncated).toBe(false);
    expect(res.items).toHaveLength(2);
    expect(res.items[0]).toMatchObject({
      url: "https://www.immobilienscout24.de/expose/123456789",
      title: "2-Zimmer-Wohnung in Köln-Ehrenfeld",
      city: "Köln",
      rent_cold_eur: 850,
      rent_warm_eur: 1050,
      rooms: 2,
      living_area_sqm: 55,
      floor: "2. OG",
      available_from: "2026-12-01",
      furnished: false,
      source: "ImmoScout24",
    });
  });

  it("handles code fences and surrounding prose", () => {
    const text =
      "Hier sind die Angebote:\n```json\n" +
      JSON.stringify([item()]) +
      "\n```\nViel Erfolg bei der Suche!";
    const res = parseModelListings(text);
    expect(res.parsed).toBe(true);
    expect(res.items).toHaveLength(1);
  });

  it("salvages complete elements from a TRUNCATED array (token budget)", () => {
    const full = JSON.stringify([item(), item({ url: "https://x.de/2" }), item({ url: "https://x.de/3" })]);
    // Cut mid-way through the third object.
    const truncated = full.slice(0, full.indexOf("https://x.de/3")) + '"title": "abgebro';
    const res = parseModelListings(truncated);
    expect(res.parsed).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.items).toHaveLength(2);
    expect(res.items.map((i) => i.url)).toEqual([
      "https://www.immobilienscout24.de/expose/123456789",
      "https://x.de/2",
    ]);
  });

  it("repairs trailing commas (common LLM artifact)", () => {
    const res = parseModelListings('[{"url":"https://a.de/123456789","title":"A",},]');
    expect(res.parsed).toBe(true);
    expect(res.items).toHaveLength(1);
  });

  it("returns parsed=false for prose without any JSON array (fallback path)", () => {
    const res = parseModelListings(
      "Ich habe mehrere Wohnungen in Köln gefunden. Hier ist der Link: https://www.immobilienscout24.de/expose/123456789",
    );
    expect(res.parsed).toBe(false);
    expect(res.items).toEqual([]);
  });

  it("returns parsed=false for empty text", () => {
    expect(parseModelListings("").parsed).toBe(false);
    expect(parseModelListings("   ").parsed).toBe(false);
  });
});

describe("parseModelListings — field coercion and sanity ranges (no fabrication)", () => {
  it("drops an item with an invalid URL (whole item unusable)", () => {
    const res = parseModelListings(
      JSON.stringify([item({ url: "not-a-url" }), item({ url: "javascript:alert(1)" }), item({ url: "ftp://x.de/1" })]),
    );
    expect(res.parsed).toBe(false); // no valid items at all
    expect(res.items).toEqual([]);
  });

  it("keeps valid items next to invalid ones", () => {
    const res = parseModelListings(
      JSON.stringify([item({ url: "not-a-url" }), item({ url: "https://a.de/expose/999999999" })]),
    );
    expect(res.items).toHaveLength(1);
    expect(res.items[0].url).toBe("https://a.de/expose/999999999");
  });

  it("rejects out-of-range numbers (absent, not trusted)", () => {
    const res = parseModelListings(
      JSON.stringify([
        item({ rent_cold_eur: 999999, rooms: 42, living_area_sqm: 99999, rent_warm_eur: 0 }),
      ]),
    );
    expect(res.items[0].rent_cold_eur).toBeNull();
    expect(res.items[0].rooms).toBeNull();
    expect(res.items[0].living_area_sqm).toBeNull();
    expect(res.items[0].rent_warm_eur).toBeNull();
  });

  it("accepts numeric strings for money (\"850\", \"1.234,50\") and integers", () => {
    const res = parseModelListings(
      JSON.stringify([item({ rent_cold_eur: "850", rent_warm_eur: "1.234,50", rooms: "3", living_area_sqm: "55" })]),
    );
    expect(res.items[0].rent_cold_eur).toBe(850);
    expect(res.items[0].rent_warm_eur).toBe(1234.5);
    expect(res.items[0].rooms).toBe(3);
    expect(res.items[0].living_area_sqm).toBe(55);
  });

  it("rejects overflow dates (2026-02-30) and non-ISO dates", () => {
    const res = parseModelListings(
      JSON.stringify([
        item({ url: "https://a.de/expose/11111111", available_from: "2026-02-30" }),
        item({ url: "https://a.de/expose/22222222", available_from: "01.12.2026" }),
      ]),
    );
    expect(res.items).toHaveLength(2);
    expect(res.items[0].available_from).toBeNull();
    expect(res.items[1].available_from).toBeNull();
  });

  it("rejects non-boolean furnished values; trims long strings; drops non-objects", () => {
    const res = parseModelListings(
      JSON.stringify([
        item({ furnished: "yes", title: "x".repeat(300) }),
        "just a string",
        42,
        null,
      ]),
    );
    expect(res.items).toHaveLength(1);
    expect(res.items[0].furnished).toBeNull();
    expect(res.items[0].title).toBeNull();
  });

  it("dedupes items by URL (case-insensitive)", () => {
    const res = parseModelListings(
      JSON.stringify([item(), { ...item(), url: "HTTPS://WWW.IMMOBILIENSCOUT24.DE/expose/123456789" }]),
    );
    expect(res.items).toHaveLength(1);
  });

  it("parses the extended detail fields (deposit, address, pets, WG) with coercion", () => {
    const res = parseModelListings(
      JSON.stringify([
        item({
          deposit_eur: "1.500",
          address: "Musterstraße 12",
          pets_allowed: true,
          wg_suitable: false,
        }),
      ]),
    );
    expect(res.items[0].deposit_eur).toBe(1500);
    expect(res.items[0].address).toBe("Musterstraße 12");
    expect(res.items[0].pets_allowed).toBe(true);
    expect(res.items[0].wg_suitable).toBe(false);
  });

  it("rejects out-of-range / wrongly-typed extended fields (unknown stays null)", () => {
    const res = parseModelListings(
      JSON.stringify([
        item({
          deposit_eur: 99999999,
          address: "x".repeat(300),
          pets_allowed: "true",
          wg_suitable: 1,
        }),
      ]),
    );
    expect(res.items[0].deposit_eur).toBeNull();
    expect(res.items[0].address).toBeNull();
    expect(res.items[0].pets_allowed).toBeNull();
    expect(res.items[0].wg_suitable).toBeNull();
  });
});
