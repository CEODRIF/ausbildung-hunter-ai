/**
 * Community chat — browser Supabase client failure.
 *
 * The public NEXT_PUBLIC_* Supabase values are INLINED into the client bundle
 * at build time, so a deployment can ship without them while the server (which
 * reads process.env at runtime) keeps working — that asymmetry is why login
 * and every server-rendered page were fine. `community-chat.tsx` was the only
 * component that built a browser client DURING RENDER, so `getSupabaseEnv()`'s
 * throw landed in the render phase and blanked /community through
 * src/app/error.tsx ("This page could not load").
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

vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn(() => ({})) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { createClient: browserCreateClient } = await import("@/lib/supabase/client");
const { CommunityChat } = await import("@/components/community-chat");

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const chatSource = readFileSync(
  resolve(root, "src/components/community-chat.tsx"),
  "utf8",
);

const ME = {
  userId: "11111111-1111-4111-8111-111111111111",
  displayName: "Anna",
  avatarId: "avatar-1",
};

const CLIENT_ENV_ERROR =
  "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.";

function renderChat() {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(CommunityChat, { me: ME, initialMessages: [] }),
    ),
  );
}

afterEach(() => {
  vi.mocked(browserCreateClient).mockImplementation(() => ({}) as never);
});

describe("community chat — browser client unavailable (missing public env)", () => {
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
    // The chat is still fully usable: empty state + composer.
    expect(html).toContain(translate("de", "community.emptyTitle"));
    expect(html).toContain(translate("de", "community.placeholder"));
    expect(html).toContain(translate("de", "community.send"));
  });

  it("never constructs the browser client during render, and guards every use", () => {
    // No render-phase client creation (useMemo/useState initialiser/module scope).
    expect(chatSource).not.toMatch(/useMemo\(\s*\(\)\s*=>\s*createClient\(\)/);
    expect(chatSource).not.toMatch(/useState\(\s*\(\)\s*=>\s*createClient\(\)/);
    // …it is created lazily, on first use after mount, and cached in a ref.
    expect(chatSource).toContain("clientRef.current = createClient();");
    // Every consumer tolerates a missing client.
    expect(chatSource).toContain("if (!client || userId in authorsRef.current) return;");
    expect(chatSource).toContain("const client = getClient();\n    if (!client)");
    // Realtime setup and image signing are wrapped, so an effect error cannot
    // reach the error boundary either.
    expect(chatSource).toContain('console.error("[community] realtime subscribe failed:", error)');
    expect(chatSource).toContain('console.error("[community] image signing failed:", error)');
    expect(chatSource).toContain("reportDegraded()");
  });
});
