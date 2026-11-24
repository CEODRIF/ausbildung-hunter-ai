// @vitest-environment jsdom
/**
 * AUTO BEWERB — Step 7 "Senden bestätigen" modal: MOBILE contract.
 *
 * Production bug (screenshot repro, phones): the confirmation modal used the
 * default "md" card — NO max-height, NO internal scroll. With several
 * recipients the card grew past the viewport; the centered flex overlay then
 * clipped the card's BOTTOM, so the Cancel/Confirm row sat below the visible
 * area and the fixed glass bottom nav (app-shell, `z-30 lg:hidden`) painted
 * over that zone — the confirm button was unreachable.
 *
 * Fix contract (same geometric solution as the cover-letter AI modal, see
 * tests/cover-letter-ai-modal-mobile.test.tsx — the bottom nav PAINTS above
 * the modal overlay because the shell content wrapper is a `relative z-10`
 * stacking context that traps the overlay's z-50, so a z-index bump alone can
 * never work):
 *
 *  1. The overlay reserves the nav's FULL footprint (+ margin) below `lg`
 *     via `pb-[calc(6rem+env(safe-area-inset-bottom))]` and the iOS
 *     status-bar/home-indicator areas via the env() inset terms; `lg:p-4`
 *     restores the desktop layout (no nav on desktop).
 *  2. The card is a flex column capped at the overlay's free area
 *     (`min(100%, calc(100dvh−2.5rem))`, vh fallback) — it never extends
 *     past the safe areas or into the nav.
 *  3. The review content scrolls INSIDE the card (single scroll region —
 *     the per-company list loses its inner `max-h-64` cap below `lg`).
 *  4. The action row is a PINNED footer sibling of the scroll body (opaque
 *     background + top divider + `env(safe-area-inset-bottom)` padding),
 *     so the confirm button is ALWAYS visible and tappable.
 *  5. At `lg+` the card renders exactly like the previous "md" dialog
 *     (desktop design unchanged) and other Modal sizes are untouched.
 *  6. Sending behavior is untouched: one explicit confirmation, the modal
 *     closes on the first tap (button gone + `sending` state) → repeated
 *     taps cannot double-send.
 */
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "@/lib/i18n";
import { Modal } from "@/components/ui";
import { Step7Review } from "@/components/auto-bewerb/step7-review";
import { createBatchAction, sendCompaniesAction } from "@/app/auto-bewerb/actions";

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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ *
 * 1. Geometry contract (derivation, same math as the precedent)
 * ------------------------------------------------------------------ */
describe("nav geometry contract (derivation of the overlay reservation)", () => {
  const NAV_BOTTOM_OFFSET = 12; // bottom-3
  const NAV_TOP_PADDING = 8; // py-2
  const NAV_LINK_ROW = 51; // py-1.5 (6+6) + 20px icon + gap-1 (4) + label (~15)
  const NAV_MIN_BOTTOM_PADDING = 8; // max(0.5rem, env(safe-area-inset-bottom))
  const iPhoneSafeInset = 34;
  const RESERVATION_BASE = 96; // 6rem

  it("the overlay's mobile bottom reservation clears the nav, with AND without a home indicator", () => {
    const withoutInset = NAV_BOTTOM_OFFSET + NAV_TOP_PADDING + NAV_LINK_ROW + NAV_MIN_BOTTOM_PADDING;
    const withInset = NAV_BOTTOM_OFFSET + NAV_TOP_PADDING + NAV_LINK_ROW + iPhoneSafeInset;
    expect(RESERVATION_BASE).toBeGreaterThan(withoutInset); // 96 > 79
    expect(RESERVATION_BASE + iPhoneSafeInset).toBeGreaterThan(withInset); // 130 > 105
  });

  it("the bottom nav itself is unchanged (the contract the reservation is derived from)", () => {
    const shell = readFileSync("src/components/app-shell.tsx", "utf8");
    expect(shell).toContain("glass fixed inset-x-3 bottom-3 z-30 flex items-center justify-around rounded-3xl px-2 py-2 lg:hidden");
    expect(shell).toContain('paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))"');
  });
});

/* ------------------------------------------------------------------ *
 * 2. The Modal "sheet" size — structural contract
 * ------------------------------------------------------------------ */
describe('Modal size="sheet" — structural contract', () => {
  const footerEl = (
    <div className="flex justify-end gap-2">
      <button>Abbrechen</button>
      <button type="submit">Jetzt senden</button>
    </div>
  );

  function findCard(dialog: HTMLElement) {
    const card = Array.from(dialog.querySelectorAll("div")).find((d) =>
      (d.className as string).includes("max-h-[min(100%"),
    );
    expect(card, "the capped flex-column card").toBeTruthy();
    return card as HTMLElement;
  }
  function findBody(card: HTMLElement) {
    const body = Array.from(card.querySelectorAll("div")).find((d) =>
      (d.className as string).includes("overscroll-contain"),
    );
    expect(body, "the internal scroll body").toBeTruthy();
    return body as HTMLElement;
  }

  it("the overlay reserves the nav footprint + safe areas below lg and restores p-4 at lg", () => {
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
    expect(cls).toContain("pt-[calc(1rem+env(safe-area-inset-top))]");
    expect(cls).toContain("pb-[calc(6rem+env(safe-area-inset-bottom))]");
    expect(cls).toContain("lg:p-4"); // desktop unchanged
  });

  it("the card is a flex column capped at the safe area (dvh + vh fallback), lg restores the md card", () => {
    render(
      <I18nProvider>
        <Modal open onClose={() => {}} title="T" size="sheet" footer={footerEl}>
          <p>content</p>
        </Modal>
      </I18nProvider>,
    );
    const card = findCard(screen.getByRole("dialog"));
    const cls = card.className as string;
    expect(cls).toContain("flex");
    expect(cls).toContain("flex-col");
    expect(cls).toContain("overflow-hidden");
    expect(cls).toContain("max-w-md");
    expect(cls).toContain("max-h-[min(100%,calc(100vh_-_2.5rem))]");
    expect(cls).toContain("supports-[height:100dvh]:max-h-[min(100%,calc(100dvh_-_2.5rem))]");
    expect(cls).toContain("lg:max-h-none"); // no cap on desktop (previous md behavior)
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

  it("the footer is PINNED: a stable sibling of the scroll body, opaque, safe-area padded, lg-transparent", () => {
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
    expect(cls).toContain("pb-[calc(0.75rem+env(safe-area-inset-bottom))]"); // iPhone home indicator
    expect(cls).toContain("lg:border-0 lg:bg-transparent lg:px-0 lg:pb-0 lg:pt-5"); // desktop = previous md look
  });

  it("size=\"md\" is UNCHANGED (other dialogs keep their exact legacy card)", () => {
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
  });

  it("size=\"form\" and size=\"wide\" are UNCHANGED", () => {
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
 * 3. Step 7 confirmation modal — behavior + layout integration
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

    // The overlay applies the geometric reservation on THIS dialog:
    const overlayCls = dialog.className as string;
    expect(overlayCls).toContain("pb-[calc(6rem+env(safe-area-inset-bottom))]");
    expect(overlayCls).toContain("lg:p-4");

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
    // The modal is gone after the FIRST tap (no button left to hit):
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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

  it("cancel closes the modal without sending", async () => {
    mountStep7(2);
    const dialog = await openConfirmModal(2);
    fireEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createBatchAction).not.toHaveBeenCalled();
    expect(sendCompaniesAction).not.toHaveBeenCalled();
  });
});
