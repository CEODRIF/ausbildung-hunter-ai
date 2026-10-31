// @vitest-environment jsdom
/**
 * AUTO BEWERB — Step 7 explicit approval gate (UI contract).
 *
 * The engine refuses every send without `approved = true` on the company row.
 * Step 7 must therefore expose the EXPLICIT approval path: an unapproved
 * company shows an "Genehmigen" button (and is NOT selectable for sending),
 * an approved company shows the "Genehmigt" chip and no button, and the
 * approval call is scoped to the clicked company.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "@/lib/i18n";
import { Step7Review } from "@/components/auto-bewerb/step7-review";
import { approveCompanyAction } from "@/app/auto-bewerb/actions";

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

const ts = "2026-12-01T00:00:00.000Z";

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
    approved_at: approved ? ts : null,
    scheduled_at: null,
    schedule_timezone: null,
    sent_at: null,
    provider_message_id: null,
    last_failure_code: null,
    ad_confirmed_at: ts,
    cv_reviewed_at: null,
    letter_reviewed_at: null,
    created_at: ts,
    updated_at: ts,
  };
}

function companyView(id: string, company: string, email: string, job: string, approved: boolean) {
  return {
    company: companyRow(id, company, email, job, approved),
    cv: { id: `cv-${id}` },
    cvVersion: 1,
    cvPdfName: "Lebenslauf_Mustapha_Drif.pdf",
    letter: { id: `letter-${id}`, text: "…", tone: "professional" },
    letterVersion: 1,
    letterPdfName: `Anschreiben_${company}.pdf`,
    latestAttempt: null,
  };
}

function makeWs() {
  return {
    ready: true,
    setupIssue: null,
    profile: null,
    photoSupported: false,
    photo: null,
    companies: [
      companyView("ca", "Firma A GmbH", "jobs@firma-a.de", "Mechatroniker", true),
      companyView("cb", "Firma B AG", "hr@firma-b.de", "Elektroniker", false),
    ],
    attachments: [],
    emailTemplate: "<p>Body</p>",
    emailSettings: { body: "<p>Body</p>", recipient: "", subject: "Betreff", accountId: "acct1", attachCv: true, attachLetter: true },
    emailSettingsSupported: true,
    emailAccounts: [{ id: "acct1", provider: "gmail", email: "mail@example.de", is_active: true, requires_reconnect: false }],
    candidateName: "Mustapha Drif",
    // Legacy mode (batches migration pending) — the approval-gate contract
    // below documents the per-company isolation path.
    batchesSupported: false,
    batches: [],
    sendStats: { sentToday: 0, scheduled: 0, processing: 0, totalToday: 0, failed: 0 },
  };
}

afterEach(cleanup);

describe("Step 7 approval gate (UI)", () => {
  it("unapproved company: approve button + not selectable + actionable gap; approved company: chip, no button", () => {
    const notify = vi.fn();
    wsHolder.current = { ws: makeWs(), refresh: vi.fn(), notify, goToStep: vi.fn() };
    render(
      <I18nProvider>
        <Step7Review />
      </I18nProvider>,
    );
    // The approved company shows the approval state (chip) and NO button:
    expect(screen.getByText("Genehmigt")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Genehmigen" })).toHaveLength(1);
    // The unapproved company is named in the actionable gap text:
    expect(screen.getByText(/Bewerbung muss erst genehmigt werden/)).toBeInTheDocument();
    // Its selection checkbox is DISABLED (no send without approval):
    const cb = screen.getByLabelText("Firma B AG") as HTMLInputElement;
    expect(cb).toBeDisabled();
    // The approved company IS selectable:
    expect(screen.getByLabelText("Firma A GmbH")).toBeEnabled();
  });

  it("clicking „Genehmigen“ approves EXACTLY that company and refreshes (mocked action, no email)", async () => {
    const refresh = vi.fn();
    const notify = vi.fn();
    wsHolder.current = { ws: makeWs(), refresh, notify, goToStep: vi.fn() };
    (approveCompanyAction as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, value: { id: "cb" } });
    render(
      <I18nProvider>
        <Step7Review />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Genehmigen" }));
    await waitFor(() => expect(approveCompanyAction).toHaveBeenCalledTimes(1));
    // Scoped to the UNAPPROVED company only — never to the other one:
    expect(approveCompanyAction).toHaveBeenCalledWith("cb");
    expect(refresh).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("success", "Bewerbung genehmigt.");
  });
});
