import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
const { getCurrentUserAndProfile } = await import("@/lib/auth");

// Offline: the default Nominatim geocoder must never run in route tests.
vi.mock("@/lib/housing/geocode", () => ({
  geocodePlace: vi.fn(async () => null),
  clearGeocodeCache: vi.fn(),
  geocodeUserAgent: () => "test-agent",
}));

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

const { POST } = await import("@/app/api/housing/search/route");

type AuthResult = Awaited<ReturnType<typeof getCurrentUserAndProfile>>;
const authed = (id: string): AuthResult =>
  ({ user: { id }, profile: null }) as unknown as AuthResult;
const unauthenticated = (): AuthResult =>
  ({ user: null, profile: null }) as unknown as AuthResult;

function req(body: unknown) {
  return new Request("http://localhost/api/housing/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe("POST /api/housing/search", () => {
  it("requires authentication", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(unauthenticated());
    const res = await POST(req({}));
    expect(res.status).toBe(401);
  });

  it("rejects unknown fields (strict schema) with 400", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    const res = await POST(req({ city: "Köln", injected_price: 1 }));
    expect(res.status).toBe(400);
  });

  it("returns labeled demo results for a valid body", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    const res = await POST(req({ city: "Köln" }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      is_demo: boolean;
      data_status: string;
      total: number;
      listings: Array<{ data_status: string; listing_url: string }>;
    };
    expect(data.is_demo).toBe(true);
    expect(data.data_status).toBe("demo");
    expect(data.total).toBe(data.listings.length);
    for (const l of data.listings) {
      expect(l.data_status).toBe("demo");
      expect(l.listing_url).toMatch(/^https?:\/\//);
    }
  });

  it("returns 429 when rate-limited", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      count: 11,
      limit: 10,
      retryAfterSeconds: 30,
    });
    const res = await POST(req({}));
    expect(res.status).toBe(429);
  });

  it("rejects out-of-range pagination (limit 1..100, offset 0..10000) with 400", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    for (const body of [
      { limit: 0 },
      { limit: 101 },
      { offset: -1 },
      { offset: 10001 },
      { limit: 2.5 },
    ]) {
      const res = await POST(req(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("pages server-side: limit/offset, stable total, has_more, radius_applied", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    const page1 = (await (await POST(req({ limit: 3, offset: 0 }))).json()) as {
      listings: unknown[];
      total: number;
      has_more: boolean;
      radius_applied: boolean;
    };
    expect(page1.listings).toHaveLength(3);
    expect(page1.total).toBeGreaterThan(3); // 10 demo fixtures
    expect(page1.has_more).toBe(true);
    expect(page1.radius_applied).toBe(false); // no city → no radius

    const tail = (await (await POST(req({ limit: 3, offset: page1.total - 1 }))).json()) as {
      listings: unknown[];
      total: number;
      has_more: boolean;
    };
    expect(tail.listings).toHaveLength(1);
    expect(tail.total).toBe(page1.total); // stable pre-pagination total
    expect(tail.has_more).toBe(false);

    // Pages do not overlap.
    const seen = new Set(
      page1.listings.map((l) => (l as { source_id: string }).source_id),
    );
    const page3 = (await (await POST(req({ limit: 3, offset: 3 }))).json()) as {
      listings: Array<{ source_id: string }>;
    };
    for (const listing of page3.listings) expect(seen.has(listing.source_id)).toBe(false);
  });
});
