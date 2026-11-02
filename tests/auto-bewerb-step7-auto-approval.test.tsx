// @vitest-environment jsdom
/**
 * AUTO BEWERB — Step 7 auto-approval (UI contract).
 *
 * The manual "Genehmigen" step no longer exists (migration
 * 20261223000000 + engine auto-approval at company creation). A company row
 * with a LEGACY `approved = false` flag (pre-migration database state) must
 * behave exactly like any other company: selectable, send-ready when its
 * data is complete, and rendered WITHOUT any approval UI (no button, no
 * chip, no "muss erst genehmigt werden" gap). The only send gate is the
 * explicit confirmation modal (exact shared content + verified recipients).
 */
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "@/lib/i18n";
import { Step7Review } from "@/components/auto-bewerb/step7-review";

vi.mock("@/app/auto-bewerb/actions", () => ({
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

/** A company row exactly as the DB returns it — `approved` is the LEGACY
 *  flag (false = a pre-migration row, which must no longer matter). */
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
      // LEGACY pre-migration row (approved = false) — must be treated the
      // same as the approved one:
      companyView("cb", "Firma B AG", "hr@firma-b.de", "Elektroniker", false),
    ],
    attachments: [],
    emailTemplate: "<p>Body</p>",
    emailSettings: { body: "<p>Body</p>", recipient: "", subject: "Betreff", accountId: "acct1", attachCv: true, attachLetter: true },
    emailSettingsSupported: true,
    emailAccounts: [{ id: "acct1", provider: "gmail", email: "mail@example.de", is_active: true, requires_reconnect: false }],
    candidateName: "Mustapha Drif",
    batchesSupported: true,
    batches: [],
    sendStats: { sentToday: 0, scheduled: 0, processing: 0, totalToday: 0, failed: 0 },
  };
}

const read = (p: string) => readFileSync(p, "utf8");

afterEach(cleanup);

describe("Step 7 auto-approval (no manual Genehmigung)", () => {
  it("a LEGACY approved=false company is selectable + sendable — no approval UI anywhere in the step", () => {
    wsHolder.current = { ws: makeWs(), refresh: vi.fn(), notify: vi.fn(), goToStep: vi.fn() };
    render(
      <I18nProvider>
        <Step7Review />
      </I18nProvider>,
    );
    // No approval button, no approval chip, no approval gap text at all:
    expect(screen.queryByRole("button", { name: "Genehmigen" })).toBeNull();
    expect(screen.queryByText(/genehmigt/i)).toBeNull();
    expect(screen.queryByText(/Genehmigen/)).toBeNull();
    // The LEGACY row (approved = false) is selectable, exactly like the
    // approved one (both fully send-ready → "2 von 2 bereit" on selection):
    expect(screen.getByLabelText("Firma A GmbH")).toBeEnabled();
    expect(screen.getByLabelText("Firma B AG")).toBeEnabled();
  });

  it("the approval contract is gone from the whole product surface (source level)", () => {
    const ACTIONS = read("src/app/auto-bewerb/actions.ts");
    expect(ACTIONS).not.toContain("approveCompanyAction");
    expect(ACTIONS).not.toContain("approveAutoBewerbCompany");
    const STEP7 = read("src/components/auto-bewerb/step7-review.tsx");
    expect(STEP7).not.toContain("approveCompanyAction");
    expect(STEP7).not.toContain("approveButton");
    expect(STEP7).not.toContain("approvedChip");
    expect(STEP7).not.toContain("missingApproval");
    expect(STEP7).not.toContain("notApprovedResult");
    // No user-visible "Genehmigen" string in any CODE line (doc comments may
    // reference the removed step by name — rendered text may not):
    const STEP7_CODE = STEP7.split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
      .join("\n");
    expect(STEP7_CODE).not.toContain("Genehmigen");
    const ENGINE = read("src/lib/auto-bewerb/engine.ts");
    expect(ENGINE).not.toContain("not_approved");
    expect(ENGINE).not.toContain("approveAutoBewerbCompany");
    // The auto-approval contract lives in the migration (default + backfill)
    // and the create-time stamp:
    expect(read("supabase/migrations/20261223000000_auto_bewerb_auto_approval.sql")).toContain("set default true");
    expect(ENGINE).toContain("approved: true");
    // No stale approval strings survive in ANY supported language:
    for (const stale of ["approveButton", "approving", "approvedChip", "approvedNote", "missingApproval", "notApprovedResult"]) {
      expect(read("src/lib/i18n/dictionaries.ts")).not.toContain(stale + ":");
    }
  });
});
