import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep the provider layer fully OFFLINE: the default Nominatim geocoder must
// never hit the network from tests. Null = "could not geocode" (fail-open),
// which preserves the original city-name matching behavior.
vi.mock("@/lib/housing/geocode", () => ({
  geocodePlace: vi.fn(async () => null),
  clearGeocodeCache: vi.fn(),
  geocodeUserAgent: () => "test-agent",
}));

const {
  searchHousing,
  findListingById,
  activeProviderIds,
  DEMO_LABEL,
  normalizeListing,
  haversineKm,
} = await import("@/lib/housing/providers");
const { DEFAULT_HOUSING_SEARCH } = await import("@/lib/housing/types");
import type {
  HousingListing,
  HousingProviderAdapter,
  HousingSearchParams,
} from "@/lib/housing/types";

function params(overrides: Partial<HousingSearchParams> = {}): HousingSearchParams {
  return { ...DEFAULT_HOUSING_SEARCH, ...overrides };
}

/** Test double: a fully-shaped adapter with controllable search results. */
function mkAdapter(
  id: string,
  search: HousingProviderAdapter["search"],
  overrides: Partial<HousingProviderAdapter> = {},
): HousingProviderAdapter {
  return {
    id,
    displayName: id,
    isLicensed: () => true,
    supportedFilters: ["city"],
    termsRef: "test://license",
    search,
    ...overrides,
  };
}

function mkListing(
  provider: string,
  sourceId: string,
  overrides: Partial<HousingListing> = {},
): HousingListing {
  return {
    provider,
    source_id: sourceId,
    title: `${provider}/${sourceId}`,
    listing_url: "https://example.com/",
    city: "Köln",
    postal_code: null,
    address: null,
    latitude: 50.942,
    longitude: 6.957,
    rent_cold_eur: null,
    additional_costs_eur: null,
    rent_warm_eur: 800,
    deposit_eur: null,
    rooms: null,
    living_area_sqm: null,
    available_from: null,
    furnished: false,
    balcony: false,
    pets_allowed: null,
    wg_suitable: false,
    verified: false,
    accommodation_type: "apartment",
    images: [],
    features: [],
    description: null,
    provider_updated_at: null,
    last_checked_at: null,
    source_terms_version: null,
    data_status: "live",
    listing_active: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

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
    expect(normalized.listing_active).toBeNull();
  });
});

describe("housing provider layer — adapter contract & result pipeline", () => {
  const KÖLN = { lat: 50.942, lon: 6.957 }; // demo-koln-2zz-balkon's coords

  it("haversineKm: 0 for identical points, sane scale for city pairs", () => {
    expect(haversineKm(KÖLN, KÖLN)).toBe(0);
    const berlin = { lat: 52.52, lon: 13.405 };
    const d = haversineKm(KÖLN, berlin);
    // Great-circle Köln→Berlin ≈ 477 km for these coordinates.
    expect(d).toBeGreaterThan(450);
    expect(d).toBeLessThan(500);
  });

  it("dedupes by provider:source_id (one card per identity)", async () => {
    const adapter = mkAdapter("fake", async () => [
      mkListing("fake", "x", { title: "first" }),
      mkListing("fake", "x", { title: "duplicate" }),
      mkListing("fake", "y"),
    ]);
    const result = await searchHousing(params(), { adapters: [adapter], geocode: null });
    const fakeIds = result.listings.filter((l) => l.provider === "fake");
    expect(fakeIds).toHaveLength(2);
    expect(fakeIds.map((l) => l.source_id).sort()).toEqual(["x", "y"]);
    // First occurrence wins.
    expect(fakeIds.find((l) => l.source_id === "x")?.title).toBe("first");
  });

  it("LIVE data wins over a demo fixture with the same provider:source_id", async () => {
    const adapter = mkAdapter("demo", async () => [
      mkListing("demo", "demo-koln-2zz-balkon", { title: "LIVE-TITLE" }),
    ]);
    const result = await searchHousing(params(), { adapters: [adapter], geocode: null });
    const match = result.listings.filter((l) => l.source_id === "demo-koln-2zz-balkon");
    expect(match).toHaveLength(1);
    expect(match[0].title).toBe("LIVE-TITLE");
    expect(match[0].data_status).toBe("live");
  });

  it("drops listings the provider marks inactive (listing_active=false), keeps null", async () => {
    const adapter = mkAdapter("fake", async () => [
      mkListing("fake", "expired", { listing_active: false }),
      mkListing("fake", "unknown", { listing_active: null }),
      mkListing("fake", "active", { listing_active: true }),
    ]);
    const result = await searchHousing(params(), { adapters: [adapter], geocode: null });
    const fakeIds = result.listings.filter((l) => l.provider === "fake").map((l) => l.source_id);
    expect(fakeIds).toEqual(["unknown", "active"]);
  });

  it("one failing adapter is isolated; the other's results are served", async () => {
    const failing = mkAdapter("bad", async () => {
      throw new Error("provider outage");
    });
    const good = mkAdapter("good", async () => [mkListing("good", "g1")]);
    const result = await searchHousing(params(), {
      adapters: [failing, good],
      geocode: null,
    });
    expect(result.listings.some((l) => l.provider === "good")).toBe(true);
    expect(result.listings.some((l) => l.provider === "bad")).toBe(false);
    // Demo data still flows (isolation, not exclusion).
    expect(result.listings.some((l) => l.provider === "demo")).toBe(true);
  });

  it("a hanging adapter times out and is dropped (does not block the search)", async () => {
    const hanging = mkAdapter("slow", () => new Promise<HousingListing[]>(() => {}));
    const good = mkAdapter("good", async () => [mkListing("good", "g1")]);
    const start = Date.now();
    const result = await searchHousing(params(), {
      adapters: [hanging, good],
      geocode: null,
      adapterTimeoutMs: 50,
    });
    expect(Date.now() - start).toBeLessThan(5000);
    expect(result.listings.some((l) => l.provider === "good")).toBe(true);
    expect(result.listings.some((l) => l.provider === "slow")).toBe(false);
  });

  it("an UNLICENSED adapter never runs, even when injected", async () => {
    const spy = vi.fn(async (): Promise<HousingListing[]> => [mkListing("unlicensed", "u1")]);
    const unlicensed = mkAdapter("unlicensed", spy, { isLicensed: () => false });
    const result = await searchHousing(params(), { adapters: [unlicensed], geocode: null });
    expect(spy).not.toHaveBeenCalled();
    expect(result.listings.every((l) => l.provider !== "unlicensed")).toBe(true);
    expect(result.is_demo).toBe(true);
  });

  it("adapters must declare supportedFilters + termsRef (trust contract)", async () => {
    // Compile-time contract: these fields are required on the interface.
    const adapter: HousingProviderAdapter = {
      id: "contract",
      displayName: "Contract",
      isLicensed: () => true,
      supportedFilters: ["city", "max_warm_rent"],
      termsRef: "https://example.com/api-terms",
      search: async () => [mkListing("contract", "c1")],
    };
    expect(adapter.supportedFilters).toContain("city");
    expect(adapter.termsRef).toMatch(/^https?:\/\//);
    const result = await searchHousing(params(), { adapters: [adapter], geocode: null });
    expect(result.listings.some((l) => l.provider === "contract")).toBe(true);
  });

  it("paginates with a stable pre-pagination total and has_more", async () => {
    const page1 = await searchHousing(params(), {
      adapters: [],
      geocode: null,
      pagination: { limit: 3, offset: 0 },
    });
    expect(page1.listings).toHaveLength(3);
    expect(page1.total).toBeGreaterThan(3); // pre-pagination total
    expect(page1.has_more).toBe(true);

    const page2 = await searchHousing(params(), {
      adapters: [],
      geocode: null,
      pagination: { limit: 3, offset: 3 },
    });
    expect(page2.total).toBe(page1.total); // stable across pages
    const overlap = page1.listings
      .map((l) => `${l.provider}:${l.source_id}`)
      .filter((key) => page2.listings.some((l) => `${l.provider}:${l.source_id}` === key));
    expect(overlap).toEqual([]); // pages do not overlap

    const tail = await searchHousing(params(), {
      adapters: [],
      geocode: null,
      pagination: { limit: 3, offset: page1.total - 1 },
    });
    expect(tail.listings).toHaveLength(1);
    expect(tail.has_more).toBe(false);
  });

  it("clamps out-of-range pagination (limit 1..100, offset 0..10000)", async () => {
    const huge = await searchHousing(params(), {
      adapters: [],
      geocode: null,
      pagination: { limit: 100000, offset: 99999999 },
    });
    expect(huge.listings).toEqual([]); // offset clamped to 10000 > total
    expect(huge.total).toBeGreaterThan(0);
    const maxLimit = await searchHousing(params(), {
      adapters: [],
      geocode: null,
      pagination: { limit: 100000, offset: 0 },
    });
    expect(maxLimit.listings.length).toBeLessThanOrEqual(100);
  });
});

describe("housing search — honest radius filter", () => {
  const KÖLN_POINT = { lat: 50.942, lon: 6.957, label: "Köln (test)" };

  it("applies haversine radius when the city geocodes (demo data has coords)", async () => {
    const result = await searchHousing(params({ city: "Köln", radius_km: 0.1 }), {
      geocode: async () => KÖLN_POINT,
    });
    expect(result.radius_applied).toBe(true);
    // Only the listing at the exact geocoded point survives a 0.1 km radius.
    const ids = result.listings.map((l) => l.source_id);
    expect(ids).toEqual(["demo-koln-2zz-balkon"]);
    expect(result.total).toBe(1);
  });

  it("keeps all city matches and reports radius_applied=false when geocoding returns null", async () => {
    const result = await searchHousing(params({ city: "Köln" }), {
      geocode: async () => null,
    });
    expect(result.radius_applied).toBe(false);
    expect(result.listings.map((l) => l.city)).toEqual(["Köln", "Köln", "Köln", "Köln"]);
  });

  it("fails OPEN when the geocoder throws (search still succeeds)", async () => {
    const result = await searchHousing(params({ city: "Köln" }), {
      geocode: async () => {
        throw new Error("geocode outage");
      },
    });
    expect(result.radius_applied).toBe(false);
    expect(result.total).toBe(4);
  });

  it("reports radius_applied=false when geocoding is disabled (null)", async () => {
    const result = await searchHousing(params({ city: "Köln" }), { geocode: null });
    expect(result.radius_applied).toBe(false);
    expect(result.total).toBe(4);
  });

  it("does not geocode at all without a city (radius needs a center)", async () => {
    const geocode = vi.fn(async () => KÖLN_POINT);
    const result = await searchHousing(params({ radius_km: 10 }), { geocode });
    expect(result.radius_applied).toBe(false);
    expect(geocode).not.toHaveBeenCalled();
  });

  it("does not apply a radius when radius_km is 0", async () => {
    const geocode = vi.fn(async () => KÖLN_POINT);
    const result = await searchHousing(params({ city: "Köln", radius_km: 0 }), { geocode });
    expect(result.radius_applied).toBe(false);
    expect(geocode).not.toHaveBeenCalled();
    expect(result.total).toBe(4);
  });

  it("keeps coord-less listings via the city-name match when radius applies", async () => {
    const adapter = mkAdapter("fake", async () => [
      mkListing("fake", "no-coords", { city: "Köln", latitude: null, longitude: null }),
    ]);
    const result = await searchHousing(params({ city: "Köln", radius_km: 0.1 }), {
      adapters: [adapter],
      geocode: async () => KÖLN_POINT,
    });
    expect(result.radius_applied).toBe(true);
    expect(result.listings.some((l) => l.source_id === "no-coords")).toBe(true);
  });
});
