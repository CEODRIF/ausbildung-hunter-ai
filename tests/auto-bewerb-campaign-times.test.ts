/**
 * AUTO BEWERB — INDIVIDUAL CAMPAIGN SCHEDULED TIMES (engine behavior, REAL
 * window logic + fake system clock, winter 2026 — Berlin = UTC+1).
 *
 * The scheduling contract under test:
 *  - each campaign keeps its OWN scheduled timestamp — a 08:00 campaign
 *    starts at 08:00 (the first tick at/after it), NEVER at 07:30 and never
 *    earlier; a 09:00 campaign at 09:00; a 10:00 campaign at 10:00;
 *  - one user's campaign time never overwrites another's (per-batch
 *    scheduled_at + per-account 3:30 inter-batch gate on actual started_at);
 *  - scheduled times OUTSIDE 07:30–10:30 Berlin are REJECTED server-side
 *    (07:29, 10:31, 11:00, 20:00) — never silently moved;
 *  - a delayed scheduler tick starts a due campaign at the FIRST safe
 *    execution after its time (while the window is still open);
 *  - legacy (pre-batch) sends: schedule validation + the send-now window
 *    gate (outside the window the attempt is held at the NEXT window start,
 *    never dispatched).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/email-providers", () => ({ createEmailProvider: vi.fn() }));

const { createAdminClient } = await import("@/lib/supabase/admin");
const { createEmailProvider } = await import("@/lib/email-providers");
const {
  claimAndDispatchDueAutoBewerbAttempts,
  createAutoBewerbBatch,
  prepareAutoBewerbSend,
  startAutoBewerbBatchesForUser,
} = await import("@/lib/auto-bewerb/engine");
const { createStudioDb } = await import("./helpers-studio");
const { cvEmpty } = await import("@/lib/templates/cv");
import type { StudioDb } from "./helpers-studio";

const USER = "11111111-1111-4111-8111-111111111111";
const ACCT = "33333333-3333-4333-8333-333333333333";
const ACCT2 = "44444444-4444-4444-8444-444444444444";
const TS = "2026-01-10T00:00:00.000Z";
const TZ = "Europe/Berlin";

/** Berlin wall-clock (January 2026, CET UTC+1) → UTC ISO instant. */
const B = (day: number, h: number, mi: number) => new Date(Date.UTC(2026, 0, day, h - 1, mi, 0)).toISOString();
/** A schedule request for Jan `day` at Berlin h:mi. */
const scheduleFor = (day: number, h: number, mi: number) => ({ timeZone: TZ, year: 2026, month: 1, day, hour: h, minute: mi });

let db: StudioDb;
const sendEmail = vi.fn();
const provider = { sendEmail };

type TBatch = { id: string; user_id: string; account_id: string; status: string; scheduled_at: string | null; started_at: string | null };
type TAttempt = { id: string; company_id: string; batch_id: string | null; status: string; scheduled_at: string | null; next_attempt_at: string | null };
const tBatches = () => db.tables.auto_bewerb_batches as unknown as TBatch[];
const tAttempts = () => db.tables.auto_bewerb_send_attempts as unknown as TAttempt[];
const tCompanies = () => db.tables.auto_bewerb_companies as unknown as Array<{ id: string; status: string; scheduled_at: string | null }>;

/** Faithful fakes for the Postgres claim RPCs (same semantics as the
 *  migration: a batch attempt is only claimable while its batch is 'sending';
 *  legacy attempts without a batch are claimable once due). */
function installRpc() {
  db.setRpc((fn: string) => {
    switch (fn) {
      case "reserve_sender_slot":
        return { data: { reserved: true, wait_ms: 0 }, error: null };
      case "recover_stale_auto_bewerb_attempts":
        return { data: 0, error: null };
      case "recover_stale_auto_bewerb_batches":
        return { data: 0, error: null };
      case "claim_startable_auto_bewerb_batches": {
        const nowIso = new Date().toISOString();
        const due = tBatches()
          .filter((b) => (b.status === "scheduled" || b.status === "waiting") && (b.scheduled_at === null || b.scheduled_at <= nowIso))
          .slice(0, 5);
        for (const b of due) {
          b.status = "sending";
          b.started_at = nowIso;
        }
        return { data: due, error: null };
      }
      case "claim_due_auto_bewerb_attempts": {
        const nowIso = new Date().toISOString();
        const due = tAttempts().filter(
          (a) =>
            a.status === "queued" &&
            (a.scheduled_at === null || a.scheduled_at <= nowIso) &&
            (a.next_attempt_at === null || a.next_attempt_at <= nowIso) &&
            (a.batch_id === null || tBatches().find((b) => b.id === a.batch_id)?.status === "sending"),
        );
        const picked = due.slice(0, 5);
        for (const a of picked) a.status = "sending";
        return { data: picked, error: null };
      }
      default:
        return { data: null, error: null };
    }
  });
}

function extractFor(company: string, email: string, job: string) {
  return {
    jobTitle: job, occupation: job, company, companyAddress: "", location: "", startDate: "",
    applicationDeadline: "", requiredQualifications: [], preferredQualifications: [], technicalSkills: [],
    softSkills: [], languageRequirements: [], educationRequirement: "", responsibilities: [],
    requestedDocuments: [], applicationMethod: "", contactPerson: "", applicationEmail: email,
    companyNotes: [], missingOrAmbiguous: [],
  };
}

function seed(nCompanies: number) {
  const companies = Array.from({ length: nCompanies }, (_, i) => ({
    id: `c${i + 1}`, name: `Company ${i + 1}`, email: `jobs${i + 1}@example.de`, job: `Ausbildung ${i + 1}`,
  }));
  const rows = companies.map((c) => ({
    id: c.id, user_id: USER, company: c.name, company_key: c.name.toLowerCase(), slot_no: Number(c.id.slice(1)),
    ad_raw: "x".repeat(40), ad_extracted: extractFor(c.name, c.email, c.job), ad_analysis: null,
    profile_snapshot: null, status: "ready", recipient_email: null, email_subject: null, email_body: null,
    email_attach_cv: true, email_attach_letter: true, email_account_id: ACCT, idempotency_key: null,
    approved: true, approved_at: TS, scheduled_at: null, schedule_timezone: null,
    sent_at: null, provider_message_id: null, last_failure_code: null, ad_confirmed_at: TS,
    cv_reviewed_at: null, letter_reviewed_at: null, created_at: TS, updated_at: TS,
  }));
  const docs = companies.flatMap((c) => [
    { id: `cv-${c.id}`, user_id: USER, company_id: c.id, doc_type: "cv", version: 1, content: cvEmpty(), created_at: TS, updated_at: TS },
    {
      id: `lt-${c.id}`, user_id: USER, company_id: c.id, doc_type: "cover_letter", version: 1,
      content: { text: `Sehr geehrte Damen und Herren,\n\nhiermit bewerbe ich mich bei ${c.name}.\n\nMit freundlichen Grüßen\nMustapha Drif`, tone: "professional" },
      created_at: TS, updated_at: TS,
    },
  ]);
  db = createStudioDb({
    auto_bewerb_profiles: [],
    auto_bewerb_companies: rows,
    auto_bewerb_documents: docs,
    auto_bewerb_attachments: [],
    auto_bewerb_company_attachments: [],
    auto_bewerb_email_templates: [
      { user_id: USER, body: "Sehr geehrte Damen und Herren,\n\nanbei meine Bewerbungsunterlagen.\n\nMit freundlichen Grüßen\nMustapha Drif", recipient: "", subject: "Bewerbung", account_id: ACCT, attach_cv: true, attach_letter: true },
    ],
    auto_bewerb_send_attempts: [],
    auto_bewerb_batches: [],
    email_accounts: [
      { id: ACCT, user_id: USER, provider: "gmail", email: "mail@example.de", is_active: true, requires_reconnect: false },
      { id: ACCT2, user_id: USER, provider: "gmail", email: "mail2@example.de", is_active: true, requires_reconnect: false },
    ],
    activity_logs: [],
    profiles: [{ id: USER, full_name: "Mustapha Drif", email: "mail@example.de", phone: "", street: "", postal_code: "", city: "", country: "Deutschland" }],
  });
  (createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ providerMessageId: "msg-ok" });
  (createEmailProvider as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(provider);
  installRpc();
}

afterEach(() => {
  vi.useRealTimers();
});

/** Hand-rolled batch row (avoids createAutoBewerbBatch for multi-account setups). */
function pushBatch(id: string, accountId: string, scheduledAt: string | null, status = "scheduled") {
  (db.tables.auto_bewerb_batches as Record<string, unknown>[]).push({
    id, user_id: USER, batch_no: 1,
    snapshot: { items: [], subject: "s", accountId, accountEmail: "mail@example.de", attachCv: true, attachLetter: true, sharedDocs: [] },
    account_id: accountId, status, scheduled_at: scheduledAt, started_at: null, completed_at: null, created_at: TS, updated_at: TS,
  });
}
function pushAttempt(batchId: string, companyId: string, scheduledAt: string | null) {
  (db.tables.auto_bewerb_send_attempts as Record<string, unknown>[]).push({
    id: `att-${batchId}`, company_id: companyId, user_id: USER, batch_id: batchId, idempotency_key: `ik-${batchId}`,
    recipient_email: "jobs1@example.de", subject: "s", payload: { html: "", text: "", attachments: [] },
    status: "queued", scheduled_at: scheduledAt, attempt_count: 0, next_attempt_at: null,
    provider_message_id: null, failure_code: null, failure_message: null, sent_at: null, created_at: TS, updated_at: TS,
  });
}

// ---------------------------------------------------------------------------
// Individual campaign times are preserved (never normalized to 07:30)
// ---------------------------------------------------------------------------

describe("individual campaign start times", () => {
  it("a campaign scheduled for 08:00 starts at 08:00 (first tick after) — NOT at 07:30", async () => {
    seed(1);
    vi.useFakeTimers();
    // Scheduled at 07:00 Berlin (window open) for 08:00 Berlin tomorrow-ish (same day 08:00):
    vi.setSystemTime(B(15, 7, 0));
    const res = await createAutoBewerbBatch(USER, { companyIds: ["c1"], schedule: scheduleFor(15, 8, 0) });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.status).toBe("scheduled");
    // The EXACT selected time is stored (08:00 Berlin = 07:00 UTC):
    expect(res.scheduledAt).toBe(B(15, 8, 0));
    expect(tBatches()[0].scheduled_at).toBe(B(15, 8, 0));

    // 07:45 + 07:50 Berlin (window open, ticks well before 08:00): NOT started.
    vi.setSystemTime(B(15, 7, 45));
    await claimAndDispatchDueAutoBewerbAttempts(5, 45_000);
    expect(tBatches()[0].status).toBe("scheduled");
    expect(tBatches()[0].started_at).toBeNull();

    // 08:01 Berlin (first tick at/after the selected time): started.
    vi.setSystemTime(B(15, 8, 1));
    await claimAndDispatchDueAutoBewerbAttempts(5, 45_000);
    expect(tBatches()[0].status).toBe("completed"); // started at 08:01 → drained + settled
    expect(tBatches()[0].started_at).toBe(B(15, 8, 1));
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("a campaign scheduled for 09:00 starts at 09:00 — NOT at 07:30", async () => {
    seed(1);
    vi.useFakeTimers();
    vi.setSystemTime(B(15, 8, 30));
    const res = await createAutoBewerbBatch(USER, { companyIds: ["c1"], schedule: scheduleFor(15, 9, 0) });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.scheduledAt).toBe(B(15, 9, 0));

    vi.setSystemTime(B(15, 8, 59));
    await claimAndDispatchDueAutoBewerbAttempts(5, 45_000);
    expect(tBatches()[0].status).toBe("scheduled"); // 08:59 — still not its time

    vi.setSystemTime(B(15, 9, 0));
    await claimAndDispatchDueAutoBewerbAttempts(5, 45_000);
    expect(tBatches()[0].started_at).toBe(B(15, 9, 0)); // exactly 09:00
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("a campaign scheduled for 10:00 starts at 10:00 — NOT at 07:30", async () => {
    seed(1);
    vi.useFakeTimers();
    vi.setSystemTime(B(15, 9, 30));
    const res = await createAutoBewerbBatch(USER, { companyIds: ["c1"], schedule: scheduleFor(15, 10, 0) });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.scheduledAt).toBe(B(15, 10, 0));

    vi.setSystemTime(B(15, 9, 59));
    await claimAndDispatchDueAutoBewerbAttempts(5, 45_000);
    expect(tBatches()[0].status).toBe("scheduled"); // never before its selected time

    vi.setSystemTime(B(15, 10, 0));
    await claimAndDispatchDueAutoBewerbAttempts(5, 45_000);
    expect(tBatches()[0].started_at).toBe(B(15, 10, 0));
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("before 07:30 (window closed) NOTHING starts — even a batch that is already due", async () => {
    seed(1);
    vi.useFakeTimers();
    pushBatch("batch-due", ACCT, B(15, 6, 0)); // due since 07:00 Berlin
    pushAttempt("batch-due", "c1", B(15, 6, 0));
    vi.setSystemTime(B(15, 7, 0)); // 07:00 Berlin — window still closed

    await claimAndDispatchDueAutoBewerbAttempts(5, 45_000);
    expect(tBatches()[0].status).toBe("scheduled");
    expect(tBatches()[0].started_at).toBeNull();
    expect(sendEmail).not.toHaveBeenCalled();

    // 07:31 (window open): it starts.
    vi.setSystemTime(B(15, 7, 31));
    await claimAndDispatchDueAutoBewerbAttempts(5, 45_000);
    expect(tBatches()[0].started_at).toBe(B(15, 7, 31));
  });

  it("a delayed tick starts the campaign at the FIRST safe execution after its time (while the window is open)", async () => {
    seed(1);
    vi.useFakeTimers();
    pushBatch("batch-0800", ACCT, B(15, 8, 0));
    pushAttempt("batch-0800", "c1", B(15, 8, 0));
    // The 08:00–08:15 ticks never ran (GitHub throttling). The first
    // execution that lands is 08:20 — the campaign starts THEN, not at 08:00
    // and not before:
    vi.setSystemTime(B(15, 8, 20));
    await claimAndDispatchDueAutoBewerbAttempts(5, 45_000);
    expect(tBatches()[0].started_at).toBe(B(15, 8, 20));
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("duplicate scheduler requests are idempotent — the campaign is sent exactly once", async () => {
    seed(1);
    vi.useFakeTimers();
    pushBatch("batch-0800", ACCT, B(15, 8, 0));
    pushAttempt("batch-0800", "c1", B(15, 8, 0));
    vi.setSystemTime(B(15, 8, 1));
    await claimAndDispatchDueAutoBewerbAttempts(5, 45_000);
    await claimAndDispatchDueAutoBewerbAttempts(5, 45_000); // overlapping / duplicate tick
    vi.setSystemTime(B(15, 8, 6));
    await claimAndDispatchDueAutoBewerbAttempts(5, 45_000);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(tBatches()[0].status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Per-account isolation + the 3:30 inter-batch gate (actual started_at)
// ---------------------------------------------------------------------------

describe("account isolation + 3:30 inter-batch gate", () => {
  it("two accounts with campaigns at the same time: each starts at its own time — no cross-account interference", async () => {
    seed(2);
    vi.useFakeTimers();
    pushBatch("batch-a", ACCT, B(15, 8, 0));
    pushAttempt("batch-a", "c1", B(15, 8, 0));
    pushBatch("batch-b", ACCT2, B(15, 8, 0));
    pushAttempt("batch-b", "c2", B(15, 8, 0));

    vi.setSystemTime(B(15, 8, 1));
    const started = await startAutoBewerbBatchesForUser(USER, 5);

    // Both accounts start at their own 08:00 (the gate is PER ACCOUNT):
    expect(started.map((b) => b.id).sort()).toEqual(["batch-a", "batch-b"]);
    for (const id of ["batch-a", "batch-b"]) {
      expect(tBatches().find((b) => b.id === id)!.started_at).toBe(B(15, 8, 1));
    }
  });

  it("same account: the 3:30 gate (from ACTUAL started_at) holds the second campaign, then releases it", async () => {
    seed(2);
    vi.useFakeTimers();
    pushBatch("batch-1", ACCT, B(15, 8, 0));
    pushAttempt("batch-1", "c1", B(15, 8, 0));
    pushBatch("batch-2", ACCT, B(15, 8, 2)); // 08:02, same account
    pushAttempt("batch-2", "c2", B(15, 8, 2));

    vi.setSystemTime(B(15, 8, 1));
    await startAutoBewerbBatchesForUser(USER, 5);
    // batch-1 started at 08:01 (first tick at/after its 08:00 time); batch-2
    // (08:02) is NOT due yet at 08:01 → still scheduled.
    expect(tBatches().find((b) => b.id === "batch-1")!.started_at).toBe(B(15, 8, 1));
    expect(tBatches().find((b) => b.id === "batch-2")!.status).toBe("scheduled");

    vi.setSystemTime(B(15, 8, 3));
    await startAutoBewerbBatchesForUser(USER, 5);
    // batch-2 is due (08:02 ≤ 08:03) but the SAME account started at 08:01 —
    // 08:01 + 3:30 = 08:04:30 > 08:03 → held as 'waiting' by the 3:30 gate.
    expect(tBatches().find((b) => b.id === "batch-2")!.status).toBe("waiting");
    expect(tBatches().find((b) => b.id === "batch-2")!.started_at).toBeNull();

    vi.setSystemTime(B(15, 8, 5));
    await startAutoBewerbBatchesForUser(USER, 5);
    // 08:01 + 3:30 = 08:04:30 ≤ 08:05 → the gate is clear → batch-2 starts.
    expect(tBatches().find((b) => b.id === "batch-2")!.started_at).toBe(B(15, 8, 5));
  });
});

// ---------------------------------------------------------------------------
// Server-side validation: out-of-window times are REJECTED (never moved)
// ---------------------------------------------------------------------------

describe("server-side schedule validation (createAutoBewerbBatch)", () => {
  it.each([
    ["07:29", 7, 29],
    ["10:31", 10, 31],
    ["11:00", 11, 0],
    ["20:00", 20, 0],
  ])("scheduling for %s Berlin is rejected with schedule_outside_window", async (_label, h, mi) => {
    seed(1);
    vi.useFakeTimers();
    vi.setSystemTime(B(14, 21, 0)); // 2026-01-14 22:00 Berlin — tomorrow is future
    const res = await createAutoBewerbBatch(USER, { companyIds: ["c1"], schedule: scheduleFor(15, h, mi) });
    expect(res.ok).toBe(false);
    expect((res as { code?: string }).code).toBe("schedule_outside_window");
    expect(tBatches().length).toBe(0); // nothing created, nothing moved
  });

  it.each([
    ["07:30", 7, 30, B(15, 7, 30)],
    ["08:00", 8, 0, B(15, 8, 0)],
    ["09:00", 9, 0, B(15, 9, 0)],
    ["10:00", 10, 0, B(15, 10, 0)],
    ["10:30", 10, 30, B(15, 10, 30)],
  ])("scheduling for %s Berlin is accepted and stores the EXACT time", async (_label, h, mi, expectedUtc) => {
    seed(1);
    vi.useFakeTimers();
    vi.setSystemTime(B(14, 21, 0));
    const res = await createAutoBewerbBatch(USER, { companyIds: ["c1"], schedule: scheduleFor(15, h, mi) });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.status).toBe("scheduled");
    expect(res.scheduledAt).toBe(expectedUtc); // exact selected time — never normalized to 07:30
    expect(tBatches()[0].scheduled_at).toBe(expectedUtc);
  });
});

describe("server-side schedule validation (legacy prepareAutoBewerbSend)", () => {
  it("a legacy schedule for 20:00 Berlin is rejected with schedule_outside_window", async () => {
    seed(1);
    vi.useFakeTimers();
    vi.setSystemTime(B(14, 21, 0));
    const res = await prepareAutoBewerbSend(USER, { companyId: "c1", schedule: scheduleFor(15, 20, 0) });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("schedule_outside_window");
    expect(tAttempts().length).toBe(0);
    expect(tCompanies()[0].status).toBe("ready"); // untouched
  });
});

// ---------------------------------------------------------------------------
// Legacy "send now" + the sending window
// ---------------------------------------------------------------------------

describe("legacy send-now + sending window", () => {
  it("inside the window (08:00 Berlin): dispatches inline exactly as before", async () => {
    seed(1);
    vi.useFakeTimers();
    vi.setSystemTime(B(15, 8, 0));
    const res = await prepareAutoBewerbSend(USER, { companyId: "c1", schedule: null });
    expect(res.ok).toBe(true);
    expect(res.dispatchStatus).toBe("sent");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(tCompanies()[0].status).toBe("sent");
  });

  it("outside the window (12:00 Berlin): NO e-mail is initiated — the send is held at the NEXT window start (honest 'scheduled')", async () => {
    seed(1);
    vi.useFakeTimers();
    vi.setSystemTime(B(15, 12, 0)); // 11:00 UTC — window closed
    const res = await prepareAutoBewerbSend(USER, { companyId: "c1", schedule: null });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.dispatchStatus).toBe("queued"); // held — NOT sent
    // Next window start = tomorrow 07:30 Berlin (CET) = 2026-01-16 06:30 UTC:
    expect(res.scheduledAt).toBe("2026-01-16T06:30:00.000Z");
    expect(tCompanies()[0].status).toBe("scheduled");
    expect(tCompanies()[0].scheduled_at).toBe("2026-01-16T06:30:00.000Z");
    expect(tAttempts()[0].scheduled_at).toBe("2026-01-16T06:30:00.000Z");
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
