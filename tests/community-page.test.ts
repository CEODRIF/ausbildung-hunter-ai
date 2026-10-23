/**
 * /community page — v2 home (Shell + Home) regression suite.
 *
 * Root cause still reproduced here: any part of the home data path
 * (room directory, unread summary, member count, recent activity) must
 * degrade gracefully instead of escalating into the global error boundary
 * ("This page could not load"). The unread summary legitimately uses the
 * service-role client — but its failure is non-fatal chrome.
 *
 * The availability flag is pinned to FALSE for this suite (it covers the
 * live path); the Coming Soon state itself is covered by
 * tests/community-coming-soon.test.ts in both flag states.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "@/lib/i18n/core";

vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/community/availability", () => ({
  COMMUNITY_COMING_SOON: false,
}));

const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { createClient } = await import("@/lib/supabase/server");
const { createAdminClient } = await import("@/lib/supabase/admin");
const { default: CommunityPage, generateMetadata } = await import(
  "@/app/community/page"
);
const { CommunityShell } = await import(
  "@/components/community/community-shell"
);
const { CommunityHome } = await import("@/components/community/community-home");
const { CommunityOnboarding } = await import("@/components/community-onboarding");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ROOM_ID = "b1000000-0000-4000-8000-000000000001";

function mockSession(userId: string | null = USER_ID, active = true) {
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: userId ? { id: userId } : null,
    profile: userId
      ? { id: userId, account_status: active ? "active" : "blocked" }
      : null,
  } as never);
}

/** Admin client: the unread summary (rpc). Throws by default in this suite? No —
 *  resolves empty; the regression test overrides it to throw. */
function mockAdminUnread(
  rows: Array<{ room_id: string; unread: number }> = [],
) {
  vi.mocked(createAdminClient).mockReturnValue({
    rpc: async (fn: string) => {
      if (fn === "community_room_unread_summary")
        return { data: rows, error: null };
      return {
        data: { allowed: true, count: 1, limit: 100, retry_after: 0 },
        error: null,
      };
    },
  } as never);
}

/**
 * Session client mock for the home data path:
 *   community_profiles maybeSingle            → the viewer's profile
 *   community_room_categories (select/order)  → directory categories
 *   community_rooms (select/eq/order)         → directory rooms
 *   community_messages (select/order/limit)   → recent activity
 *   community_rooms .in(                       → room names for recent
 *   community_profiles .in(                    → author labels for recent
 *   community_profiles select {count, head}    → member count
 */
function mockSessionClient(opts: {
  profile?: Record<string, unknown> | null;
  profileError?: { message: string } | null;
  categories?: Array<Record<string, unknown>>;
  rooms?: Array<Record<string, unknown>>;
  directoryError?: { message: string } | null;
  recent?: Array<Record<string, unknown>>;
  recentError?: { message: string } | null;
  authors?: Array<Record<string, unknown>>;
  memberCount?: number;
} = {}) {
  vi.mocked(createClient).mockResolvedValue({
    from(table: string) {
      const chain: Record<string, unknown> = {};
      let isCount = false;
      let usedIn = false;
      chain.select = (_q?: unknown, o?: { count?: string }) => {
        if (o?.count) isCount = true;
        return chain;
      };
      chain.order = () => chain;
      chain.eq = () => chain;
      chain.limit = () => chain;
      chain.in = () => {
        usedIn = true;
        return chain;
      };
      chain.maybeSingle = async () => ({
        data: opts.profile ?? null,
        error: opts.profileError ?? null,
      });
      chain.then = (onF?: unknown, onR?: unknown) =>
        Promise.resolve(
          isCount
            ? { data: null, count: opts.memberCount ?? 0, error: null }
            : table === "community_messages"
              ? { data: opts.recent ?? [], error: opts.recentError ?? null }
              : table === "community_profiles"
                ? { data: usedIn ? (opts.authors ?? []) : [], error: null }
                : table === "community_room_categories"
                  ? { data: opts.categories ?? [], error: opts.directoryError ?? null }
                  : table === "community_rooms"
                    ? { data: opts.rooms ?? [], error: opts.directoryError ?? null }
                    : { data: [], error: null },
        ).then(onF as never, onR as never);
      return chain;
    },
  } as never);
}

const PROFILE_ROW = { display_name: "SilverFox", avatar_id: "avatar-1" };
const CATEGORY_ROW = {
  id: "b0000000-0000-4000-8000-000000000001",
  slug: "allgemein",
  name: "ALLGEMEIN",
  position: 1,
};
const ROOM_ROW = {
  id: ROOM_ID,
  slug: "public-chat",
  name: "Public Chat",
  category_id: CATEGORY_ROW.id,
  description: null,
  icon: "hash",
  position: 1,
  enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSession();
  mockAdminUnread();
  mockSessionClient({ profile: PROFILE_ROW });
});

// ---------------------------------------------------------------------------
// THE regression: the service-role client must not be able to kill the page
// ---------------------------------------------------------------------------

describe("/community page — the white-page regression", () => {
  it("does NOT throw when createAdminClient() fails (missing service-role env)", async () => {
    mockSessionClient({ profile: PROFILE_ROW });
    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new Error("Missing Supabase server environment variables.");
    });
    // On the broken code this rejected and Next.js rendered src/app/error.tsx.
    const tree = (await CommunityPage()) as {
      type: unknown;
      props: { unread: Record<string, number> };
    };
    expect(tree.type).toBe(CommunityShell);
    // The unread chrome degrades to "nothing unread" — the page itself is fine.
    expect(tree.props.unread).toEqual({});
  });

  it("renders the shell when the room directory read fails (degraded, not fatal)", async () => {
    mockSessionClient({
      profile: PROFILE_ROW,
      directoryError: { message: "connection terminated" },
    });
    const tree = (await CommunityPage()) as {
      type: unknown;
      props: { categories: unknown[]; children: unknown };
    };
    expect(tree.type).toBe(CommunityShell);
    expect(tree.props.categories).toEqual([]);
    const home = tree.props.children as {
      type: unknown;
      props: { roomsUnavailable: boolean };
    };
    expect(home.type).toBe(CommunityHome);
    expect(home.props.roomsUnavailable).toBe(true);
  });

  it("recent-activity failures degrade to an empty feed, not an error page", async () => {
    mockSessionClient({
      profile: PROFILE_ROW,
      recentError: { message: "connection terminated" },
    });
    const tree = (await CommunityPage()) as {
      type: unknown;
      props: { children: unknown };
    };
    expect(tree.type).toBe(CommunityShell);
    const home = tree.props.children as { props: { recent: unknown[] } };
    expect(home.props.recent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The profile-lookup states (never a white page, never a false onboarding)
// ---------------------------------------------------------------------------

describe("/community page — profile states", () => {
  it("shows onboarding when no community profile exists yet", async () => {
    mockSessionClient({ profile: null });
    const tree = await CommunityPage();
    expect((tree as { type: unknown }).type).toBe(CommunityOnboarding);
  });

  it("a FAILED profile lookup renders the retryable state — NOT onboarding", async () => {
    mockSessionClient({
      profile: null,
      profileError: { message: "connection terminated" },
    });
    const tree = await CommunityPage();
    expect(tree).toBeTruthy();
    expect((tree as { type: unknown }).type).not.toBe(CommunityOnboarding);
    expect((tree as { type: unknown }).type).not.toBe(CommunityShell);
    // The retryable state is a distinct (async server) component — a function
    // type, not a raw host element or any of the known community branches.
    expect(typeof (tree as { type: unknown }).type).toBe("function");
  });

  it("does not crash when the profile lookup itself throws (transport error)", async () => {
    vi.mocked(createClient).mockResolvedValue({
      from: () => {
        throw new Error("connection terminated");
      },
    } as never);
    const tree = await CommunityPage();
    expect((tree as { type: unknown }).type).not.toBe(CommunityOnboarding);
  });
});

// ---------------------------------------------------------------------------
// The happy paths
// ---------------------------------------------------------------------------

describe("/community page — normal operation", () => {
  it("loads the home: shell + home with identity, directory, unread, members, recent", async () => {
    mockAdminUnread([
      { room_id: ROOM_ID, unread: 3 },
      { room_id: "b1000000-0000-4000-8000-000000000004", unread: 0 }, // filtered out
    ]);
    mockSessionClient({
      profile: PROFILE_ROW,
      categories: [CATEGORY_ROW],
      rooms: [ROOM_ROW],
      recent: [
        {
          id: "m1",
          user_id: USER_ID,
          room_id: ROOM_ID,
          message: "hallo",
          image_path: null,
          reply_to_message_id: null,
          created_at: "2026-01-01T09:00:00.000Z",
          updated_at: "2026-01-01T09:00:00.000Z",
        },
      ],
      authors: [{ user_id: USER_ID, display_name: "SilverFox", avatar_id: "avatar-1" }],
      memberCount: 42,
    });
    const tree = (await CommunityPage()) as {
      type: unknown;
      props: {
        me: { userId: string; displayName: string; avatarId: string; platformAdmin: boolean };
        categories: unknown[];
        unread: Record<string, number>;
        activeSlug: string | null;
        children: unknown;
      };
    };
    expect(tree.type).toBe(CommunityShell);
    expect(tree.props.me).toEqual({
      userId: USER_ID,
      displayName: "SilverFox",
      avatarId: "avatar-1",
      // Phase 10: server-computed flag (false for a normal member)
      platformAdmin: false,
    });
    expect(tree.props.unread).toEqual({ [ROOM_ID]: 3 });
    expect(tree.props.activeSlug).toBeNull();
    const home = (tree.props.children as {
      type: unknown;
      props: {
        categories: unknown[];
        roomsUnavailable: boolean;
        memberCount: number;
        recent: Array<{ message: { id: string }; roomName: string }>;
      };
    });
    expect(home.type).toBe(CommunityHome);
    expect(home.props.roomsUnavailable).toBe(false);
    expect(home.props.memberCount).toBe(42);
    expect(home.props.recent).toHaveLength(1);
    expect(home.props.recent[0].roomName).toBe("Public Chat");
    expect(home.props.recent[0].message.id).toBe("m1");
  });

  it("keeps the empty home states when nothing exists yet", async () => {
    mockSessionClient({
      profile: PROFILE_ROW,
      categories: [],
      rooms: [],
      recent: [],
      memberCount: 1,
    });
    const tree = (await CommunityPage()) as {
      props: { categories: unknown[]; children: unknown };
    };
    expect(tree.props.categories).toEqual([]);
    const home = tree.props.children as { props: { recent: unknown[] } };
    expect(home.props.recent).toEqual([]);
  });

  it("a missing service-role key does not degrade the directory or the feed", async () => {
    mockSessionClient({
      profile: PROFILE_ROW,
      categories: [CATEGORY_ROW],
      rooms: [ROOM_ROW],
      recent: [],
    });
    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new Error("Missing Supabase server environment variables.");
    });
    const tree = (await CommunityPage()) as {
      props: { categories: Array<{ id: string }>; unread: unknown };
    };
    expect(tree.props.categories).toHaveLength(1);
    expect(tree.props.unread).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Access control + metadata
// ---------------------------------------------------------------------------

describe("/community page — access control", () => {
  it("redirects unauthenticated visitors to /login", async () => {
    mockSession(null);
    await expect(CommunityPage()).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
  });

  it("redirects users whose account is not active", async () => {
    mockSession(USER_ID, false);
    await expect(CommunityPage()).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
  });

  it("generateMetadata: no absolute title while the feature is live", () => {
    expect(generateMetadata()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The graceful states must be translated in every supported language
// ---------------------------------------------------------------------------

describe("graceful-state copy", () => {
  it("has translated notices for the degraded home states", () => {
    for (const lang of ["de", "en", "fr", "ar"] as const) {
      expect(translate(lang, "community.historyUnavailable")).not.toBe(
        "community.historyUnavailable",
      );
      expect(translate(lang, "community.historyUnavailableRetry")).not.toBe(
        "community.historyUnavailableRetry",
      );
      expect(translate(lang, "community.homeTitle")).not.toBe("community.homeTitle");
    }
  });
});
