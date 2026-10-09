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
  it("builds FOUR German query families for 'all' (apartment / WG / student / private rental), each naming every constraint the user set", () => {
    const built = buildHousingQueries({
      ...base,
      city: "Köln",
      radius_km: 10,
      max_warm_rent: 800,
      rooms: 2,
      min_area_sqm: 50,
      available_before: "2026-11-01",
    });
    expect(built.queries).toHaveLength(4);
    for (const q of built.queries) {
      expect(q).toContain("Köln");
      expect(q).toContain("800 Euro Warmmiete");
      expect(q).toContain("2 Zimmer");
      expect(q).toContain("mind. 50 m²");
      expect(q).toContain("frei ab 2026-11-01");
      expect(q).toContain("in der Umgebung von Köln");
    }
    // One family per market segment — different segments surface different
    // portals/index rankings (WG-Gesucht, university housing, private
    // landlords), which a single "Mietwohnung" query systematically misses.
    expect(built.queries[0]).toContain("Mietwohnung");
    expect(built.queries[1]).toContain("WG-Zimmer");
    expect(built.queries[2]).toContain("Studentenwohnung");
    expect(built.queries[3]).toContain("Eigentümer");
    // Targeted mode uses the primary German query.
    expect(built.targetedQuery).toBe(built.queries[0]);
  });

  it("every query carries the explicit web-search + JSON output instruction", () => {
    const built = buildHousingQueries({ ...base, city: "Berlin", max_warm_rent: 1000 });
    for (const q of built.queries) {
      // The raw user query is preserved verbatim inside the instruction…
      expect(q).toContain("Berlin");
      expect(q).toContain("1.000 Euro Warmmiete");
      // …and the instruction explicitly demands a live web search, per-
      // listing DIRECT links, citations, and a strict JSON array answer.
      expect(q).toMatch(/Websuche/i);
      expect(q).toMatch(/direkten Link/i);
      expect(q).toMatch(/zitiere/i);
      expect(q).toMatch(/JSON-Array/i);
      // Anti-fabrication rules are part of the request contract.
      expect(q).toMatch(/null sein/i);
      expect(q).toMatch(/Erfinde niemals/i);
    }
  });

  it("uses the postal code when no city is given; radius is city-only", () => {
    const built = buildHousingQueries({ ...base, postal_code: "50667", radius_km: 10 });
    expect(built.queries[0]).toContain("50667");
    expect(built.queries[0]).not.toContain("in der Umgebung");
  });

  it("omits unset constraints (rooms=all, no rent cap)", () => {
    const built = buildHousingQueries({ ...base, city: "Leipzig" });
    const de = built.queries[0];
    expect(de).toContain("Mietwohnung, Leipzig");
    // The JSON field schema always mentions the German field names ("Zimmer",
    // "Warmmiete") — so assert the CONSTRAINT phrases are absent.
    expect(de).not.toMatch(/\d\s+Zimmer/);
    expect(de).not.toContain("Euro Warmmiete");
  });

  it("maps every SPECIFIC accommodation type to exactly TWO queries (primary + complementary terms)", () => {
    for (const [type, primary, secondary] of [
      ["apartment", "Mietwohnung", "Wohnung mieten"],
      ["wg_room", "WG-Zimmer", "Zimmer in WG mieten"],
      ["furnished", "möblierte Wohnung", "möblierte Wohnung mieten"],
      ["studio", "Studio-Wohnung", "Studio mieten"],
    ] as const) {
      const built = buildHousingQueries({ ...base, city: "Köln", accommodation_type: type });
      expect(built.queries).toHaveLength(2);
      expect(built.queries[0]).toContain(primary);
      expect(built.queries[1]).toContain(secondary);
    }
  });

  it("does not add a calendar phrase for invalid availability dates", () => {
    const built = buildHousingQueries({ ...base, city: "Köln", available_before: "2026-02-30" });
    expect(built.queries[0]).not.toContain("frei ab");
  });

  it("keeps ALL queries bounded (raw part ≤400 chars + fixed instruction ≤1400 total)", () => {
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
    for (const q of built.queries) {
      expect(q.length).toBeLessThanOrEqual(1400);
    }
  });
});
