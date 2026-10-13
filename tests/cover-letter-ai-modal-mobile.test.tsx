import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CoverLetterBuilder } from "@/components/cover-letter-builder";
import { I18nProvider } from "@/lib/i18n";

/**
 * Regression: on mobile (iOS Safari) the Cover Letter "Create with AI"
 * modal's primary Generate button was hidden behind the fixed glass
 * bottom nav (screenshot repro: the nav paints over the modal card and
 * the Cancel/Generate row below the replace-warning is unreachable).
 *
 * Why the nav wins paint order: the app-shell content wrapper
 * (`relative z-10 …`) is a stacking context that TRAPS the modal
 * overlay's `z-50`, while the bottom nav is a shell sibling at `z-30`.
 * The nav always paints above the modal — so the fix is geometric, not
 * z-index (identical contract to the applications confirm dialog,
 * tests/confirm-dialog-mobile.test.tsx):
 *
 *  1. The overlay reserves the nav's FULL footprint + a margin below
 *     `lg` (where the nav exists) via
 *     `pb-[calc(6rem_+_env(safe-area-inset-bottom))]`, restored to
 *     `p-4` at `lg` (no nav on desktop → desktop layout unchanged).
 *  2. The dialog card is capped at the overlay's free area
 *     (`min(100%, calc(100vh - 2.5rem))`, refined to `100dvh` where
 *     supported — iOS Safari's dynamic viewport) and scrolls internally
 *     (`overflow-y-auto overscroll-contain`), so the Generate button can
 *     always be scrolled completely above the bottom nav. The `100%`
 *     term re-bounds the card when iOS Safari shrinks the layout
 *     viewport under the keyboard — no hard-coded height breaks then.
 *
 * AI-generation LOGIC is untouched: the same `onGenerate` wiring with
 * the same settings payload, busy state and cancel wiring — asserted
 * below.
 */

const builder = readFileSync("src/components/cover-letter-builder.tsx", "utf8");
const shell = readFileSync("src/components/app-shell.tsx", "utf8");

describe("nav geometry contract (derivation of the reservation)", () => {
  // Bottom-nav footprint from the app-shell markup, in px:
  //   `bottom-3` offset …
  const NAV_BOTTOM_OFFSET = 12;
  //   … + top padding py-2 …
  const NAV_TOP_PADDING = 8;
  //   … + link row: py-1.5 (6+6) + 20px icon + gap-1 (4) + label line (~15).
  const NAV_LINK_ROW = 51;
  //   … + bottom padding max(0.5rem, env(safe-area-inset-bottom)).
  const NAV_MIN_BOTTOM_PADDING = 8;
  const iPhoneSafeInset = 34; // typical home-indicator inset
  // The overlay's mobile bottom reservation: 6rem + env(safe-area-inset-bottom).
  const RESERVATION_BASE = 96;

  it("the reservation clears the nav with margin, with AND without a home indicator", () => {
    const withoutInset = NAV_BOTTOM_OFFSET + NAV_TOP_PADDING + NAV_LINK_ROW + NAV_MIN_BOTTOM_PADDING;
    const withInset = NAV_BOTTOM_OFFSET + NAV_TOP_PADDING + NAV_LINK_ROW + iPhoneSafeInset;
    // env(safe-area-inset-bottom) adds equally to reservation and nav, so
    // the margin only ever GROWS with the inset — both cases must clear:
    expect(RESERVATION_BASE).toBeGreaterThan(withoutInset); // 96 > 79
    expect(RESERVATION_BASE + iPhoneSafeInset).toBeGreaterThan(withInset); // 130 > 105
  });

  it("the bottom nav itself is unchanged (the contract the reservation is derived from)", () => {
    expect(shell).toContain(
      'glass fixed inset-x-3 bottom-3 z-30 flex items-center justify-around rounded-3xl px-2 py-2 lg:hidden',
    );
    expect(shell).toContain(
      'paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))"',
    );
  });
});

describe("AI letter modal: mobile layout guards (source)", () => {
  it("reserves bottom-nav space + iOS safe-area inset below lg, restores p-4 at lg", () => {
    expect(builder).toContain(
      "pb-[calc(6rem_+_env(safe-area-inset-bottom))]",
    );
    expect(builder).toContain("lg:pb-4");
    // The overlay stays centered + z-50 + dimmed (existing look):
    expect(builder).toContain(
      "fixed inset-0 z-50 flex items-center justify-center p-4",
    );
  });

  it("caps the card at the free area with a dvh cap (vh fallback) and scrolls internally", () => {
    // dvh for iOS Safari's dynamic viewport, vh fallback before that:
    expect(builder).toContain(
      "supports-[height:100dvh]:max-h-[min(100%,calc(100dvh_-_2.5rem))]",
    );
    expect(builder).toContain(
      "max-h-[min(100%,calc(100vh_-_2.5rem))]",
    );
    // Internal scrolling for content taller than the viewport:
    expect(builder).toContain("overflow-y-auto");
    expect(builder).toContain("overscroll-contain");
    // Card identity (width, radius, padding, focus ring) preserved:
    expect(builder).toContain(
      "w-full max-w-2xl overflow-y-auto overscroll-contain rounded-2xl border border-line bg-surface p-5 shadow-2xl outline-none sm:p-7",
    );
    // The old hard 85vh cap — the cause of the button landing in the
    // nav's footprint — is gone from this component:
    expect(builder).not.toContain("max-h-[85vh]");
  });

  it("form fields, validation and AI-generation wiring are intact (no behavior change)", () => {
    // Same settings payload into the existing /api/ai/cover-letter flow:
    expect(builder).toContain("fetch(\"/api/ai/cover-letter\"");
    expect(builder).toContain(
      "onGenerate({ position, company, jobDescription, tone, language })",
    );
    // Both selects keep their controlled wiring:
    expect(builder).toContain("value={tone}");
    expect(builder).toContain("value={language}");
    // All form inputs still present:
    for (const field of ["aiPosition", "aiCompany", "aiTone", "aiJobDescription", "aiLanguage"]) {
      expect(builder, `coverLetter.${field} must still be rendered`).toContain(field);
    }
    // Trigger + busy/cancel wiring unchanged:
    expect(builder).toContain("onClick={() => setAiModalOpen(true)}");
    expect(builder).toContain("disabled={busy}");
    expect(builder).toContain("variant=\"secondary\" onClick={onClose}");
  });
});

describe("AI letter modal: SSR smoke (builder still renders after the layout change)", () => {
  it("renders the builder; the modal overlay stays closed in the initial state", () => {
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(CoverLetterBuilder, { userId: "user-1" }),
      ),
    );
    // The fixed overlay is rendered ONLY when the modal is open — it is
    // absent from the SSR markup (no dialog flash, unchanged initial
    // behavior; the page starts in its loading/empty state):
    expect(html).not.toContain("fixed inset-0 z-50");
    expect(html).not.toContain("pb-[calc(6rem_+_env(safe-area-inset-bottom))]");
  });
});
