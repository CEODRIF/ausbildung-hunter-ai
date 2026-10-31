// @vitest-environment jsdom
/**
 * AUTO BEWERB — Step 7 multi-batch UI contract (jsdom).
 *
 * The reference layout, wired to REAL persisted queue data:
 *   - "Aktuelle Versandgruppe (X Unternehmen)" with per-company readiness
 *     (X von Y bereit) and the hard cap of 10;
 *   - Send now behind the explicit confirmation modal (client passes ONLY
 *     company ids + confirmation);
 *   - "Geplante & frühere Versände" from ws.batches (batch #, count, time, visual
 *     countdown, status, account, details, cancel ONLY pre-start);
 *   - Smart Sending policy panel (always on, real interval constants);
 *   - statistics from ws.sendStats (persisted data, never demo numbers);
 *   - graceful legacy mode (batchesSupported = false hides queue + stats).
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "@/lib/i18n";
import { Step7Review } from "@/components/auto-bewerb/step7-review";
import { cancelBatchAction, createBatchAction, sendCompaniesAction } from "@/app/auto-bewerb/actions";

vi.mock("@/app/auto-bewerb/actions", () => ({
  approveCompanyAction: vi.fn(),
  cancelBatchAction: vi.fn(),
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

function makeWs(opts: {
  batchMode?: boolean;
  companies?: ReturnType<typeof companyView>[];
  batches?: Record<string, unknown>[];
  stats?: { sentToday: number; scheduled: number; processing: number; totalToday: number };
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
    sendStats: opts.stats ?? { sentToday: 0, scheduled: 0, processing: 0, totalToday: 0 },
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

describe("Step 7 batch UI (batchesSupported = true)", () => {
  it("renders the queue from persisted data: batch #, count, time, countdown, status, account", () => {
    mount(makeWs({
      batches: [batchView()],
      stats: { sentToday: 2, scheduled: 1, processing: 0, totalToday: 5 },
    }));
    // Current batch panel (nothing selected yet):
    expect(screen.getByText("Aktuelle Versandgruppe (0 Unternehmen)")).toBeInTheDocument();
    // The queue panel with the REAL persisted batch:
    expect(screen.getByText("Geplante & frühere Versände")).toBeInTheDocument();
    expect(screen.getByText("Batch #1")).toBeInTheDocument();
    expect(screen.getByText("2 Unternehmen")).toBeInTheDocument();
    // "Geplant" = the batch status pill (also the "Scheduled" stats label):
    expect(screen.getAllByText("Geplant").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Von: mail@example.de")).toBeInTheDocument();
    // Visual countdown (server owns the schedule — this is display only):
    expect(screen.getByText(/in \d/)).toBeInTheDocument();
    // Details view: collapsed by default (the company appears only in the
    // review list — exactly once); expanding adds the batch's own item list:
    expect(screen.getAllByText("Firma A GmbH")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getAllByText("Firma A GmbH")).toHaveLength(2);
    expect(screen.getAllByText("Firma B AG")).toHaveLength(2);
    // Smart Sending policy (real constants, always on, no bypass UI):
    expect(screen.getByText("Smart Sending")).toBeInTheDocument();
    expect(screen.getByText("IMMER AN")).toBeInTheDocument();
    expect(screen.getByText("Mindestintervall")).toBeInTheDocument();
    expect(screen.getByText("5 Sekunden")).toBeInTheDocument();
    expect(screen.getByText("Empfohlen")).toBeInTheDocument();
    expect(screen.getByText("6 Sekunden")).toBeInTheDocument();
    expect(screen.getByText("Zwischen Batch-Starts")).toBeInTheDocument();
    expect(screen.getByText("3 Minuten 30 Sekunden")).toBeInTheDocument();
    // Statistics from persisted data:
    expect(screen.getByText("Versand-Statistik")).toBeInTheDocument();
    expect(screen.getByText("Heute gesendet")).toBeInTheDocument();
    expect(screen.getByText("Heute gesamt")).toBeInTheDocument();
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(1);
  });

  it("selecting companies builds the current batch with readiness; send-now goes through the confirmation modal with ids + confirmation ONLY", async () => {
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
    expect(screen.getByText("Aktuelle Versandgruppe (2 Unternehmen)")).toBeInTheDocument();
    expect(screen.getByText("2 von 2 bereit")).toBeInTheDocument();
    // Send now → explicit confirmation modal with the exact shared config:
    fireEvent.click(screen.getByRole("button", { name: "Ausgewählte senden (2)" }));
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
    await waitFor(() => expect(screen.getByText("Aktuelle Versandgruppe (0 Unternehmen)")).toBeInTheDocument());
  });

  it("enforces the hard cap of 10 companies per batch", () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      companyView(`c${i + 1}`, `Firma ${i + 1} GmbH`, `jobs@firma-${i + 1}.de`, `Ausbildung ${i + 1}`, true),
    );
    mount(makeWs({ companies: many }));
    for (let i = 1; i <= 10; i++) fireEvent.click(screen.getByLabelText(`Firma ${i} GmbH`));
    expect(screen.getByText("Aktuelle Versandgruppe (10 Unternehmen)")).toBeInTheDocument();
    expect(screen.getByText("10 von 10 bereit")).toBeInTheDocument();
    // The 11th company cannot be added to the current batch:
    expect(screen.getByLabelText("Firma 11 GmbH")).toBeDisabled();
    expect(screen.getByText("Maximal 10 Unternehmen pro Batch.")).toBeInTheDocument();
  });

  it("an incomplete company can be selected but blocks sending (readiness indicator)", () => {
    const companies = [
      companyView("ca", "Firma A GmbH", "jobs@firma-a.de", "Mechatroniker", true),
      companyView("cb", "Firma B AG", "hr@firma-b.de", "Elektroniker", false), // not approved
    ];
    mount(makeWs({ companies }));
    fireEvent.click(screen.getByLabelText("Firma A GmbH"));
    fireEvent.click(screen.getByLabelText("Firma B AG"));
    expect(screen.getByText("1 von 2 bereit")).toBeInTheDocument();
    expect(screen.getByText("Unvollständig")).toBeInTheDocument();
    // The actionable gap names the missing approval:
    expect(screen.getByText(/Bewerbung muss erst genehmigt werden/)).toBeInTheDocument();
    // Sending is disabled while the batch is not fully ready:
    expect(screen.getByRole("button", { name: "Ausgewählte senden (2)" })).toBeDisabled();
  });

  it("cancels ONLY pre-start batches (safe cancel); started/completed batches have no cancel", async () => {
    (cancelBatchAction as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, value: { ok: true } });
    const { notify } = mount(makeWs({
      batches: [
        batchView({ id: "batch-1", batch_no: 2 }),
        batchView({ id: "batch-2", batch_no: 1, status: "completed", completed_at: TS, sentCount: 2, pendingCount: 0, scheduled_at: new Date(Date.now() - 3600_000).toISOString(), started_at: TS }),
      ],
    }));
    // Only the scheduled (pre-start) batch offers the safe cancel:
    expect(screen.getAllByRole("button", { name: "Abbrechen" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(cancelBatchAction).toHaveBeenCalledTimes(1));
    expect(cancelBatchAction).toHaveBeenCalledWith("batch-1");
    await waitFor(() => expect(notify).toHaveBeenCalledWith("success", expect.stringContaining("Batch abgebrochen")));
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
    fireEvent.click(screen.getByRole("button", { name: "Ausgewählte senden (2)" }));
    await screen.findByText("Senden bestätigen");
    fireEvent.click(screen.getByRole("button", { name: "Jetzt senden (2)" }));
    await waitFor(() => expect(screen.getByText("Ergebnis")).toBeInTheDocument());
    expect(screen.getByText("Firma B AG:")).toBeInTheDocument();
    expect(screen.getByText("Lebenslauf noch nicht erstellt")).toBeInTheDocument();
  });
});

describe("Step 7 legacy mode (batchesSupported = false, migration pending)", () => {
  it("hides queue + statistics but keeps the full per-company workflow", async () => {
    (sendCompaniesAction as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: [{ companyId: "ca", ok: true, dispatchStatus: "sent" }],
    });
    mount(makeWs({
      batchMode: false,
      batches: [batchView()], // must NOT be rendered
      stats: { sentToday: 99, scheduled: 99, processing: 99, totalToday: 99 },
    }));
    expect(screen.queryByText("Geplante & frühere Versände")).toBeNull();
    expect(screen.queryByText("Versand-Statistik")).toBeNull();
    expect(screen.queryByText("Batch #1")).toBeNull();
    // Smart Sending policy still shown (platform-wide):
    expect(screen.getByText("Smart Sending")).toBeInTheDocument();
    // The legacy send path is intact (per-company isolation, explicit confirm):
    fireEvent.click(screen.getByLabelText("Firma A GmbH"));
    expect(screen.getByText("Aktuelle Versandgruppe (1 Unternehmen)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ausgewählte senden (1)" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Jetzt senden (1)" }));
    await waitFor(() => expect(sendCompaniesAction).toHaveBeenCalledTimes(1));
    expect(sendCompaniesAction).toHaveBeenCalledWith([{ companyId: "ca", confirmed: true }]);
  });
});
