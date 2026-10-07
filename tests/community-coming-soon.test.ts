/**
 * /community page — the availability flag (both states).
 *
 * The community is parked behind ONE boolean (src/lib/community/availability):
 *
 *   COMMUNITY_COMING_SOON = true  → the route renders CommunityComingSoon and
 *   performs NO data access at all (auth, session client, admin client) —
 *   even an incomplete Supabase environment must not affect the page.
 *
 *   COMMUNITY_COMING_SOON = false → the live home path: auth + profile
 *   lookup + the home data fan-out (directory, unread, members, recent),
 *   all degraded-safe (see tests/community-page.test.ts for the deep
 *   regression coverage).
 *
 * The module cache is reset per test so the same suite pins BOTH states
 * against the real page implementation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const USER_ID = "11111111-1111-4111-8111-111111111111";

/** Freshly (re)load the page module with the availability flag pinned. */
async function loadPageWithFlag(flag: boolean) {
  vi.resetModules();
  vi.doMock("@/lib/community/availability", () => ({
    COMMUNITY_COMING_SOON: flag,
  }));
  const page = await import("@/app/community/page");
  const comingSoon = await import("@/components/community-coming-soon");
  const shell = await import("@/components/community/community-shell");
  const onboarding = await import("@/components/community-onboarding");
  const { getCurrentUserAndProfile } = await import("@/lib/auth");
  const { createClient } = await import("@/lib/supabase/server");
  const { createAdminClient } = await import("@/lib/supabase/admin");
  return {
    page,
    CommunityComingSoon: comingSoon.CommunityComingSoon,
    CommunityShell: shell.CommunityShell,
    CommunityOnboarding: onboarding.CommunityOnboarding,
    getCurrentUserAndProfile,
    createClient,
    createAdminClient,
  };
}

function mockSession(
  getCurrentUserAndProfile: typeof import("@/lib/auth").getCurrentUserAndProfile,
  userId: string | null = USER_ID,
) {
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: userId ? { id: userId } : null,
    profile: userId ? { id: userId, account_status: "active" } : null,
  } as never);
}

function mockSessionClient(
  createClient: typeof import("@/lib/supabase/server").createClient,
) {
  vi.mocked(createClient).mockResolvedValue({
    from() {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.order = () => chain;
      chain.eq = () => chain;
      chain.limit = () => chain;
      chain.in = () => chain;
      chain.maybeSingle = async () => ({
        data: { display_name: "SilverFox", avatar_id: "avatar-1" },
        error: null,
      });
      chain.then = (onF?: unknown, onR?: unknown) =>
        Promise.resolve({ data: [], error: null }).then(onF as never, onR as never);
      return chain;
    },
  } as never);
}

function mockAdmin(
  createAdminClient: typeof import("@/lib/supabase/admin").createAdminClient,
) {
  vi.mocked(createAdminClient).mockReturnValue({
    rpc: async () => ({ data: [], error: null }),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("COMMUNITY_COMING_SOON = true (feature parked)", () => {
  it("renders CommunityComingSoon — and never anything else", async () => {
    const { page, CommunityComingSoon, getCurrentUserAndProfile, createClient } =
      await loadPageWithFlag(true);
    mockSession(getCurrentUserAndProfile);
    mockSessionClient(createClient);
    const tree = await page.default();
    expect((tree as { type: unknown }).type).toBe(CommunityComingSoon);
  });

  it("performs NO data access at all (auth, session client, admin client)", async () => {
    const {
      page,
      CommunityComingSoon,
      getCurrentUserAndProfile,
      createClient,
      createAdminClient,
    } = await loadPageWithFlag(true);
    // Even a totally broken environment must not matter: nothing is called.
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({} as never);
    const tree = await page.default();
    expect((tree as { type: unknown }).type).toBe(CommunityComingSoon);
    expect(getCurrentUserAndProfile).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("serves the dedicated metadata (absolute title)", async () => {
    const { page } = await loadPageWithFlag(true);
    expect(page.generateMetadata()).toEqual({
      title: { absolute: "Community — Coming Soon" },
    });
  });
});

describe("COMMUNITY_COMING_SOON = false (feature live)", () => {
  it("serves the default metadata (no absolute title)", async () => {
    const { page } = await loadPageWithFlag(false);
    expect(page.generateMetadata()).toEqual({});
  });

  it("runs the auth + data path and renders the live home (Shell)", async () => {
    const {
      page,
      CommunityShell,
      getCurrentUserAndProfile,
      createClient,
      createAdminClient,
    } = await loadPageWithFlag(false);
    mockSession(getCurrentUserAndProfile);
    mockSessionClient(createClient);
    mockAdmin(createAdminClient);
    const tree = await page.default();
    expect((tree as { type: unknown }).type).toBe(CommunityShell);
    expect(getCurrentUserAndProfile).toHaveBeenCalled();
    expect(createClient).toHaveBeenCalled();
  });

  it("renders onboarding when the member has no community profile yet", async () => {
    const {
      page,
      CommunityOnboarding,
      getCurrentUserAndProfile,
      createClient,
    } = await loadPageWithFlag(false);
    mockSession(getCurrentUserAndProfile);
    vi.mocked(createClient).mockResolvedValue({
      from() {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.maybeSingle = async () => ({ data: null, error: null });
        return chain;
      },
    } as never);
    const tree = await page.default();
    expect((tree as { type: unknown }).type).toBe(CommunityOnboarding);
  });

  it("redirects unauthenticated visitors to /login (like every other page)", async () => {
    const { page, getCurrentUserAndProfile } = await loadPageWithFlag(false);
    mockSession(getCurrentUserAndProfile, null);
    await expect(page.default()).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
  });
});
