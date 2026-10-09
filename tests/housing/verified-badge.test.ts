import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the demo-listing trust indicators (audit finding:
 * fictional demo listings rendered a green "Verified source" badge).
 *
 * Contract under test:
 *   1. The green "verified" badge may ONLY appear on LIVE listings whose
 *      source verification is substantiated by a registered provider adapter.
 *   2. Demo listings NEVER render the verified badge — regardless of their
 *      `verified` field (in sample data it is display metadata, not evidence).
 *   3. With no live adapters registered (the current state), the app can
 *      serve NO verified listing at all.
 */

const { isVerifiedListing } = await import("@/lib/housing/types");
const {
  searchHousing,
  normalizeListing,
  activeProviderIds,
  PROVIDER_ADAPTERS,
} = await import("@/lib/housing/providers");
const { DEFAULT_HOUSING_SEARCH } = await import("@/lib/housing/types");

const cardSrc = readFileSync(
  new URL("../../src/components/housing/listing-card.tsx", import.meta.url),
  "utf8",
);
const searchSrc = readFileSync(
  new URL("../../src/components/housing/housing-search.tsx", import.meta.url),
  "utf8",
);

describe("isVerifiedListing gate (logic)", () => {
  it("a demo listing with verified=true is NEVER verified (the reported bug)", () => {
    expect(isVerifiedListing({ data_status: "demo", verified: true })).toBe(false);
  });

  it("a demo listing with verified=false is not verified", () => {
    expect(isVerifiedListing({ data_status: "demo", verified: false })).toBe(false);
  });

  it("a genuine live listing with provider-substantiated verification retains the badge", () => {
    // searchHousing re-stamps registered-adapter results with data_status
    // "live" — normalizeListing mirrors that path here.
    const liveVerified = normalizeListing({
      provider: "example-licensed-provider",
      source_id: "x",
      data_status: "live",
      verified: true,
    });
    expect(isVerifiedListing(liveVerified)).toBe(true);
  });

  it("a live listing without provider-substantiated verification gets no badge", () => {
    expect(isVerifiedListing({ data_status: "live", verified: false })).toBe(false);
  });
});

describe("current demo data is unverified end-to-end", () => {
  it("every listing the app can currently serve fails the verified gate", async () => {
    const result = await searchHousing(DEFAULT_HOUSING_SEARCH);
    expect(result.listings.length).toBeGreaterThan(0);
    for (const listing of result.listings) {
      expect(listing.data_status).toBe("demo");
      expect(isVerifiedListing(listing)).toBe(false);
    }
  });

  it("the verified_only filter cannot turn demo listings into verified ones", async () => {
    // Even though demo fixtures carry verified=true for filtering purposes,
    // the trust gate must reject them all.
    const result = await searchHousing({
      ...DEFAULT_HOUSING_SEARCH,
      verified_only: true,
    });
    expect(result.listings.length).toBeGreaterThan(0);
    for (const listing of result.listings) {
      expect(isVerifiedListing(listing)).toBe(false);
    }
  });

  it("no live provider adapter is registered → the app cannot produce a live/verified listing today", () => {
    // This is the honest limitation: the live-data verification contract is
    // not implemented, so the verified badge is unreachable in production.
    expect(PROVIDER_ADAPTERS).toEqual([]);
    expect(activeProviderIds()).toEqual([]);
  });
});

describe("render sites are gated by the trust gate (source-level guard)", () => {
  it("listing-card.tsx: the green verified badge is rendered only via isVerifiedListing", () => {
    // The old defect: a bare `.verified &&` condition drove the badge.
    expect(cardSrc).not.toMatch(/listing\.verified\s*&&/);
    // The badge path must go through the gate.
    expect(cardSrc).toMatch(/isVerifiedListing\(listing\)/);
    // The neutral demo indicator branch exists and reuses the translated
    // "sample listing" label.
    expect(cardSrc).toMatch(/data_status === "demo"/);
    expect(cardSrc).toContain('t("housing.demoSource")');
    // The gate helper is actually imported, not just mentioned.
    expect(cardSrc).toMatch(/import\s*\{[^}]*\bisVerifiedListing\b[^}]*\}\s*from\s*"\@\/lib\/housing\/types"/);
  });

  it("housing-search.tsx: the detail-panel badge is rendered only via isVerifiedListing", () => {
    expect(searchSrc).not.toMatch(/selected\.verified\s*&&/);
    expect(searchSrc).toMatch(/isVerifiedListing\(selected\)/);
    expect(searchSrc).toMatch(/data_status === "demo"/);
    expect(searchSrc).toContain('t("housing.demoSource")');
    expect(searchSrc).toMatch(/import\s*\{[^}]*\bisVerifiedListing\b[^}]*\}\s*from\s*"\@\/lib\/housing\/types"/);
  });
});
