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
}));
const { runHousingWebSearch } = await import("@/lib/housing/web-search/discovery");

const { POST } = await import("@/app/api/housing/web-search/route");
const { GET } = await import("@/app/api/housing/web-search/domains/route");
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
    ["invalid availability date format", { mode: "web", params: { available_before: "2026.11.01" } }],
    ["rooms out of range", { mode: "web", params: { rooms: 11 } }],
    ["rent out of range", { mode: "web", params: { max_warm_rent: 99999 } }],
    ["radius out of range", { mode: "web", params: { radius_km: 101 } }],
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
  });

});

describe("GET /api/housing/web-search/domains", () => {
  it("requires authentication", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(unauthenticated());
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("lists the allowlist with fetchability (no internal rationale leaks to the client)", async () => {
    const res = await GET();
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
