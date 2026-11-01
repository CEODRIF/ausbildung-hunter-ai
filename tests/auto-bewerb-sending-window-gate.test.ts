/**
 * AUTO BEWERB — SENDING WINDOW GATE (engine behavior, REAL window logic).
 *
 * Unlike the other engine suites (which pin the window OPEN for determinism),
 * this file runs the REAL sending-window module against a FAKE system clock
 * (winter 2026 — Berlin = UTC+1), so 08:00 Berlin = 07:00 UTC, 11:00 Berlin
 * = 10:00 UTC, etc.
 *
 * Safe batch-boundary policy under test:
 *  - outside the window: NO new batch starts (cron path skips the
 *    claim_startable RPC entirely; immediate 'send now' is accepted but held
 *    'waiting' with the honest windowDeferred status; page-load catch-up
 *    starts nothing);
 *  - in-flight 'sending' batches DRAIN to completion even outside the window
 *    (their queued attempts are claimed + dispatched — nothing interrupted);
 *  - held batches start at the next eligible window.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/email-providers", () => ({ createEmailProvider: vi.fn() }));

const { createAdminClient } = await import("@/lib/supabase/admin");
const { createEmailProvider } = await import("@/lib/email-providers");
const {
  claimAndDispatchDueAutoBewerbAttempts,
  createAutoBewerbBatch,
  getAutoBewerbWorkspace,
  processDueAutoBewerbAttemptsForUser,
} = await import("@/lib/auto-bewerb/engine");
const { createStudioDb } = await import("./helpers-studio");
const { cvEmpty } = await import("@/lib/templates/cv");
import type { StudioDb } from "./helpers-studio";

const USER = "11111111-1111-4111-8111-111111111111";
const ACCT = "33333333-3333-4333-8333-333333333333";
const TS = "2026-01-10T00:00:00.000Z";

/** Winter 2026 (CET, UTC+1) instants — Berlin wall clock +1h = UTC. */
const BERLIN = {
  "08:00": Date.UTC(2026, 0, 15, 7, 0, 0), // inside window
  "11:00": Date.UTC(2026, 0, 15, 10, 0, 0), // outside (after)
  "07:31": Date.UTC(2026, 0, 15, 6, 31, 0), // inside (just opened)
  "10:45": Date.UTC(2026, 0, 15, 9, 45, 0), // outside (drain case)
  "10:30:30": Date.UTC(2026, 0, 15, 9, 30, 30), // last minute of the window (end inclusive)
  "10:31:00": Date.UTC(2026, 0, 15, 9, 31, 0), // first minute after the window
};

/** A batch scheduled for EXACTLY 10:30 Berlin (09:30 UTC) + its attempt. */
function batchDueAt1030() {
  return {
    id: "batch-1030", user_id: USER, batch_no: 1,
    snapshot: { items: [], subject: "s", accountId: ACCT, accountEmail: "mail@example.de", attachCv: true, attachLetter: true, sharedDocs: [] },
    account_id: ACCT, status: "scheduled", scheduled_at: "2026-01-15T09:30:00.000Z",
    started_at: null, completed_at: null, created_at: TS, updated_at: TS,
  };
}
function attemptOf1030(companyId: string) {
  return {
    id: "att-1030", company_id: companyId, user_id: USER, batch_id: "batch-1030", idempotency_key: "ik-1030",
    recipient_email: "jobs@held.de", subject: "s", payload: { html: "", text: "", attachments: [] },
    status: "queued", scheduled_at: "2026-01-15T09:30:00.000Z", attempt_count: 0, next_attempt_at: null,
    provider_message_id: null, failure_code: null, failure_message: null, sent_at: null, created_at: TS, updated_at: TS,
  };
}

let db: StudioDb;
const sendEmail = vi.fn();
const provider = { sendEmail };
const rpcCalls: string[] = [];

type TAttempt = { id: string; company_id: string; batch_id: string | null; status: string; scheduled_at: string | null; next_attempt_at: string | null };
type TBatch = { id: string; user_id: string; status: string; account_id: string; scheduled_at: string | null; started_at: string | null; snapshot: unknown };
const tAttempts = () => db.tables.auto_bewerb_send_attempts as unknown as TAttempt[];
const tBatches = () => db.tables.auto_bewerb_batches as unknown as TBatch[];

/** Faithful fakes for the Postgres claim RPCs (record every call). */
function installRpc() {
  db.setRpc((fn: string) => {
    rpcCalls.push(fn);
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

function companyRow(id: string, company: string, email: string, job: string, approved: boolean) {
  return {
    id, user_id: USER, company, company_key: company.toLowerCase(), slot_no: 1,
    ad_raw: "x".repeat(40), ad_extracted: extractFor(company, email, job), ad_analysis: null,
    profile_snapshot: null, status: "ready", recipient_email: null, email_subject: null, email_body: null,
    // Set directly (the hand-rolled attempt tests skip prepareAutoBewerbSend,
    // which would normally stamp the batch account here):
    email_attach_cv: true, email_attach_letter: true, email_account_id: ACCT, idempotency_key: null,
    approved, approved_at: approved ? TS : null, scheduled_at: null, schedule_timezone: null,
    sent_at: null, provider_message_id: null, last_failure_code: null, ad_confirmed_at: TS,
    cv_reviewed_at: null, letter_reviewed_at: null, created_at: TS, updated_at: TS,
  };
}

function seed(companies: Array<{ id: string; name: string; email: string; job: string; approved?: boolean }>) {
  const rows = companies.map((c) => companyRow(c.id, c.name, c.email, c.job, c.approved ?? true));
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
    email_accounts: [{ id: ACCT, user_id: USER, provider: "gmail", email: "mail@example.de", is_active: true, requires_reconnect: false }],
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
  rpcCalls.length = 0;
});

// ---------------------------------------------------------------------------
// Immediate 'send now' (createAutoBewerbBatch, schedule: null)
// ---------------------------------------------------------------------------

describe("immediate batch + sending window", () => {
  it("11:00 Berlin (window CLOSED): accepted but held 'waiting', honest windowDeferred, nothing sent", async () => {
    seed([{ id: "w1", name: "Window GmbH", email: "jobs@window.de", job: "Ausbildung W" }]);
    vi.useFakeTimers();
    vi.setSystemTime(BERLIN["11:00"]);
    const res = await createAutoBewerbBatch(USER, { companyIds: ["w1"], schedule: null });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.status).toBe("waiting"); // held — NOT started outside the window
    expect(res.windowDeferred).toBe(true); // honest deferral status
    expect(tBatches()[0].status).toBe("waiting");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("08:00 Berlin (window OPEN): starts immediately as before", async () => {
    seed([{ id: "w1", name: "Window GmbH", email: "jobs@window.de", job: "Ausbildung W" }]);
    vi.useFakeTimers();
    vi.setSystemTime(BERLIN["08:00"]);
    const res = await createAutoBewerbBatch(USER, { companyIds: ["w1"], schedule: null });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.windowDeferred).toBeUndefined();
    // The single company dispatches inline: batch settled, mail sent.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(tAttempts()[0].status).toBe("sent");
  });
});

// ---------------------------------------------------------------------------
// Cron path (claimAndDispatchDueAutoBewerbAttempts)
// ---------------------------------------------------------------------------

describe("cron tick + sending window", () => {
  it("window CLOSED: the claim_startable RPC is never called (no new batch starts), but in-flight batches DRAIN (safe batch boundary)", async () => {
    seed([
      { id: "f1", name: "Flying GmbH", email: "jobs@flying.de", job: "Ausbildung F" }, // in-flight batch
      { id: "h1", name: "Held GmbH", email: "jobs@held.de", job: "Ausbildung H" }, // due, must WAIT
    ]);
    vi.useFakeTimers();
    vi.setSystemTime(BERLIN["10:45"]);
    // Pre-state: batch A already STARTED (in-flight), batch B due + waiting:
    const batchA = { id: "batch-a", user_id: USER, batch_no: 1, snapshot: { items: [], subject: "s", accountId: ACCT, accountEmail: "mail@example.de", attachCv: true, attachLetter: true, sharedDocs: [] }, account_id: ACCT, status: "sending", scheduled_at: null, started_at: "2026-01-15T09:25:00.000Z", completed_at: null, created_at: TS, updated_at: TS };
    const batchB = { id: "batch-b", user_id: USER, batch_no: 2, snapshot: batchA.snapshot, account_id: ACCT, status: "waiting", scheduled_at: null, started_at: null, completed_at: null, created_at: TS, updated_at: TS };
    (db.tables.auto_bewerb_batches as Record<string, unknown>[]).push(batchA, batchB);
    (db.tables.auto_bewerb_send_attempts as Record<string, unknown>[]).push(
      { id: "att-a1", company_id: "f1", user_id: USER, batch_id: "batch-a", idempotency_key: "ik-a1", recipient_email: "jobs@flying.de", subject: "s", payload: { html: "", text: "", attachments: [] }, status: "queued", scheduled_at: "2026-01-15T09:25:00.000Z", attempt_count: 0, next_attempt_at: null, provider_message_id: null, failure_code: null, failure_message: null, sent_at: null, created_at: TS, updated_at: TS },
      { id: "att-b1", company_id: "h1", user_id: USER, batch_id: "batch-b", idempotency_key: "ik-b1", recipient_email: "jobs@held.de", subject: "s", payload: { html: "", text: "", attachments: [] }, status: "queued", scheduled_at: "2026-01-15T09:25:00.000Z", attempt_count: 0, next_attempt_at: null, provider_message_id: null, failure_code: null, failure_message: null, sent_at: null, created_at: TS, updated_at: TS },
    );
    // Company f1 must look 'sending' to dispatch (approved + account set by prepare in production; set directly here):
    (db.tables.auto_bewerb_companies as Record<string, unknown>[]).find((c) => c.id === "f1")!.status = "sending";

    const sweep = await claimAndDispatchDueAutoBewerbAttempts(5, 45_000);

    // The window gate: the batch-START RPC was never invoked…
    expect(rpcCalls).not.toContain("claim_startable_auto_bewerb_batches");
    expect(sweep.windowOpen).toBe(false);
    // …batch B (due) is still waiting — held for the next window…
    expect(tBatches().find((b) => b.id === "batch-b")!.status).toBe("waiting");
    // …while in-flight batch A DRAINED: its attempt was claimed + sent.
    expect(tAttempts().find((a) => a.id === "att-a1")!.status).toBe("sent");
    expect(tAttempts().find((a) => a.id === "att-b1")!.status).toBe("queued"); // B's attempt untouched
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("window OPEN: claim_startable runs and due batches start (behavior unchanged)", async () => {
    seed([{ id: "h1", name: "Held GmbH", email: "jobs@held.de", job: "Ausbildung H" }]);
    vi.useFakeTimers();
    vi.setSystemTime(BERLIN["08:00"]);
    const batchB = { id: "batch-b", user_id: USER, batch_no: 1, snapshot: { items: [], subject: "s", accountId: ACCT, accountEmail: "mail@example.de", attachCv: true, attachLetter: true, sharedDocs: [] }, account_id: ACCT, status: "waiting", scheduled_at: null, started_at: null, completed_at: null, created_at: TS, updated_at: TS };
    (db.tables.auto_bewerb_batches as Record<string, unknown>[]).push(batchB);
    (db.tables.auto_bewerb_send_attempts as Record<string, unknown>[]).push(
      { id: "att-b1", company_id: "h1", user_id: USER, batch_id: "batch-b", idempotency_key: "ik-b1", recipient_email: "jobs@held.de", subject: "s", payload: { html: "", text: "", attachments: [] }, status: "queued", scheduled_at: "2026-01-15T07:00:00.000Z", attempt_count: 0, next_attempt_at: null, provider_message_id: null, failure_code: null, failure_message: null, sent_at: null, created_at: TS, updated_at: TS },
    );

    const sweep = await claimAndDispatchDueAutoBewerbAttempts(5, 45_000);

    expect(rpcCalls).toContain("claim_startable_auto_bewerb_batches");
    expect(sweep.windowOpen).toBe(true);
    // The batch STARTED (gate clear) — its single e-mail was dispatched and
    // the batch then honestly settled to its terminal status:
    expect(tBatches()[0].started_at).toBeTruthy();
    expect(tBatches()[0].status).toBe("completed");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// End-of-window rule: a batch scheduled for EXACTLY 10:30 starts on the
// 10:30 tick; NOTHING starts at 10:31 or later.
// ---------------------------------------------------------------------------

describe("end-of-window (10:30 boundary)", () => {
  it("10:30:30 Berlin (last minute of the window): a batch scheduled for exactly 10:30 STARTS", async () => {
    seed([{ id: "h1", name: "Held GmbH", email: "jobs@held.de", job: "Ausbildung H" }]);
    vi.useFakeTimers();
    (db.tables.auto_bewerb_batches as Record<string, unknown>[]).push(batchDueAt1030());
    (db.tables.auto_bewerb_send_attempts as Record<string, unknown>[]).push(attemptOf1030("h1"));
    vi.setSystemTime(BERLIN["10:30:30"]);

    const sweep = await claimAndDispatchDueAutoBewerbAttempts(5, 45_000);

    expect(sweep.windowOpen).toBe(true); // 10:30 minute is still inside the window
    expect(rpcCalls).toContain("claim_startable_auto_bewerb_batches");
    expect(tBatches()[0].status).toBe("completed"); // started at 10:30 → drained + settled
    expect(tBatches()[0].started_at).toBe("2026-01-15T09:30:30.000Z"); // the 10:30 tick, not earlier
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("10:31:00 Berlin (window closed): the same due batch is NOT started — it stays queued for the next window", async () => {
    seed([{ id: "h1", name: "Held GmbH", email: "jobs@held.de", job: "Ausbildung H" }]);
    vi.useFakeTimers();
    (db.tables.auto_bewerb_batches as Record<string, unknown>[]).push(batchDueAt1030());
    (db.tables.auto_bewerb_send_attempts as Record<string, unknown>[]).push(attemptOf1030("h1"));
    vi.setSystemTime(BERLIN["10:31:00"]);

    const sweep = await claimAndDispatchDueAutoBewerbAttempts(5, 45_000);

    expect(sweep.windowOpen).toBe(false);
    expect(rpcCalls).not.toContain("claim_startable_auto_bewerb_batches");
    expect(tBatches()[0].status).toBe("scheduled"); // held in Supabase for the next window
    expect(tBatches()[0].started_at).toBeNull();
    expect(tAttempts()[0].status).toBe("queued");
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Page-load catch-up (processDueAutoBewerbAttemptsForUser)
// ---------------------------------------------------------------------------

describe("page-load catch-up + sending window", () => {
  it("window CLOSED: due scheduled batches stay held (no start, no send)", async () => {
    seed([{ id: "s1", name: "Soon GmbH", email: "jobs@soon.de", job: "Ausbildung S" }]);
    vi.useFakeTimers();
    vi.setSystemTime(BERLIN["11:00"]);
    const batchS = { id: "batch-s", user_id: USER, batch_no: 1, snapshot: { items: [], subject: "s", accountId: ACCT, accountEmail: "mail@example.de", attachCv: true, attachLetter: true, sharedDocs: [] }, account_id: ACCT, status: "scheduled", scheduled_at: "2026-01-15T08:00:00.000Z", started_at: null, completed_at: null, created_at: TS, updated_at: TS };
    (db.tables.auto_bewerb_batches as Record<string, unknown>[]).push(batchS);
    (db.tables.auto_bewerb_send_attempts as Record<string, unknown>[]).push(
      { id: "att-s1", company_id: "s1", user_id: USER, batch_id: "batch-s", idempotency_key: "ik-s1", recipient_email: "jobs@soon.de", subject: "s", payload: { html: "", text: "", attachments: [] }, status: "queued", scheduled_at: "2026-01-15T08:00:00.000Z", attempt_count: 0, next_attempt_at: null, provider_message_id: null, failure_code: null, failure_message: null, sent_at: null, created_at: TS, updated_at: TS },
    );

    const res = await processDueAutoBewerbAttemptsForUser(USER, 5);

    expect(res.windowOpen).toBe(false);
    expect(tBatches()[0].status).not.toBe("sending"); // held in the queue
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("window OPEN (next morning 07:31): the held batch starts and sends", async () => {
    seed([{ id: "s1", name: "Soon GmbH", email: "jobs@soon.de", job: "Ausbildung S" }]);
    vi.useFakeTimers();
    // The batch was held all night (status waiting, DUE since 06:00 Berlin):
    const batchS = { id: "batch-s", user_id: USER, batch_no: 1, snapshot: { items: [], subject: "s", accountId: ACCT, accountEmail: "mail@example.de", attachCv: true, attachLetter: true, sharedDocs: [] }, account_id: ACCT, status: "waiting", scheduled_at: "2026-01-15T05:00:00.000Z", started_at: null, completed_at: null, created_at: TS, updated_at: TS };
    (db.tables.auto_bewerb_batches as Record<string, unknown>[]).push(batchS);
    (db.tables.auto_bewerb_send_attempts as Record<string, unknown>[]).push(
      { id: "att-s1", company_id: "s1", user_id: USER, batch_id: "batch-s", idempotency_key: "ik-s1", recipient_email: "jobs@soon.de", subject: "s", payload: { html: "", text: "", attachments: [] }, status: "queued", scheduled_at: "2026-01-15T05:00:00.000Z", attempt_count: 0, next_attempt_at: null, provider_message_id: null, failure_code: null, failure_message: null, sent_at: null, created_at: TS, updated_at: TS },
    );
    vi.setSystemTime(BERLIN["07:31"]);

    await processDueAutoBewerbAttemptsForUser(USER, 5);

    // Window just opened → the held batch started + sent + settled:
    expect(tBatches()[0].started_at).toBeTruthy();
    expect(tBatches()[0].status).toBe("completed");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Workspace exposure (honest UI state)
// ---------------------------------------------------------------------------

describe("workspace.sendingWindow", () => {
  it("open at 08:00 Berlin (nextStartMs null), closed at 11:00 (nextStartMs = next 07:30 Berlin)", async () => {
    seed([{ id: "s1", name: "Soon GmbH", email: "jobs@soon.de", job: "Ausbildung S" }]);
    vi.useFakeTimers();
    vi.setSystemTime(BERLIN["08:00"]);
    const open = await getAutoBewerbWorkspace(USER);
    expect(open.sendingWindow?.open).toBe(true);
    expect(open.sendingWindow?.nextStartMs).toBeNull();
    expect(open.sendingWindow?.label).toBe("07:30–10:30 Europe/Berlin");

    vi.setSystemTime(BERLIN["11:00"]);
    const closed = await getAutoBewerbWorkspace(USER);
    expect(closed.sendingWindow?.open).toBe(false);
    // Next 07:30 Berlin = 2026-01-16 06:30 UTC (CET, UTC+1):
    expect(closed.sendingWindow?.nextStartMs).toBe(Date.UTC(2026, 0, 16, 6, 30, 0));
  });
});
