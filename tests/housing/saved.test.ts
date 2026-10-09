import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAdminMock } = await import("../helpers");

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
const { createAdminClient } = await import("@/lib/supabase/admin");

const {
  saveHousingListing,
  listSavedListings,
  removeSavedListing,
  saveHousingSearch,
  isSavedListingStatus,
} = await import("@/lib/housing/saved");

/**
 * A previously saved row (its snapshot lives in the DB — that is why the
 * saved page keeps working after the demo fixtures were removed).
 */
const savedRow = {
  id: "sl-1",
  user_id: "user-1",
  provider: "web-search",
  source_listing_id: "is24-123456789",
  url: "https://immobilienscout24.de/expose/123456789",
  snapshot: {
    provider: "web-search",
    source_id: "is24-123456789",
    title: "2-Zimmer-Wohnung in Köln-Ehrenfeld",
    listing_url: "https://immobilienscout24.de/expose/123456789",
    city: "Köln",
    rent_warm_eur: 850,
    data_status: "live",
  },
  notes: null,
  status: "saved",
  saved_at: "2026-10-09T00:00:00.000Z",
};

const searchRow = {
  id: "ss-1",
  user_id: "user-1",
  name: "Köln unter 850",
  query: { city: "Köln", max_warm_rent: 850 },
  last_run_at: "2026-10-09T00:00:00.000Z",
  last_count: 3,
  created_at: "2026-10-09T00:00:00.000Z",
};

let adminMock: Awaited<ReturnType<typeof createAdminMock>>;

beforeEach(() => {
  adminMock = createAdminMock({
    maybeSingleData: (table) => (table === "housing_saved_listings" ? savedRow : null),
    singleData: (table) => (table === "housing_saved_searches" ? searchRow : null),
  });
  vi.mocked(createAdminClient).mockReturnValue(adminMock.admin as never);
});
afterEach(() => vi.clearAllMocks());

describe("saveHousingListing (server-derived snapshot, never client data)", () => {
  it("rejects EVERY listing id while no adapter is registered — no fabrication, no write", async () => {
    // The demo fixtures are gone: there is no listing that can be re-derived
    // server-side, so saving must fail closed instead of inventing data.
    for (const [provider, sourceId] of [
      ["demo", "demo-koln-2zz-balkon"],
      ["web-search", "is24-123456789"],
      ["anything", "else"],
    ] as const) {
      await expect(saveHousingListing("user-1", provider, sourceId)).rejects.toThrow(
        "Listing not found.",
      );
    }
    expect(
      adminMock.calls.some((c) => c.table === "housing_saved_listings" && c.op === "upsert"),
    ).toBe(false);
  });
});

describe("user isolation + migrated schema", () => {
  it("listSavedListings selects only migrated columns, scoped to the session user", async () => {
    await listSavedListings("user-1");
    const MIGRATED = new Set([
      "id",
      "user_id",
      "provider",
      "source_listing_id",
      "url",
      "snapshot",
      "notes",
      "status",
      "saved_at",
    ]);
    const selectCall = adminMock.calls.find(
      (c) => c.table === "housing_saved_listings" && c.op === "select",
    );
    expect(selectCall).toBeDefined();
    const columns = (selectCall?.args[0] as string)
      .split(",")
      .map((c) => c.trim());
    for (const column of columns) expect(MIGRATED.has(column)).toBe(true);
    const userScope = adminMock.calls.find(
      (c) =>
        c.table === "housing_saved_listings" && c.op === "eq" && c.args[0] === "user_id",
    );
    expect(userScope?.args[1]).toBe("user-1");
  });

  it("removeSavedListing scopes the delete to the session user", async () => {
    await removeSavedListing("user-A", "web-search", "is24-123456789");
    const eqs = adminMock.calls.filter(
      (c) => c.table === "housing_saved_listings" && c.op === "eq",
    );
    const userScope = eqs.find((c) => c.args[0] === "user_id");
    expect(userScope?.args[1]).toBe("user-A");
    expect(eqs.some((c) => c.args[0] === "source_listing_id")).toBe(true);
  });

  it("saveHousingSearch stores the normalized query for the session user", async () => {
    await saveHousingSearch(
      "user-1",
      "Köln unter 850",
      { city: "Köln", max_warm_rent: 850 } as never,
      3,
    );
    const insert = adminMock.calls.find(
      (c) => c.table === "housing_saved_searches" && c.op === "insert",
    );
    expect(insert).toBeDefined();
    const payload = insert?.args[0] as Record<string, unknown>;
    expect(payload.user_id).toBe("user-1");
    expect(payload.name).toBe("Köln unter 850");
    expect((payload.query as { city: string }).city).toBe("Köln");
    expect(payload.last_count).toBe(3);
  });

  it("isSavedListingStatus only accepts the known enum values", () => {
    expect(isSavedListingStatus("saved")).toBe(true);
    expect(isSavedListingStatus("applied")).toBe(true);
    expect(isSavedListingStatus("bogus")).toBe(false);
  });
});
