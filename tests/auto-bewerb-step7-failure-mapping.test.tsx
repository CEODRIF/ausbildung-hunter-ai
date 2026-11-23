// @vitest-environment jsdom
/**
 * AUTO BEWERB — Step 7: send-failure message mapping (PR review fix).
 *
 * Contract locked here:
 *  1. `token_invalid` means "OAuth access token rejected"
 *     (src/lib/email-providers.ts — Gmail 401/403 with a refresh path). It is
 *     NOT a rate limit → it must render the RECONNECT message + the
 *     /settings/email CTA, never the rate-limit text.
 *  2. Every provider/document failure code the engine can persist renders
 *     its correct actionable message (no raw internal code for known codes).
 *  3. Retry-related messages match the ACTUAL dispatch behavior: the engine
 *     retries temporary failures automatically (3 attempts, 2/4/8 min backoff)
 *     and then gives up — so a message shown at failure time must say
 *     "automatic retries were exhausted, send again later", never
 *     "will be retried automatically".
 *  4. The engine-persisted `last_failure_code` is displayed on failed rows
 *     (survives refresh), with the CTA for account/token codes.
 */
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "@/lib/i18n";
import { dictionaries } from "@/lib/i18n/dictionaries";
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

import { createBatchAction } from "@/app/auto-bewerb/actions";

const ts = "2026-12-01T00:00:00.000Z";
const DICT = dictionaries.de.autoBewerb;

function companyView(id: string, company: string, email: string, job: string, status: string, lastFailureCode: string | null) {
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
      status,
      recipient_email: null,
      email_subject: null,
      email_body: null,
      email_attach_cv: true,
      email_attach_letter: true,
      email_account_id: null,
      idempotency_key: null,
      approved: true,
      approved_at: ts,
      scheduled_at: null,
      schedule_timezone: null,
      sent_at: null,
      provider_message_id: null,
      last_failure_code: lastFailureCode,
      ad_confirmed_at: ts,
      cv_reviewed_at: null,
      letter_reviewed_at: null,
      created_at: ts,
      updated_at: ts,
    },
    cv: { id: `cv-${id}` },
    cvVersion: 1,
    cvPdfName: `Lebenslauf_${company}.pdf`,
    letter: { id: `letter-${id}`, text: "…", tone: "professional" },
    letterVersion: 1,
    letterPdfName: `Anschreiben_${company}.pdf`,
    latestAttempt: null,
  };
}

/** Fully send-ready workspace (global settings + connected account). */
function makeWs(companies: unknown[]) {
  return {
    ready: true,
    setupIssue: null,
    profile: null,
    photoSupported: false,
    photo: null,
    companies,
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

/** Select the company, open the confirm modal, confirm the send. */
async function confirmSend() {
  fireEvent.click(screen.getByLabelText("Firma A GmbH"));
  fireEvent.click(screen.getByRole("button", { name: DICT.sendNowConfirm.replace("{count}", "1") }));
  fireEvent.click(screen.getByRole("button", { name: DICT.confirmSendButton.replace("{count}", "1") }));
}

afterEach(() => {
  cleanup();
  vi.mocked(createBatchAction).mockReset();
});

describe("results panel — every failure code renders its correct actionable message", () => {
  it("maps all provider/document codes; token_invalid (and friends) get the reconnect text + settings CTA", async () => {
    wsHolder.current = { ws: makeWs([companyView("ca", "Firma A GmbH", "jobs@firma-a.de", "Mechatroniker", "ready", null)]), refresh: vi.fn(), notify: vi.fn(), goToStep: vi.fn() };
    const items = [
      "reconnect_required",
      "token_invalid",
      "gmail_scope_missing",
      "no_email_account",
      "provider_rejected",
      "provider_rate_limited",
      "provider_temporary",
      "provider_not_configured",
      "attachment_unavailable",
      "cv_render_failed",
      "letter_render_failed",
      "already_sent",
      "zzz_unknown",
    ].map((code, i) => ({ companyId: `c${i}`, ok: false, code: null, message: "", dispatchStatus: null, failureCode: code, scheduledAt: null }));
    vi.mocked(createBatchAction).mockResolvedValue({ ok: true, value: { items, batchNo: 1, windowDeferred: false, scheduledAt: null } } as never);
    render(
      <I18nProvider>
        <Step7Review />
      </I18nProvider>,
    );
    await confirmSend();
    await waitFor(() => expect(screen.getAllByText(DICT.sendFailedReconnect)).toHaveLength(4));

    // Account/token family → reconnect message. Exactly the FOUR account
    // codes (reconnect_required, token_invalid, gmail_scope_missing,
    // no_email_account) map to it — token_invalid MUST be here, never in the
    // rate-limit message:
    expect(screen.getAllByText(DICT.sendFailedReconnect)).toHaveLength(4);
    expect(screen.getByText(DICT.sendFailedProviderRejected)).toBeInTheDocument();
    expect(screen.getByText(DICT.sendFailedRateLimited)).toBeInTheDocument();
    expect(screen.getByText(DICT.sendFailedProviderTemporary)).toBeInTheDocument();
    expect(screen.getByText(DICT.sendFailedNotConfigured)).toBeInTheDocument();
    expect(screen.getByText(DICT.sendFailedAttachment)).toBeInTheDocument();
    expect(screen.getByText(DICT.sendFailedCv)).toBeInTheDocument();
    expect(screen.getByText(DICT.sendFailedLetter)).toBeInTheDocument();
    expect(screen.getByText(DICT.alreadySentNote)).toBeInTheDocument();
    // Unknown codes keep the raw-code fallback (nothing hidden):
    expect(screen.getByText(DICT.resultFailed.replace("{code}", "zzz_unknown"))).toBeInTheDocument();
    // The CTA link to the e-mail settings appears EXACTLY for the four
    // account/token codes:
    const ctas = screen.getAllByRole("link", { name: DICT.emailAccountNoneCta });
    expect(ctas).toHaveLength(4);
    for (const link of ctas) expect(link).toHaveAttribute("href", "/settings/email");
  });

  it("never promises future automatic retries at failure time (matches the engine: retries are exhausted by then)", async () => {
    wsHolder.current = { ws: makeWs([companyView("ca", "Firma A GmbH", "jobs@firma-a.de", "Mechatroniker", "ready", null)]), refresh: vi.fn(), notify: vi.fn(), goToStep: vi.fn() };
    const items = ["provider_rate_limited", "provider_temporary"].map((code, i) => ({ companyId: `c${i}`, ok: false, code: null, message: "", dispatchStatus: null, failureCode: code, scheduledAt: null }));
    vi.mocked(createBatchAction).mockResolvedValue({ ok: true, value: { items, batchNo: 1, windowDeferred: false, scheduledAt: null } } as never);
    render(
      <I18nProvider>
        <Step7Review />
      </I18nProvider>,
    );
    await confirmSend();
    await waitFor(() => expect(screen.getByText(DICT.sendFailedRateLimited)).toBeInTheDocument());
    // The messages state the retries were EXHAUSTED (past tense) and ask the
    // user to send again — never a future promise:
    expect(DICT.sendFailedRateLimited).toContain("automatischen Wiederholungen waren ebenfalls nicht erfolgreich");
    expect(DICT.sendFailedProviderTemporary).toContain("automatischen Wiederholungen waren ebenfalls nicht erfolgreich");
    // The stale future-tense promise must be gone from the rendered text:
    const rendered = document.body.textContent ?? "";
    expect(rendered).not.toContain("wird automatisch später erneut versucht");
    expect(rendered).not.toContain("wird automatisch erneut versucht");
    // …and the strings themselves (all four languages) state the retries were
    // exhausted in the past tense:
    for (const lang of Object.keys(dictionaries) as Array<keyof typeof dictionaries>) {
      const d = dictionaries[lang].autoBewerb;
      for (const s of [d.sendFailedRateLimited, d.sendFailedProviderTemporary]) {
        expect(s).not.toMatch(/will be retried automatically|sera automatiquement réessayé|سيُعاد الإرسال تلقائيًا/);
      }
    }
  });
});

describe("pre-validation error list (itemErrorText)", () => {
  it("maps gap codes and delegates provider codes to the shared mapping", async () => {
    wsHolder.current = { ws: makeWs([companyView("ca", "Firma A GmbH", "jobs@firma-a.de", "Mechatroniker", "ready", null)]), refresh: vi.fn(), notify: vi.fn(), goToStep: vi.fn() };
    vi.mocked(createBatchAction).mockResolvedValue({
      ok: false,
      code: "batch_not_ready",
      message: "Kein Unternehmen des Batches war versandbereit.",
      errors: [
        { companyId: "ca", code: "invalid_recipient" },
        { companyId: "cb", code: "token_invalid" },
        { companyId: "cc", code: "provider_not_configured" },
        { companyId: "cd", code: "missing_cv" },
      ],
    } as never);
    render(
      <I18nProvider>
        <Step7Review />
      </I18nProvider>,
    );
    await confirmSend();
    await waitFor(() => expect(screen.getByText(DICT.invalidRecipient)).toBeInTheDocument());
    expect(screen.getByText(DICT.sendFailedReconnect)).toBeInTheDocument(); // token_invalid → shared mapping
    expect(screen.getByText(DICT.sendFailedNotConfigured)).toBeInTheDocument();
    expect(screen.getByText(DICT.missingCv)).toBeInTheDocument();
  });
});

describe("active list — the engine-persisted last_failure_code survives refresh", () => {
  it("a failed company shows the actual cause + the settings CTA (account code)", () => {
    wsHolder.current = {
      ws: makeWs([companyView("ca", "Firma A GmbH", "jobs@firma-a.de", "Mechatroniker", "failed", "token_invalid")]),
      refresh: vi.fn(),
      notify: vi.fn(),
      goToStep: vi.fn(),
    };
    render(
      <I18nProvider>
        <Step7Review />
      </I18nProvider>,
    );
    expect(screen.getByText(DICT.sendFailedReconnect)).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: DICT.emailAccountNoneCta });
    expect(cta).toHaveAttribute("href", "/settings/email");
  });

  it("a failed company with a provider code shows the cause WITHOUT a settings CTA", () => {
    wsHolder.current = {
      ws: makeWs([companyView("ca", "Firma A GmbH", "jobs@firma-a.de", "Mechatroniker", "failed", "provider_rejected")]),
      refresh: vi.fn(),
      notify: vi.fn(),
      goToStep: vi.fn(),
    };
    render(
      <I18nProvider>
        <Step7Review />
      </I18nProvider>,
    );
    expect(screen.getByText(DICT.sendFailedProviderRejected)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: DICT.emailAccountNoneCta })).toBeNull();
  });
});

describe("retry-message ↔ engine behavior lock (source level)", () => {
  it("the engine retries temporary failures (3 attempts, 2/4/8 min backoff) and then persists the terminal code", () => {
    const ENGINE = readFileSync("src/lib/auto-bewerb/engine.ts", "utf8");
    expect(ENGINE).toContain("const MAX_SEND_ATTEMPTS = 3;");
    // backoff ladder 2m/4m/8m (doubling per attempt):
    expect(ENGINE).toContain("2 * 60_000 * 2 ** (attempt - 1)");
    // a temporary failure becomes TERMINAL only once the budget is exhausted:
    expect(ENGINE).toContain("executedCount >= MAX_SEND_ATTEMPTS");
    // …and the terminal write persists exactly the code the UI now translates:
    expect(ENGINE).toContain("last_failure_code");
  });
});
