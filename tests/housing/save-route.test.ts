import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAdminMock } = await import("../helpers");

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
const { createAdminClient } = await import("@/lib/supabase/admin");

vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
const { getCurrentUserAndProfile } = await import("@/lib/auth");

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    count: 1,
    limit: 10,
    retryAfterSeconds: 0,
  })),
  tooManyRequests: () =>
    new Response(JSON.stringify({ error: "Too many requests." }), { status: 429 }),
}));
const { checkRateLimit } = await import("@/lib/rate-limit");

const { GET, POST, DELETE } = await import("@/app/api/housing/save/route");

const searchRow = {
  id: "ss-1",
  user_id: "user-1",
  name: "Köln",
  query: { city: "Köln" },
  last_run_at: "2026-10-09T00:00:00.000Z",
  last_count: 2,
  created_at: "2026-10-09T00:00:00.000Z",
};

type AuthResult = Awaited<ReturnType<typeof getCurrentUserAndProfile>>;
const authed = (id: string): AuthResult =>
  ({ user: { id }, profile: null }) as unknown as AuthResult;
const unauthenticated = (): AuthResult =>
  ({ user: null, profile: null }) as unknown as AuthResult;

function req(url: string, body: unknown) {
  return new Request(`http://localhost/api/housing/save${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let adminMock: Awaited<ReturnType<typeof createAdminMock>>;
beforeEach(() => {
  adminMock = createAdminMock({
    singleData: (table) => (table === "housing_saved_searches" ? searchRow : null),
  });
  vi.mocked(createAdminClient).mockReturnValue(adminMock.admin as never);
  vi.clearAllMocks();
});
afterEach(() => vi.clearAllMocks());

describe("GET /api/housing/save", () => {
  it("requires authentication", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(unauthenticated());
    expect((await GET()).status).toBe(401);
  });

  it("returns both collections", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    const res = await GET();
    expect(res.status).toBe(200);
    const data = (await res.json()) as { listings: unknown[]; searches: unknown[] };
    expect(data.listings).toEqual([]);
    expect(data.searches).toEqual([]);
  });
});

describe("POST /api/housing/save", () => {
  it("rejects injected listing data (strict schema) with 400", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    const res = await POST(
      req("", { kind: "listing", provider: "demo", sourceId: "x", title: "FAKE" }),
    );
    expect(res.status).toBe(400);
    expect(
      adminMock.calls.some((c) => c.table === "housing_saved_listings" && c.op === "upsert"),
    ).toBe(false);
  });

  it("maps EVERY listing save to 404 while no adapter is registered — nothing can be re-derived, so nothing is fabricated", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    for (const [provider, sourceId] of [
      ["demo", "demo-koln-2zz-balkon"], // the old demo id — gone for good
      ["web-search", "is24-123456789"],
      ["nope", "nope"],
    ] as const) {
      const res = await POST(req("", { kind: "listing", provider, sourceId }));
      expect(res.status).toBe(404);
    }
    expect(
      adminMock.calls.some((c) => c.table === "housing_saved_listings" && c.op === "upsert"),
    ).toBe(false);
  });

  it("saves a search (kind=search)", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    const res = await POST(
      req("", { kind: "search", name: "Köln", query: { city: "Köln" }, lastCount: 2 }),
    );
    expect(res.status).toBe(200);
    const insert = adminMock.calls.find(
      (c) => c.table === "housing_saved_searches" && c.op === "insert",
    );
    expect(insert).toBeDefined();
  });

  it("returns 429 when rate-limited", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      count: 11,
      limit: 10,
      retryAfterSeconds: 30,
    });
    const res = await POST(req("", { kind: "listing", provider: "demo", sourceId: "x" }));
    expect(res.status).toBe(429);
  });
});

describe("DELETE /api/housing/save", () => {
  it("removes a saved listing scoped to the user", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    const res = await DELETE(
      new Request("http://localhost/api/housing/save", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "listing", provider: "web-search", sourceId: "is24-123456789" }),
      }),
    );
    expect(res.status).toBe(200);
    const del = adminMock.calls.find(
      (c) => c.table === "housing_saved_listings" && c.op === "delete",
    );
    expect(del).toBeDefined();
    const userScope = adminMock.calls.find(
      (c) =>
        c.table === "housing_saved_listings" && c.op === "eq" && c.args[0] === "user_id",
    );
    expect(userScope?.args[1]).toBe("user-1");
  });
});
