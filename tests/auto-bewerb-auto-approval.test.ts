/**
 * AUTO BEWERB — automatic company approval (ENGINE contract).
 *
 * The mandatory manual "Genehmigen" step is removed (product decision
 * 2026-11-02, migration 20261223000000_auto_bewerb_auto_approval.sql).
 * Pinned here with the REAL engine + the in-memory Supabase-style DB
 * (tests/helpers-studio):
 *
 *   1. a NEW company is auto-approved at creation (approved=true stamped
 *      inside the successful insert) and needs no further consent step;
 *   2. a COMPLETE application sends WITHOUT any manual approval
 *      (immediate legacy path, window open, slot free);
 *   3. an INCOMPLETE application is NOT sent — the exact gap is reported
 *      (missing CV, invalid recipient) and nothing is prepared;
 *   4. a LEGACY approved=false row (pre-migration database state) can still
 *      be sent — no stale state blocks the workflow;
 *   5. batch sending is automatic + PARTIAL: one ineligible company is
 *      excluded WITH its reason and never blocks the eligible subset;
 *   6. an all-ineligible selection creates no batch (every reason returned);
 *   7. safety preserved: duplicate-send prevention (already_sent) and the
 *      per-account sender-slot pacing (busy slot re-queues, no email,
 *      retry budget untouched).
 *
 * The sending window is pinned OPEN (the window GATE itself is covered by
 * tests/auto-bewerb-sending-window-gate.test.ts).
 */
import { describe, expect, it, vi } from "vitest";
import type { StudioDb } from "./helpers-studio";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/email-providers", () => ({ createEmailProvider: vi.fn() }));
vi.mock("@/lib/auto-bewerb/sending-window", () => ({
  isSendingWindowOpen: () => true,
  nextWindowStartMs: () => null,
  windowLabel: () => "07:30–10:30 Europe/Berlin",
  isCampaignTimeInWindow: () => true,
  AUTO_BEWERB_SENDING_WINDOW: { timeZone: "Europe/Berlin", startHour: 7, startMinute: 30, endHour: 10, endMinute: 30 },
}));

const { createAdminClient } = await import("@/lib/supabase/admin");
const { createEmailProvider } = await import("@/lib/email-providers");
const {
  createAutoBewerbCompany,
  createAutoBewerbBatch,
  dispatchAutoBewerbAttempt,
  prepareAutoBewerbSend,
} = await import("@/lib/auto-bewerb/engine");
const { createStudioDb } = await import("./helpers-studio");
const { cvEmpty } = await import("@/lib/templates/cv");

const USER = "11111111-1111-4111-8111-111111111111";
const ACCT = "33333333-3333-4333-8333-333333333333";
const TS = "2026-12-01T00:00:00.000Z";
const FUTURE = { timeZone: "Europe/Berlin", year: 2030, month: 6, day: 10, hour: 9, minute: 0 };

let db: StudioDb;
const tCompanies = () => db.tables.auto_bewerb_companies as unknown as Array<Record<string, unknown>>;
const tAttempts = () => db.tables.auto_bewerb_send_attempts as unknown as Array<Record<string, unknown>>;

const sendEmail = vi.fn();
const provider = { sendEmail };

function extractFor(company: string, email: string, job: string) {
  return {
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
  };
}

function companyRow(id: string, company: string, email: string, job: string, over: Record<string, unknown> = {}) {
  return {
    id,
    user_id: USER,
    company,
    company_key: company.toLowerCase(),
    slot_no: 1,
    ad_raw: "x".repeat(40),
    ad_extracted: extractFor(company, email, job),
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
    // AUTO-APPROVAL: the default row state since the migration (a legacy
    // row is simulated explicitly with over: { approved: false }).
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
    ...over,
  };
}

function cvFor(company: string) {
  const cv = cvEmpty();
  cv.personal = { ...cv.personal, fullName: "Mustapha Drif", professionalTitle: `Auszubildende:r — ${company}` };
  cv.summary = `Maßgeschneiderte Zusammenfassung für ${company}.`;
  return cv;
}

function letterFor(company: string) {
  return {
    text: `Sehr geehrte Damen und Herren,\n\nhiermit bewerbe ich mich bei ${company}.\n\nMit freundlichen Grüßen\nMustapha Drif`,
    tone: "professional" as const,
  };
}

/**
 * Seed an engine-ready database. `companies` = the company rows; for every
 * company WITHOUT `noDocs`, the tailored CV + cover letter are seeded
 * (versioned documents). Global e-mail settings: body + subject + the
 * active account, both attachment flags ON (the strictest default).
 */
function seed(companies: Array<{ id: string; company: string; email: string; job: string; noDocs?: boolean; row?: Record<string, unknown> }>) {
  const documents: Record<string, unknown>[] = [];
  for (const c of companies) {
    if (c.noDocs) continue;
    documents.push(
      { id: `cv-${c.id}`, user_id: USER, company_id: c.id, doc_type: "cv", version: 1, content: cvFor(c.company), created_at: TS, updated_at: TS },
      { id: `lt-${c.id}`, user_id: USER, company_id: c.id, doc_type: "cover_letter", version: 1, content: letterFor(c.company), created_at: TS, updated_at: TS },
    );
  }
  db = createStudioDb({
    auto_bewerb_profiles: [],
    auto_bewerb_companies: companies.map((c) => companyRow(c.id, c.company, c.email, c.job, c.row ?? {})),
    auto_bewerb_documents: documents,
    auto_bewerb_attachments: [
      {
        id: "att-1",
        user_id: USER,
        display_name: "Abiturzeugnis.pdf",
        doc_category: "school_certificate",
        mime_type: "application/pdf",
        size_bytes: 1024,
        storage_path: `${USER}/auto-bewerb/docs/att-1.pdf`,
        file_hash: "h1",
        created_at: TS,
        updated_at: TS,
      },
    ],
    auto_bewerb_company_attachments: [],
    auto_bewerb_email_templates: [
      {
        user_id: USER,
        body: "Sehr geehrte Damen und Herren,\n\nanbei meine Bewerbungsunterlagen.\n\nMit freundlichen Grüßen\nMustapha Drif",
        recipient: "",
        subject: "Bewerbung um einen Ausbildungsplatz",
        account_id: ACCT,
        attach_cv: true,
        attach_letter: true,
      },
    ],
    auto_bewerb_send_attempts: [],
    auto_bewerb_batches: [],
    email_accounts: [{ id: ACCT, user_id: USER, provider: "gmail", email: "mail@example.de", is_active: true, requires_reconnect: false }],
    activity_logs: [],
    profiles: [
      {
        id: USER,
        full_name: "Mustapha Drif",
        email: "mail@example.de",
        phone: "+49 151 23456789",
        street: "Hafenstraße 1",
        postal_code: "20457",
        city: "Hamburg",
        country: "Deutschland",
      },
    ],
  });
  (createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ providerMessageId: "msg-ok" });
  (createEmailProvider as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(provider);
  // Slot free by default (the pacing test overrides this rpc explicitly).
  db.setRpc((fn) => (fn === "reserve_sender_slot" ? { data: { reserved: true, wait_ms: 0 }, error: null } : { data: null, error: null }));
}

// ---------------------------------------------------------------------------
// 1 — auto-approval at creation
// ---------------------------------------------------------------------------

describe("auto-approval at company creation", () => {
  it("a NEW company is approved=true + approved_at inside the successful insert (no consent step afterwards)", async () => {
    db = createStudioDb({
      auto_bewerb_profiles: [],
      auto_bewerb_companies: [],
      auto_bewerb_documents: [],
      auto_bewerb_attachments: [],
      auto_bewerb_company_attachments: [],
      auto_bewerb_email_templates: [],
      auto_bewerb_send_attempts: [],
      auto_bewerb_batches: [],
      email_accounts: [],
      activity_logs: [],
      profiles: [],
    });
    (createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
    const res = await createAutoBewerbCompany(USER, {
      adRaw: "Ausbildung Anlagenmechaniker SHK — Vollzeit, Hamburg. Wir suchen zum 01.08. eine motivierte Persönlichkeit. E-Mail: jobs@neugmbh.de",
      company: "Neu GmbH",
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) throw new Error("unreachable: create failed");
    const row = res.value as unknown as Record<string, unknown>;
    expect(row.status).toBe("draft");
    expect(row.approved).toBe(true); // the auto-approval stamp
    expect(row.approved_at).toBeTruthy();
    expect(row.ad_confirmed_at).toBeTruthy();
    // The row is persisted as-is (the send pipeline re-checks its data gaps,
    // never an approval flag):
    expect(tCompanies().find((c) => c.id === row.id)?.approved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2 — complete application sends without manual approval
// ---------------------------------------------------------------------------

describe("send without manual approval", () => {
  it("a COMPLETE application sends immediately (legacy path) — no Genehmigung step exists", async () => {
    seed([{ id: "co-1", company: "Kältebau Nord GmbH", email: "jobs@kaltbau-nord.de", job: "Anlagenmechaniker SHK" }]);
    const res = await prepareAutoBewerbSend(USER, { companyId: "co-1" });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.dispatchStatus).toBe("sent");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toBe("jobs@kaltbau-nord.de");
    // Company + attempt are terminal "sent":
    const row = tCompanies()[0];
    expect(row.status).toBe("sent");
    expect(row.provider_message_id).toBe("msg-ok");
    const att = tAttempts()[0];
    expect(att.status).toBe("sent");
  });

  it("a LEGACY approved=false row (pre-migration database) sends exactly the same way", async () => {
    seed([{ id: "co-1", company: "Alt GmbH", email: "hr@alt-gmbh.de", job: "Fachinformatiker", row: { approved: false, approved_at: null } }]);
    const res = await prepareAutoBewerbSend(USER, { companyId: "co-1" });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.dispatchStatus).toBe("sent");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(tCompanies()[0].status).toBe("sent");
  });
});

// ---------------------------------------------------------------------------
// 3 — incomplete applications are NOT sent (the real gaps remain enforced)
// ---------------------------------------------------------------------------

describe("incomplete applications stay blocked (data gaps, not approval)", () => {
  it("missing CV (attachCv on) → missing_cv, nothing prepared", async () => {
    seed([{ id: "co-1", company: "NoCv GmbH", email: "jobs@nocv.de", job: "Elektroniker", noDocs: true }]);
    const res = await prepareAutoBewerbSend(USER, { companyId: "co-1" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("missing_cv");
    expect(tAttempts()).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
    const row = tCompanies()[0];
    expect(row.status).toBe("ready");
    expect(row.idempotency_key).toBeNull();
  });

  it("unresolvable recipient → invalid_recipient, nothing prepared", async () => {
    seed([{ id: "co-1", company: "NoMail GmbH", email: "", job: "Elektroniker" }]);
    const res = await prepareAutoBewerbSend(USER, { companyId: "co-1" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("invalid_recipient");
    expect(tAttempts()).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4 — batch sending: automatic, per-company results, partial exclusion
// ---------------------------------------------------------------------------

describe("automatic batch sending (partial exclusion)", () => {
  it("ONE ineligible company is excluded WITH its reason — the other 3 are sent (batch completed)", async () => {
    seed([
      { id: "co-1", company: "Firma 1 GmbH", email: "jobs@firma-1.de", job: "Ausbildung 1" },
      { id: "co-2", company: "Firma 2 GmbH", email: "jobs@firma-2.de", job: "Ausbildung 2" },
      { id: "co-3", company: "Firma 3 GmbH", email: "", job: "Ausbildung 3" }, // no verified recipient
      { id: "co-4", company: "Firma 4 GmbH", email: "jobs@firma-4.de", job: "Ausbildung 4" },
    ]);
    const res = await createAutoBewerbBatch(USER, { companyIds: ["co-1", "co-2", "co-3", "co-4"], schedule: null });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    // The gap is reported with the exact reason:
    expect(res.errors).toEqual([{ companyId: "co-3", code: "invalid_recipient", message: expect.any(String) }]);
    // The eligible subset (3 of 4) forms the batch and is sent:
    expect(res.items?.filter((i) => i.ok)).toHaveLength(3);
    expect(res.items?.every((i) => i.ok && i.dispatchStatus === "sent")).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(3);
    const batch = db.tables.auto_bewerb_batches[0] as { snapshot: { items: Array<{ companyId: string }> }; status: string };
    expect(batch.snapshot.items.map((i) => i.companyId)).toEqual(["co-1", "co-2", "co-4"]);
    expect(batch.status).toBe("completed");
    // The excluded company is UNTOUCHED (still selectable for a new batch):
    expect(tCompanies().find((c) => c.id === "co-3")!.status).toBe("ready");
  });

  it("an ALL-ineligible selection creates NO batch (every reason returned, nothing sent)", async () => {
    seed([
      { id: "co-1", company: "Bad 1 GmbH", email: "jobs@bad-1.de", job: "Ausbildung 1", noDocs: true }, // missing CV
      { id: "co-2", company: "Bad 2 GmbH", email: "", job: "Ausbildung 2" }, // invalid recipient
    ]);
    const res = await createAutoBewerbBatch(USER, { companyIds: ["co-1", "co-2"], schedule: null });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("batch_not_ready");
    expect(res.errors).toHaveLength(2);
    expect(res.errors?.find((e) => e.companyId === "co-1")!.code).toBe("missing_cv");
    expect(res.errors?.find((e) => e.companyId === "co-2")!.code).toBe("invalid_recipient");
    expect(db.tables.auto_bewerb_batches).toHaveLength(0);
    expect(tAttempts()).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5 — preserved safety: duplicate-send prevention + sender-slot pacing
// ---------------------------------------------------------------------------

describe("safety checks remain in force after removing the approval step", () => {
  it("duplicate-send prevention: a second send of the same company is refused (already_sent)", async () => {
    seed([{ id: "co-1", company: "Once GmbH", email: "jobs@once.de", job: "Anlagenmechaniker SHK" }]);
    const first = await prepareAutoBewerbSend(USER, { companyId: "co-1" });
    expect(first.ok).toBe(true);
    expect(first.dispatchStatus).toBe("sent");
    const second = await prepareAutoBewerbSend(USER, { companyId: "co-1" });
    expect(second.ok).toBe(false);
    expect(second.code).toBe("already_sent");
    expect(sendEmail).toHaveBeenCalledTimes(1); // exactly ONE e-mail
    expect(tAttempts()).toHaveLength(1); // no second attempt row
  });

  it("sender-slot pacing: a BUSY account slot re-queues (no email, retry budget untouched)", async () => {
    seed([{ id: "co-1", company: "Paced GmbH", email: "jobs@paced.de", job: "Elektroniker" }]);
    // SCHEDULED → the attempt is durable, nothing dispatches inline:
    const res = await prepareAutoBewerbSend(USER, { companyId: "co-1", schedule: FUTURE });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const attempt = tAttempts()[0];
    expect(attempt.status).toBe("queued");
    // The account slot is busy (the DB says "wait 50ms"):
    db.setRpc((fn) => (fn === "reserve_sender_slot" ? { data: { reserved: false, wait_ms: 50 }, error: null } : { data: null, error: null }));
    const out = await dispatchAutoBewerbAttempt(String(attempt.id), { slotBudgetMs: 120 });
    expect(out).toMatchObject({ ok: false, status: "queued", failureCode: "sender_slot_busy" });
    expect(attempt.status).toBe("queued"); // stays in the queue for the next tick
    expect(attempt.attempt_count).toBe(0); // a busy slot is not a send failure
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
