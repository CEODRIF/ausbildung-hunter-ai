/**
 * /community page — regression tests for the post-onboarding white page.
 *
 * Root cause reproduced here: after the Community profile exists, the page
 * renders the chat branch, which called fetchInitialCommunityMessages() ->
 * createAdminClient() with NO error handling. createAdminClient() throws when
 * SUPABASE_SERVICE_ROLE_KEY (or NEXT_PUBLIC_SUPABASE_URL) is unavailable at
 * runtime, and the exception escaped the Server Component render up to
 * src/app/error.tsx ("This page could not load"). These tests fail on the
 * old code and pass only when the page degrades gracefully instead.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "@/lib/i18n/core";

vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn(() => ({})) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { createClient } = await import("@/lib/supabase/server");
const { createAdminClient } = await import("@/lib/supabase/admin");
const CommunityPage = (await import("@/app/community/page")).default;
const { CommunityChat } = await import("@/components/community-chat");
const { CommunityOnboarding } = await import("@/components/community-onboarding");

const USER_ID = "11111111-1111-4111-8111-111111111111";

function mockSession(userId: string | null = USER_ID, active = true) {
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: userId ? { id: userId } : null,
    profile: userId ? { id: userId, account_status: active ? "active" : "blocked" } : null,
  } as never);
}

/**
 * Session client (RLS-enforced) — the ONLY client the page is allowed to need:
 *   community_profiles.eq(...).maybeSingle()  → the viewer's profile
 *   community_messages.order().limit()        → the newest page
 *   community_profiles.in(...)                → author labels
 */
function mockSessionClient(opts: {
  profile?: Record<string, unknown> | null;
  error?: { message: string } | null;
  messages?: Array<Record<string, unknown>>;
  messagesError?: { message: string } | null;
  authors?: Array<Record<string, unknown>>;
  authorsError?: { message: string } | null;
}) {
  vi.mocked(createClient).mockResolvedValue({
    from(table: string) {
      let usedIn = false;
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.order = () => chain;
      chain.limit = () => chain;
      chain.in = () => {
        usedIn = true;
        return chain;
      };
      chain.maybeSingle = async () => ({
        data: opts.profile ?? null,
        error: opts.error ?? null,
      });
      chain.then = (onF?: unknown, onR?: unknown) =>
        Promise.resolve(
          table === "community_messages"
            ? { data: opts.messages ?? [], error: opts.messagesError ?? null }
            : {
                data: usedIn ? (opts.authors ?? []) : [],
                error: usedIn ? (opts.authorsError ?? null) : null,
              },
        ).then(onF as never, onR as never);
      return chain;
    },
  } as never);
}

const PROFILE_ROW = { display_name: "Anna", avatar_id: "avatar-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mockSession();
});

// ---------------------------------------------------------------------------
// THE regression: admin client unavailable (missing service-role env)
// ---------------------------------------------------------------------------

describe("/community page — the white-page regression", () => {
  it("does NOT throw when createAdminClient() fails (missing service-role env)", async () => {
    mockSessionClient({ profile: PROFILE_ROW });
    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new Error("Missing Supabase server environment variables.");
    });
    // On the broken code this rejected and Next.js rendered src/app/error.tsx
    // ("This page could not load"). It must now resolve.
    const tree = await CommunityPage();
    expect((tree as { type: unknown }).type).toBe(CommunityChat);
    // …and the render path must no longer touch the service-role client at all.
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("loads the history through the member's RLS-backed client even without a service-role key", async () => {
    mockSessionClient({
      profile: PROFILE_ROW,
      messages: [
        {
          id: "m1",
          user_id: USER_ID,
          message: "hallo",
          image_path: null,
          created_at: "2026-01-01T09:00:00.000Z",
          updated_at: "2026-01-01T09:00:00.000Z",
        },
      ],
    });
    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new Error("Missing Supabase server environment variables.");
    });
    const tree = (await CommunityPage()) as {
      props: { initialMessages: Array<{ id: string }>; historyUnavailable?: boolean };
    };
    // No degradation at all: the missing key is simply irrelevant here.
    expect(tree.props.initialMessages.map((m) => m.id)).toEqual(["m1"]);
    expect(tree.props.historyUnavailable).toBe(false);
  });

  it("still renders the chat when the messages query errors (DB temporarily unavailable)", async () => {
    mockSessionClient({
      profile: PROFILE_ROW,
      messagesError: { message: "connection terminated" },
    });
    const tree = (await CommunityPage()) as {
      type: unknown;
      props: { initialMessages: unknown[]; historyUnavailable?: boolean };
    };
    expect(tree.type).toBe(CommunityChat);
    expect(tree.props.initialMessages).toEqual([]);
    expect(tree.props.historyUnavailable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The happy paths must keep working (no behaviour change)
// ---------------------------------------------------------------------------

describe("/community page — normal operation", () => {
  it("loads the chat for an existing community profile", async () => {
    mockSessionClient({
      profile: PROFILE_ROW,
      messages: [
        {
          id: "m1",
          user_id: USER_ID,
          message: "hallo",
          image_path: null,
          created_at: "2026-01-01T09:00:00.000Z",
          updated_at: "2026-01-01T09:00:00.000Z",
        },
      ],
      authors: [{ user_id: USER_ID, display_name: "Anna", avatar_id: "avatar-1" }],
    });
    const tree = (await CommunityPage()) as {
      type: unknown;
      props: {
        me: { userId: string; displayName: string; avatarId: string };
        initialMessages: Array<{ id: string; author: unknown }>;
        historyUnavailable?: boolean;
      };
    };
    expect(tree.type).toBe(CommunityChat);
    expect(tree.props.me).toEqual({
      userId: USER_ID,
      displayName: "Anna",
      avatarId: "avatar-1",
    });
    expect(tree.props.initialMessages.map((m) => m.id)).toEqual(["m1"]);
    expect(tree.props.initialMessages[0].author).toEqual({
      user_id: USER_ID,
      display_name: "Anna",
      avatar_id: "avatar-1",
    });
    expect(tree.props.historyUnavailable).toBe(false);
  });

  it("shows onboarding when no community profile exists yet", async () => {
    mockSessionClient({ profile: null });
    const tree = await CommunityPage();
    expect((tree as { type: unknown }).type).toBe(CommunityOnboarding);
  });

  it("keeps the empty chat state when there are no messages", async () => {
    mockSessionClient({ profile: PROFILE_ROW, messages: [] });
    const tree = (await CommunityPage()) as { props: { initialMessages: unknown[] } };
    expect(tree.props.initialMessages).toEqual([]);
  });

  it("does not crash when the profile lookup itself fails (DB unavailable)", async () => {
    mockSessionClient({ profile: null, error: { message: "connection terminated" } });
    // Must not reject: the page has to show a retryable state instead.
    const tree = await CommunityPage();
    expect(tree).toBeTruthy();
    expect((tree as { type: unknown }).type).not.toBe(CommunityOnboarding);
  });
});

// ---------------------------------------------------------------------------
// Access control
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
});

// ---------------------------------------------------------------------------
// The graceful states must be translated in every supported language
// ---------------------------------------------------------------------------

describe("graceful-state copy", () => {
  it("has a translated notice for an unloadable message history", () => {
    for (const lang of ["de", "en", "fr", "ar"] as const) {
      expect(translate(lang, "community.historyUnavailable")).not.toBe(
        "community.historyUnavailable",
      );
      expect(translate(lang, "community.historyUnavailableRetry")).not.toBe(
        "community.historyUnavailableRetry",
      );
    }
  });
});
