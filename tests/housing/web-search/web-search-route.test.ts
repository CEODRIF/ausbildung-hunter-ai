import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
const { getCurrentUserAndProfile } = await import("@/lib/auth");

// Fully mocked (the real module drags in the Supabase admin client); the
// per-scope budget table itself is regression-tested in tests/rate-limit.test.ts,
// which iterates EVERY scope — including "housing_web_search".
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    count: 1,
    limit: 10,
    retryAfterSeconds: 0,
  })),
  rateLimitHeaders: () => ({}),
  tooManyRequests: () =>
    new Response(JSON.stringify({ error: "Too many requests." }), { status: 429 }),
}));
const { checkRateLimit } = await import("@/lib/rate-limit");

vi.mock("@/lib/housing/web-search/discovery", () => ({
  runHousingWebSearch: vi.fn(),
  ZERO_FUNNEL: {
    providerCalls: 0,
    webSearchCalls: 0,
    rawCandidates: 0,
    uniqueCandidates: 0,
    invalidUrls: 0,
    searchPagesRejected: 0,
    cityMismatches: 0,
    duplicateResults: 0,
    offAllowlist: 0,
    jsonItems: 0,
    jsonMatched: 0,
    fabricatedRejected: 0,
    detailsEnriched: 0,
    imagesAttached: 0,
    validListings: 0,
    displayedListings: 0,
    elapsedMs: 0,
  },
}));
const { runHousingWebSearch, ZERO_FUNNEL } = await import("@/lib/housing/web-search/discovery");

vi.mock("@/lib/housing/web-search/quota", () => ({
  reserveHousingWebSearch: vi.fn(async () => ({ status: "reserved", used: 1, remaining: 19 })),
  releaseHousingWebSearch: vi.fn(async () => true),
  completeHousingWebSearch: vi.fn(async () => true),
  getHousingWebSearchStatus: vi.fn(async () => ({
    limit: 20,
    used: 0,
    remaining: 20,
    usageDate: "2026-10-09",
    resetsAt: "2026-10-09T23:00:00.000Z",
  })),
  getHousingWebSearchDailyLimit: () => 20,
  nextBerlinMidnight: () => new Date("2026-10-09T23:00:00.000Z"),
}));
const {
  reserveHousingWebSearch,
  releaseHousingWebSearch,
  completeHousingWebSearch,
  getHousingWebSearchStatus,
} = await import("@/lib/housing/web-search/quota");

const { POST, GET: GET_QUOTA } = await import("@/app/api/housing/web-search/route");
const { GET: GET_DOMAINS } = await import("@/app/api/housing/web-search/domains/route");
import type { HousingWebSearchOutcome } from "@/lib/housing/web-search/discovery";

type AuthResult = Awaited<ReturnType<typeof getCurrentUserAndProfile>>;
const authed = (id: string): AuthResult =>
  ({ user: { id }, profile: null }) as unknown as AuthResult;
const unauthenticated = (): AuthResult =>
  ({ user: null, profile: null }) as unknown as AuthResult;

function req(body: unknown) {
  return new Request("http://localhost/api/housing/web-search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeOutcome(over: Record<string, unknown> = {}): HousingWebSearchOutcome {
  return {
    status: "ok",
    message: null,
    provider: "azure",
    mode: "web",
    listings: [],
    citations: [],
    queries: [],
    stats: { searchCalls: 0, pagesFetched: 0, bingRequests: null },
    funnel: { ...ZERO_FUNNEL },
    warnings: [] as string[],
    cached: false,
    fetchedAt: "2025-10-09T00:00:00.000Z",
    ...over,
  } as HousingWebSearchOutcome;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    count: 1,
    limit: 10,
    retryAfterSeconds: 0,
  });
});

afterEach(() => vi.clearAllMocks());

describe("POST /api/housing/web-search", () => {
  it("requires authentication", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(unauthenticated());
    const res = await POST(req({}));
    expect(res.status).toBe(401);
    expect(vi.mocked(runHousingWebSearch)).not.toHaveBeenCalled();
  });

  it("returns 429 when the per-user hourly budget is exhausted", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      count: 11,
      limit: 10,
      retryAfterSeconds: 300,
    });
    const res = await POST(req({}));
    expect(res.status).toBe(429);
    expect(vi.mocked(runHousingWebSearch)).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies with 400", async () => {
    const bad = new Request("http://localhost/api/housing/web-search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect((await POST(bad)).status).toBe(400);
  });

  it.each([
    ["unknown top-level field", { mode: "web", params: {}, hacker: true }],
    ["unknown param field", { mode: "web", params: { city: "Köln", injected_price: 1 } }],
    ["invalid mode", { mode: "deep", params: {} }],
    ["invalid availability date format", { mode: "web", params: { available_before: "2026.13.01" } }],
    ["rooms out of range", { mode: "web", params: { rooms: 11 } }],
    ["rent out of range", { mode: "web", params: { max_warm_rent: 99999 } }],
    ["radius out of range", { mode: "web", params: { radius_km: 101 } }],
    ["invalid request_id (non-uuid)", { mode: "web", params: {}, request_id: "not-a-uuid" }],
    ["too many domains", { mode: "targeted", params: {}, domains: Array.from({ length: 101 }, (_, i) => `d${i}.de`) }],
  ])("rejects %s with 400", async (_name, body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect(vi.mocked(runHousingWebSearch)).not.toHaveBeenCalled();
  });

  it("maps pipeline outcomes to 200 with a machine-readable status (not_configured)", async () => {
    vi.mocked(runHousingWebSearch).mockResolvedValue(
      makeOutcome({ status: "not_configured", message: "no_search_provider" }),
    );
    const res = await POST(req({ mode: "web", params: { city: "Köln" } }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("not_configured");
  });

  it("returns verified listings on success", async () => {
    vi.mocked(runHousingWebSearch).mockResolvedValue(
      makeOutcome({
        listings: [{ provider: "web-search", listing_url: "https://open.nrw/dataset/x", data_status: "live" }],
        citations: [{ url: "https://open.nrw/dataset/x", title: "t" }],
      }),
    );
    const res = await POST(req({ mode: "web", params: { city: "Köln" } }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { listings: unknown[]; citations: unknown[] };
    expect(data.listings).toHaveLength(1);
    expect(data.citations).toHaveLength(1);
  });

  it("passes the count-only funnel diagnostics through to the client", async () => {
    vi.mocked(runHousingWebSearch).mockResolvedValue(
      makeOutcome({
        funnel: {
          ...ZERO_FUNNEL,
          providerCalls: 1,
          webSearchCalls: 1,
          rawCandidates: 15,
          uniqueCandidates: 12,
          invalidUrls: 0,
          searchPagesRejected: 2,
          cityMismatches: 0,
          duplicateResults: 3,
          jsonItems: 10,
          jsonMatched: 8,
          fabricatedRejected: 0,
          validListings: 9,
          displayedListings: 7,
        },
      }),
    );
    const res = await POST(req({ mode: "web", params: { city: "Berlin" } }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { funnel: Record<string, number> };
    expect(data.funnel).toMatchObject({
      rawCandidates: 15,
      uniqueCandidates: 12,
      searchPagesRejected: 2,
      duplicateResults: 3,
      validListings: 9,
      displayedListings: 7,
    });
  });

  it("drops non-allowlisted domains server-side and reports them as a warning", async () => {
    const outcome = makeOutcome();
    vi.mocked(runHousingWebSearch).mockResolvedValue(outcome);
    const res = await POST(
      req({
        mode: "targeted",
        params: {},
        domains: ["immobilienscout24.de", "open.nrw", "evil.example"],
      }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(runHousingWebSearch)).toHaveBeenCalledWith({
      mode: "targeted",
      params: expect.objectContaining({ city: "" }),
      domains: ["immobilienscout24.de", "open.nrw"],
    });
    expect(outcome.warnings).toContain("domains_rejected:evil.example");
  });

  it("returns a controlled 502 (no internals) when the pipeline throws unexpectedly", async () => {
    vi.mocked(runHousingWebSearch).mockRejectedValue(new Error("SECRETS: sk-live-abc123 stacktrace..."));
    const res = await POST(req({ mode: "web", params: {} }));
    expect(res.status).toBe(502);
    const data = (await res.json()) as { status: string; message: string };
    expect(data.status).toBe("provider_error");
    expect(data.message).not.toContain("sk-live-abc123");
    expect(data.message).not.toContain("stacktrace");
    // The reserved slot is refunded on unexpected failure.
    expect(vi.mocked(releaseHousingWebSearch)).toHaveBeenCalled();
  });
});

describe("per-user daily quota (server-side, before any provider call)", () => {
  it("reserves a slot BEFORE the provider and settles it as succeeded on success", async () => {
    vi.mocked(runHousingWebSearch).mockResolvedValue(makeOutcome());
    const res = await POST(req({ mode: "web", params: {}, request_id: "11111111-1111-4111-8111-111111111111" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(reserveHousingWebSearch)).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(vi.mocked(completeHousingWebSearch)).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(vi.mocked(releaseHousingWebSearch)).not.toHaveBeenCalled();
    const data = (await res.json()) as { quota: { used: number; remaining: number; limit: number } };
    expect(data.quota).toMatchObject({ limit: 20, used: 1, remaining: 19 });
  });

  it("generates its own idempotency key when the client sends none", async () => {
    vi.mocked(runHousingWebSearch).mockResolvedValue(makeOutcome());
    await POST(req({ mode: "web", params: {} }));
    const runId = vi.mocked(reserveHousingWebSearch).mock.calls[0][0];
    expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("blocks at the limit WITHOUT calling the provider, and reports the reset time", async () => {
    vi.mocked(reserveHousingWebSearch).mockResolvedValueOnce({
      status: "quota_exhausted",
      used: 20,
      remaining: 0,
    });
    const res = await POST(req({ mode: "web", params: {} }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      status: string;
      listings: unknown[];
      quota: { used: number; remaining: number; resetsAt: string };
    };
    expect(data.status).toBe("daily_quota_exhausted");
    expect(data.listings).toEqual([]);
    expect(data.quota).toMatchObject({ used: 20, remaining: 0 });
    expect(data.quota.resetsAt).toBe("2026-10-09T23:00:00.000Z");
    expect(vi.mocked(runHousingWebSearch)).not.toHaveBeenCalled(); // no paid call
  });

  it("fails closed (no provider call) when the quota RPC itself fails", async () => {
    vi.mocked(reserveHousingWebSearch).mockResolvedValueOnce(null);
    const res = await POST(req({ mode: "web", params: {} }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; quota: null };
    expect(data.status).toBe("quota_unavailable");
    expect(data.quota).toBeNull();
    expect(vi.mocked(runHousingWebSearch)).not.toHaveBeenCalled();
  });

  it("refunds the slot for a result-cache hit (no paid call happened)", async () => {
    vi.mocked(runHousingWebSearch).mockResolvedValue(makeOutcome({ cached: true }));
    const res = await POST(req({ mode: "web", params: {}, request_id: "22222222-2222-4222-8222-222222222222" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(releaseHousingWebSearch)).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
    expect(vi.mocked(completeHousingWebSearch)).not.toHaveBeenCalled();
    const data = (await res.json()) as { quota: { used: number; remaining: number } };
    expect(data.quota).toMatchObject({ used: 0, remaining: 20 }); // refunded
  });

  it("refunds the slot for provider failures (user not charged for a failed search)", async () => {
    vi.mocked(runHousingWebSearch).mockResolvedValue(
      makeOutcome({ status: "tool_blocked", message: "tool blocked" }),
    );
    const res = await POST(req({ mode: "web", params: {}, request_id: "33333333-3333-4333-8333-333333333333" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(releaseHousingWebSearch)).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333");
    expect(vi.mocked(completeHousingWebSearch)).not.toHaveBeenCalled();
    const data = (await res.json()) as { status: string; quota: { used: number; remaining: number } };
    expect(data.status).toBe("tool_blocked");
    expect(data.quota).toMatchObject({ used: 0, remaining: 20 });
  });
});

describe("GET /api/housing/web-search (quota status)", () => {
  it("requires authentication", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(unauthenticated());
    const res = await GET_QUOTA();
    expect(res.status).toBe(401);
    expect(vi.mocked(getHousingWebSearchStatus)).not.toHaveBeenCalled();
  });

  it("reports the per-user remaining quota without consuming anything", async () => {
    const res = await GET_QUOTA();
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      status: string;
      quota: { limit: number; used: number; remaining: number; resetsAt: string };
    };
    expect(data.status).toBe("ok");
    expect(data.quota).toMatchObject({ limit: 20, used: 0, remaining: 20 });
    expect(data.quota.resetsAt).toBe("2026-10-09T23:00:00.000Z");
    expect(vi.mocked(reserveHousingWebSearch)).not.toHaveBeenCalled(); // read-only
  });

  it("answers an honest quota_unavailable when the status RPC failed", async () => {
    vi.mocked(getHousingWebSearchStatus).mockResolvedValueOnce(null);
    const res = await GET_QUOTA();
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; quota: null };
    expect(data.status).toBe("quota_unavailable");
    expect(data.quota).toBeNull();
  });
});

describe("GET /api/housing/web-search/domains", () => {
  it("requires authentication", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(unauthenticated());
    const res = await GET_DOMAINS();
    expect(res.status).toBe(401);
  });

  it("lists the allowlist with fetchability (no internal rationale leaks to the client)", async () => {
    const res = await GET_DOMAINS();
    expect(res.status).toBe(200);
    const data = (await res.json()) as { domains: Array<{ domain: string; label: string; fetchable: boolean }> };
    expect(data.domains.length).toBeGreaterThanOrEqual(6);
    for (const d of data.domains) {
      expect(d).toHaveProperty("domain");
      expect(d).toHaveProperty("label");
      expect(typeof d.fetchable).toBe("boolean");
    }
    const is24 = data.domains.find((d) => d.domain === "immobilienscout24.de");
    expect(is24?.fetchable).toBe(false);
    const nrw = data.domains.find((d) => d.domain === "open.nrw");
    expect(nrw?.fetchable).toBe(true);
  });
});
