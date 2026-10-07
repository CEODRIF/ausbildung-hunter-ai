/**
 * Community v2 — browser Supabase client failure (RoomChat).
 *
 * The public NEXT_PUBLIC_* Supabase values are INLINED into the client bundle
 * at build time, so a deployment can ship without them while the server (which
 * reads process.env at runtime) keeps working — that asymmetry is why login
 * and every server-rendered page were fine. The chat was the component that
 * built a browser client DURING RENDER, so `getSupabaseEnv()`'s throw landed
 * in the render phase and blanked /community through src/app/error.tsx
 * ("This page could not load").
 *
 * These tests fail on the previous implementation and pass once the client is
 * created after mount and every consumer tolerates its absence.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translate } from "@/lib/i18n/core";
import { I18nProvider } from "@/lib/i18n";
import type { CommunityRoom } from "@/lib/community";

vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn(() => ({})) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { createClient: browserCreateClient } = await import("@/lib/supabase/client");
const { RoomChat } = await import("@/components/community/room-chat");

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const chatSource = readFileSync(
  resolve(root, "src/components/community/room-chat.tsx"),
  "utf8",
);

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

const CLIENT_ENV_ERROR =
  "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.";

function renderChat() {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(RoomChat, { me: ME, room: ROOM, initialMessages: [] }),
    ),
  );
}

afterEach(() => {
  vi.mocked(browserCreateClient).mockImplementation(() => ({}) as never);
});

describe("room chat — browser client unavailable (missing public env)", () => {
  it("renders the chat instead of throwing when the browser client cannot be built", () => {
    vi.mocked(browserCreateClient).mockImplementation(() => {
      throw new Error(CLIENT_ENV_ERROR);
    });
    // Previously this threw during render (createClient in useMemo) and the
    // error boundary replaced the whole page.
    let html = "";
    expect(() => {
      html = renderChat();
    }).not.toThrow();
    // The chat is still fully usable: room intro/empty state + composer.
    expect(html).toContain(ROOM.name);
    expect(html).toContain(translate("de", "community.emptyCta"));
    expect(html).toContain(translate("de", "community.placeholder"));
    expect(html).toContain(translate("de", "community.send"));
  });

  it("never constructs the browser client during render, and guards every use", () => {
    // No render-phase client creation (useMemo/useState initialiser/module scope).
    expect(chatSource).not.toMatch(/useMemo\(\s*\(\)\s*=>\s*createClient\(\)/);
    expect(chatSource).not.toMatch(/useState\(\s*\(\)\s*=>\s*createClient\(\)/);
    // …it is created lazily, on first use after mount, and cached in a ref.
    expect(chatSource).toContain("clientRef.current = createClient();");
    // A client that cannot be built is logged + reported (degraded state),
    // never thrown.
    expect(chatSource).toContain('console.error("[community] realtime client unavailable:", error)');
    // Every consumer tolerates a missing client.
    // (Phase 10: author enrichment no longer touches the browser client at
    // all — it goes through the secure session-gated member endpoint with
    // the same dedupe + uuid guards, so a broken client degrades nothing
    // here; the realtime consumer below still guards a missing client.)
    expect(chatSource).toContain("if (userId in authorsRef.current) return;");
    expect(chatSource).toContain("if (!UUID_RE.test(userId)) return;");
    expect(chatSource).toContain("const client = getClient();\n    if (!client)");
    // Realtime setup and image signing are wrapped, so an effect error cannot
    // reach the error boundary either.
    expect(chatSource).toContain('console.error("[community] realtime subscribe failed:", error)');
    expect(chatSource).toContain('console.error("[community] image signing failed:", error)');
    expect(chatSource).toContain("reportDegraded()");
  });
});
