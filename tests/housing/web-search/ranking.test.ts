import { describe, expect, it } from "vitest";

import { rankListing, type RankInput } from "@/lib/housing/web-search/ranking";

const NOW = Date.parse("2026-10-10T00:00:00Z");

const base = (over: Partial<RankInput> = {}): RankInput => ({
  city: "Berlin",
  cityVerified: true,
  listingUrl: "https://immobilienscout24.de/expose/123456789",
  hasListingId: true,
  rentWarmEur: 750,
  rentColdEur: 650,
  rooms: 2,
  livingAreaSqm: 55,
  floor: "1. OG",
  availableFrom: "2026-11-01",
  furnished: null,
  accommodationType: "apartment",
  requestedType: "all",
  maxWarmRent: null,
  sourceHost: "immobilienscout24.de",
  pageVerified: false,
  nowMs: NOW,
  ...over,
});

describe("rankListing — explicit signals", () => {
  it("awards the city-verified bonus (+25) and names it in the reasons", () => {
    const full = rankListing(base({ rentWarmEur: null, rentColdEur: null, rooms: null, livingAreaSqm: null, floor: null, availableFrom: null, hasListingId: false, sourceHost: "unbekannt.de" }));
    expect(full.score).toBe(25);
    expect(full.reasons).toContain("rank.cityMatch");

    const unknown = rankListing(base({ cityVerified: false, city: null }));
    expect(unknown.score).toBeLessThan(rankListing(base({ cityVerified: true })).score);
    // cityUnknown is a low-priority reason: it surfaces in the top-3 only
    // when no stronger signal exists (the cap is by design).
    const bareUnknown = rankListing(base({
      cityVerified: false,
      city: null,
      hasListingId: false,
      rentWarmEur: null,
      rentColdEur: null,
      rooms: null,
      livingAreaSqm: null,
      floor: null,
      availableFrom: null,
      sourceHost: "unbekannt.de",
    }));
    expect(bareUnknown.score).toBe(0); // unknown city is kept, NOT boosted
    expect(bareUnknown.reasons).toContain("rank.cityUnknown");
  });

  it("budget fit scores higher than the same listing OVER the budget (-15)", () => {
    const fit = rankListing(base({ maxWarmRent: 900 }));
    const over = rankListing(base({ maxWarmRent: 500 }));
    expect(fit.score).toBeGreaterThan(over.score);
    expect(fit.reasons).toContain("rank.budgetFit");
    expect(over.reasons).toContain("rank.budgetOver");
  });

  it("unknown rent never fakes a budget fit", () => {
    const r = rankListing(base({ rentWarmEur: null, rentColdEur: null, maxWarmRent: 900 }));
    expect(r.reasons).toContain("rank.rentUnknown");
    expect(r.reasons).not.toContain("rank.budgetFit");
    // The same listing WITH a known in-budget rent scores higher.
    expect(r.score).toBeLessThan(rankListing(base({ maxWarmRent: 900 })).score);
  });

  it("type match only when the user picked a specific type", () => {
    expect(rankListing(base({ requestedType: "wg_room", accommodationType: "wg_room" })).reasons).toContain("rank.typeMatch");
    expect(rankListing(base({ requestedType: "all", accommodationType: "wg_room" })).reasons).not.toContain("rank.typeMatch");
  });

  it("freshness: available_from within 60 days ahead scores, not stale/far dates", () => {
    expect(rankListing(base({ availableFrom: "2026-11-15" })).reasons).toContain("rank.fresh");
    expect(rankListing(base({ availableFrom: "2027-05-01" })).reasons).not.toContain("rank.fresh");
  });

  it("reviewed portals and open-data sources get the quality bonus", () => {
    const portal = rankListing(base({ sourceHost: "wg-gesucht.de", hasListingId: false }));
    const openData = rankListing(base({ sourceHost: "open.nrw", listingUrl: "https://open.nrw/dataset/mieten", hasListingId: false }));
    const unknown = rankListing(base({ sourceHost: "zufall.de", hasListingId: false }));
    expect(portal.score).toBeGreaterThan(unknown.score);
    expect(openData.score).toBeGreaterThan(unknown.score);
  });

  it("page-verified fields add the verification bonus", () => {
    expect(rankListing(base({ pageVerified: true })).score).toBeGreaterThan(rankListing(base()).score);
  });

  it("clamps to 0..100 and returns at most 3 top reasons", () => {
    const r = rankListing(base({ maxWarmRent: 900 }));
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.reasons.length).toBeLessThanOrEqual(3);
  });
});
