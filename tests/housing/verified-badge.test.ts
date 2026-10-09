import { describe, expect, it } from "vitest";

/**
 * Regression guard for the listing trust indicators (audit finding:
 * fictional demo listings rendered a green "Verified source" badge).
 *
 * Contract under test:
 *   1. The green "verified" badge may ONLY appear on LIVE listings whose
 *      source verification is substantiated by a registered provider adapter.
 *   2. Demo-stamped data NEVER renders the verified badge — regardless of
 *      its `verified` field (in sample data it is display metadata, not
 *      evidence).
 *   3. With no live adapters registered (the current state), the app can
 *      serve NO verified listing at all.
 *
 * (Demo data was removed from the housing surface on 2026-10-10 —
 * `tests/housing/no-demo-data.test.ts` guarantees it cannot come back.
 * The gate logic stays as defense in depth for any future data source.)
 */

const { isVerifiedListing } = await import("@/lib/housing/types");
const {
  normalizeListing,
  activeProviderIds,
  PROVIDER_ADAPTERS,
} = await import("@/lib/housing/providers");

describe("isVerifiedListing gate (logic)", () => {
  it("a demo listing with verified=true is NEVER verified (the reported bug)", () => {
    expect(isVerifiedListing({ data_status: "demo", verified: true })).toBe(false);
  });

  it("a demo listing with verified=false is not verified", () => {
    expect(isVerifiedListing({ data_status: "demo", verified: false })).toBe(false);
  });

  it("a genuine live listing with provider-substantiated verification retains the badge", () => {
    // The provider pipeline re-stamps registered-adapter results with
    // data_status "live" — normalizeListing mirrors that path here.
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

  it("no live provider adapter is registered → the app cannot produce a live/verified listing today", () => {
    // This is the honest limitation: the live-data verification contract is
    // not implemented, so the verified badge is unreachable in production.
    expect(PROVIDER_ADAPTERS).toEqual([]);
    expect(activeProviderIds()).toEqual([]);
  });
});
