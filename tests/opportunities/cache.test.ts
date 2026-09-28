import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCacheKey,
  fetchOpportunities,
  searchOpportunities,
} from "@/lib/opportunities/search";

const { createAdminMock, candidateProfileFixture, baseParams, jsonResponse } =
  await import("../helpers");
const searchArbeit = (await import("../fixtures/ba-search-arbeit.json")) as {
  ergebnisliste: Record<string, unknown>[];
  maxErgebnisse: number;
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));
const { createAdminClient } = await import("@/lib/supabase/admin");

let adminMock: Awaited<ReturnType<typeof createAdminMock>>;

beforeEach(() => {
  adminMock = createAdminMock();
  vi.mocked(createAdminClient).mockReturnValue(adminMock.admin as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("buildCacheKey", () => {
  it("is user-independent: the match flag does not change the key", () => {
    expect(buildCacheKey(baseParams({ match: false }))).toBe(
      buildCacheKey(baseParams({ match: true })),
    );
  });

  it("is version-prefixed", () => {
    expect(buildCacheKey(baseParams())).toMatch(/^v2:/);
  });

  it("changes with the provider query", () => {
    const base = buildCacheKey(baseParams());
    expect(buildCacheKey(baseParams({ location: "Hamburg" }))).not.toBe(base);
    expect(buildCacheKey(baseParams({ goal: "ausbildung" }))).not.toBe(base);
    expect(buildCacheKey(baseParams({ freshness: "14d" }))).not.toBe(base);
    expect(buildCacheKey(baseParams({ page: 2 }))).not.toBe(base);
  });
});

describe("shared cache content", () => {
  it("stores normalized source data without any match/user data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(searchArbeit)),
    );
    await fetchOpportunities(baseParams({ match: false }));
    const upsert = adminMock.calls.find(
      (call) => call.table === "opportunity_cache" && call.op === "upsert",
    );
    expect(upsert).toBeDefined();
    const payload = upsert?.args[0] as {
      schema_version: number;
      result: {
        results: Array<{ match: unknown; user_id?: unknown }>;
        total: number;
        scan_truncated: boolean;
        generated_at: string;
      };
    };
    expect(payload.schema_version).toBe(2);
    expect(payload.result.results).toHaveLength(2);
    for (const row of payload.result.results) {
      expect(row.match).toBeNull();
      expect(row).not.toHaveProperty("user_id");
    }
  });

  it("filters cached rows by the current schema version and a valid expiry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(searchArbeit)),
    );
    await fetchOpportunities(baseParams());
    // The final filter call carries the accumulated filter snapshot.
    const gte = adminMock.calls.find(
      (call) => call.table === "opportunity_cache" && call.op === "gte",
    );
    expect(gte).toBeDefined();
    expect(gte?.filters["eq:schema_version"]).toBe(2);
    expect(gte?.filters["eq:cache_key"]).toMatch(/^v2:/);
    expect(typeof gte?.filters["gte:expires_at"]).toBe("string");
  });

  it("prunes expired rows and stale schema versions on write", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(searchArbeit)),
    );
    await fetchOpportunities(baseParams());
    const deleteCall = adminMock.calls.find(
      (call) => call.table === "opportunity_cache" && call.op === "or",
    );
    expect(deleteCall).toBeDefined();
    expect(String(deleteCall?.args[0])).toContain("schema_version.lt.2");
    expect(String(deleteCall?.args[0])).toContain("expires_at.lt.");
  });

  it("applies the per-user match only after a cache hit (and never re-stores it)", async () => {
    // A cache row written by an earlier (unmatched) search.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(searchArbeit)),
    );
    const first = await fetchOpportunities(baseParams({ match: false }));

    // Now simulate a cache hit for the same key.
    adminMock = createAdminMock({
      maybeSingleData: (table) =>
        table === "opportunity_cache"
          ? {
              result: {
                results: first.results.map((row) => ({
                  ...row,
                  match: null,
                })),
                total: first.total,
                scan_truncated: false,
                generated_at: new Date().toISOString(),
              },
            }
          : table === "candidate_profiles"
            ? { profile_json: candidateProfileFixture() }
            : null,
    });
    vi.mocked(createAdminClient).mockReturnValue(adminMock.admin as never);

    const response = await searchOpportunities(baseParams({ match: true }), {
      userId: "user-1",
    });
    expect(response.match_available).toBe(true);
    expect(response.results[0].match).not.toBeNull();
    expect(response.results[0].match?.match_score).toBeGreaterThanOrEqual(0);
    // Cache hit path must not write anything back.
    expect(
      adminMock.calls.filter(
        (call) => call.table === "opportunity_cache" && call.op === "upsert",
      ),
    ).toHaveLength(0);
  });

  it("reports match_available=false and match=null without a candidate profile", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(searchArbeit)),
    );
    adminMock = createAdminMock({ maybeSingleData: () => null });
    vi.mocked(createAdminClient).mockReturnValue(adminMock.admin as never);
    const response = await searchOpportunities(baseParams({ match: true }), {
      userId: "user-1",
    });
    expect(response.match_available).toBe(false);
    expect(response.results.every((row) => row.match === null)).toBe(true);
  });

  it("does not require authentication data when match is not requested", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(searchArbeit)),
    );
    const response = await searchOpportunities(
      baseParams({ match: false }),
      null,
    );
    expect(response.results).toHaveLength(2);
    expect(response.match_available).toBe(false);
  });
});
