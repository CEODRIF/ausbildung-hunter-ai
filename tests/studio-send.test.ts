/**
 * AI Bewerbung Studio — send pipeline: approval gate, recipient validation,
 * idempotency / duplicate-send prevention, durable scheduling, retries,
 * cancellation.
 *
 * The email provider is MOCKED (no real email ever leaves, no OAuth); the
 * database is an in-memory model honoring the studio migration's unique
 * constraints. Every assertion here is about server-side behavior — the UI
 * confirmation checkbox is not part of this contract.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStudioDb, type StudioDb } from "./helpers-studio";
import { STUDIO_LETTER_PDF_ID } from "@/lib/studio/schema";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/email-providers", () => ({
  createEmailProvider: vi.fn(),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { createEmailProvider } from "@/lib/email-providers";

let db: StudioDb;

const APP_ID = "11111111-1111-4111-8111-111111111111";
const ATT_ID = "22222222-2222-4222-8222-222222222222";
const ACCT_ID = "33333333-3333-4333-8333-333333333333";

function appRow(over: Record<string, unknown> = {}) {
  return {
    id: APP_ID,
    user_id: "user-a",
    ad_raw: "x".repeat(40),
    ad_extracted: {
      jobTitle: "Fachinformatiker",
      occupation: "Fachinformatiker",
      company: "Tech GmbH",
      companyAddress: "",
      location: "Berlin",
      startDate: "",
      applicationDeadline: "30.06.2027",
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
      applicationEmail: "jobs@tech-gmbh.de",
      companyNotes: [],
      missingOrAmbiguous: [],
    },
    ad_analysis: null,
    profile_snapshot: null,
    status: "draft",
    email_account_id: ACCT_ID,
    recipient_email: "jobs@tech-gmbh.de",
    idempotency_key: null,
    approved: true,
    approved_at: "2026-12-01T10:00:00.000Z",
    scheduled_at: null,
    schedule_timezone: null,
    sent_at: null,
    provider_message_id: null,
    last_failure_code: null,
    created_at: "2026-12-01T00:00:00.000Z",
    updated_at: "2026-12-01T00:00:00.000Z",
    ...over,
  };
}

function attemptRow(over: Record<string, unknown> = {}) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    application_id: APP_ID,
    user_id: "user-a",
    idempotency_key: "55555555-5555-4555-8555-555555555555",
    recipient_email: "jobs@tech-gmbh.de",
    subject: "Bewerbung als Fachinformatiker",
    payload: { html: "<p>hallo</p>", text: "hallo", attachments: [] },
    status: "queued",
    scheduled_at: null,
    attempt_count: 0,
    next_attempt_at: null,
    provider_message_id: null,
    failure_code: null,
    failure_message: null,
    sent_at: null,
    created_at: "2026-12-01T00:00:00.000Z",
    updated_at: "2026-12-01T00:00:00.000Z",
    ...over,
  };
}

let sendEmailImpl: (payload: { to: string; subject: string; html: string; text: string; attachments: unknown[] }) => Promise<{ providerMessageId: string }>;
let sendEmailCalls: number;

beforeEach(() => {
  db = createStudioDb({
    studio_applications: [appRow()],
    email_accounts: [
      { id: ACCT_ID, user_id: "user-a", provider: "gmail", email: "a@gmail.com", is_active: true, requires_reconnect: false },
    ],
    studio_attachments: [
      {
        id: ATT_ID,
        application_id: APP_ID,
        user_id: "user-a",
        display_name: "Lebenslauf.pdf",
        doc_category: "other",
        mime_type: "application/pdf",
        size_bytes: 123,
        storage_path: "user-a/studio/abc-Lebenslauf.pdf",
        required: false,
        created_at: "2026-12-01T00:00:00.000Z",
      },
    ],
  });
  (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
  sendEmailCalls = 0;
  sendEmailImpl = async () => {
    sendEmailCalls++;
    return { providerMessageId: `msg-${sendEmailCalls}` };
  };
  (createEmailProvider as ReturnType<typeof vi.fn>).mockImplementation(
    async () => ({ sendEmail: sendEmailImpl }),
  );
});

function studio() {
  vi.resetModules();
  return import("@/lib/studio");
}

const IMMEDIATE = {
  applicationId: APP_ID,
  recipientEmail: "jobs@tech-gmbh.de",
  emailAccountId: ACCT_ID,
  subject: "Bewerbung als Fachinformatiker",
  body: "Sehr geehrte Damen und Herren, anbei meine Bewerbung.",
  attachmentIds: [ATT_ID],
  schedule: null,
};

describe("approval gate (explicit consent before any send)", () => {
  it("refuses to send an UNAPPROVED application", async () => {
    db.tables.studio_applications[0].approved = false;
    const { prepareStudioSend } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await prepareStudioSend("user-a", { ...IMMEDIATE });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_approved");
    expect(db.tables.studio_send_attempts.length).toBe(0);
    expect(sendEmailCalls).toBe(0);
  });

  it("refuses a sent application (no re-send of the same logical send)", async () => {
    db.tables.studio_applications[0].status = "sent";
    const { prepareStudioSend } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await prepareStudioSend("user-a", { ...IMMEDIATE });
    expect(res.ok).toBe(false);
    expect(db.tables.studio_send_attempts.length).toBe(0);
  });

  it("refuses invalid recipients BEFORE any attempt row is created", async () => {
    const { prepareStudioSend } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await prepareStudioSend("user-a", { ...IMMEDIATE, recipientEmail: "not-an-email" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invalid_recipient");
    expect(db.tables.studio_send_attempts.length).toBe(0);
    expect(sendEmailCalls).toBe(0);
  });

  it("refuses a recipient that is syntactically valid but longer than the DB column (320)", async () => {
    const { prepareStudioSend } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const long = "a".repeat(310) + "@example.de"; // 321 chars > 320 column cap
    const res = await prepareStudioSend("user-a", { ...IMMEDIATE, recipientEmail: long });
    expect(res.ok).toBe(false);
  });

  it("refuses another user's email account", async () => {
    db.tables.email_accounts.push({
      id: "99999999-9999-4999-8999-999999999999",
      user_id: "user-b",
      provider: "gmail",
      email: "b@gmail.com",
      is_active: true,
      requires_reconnect: false,
    });
    const { prepareStudioSend } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await prepareStudioSend("user-a", {
      ...IMMEDIATE,
      emailAccountId: "99999999-9999-4999-8999-999999999999",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("no_email_account");
  });

  it("refuses attachments that belong to ANOTHER application", async () => {
    db.tables.studio_attachments.push({
      ...attemptRow(),
      id: "66666666-6666-4666-8666-666666666666",
      application_id: "77777777-7777-4777-8777-777777777777",
      display_name: "fremd.pdf",
    });
    const { prepareStudioSend } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await prepareStudioSend("user-a", {
      ...IMMEDIATE,
      attachmentIds: ["66666666-6666-4666-8666-666666666666"],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_found");
    expect(db.tables.studio_send_attempts.length).toBe(0);
  });

  it("only attaches documents the user SELECTED (ownership + application scoped)", async () => {
    const { prepareStudioSend } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await prepareStudioSend("user-a", { ...IMMEDIATE, attachmentIds: [ATT_ID] });
    expect(res.ok).toBe(true);
    const attempt = db.tables.studio_send_attempts[0];
    const payload = attempt.payload as { attachments: Array<{ filename: string }> };
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].filename).toBe("Lebenslauf.pdf");
  });
});

describe("idempotency + duplicate-send prevention", () => {
  it("immediate send: one attempt, one provider call, app marked sent", async () => {
    const { prepareStudioSend } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await prepareStudioSend("user-a", { ...IMMEDIATE });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.dispatchStatus).toBe("sent");
    expect(db.tables.studio_send_attempts).toHaveLength(1);
    expect(sendEmailCalls).toBe(1);
    expect(db.tables.studio_applications[0].status).toBe("sent");
    expect(db.tables.studio_applications[0].provider_message_id).toBe("msg-1");
    expect(db.tables.studio_applications[0].sent_at).not.toBeNull();
  });

  it("a second prepare while a send is in flight is refused (send_in_progress)", async () => {
    // Simulate the race loser: the status was already claimed by the first prepare.
    db.tables.studio_applications[0].status = "sending";
    const { prepareStudioSend } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await prepareStudioSend("user-a", { ...IMMEDIATE });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("send_in_progress");
    expect(db.tables.studio_send_attempts.length).toBe(0);
    expect(sendEmailCalls).toBe(0);
  });

  it("a failed send can be retried EXPLICITLY (status failed → new prepare allowed)", async () => {
    db.tables.studio_applications[0].status = "failed";
    db.tables.studio_applications[0].last_failure_code = "temporary_failure";
    const { prepareStudioSend } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await prepareStudioSend("user-a", { ...IMMEDIATE });
    expect(res.ok).toBe(true);
    expect(db.tables.studio_send_attempts).toHaveLength(1);
  });

  it("concurrent dispatch of the SAME attempt: only one executes (atomic claim)", async () => {
    db.tables.studio_send_attempts.push(attemptRow());
    const { dispatchStudioAttempt } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const [r1, r2] = await Promise.all([
      dispatchStudioAttempt("44444444-4444-4444-8444-444444444444"),
      dispatchStudioAttempt("44444444-4444-4444-8444-444444444444"),
    ]);
    const executed = [r1, r2].filter((r) => !r.duplicate && r.status === "sent").length;
    const duplicates = [r1, r2].filter((r) => r.duplicate).length;
    expect(executed + duplicates).toBe(2);
    expect(executed).toBeLessThanOrEqual(1);
    expect(sendEmailCalls).toBeLessThanOrEqual(1);
  });

  it("dispatching an already-SENT attempt is a duplicate, no provider call", async () => {
    db.tables.studio_send_attempts.push(attemptRow({ status: "sent" }));
    const { dispatchStudioAttempt } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await dispatchStudioAttempt("44444444-4444-4444-8444-444444444444");
    expect(res.duplicate).toBe(true);
    expect(sendEmailCalls).toBe(0);
  });
});

describe("dispatch: consent re-check at execution time", () => {
  it("a SCHEDULED send whose application lost approval is terminal (not_approved)", async () => {
    db.tables.studio_send_attempts.push(attemptRow({ status: "queued", scheduled_at: new Date(Date.now() - 1000).toISOString() }));
    db.tables.studio_applications[0].approved = false;
    const { dispatchStudioAttempt } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await dispatchStudioAttempt("44444444-4444-4444-8444-444444444444");
    expect(res.ok).toBe(false);
    expect(res.status).toBe("failed");
    expect(res.failureCode).toBe("not_approved");
    expect(sendEmailCalls).toBe(0);
  });

  it("a scheduled send whose email account was disconnected is terminal", async () => {
    db.tables.studio_send_attempts.push(attemptRow({ status: "queued" }));
    db.tables.studio_applications[0].email_account_id = null;
    const { dispatchStudioAttempt } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await dispatchStudioAttempt("44444444-4444-4444-8444-444444444444");
    expect(res.ok).toBe(false);
    expect(res.failureCode).toBe("no_email_account");
    expect(sendEmailCalls).toBe(0);
  });
});

describe("retries: temporary vs. uncertain failures", () => {
  it("temporary provider failure → re-queued with backoff (retry 1/3)", async () => {
    db.tables.studio_send_attempts.push(attemptRow());
    sendEmailImpl = async () => {
      const err = new Error("provider down") as Error & { temporary?: boolean; code?: string };
      err.temporary = true;
      err.code = "temporary_failure";
      throw err;
    };
    const { dispatchStudioAttempt } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await dispatchStudioAttempt("44444444-4444-4444-8444-444444444444");
    expect(res.ok).toBe(false);
    expect(res.status).toBe("queued");
    const row = db.tables.studio_send_attempts[0];
    expect(row.status).toBe("queued");
    expect(row.attempt_count).toBe(1);
    expect(row.next_attempt_at).not.toBeNull();
  });

  it("UNCERTAIN failure (maybe already delivered) → terminal failed, NEVER auto-retry", async () => {
    db.tables.studio_send_attempts.push(attemptRow());
    sendEmailImpl = async () => {
      const err = new Error("timeout") as Error & { uncertain?: boolean; code?: string };
      err.uncertain = true;
      err.code = "provider_timeout";
      throw err;
    };
    const { dispatchStudioAttempt } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await dispatchStudioAttempt("44444444-4444-4444-8444-444444444444");
    expect(res.ok).toBe(false);
    expect(res.status).toBe("failed");
    const row = db.tables.studio_send_attempts[0];
    expect(row.status).toBe("failed");
    expect(row.next_attempt_at).toBeNull();
  });

  it("non-temporary failure → terminal failed", async () => {
    db.tables.studio_send_attempts.push(attemptRow());
    sendEmailImpl = async () => {
      const err = new Error("invalid grant") as Error & { code?: string };
      err.code = "invalid_grant";
      throw err;
    };
    const { dispatchStudioAttempt } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await dispatchStudioAttempt("44444444-4444-4444-8444-444444444444");
    expect(res.status).toBe("failed");
    expect(db.tables.studio_applications[0].status).toBe("failed");
    expect(db.tables.studio_applications[0].last_failure_code).toBe("invalid_grant");
  });

  it("retry budget: the third executed failure is terminal", async () => {
    const row = attemptRow();
    row.attempt_count = 2;
    db.tables.studio_send_attempts.push(row);
    sendEmailImpl = async () => {
      const err = new Error("provider down") as Error & { temporary?: boolean; code?: string };
      err.temporary = true;
      err.code = "temporary_failure";
      throw err;
    };
    const { dispatchStudioAttempt } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await dispatchStudioAttempt("44444444-4444-4444-8444-444444444444");
    expect(res.status).toBe("failed");
    expect(db.tables.studio_send_attempts[0].status).toBe("failed");
    expect(db.tables.studio_send_attempts[0].attempt_count).toBe(3);
  });
});

describe("scheduling (durable, explicit timezone)", () => {
  // A fixed, comfortably future wall-clock time (before the default 30.06.2027
  // deadline) — deterministic regardless of the test clock's season.
  const BERLIN_FUTURE = { timeZone: "Europe/Berlin", year: 2026, month: 12, day: 20, hour: 9, minute: 0 };

  it("stores a future scheduled send in UTC with the user's IANA zone", async () => {
    const schedule = BERLIN_FUTURE;
    const { prepareStudioSend } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await prepareStudioSend("user-a", { ...IMMEDIATE, schedule });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scheduledAt).not.toBeNull();
    const app = db.tables.studio_applications[0];
    expect(app.status).toBe("scheduled");
    expect(app.schedule_timezone).toBe("Europe/Berlin");
    expect(app.scheduled_at).not.toBeNull();
    // A scheduled (future) send must NOT dispatch inline.
    expect(sendEmailCalls).toBe(0);
    const attempt = db.tables.studio_send_attempts[0];
    expect(attempt.status).toBe("queued");
    expect(new Date(attempt.scheduled_at as string).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects past schedule times (invalid_schedule)", async () => {
    const { prepareStudioSend } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await prepareStudioSend("user-a", {
      ...IMMEDIATE,
      schedule: { timeZone: "Europe/Berlin", year: 2020, month: 1, day: 1, hour: 12, minute: 0 },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invalid_schedule");
    expect(db.tables.studio_send_attempts.length).toBe(0);
  });

  it("rejects impossible instants: DST gap 02:30 on 2026-03-29 (Europe/Berlin)", async () => {
    const { prepareStudioSend } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await prepareStudioSend("user-a", {
      ...IMMEDIATE,
      schedule: { timeZone: "Europe/Berlin", year: 2026, month: 3, day: 29, hour: 2, minute: 30 },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invalid_schedule");
  });

  it("rejects an impossible calendar date (31 Feb)", async () => {
    const { prepareStudioSend } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await prepareStudioSend("user-a", {
      ...IMMEDIATE,
      schedule: { timeZone: "Europe/Berlin", year: 2026, month: 2, day: 31, hour: 12, minute: 0 },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invalid_schedule");
  });

  it("rejects schedules AFTER the advertisement deadline", async () => {
    // Deadline 30.06.2026 (in the past from the test clock's perspective is
    // fine — we schedule past it but in the FUTURE of Date.now()).
    db.tables.studio_applications[0].ad_extracted = {
      ...(db.tables.studio_applications[0].ad_extracted as object),
      applicationDeadline: "31.12.2026",
    };
    const { prepareStudioSend } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await prepareStudioSend("user-a", {
      ...IMMEDIATE,
      schedule: { timeZone: "Europe/Berlin", year: 2027, month: 1, day: 10, hour: 9, minute: 0 },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("schedule_after_deadline");
  });
});

describe("cancellation", () => {
  it("cancels a QUEUED scheduled send and resets the application", async () => {
    db.tables.studio_send_attempts.push(attemptRow({ status: "queued", scheduled_at: new Date(Date.now() + 3600_000).toISOString() }));
    db.tables.studio_applications[0].status = "scheduled";
    db.tables.studio_applications[0].scheduled_at = new Date(Date.now() + 3600_000).toISOString();
    db.tables.studio_applications[0].schedule_timezone = "Europe/Berlin";
    const { cancelStudioSend } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await cancelStudioSend("user-a", "44444444-4444-4444-8444-444444444444");
    expect(res.ok).toBe(true);
    expect(db.tables.studio_send_attempts[0].status).toBe("cancelled");
    expect(db.tables.studio_applications[0].status).toBe("ready");
    expect(db.tables.studio_applications[0].scheduled_at).toBeNull();
  });

  it("never cancels a send that is already in flight (sending)", async () => {
    db.tables.studio_send_attempts.push(attemptRow({ status: "sending" }));
    const { cancelStudioSend } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await cancelStudioSend("user-a", "44444444-4444-4444-8444-444444444444");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_cancellable");
  });

  it("never cancels someone else's send (ownership)", async () => {
    db.tables.studio_send_attempts.push(attemptRow({ status: "queued" }));
    const { cancelStudioSend } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await cancelStudioSend("user-b", "44444444-4444-4444-8444-444444444444");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_found");
    expect(db.tables.studio_send_attempts[0].status).toBe("queued");
  });

  it("a cancelled attempt is never dispatched", async () => {
    db.tables.studio_send_attempts.push(attemptRow({ status: "cancelled" }));
    const { dispatchStudioAttempt } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await dispatchStudioAttempt("44444444-4444-4444-8444-444444444444");
    expect(res.status).toBe("skipped");
    expect(sendEmailCalls).toBe(0);
  });
});

describe("server-rendered Anschreiben PDF (explicitly selected)", () => {
  function seedLetter() {
    db.tables.studio_documents.push({
      id: "dddd1111-1111-4111-8111-dddddddddddd",
      application_id: APP_ID,
      user_id: "user-a",
      doc_type: "cover_letter",
      version: 1,
      content: {
        text: "Sehr geehrter Herr Müller,\n\nauf die Stelle bewerbe ich mich hiermit.\n\nMit freundlichen Grüßen\nTest User",
        tone: "professional",
      },
      created_at: "2026-12-01T00:00:00.000Z",
    });
    db.tables.profiles.push({
      user_id: "user-a",
      full_name: "Test User",
      email: "test@example.de",
      phone: "+49 170 1234567",
      street: "Musterstraße 1",
      postal_code: "10115",
      city: "Berlin",
      country: "Deutschland",
    });
  }

  it("renders the stored letter into the private bucket ONLY when selected", async () => {
    seedLetter();
    const { prepareStudioSend } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await prepareStudioSend("user-a", {
      ...IMMEDIATE,
      attachmentIds: [STUDIO_LETTER_PDF_ID, ATT_ID],
    });
    expect(res.ok).toBe(true);
    const attempt = db.tables.studio_send_attempts[0];
    const payload = attempt.payload as { attachments: Array<{ filename: string; mimeType: string; storagePath: string }> };
    expect(payload.attachments).toHaveLength(2);
    const letter = payload.attachments.find((a) => a.filename.startsWith("Anschreiben_"));
    expect(letter).toBeTruthy();
    expect(letter?.mimeType).toBe("application/pdf");
    expect(letter?.storagePath).toMatch(/^user-a\/bew-anschreiben\//);
    const bucketUpload = db.uploaded.find((u) => u.path.endsWith(".pdf") && u.bucket === "application-attachments" && u.path.startsWith("user-a/bew-anschreiben/"));
    expect(bucketUpload).toBeTruthy();
  });

  it("a selected letter PDF without a stored letter is dropped — the send still succeeds", async () => {
    const { prepareStudioSend } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await prepareStudioSend("user-a", {
      ...IMMEDIATE,
      attachmentIds: [STUDIO_LETTER_PDF_ID],
    });
    expect(res.ok).toBe(true);
    const attempt = db.tables.studio_send_attempts[0];
    const payload = attempt.payload as { attachments: unknown[] };
    expect(payload.attachments).toEqual([]);
  });

  it("the letter PDF is NOT attached when the user did not select it", async () => {
    seedLetter();
    const { prepareStudioSend } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await prepareStudioSend("user-a", { ...IMMEDIATE });
    expect(res.ok).toBe(true);
    const attempt = db.tables.studio_send_attempts[0];
    const payload = attempt.payload as { attachments: Array<{ filename: string }> };
    expect(payload.attachments.some((a) => a.filename.startsWith("Anschreiben_"))).toBe(false);
  });
});

describe("cron sweep", () => {
  it("claims due attempts via the RPC and dispatches them (budget respected)", async () => {
    db.tables.studio_send_attempts.push(
      attemptRow({ id: "aaaa1111-1111-4111-8111-111111111111", status: "queued", scheduled_at: new Date(Date.now() - 1000).toISOString() }),
      attemptRow({ id: "aaaa2222-2222-4222-8222-222222222222", status: "queued", scheduled_at: new Date(Date.now() - 500).toISOString() }),
    );
    db.setRpc((fn, args) => {
      if (fn === "claim_due_studio_attempts") {
        // Emulate the SQL: return the due rows (already flipped to 'sending').
        const due = db.tables.studio_send_attempts
          .filter((r) => r.status === "queued" && (r.scheduled_at === null || new Date(r.scheduled_at as string).getTime() <= Date.now()))
          .slice(0, Number((args.p_limit as number) ?? 5));
        for (const r of due) r.status = "sending";
        return { data: due, error: null };
      }
      if (fn === "recover_stale_studio_attempts") return { data: 0, error: null };
      return { data: null, error: null };
    });
    const { claimAndDispatchDueStudioAttempts } = await studio();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await claimAndDispatchDueStudioAttempts(5, 60_000);
    expect(res.claimed).toBe(2);
    expect(res.results.filter((r) => r.status === "sent")).toHaveLength(2);
    expect(sendEmailCalls).toBe(2);
  });
});
