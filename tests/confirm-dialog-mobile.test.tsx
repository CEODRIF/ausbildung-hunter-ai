import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApplicationComposer } from "@/components/application-composer";
import { I18nProvider } from "@/lib/i18n";
import type { ApplicationDraft } from "@/lib/application-drafts";
import type { SafeEmailAccount } from "@/lib/email-oauth";

/**
 * Regression: on mobile (iOS Safari) the "Confirm applications" dialog's
 * final action buttons were covered by the fixed glass bottom nav.
 *
 * Why the nav wins paint order: the app-shell content wrapper
 * (`relative z-10 …`) is a stacking context that TRAPS the dialog overlay's
 * `z-50`, while the bottom nav is a shell sibling at `z-30`. The nav always
 * paints above the dialog — so the fix is geometric, not z-index:
 *
 *  1. The overlay reserves the nav's FULL footprint + a margin below `lg`
 *     (where the nav exists) via
 *     `pb-[calc(6rem_+_env(safe-area-inset-bottom))]`, restored to `p-5`
 *     at `lg` (no nav on desktop → desktop behavior unchanged).
 *  2. The dialog card is capped at the overlay's free area
 *     (`min(100%, calc(100vh - 2.5rem))`, refined to `100dvh` where
 *     supported — iOS Safari's dynamic viewport) and scrolls internally
 *     (`overflow-y-auto overscroll-contain`), so the last button can always
 *     be scrolled completely above the nav.
 *
 * Scheduling LOGIC is untouched: the same `scheduleApplications` /
 * `sendApplications` actions, hidden fields, gates and cancel wiring —
 * asserted below.
 */

const composer = readFileSync(
  "src/components/application-composer.tsx",
  "utf8",
);
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
    expect(RESERVATION_BASE).toBeGreaterThan(withoutInset); // 96 > 77
    expect(RESERVATION_BASE + iPhoneSafeInset).toBeGreaterThan(withInset); // 130 > 101
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

describe("confirm dialog: mobile layout guards (source)", () => {
  it("reserves bottom-nav space + iOS safe-area inset below lg, restores p-5 at lg", () => {
    expect(composer).toContain(
      "pb-[calc(6rem_+_env(safe-area-inset-bottom))]",
    );
    expect(composer).toContain("lg:pb-5");
    // The overlay stays centered + z-50 + dimmed (existing look):
    expect(composer).toContain(
      "fixed inset-0 z-50 flex items-center justify-center bg-navy/50",
    );
  });

  it("caps the card at the free area with a dvh cap (vh fallback) and scrolls internally", () => {
    // dvh for iOS Safari's dynamic viewport, vh fallback before that:
    expect(composer).toContain(
      "supports-[height:100dvh]:max-h-[min(100%,calc(100dvh_-_2.5rem))]",
    );
    expect(composer).toContain(
      "max-h-[min(100%,calc(100vh_-_2.5rem))]",
    );
    // Internal scrolling for content taller than the viewport:
    expect(composer).toContain("overflow-y-auto");
    expect(composer).toContain("overscroll-contain");
    // Card identity (width, radius, padding) preserved:
    expect(composer).toContain("w-full max-w-md");
    expect(composer).toContain("rounded-3xl border border-line bg-surface p-6 shadow-[var(--shadow-float)]");
  });

  it("scheduling/send logic wiring is byte-for-byte intact (no behavior change)", () => {
    expect(composer).toContain("action={sendApplications}");
    expect(composer).toContain("action={scheduleApplications}");
    expect(composer).toContain("onCancel={() => setConfirmOpen(false)}");
    expect(composer).toContain("submitLabel={t(\"apps.schedule.submitSchedule\")}");
    expect(composer).toContain("const sendGate = useRef(createSendGate()).current;");
    // Mode switch unchanged:
    expect(composer).toContain('sendMode === "now" ? (');
    expect(composer).toContain('onClick={() => setSendMode(mode)}');
  });
});

const account: SafeEmailAccount = {
  id: "acc-1",
  provider: "gmail",
  email: "test@example.com",
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  last_used_at: null,
};

const draft: ApplicationDraft = {
  id: "draft-1",
  user_id: "user-1",
  goal: "ausbildung",
  sender_email_account_id: "acc-1",
  subject: "Bewerbung um einen Ausbildungsplatz",
  body_html: "<p>Hallo</p>",
  body_text: "Hallo",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  opportunity_key: null,
  opportunity_title: null,
  opportunity_company: null,
  opportunity_source_url: null,
  recipients: [
    {
      id: "r-1",
      email: "job@firma.de",
      company_name: "Firma GmbH",
      contact_name: null,
      validation_status: "valid",
    },
  ],
  attachments: [],
};

describe("confirm dialog: SSR smoke (composer still renders after the layout change)", () => {
  it("renders the composer page; the dialog stays closed in the initial state", () => {
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(ApplicationComposer, { draft, accounts: [account] }),
      ),
    );
    // Page content present:
    expect(html).toContain("Prepare your Bewerbung");
    expect(html).toContain("Send applications");
    // Dialog is rendered ONLY when open — the fixed overlay is absent in
    // the SSR markup (no dialog flash, unchanged initial behavior):
    expect(html).not.toContain("fixed inset-0 z-50");
    expect(html).not.toContain("Confirm applications");
  });
});
