import { describe, expect, it } from "vitest";

import { planRound, maxGoogleQueriesPerRun } from "@/lib/housing/web-search/query-planner";
import { PROVIDER_LIMITS } from "@/lib/housing/web-search/config";
import type { QueryParams } from "@/lib/housing/web-search/queries";

const params = (over: Partial<QueryParams> = {}): QueryParams => ({
  city: "Berlin",
  postal_code: "",
  radius_km: 0,
  max_warm_rent: null,
  accommodation_type: "all",
  rooms: "all",
  min_area_sqm: null,
  available_before: null,
  ...over,
});

describe("planRound — round 1 (breadth)", () => {
  it("plans three distinct Google families for the default search", () => {
    const plan = planRound(params(), 1);
    expect(plan.round).toBe(1);
    expect(plan.google).toHaveLength(3);
    // Distinct raw queries (no useless duplicates within the provider).
    const raw = plan.google.map((q) => q.query);
    expect(new Set(raw).size).toBe(raw.length);
    // Every query names the city.
    for (const q of raw) expect(q).toContain("Berlin");
  });

  it("carries the user's constraints into every raw query", () => {
    const plan = planRound(params({ max_warm_rent: 850, rooms: 2 }), 1);
    for (const q of plan.google) {
      expect(q.query).toContain("850");
      expect(q.query).toContain("2 Zimmer");
    }
  });

  it("uses the move-in month for availability phrasings (round 2)", () => {
    const plan = planRound(params({ available_before: "2026-12-01" }), 2);
    const availability = plan.google.find((q) => q.family === "availability");
    expect(availability).toBeDefined();
    expect(availability!.query).toContain("Dezember 2026");
  });

  it("emits a budget query only when budget AND room count are set", () => {
    expect(planRound(params({ max_warm_rent: 700, rooms: 1 }), 2).google.some((q) => q.family === "budget")).toBe(true);
    expect(planRound(params({ max_warm_rent: 700 }), 2).google.some((q) => q.family === "budget")).toBe(false);
    expect(planRound(params({ rooms: 1 }), 2).google.some((q) => q.family === "budget")).toBe(false);
  });

  it("specific types use the type's own core term (WG Zimmer, möbliert, Studio)", () => {
    expect(planRound(params({ accommodation_type: "wg_room" }), 1).google.some((q) => q.query.includes("WG Zimmer mieten"))).toBe(true);
    expect(planRound(params({ accommodation_type: "furnished" }), 1).google.some((q) => q.query.includes("möblierte Wohnung"))).toBe(true);
    expect(planRound(params({ accommodation_type: "studio" }), 1).google.some((q) => q.query.includes("Studio"))).toBe(true);
  });

  it("falls back to the postal code when no city is set", () => {
    const plan = planRound(params({ city: "", postal_code: "10115" }), 1);
    for (const q of plan.google) expect(q.query).toContain("10115");
  });

  it("plans nothing for an empty location (no useless nationwide query)", () => {
    const plan = planRound(params({ city: "", postal_code: "" }), 1);
    expect(plan.google).toHaveLength(0);
    expect(plan.azure).toHaveLength(0);
  });
});

describe("planRound — hard caps + determinism", () => {
  it("never exceeds the per-round Google caps", () => {
    for (const round of [1, 2, 3] as const) {
      const plan = planRound(params(), round);
      const cap =
        round === 1
          ? PROVIDER_LIMITS.googleRound1Calls
          : round === 2
            ? PROVIDER_LIMITS.googleRound2Calls
            : PROVIDER_LIMITS.googleRound3Calls;
      expect(plan.google.length).toBeLessThanOrEqual(cap);
    }
  });

  it("is deterministic (same params → same plan)", () => {
    expect(planRound(params(), 2)).toEqual(planRound(params(), 2));
    expect(planRound(params({ available_before: "2027-01-15" }), 2)).toEqual(
      planRound(params({ available_before: "2027-01-15" }), 2),
    );
  });

  it("the per-run worst case is bounded (9 Google queries max)", () => {
    expect(maxGoogleQueriesPerRun()).toBe(
      PROVIDER_LIMITS.googleRound1Calls +
        PROVIDER_LIMITS.googleRound2Calls +
        PROVIDER_LIMITS.googleRound3Calls,
    );
    expect(maxGoogleQueriesPerRun()).toBe(9);
  });
});

describe("planRound — round 3 (site: gap filling)", () => {
  it("queries the major portals plus Studentenwerk", () => {
    const plan = planRound(params(), 3);
    expect(plan.google.some((q) => q.query.startsWith("site:wg-gesucht.de"))).toBe(true);
    expect(plan.google.some((q) => q.query.startsWith("site:immobilienscout24.de"))).toBe(true);
    expect(plan.google.some((q) => q.family === "studentenwerk")).toBe(true);
  });

  it("skips portals that ALREADY surfaced candidates (existingDomains)", () => {
    const plan = planRound(params(), 3, new Set(["wg-gesucht.de", "immobilienscout24.de"]));
    expect(plan.google.some((q) => q.query.startsWith("site:wg-gesucht.de"))).toBe(false);
    expect(plan.google.some((q) => q.query.startsWith("site:immobilienscout24.de"))).toBe(false);
    expect(plan.google.some((q) => q.query.startsWith("site:immowelt.de"))).toBe(true);
  });

  it("never plans site: queries for unreviewed domains", () => {
    const plan = planRound(params(), 3);
    for (const q of plan.google) {
      if (q.query.startsWith("site:")) {
        expect(["wg-gesucht.de", "immobilienscout24.de", "immowelt.de", "kleinanzeigen.de", "immonet.de", "housinganywhere.com", "wunderflats.com"]).toContain(
          q.query.slice(5).split(" ")[0],
        );
      }
    }
  });
});

describe("planRound — per-bucket dedup", () => {
  it("allows the same raw query on BOTH providers (different indexes)", () => {
    const plan = planRound(params(), 1);
    const googleCore = plan.google.find((q) => q.family === "core")!.query;
    const azureCore = plan.azure.find((q) => q.family === "core")!.query;
    expect(azureCore).toBe(googleCore);
  });
});
