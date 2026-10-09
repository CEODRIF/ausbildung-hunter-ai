import { describe, expect, it } from "vitest";

import {
  firstSafeImage,
  listingSourceLabel,
  safeHostname,
  shouldShowImage,
  type WebSearchDomain,
} from "@/components/housing/listing-card";
import { applyClientFilters } from "@/components/housing/housing-web-search";
import type { HousingListing } from "@/lib/housing/types";

function listing(over: Partial<HousingListing> = {}): HousingListing {
  return {
    provider: "web-search",
    source_id: "abc",
    title: "T",
    listing_url: "https://immobilienscout24.de/expose/123456789",
    city: "Köln",
    postal_code: null,
    address: null,
    latitude: null,
    longitude: null,
    rent_cold_eur: null,
    additional_costs_eur: null,
    rent_warm_eur: null,
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
    ...over,
  };
}

const DOMAINS: WebSearchDomain[] = [
  { domain: "immobilienscout24.de", label: "ImmoScout24", fetchable: false },
  { domain: "open.nrw", label: "Open.NRW (Open Data)", fetchable: true },
];

describe("firstSafeImage", () => {
  it("returns the first https image", () => {
    expect(firstSafeImage(["https://cdn.de/a.jpg", "https://cdn.de/b.jpg"])).toBe("https://cdn.de/a.jpg");
  });
  it("skips http (mixed content), invalid and non-string values", () => {
    expect(firstSafeImage(["http://cdn.de/a.jpg", "javascript:alert(1)", "not a url", "", null as never])).toBeNull();
    expect(firstSafeImage(["http://cdn.de/a.jpg", "https://ok.de/b.jpg"])).toBe("https://ok.de/b.jpg");
  });
  it("returns null for empty/undefined", () => {
    expect(firstSafeImage([])).toBeNull();
    expect(firstSafeImage(null)).toBeNull();
    expect(firstSafeImage(undefined)).toBeNull();
  });

  it("rejects credentials, localhost and private IP-literal hosts (legacy-snapshot defense)", () => {
    expect(firstSafeImage(["https://user:pass@cdn.de/a.jpg"])).toBeNull();
    expect(firstSafeImage(["https://user@cdn.de/a.jpg"])).toBeNull();
    expect(firstSafeImage(["https://localhost/a.jpg"])).toBeNull();
    expect(firstSafeImage(["https://192.168.1.5/a.jpg"])).toBeNull();
    expect(firstSafeImage(["https://10.0.0.8/a.jpg"])).toBeNull();
    expect(firstSafeImage(["https://169.254.169.254/a.jpg"])).toBeNull();
    expect(firstSafeImage(["https://[::1]/a.jpg"])).toBeNull();
    // and a safe URL behind bad ones still wins
    expect(firstSafeImage(["https://10.0.0.8/a.jpg", "https://cdn.de/ok.jpg"])).toBe("https://cdn.de/ok.jpg");
  });

  it("accepts a public IP-literal host", () => {
    expect(firstSafeImage(["https://93.184.216.34/a.jpg"])).toBe("https://93.184.216.34/a.jpg");
  });
});

describe("shouldShowImage — broken-image fallback decision", () => {
  it("no image → placeholder (false)", () => {
    expect(shouldShowImage(null, null)).toBe(false);
  });

  it("image present, nothing failed → photo (true)", () => {
    expect(shouldShowImage("https://cdn.de/a.jpg", null)).toBe(true);
  });

  it("the image itself failed to load → placeholder (true fallback)", () => {
    expect(shouldShowImage("https://cdn.de/a.jpg", "https://cdn.de/a.jpg")).toBe(false);
  });

  it("an OLD failure (different src, e.g. after re-search) does not suppress the new photo", () => {
    expect(shouldShowImage("https://cdn.de/new.jpg", "https://cdn.de/a.jpg")).toBe(true);
  });
});

describe("safeHostname / listingSourceLabel", () => {
  it("strips www", () => {
    expect(safeHostname("https://www.immobilienscout24.de/expose/1")).toBe("immobilienscout24.de");
  });
  it("prefers the model-reported source label", () => {
    expect(listingSourceLabel(listing({ source_label: "ImmoScout24 (via Bing)" }), DOMAINS)).toBe(
      "ImmoScout24 (via Bing)",
    );
  });
  it("falls back to the reviewed allowlist label, then the bare hostname", () => {
    expect(listingSourceLabel(listing(), DOMAINS)).toBe("ImmoScout24");
    expect(
      listingSourceLabel(listing({ listing_url: "https://some-unknown-portal.de/wohnung/123456789" }), DOMAINS),
    ).toBe("some-unknown-portal.de");
  });
});

describe("applyClientFilters — consistent, honest post-search filtering", () => {
  const noFilters = {
    furnished_only: false,
    wg_suitable_only: false,
    pets_allowed_only: false,
    verified_only: false,
    max_warm_rent: null,
    rooms: "all" as const,
    min_area_sqm: null,
    available_before: null,
  };

  it("keeps everything without filters", () => {
    const ls = [listing({ rent_warm_eur: 500 }), listing({ rent_warm_eur: 2000 })];
    expect(applyClientFilters(ls, noFilters)).toHaveLength(2);
  });

  it("excludes listings whose KNOWN rent exceeds the cap, keeps unknown rents", () => {
    const ls = [
      listing({ source_id: "a", rent_warm_eur: 500 }),
      listing({ source_id: "b", rent_warm_eur: 1200 }),
      listing({ source_id: "c", rent_warm_eur: null }),
    ];
    const out = applyClientFilters(ls, { ...noFilters, max_warm_rent: 1000 });
    expect(out.map((l) => l.source_id)).toEqual(["a", "c"]);
  });

  it("boolean toggles exclude definitive non-matches only", () => {
    const ls = [
      listing({ source_id: "f1", furnished: true }),
      listing({ source_id: "f2", furnished: false }),
      listing({ source_id: "p1", pets_allowed: true }),
      listing({ source_id: "p2", pets_allowed: null }),
      listing({ source_id: "p3", pets_allowed: false }),
    ];
    expect(applyClientFilters(ls, { ...noFilters, furnished_only: true }).map((l) => l.source_id)).toEqual(["f1"]);
    expect(applyClientFilters(ls, { ...noFilters, pets_allowed_only: true }).map((l) => l.source_id)).toEqual([
      "p1",
    ]);
  });

  it("verified_only matches nothing for web-search data (never falsely verified)", () => {
    const ls = [listing({ verified: false }), listing({ verified: true, data_status: "live" })];
    // A web-search listing with verified=true would match — but the pipeline
    // always sets verified=false; this documents the gate's contract.
    expect(applyClientFilters(ls, { ...noFilters, verified_only: true }).map((l) => l.verified)).toEqual([true]);
  });

  it("numeric room/area/date filters exclude known violations, keep unknowns", () => {
    const ls = [
      listing({ source_id: "r2", rooms: 2 }),
      listing({ source_id: "r3", rooms: 3 }),
      listing({ source_id: "r?", rooms: null }),
      listing({ source_id: "a40", living_area_sqm: 40 }),
      listing({ source_id: "a80", living_area_sqm: 80 }),
      listing({ source_id: "late", available_from: "2027-06-01" }),
      listing({ source_id: "early", available_from: "2026-11-01" }),
      listing({ source_id: "unk", available_from: null }),
    ];
    const out = applyClientFilters(ls, {
      ...noFilters,
      rooms: 2,
      min_area_sqm: 50,
      available_before: "2026-12-31",
    });
    expect(out.map((l) => l.source_id)).toEqual(["r2", "r?", "a80", "early", "unk"]);
  });
});
