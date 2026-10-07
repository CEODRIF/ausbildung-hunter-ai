/**
 * RoomChat — rendered markup in the degraded state.
 *
 * Requirement: when the history cannot be prefetched (DB outage, incomplete
 * server env) or Realtime is unavailable, the chat must still RENDER and stay
 * usable — with an explicit notice — instead of the global error page. This
 * renders the real component (same pattern as tests/deckblatt-coming-soon).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { translate } from "@/lib/i18n/core";
import type { CommunityMessageClient, CommunityRoom } from "@/lib/community";

vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn(() => ({})) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { RoomChat } = await import("@/components/community/room-chat");

const ME = {
  userId: "11111111-1111-4111-8111-111111111111",
  displayName: "SilverFox",
  avatarId: "avatar-1",
};

const ROOM: CommunityRoom = {
  id: "b1000000-0000-4000-8000-000000000001",
  slug: "public-chat",
  name: "Public Chat",
  category_id: "b0000000-0000-4000-8000-000000000001",
  description: null,
  icon: "hash",
  position: 1,
  enabled: true,
  qna_enabled: false,
};

function render(props: {
  initialMessages: CommunityMessageClient[];
  historyUnavailable?: boolean;
}) {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(RoomChat, { me: ME, room: ROOM, ...props }),
    ),
  );
}

function row(
  id: string,
  message: string,
  author: {
    user_id: string;
    display_name: string;
    avatar_id: string;
  } | null,
): CommunityMessageClient {
  return {
    id,
    user_id: author?.user_id ?? ME.userId,
    room_id: ROOM.id,
    message,
    image_path: null,
    reply_to_message_id: null,
    created_at: "2026-01-01T09:00:00.000Z",
    updated_at: "2026-01-01T09:00:00.000Z",
    author,
    reactions: [],
    replyTo: null,
  };
}

describe("room chat — degraded rendering", () => {
  it("renders a usable chat (empty state + composer) when the history failed to load", () => {
    const html = render({ initialMessages: [], historyUnavailable: true });
    // The degraded notice + its retry action are visible…
    expect(html).toContain(translate("de", "community.historyUnavailable"));
    expect(html).toContain(translate("de", "community.historyUnavailableRetry"));
    // …and the chat itself is fully usable: room intro/empty CTA + composer.
    expect(html).toContain(ROOM.name);
    expect(html).toContain(translate("de", "community.roomDescriptions.public-chat"));
    expect(html).toContain(translate("de", "community.emptyCta"));
    expect(html).toContain(translate("de", "community.placeholder"));
    // No raw-HTML injection anywhere in the rendered output.
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });

  it("hides the degraded notice when the history loaded normally", () => {
    const html = render({ initialMessages: [], historyUnavailable: false });
    expect(html).not.toContain(translate("de", "community.historyUnavailable"));
    expect(html).toContain(translate("de", "community.emptyCta"));
  });

  it("renders the composer even with a message history present", () => {
    const html = render({
      initialMessages: [
        row("m1", "<img src=x onerror=alert(1)>", {
          user_id: ME.userId,
          display_name: "SilverFox",
          avatar_id: "avatar-1",
        }),
      ],
    });
    expect(html).toContain(translate("de", "community.placeholder"));
    // Message bodies are escaped as text — the markup must not become HTML.
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
  });

  it("renders a reply preview without HTML injection", () => {
    const parent = row("p1", "original question", {
      user_id: ME.userId,
      display_name: "SilverFox",
      avatar_id: "avatar-1",
    });
    const html = render({
      initialMessages: [
        {
          ...row("m2", "my answer", {
            user_id: ME.userId,
            display_name: "SilverFox",
            avatar_id: "avatar-1",
          }),
          reply_to_message_id: "p1",
          replyTo: {
            id: parent.id,
            user_id: parent.user_id,
            message: parent.message,
            image_path: null,
            created_at: parent.created_at,
            author: parent.author,
          },
        },
      ],
    });
    expect(html).toContain("original question");
    expect(html).toContain("my answer");
  });
});
