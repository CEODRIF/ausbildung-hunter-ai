import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitResult } from "@/lib/rate-limit";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
vi.mock("@/lib/ai-service", () => ({
  getAIContext: vi.fn(),
  prepareChat: vi.fn(),
  provider: vi.fn(),
  saveAssistantMessage: vi.fn(),
}));
vi.mock("@/lib/opportunities/search", () => ({
  OpportunityProviderError: class extends Error {},
  searchOpportunities: vi.fn(),
}));
vi.mock("@/lib/opportunities/saved", () => ({
  OpportunityNotFoundError: class extends Error {},
  OpportunityProviderError: class extends Error {},
  listSavedOpportunities: vi.fn(),
  removeSavedOpportunity: vi.fn(),
  saveOpportunityFromKey: vi.fn(),
  updateSavedOpportunityNotes: vi.fn(),
}));
vi.mock("@/lib/account-data", () => ({
  exportUserData: vi.fn(),
  deleteUserAccount: vi.fn(),
}));
vi.mock("@/lib/billing/admin", () => ({
  requireAdmin: vi.fn(),
  isUuid: (v: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  executeAdminAction: vi.fn(),
}));
vi.mock("@/lib/billing/admin-users", () => ({ listAdminUsers: vi.fn() }));

const { createClient } = await import("@/lib/supabase/server");
const { createAdminClient } = await import("@/lib/supabase/admin");
const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { prepareChat, provider } = await import("@/lib/ai-service");
const { searchOpportunities } = await import("@/lib/opportunities/search");
const { saveOpportunityFromKey } = await import("@/lib/opportunities/saved");
const { exportUserData, deleteUserAccount } =
  await import("@/lib/account-data");
const { requireAdmin } = await import("@/lib/billing/admin");
const { listAdminUsers } = await import("@/lib/billing/admin-users");
const {
  checkRateLimit,
  rateLimitKey,
  rateLimitHeaders,
  tooManyRequests,
  RATE_LIMITS,
} = await import("@/lib/rate-limit");

const USER_ID = "88888888-8888-4888-8888-888888888888";
const ADMIN_ID = "99999999-9999-4999-8999-999999999999";

function mockLimiter(result: {
  data?: Record<string, unknown> | null;
  error?: { message: string } | null;
}) {
  vi.mocked(createAdminClient).mockReturnValue({
    rpc: vi.fn().mockResolvedValue(result),
  } as never);
}

function deniedResult(scope: keyof typeof RATE_LIMITS) {
  const { max } = RATE_LIMITS[scope];
  return {
    data: {
      allowed: false,
      count: max + 1,
      limit: max,
      retry_after: 42,
    },
  };
}

function allowedResult(scope: keyof typeof RATE_LIMITS) {
  const { max } = RATE_LIMITS[scope];
  return { data: { allowed: true, count: 1, limit: max, retry_after: 0 } };
}

function mockSessionUser(userId: string | null) {
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: { user: userId ? { id: userId } : null },
      }),
    },
  } as never);
}

function mockProfile(userId: string | null, accountStatus = "active") {
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: userId ? { id: userId } : null,
    profile: userId
      ? { id: userId, email: "user@example.com", account_status: accountStatus }
      : null,
  } as never);
}

const denied = (r: RateLimitResult): RateLimitResult => r;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("rate-limit lib", () => {
  it("keys are scoped per session user: scope:<user_id>", () => {
    expect(rateLimitKey("ai_chat", USER_ID)).toBe(`ai_chat:${USER_ID}`);
    expect(rateLimitKey("admin_actions", ADMIN_ID)).not.toContain(USER_ID);
  });

  it("sends the documented budgets to the RPC", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue(allowedResult("opportunity_search").data);
    vi.mocked(createAdminClient).mockReturnValue({ rpc } as never);
    await checkRateLimit("opportunity_search", USER_ID);
    expect(rpc).toHaveBeenCalledWith("check_rate_limit", {
      limit_key: `opportunity_search:${USER_ID}`,
      max_requests: 10,
      window_seconds: 60,
    });
  });

  it("maps the RPC result to the JS shape", async () => {
    mockLimiter(deniedResult("ai_chat"));
    const result = await checkRateLimit("ai_chat", USER_ID);
    expect(result.allowed).toBe(false);
    expect(result.count).toBe(21);
    expect(result.limit).toBe(20);
    expect(result.retryAfterSeconds).toBe(42);
  });

  it("fails open when the RPC errors (limiter outage must not take the product down)", async () => {
    mockLimiter({ error: { message: "db down" } });
    const result = await checkRateLimit("ai_chat", USER_ID);
    expect(result.allowed).toBe(true);
  });

  it("fails open when the RPC returns no data", async () => {
    mockLimiter({ data: null });
    const result = await checkRateLimit("ai_chat", USER_ID);
    expect(result.allowed).toBe(true);
  });

  it("fails open when the limiter path throws (client without rpc, env missing)", async () => {
    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new Error("no env");
    });
    const result = await checkRateLimit("ai_chat", USER_ID);
    expect(result.allowed).toBe(true);
  });

  it("defines sane budgets for every scope (RPC bounds: max>=1, 1..86400 s)", () => {
    for (const scope of Object.keys(RATE_LIMITS) as Array<
      keyof typeof RATE_LIMITS
    >) {
      const { max, windowSeconds } = RATE_LIMITS[scope];
      expect(max).toBeGreaterThanOrEqual(1);
      expect(windowSeconds).toBeGreaterThanOrEqual(1);
      expect(windowSeconds).toBeLessThanOrEqual(86400);
    }
  });

  it("tooManyRequests: 429 + retry-after (>=1) + x-ratelimit-* headers", () => {
    const res = tooManyRequests(
      denied({
        allowed: false,
        count: 21,
        limit: 20,
        retryAfterSeconds: 42,
      }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(res.headers.get("x-ratelimit-limit")).toBe("20");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("0");
  });

  it("rateLimitHeaders clamps remaining at 0", () => {
    const h = rateLimitHeaders({
      allowed: false,
      count: 5,
      limit: 3,
      retryAfterSeconds: 1,
    });
    expect(h["x-ratelimit-remaining"]).toBe("0");
  });
});

describe("migration guards", () => {
  const sql = readFileSync(
    fileURLToPath(
      new URL(
        "../supabase/migrations/20261002000000_rate_limits.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it("enables RLS on rate_limits and defines no permissive policy on it", () => {
    expect(sql).toMatch(
      /alter table public\.rate_limits enable row level security/i,
    );
    expect(sql).not.toMatch(
      /create\s+(or\s+replace\s+)?policy[^\n]*on\s+public\.rate_limits/i,
    );
  });

  it("RPC is security definer; execute revoked from public/anon/authenticated, granted to service_role", () => {
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(
      /revoke execute on function public\.check_rate_limit\([^)]*\)\s*from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.check_rate_limit\([^)]*\)\s*to service_role/i,
    );
  });

  it("validates bounds server-side (no client-injected windows)", () => {
    expect(sql).toMatch(/max_requests < 1/);
    expect(sql).toMatch(/window_seconds > 86400/);
    expect(sql).toMatch(/length\(limit_key\) > 200/);
  });

  it("increments atomically (no lost-update race)", () => {
    expect(sql).toMatch(/on conflict \(key, window_start\)/i);
  });
});

describe("route integration: 429 before business logic", () => {
  it("ai/chat: denied user gets 429, AI service untouched", async () => {
    const { POST } = await import("@/app/api/ai/chat/route");
    mockSessionUser(USER_ID);
    mockLimiter(deniedResult("ai_chat"));
    const res = await POST(
      new Request("http://localhost/api/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: "c", content: "hi" }),
      }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(prepareChat).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it("opportunities/search: denied user gets 429, BA upstream untouched", async () => {
    const { GET } = await import("@/app/api/opportunities/search/route");
    mockProfile(USER_ID);
    mockLimiter(deniedResult("opportunity_search"));
    const res = await GET(
      new Request("http://localhost/api/opportunities/search?q=test"),
    );
    expect(res.status).toBe(429);
    expect(searchOpportunities).not.toHaveBeenCalled();
  });

  it("opportunities/search: allowed user proceeds, response carries ratelimit headers", async () => {
    const { GET } = await import("@/app/api/opportunities/search/route");
    mockProfile(USER_ID);
    mockLimiter(allowedResult("opportunity_search"));
    vi.mocked(searchOpportunities).mockResolvedValue({
      results: [],
      total: 0,
    } as never);
    const res = await GET(
      new Request("http://localhost/api/opportunities/search?goal=arbeit"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-limit")).toBe("10");
    expect(searchOpportunities).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: "" }),
      { userId: USER_ID },
    );
  });

  it("opportunities/save POST: denied user gets 429, save untouched", async () => {
    const { POST } = await import("@/app/api/opportunities/save/route");
    mockProfile(USER_ID);
    mockLimiter(deniedResult("opportunity_save"));
    const res = await POST(
      new Request("http://localhost/api/opportunities/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ opportunityKey: "arbeitsagentur:123" }),
      }),
    );
    expect(res.status).toBe(429);
    expect(saveOpportunityFromKey).not.toHaveBeenCalled();
  });

  it("account/export: denied user gets 429, export untouched", async () => {
    const { GET } = await import("@/app/api/account/export/route");
    mockProfile(USER_ID);
    mockLimiter(deniedResult("account_export"));
    const res = await GET();
    expect(res.status).toBe(429);
    expect(exportUserData).not.toHaveBeenCalled();
  });

  it("account/delete: denied user gets 429, deletion untouched", async () => {
    const { POST } = await import("@/app/api/account/delete/route");
    mockProfile(USER_ID);
    mockLimiter(deniedResult("account_delete"));
    const res = await POST(
      new Request("http://localhost/api/account/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmEmail: "user@example.com" }),
      }),
    );
    expect(res.status).toBe(429);
    expect(deleteUserAccount).not.toHaveBeenCalled();
  });

  it("email/connect: denied user gets 429 instead of the OAuth redirect", async () => {
    const { GET } = await import("@/app/api/email/connect/[provider]/route");
    mockSessionUser(USER_ID);
    mockLimiter(deniedResult("email_oauth"));
    const res = await GET(
      new Request("http://localhost/api/email/connect/gmail"),
      { params: Promise.resolve({ provider: "gmail" }) },
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("location")).toBeNull();
  });

  it("admin/users GET: limited admin gets 429, user list untouched", async () => {
    const { GET } = await import("@/app/api/admin/users/route");
    vi.mocked(requireAdmin).mockResolvedValue({
      id: ADMIN_ID,
      email: "admin@example.com",
    } as never);
    mockLimiter(deniedResult("admin_actions"));
    const res = await GET(new Request("http://localhost/api/admin/users"));
    expect(res.status).toBe(429);
    expect(listAdminUsers).not.toHaveBeenCalled();
  });

  it("admin/users POST ([id]): limited admin gets 429 before action parsing", async () => {
    const { POST } = await import("@/app/api/admin/users/[id]/route");
    vi.mocked(requireAdmin).mockResolvedValue({
      id: ADMIN_ID,
      email: "admin@example.com",
    } as never);
    mockLimiter(deniedResult("admin_actions"));
    const res = await POST(
      new Request("http://localhost/api/admin/users/u1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set_plan", plan: "pro" }),
      }),
      { params: Promise.resolve({ id: USER_ID }) },
    );
    expect(res.status).toBe(429);
  });

  it("unauthenticated requests are 401/redirect, not 429 (authn before limiting)", async () => {
    const { POST } = await import("@/app/api/ai/chat/route");
    mockSessionUser(null);
    mockLimiter(deniedResult("ai_chat"));
    const res = await POST(
      new Request("http://localhost/api/ai/chat", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });
});
