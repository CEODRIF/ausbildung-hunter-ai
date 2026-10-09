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
const { findListingById } = await import("@/lib/housing/providers");

const listing = findListingById("demo", "demo-koln-2zz-balkon")!;

const savedRow = {
  id: "sl-1",
  user_id: "user-1",
  provider: "demo",
  source_listing_id: "demo-koln-2zz-balkon",
  url: listing.listing_url,
  snapshot: listing,
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
  it("re-derives the snapshot from the source and keys it by the session user", async () => {
    const row = await saveHousingListing("user-1", "demo", "demo-koln-2zz-balkon", "note");
    expect(row.id).toBe("sl-1");
    const upsert = adminMock.calls.find(
      (c) => c.table === "housing_saved_listings" && c.op === "upsert",
    );
    expect(upsert).toBeDefined();
    const payload = upsert?.args[0] as Record<string, unknown>;
    expect(payload.user_id).toBe("user-1");
    expect(payload.provider).toBe("demo");
    expect(payload.source_listing_id).toBe("demo-koln-2zz-balkon");
    // Snapshot is the server-derived fixture, not anything a client could send.
    const snapshot = payload.snapshot as { title: string; rent_warm_eur: number };
    expect(snapshot.title).toBe(listing.title);
    expect(snapshot.rent_warm_eur).toBe(listing.rent_warm_eur);
    expect(payload.notes).toBe("note");
    expect(upsert?.args[1]).toEqual({
      onConflict: "user_id,provider,source_listing_id",
      ignoreDuplicates: true,
    });
  });

  it("only writes the migrated columns", async () => {
    const MIGRATED = new Set([
      "user_id",
      "provider",
      "source_listing_id",
      "url",
      "snapshot",
      "notes",
      "status",
    ]);
    await saveHousingListing("user-1", "demo", "demo-koln-2zz-balkon");
    const upsert = adminMock.calls.find(
      (c) => c.table === "housing_saved_listings" && c.op === "upsert",
    );
    const payload = upsert?.args[0] as Record<string, unknown>;
    for (const key of Object.keys(payload)) {
      expect(MIGRATED.has(key)).toBe(true);
    }
  });

  it("rejects an unknown listing id (no fabrication, no write)", async () => {
    await expect(
      saveHousingListing("user-1", "demo", "does-not-exist"),
    ).rejects.toThrow();
    expect(
      adminMock.calls.some(
        (c) => c.table === "housing_saved_listings" && c.op === "upsert",
      ),
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
    await removeSavedListing("user-A", "demo", "demo-koln-2zz-balkon");
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
