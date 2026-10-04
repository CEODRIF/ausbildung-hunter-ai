/**
 * Community chat — rendered markup in the degraded state.
 *
 * Requirement: when the history cannot be prefetched (DB outage, missing
 * server env) or Realtime is unavailable, the chat must still RENDER and stay
 * usable — with an explicit notice — instead of the global error page. This
 * renders the real component (same pattern as tests/deckblatt-coming-soon).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { translate } from "@/lib/i18n/core";

vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn(() => ({})) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { CommunityChat } = await import("@/components/community-chat");

const ME = {
  userId: "11111111-1111-4111-8111-111111111111",
  displayName: "Anna",
  avatarId: "avatar-1",
};

function render(props: { initialMessages: []; historyUnavailable?: boolean }) {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(CommunityChat, { me: ME, ...props }),
    ),
  );
}

describe("community chat — degraded rendering", () => {
  it("renders a usable chat (empty state + composer) when the history failed to load", () => {
    const html = render({ initialMessages: [], historyUnavailable: true });
    // The degraded notice + its retry action are visible…
    expect(html).toContain(translate("de", "community.historyUnavailable"));
    expect(html).toContain(translate("de", "community.historyUnavailableRetry"));
    // …and the chat itself is fully usable: empty state, composer, send button.
    expect(html).toContain(translate("de", "community.emptyTitle"));
    expect(html).toContain(translate("de", "community.placeholder"));
    expect(html).toContain(translate("de", "community.send"));
    // No raw-HTML injection anywhere in the rendered output.
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });

  it("hides the degraded notice when the history loaded normally", () => {
    const html = render({ initialMessages: [], historyUnavailable: false });
    expect(html).not.toContain(translate("de", "community.historyUnavailable"));
    expect(html).toContain(translate("de", "community.emptyTitle"));
  });

  it("renders the composer even with a message history present", () => {
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(CommunityChat, {
          me: ME,
          initialMessages: [
            {
              id: "m1",
              user_id: ME.userId,
              message: "<img src=x onerror=alert(1)>",
              image_path: null,
              created_at: "2026-01-01T09:00:00.000Z",
              updated_at: "2026-01-01T09:00:00.000Z",
              author: {
                user_id: ME.userId,
                display_name: "Anna",
                avatar_id: "avatar-1",
              },
            },
          ],
        }),
      ),
    );
    expect(html).toContain(translate("de", "community.send"));
    // Message bodies are escaped as text — the markup must not become HTML.
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
  });
});
