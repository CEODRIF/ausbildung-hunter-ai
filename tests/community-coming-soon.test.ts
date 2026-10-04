/**
 * /community page — the Coming Soon gate (availability flag).
 *
 * While COMMUNITY_COMING_SOON is true the route must:
 *   - render CommunityComingSoon (never the chat, onboarding or unavailable
 *     state),
 *   - perform ZERO data access (no auth/profile lookup, no message fetch —
 *     the parked page must not even prepare a query),
 *   - publish the "Community — Coming Soon" document title.
 *
 * NOTE: the availability module is deliberately NOT mocked here — the real
 * constant is what this suite pins.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn(() => ({})) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { createClient } = await import("@/lib/supabase/server");
const { COMMUNITY_COMING_SOON } = await import("@/lib/community/availability");
const CommunityPageModule = await import("@/app/community/page");
const { CommunityComingSoon } = await import("@/components/community-coming-soon");
const { CommunityChat } = await import("@/components/community-chat");
const { CommunityOnboarding } = await import("@/components/community-onboarding");

const CommunityPage = CommunityPageModule.default;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/community page — the Coming Soon gate", () => {
  it("the feature is currently parked behind the availability flag", () => {
    expect(COMMUNITY_COMING_SOON).toBe(true);
  });

  it("renders CommunityComingSoon — never the chat or onboarding", async () => {
    const tree = (await CommunityPage()) as { type: unknown };
    expect(tree.type).toBe(CommunityComingSoon);
    expect(tree.type).not.toBe(CommunityChat);
    expect(tree.type).not.toBe(CommunityOnboarding);
  });

  it("performs ZERO data access while parked (no auth lookup, no queries)", async () => {
    await CommunityPage();
    expect(getCurrentUserAndProfile).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("publishes the absolute Coming Soon document title while parked", () => {
    const meta = CommunityPageModule.generateMetadata();
    expect(meta.title).toEqual({ absolute: "Community — Coming Soon" });
  });
});
