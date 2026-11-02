// @vitest-environment jsdom
/**
 * AUTO BEWERB — Step 7 Versand page UI contract (jsdom).
 *
 * Reference layout (three zones, one page):
 *   1. Versand-Regeln banner on top — the SERVER-enforced rules with their
 *      REAL values (fixed 5–6 s per-account interval, the daily
 *      07:30–10:30 Europe/Berlin window, server-side dedupe — the system
 *      has no per-hour/per-day counters, so none are displayed);
 *   2. two adjacent sections: "1. Unternehmen auswählen" (wider, left —
 *      select-all row, live counter, per-company data + readiness) and
 *      "2. Versand & Zeitplan" (right — send-now / schedule mode switch,
 *      the single primary action, the real sending settings, statistics,
 *      Smart Sending policy, results of the last accepted batch);
 *   3. "3. Versand-Ergebnisse (Versand-Historie)" full-width below — the
 *      preserved audit records (redesigned in PR #137, unchanged here).
 *
 * Functional contracts preserved from the pre-refactor tests:
 *   - send now behind the explicit confirmation modal (client passes ONLY
 *     company ids + confirmation);
 *   - NO "Versand-Warteschlange" panel (persisted batches render nothing);
 *   - partial exclusion: an incomplete selected company is dropped with its
 *     reason and never blocks the eligible subset;
 *   - the global 100-company cap (persisted server counters);
 *   - scheduled sends stay trackable (review row + statistics);
 *   - statistics from ws.sendStats (persisted data, never demo numbers);
 *   - graceful legacy mode (batchesSupported = false; full per-company
 *     workflow intact).
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "@/lib/i18n";
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

function companyRow(id: string, company: string, email: string, job: string, approved: boolean) {
  return {
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
    approved,
    approved_at: approved ? TS : null,
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
  };
}

function companyView(id: string, company: string, email: string, job: string, approved: boolean) {
  return {
    company: companyRow(id, company, email, job, approved),
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

function batchView(over: Record<string, unknown> = {}) {
  return {
    id: "batch-1",
    user_id: "u1",
    batch_no: 1,
    snapshot: {
      items: [
        { companyId: "ca", company: "Firma A GmbH", position: "Mechatroniker", recipientEmail: "jobs@firma-a.de", cvPdfName: "cv1.pdf", letterPdfName: "lt1.pdf", sharedDocs: [] },
        { companyId: "cb", company: "Firma B AG", position: "Elektroniker", recipientEmail: "hr@firma-b.de", cvPdfName: "cv2.pdf", letterPdfName: "lt2.pdf", sharedDocs: [] },
      ],
      subject: "Betreff",
      accountId: "acct1",
      accountEmail: "mail@example.de",
      attachCv: true,
      attachLetter: true,
      sharedDocs: [],
    },
    account_id: "acct1",
    status: "scheduled",
    scheduled_at: new Date(Date.now() + 2 * 3600_000).toISOString(),
    started_at: null,
    completed_at: null,
    created_at: TS,
    updated_at: TS,
    sentCount: 0,
    failedCount: 0,
    pendingCount: 2,
    ...over,
  };
}

const readyCompanies = () => [
  companyView("ca", "Firma A GmbH", "jobs@firma-a.de", "Mechatroniker", true),
  companyView("cb", "Firma B AG", "hr@firma-b.de", "Elektroniker", true),
];

function historyView(over: Record<string, unknown> = {}) {
  return {
    companyId: "cs",
    company: "Firma C GmbH",
    position: "Fachinformatiker",
    recipient: "jobs@firma-c.de",
    status: "sent" as const,
    sentAt: TS,
    accountEmail: "mail@example.de",
    batchId: "batch-history-1",
    ...over,
  };
}

function makeWs(opts: {
  batchMode?: boolean;
  companies?: ReturnType<typeof companyView>[];
  batches?: Record<string, unknown>[];
  sendHistory?: ReturnType<typeof historyView>[];
  stats?: { sentToday: number; scheduled: number; processing: number; totalToday: number; failed?: number };
  capacity?: { reserved: number; capacity: number; available: number };
}) {
  return {
    ready: true,
    setupIssue: null,
    profile: null,
    photoSupported: false,
    photo: null,
    companies: opts.companies ?? readyCompanies(),
    attachments: [],
    emailTemplate: "<p>Body</p>",
    emailSettings: { body: "<p>Body</p>", recipient: "", subject: "Betreff", accountId: "acct1", attachCv: true, attachLetter: true },
    emailSettingsSupported: true,
    emailAccounts: [{ id: "acct1", provider: "gmail", email: "mail@example.de", is_active: true, requires_reconnect: false }],
    candidateName: "Mustapha Drif",
    batchesSupported: opts.batchMode ?? true,
    batches: opts.batches ?? [],
    sendHistory: opts.sendHistory ?? [],
    sendStats: opts.stats ?? { sentToday: 0, scheduled: 0, processing: 0, totalToday: 0, failed: 0 },
    ...(opts.capacity ? { capacity: opts.capacity } : {}),
  };
}

function mount(ws: Record<string, unknown>) {
  const notify = vi.fn();
  const refresh = vi.fn();
  wsHolder.current = { ws, refresh, notify, goToStep: vi.fn() };
  render(
    <I18nProvider>
      <Step7Review />
    </I18nProvider>,
  );
  return { notify, refresh };
}

afterEach(cleanup);

describe("Step 7 page layout (reference: banner + two adjacent sections + full-width history)", () => {
  it("renders the three zones: real rules banner, both adjacent sections, redesigned history below", () => {
    mount(makeWs({
      batches: [batchView()], // must NOT render a queue section
      sendHistory: [
        historyView(),
        historyView({ companyId: "cd", company: "Firma D GmbH", position: "Kaufmann", recipient: "hr@firma-d.de", status: "cancelled", sentAt: null, batchId: null }),
      ],
      stats: { sentToday: 2, scheduled: 1, processing: 0, totalToday: 5, failed: 0 },
    }));
    // --- Zone 1: the rules banner with the REAL enforced values only ---
    expect(screen.getByText("Versand-Regeln (sicher & realistisch)")).toBeInTheDocument();
    expect(screen.getByText("Mindestens 5–6 Sekunden Abstand")).toBeInTheDocument();
    expect(screen.getByText("Sende-Fenster 07:30–10:30 Europe/Berlin")).toBeInTheDocument();
    expect(screen.getByText("Keine doppelten Sendungen")).toBeInTheDocument();
    // The system has no per-hour / per-day counters — no fake limits:
    expect(screen.queryByText(/pro Stunde/)).toBeNull();
    expect(screen.queryByText(/Tageslimit/)).toBeNull();
    // --- Zone 2a: "1. Unternehmen auswählen" (wider, left) ---
    expect(screen.getByText("1. Unternehmen auswählen")).toBeInTheDocument();
    expect(screen.getByText("Wählen Sie die Unternehmen aus, an die Sie Ihre Bewerbung senden möchten.")).toBeInTheDocument();
    expect(screen.getByText("Alle auswählen")).toBeInTheDocument();
    expect(screen.getByText("Ausgewählt: 0 / 2")).toBeInTheDocument();
    expect(screen.getByText("0 von 2 ausgewählt")).toBeInTheDocument();
    // Every company stays fully visible (name + position + recipient e-mail):
    expect(screen.getAllByText("Firma A GmbH")).toHaveLength(1);
    expect(screen.getByText("Mechatroniker")).toBeInTheDocument();
    expect(screen.getAllByText("jobs@firma-a.de").length).toBeGreaterThanOrEqual(1);
    // --- Zone 2b: "2. Versand & Zeitplan" (right) ---
    expect(screen.getByText("2. Versand & Zeitplan")).toBeInTheDocument();
    expect(screen.getByText("Legen Sie den Zeitpunkt und die Versand-Optionen fest.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jetzt senden" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zeitlich planen" })).toBeInTheDocument();
    // Real, read-only sending settings (engine constants + the window):
    expect(screen.getByText("Versand-Einstellungen")).toBeInTheDocument();
    expect(screen.getByText("6 Sekunden (erlaubt 5–6)")).toBeInTheDocument();
    expect(screen.getByText("07:30–10:30 Europe/Berlin")).toBeInTheDocument();
    expect(screen.getByText("werden serverseitig verhindert")).toBeInTheDocument();
    // Smart Sending policy (compact, still present, real constants):
    expect(screen.getByText("Smart Sending")).toBeInTheDocument();
    expect(screen.getByText("IMMER AN")).toBeInTheDocument();
    expect(screen.getByText("5–6 Sekunden")).toBeInTheDocument();
    expect(screen.getByText("6 Sekunden")).toBeInTheDocument();
    expect(screen.getByText("5 Sekunden")).toBeInTheDocument();
    expect(screen.getByText(/3 Minuten 30 Sekunden/)).toBeInTheDocument();
    // Statistics from persisted data (batch-independent):
    expect(screen.getByText("Versand-Statistik")).toBeInTheDocument();
    expect(screen.getByText("Heute gesendet")).toBeInTheDocument();
    expect(screen.getByText("Heute gesamt")).toBeInTheDocument();
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(1);
    // --- Zone 3: Versand-Historie (redesigned in PR #137) full-width below —
    // numbered title, subtitle, REAL summary badges, every persisted field.
    // (jsdom renders the desktop table AND the mobile cards — count-aware
    // matchers throughout.)
    expect(screen.getByText(/Versand-Ergebnisse \(Versand-Historie\)/)).toBeInTheDocument();
    expect(screen.getByText(/Übersicht aller gesendeten Bewerbungen/)).toBeInTheDocument();
    // Summary badges = counts of the EXACT displayed rows (1 sent, 1
    // cancelled, 0 failed — never hardcoded):
    expect(screen.getByText("Erfolgreich: 1")).toBeInTheDocument();
    expect(screen.getByText("Fehlgeschlagen: 0")).toBeInTheDocument();
    expect(screen.getByText("Gesamt: 2")).toBeInTheDocument();
    // Table headers:
    expect(screen.getByText("Unternehmen")).toBeInTheDocument();
    expect(screen.getByText("Gesendet am")).toBeInTheDocument();
    expect(screen.getAllByText("Status").length).toBeGreaterThanOrEqual(1);
    // Row 1 (sent): company, position, recipient, success badge:
    expect(screen.getAllByText("Firma C GmbH").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Fachinformatiker").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/jobs@firma-c\.de/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Erfolgreich").length).toBeGreaterThanOrEqual(1);
    // Row 2 (cancelled): the existing status stays visible:
    expect(screen.getAllByText("Abgebrochen").length).toBeGreaterThanOrEqual(1);
    // Details are collapsed by default (account + batch hidden)…
    expect(screen.queryByText(/Versand-Konto:/)).toBeNull();
    // …and accessible through the details action:
    fireEvent.click(screen.getAllByRole("button", { name: /Details — Firma C GmbH/ })[0]);
    expect(screen.getAllByText(/Versand-Konto/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/batch-hi/).length).toBeGreaterThanOrEqual(1);
    // The removed "Versand-Warteschlange" section — and every part of it —
    // is gone (title, batch chip, count, account line, countdown, details):
    expect(screen.queryByText("Versand-Warteschlange")).toBeNull();
    expect(screen.queryByText("Batch #1")).toBeNull();
    expect(screen.queryByText("2 Unternehmen")).toBeNull();
    expect(screen.queryByText("Von: mail@example.de")).toBeNull();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
  });

  it("select-all selects every company at once; the live counters update; a second click clears", () => {
    mount(makeWs({}));
    const selectAll = screen.getByLabelText("Alle auswählen");
    fireEvent.click(selectAll);
    expect(screen.getByText("Ausgewählt: 2 / 2")).toBeInTheDocument();
    expect(screen.getByText("2 von 2 ausgewählt")).toBeInTheDocument();
    expect(screen.getByText("2 von 2 bereit")).toBeInTheDocument();
    // Select-all again (now checked) clears the whole selection:
    fireEvent.click(screen.getByLabelText("Alle auswählen"));
    expect(screen.getByText("Ausgewählt: 0 / 2")).toBeInTheDocument();
    expect(screen.getByText("0 von 2 ausgewählt")).toBeInTheDocument();
  });

  it("the mode switch reveals the schedule form (validated future datetime flow untouched)", () => {
    mount(makeWs({}));
    // Select both companies so the actions are active:
    fireEvent.click(screen.getByLabelText("Firma A GmbH"));
    fireEvent.click(screen.getByLabelText("Firma B AG"));
    // Default mode: send now — the primary send action is visible, the
    // schedule form is hidden (asserted via its hidden timezone field):
    expect(screen.getByRole("button", { name: "Bewerbungen jetzt senden (2)" })).toBeInTheDocument();
    expect(document.querySelector('input[name="scheduleTimezone"]')).toBeNull();
    // Switch to schedule mode: the existing ScheduleForm appears (send action hidden):
    fireEvent.click(screen.getByRole("button", { name: "Zeitlich planen" }));
    expect(document.querySelector('input[name="scheduleTimezone"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Zeitlich planen" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Bewerbungen jetzt senden (2)" })).toBeNull();
    // …and switching back reveals the primary send action again:
    fireEvent.click(screen.getByRole("button", { name: "Jetzt senden" }));
    expect(document.querySelector('input[name="scheduleTimezone"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Jetzt senden" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Bewerbungen jetzt senden (2)" })).toBeInTheDocument();
  });
});

describe("Step 7 batch UI (batchesSupported = true)", () => {
  it("selecting companies updates the counters; send-now goes through the confirmation modal with ids + confirmation ONLY", async () => {
    (createBatchAction as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: {
        ok: true,
        batchId: "b1",
        batchNo: 7,
        status: "completed",
        scheduledAt: null,
        items: [
          { companyId: "ca", ok: true, dispatchStatus: "sent" },
          { companyId: "cb", ok: true, dispatchStatus: "sent" },
        ],
      },
    });
    const { notify } = mount(makeWs({}));
    fireEvent.click(screen.getByLabelText("Firma A GmbH"));
    fireEvent.click(screen.getByLabelText("Firma B AG"));
    expect(screen.getByText("Ausgewählt: 2 / 2")).toBeInTheDocument();
    expect(screen.getByText("2 von 2 ausgewählt")).toBeInTheDocument();
    expect(screen.getByText("2 von 2 bereit")).toBeInTheDocument();
    // Send now → explicit confirmation modal with the exact shared config:
    fireEvent.click(screen.getByRole("button", { name: "Bewerbungen jetzt senden (2)" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Senden bestätigen")).toBeInTheDocument();
    // The modal shows the ONE shared e-mail (preview + every company's card):
    expect(within(dialog).getAllByText("Betreff").length).toBeGreaterThanOrEqual(3);
    expect(within(dialog).getByText("mail@example.de")).toBeInTheDocument();
    expect(within(dialog).getByText("jobs@firma-a.de")).toBeInTheDocument();
    expect(within(dialog).getByText("hr@firma-b.de")).toBeInTheDocument();
    // Confirm: ONLY company ids + the explicit confirmation leave the client:
    fireEvent.click(screen.getByRole("button", { name: "Jetzt senden (2)" }));
    await waitFor(() => expect(createBatchAction).toHaveBeenCalledTimes(1));
    expect(createBatchAction).toHaveBeenCalledWith(["ca", "cb"], null, true);
    // Accepted batch leaves the active selection (spec D) + honest result:
    await waitFor(() => expect(notify).toHaveBeenCalledWith("success", expect.stringContaining("Batch #7")));
    await waitFor(() => expect(screen.getByText("Ausgewählt: 0 / 2")).toBeInTheDocument());
  });

  // 30 s budget: this test clicks 100 checkboxes sequentially, each re-rendering
  // the full 101-row list — fine locally, but beyond vitest's 5 s default on
  // slower CI runners (assertions are unchanged, only the time budget).
  it(
    "enforces the global 100-company cap for the current batch (101st only rejected at exhausted capacity)",
    () => {
      const many = Array.from({ length: 101 }, (_, i) =>
        companyView(`c${i + 1}`, `Firma ${i + 1} GmbH`, `jobs@firma-${i + 1}.de`, `Ausbildung ${i + 1}`, true),
      );
      mount(makeWs({
        companies: many,
        capacity: { reserved: 100, capacity: 100, available: 0 }, // global capacity exhausted (persisted server data)
      }));
      for (let i = 1; i <= 100; i++) fireEvent.click(screen.getByLabelText(`Firma ${i} GmbH`));
      expect(screen.getByText("100 von 100 bereit")).toBeInTheDocument();
      // The 101st company cannot be added to the current batch — the selection is
      // bounded by the GLOBAL capacity (exhausted at 100 reserved):
      expect(screen.getByLabelText("Firma 101 GmbH")).toBeDisabled();
      expect(screen.getByText("Maximal 100 Unternehmen pro Batch — begrenzt durch Ihre globale Kapazität.")).toBeInTheDocument();
      // The exhausted capacity is displayed from the persisted counters:
      expect(screen.getByText("100 / 100")).toBeInTheDocument();
    },
    30_000,
  );

  it("an incomplete company can be selected; it is EXCLUDED (with reason) and never blocks the rest (partial batch)", () => {
    const companies = [
      companyView("ca", "Firma A GmbH", "jobs@firma-a.de", "Mechatroniker", true),
      // missing CV (the workspace view types cv as nullable in production):
      { ...companyView("cb", "Firma B AG", "hr@firma-b.de", "Elektroniker", true), cv: null, cvVersion: null, cvPdfName: null } as unknown as ReturnType<typeof companyView>,
    ];
    mount(makeWs({ companies }));
    fireEvent.click(screen.getByLabelText("Firma A GmbH"));
    fireEvent.click(screen.getByLabelText("Firma B AG"));
    expect(screen.getByText("1 von 2 bereit")).toBeInTheDocument();
    expect(screen.getByText("Unvollständig")).toBeInTheDocument();
    // The actionable gap names the REAL missing document (no approval gap):
    expect(screen.getByText(/Lebenslauf noch nicht erstellt/)).toBeInTheDocument();
    expect(screen.queryByText(/genehmigt/)).toBeNull();
    // Sending is NOT blocked by the incomplete company — the button counts
    // only the send-ready subset (1 of 2) and stays enabled:
    const sendBtn = screen.getByRole("button", { name: "Bewerbungen jetzt senden (1)" });
    expect(sendBtn).toBeEnabled();
  });

  it("scheduled sends stay trackable WITHOUT the queue panel: review list shows the scheduled time, stats count them", () => {
    // A company already committed to a scheduled batch (status = "scheduled"):
    const scheduled = {
      ...companyView("cs", "Firma S GmbH", "jobs@firma-s.de", "Elektroniker", true),
      company: { ...companyRow("cs", "Firma S GmbH", "jobs@firma-s.de", "Elektroniker", true), status: "scheduled", scheduled_at: TS },
    } as unknown as ReturnType<typeof companyView>;
    mount(makeWs({
      companies: [scheduled],
      batches: [batchView()], // persisted batch — still must NOT render
      stats: { sentToday: 0, scheduled: 1, processing: 0, totalToday: 1, failed: 0 },
    }));
    // No queue section, no cancel button (the batch cancel API remains
    // server-side; the UI tracking surface is the review list + stats):
    expect(screen.queryByText("Versand-Warteschlange")).toBeNull();
    expect(screen.queryByRole("button", { name: "Abbrechen" })).toBeNull();
    // The scheduled company stays in the review list with its scheduled time:
    expect(screen.getByText("Firma S GmbH")).toBeInTheDocument();
    expect(screen.getAllByText("Geplant").length).toBeGreaterThanOrEqual(1); // pill + stats label
    expect(screen.getByText(/Geplant:/)).toBeInTheDocument(); // scheduled_at line
    // The persisted statistics still surface the scheduled counter:
    expect(screen.getByText("Versand-Statistik")).toBeInTheDocument();
  });

  it("shows the per-company gaps on batch rejection (actionable, not a bare code)", async () => {
    (createBatchAction as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      code: "batch_not_ready",
      message: "Nicht alle Unternehmen sind versandbereit.",
      errors: [{ companyId: "cb", code: "missing_cv", message: "" }],
    });
    mount(makeWs({}));
    fireEvent.click(screen.getByLabelText("Firma A GmbH"));
    fireEvent.click(screen.getByLabelText("Firma B AG"));
    fireEvent.click(screen.getByRole("button", { name: "Bewerbungen jetzt senden (2)" }));
    await screen.findByText("Senden bestätigen");
    fireEvent.click(screen.getByRole("button", { name: "Jetzt senden (2)" }));
    await waitFor(() => expect(screen.getByText("Ergebnis")).toBeInTheDocument());
    expect(screen.getByText("Firma B AG:")).toBeInTheDocument();
    expect(screen.getByText("Lebenslauf noch nicht erstellt")).toBeInTheDocument();
  });
});

describe("Step 7 legacy mode (batchesSupported = false, migration pending)", () => {
  it("keeps statistics visible + the full per-company workflow (no queue panel in any mode)", async () => {
    (sendCompaniesAction as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: [{ companyId: "ca", ok: true, dispatchStatus: "sent" }],
    });
    mount(makeWs({
      batchMode: false,
      batches: [batchView()], // must NOT be rendered
      stats: { sentToday: 99, scheduled: 99, processing: 99, totalToday: 99, failed: 0 },
    }));
    expect(screen.queryByText("Versand-Warteschlange")).toBeNull();
    // Spec §9: capacity + sending statistics are visible in ALL modes
    // (they derive from persisted counters, not from the batch queue):
    expect(screen.getByText("Versand-Statistik")).toBeInTheDocument();
    // 99 renders in every counter tile (sent today / scheduled / processing / total):
    expect(screen.getAllByText("99").length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText("Batch #1")).toBeNull();
    // Smart Sending policy still shown (platform-wide):
    expect(screen.getByText("Smart Sending")).toBeInTheDocument();
    // The legacy send path is intact (per-company isolation, explicit confirm):
    fireEvent.click(screen.getByLabelText("Firma A GmbH"));
    expect(screen.getByText("1 von 1 bereit")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Bewerbungen jetzt senden (1)" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Jetzt senden (1)" }));
    await waitFor(() => expect(sendCompaniesAction).toHaveBeenCalledTimes(1));
    expect(sendCompaniesAction).toHaveBeenCalledWith([{ companyId: "ca", confirmed: true }]);
  });
});
