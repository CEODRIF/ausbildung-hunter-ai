/**
 * Community Phase 3 — GET /api/community/badges (route-level).
 *
 * The badge COMPUTATION (fetchSocialBadges: DM unread sum, pending INCOMING
 * friend-request count, RLS-scoped unread notification count, and its null
 * degradation on DB failure) is unit-covered in community-social.test.ts;
 * this suite pins the ROUTE boundary:
 *   - unauthenticated → 401 (no badge work, no rate-limit probe)
 *   - inactive account → 401
 *   - rate limited (community_profile scope, 30/min) → 429 + retry-after
 *   - badge read failure → 500 (chrome never throws, never blocks)
 *   - success → 200 + the SAME server counts the first render uses,
 *     with the standard x-ratelimit-* headers
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/community/social", () => ({ fetchSocialBadges: vi.fn() }));

import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchSocialBadges } from "@/lib/community/social";
import { GET } from "@/app/api/community/badges/route";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BADGES = { dms: 3, friendRequests: 1, notifications: 7 };

function mockAuth(userId: string | null, account_status = "active") {
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: userId ? { id: userId } : null,
    profile: { id: "p", account_status } as never,
  } as never);
}

function mockRateLimit(result: {
  allowed: boolean;
  count?: number;
  limit?: number;
  retry_after?: number;
} = { allowed: true, count: 1, limit: 30, retry_after: 0 }) {
  vi.mocked(createAdminClient).mockReturnValue({
    rpc: vi.fn(async (fn: string) =>
      fn === "check_rate_limit" ? { data: result, error: null } : { data: null, error: null },
    ),
  } as never);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/community/badges", () => {
  it("rejects unauthenticated requests with 401 (no badge work)", async () => {
    mockAuth(null);
    const res = await GET(new Request("http://localhost/api/community/badges"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(fetchSocialBadges).not.toHaveBeenCalled();
  });

  it("rejects inactive accounts with 401", async () => {
    mockAuth(ALICE, "suspended");
    const res = await GET(new Request("http://localhost/api/community/badges"));
    expect(res.status).toBe(401);
    expect(fetchSocialBadges).not.toHaveBeenCalled();
  });

  it("rate-limits on the community_profile scope → 429 + retry-after, no badge work", async () => {
    mockAuth(ALICE);
    mockRateLimit({ allowed: false, count: 31, limit: 30, retry_after: 12 });
    const res = await GET(new Request("http://localhost/api/community/badges"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
    expect(fetchSocialBadges).not.toHaveBeenCalled();
  });

  it("degrades to 500 (never throws) when the badge read fails", async () => {
    mockAuth(ALICE);
    mockRateLimit();
    vi.mocked(createClient).mockResolvedValue({} as never);
    vi.mocked(fetchSocialBadges).mockResolvedValue(null);
    const res = await GET(new Request("http://localhost/api/community/badges"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not load badges." });
  });

  it("returns the badge counts + x-ratelimit headers on success", async () => {
    mockAuth(ALICE);
    mockRateLimit({ allowed: true, count: 2, limit: 30, retry_after: 0 });
    vi.mocked(createClient).mockResolvedValue({} as never);
    vi.mocked(fetchSocialBadges).mockResolvedValue(BADGES as never);
    const res = await GET(new Request("http://localhost/api/community/badges"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(BADGES);
    expect(res.headers.get("x-ratelimit-limit")).toBe("30");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("28");
    expect(fetchSocialBadges).toHaveBeenCalledWith({}, ALICE);
  });
});
