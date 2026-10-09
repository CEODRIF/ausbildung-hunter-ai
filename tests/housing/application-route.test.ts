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
const { findListingById } = await import("@/lib/housing/providers");

const listing = findListingById("demo", "demo-koln-2zz-balkon")!;
const appRow = {
  id: "app-1",
  user_id: "user-1",
  listing_ref: {
    provider: "demo",
    source_id: "demo-koln-2zz-balkon",
    title: listing.title,
    url: listing.listing_url,
  },
  title: listing.title,
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
    provider: "demo",
    sourceId: "demo-koln-2zz-balkon",
    context: { firstName: "Max", lastName: "Mustermann" },
  };

  it("requires authentication", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(unauthenticated());
    expect((await POST(req("POST", cleanBody))).status).toBe(401);
  });

  it("maps an unknown listing to 404 (before any AI call)", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    const res = await POST(
      req("POST", { ...cleanBody, sourceId: "nope" }),
    );
    expect(res.status).toBe(404);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("creates a prepared application with the AI draft", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    const res = await POST(req("POST", cleanBody));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      application: { id: string; status: string; message_draft: string };
      ai_assisted: boolean;
    };
    expect(data.application.id).toBe("app-1");
    expect(data.application.status).toBe("prepared");
    expect(data.ai_assisted).toBe(true);
    const insert = adminMock.calls.find(
      (c) => c.table === "housing_applications" && c.op === "insert",
    );
    expect(insert?.args[0]).toMatchObject({ user_id: "user-1", status: "prepared" });
  });

  it("falls back to a deterministic draft (ai_assisted=false) when the AI fails", async () => {
    mockGenerate.mockRejectedValue(new Error("AI down"));
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    const res = await POST(req("POST", cleanBody));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ai_assisted: boolean };
    expect(data.ai_assisted).toBe(false);
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
