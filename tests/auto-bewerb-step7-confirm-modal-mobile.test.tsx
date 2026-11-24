// @vitest-environment jsdom
/**
 * AUTO BEWERB — Step 7 "Senden bestätigen" modal: MOBILE contract (v2).
 *
 * WHY v1 (PR #154) FAILED on real devices — two independent, VERIFIED causes
 * (reproduced from the SHIPPED source + the actual Tailwind v4-compiled CSS):
 *  1. STACKING TRAP (always in effect): the shell content wrapper
 *     (`relative z-10`, app-shell) is a stacking context that TRAPPED the
 *     overlay's `z-50`, while the bottom nav (`z-30`) is a SIBLING of the
 *     wrapper at the shell root — the nav therefore ALWAYS painted above the
 *     whole modal subtree and intercepted taps in its zone. No in-context
 *     z-index bump can escape a stacking context.
 *  2. WRONG-EDGE RESERVATION (deterministic on every phone): the v1 CSS was
 *     fully valid (verified in the f35dd52 build's compiled output — Tailwind
 *     v4 normalizes calc whitespace, `pb-[calc(6rem+env(…))]` ships as
 *     `padding-bottom: calc(6rem + env(…))`), so the 96px reservation DID
 *     apply — but it reserved space for the CARD BOTTOM (y = 96+envB), which
 *     clears the nav TOP (y = 70+max(8,envB)) by only ~17–26px. The send
 *     BUTTON sits 12+envB (footer pb) + ~40px (button) above the card
 *     bottom → a CONSTANT band at y ∈ [44, 84] from the viewport bottom
 *     (envB cancels in both terms) — below the nav top on EVERY phone:
 *     85% of the button under the glass with a 3-button nav (envB=0), 100%
 *     with gesture nav / iPhone (envB≥8). The #154 regression test compared
 *     the card edge to the nav top ("25px clearance") — the wrong edge — so
 *     CI was green while the button stayed covered and unpressable.
 *
 * v2 CONTRACT (this file):
 *  1. EVERY <Modal> portals to document.body (root-level stacking).
 *  2. The shell HIDES the bottom nav (display:none) while any modal is open —
 *     modal-open registry in @/components/ui — and restores it on close.
 *  3. The sheet card is BOTTOM-PINNED (`bottom: 1rem + env(bottom)`) and capped
 *     by the DYNAMIC viewport (`100dvh − 2rem − env(top) − env(bottom)`, vh
 *     fallback). The derivation below proves the card — footer included — stays
 *     inside the currently visible viewport on Android (chrome on top) and iOS
 *     (chrome on bottom) for ANY layout/dynamic viewport relationship.
 *  4. Content scrolls INSIDE the card (single scroll region); the footer is a
 *     stable `shrink-0` sibling — the confirm button never scrolls away.
 *  5. At lg+ the sheet renders EXACTLY like the previous "md" dialog
 *     (desktop unchanged); the md/form/wide sizes are untouched.
 *  6. Sending behavior untouched: one explicit confirmation, the modal closes
 *     on the first tap (button gone + `sending` state) → no double-send.
 */
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "@/lib/i18n";
import { isAnyModalOpen, Modal, subscribeModalOpen } from "@/components/ui";
import { AppShell } from "@/components/app-shell";
import { Step7Review } from "@/components/auto-bewerb/step7-review";
import { createBatchAction, sendCompaniesAction } from "@/app/auto-bewerb/actions";

// jsdom has no matchMedia (ThemeSwitcher, rendered inside AppShell, uses it
// for the system-theme listener) — minimal stub, this file only.
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
vi.mock("@/app/auto-bewerb/actions", () => ({
  cancelSendAction: vi.fn(),
  createBatchAction: vi.fn(),
  scheduleCompaniesAction: vi.fn(),
  sendCompaniesAction: vi.fn(),
}));

const wsHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/components/auto-bewerb/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/auto-bewerb/shared")>();
  return { ...actual, useAutoBewerb: () => wsHolder.current };
});

const TS = "2026-12-01T00:00:00.000Z";

function companyView(id: string, company: string, email: string, job: string) {
  return {
    company: {
      id,
      user_id: "u1",
      company,
      company_key: company.toLowerCase(),
      slot_no: 1,
      ad_raw: "x".repeat(40),
      ad_extracted: {
        jobTitle: job,
        occupation: job,
        company,
        companyAddress: "",
        location: "",
        startDate: "",
        applicationDeadline: "",
        requiredQualifications: [],
        preferredQualifications: [],
        technicalSkills: [],
        softSkills: [],
        languageRequirements: [],
        educationRequirement: "",
        responsibilities: [],
        requestedDocuments: [],
        applicationMethod: "",
        contactPerson: "",
        applicationEmail: email,
        companyNotes: [],
        missingOrAmbiguous: [],
      },
      ad_analysis: null,
      profile_snapshot: null,
      status: "ready",
      recipient_email: null,
      email_subject: null,
      email_body: null,
      email_attach_cv: true,
      email_attach_letter: true,
      email_account_id: null,
      idempotency_key: null,
      approved: true,
      approved_at: TS,
      scheduled_at: null,
      schedule_timezone: null,
      sent_at: null,
      provider_message_id: null,
      last_failure_code: null,
      ad_confirmed_at: TS,
      cv_reviewed_at: null,
      letter_reviewed_at: null,
      created_at: TS,
      updated_at: TS,
    },
    cv: { id: `cv-${id}` },
    cvVersion: 1,
    cvPdfName: `Lebenslauf_${company}.pdf`,
    letter: { id: `letter-${id}`, text: "…", tone: "professional" },
    letterVersion: 1,
    letterPdfName: `Anschreiben_${company}.pdf`,
    latestAttempt: null,
    letterTemplate: null,
    suggestedTemplate: null,
  };
}

function makeWs(count: number) {
  return {
    ready: true,
    setupIssue: null,
    profile: null,
    photoSupported: false,
    photo: null,
    companies: Array.from({ length: count }, (_, i) =>
      companyView(`c${i + 1}`, `Firma ${i + 1} GmbH`, `jobs@firma-${i + 1}.de`, `Ausbildung ${i + 1}`),
    ),
    attachments: [],
    emailTemplate: "<p>Body</p>",
    emailSettings: { body: "<p>Body</p>", recipient: "", subject: "Betreff", accountId: "acct1", attachCv: true, attachLetter: true },
    emailSettingsSupported: true,
    emailAccounts: [{ id: "acct1", provider: "gmail", email: "mail@example.de", is_active: true, requires_reconnect: false }],
    candidateName: "Mustapha Drif",
    batchesSupported: true,
    batches: [],
    sendHistory: [],
    sendStats: { sentToday: 0, scheduled: 0, processing: 0, totalToday: 0, failed: 0 },
  };
}

function mountStep7(count = 6) {
  const notify = vi.fn();
  const refresh = vi.fn();
  wsHolder.current = { ws: makeWs(count), refresh, notify, goToStep: vi.fn() };
  render(
    <I18nProvider>
      <Step7Review />
    </I18nProvider>,
  );
  return { notify, refresh };
}

async function openConfirmModal(count = 6) {
  for (let i = 1; i <= count; i += 1) fireEvent.click(screen.getByLabelText(`Firma ${i} GmbH`));
  fireEvent.click(screen.getByRole("button", { name: `Bewerbungen jetzt senden (${count})` }));
  return screen.findByRole("dialog");
}

const footerEl = (
  <div className="flex justify-end gap-2">
    <button>Abbrechen</button>
    <button type="submit">Jetzt senden</button>
  </div>
);

/** A sheet modal whose `open` state is driven from outside. */
function ModalHarness({ open }: { open: boolean }) {
  return (
    <Modal open={open} onClose={() => {}} title="T" size="sheet" footer={footerEl}>
      <p>content</p>
    </Modal>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Canary: no test may leak an open modal into the shared registry —
  // a leaked count would hide the bottom nav for every later test.
  expect(isAnyModalOpen()).toBe(false);
});

/* ------------------------------------------------------------------ *
 * 1. Sheet geometry contract (derivation of the v2 pin/cap)
 * ------------------------------------------------------------------ */
describe("sheet geometry contract (derivation, v2)", () => {
  /**
   * The card is pinned `bottom: 1rem + envB` from the viewport (layout)
   * bottom and capped at `100dvh − 2rem − envT − envB`. In the WORST case
   * (card at max height) its top is at
   *   (H − 1rem − envB) − (dvh − 2rem − envT − envB) = (H − dvh) + 1rem + envT,
   * i.e. exactly `visible top + 1rem` because `H − dvh` is precisely the
   * chrome area (Android: the expanded top omnibox; iOS: the status-bar
   * safe area — the Safari toolbar is excluded from H itself).
   */
  function cardBounds(H: number, dvh: number, envT: number, envB: number) {
    const bottomOffset = 16 + envB; // 1rem
    const maxH = dvh - 32 - envT - envB; // 100dvh − 2rem − envT − envB
    const cardBottom = H - bottomOffset; // pinned
    const cardTop = cardBottom - maxH; // worst case: card at max height
    return { cardTop, cardBottom };
  }

  it("Android Chrome (omnibox on TOP, bottom edge always visible): card stays inside the visible region", () => {
    const H = 844; // layout viewport (inset-0 overlay height)
    const omnibox = 134; // expanded top browser UI
    const envT = 0;
    const envB = 0;
    const dvh = H - omnibox; // dynamic viewport = visible region
    const { cardTop, cardBottom } = cardBounds(H, dvh, envT, envB);
    expect(cardTop).toBeGreaterThanOrEqual(omnibox + 16); // ≥ visible top + 1rem
    expect(cardBottom).toBeLessThanOrEqual(H); // never below the layout bottom
    // Toolbar collapsed (dvh = H): still inside.
    const collapsed = cardBounds(H, H, envT, envB);
    expect(collapsed.cardTop).toBeGreaterThanOrEqual(16);
  });

  it("iPhone Safari (toolbar on BOTTOM, status bar + home indicator safe areas): card stays inside the visible region", () => {
    const H = 766; // layout viewport (screen − Safari toolbar; cover adds the safe areas)
    const envT = 47; // status bar
    const envB = 34; // home indicator
    const dvh = H - envT; // visible region (below the status bar)
    const { cardTop, cardBottom } = cardBounds(H, dvh, envT, envB);
    expect(cardTop).toBeGreaterThanOrEqual(envT + 16); // ≥ visible top + 1rem
    expect(cardBottom).toBeLessThanOrEqual(H - 16 - envB); // ≥ 1rem + envB above the home indicator
  });

  it("reproduces the v1 failure deterministically: the 96px reservation cleared the CARD edge but not the BUTTON (all phones)", () => {
    /**
     * v1 as SHIPPED (verified in the f35dd52 build's compiled CSS — every
     * declaration was valid and present): overlay `fixed inset-0` with
     * `pb: 96+envB` (6rem reservation), centered card capped at
     * `min(100%, 100dvh−40)`; with tall review content the card fills the
     * padded box → card bottom at y = 96+envB from the viewport bottom.
     *
     * Bottom-nav footprint (app-shell): bottom-3 (12) + py-2 top (8) +
     * row (icon 20 + gap 4 + label ~14 + py-1.5 ×2 = 50) +
     * paddingBottom max(8, envB) → nav TOP at y = 70+max(8, envB).
     *
     * The v1 #154 regression test compared CARD BOTTOM (96/130) vs NAV TOP
     * (78/104) → "25px clearance" ✓ CI green. But the send BUTTON is a
     * ~40px row sitting 12+envB (footer pb) above the card bottom → the
     * button occupies y ∈ [44, 84] — a CONSTANT band (envB cancels out in
     * both terms) — entirely below the nav top (≥78) on every phone.
     */
    const FOOTER_PB = 12; // v1 footer: pb-[calc(0.75rem+envB)]
    const BUTTON_H = 40;
    const NAV_TOP = (envB: number) => 12 + 8 + 50 + Math.max(8, envB); // 70+max(8,envB)
    function v1ButtonBand(envB: number): [number, number] {
      const cardBottom = 96 + envB; // 6rem reservation (shipped, valid)
      const buttonBottom = cardBottom - (FOOTER_PB + envB);
      return [buttonBottom - BUTTON_H, buttonBottom]; // y from viewport bottom
    }
    for (const envB of [0, 24, 34]) {
      const [top, bottom] = v1ButtonBand(envB);
      expect(top).toBe(44);
      expect(bottom).toBe(84); // CONSTANT — envB cancels out
      // The v1 test's comparison (card edge vs nav top) PASSED…
      expect(96 + envB).toBeGreaterThan(NAV_TOP(envB));
      // …yet the button band was INSIDE the nav zone (paint order: nav on
      // top via the stacking trap) → 85–100% of the button covered:
      const covered = Math.min(bottom, NAV_TOP(envB)) - top;
      expect(covered / BUTTON_H).toBeGreaterThanOrEqual(0.85);
    }
    // v2: the nav is HIDDEN while the modal is open → no zone exists; and
    // the pinned card puts the button bottom at a deterministic
    // 4+envB px above the viewport bottom (16+envB card − 12 footer pb):
    for (const envB of [0, 24, 34]) {
      expect(16 + envB - 12).toBeGreaterThanOrEqual(4); // visible, uncovered
    }
    // The v2 pin/cap use the codebase's valid underscore calc form:
    const ui = readFileSync("src/components/ui.tsx", "utf8");
    expect(ui).toContain("bottom-[calc(1rem_+_env(safe-area-inset-bottom))]");
    expect(ui).toContain("max-h-[calc(100vh_-_2rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))]");
    expect(ui).toContain(
      "supports-[height:100dvh]:max-h-[calc(100dvh_-_2rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))]",
    );
  });

  it("the bottom nav itself is unchanged — it gets hidden, not re-sized", () => {
    const shell = readFileSync("src/components/app-shell.tsx", "utf8");
    expect(shell).toContain(
      'glass fixed inset-x-3 bottom-3 z-30 ${modalOpen ? "hidden" : "flex"} items-center justify-around rounded-3xl px-2 py-2 lg:hidden',
    );
    expect(shell).toContain('paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))"');
  });
});

/* ------------------------------------------------------------------ *
 * 2. Modal open-state registry + portal (root-level stacking)
 * ------------------------------------------------------------------ */
describe("modal open-state registry + portal", () => {
  it("an open sheet modal is PORTALED to document.body — not inside the caller's container", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      <I18nProvider>
        <ModalHarness open />
      </I18nProvider>,
      { container: host },
    );
    const dialog = screen.getByRole("dialog");
    // The overlay escaped the (potentially stacking-trapping) parent tree:
    expect(host.contains(dialog)).toBe(false);
    expect(dialog.parentElement).toBe(document.body);
    expect(isAnyModalOpen()).toBe(true);
    host.remove();
  });

  it("the registry reports open → closed across a full open/close cycle", async () => {
    const states: boolean[] = [];
    const unsubscribe = subscribeModalOpen((open) => states.push(open));
    const { rerender } = render(
      <I18nProvider>
        <ModalHarness open />
      </I18nProvider>,
    );
    expect(isAnyModalOpen()).toBe(true);
    expect(states).toContain(true);
    rerender(
      <I18nProvider>
        <ModalHarness open={false} />
      </I18nProvider>,
    );
    await waitFor(() => expect(isAnyModalOpen()).toBe(false));
    expect(states[states.length - 1]).toBe(false);
    unsubscribe();
  });

  it("overlapping modals: the registry stays open until the LAST modal closes", async () => {
    const a = render(
      <I18nProvider>
        <ModalHarness open />
      </I18nProvider>,
    );
    const b = render(
      <I18nProvider>
        <ModalHarness open />
      </I18nProvider>,
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    expect(isAnyModalOpen()).toBe(true);
    a.rerender(
      <I18nProvider>
        <ModalHarness open={false} />
      </I18nProvider>,
    );
    expect(isAnyModalOpen()).toBe(true); // b is still open
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
    b.rerender(
      <I18nProvider>
        <ModalHarness open={false} />
      </I18nProvider>,
    );
    await waitFor(() => expect(isAnyModalOpen()).toBe(false));
  });
});

/* ------------------------------------------------------------------ *
 * 3. App-shell bottom nav — hidden while a modal is open, restored on close
 * ------------------------------------------------------------------ */
describe("app-shell bottom nav — hidden while a modal is open", () => {
  function ShellWithModal({ open }: { open: boolean }) {
    return (
      <I18nProvider>
        <AppShell profile={null}>
          <Modal open={open} onClose={() => {}} title="T" size="sheet" footer={footerEl}>
            <p>content</p>
          </Modal>
        </AppShell>
      </I18nProvider>
    );
  }

  it("the nav is display:none while a modal is open and restored (flex) on close", () => {
    const { rerender } = render(<ShellWithModal open={false} />);
    // The shell has several <nav> elements (NavSectionList groups) — the
    // BOTTOM nav is the glass one (class marker, not tag).
    const nav = document.querySelector('nav[class*="glass"]') as HTMLElement;
    expect(nav, "the fixed glass bottom nav").toBeTruthy();
    // (Token-precise: `lg:hidden` is a DIFFERENT class token than `hidden`.)
    // Closed state: the nav is visible (its normal flex row).
    expect(nav.classList.contains("flex")).toBe(true);
    expect(nav.classList.contains("hidden")).toBe(false);

    // Open the modal: the registry flips the shell state → nav hidden.
    rerender(<ShellWithModal open />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(nav.classList.contains("hidden")).toBe(true);
    expect(nav.classList.contains("flex")).toBe(false);

    // Close the modal: the nav is restored.
    rerender(<ShellWithModal open={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(nav.classList.contains("flex")).toBe(true);
    expect(nav.classList.contains("hidden")).toBe(false);
  });

  it("the nav consumes the registry (wiring pin)", () => {
    const shell = readFileSync("src/components/app-shell.tsx", "utf8");
    expect(shell).toContain('import { subscribeModalOpen } from "@/components/ui";');
    expect(shell).toContain("const [modalOpen, setModalOpen] = useState(false);");
    expect(shell).toContain("useEffect(() => subscribeModalOpen(setModalOpen), []);");
  });
});

/* ------------------------------------------------------------------ *
 * 4. The Modal "sheet" size — structural contract (v2)
 * ------------------------------------------------------------------ */
describe('Modal size="sheet" — structural contract (v2)', () => {
  function findCard(dialog: HTMLElement) {
    const card = Array.from(dialog.querySelectorAll("div")).find((d) =>
      (d.className as string).includes("bottom-[calc(1rem_+_env"),
    );
    expect(card, "the bottom-pinned sheet card").toBeTruthy();
    return card as HTMLElement;
  }
  function findBody(card: HTMLElement) {
    const body = Array.from(card.querySelectorAll("div")).find((d) =>
      (d.className as string).includes("overscroll-contain"),
    );
    expect(body, "the internal scroll body").toBeTruthy();
    return body as HTMLElement;
  }

  it("the mobile overlay is BACKDROP-ONLY (the card positions itself); lg restores the exact md overlay", () => {
    render(
      <I18nProvider>
        <Modal open onClose={() => {}} title="T" size="sheet" footer={footerEl}>
          <p>content</p>
        </Modal>
      </I18nProvider>,
    );
    const overlay = screen.getByRole("dialog");
    const cls = overlay.className as string;
    expect(cls).toContain("fixed inset-0 z-50");
    expect(cls).toContain("lg:flex");
    expect(cls).toContain("lg:items-center");
    expect(cls).toContain("lg:justify-center");
    expect(cls).toContain("lg:p-4");
    // No mobile padding/centering that could mis-size the card against the
    // overlay, and no dead unspaced calc():
    expect(cls).not.toContain("pt-[calc");
    expect(cls).not.toContain("pb-[calc");
    // Portaled to the document root (see registry/portal tests):
    expect(overlay.parentElement).toBe(document.body);
  });

  it("the card is BOTTOM-PINNED with the dynamic-viewport cap (vh fallback); lg restores the md card", () => {
    render(
      <I18nProvider>
        <Modal open onClose={() => {}} title="T" size="sheet" footer={footerEl}>
          <p>content</p>
        </Modal>
      </I18nProvider>,
    );
    const card = findCard(screen.getByRole("dialog"));
    const cls = card.className as string;
    expect(cls).toContain("absolute");
    expect(cls).toContain("inset-x-4");
    expect(cls).toContain("bottom-[calc(1rem_+_env(safe-area-inset-bottom))]");
    expect(cls).toContain("z-10");
    expect(cls).toContain("flex");
    expect(cls).toContain("flex-col");
    expect(cls).toContain("overflow-hidden");
    // The v2 cap — dynamic viewport minus ALL safe areas (valid calc, `_` form):
    expect(cls).toContain("max-h-[calc(100vh_-_2rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))]");
    expect(cls).toContain(
      "supports-[height:100dvh]:max-h-[calc(100dvh_-_2rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))]",
    );
    // The v1 cap is gone (it assumed overlay height == visible viewport):
    expect(cls).not.toContain("max-h-[min(100%");
    // At lg the card becomes exactly the "md" card:
    expect(cls).toContain("lg:static");
    expect(cls).toContain("lg:inset-x-auto");
    expect(cls).toContain("lg:bottom-auto");
    expect(cls).toContain("lg:w-full");
    expect(cls).toContain("lg:max-w-md");
    expect(cls).toContain("lg:max-h-none");
    expect(cls).toContain("lg:p-5");
  });

  it("the body scrolls internally below lg and flows naturally at lg", () => {
    render(
      <I18nProvider>
        <Modal open onClose={() => {}} title="T" size="sheet" footer={footerEl}>
          <p>content</p>
        </Modal>
      </I18nProvider>,
    );
    const card = findCard(screen.getByRole("dialog"));
    const body = findBody(card);
    const cls = body.className as string;
    expect(cls).toContain("flex-1");
    expect(cls).toContain("min-h-0");
    expect(cls).toContain("overflow-y-auto");
    expect(cls).toContain("overscroll-contain");
    expect(cls).toContain("lg:overflow-visible");
    expect(cls).toContain("lg:p-0");
  });

  it("the footer is PINNED: a stable sibling of the scroll body, opaque, simple padding (the card owns the safe area)", () => {
    render(
      <I18nProvider>
        <Modal open onClose={() => {}} title="T" size="sheet" footer={footerEl}>
          <p>content</p>
        </Modal>
      </I18nProvider>,
    );
    const card = findCard(screen.getByRole("dialog"));
    const body = findBody(card);
    const submit = screen.getByRole("button", { name: "Jetzt senden" });
    // The confirm button is NOT inside the scrollable body (it can never scroll away):
    expect(body.contains(submit)).toBe(false);
    const footer = submit.closest("div.shrink-0") as HTMLElement;
    expect(footer, "the pinned footer row").toBeTruthy();
    expect(card.contains(footer)).toBe(true);
    const cls = footer.className as string;
    expect(cls).toContain("shrink-0");
    expect(cls).toContain("border-t"); // clear separation from the scrolling content
    expect(cls).toContain("bg-surface/95"); // opaque background — no visual bleed-through
    expect(cls).toContain("pb-3"); // the card's bottom offset owns the safe area (no double env)
    expect(cls).not.toContain("pb-[calc"); // the v1 double-counted env() form is gone
    expect(cls).toContain("lg:border-0 lg:bg-transparent lg:px-0 lg:pb-0 lg:pt-5"); // desktop = previous md look
  });

  it('size="md" is UNCHANGED (other dialogs keep their exact legacy card; the portal is DOM-only)', () => {
    render(
      <I18nProvider>
        <Modal open onClose={() => {}} title="T">
          <p>legacy content</p>
        </Modal>
      </I18nProvider>,
    );
    const overlay = screen.getByRole("dialog");
    const legacy = Array.from(overlay.querySelectorAll("div")).find((d) =>
      (d.className as string).includes("max-w-md"),
    );
    expect(legacy).toBeTruthy();
    const cls = (legacy as HTMLElement).className as string;
    // The legacy md card: no flex column, no max-height, no footer slot.
    expect(cls).toBe("relative z-10 w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-2xl");
    expect(cls).not.toContain("max-h");
    expect(screen.queryByRole("button", { name: "Jetzt senden" })).toBeNull();
    expect(overlay.className).toBe("fixed inset-0 z-50 flex items-center justify-center p-4");
    // …and it portals to the document root too (no visual change):
    expect(overlay.parentElement).toBe(document.body);
  });

  it('size="form" and size="wide" are UNCHANGED', () => {
    render(
      <I18nProvider>
        <Modal open onClose={() => {}} title="T" size="form">
          <p>form</p>
        </Modal>
      </I18nProvider>,
    );
    const formCard = Array.from(screen.getByRole("dialog").querySelectorAll("div")).find((d) =>
      (d.className as string).includes("max-h-[90vh]"),
    );
    expect(formCard).toBeTruthy();

    cleanup();
    render(
      <I18nProvider>
        <Modal open onClose={() => {}} title="T" size="wide">
          <p>wide</p>
        </Modal>
      </I18nProvider>,
    );
    const wideCard = Array.from(screen.getByRole("dialog").querySelectorAll("div")).find((d) =>
      (d.className as string).includes("max-h-[94vh]"),
    );
    expect(wideCard).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * 5. Step 7 confirmation modal — behavior + layout integration
 * ------------------------------------------------------------------ */
describe("Step 7 confirm modal — mobile behavior", () => {
  it("shows ALL recipients/attachments/e-mail for review, with the confirm button pinned below the scroll region", async () => {
    mountStep7(6);
    const dialog = await openConfirmModal(6);
    expect(within(dialog).getByText("Senden bestätigen")).toBeInTheDocument();

    // Every one of the 6 companies is reviewable inside the modal:
    for (let i = 1; i <= 6; i += 1) {
      expect(within(dialog).getByText(`jobs@firma-${i}.de`)).toBeInTheDocument();
    }
    // Shared e-mail + attachment filenames are shown:
    expect(within(dialog).getByText("mail@example.de")).toBeInTheDocument();
    expect(within(dialog).getByText(/Lebenslauf_Firma 3 GmbH\.pdf/)).toBeInTheDocument();

    // The overlay is the portaled, backdrop-only v2 shell on THIS dialog:
    const overlayCls = dialog.className as string;
    expect(overlayCls).toContain("fixed inset-0 z-50");
    expect(overlayCls).toContain("lg:p-4");
    expect(dialog.parentElement).toBe(document.body);
    // …and it drives the bottom-nav hide while open:
    expect(isAnyModalOpen()).toBe(true);

    // The per-company list no longer scrollsWithin-scrolls on mobile
    // (single scroll region = the sheet body); desktop keeps its cap:
    const list = dialog.querySelector('[class*="max-h-64"]') as HTMLElement;
    expect(list, "the per-company list container").toBeTruthy();
    expect(list.className).toContain("overflow-auto"); // lg+ cap intact
    expect(list.className).toContain("max-lg:max-h-none");
    expect(list.className).toContain("max-lg:overflow-visible");

    // The confirm button sits in the pinned footer (not the scroll body):
    const confirm = within(dialog).getByRole("button", { name: "Jetzt senden (6)" });
    const body = Array.from(dialog.querySelectorAll("div")).find((d) =>
      (d.className as string).includes("overscroll-contain"),
    ) as HTMLElement;
    expect(body.contains(confirm)).toBe(false);
  });

  it("mobile action layout: the send button is a FULL-WIDTH primary row (top), cancel below it; lg+ keeps the side-by-side row", async () => {
    mountStep7(2);
    const dialog = await openConfirmModal(2);
    const confirm = within(dialog).getByRole("button", { name: "Jetzt senden (2)" });
    const cancel = within(dialog).getByRole("button", { name: "Abbrechen" });
    // The two buttons share ONE row container:
    const row = confirm.parentElement as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.contains(cancel)).toBe(true);
    const cls = row.className as string;
    // Mobile: stacked (column, reversed so the primary send is ON TOP),
    // both buttons full-width — the organized full-bleed action layout.
    expect(cls).toContain("flex-col-reverse");
    expect(cls).toContain("gap-2");
    expect(cls).toContain("lg:flex-row"); // desktop: back to the row
    expect(cls).toContain("lg:justify-end");
    expect(confirm.className).toContain("w-full");
    expect(confirm.className).toContain("lg:w-auto");
    expect(cancel.className).toContain("w-full");
    expect(cancel.className).toContain("lg:w-auto");
    // DOM order keeps cancel first → in the reversed mobile column the
    // PRIMARY send renders on top, cancel beneath it.
    expect(Array.from(row.children).indexOf(cancel)).toBeLessThan(
      Array.from(row.children).indexOf(confirm),
    );
  });

  it("one confirm tap closes the modal and sends EXACTLY once — repeated taps cannot double-send", async () => {
    (createBatchAction as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: {
        ok: true,
        batchId: "b1",
        batchNo: 7,
        status: "completed",
        scheduledAt: null,
        items: Array.from({ length: 6 }, (_, i) => ({ companyId: `c${i + 1}`, ok: true, dispatchStatus: "sent" })),
      },
    });
    mountStep7(6);
    const dialog = await openConfirmModal(6);
    const confirm = within(dialog).getByRole("button", { name: "Jetzt senden (6)" });

    // Rapid double-tap (the reported mobile failure mode):
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(createBatchAction).toHaveBeenCalledTimes(1));
    expect(createBatchAction).toHaveBeenCalledWith(
      ["c1", "c2", "c3", "c4", "c5", "c6"],
      null,
      true,
    );
    // The modal is gone after the FIRST tap (no button left to hit) and the
    // registry (→ bottom nav) is released:
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(isAnyModalOpen()).toBe(false);
  });

  it("while the batch request is in flight the modal is already closed (the sending state guards the page)", async () => {
    let resolveBatch: (v: unknown) => void;
    (createBatchAction as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBatch = resolve;
        }),
    );
    mountStep7(2);
    const dialog = await openConfirmModal(2);
    fireEvent.click(within(dialog).getByRole("button", { name: "Jetzt senden (2)" }));
    // Synchronously closed — nothing on screen can trigger a second send:
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createBatchAction).toHaveBeenCalledTimes(1);
    resolveBatch!({
      ok: true,
      value: {
        ok: true,
        batchId: "b1",
        batchNo: 8,
        status: "completed",
        scheduledAt: null,
        items: [
          { companyId: "c1", ok: true, dispatchStatus: "sent" },
          { companyId: "c2", ok: true, dispatchStatus: "sent" },
        ],
      },
    });
  });

  it("cancel closes the modal without sending and restores the bottom nav", async () => {
    mountStep7(2);
    const dialog = await openConfirmModal(2);
    expect(isAnyModalOpen()).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createBatchAction).not.toHaveBeenCalled();
    expect(sendCompaniesAction).not.toHaveBeenCalled();
    // Registry released → the shell shows the nav again:
    expect(isAnyModalOpen()).toBe(false);
  });
});
