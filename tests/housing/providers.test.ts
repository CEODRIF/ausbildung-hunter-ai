import { describe, expect, it } from "vitest";

const {
  searchHousing,
  findListingById,
  activeProviderIds,
  DEMO_LABEL,
  normalizeListing,
} = await import("@/lib/housing/providers");
const { DEFAULT_HOUSING_SEARCH } = await import("@/lib/housing/types");
import type { HousingSearchParams } from "@/lib/housing/types";

function params(overrides: Partial<HousingSearchParams> = {}): HousingSearchParams {
  return { ...DEFAULT_HOUSING_SEARCH, ...overrides };
}

describe("housing provider layer (MVP = demo only, zero live providers)", () => {
  it("has NO live providers registered (the hard no-scraping / no-license gate)", () => {
    expect(activeProviderIds()).toEqual([]);
  });

  it("serves only labeled demo data and marks it as demo", async () => {
    const result = await searchHousing(params());
    expect(result.is_demo).toBe(true);
    expect(result.data_status).toBe("demo");
    expect(result.total).toBe(result.listings.length);
    expect(result.total).toBeGreaterThan(0);
    for (const listing of result.listings) {
      expect(listing.data_status).toBe("demo");
      // Every listing links OUT to a real portal (http/https), never a scrape.
      expect(listing.listing_url).toMatch(/^https?:\/\//);
      // The demo label is present and explicit.
      expect(DEMO_LABEL).toContain("Demo-Daten");
    }
  });

  it("filters by city (case-insensitive substring)", async () => {
    const all = (await searchHousing(params())).listings;
    const berlin = (await searchHousing(params({ city: "berlin" }))).listings;
    expect(berlin.length).toBeGreaterThan(0);
    expect(berlin.length).toBeLessThan(all.length);
    for (const l of berlin) expect(l.city.toLowerCase()).toBe("berlin");
  });

  it("caps by max warm rent and drops listings without a warm rent", async () => {
    const result = (await searchHousing(params({ max_warm_rent: 600 }))).listings;
    for (const l of result) {
      expect(l.rent_warm_eur).not.toBeNull();
      expect(l.rent_warm_eur as number).toBeLessThanOrEqual(600);
    }
    // The 1750€ Berlin flat must be excluded.
    expect(result.some((l) => l.source_id === "demo-berlin-3zz")).toBe(false);
  });

  it("filters by accommodation type and furnished flag", async () => {
    const wg = (await searchHousing(params({ accommodation_type: "wg_room" }))).listings;
    expect(wg.length).toBeGreaterThan(0);
    for (const l of wg) {
      expect(l.accommodation_type).toBe("wg_room");
      expect(l.wg_suitable).toBe(true);
    }
    const furnished = (await searchHousing(params({ furnished_only: true }))).listings;
    for (const l of furnished) expect(l.furnished).toBe(true);
  });

  it("sorts price ascending with null rents LAST (never fabricated)", async () => {
    const result = (await searchHousing(params({ sort: "price_asc" }))).listings;
    const rents = result.map((l) => l.rent_warm_eur);
    const nonNull = rents.filter((r): r is number => r != null);
    // Non-null rents are in ascending order.
    for (let i = 1; i < nonNull.length; i++) {
      expect(nonNull[i]).toBeGreaterThanOrEqual(nonNull[i - 1]);
    }
    // Any nulls are all at the end.
    const firstNull = rents.findIndex((r) => r == null);
    if (firstNull !== -1) {
      for (let i = firstNull; i < rents.length; i++) expect(rents[i]).toBeNull();
    }
  });

  it("returns an empty result set for impossible filters (no fabrication)", async () => {
    const result = await searchHousing(
      params({ city: "Nonexistent-City-XYZ", max_warm_rent: 1 }),
    );
    expect(result.total).toBe(0);
    expect(result.listings).toEqual([]);
  });

  it("findListingById resolves demo listings and rejects unknown ids", () => {
    const found = findListingById("demo", "demo-koln-2zz-balkon");
    expect(found).not.toBeNull();
    expect(found?.title).toBeTruthy();
    expect(findListingById("demo", "does-not-exist")).toBeNull();
    expect(findListingById("unknown-provider", "demo-koln-2zz-balkon")).toBeNull();
  });

  it("normalizeListing fills null-safe defaults (never undefined)", () => {
    const normalized = normalizeListing({ source_id: "x", title: "t" });
    expect(normalized.provider).toBe("demo");
    expect(normalized.data_status).toBe("demo");
    expect(normalized.images).toEqual([]);
    expect(normalized.features).toEqual([]);
    expect(normalized.postal_code).toBeNull();
  });
});
