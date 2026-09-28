import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildCacheKey, searchOpportunities } from "@/lib/opportunities/search";
import {
  OPPORTUNITY_SCHEMA_VERSION,
  type Opportunity,
} from "@/lib/opportunities/types";

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

function setAdminMock(options: Parameters<typeof createAdminMock>[0] = {}) {
  adminMock = createAdminMock(options);
  vi.mocked(createAdminClient).mockReturnValue(adminMock.admin as never);
}

/** Extract the cached payload written by the most recent upsert. */
function lastCachePayload(): {
  cache_key: string;
  schema_version: number;
  result: Record<string, unknown>;
} {
  const upsert = adminMock.calls.find(
    (call) => call.table === "opportunity_cache" && call.op === "upsert",
  );
  return upsert?.args[0] as never;
}

beforeEach(() => {
  setAdminMock();
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

  it("is version-prefixed with the current schema version", () => {
    expect(buildCacheKey(baseParams())).toMatch(
      new RegExp(`^v${OPPORTUNITY_SCHEMA_VERSION}:`),
    );
  });

  it("upstream (page) mode includes the page in the key", () => {
    expect(buildCacheKey(baseParams({ page: 1 }))).not.toBe(
      buildCacheKey(baseParams({ page: 2 })),
    );
    expect(buildCacheKey(baseParams())).toMatch(
      new RegExp(`^v${OPPORTUNITY_SCHEMA_VERSION}:page:`),
    );
  });

  it("scan mode excludes the page (page-independent window) and match", () => {
    const a = buildCacheKey(baseParams({ role: "Kaufmann", page: 1 }));
    const b = buildCacheKey(baseParams({ role: "Kaufmann", page: 2 }));
    expect(a).toBe(b);
    expect(a).toMatch(new RegExp(`^v${OPPORTUNITY_SCHEMA_VERSION}:scan:`));
    expect(buildCacheKey(baseParams({ role: "Kaufmann", match: false }))).toBe(
      buildCacheKey(baseParams({ role: "Kaufmann", match: true })),
    );
  });

  it("changes with the provider query (filters, sort, goal, freshness)", () => {
    const base = buildCacheKey(baseParams());
    expect(buildCacheKey(baseParams({ location: "Hamburg" }))).not.toBe(base);
    expect(buildCacheKey(baseParams({ goal: "ausbildung" }))).not.toBe(base);
    expect(buildCacheKey(baseParams({ freshness: "14d" }))).not.toBe(base);
    expect(buildCacheKey(baseParams({ sort: "newest" }))).not.toBe(base);
    expect(buildCacheKey(baseParams({ employment: "full_time" }))).not.toBe(
      base,
    );
    expect(buildCacheKey(baseParams({ salary_documented: true }))).not.toBe(
      base,
    );
  });
});

describe("shared cache content (user-independent, no match data)", () => {
  it("stores normalized source data with mode/window and no match/user data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(searchArbeit)),
    );
    await searchOpportunities(baseParams({ match: false }), null);
    const payload = lastCachePayload();
    expect(payload.schema_version).toBe(OPPORTUNITY_SCHEMA_VERSION);
    const result = payload.result as {
      mode: string;
      window: Array<{ match: unknown; user_id?: unknown }>;
      total: number;
      scan_truncated: boolean;
      exhausted: boolean;
      generated_at: string;
    };
    expect(result.mode).toBe("upstream");
    expect(result.window).toHaveLength(2);
    for (const row of result.window) {
      expect(row.match).toBeNull();
      expect(row).not.toHaveProperty("user_id");
    }
  });

  it("filters cached rows by the current schema version and a valid expiry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(searchArbeit)),
    );
    await searchOpportunities(baseParams(), null);
    // The final filter call carries the accumulated filter snapshot.
    const gte = adminMock.calls.find(
      (call) => call.table === "opportunity_cache" && call.op === "gte",
    );
    expect(gte).toBeDefined();
    expect(gte?.filters["eq:schema_version"]).toBe(OPPORTUNITY_SCHEMA_VERSION);
    expect(gte?.filters["eq:cache_key"]).toMatch(
      new RegExp(`^v${OPPORTUNITY_SCHEMA_VERSION}:(page|scan):`),
    );
    expect(typeof gte?.filters["gte:expires_at"]).toBe("string");
  });

  it("prunes expired rows and stale schema versions on write", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(searchArbeit)),
    );
    await searchOpportunities(baseParams(), null);
    const deleteCall = adminMock.calls.find(
      (call) => call.table === "opportunity_cache" && call.op === "or",
    );
    expect(deleteCall).toBeDefined();
    expect(String(deleteCall?.args[0])).toContain(
      `schema_version.lt.${OPPORTUNITY_SCHEMA_VERSION}`,
    );
    expect(String(deleteCall?.args[0])).toContain("expires_at.lt.");
  });

  it("applies the per-user match only after a cache hit (and never re-stores it)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(searchArbeit)),
    );
    await searchOpportunities(baseParams({ match: false }), null);
    const payload = lastCachePayload();

    // Simulate a cache hit returning the row we just stored.
    setAdminMock({
      maybeSingleData: (table) =>
        table === "opportunity_cache"
          ? { result: payload.result }
          : table === "candidate_profiles"
            ? { profile_json: candidateProfileFixture() }
            : null,
    });

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

  it("reuses a cached scan window across pages without re-hitting the provider", async () => {
    // A small exhausted scan window (2 matched items, source ended).
    const fetchMock = vi.fn(async (url: string | URL) =>
      jsonResponse(
        new URL(String(url)).searchParams.get("page") === "1"
          ? {
              ergebnisliste: [
                {
                  referenznummer: "W-1-S",
                  stellenangebotsTitel: "Servicekraft Job",
                  stellenangebotsart: "ARBEIT",
                  hauptberuf: "Servicekraft",
                  datumErsteVeroeffentlichung: "2026-09-28",
                },
                {
                  referenznummer: "W-2-S",
                  stellenangebotsTitel: "Koch Job",
                  stellenangebotsart: "ARBEIT",
                  hauptberuf: "Koch",
                  datumErsteVeroeffentlichung: "2026-09-27",
                },
              ],
              maxErgebnisse: 2,
            }
          : { ergebnisliste: [], maxErgebnisse: 2 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    setAdminMock();
    const first = await searchOpportunities(
      baseParams({ role: "Servicekraft", pageSize: 20 }),
      null,
    );
    expect(first.mode).toBe("scan");
    expect(first.total).toBe(1); // only the Servicekraft item matches
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    const payload = lastCachePayload();

    // Page 2 must be served from the cached window — no new provider call.
    setAdminMock({
      maybeSingleData: (table) =>
        table === "opportunity_cache" ? { result: payload.result } : null,
    });
    const before = fetchMock.mock.calls.length;
    const second = await searchOpportunities(
      baseParams({ role: "Servicekraft", page: 2, pageSize: 20 }),
      null,
    );
    expect(second.results).toHaveLength(0); // window has only 1 item
    expect(fetchMock.mock.calls.length).toBe(before); // no new provider call
  });

  it("reports match_available=false and match=null without a candidate profile", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(searchArbeit)),
    );
    setAdminMock({ maybeSingleData: () => null });
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
    expect(response.mode).toBe("upstream");
    expect(response.match_available).toBe(false);
  });
});

describe("sorting + pagination semantics (search layer)", () => {
  function mkOpp(
    id: string,
    overrides: Partial<Opportunity> = {},
  ): Opportunity {
    return {
      id: `arbeitsagentur:${id}`,
      provider: "arbeitsagentur",
      external_id: id,
      source_name: "S",
      source_url: `https://example.test/${id}`,
      application_url: null,
      title: `Title ${id}`,
      goal: "arbeit",
      stellenangebotsart: "ARBEIT",
      company_name: null,
      company_url: null,
      location: null,
      location_detail: null,
      distance_km: null,
      latitude: null,
      longitude: null,
      profession: null,
      alternative_professions: [],
      description: null,
      tasks: [],
      requirements: [],
      employment_type: null,
      home_office: null,
      career_change_friendly: null,
      salary: null,
      training_type: null,
      education_requirement: null,
      valid_from: null,
      posted_at: null,
      updated_at: null,
      retrieved_at: "2026-09-28T00:00:00.000Z",
      contact: null,
      required_skills: [],
      preferred_skills: [],
      required_languages: [],
      extracted_keywords: [],
      match: null,
      ...overrides,
    } as Opportunity;
  }

  function stubWindow(items: Opportunity[]) {
    setAdminMock({
      maybeSingleData: (table) =>
        table === "opportunity_cache"
          ? {
              result: {
                mode: "scan",
                window: items,
                total: items.length,
                scan_truncated: false,
                exhausted: true,
                generated_at: new Date().toISOString(),
              },
            }
          : table === "candidate_profiles"
            ? { profile_json: candidateProfileFixture() }
            : null,
    });
  }

  // Cached windows are stored in their final (provider-sorted) order; the
  // search layer only slices (and, for sort=match, reorders in memory).
  const windowItems = [
    mkOpp("P3-S", {
      posted_at: "2026-09-01T00:00:00.000Z",
      salary: { amount: 30, unit: "hourly", label: "30" },
    }),
    mkOpp("P1-S", {
      posted_at: "2026-01-05T00:00:00.000Z",
      salary: { amount: 15, unit: "hourly", label: "15" },
    }),
    mkOpp("P2-S", { posted_at: null, salary: null }),
  ];

  it("slices pages from the scan window without duplicates", async () => {
    stubWindow(windowItems);
    const page1 = await searchOpportunities(
      baseParams({ sort: "newest", page: 1, pageSize: 2 }),
      null,
    );
    const page2 = await searchOpportunities(
      baseParams({ sort: "newest", page: 2, pageSize: 2 }),
      null,
    );
    const all = [...page1.results, ...page2.results].map((o) => o.id);
    expect(new Set(all).size).toBe(all.length); // no duplicates across pages
    expect(page1.results.map((o) => o.id)).toEqual([
      "arbeitsagentur:P3-S",
      "arbeitsagentur:P1-S",
    ]);
    expect(page2.results.map((o) => o.id)).toEqual([
      "arbeitsagentur:P2-S", // undated sorts last
    ]);
  });

  it("sort=match without a match request normalizes to relevance", async () => {
    stubWindow(windowItems);
    const response = await searchOpportunities(
      baseParams({ sort: "match", match: false, pageSize: 10 }),
      { userId: "user-1" },
    );
    // Profile exists but match was not requested: no scores, window order.
    expect(response.match_available).toBe(false);
    expect(response.results.map((o) => o.id)).toEqual(
      windowItems.map((o) => o.id),
    );
  });

  it("sort=match orders the window by the user's per-user score (in-memory only)", async () => {
    stubWindow(windowItems);
    const response = await searchOpportunities(
      baseParams({ sort: "match", match: true, pageSize: 10 }),
      { userId: "user-1" },
    );
    expect(response.match_available).toBe(true);
    const scores = response.results.map((o) => o.match?.match_score ?? -1);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  });

  it("upstream mode returns exactly one page of results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(searchArbeit)),
    );
    setAdminMock();
    const response = await searchOpportunities(
      baseParams({ page: 1, pageSize: 20 }),
      null,
    );
    expect(response.mode).toBe("upstream");
    expect(response.results).toHaveLength(2);
    expect(response.total).toBe(searchArbeit.maxErgebnisse);
  });
});
