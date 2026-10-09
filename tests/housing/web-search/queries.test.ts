import { describe, expect, it } from "vitest";

import { buildHousingQueries } from "@/lib/housing/web-search/queries";
import type { HousingSearchParams } from "@/lib/housing/types";

type Q = Pick<
  HousingSearchParams,
  | "city"
  | "postal_code"
  | "radius_km"
  | "max_warm_rent"
  | "accommodation_type"
  | "rooms"
  | "min_area_sqm"
  | "available_before"
>;

const base: Q = {
  city: "",
  postal_code: "",
  radius_km: 0,
  max_warm_rent: null,
  accommodation_type: "all",
  rooms: "all",
  min_area_sqm: null,
  available_before: null,
};

describe("buildHousingQueries", () => {
  it("builds a German primary query naming every constraint the user set", () => {
    const built = buildHousingQueries({
      ...base,
      city: "Köln",
      radius_km: 10,
      max_warm_rent: 800,
      rooms: 2,
      min_area_sqm: 50,
      available_before: "2026-11-01",
    });
    const de = built.queries[0];
    expect(de).toContain("Mietwohnung");
    expect(de).toContain("Köln");
    expect(de).toContain("800 Euro Warmmiete");
    expect(de).toContain("2 Zimmer");
    expect(de).toContain("mind. 50 m²");
    expect(de).toContain("frei ab 2026-11-01");
    expect(de).toContain("in der Umgebung von Köln");
    // Targeted mode uses the German query; the EN query is a general-mode retry.
    expect(built.targetedQuery).toBe(de);
    expect(built.queries).toHaveLength(2);
  });

  it("builds a useful English secondary query", () => {
    const built = buildHousingQueries({
      ...base,
      city: "Köln",
      max_warm_rent: 800,
      rooms: 2,
      min_area_sqm: 50,
    });
    const en = built.queries[1];
    expect(en).toContain("rental apartment");
    expect(en).toContain("Köln");
    expect(en).toContain("max 800 EUR warm rent");
    expect(en).toContain("2 rooms");
    expect(en).toContain("min 50 sqm");
  });

  it("uses the postal code when no city is given; radius is city-only", () => {
    const built = buildHousingQueries({ ...base, postal_code: "50667", radius_km: 10 });
    expect(built.queries[0]).toContain("50667");
    expect(built.queries[0]).not.toContain("in der Umgebung");
  });

  it("omits unset constraints (rooms=all, no rent cap)", () => {
    const built = buildHousingQueries({ ...base, city: "Leipzig" });
    const de = built.queries[0];
    expect(de).toBe("Mietwohnung, Leipzig");
  });

  it("maps every accommodation type to German and English terms", () => {
    for (const [type, deTerm, enTerm] of [
      ["all", "Mietwohnung", "rental apartment"],
      ["apartment", "Mietwohnung", "rental apartment"],
      ["wg_room", "WG-Zimmer", "shared flat room (WG)"],
      ["furnished", "möblierte Wohnung", "furnished rental apartment"],
      ["studio", "Studio-Wohnung", "studio apartment for rent"],
    ] as const) {
      const built = buildHousingQueries({ ...base, city: "Köln", accommodation_type: type });
      expect(built.queries[0]).toContain(deTerm);
      expect(built.queries[1]).toContain(enTerm);
    }
  });

  it("does not add a calendar phrase for invalid availability dates", () => {
    const built = buildHousingQueries({ ...base, city: "Köln", available_before: "2026-02-30" });
    expect(built.queries[0]).not.toContain("frei ab");
  });

  it("keeps queries bounded (≤400 chars)", () => {
    const built = buildHousingQueries({
      ...base,
      city: "Köln",
      postal_code: "50667",
      radius_km: 100,
      max_warm_rent: 20000,
      rooms: 10,
      min_area_sqm: 2000,
      available_before: "2026-11-01",
    });
    for (const q of [built.queries[0], built.queries[1], built.targetedQuery]) {
      expect(q.length).toBeLessThanOrEqual(400);
    }
  });
});
