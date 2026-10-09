import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAdminMock } = await import("../helpers");

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
const { createAdminClient } = await import("@/lib/supabase/admin");

vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
const { getCurrentUserAndProfile } = await import("@/lib/auth");

const { mockGenerate } = vi.hoisted(() => ({ mockGenerate: vi.fn() }));
vi.mock("@/lib/ai-service", () => ({
  provider: () => ({ generateText: mockGenerate }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    count: 1,
    limit: 5,
    retryAfterSeconds: 0,
  })),
  tooManyRequests: () =>
    new Response(JSON.stringify({ error: "Too many requests." }), { status: 429 }),
}));
const { checkRateLimit } = await import("@/lib/rate-limit");

const { POST, GET, PATCH } = await import("@/app/api/housing/application/route");

const appRow = {
  id: "app-1",
  user_id: "user-1",
  listing_ref: {
    provider: "example-licensed-provider",
    source_id: "src-1",
    title: "2-Zimmer-Wohnung in Köln-Ehrenfeld",
    url: "https://immobilienscout24.de/expose/123456789",
  },
  title: "2-Zimmer-Wohnung in Köln-Ehrenfeld",
  message_draft: "AI draft",
  status: "prepared",
  timeline: [{ status: "prepared", at: "2026-10-09T00:00:00.000Z" }],
  created_at: "2026-10-09T00:00:00.000Z",
  updated_at: "2026-10-09T00:00:00.000Z",
};

type AuthResult = Awaited<ReturnType<typeof getCurrentUserAndProfile>>;
const authed = (id: string): AuthResult =>
  ({ user: { id }, profile: null }) as unknown as AuthResult;
const unauthenticated = (): AuthResult =>
  ({ user: null, profile: null }) as unknown as AuthResult;

function req(method: string, body: unknown) {
  return new Request("http://localhost/api/housing/application", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let adminMock: Awaited<ReturnType<typeof createAdminMock>>;
beforeEach(() => {
  adminMock = createAdminMock({
    singleData: (table) => (table === "housing_applications" ? appRow : null),
    maybeSingleData: (table) => (table === "housing_applications" ? appRow : null),
  });
  vi.mocked(createAdminClient).mockReturnValue(adminMock.admin as never);
  mockGenerate.mockReset().mockResolvedValue("AI draft");
  vi.clearAllMocks();
});
afterEach(() => vi.clearAllMocks());

describe("POST /api/housing/application", () => {
  const cleanBody = {
    provider: "example-licensed-provider",
    sourceId: "src-1",
    context: { firstName: "Max", lastName: "Mustermann" },
  };

  it("requires authentication", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(unauthenticated());
    expect((await POST(req("POST", cleanBody))).status).toBe(401);
  });

  it("maps EVERY listing to 404 while no adapter is registered — the listing is never fabricated, and no AI call happens", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    for (const sourceId of ["src-1", "demo-koln-2zz-balkon", "nope"]) {
      const res = await POST(req("POST", { ...cleanBody, sourceId }));
      expect(res.status).toBe(404);
    }
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(
      adminMock.calls.some((c) => c.table === "housing_applications" && c.op === "insert"),
    ).toBe(false);
  });

  it("returns 429 when rate-limited", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      count: 6,
      limit: 5,
      retryAfterSeconds: 60,
    });
    expect((await POST(req("POST", cleanBody))).status).toBe(429);
  });
});

describe("GET + PATCH /api/housing/application", () => {
  it("GET requires authentication", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(unauthenticated());
    expect((await GET()).status).toBe(401);
  });

  it("PATCH rejects an invalid status with 400", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    const res = await PATCH(req("PATCH", { id: "app-1", status: "bogus" }));
    expect(res.status).toBe(400);
  });

  it("PATCH updates a valid status", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    const res = await PATCH(req("PATCH", { id: "app-1", status: "viewing" }));
    expect(res.status).toBe(200);
    const update = adminMock.calls.find(
      (c) => c.table === "housing_applications" && c.op === "update",
    );
    expect(update?.args[0]).toMatchObject({ status: "viewing" });
  });
});
