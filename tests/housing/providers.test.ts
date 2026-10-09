import { describe, expect, it } from "vitest";

const {
  activeProviderIds,
  findListingById,
  haversineKm,
  normalizeListing,
  PROVIDER_ADAPTERS,
} = await import("@/lib/housing/providers");

/**
 * The provider layer after the demo-data removal (2026-10-10):
 * no demo fixtures, no demo search — the only listings the app can show are
 * the live Azure web-search results (covered in tests/housing/web-search/).
 * What remains is the licensed-ADAPTER contract + the id-lookup used by the
 * save/application routes.
 */

describe("provider layer — no demo data, adapter contract intact", () => {
  it("no live provider adapter is registered → activeProviderIds is empty", () => {
    expect(PROVIDER_ADAPTERS).toEqual([]);
    expect(activeProviderIds()).toEqual([]);
  });

  it("findListingById resolves NOTHING while no adapter is registered (no demo data to fall back on)", () => {
    // The old demo fixtures are gone: even the ids they used to serve miss.
    expect(findListingById("demo", "demo-koln-2zz-balkon")).toBeNull();
    expect(findListingById("any-provider", "any-id")).toBeNull();
    expect(findListingById("", "x")).toBeNull();
    expect(findListingById("demo", "")).toBeNull();
  });

  it("normalizeListing fills null-safe defaults (never undefined)", () => {
    const normalized = normalizeListing({ source_id: "x", title: "t" });
    expect(normalized.provider).toBe("demo");
    expect(normalized.data_status).toBe("demo");
    expect(normalized.rent_warm_eur).toBeNull();
    expect(normalized.images).toEqual([]);
    expect(normalized.features).toEqual([]);
  });

  it("haversineKm: 0 for identical points, sane scale for city pairs", () => {
    const KÖLN = { lat: 50.942, lon: 6.957 };
    const berlin = { lat: 52.52, lon: 13.405 };
    expect(haversineKm(KÖLN, KÖLN)).toBe(0);
    const d = haversineKm(KÖLN, berlin);
    expect(d).toBeGreaterThan(450);
    expect(d).toBeLessThan(550);
  });
});
