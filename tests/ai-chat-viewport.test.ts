/**
 * AI Assistant — mobile (iPhone / iOS Safari) keyboard & viewport
 * invariants.
 *
 * Root cause this file pins down: iOS Safari auto-zooms when an input
 * with font-size < 16px gains focus. The 14px composer textarea caused
 * a zoom that distorted the layout while the keyboard was open and got
 * "stuck" (page looked enlarged, layout did not restore) on close.
 * The fix is pure CSS/meta (16px below lg + viewport-fit=cover); these
 * source-scan invariants make sure the layout architecture that makes
 * the CSS fix sufficient never regresses.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

const chat = read("../src/components/ai-chat.tsx");
const layout = read("../src/app/layout.tsx");

describe("iOS zoom prevention", () => {
  it("composer textarea uses 16px (text-base) on mobile, 14px (text-sm) from lg up", () => {
    // 16px below the lg breakpoint = every iPhone (portrait AND
    // landscape) and iPad — Safari never triggers focus auto-zoom.
    // Desktop (>= 1024px) keeps the original text-sm: zero desktop change.
    expect(chat).toContain(
      "max-h-48 min-h-10 flex-1 resize-none bg-transparent px-1 py-2.5 text-base leading-6 text-ink-soft outline-none placeholder:text-faint lg:text-sm",
    );
    // No sub-16px font may remain on the focused textarea itself.
    // The opening tag ends at the first `/>`; attribute arrows contain a
    // bare `>`, so the match must be anchored on the closing slash.
    const textareaOpen = chat.match(/<textarea[\s\S]*?\/>/)?.[0] ?? "";
    expect(textareaOpen).toContain("text-base");
    expect(textareaOpen).toContain("lg:text-sm");
    // A BARE (un-prefixed) text-xs/text-sm would re-trigger the iOS zoom.
    expect(textareaOpen).not.toMatch(/(?:^|\s)text-(xs|sm)\b/);
  });

  it("the root layout pins the zoom baseline (device-width + initialScale=1 + cover)", () => {
    expect(layout).toMatch(/export const viewport: Viewport/);
    expect(layout).toContain('width: "device-width"');
    expect(layout).toContain("initialScale: 1");
    // cover is required for env(safe-area-inset-bottom) to be non-zero.
    expect(layout).toContain('viewportFit: "cover"');
  });
});

describe("layout architecture (why the CSS fix is sufficient)", () => {
  it("the page itself never scrolls: fixed dynamic-viewport root", () => {
    expect(chat).toContain("flex h-dvh overflow-hidden bg-background");
    // The static 100vh (large viewport) must not be reintroduced — it is
    // the source of keyboard-era height drift on iOS.
    expect(chat).not.toContain("100vh");
    expect(chat).not.toContain("h-screen");
  });

  it("the messages container is the ONLY scroller", () => {
    expect(chat).toContain("flex-1 overflow-y-auto overscroll-contain");
  });

  it("the composer is in normal flow (no fixed/sticky bottom bar)", () => {
    // A fixed/sticky composer inside a container that iOS resizes is the
    // classic second cause of the stuck-layout bug. The composer must stay
    // anchored at the bottom of the flex column instead.
    expect(chat).not.toMatch(/fixed[^"']{0,40}bottom-0/);
    expect(chat).not.toMatch(/sticky[^"']{0,40}bottom-0/);
    expect(chat).toContain(
      "shrink-0 border-t border-line bg-surface px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6",
    );
  });

  it("safe area is handled by padding, not by extra JS", () => {
    expect(chat).toContain("env(safe-area-inset-bottom)");
  });
});

describe("no artificial keyboard handling (regression guard)", () => {
  it("no visualViewport/resize listeners, no polling, no body mutation", () => {
    expect(chat).not.toContain("visualViewport");
    expect(chat).not.toContain("addEventListener");
    expect(chat).not.toContain("setInterval");
    expect(chat).not.toContain("document.body");
    expect(chat).not.toContain("documentElement");
    expect(chat).not.toContain("scrollIntoView");
    // No sleep-style promises (fake delays) anywhere in the component.
    expect(chat).not.toMatch(/new Promise\([^)]*=>\s*setTimeout\(/);
  });
});
