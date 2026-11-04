/**
 * AUTO BEWERB — ADMIN WINDOW BYPASS (engine behavior, REAL window logic).
 *
 * Runs the REAL sending-window module + the REAL trusted admin-membership
 * check (isUserAdmin → public.admins, service role) against a fake system
 * clock (winter 2026 — Berlin = UTC+1 — plus both 2026 DST transitions).
 *
 * Mandated scenarios:
 *   1. normal user at 05:00      — blocked (immediate held / schedule rejected)
 *   2. normal user at 07:29      — blocked
 *   3. normal user at 07:30      — allowed
 *   4. normal user at 10:29      — allowed (window is inclusive at minute level)
 *   5. normal user at 10:30/10:31 — the EXISTING rule is kept: the 10:30
 *                                    minute is still inside (inclusive end,
 *                                    documented in sending-window.ts);
 *                                    NOTHING is allowed at 10:31 or later
 *   6. admin at 02:00            — allowed (immediate starts + sends)
 *   7. admin at 14:00            — allowed (schedule + immediate)
 *   8. admin manual send outside the window — dispatched immediately
 *   9. normal user impersonating an admin  — rejected (no client flag exists;
 *                                          the ONLY source is public.admins,
 *                                          read service-role for the session
 *                                          user id; fails closed on read error)
 *   10. unauthenticated request  — rejected at the action layer
 *   11. admin quota/subscription/anti-abuse — still enforced (incomplete
 *                                          settings, missing CV, and the 3:30
 *                                          inter-batch gate all still apply)
 *   12. in-flight campaigns keep draining after the window closes
 *   13. admin scheduled campaigns are processed by the cron (GH Actions)
 *                                          OUTSIDE the window — and the legacy
 *                                          claim_startable RPC is never called
 *                                          while the window is closed
 *                                          (fail-closed on pre-gate databases)
 *
 * Plus: Europe/Berlin timezone + daylight-saving transition tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/email-providers", () => ({ createEmailProvider: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));

const { createAdminClient } = await import("@/lib/supabase/admin");
const { createEmailProvider } = await import("@/lib/email-providers");
const { getCurrentUserAndProfile } = await import("@/lib/auth");
const {
  claimAndDispatchDueAutoBewerbAttempts,
  createAutoBewerbBatch,
  getAutoBewerbWorkspace,
  prepareAutoBewerbSend,
  processDueAutoBewerbAttemptsForUser,
  startAdminBatchesOutsideWindow,
} = await import("@/lib/auto-bewerb/engine");
const { isUserAdmin } = await import("@/lib/billing/admin");
const { isSendingWindowOpen } = await import("@/lib/auto-bewerb/sending-window");
const { createBatchAction, sendCompaniesAction } = await import("@/app/auto-bewerb/actions");
const { createStudioDb } = await import("./helpers-studio");
const { cvEmpty } = await import("@/lib/templates/cv");
import type { StudioDb } from "./helpers-studio";

const USER = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const ACCT = "33333333-3333-4333-8333-333333333333"; // USER's account
const ACCT_A = "44444444-4444-4444-8444-444444444444"; // ADMIN's account
const TS = "2026-01-10T00:00:00.000Z";

/** Winter 2026 (CET, UTC+1) instants — Berlin wall clock − 1h = UTC. */
const W = {
  "02:00": Date.UTC(2026, 0, 15, 1, 0, 0),
  "05:00": Date.UTC(2026, 0, 15, 4, 0, 0),
  "07:29": Date.UTC(2026, 0, 15, 6, 29, 0),
  "07:30": Date.UTC(2026, 0, 15, 6, 30, 0),
  "10:29": Date.UTC(2026, 0, 15, 9, 29, 0),
  "10:45": Date.UTC(2026, 0, 15, 9, 45, 0),
  "14:00": Date.UTC(2026, 0, 15, 13, 0, 0),
};

let db: StudioDb;
const sendEmail = vi.fn();
const provider = { sendEmail };
const rpcCalls: string[] = [];

type TAttempt = { id: string; company_id: string; user_id: string; batch_id: string | null; status: string; scheduled_at: string | null; next_attempt_at: string | null };
type TBatch = { id: string; user_id: string; status: string; account_id: string; scheduled_at: string | null; started_at: string | null; snapshot: unknown };
const tAttempts = () => db.tables.auto_bewerb_send_attempts as unknown as TAttempt[];
const tBatches = () => db.tables.auto_bewerb_batches as unknown as TBatch[];

/** Faithful fakes for the Postgres RPCs (record every call). The
 *  claim_startable fake mirrors the NEW database rule (migration
 *  20261224000000): window open OR batch owner is a public.admins member. */
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
        const open = isSendingWindowOpen(Date.now());
        const adminIds = ((db.tables.admins as Record<string, unknown>[]) ?? []).map((a) => a.user_id as string);
        const due = tBatches()
          .filter((b) => (b.status === "scheduled" || b.status === "waiting") && (b.scheduled_at === null || b.scheduled_at <= nowIso))
          .filter((b) => open || adminIds.includes(b.user_id))
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

function companyRow(user: string, id: string, company: string, email: string, job: string, account: string) {
  return {
    id, user_id: user, company, company_key: company.toLowerCase(), slot_no: 1,
    ad_raw: "x".repeat(40), ad_extracted: extractFor(company, email, job), ad_analysis: null,
    profile_snapshot: null, status: "ready", recipient_email: null, email_subject: null, email_body: null,
    email_attach_cv: true, email_attach_letter: true, email_account_id: account, idempotency_key: null,
    approved: true, approved_at: TS, scheduled_at: null, schedule_timezone: null,
    sent_at: null, provider_message_id: null, last_failure_code: null, ad_confirmed_at: TS,
    cv_reviewed_at: null, letter_reviewed_at: null, created_at: TS, updated_at: TS,
  };
}

function docsFor(user: string, companyId: string, name: string) {
  return [
    { id: `cv-${companyId}`, user_id: user, company_id: companyId, doc_type: "cv", version: 1, content: cvEmpty(), created_at: TS, updated_at: TS },
    {
      id: `lt-${companyId}`, user_id: user, company_id: companyId, doc_type: "cover_letter", version: 1,
      content: { text: `Sehr geehrte Damen und Herren,\n\nhiermit bewerbe ich mich bei ${name}.\n\nMit freundlichen Grüßen`, tone: "professional" },
      created_at: TS, updated_at: TS,
    },
  ];
}

function batchRow(user: string, id: string, account: string, status: string, scheduledAt: string | null, startedAt: string | null) {
  return {
    id, user_id: user, batch_no: 1,
    snapshot: { items: [], subject: "s", accountId: account, accountEmail: "mail@example.de", attachCv: true, attachLetter: true, sharedDocs: [] },
    account_id: account, status, scheduled_at: scheduledAt, started_at: startedAt,
    completed_at: null, created_at: TS, updated_at: TS,
  };
}

function attemptRow(user: string, companyId: string, batchId: string, scheduledAt: string | null) {
  return {
    id: `att-${batchId}-${companyId}`, company_id: companyId, user_id: user, batch_id: batchId,
    idempotency_key: `ik-${batchId}-${companyId}`, recipient_email: "jobs@example.de", subject: "s",
    payload: { html: "", text: "", attachments: [] }, status: "queued", scheduled_at: scheduledAt,
    attempt_count: 0, next_attempt_at: null, provider_message_id: null, failure_code: null,
    failure_message: null, sent_at: null, created_at: TS, updated_at: TS,
  };
}

interface SeedOptions {
  /** Seed the ADMIN into public.admins (the ONLY way to become admin). */
  admin?: boolean;
  /** Seed the admin's e-mail account as INACTIVE (anti-abuse/quota test). */
  adminAccountInactive?: boolean;
  /** Omit the admin's CV document (document-completeness test). */
  adminMissingCv?: boolean;
}

/** Two isolated workspaces: USER (normal) + ADMIN (platform admin). */
function seed(opts: SeedOptions = {}) {
  const companies = [
    companyRow(USER, "n1", "Normal GmbH", "jobs@normal.de", "Ausbildung N", ACCT),
    companyRow(USER, "n2", "Norm Zwei GmbH", "jobs@normzwei.de", "Ausbildung N2", ACCT),
    companyRow(ADMIN, "a1", "AdminOne GmbH", "jobs@adminone.de", "Ausbildung A1", ACCT_A),
    companyRow(ADMIN, "a2", "AdminTwo GmbH", "jobs@admintwo.de", "Ausbildung A2", ACCT_A),
    companyRow(ADMIN, "a3", "AdminThree GmbH", "jobs@adminthree.de", "Ausbildung A3", ACCT_A),
  ];
  const docs = [
    ...docsFor(USER, "n1", "Normal GmbH"),
    ...docsFor(USER, "n2", "Norm Zwei GmbH"),
    ...docsFor(ADMIN, "a1", "AdminOne GmbH"),
    ...docsFor(ADMIN, "a2", "AdminTwo GmbH"),
    ...(opts.adminMissingCv ? [] : docsFor(ADMIN, "a3", "AdminThree GmbH")),
  ];
  db = createStudioDb({
    auto_bewerb_profiles: [],
    auto_bewerb_companies: companies,
    auto_bewerb_documents: docs,
    auto_bewerb_attachments: [],
    auto_bewerb_company_attachments: [],
    auto_bewerb_email_templates: [
      { user_id: USER, body: "Sehr geehrte Damen und Herren,\n\nanbei meine Bewerbungsunterlagen.\n\nMit freundlichen Grüßen", recipient: "", subject: "Bewerbung", account_id: ACCT, attach_cv: true, attach_letter: true },
      { user_id: ADMIN, body: "Sehr geehrte Damen und Herren,\n\nanbei meine Bewerbungsunterlagen.\n\nMit freundlichen Grüßen", recipient: "", subject: "Bewerbung", account_id: ACCT_A, attach_cv: true, attach_letter: true },
    ],
    auto_bewerb_send_attempts: [],
    auto_bewerb_batches: [],
    email_accounts: [
      { id: ACCT, user_id: USER, provider: "gmail", email: "mail@example.de", is_active: true, requires_reconnect: false },
      { id: ACCT_A, user_id: ADMIN, provider: "gmail", email: "admin@example.de", is_active: !opts.adminAccountInactive, requires_reconnect: false },
    ],
    activity_logs: [],
    profiles: [
      { id: USER, full_name: "Mustapha Drif", email: "mail@example.de", phone: "", street: "", postal_code: "", city: "", country: "Deutschland" },
      { id: ADMIN, full_name: "Admin Tester", email: "admin@example.de", phone: "", street: "", postal_code: "", city: "", country: "Deutschland" },
    ],
    admins: opts.admin ? [{ user_id: ADMIN, created_by: USER, created_at: TS }] : [],
  });
  (createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ providerMessageId: "msg-ok" });
  (createEmailProvider as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(provider);
  installRpc();
}

const scheduleFor = (day: number, hour: number, minute: number) => ({
  timeZone: "Europe/Berlin",
  year: 2026, month: 1, day, hour, minute,
});

afterEach(() => {
  vi.useRealTimers();
  rpcCalls.length = 0;
  vi.mocked(getCurrentUserAndProfile).mockReset();
});

// ---------------------------------------------------------------------------
// 1–5 — Normal user: the existing window is preserved EXACTLY.
// ---------------------------------------------------------------------------

describe("normal user — window preserved (07:30–10:30 Europe/Berlin)", () => {
  it("1. at 05:00 Berlin: immediate 'send now' is HELD (nothing sent); scheduling for 05:00 is rejected", async () => {
    seed({});
    vi.useFakeTimers();
    vi.setSystemTime(W["05:00"]);
    const res = await createAutoBewerbBatch(USER, { companyIds: ["n1"], schedule: null });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.windowDeferred).toBe(true);
    expect(tBatches()[0].status).toBe("waiting");
    expect(sendEmail).not.toHaveBeenCalled();

    const sched = await createAutoBewerbBatch(USER, { companyIds: ["n2"], schedule: scheduleFor(16, 5, 0) });
    expect(sched.ok).toBe(false);
    expect(sched.code).toBe("schedule_outside_window");
  });

  it("2. at 07:29 Berlin (one minute before open): scheduling for 07:29 is rejected", async () => {
    seed({});
    vi.useFakeTimers();
    vi.setSystemTime(W["07:29"]);
    const res = await createAutoBewerbBatch(USER, { companyIds: ["n1"], schedule: scheduleFor(16, 7, 29) });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("schedule_outside_window");
  });

  it("3. at 07:30 Berlin (window just opened): scheduling for 07:30 is allowed", async () => {
    seed({});
    vi.useFakeTimers();
    vi.setSystemTime(W["07:30"]);
    const res = await createAutoBewerbBatch(USER, { companyIds: ["n1"], schedule: scheduleFor(16, 7, 30) });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.status).toBe("scheduled");
    // 07:30 Berlin (CET) = 06:30 UTC:
    expect(res.scheduledAt).toBe("2026-01-16T06:30:00.000Z");
  });

  it("4. at 10:29 Berlin: scheduling for 10:29 is allowed", async () => {
    seed({});
    vi.useFakeTimers();
    vi.setSystemTime(W["10:29"]);
    const res = await createAutoBewerbBatch(USER, { companyIds: ["n1"], schedule: scheduleFor(16, 10, 29) });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.status).toBe("scheduled");
    expect(res.scheduledAt).toBe("2026-01-16T09:29:00.000Z");
  });

  it("5. 10:30 boundary — EXISTING inclusive rule preserved: 10:30 still allowed, 10:31 blocked", async () => {
    seed({});
    vi.useFakeTimers();
    vi.setSystemTime(W["10:29"]);
    // The 10:30 MINUTE is inside the window (documented, pre-existing rule):
    const at1030 = await createAutoBewerbBatch(USER, { companyIds: ["n1"], schedule: scheduleFor(16, 10, 30) });
    expect(at1030.ok, JSON.stringify(at1030)).toBe(true);
    // NOTHING may be scheduled for 10:31 or later:
    const at1031 = await createAutoBewerbBatch(USER, { companyIds: ["n2"], schedule: scheduleFor(16, 10, 31) });
    expect(at1031.ok).toBe(false);
    expect(at1031.code).toBe("schedule_outside_window");
  });
});

// ---------------------------------------------------------------------------
// 6–8 — Admin: full scheduling access (24/7).
// ---------------------------------------------------------------------------

describe("admin — full scheduling access", () => {
  it("6. at 02:00 Berlin: an admin's immediate campaign STARTS and SENDS (no hold)", async () => {
    seed({ admin: true });
    vi.useFakeTimers();
    vi.setSystemTime(W["02:00"]);
    expect(isSendingWindowOpen()).toBe(false); // sanity: window really closed
    const res = await createAutoBewerbBatch(ADMIN, { companyIds: ["a1"], schedule: null });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.windowDeferred).toBeUndefined();
    expect(res.status).toBe("completed"); // started + drained + settled inline
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("7. at 14:00 Berlin: an admin may SCHEDULE for an out-of-window time (14:00, and 02:00)", async () => {
    seed({ admin: true });
    vi.useFakeTimers();
    vi.setSystemTime(W["14:00"]);
    const afternoon = await createAutoBewerbBatch(ADMIN, { companyIds: ["a1"], schedule: scheduleFor(16, 14, 0) });
    expect(afternoon.ok, JSON.stringify(afternoon)).toBe(true);
    expect(afternoon.status).toBe("scheduled");
    expect(afternoon.scheduledAt).toBe("2026-01-16T13:00:00.000Z");

    const night = await createAutoBewerbBatch(ADMIN, { companyIds: ["a2"], schedule: scheduleFor(16, 2, 0) });
    expect(night.ok, JSON.stringify(night)).toBe(true);
    expect(night.scheduledAt).toBe("2026-01-16T01:00:00.000Z");
  });

  it("8. admin MANUAL (legacy single-company) send outside the window dispatches immediately — a normal user's identical send is HELD", async () => {
    seed({ admin: true });
    vi.useFakeTimers();
    vi.setSystemTime(W["05:00"]);

    const adminSend = await prepareAutoBewerbSend(ADMIN, { companyId: "a1", schedule: null });
    expect(adminSend.ok, JSON.stringify(adminSend)).toBe(true);
    expect(adminSend.dispatchStatus).toBe("sent");
    expect(adminSend.scheduledAt).toBeNull();

    const userSend = await prepareAutoBewerbSend(USER, { companyId: "n1", schedule: null });
    expect(userSend.ok, JSON.stringify(userSend)).toBe(true);
    expect(userSend.dispatchStatus).toBe("queued"); // held — never sent outside the window
    // Next window start = today 07:30 Berlin (CET) = 06:30 UTC:
    expect(userSend.scheduledAt).toBe("2026-01-15T06:30:00.000Z");
    // Exactly ONE e-mail left the building (the admin's):
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 9–10 — Security: trusted admin determination only.
// ---------------------------------------------------------------------------

describe("security — admin determination is server-side and trusted", () => {
  it("9a. the ONLY admin source is public.admins (service-role read of the session user id): normal=false, admin=true, malformed=false", async () => {
    seed({ admin: true });
    expect(await isUserAdmin(USER)).toBe(false);
    expect(await isUserAdmin(ADMIN)).toBe(true);
    expect(await isUserAdmin("definitely-not-a-uuid")).toBe(false);
    expect(await isUserAdmin("")).toBe(false);
  });

  it("9b. a normal user at 02:00 CANNOT bypass — there is no client-supplied admin flag in any engine input (immediate send stays held)", async () => {
    seed({ admin: true }); // the admins table EXISTS — the bypass is real…
    vi.useFakeTimers();
    vi.setSystemTime(W["02:00"]);
    // …but keyed to the session-derived user id. USER has no membership row:
    const res = await createAutoBewerbBatch(USER, { companyIds: ["n1"], schedule: null });
    expect(res.ok).toBe(true);
    expect(res.windowDeferred).toBe(true); // gated exactly like before
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("9c. fails CLOSED: when the admins table cannot be read, even a real admin loses the bypass (normal behavior applies)", async () => {
    seed({ admin: true });
    vi.useFakeTimers();
    vi.setSystemTime(W["02:00"]);
    db.failTables(["admins"]);
    expect(await isUserAdmin(ADMIN)).toBe(false); // read error → false
    const res = await createAutoBewerbBatch(ADMIN, { companyIds: ["a1"], schedule: null });
    expect(res.ok).toBe(true);
    expect(res.windowDeferred).toBe(true); // treated as a normal user
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("10. unauthenticated requests are rejected at the action layer (session, not payload)", async () => {
    seed({ admin: true });
    vi.useFakeTimers();
    vi.setSystemTime(W["02:00"]);
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({ user: null, profile: null } as never);
    const batch = await createBatchAction(["a1"], null, true);
    expect(batch.ok).toBe(false);
    expect((batch as { code?: string }).code).toBe("unauthorized");
    const sends = await sendCompaniesAction([]);
    expect(sends.ok).toBe(false);
    expect((sends as { code?: string }).code).toBe("unauthorized");
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 11 — The bypass lifts the TIME gate only: quotas/limits/validations keep
//      applying to administrators.
// ---------------------------------------------------------------------------

describe("admin restrictions that REMAIN enforced", () => {
  it("11a. admin with NO ACTIVE E-MAIL ACCOUNT is rejected (no_settings validation before any window logic)", async () => {
    seed({ admin: true, adminAccountInactive: true });
    vi.useFakeTimers();
    vi.setSystemTime(W["02:00"]);
    const res = await createAutoBewerbBatch(ADMIN, { companyIds: ["a1"], schedule: null });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("no_email_account");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("11b. admin with a MISSING CV document is rejected (document completeness, per-company isolation)", async () => {
    seed({ admin: true, adminMissingCv: true });
    vi.useFakeTimers();
    vi.setSystemTime(W["02:00"]);
    const res = await createAutoBewerbBatch(ADMIN, { companyIds: ["a3"], schedule: null });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("batch_not_ready");
    expect(res.errors?.some((e) => e.code === "missing_cv")).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("11c. the 3:30 inter-batch gate still applies to an admin (bypass ≠ unlimited): the second immediate batch waits", async () => {
    seed({ admin: true });
    vi.useFakeTimers();
    vi.setSystemTime(W["02:00"]);
    const first = await createAutoBewerbBatch(ADMIN, { companyIds: ["a1"], schedule: null });
    expect(first.ok).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);

    // Same sending account, < 3:30 after the first batch's start:
    const second = await createAutoBewerbBatch(ADMIN, { companyIds: ["a2"], schedule: null });
    expect(second.ok).toBe(true);
    expect(second.status).toBe("waiting"); // held by the inter-batch gate
    expect(second.windowDeferred).toBeUndefined(); // NOT a window deferral
    expect(sendEmail).toHaveBeenCalledTimes(1); // a2 not sent yet
  });
});

// ---------------------------------------------------------------------------
// 12 — In-flight campaigns keep processing after the window closes.
// ---------------------------------------------------------------------------

describe("safe batch boundary — in-flight campaigns drain after the window closes", () => {
  it("12. at 10:45 Berlin (closed): in-flight batches (normal AND admin) keep draining; due-not-started normal batches stay held", async () => {
    seed({ admin: true });
    vi.useFakeTimers();
    vi.setSystemTime(W["10:45"]);
    // Two in-flight batches (started while the window was open) + one due,
    // not-yet-started NORMAL batch (must stay held):
    (db.tables.auto_bewerb_batches as Record<string, unknown>[]).push(
      batchRow(USER, "b-inflight-n", ACCT, "sending", null, "2026-01-15T09:25:00.000Z"),
      batchRow(ADMIN, "b-inflight-a", ACCT_A, "sending", null, "2026-01-15T09:25:00.000Z"),
      batchRow(USER, "b-held", ACCT, "waiting", null, null),
    );
    (db.tables.auto_bewerb_send_attempts as Record<string, unknown>[]).push(
      attemptRow(USER, "n1", "b-inflight-n", "2026-01-15T09:25:00.000Z"),
      attemptRow(ADMIN, "a1", "b-inflight-a", "2026-01-15T09:25:00.000Z"),
      attemptRow(USER, "n2", "b-held", "2026-01-15T09:25:00.000Z"),
    );

    const sweep = await claimAndDispatchDueAutoBewerbAttempts(5, 45_000);
    expect(sweep.windowOpen).toBe(false);
    // Both in-flight attempts were dispatched (no interruption):
    expect(tAttempts().find((a) => a.id === "att-b-inflight-n-n1")!.status).toBe("sent");
    expect(tAttempts().find((a) => a.id === "att-b-inflight-a-a1")!.status).toBe("sent");
    expect(sendEmail).toHaveBeenCalledTimes(2);
    // The due-but-not-started NORMAL batch stayed held for the next window:
    expect(tBatches().find((b) => b.id === "b-held")!.status).toBe("waiting");
    expect(tAttempts().find((a) => a.id === "att-b-held-n2")!.status).toBe("queued");
    // And the legacy claim_startable RPC was NEVER called while closed
    // (fail-closed: pre-window-gate databases could never start normal
    // batches outside the window):
    expect(rpcCalls).not.toContain("claim_startable_auto_bewerb_batches");
  });
});

// ---------------------------------------------------------------------------
// 13 — GH Actions cron processes admin scheduled campaigns OUTSIDE the window.
// ---------------------------------------------------------------------------

describe("cron tick (GitHub Actions) + admin window bypass", () => {
  it("13a. window CLOSED (14:00): a due ADMIN batch starts + sends via the cron; a due NORMAL batch stays held", async () => {
    seed({ admin: true });
    vi.useFakeTimers();
    vi.setSystemTime(W["14:00"]);
    const due = "2026-01-15T12:55:00.000Z"; // both due 5 minutes ago
    (db.tables.auto_bewerb_batches as Record<string, unknown>[]).push(
      batchRow(ADMIN, "b-admin-due", ACCT_A, "scheduled", due, null),
      batchRow(USER, "b-user-due", ACCT, "waiting", due, null),
    );
    (db.tables.auto_bewerb_send_attempts as Record<string, unknown>[]).push(
      attemptRow(ADMIN, "a1", "b-admin-due", due),
      attemptRow(USER, "n1", "b-user-due", due),
    );

    const sweep = await claimAndDispatchDueAutoBewerbAttempts(5, 45_000);
    expect(sweep.windowOpen).toBe(false);

    // The admin campaign processed OUTSIDE the window (the 24/7 bypass):
    expect(tBatches().find((b) => b.id === "b-admin-due")!.status).toBe("completed");
    // Started on THIS tick (14:00 Berlin = 13:00Z), never earlier than due:
    expect(tBatches().find((b) => b.id === "b-admin-due")!.started_at).toBe("2026-01-15T13:00:00.000Z");
    expect(tAttempts().find((a) => a.id === "att-b-admin-due-a1")!.status).toBe("sent");
    // The normal campaign is untouched — held for the next window:
    expect(tBatches().find((b) => b.id === "b-user-due")!.status).toBe("waiting");
    expect(tBatches().find((b) => b.id === "b-user-due")!.started_at).toBeNull();
    expect(tAttempts().find((a) => a.id === "att-b-user-due-n1")!.status).toBe("queued");
    expect(sendEmail).toHaveBeenCalledTimes(1); // only the admin's e-mail
  });

  it("13b. window OPEN (08:00): behavior unchanged — the claim_startable RPC runs and admin + normal due batches both start", async () => {
    seed({ admin: true });
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 15, 7, 0, 0)); // 08:00 Berlin
    const due = "2026-01-15T06:55:00.000Z";
    (db.tables.auto_bewerb_batches as Record<string, unknown>[]).push(
      batchRow(ADMIN, "b-admin-open", ACCT_A, "waiting", due, null),
      batchRow(USER, "b-user-open", ACCT, "waiting", due, null),
    );
    (db.tables.auto_bewerb_send_attempts as Record<string, unknown>[]).push(
      attemptRow(ADMIN, "a1", "b-admin-open", due),
      attemptRow(USER, "n1", "b-user-open", due),
    );

    const sweep = await claimAndDispatchDueAutoBewerbAttempts(5, 45_000);
    expect(sweep.windowOpen).toBe(true);
    expect(rpcCalls).toContain("claim_startable_auto_bewerb_batches");
    expect(tBatches().find((b) => b.id === "b-admin-open")!.status).toBe("completed");
    expect(tBatches().find((b) => b.id === "b-user-open")!.status).toBe("completed");
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("13c. startAdminBatchesOutsideWindow claims ADMIN-owned batches only (direct mirror, fail-closed)", async () => {
    seed({ admin: true });
    vi.useFakeTimers();
    vi.setSystemTime(W["02:00"]);
    const due = "2026-01-15T00:55:00.000Z";
    (db.tables.auto_bewerb_batches as Record<string, unknown>[]).push(
      batchRow(ADMIN, "b-a", ACCT_A, "scheduled", due, null),
      batchRow(USER, "b-n", ACCT, "scheduled", due, null),
    );
    const started = await startAdminBatchesOutsideWindow(5);
    expect(started.map((b) => b.id)).toEqual(["b-a"]);
    expect(tBatches().find((b) => b.id === "b-a")!.status).toBe("sending");
    expect(tBatches().find((b) => b.id === "b-n")!.status).toBe("scheduled"); // untouched

    // No admins at all → nothing starts (empty table):
    seed({});
    const none = await startAdminBatchesOutsideWindow(5);
    expect(none).toEqual([]);
  });

  it("page-load catch-up: an ADMIN's due batch starts while the window is closed; a normal user's identical state stays held", async () => {
    seed({ admin: true });
    vi.useFakeTimers();
    vi.setSystemTime(W["14:00"]);
    const due = "2026-01-15T12:55:00.000Z"; // due 5 minutes ago (13:55 Berlin)
    (db.tables.auto_bewerb_batches as Record<string, unknown>[]).push(
      batchRow(ADMIN, "b-catchup-a", ACCT_A, "waiting", due, null),
      batchRow(USER, "b-catchup-n", ACCT, "waiting", due, null),
    );
    (db.tables.auto_bewerb_send_attempts as Record<string, unknown>[]).push(
      attemptRow(ADMIN, "a1", "b-catchup-a", due),
      attemptRow(USER, "n1", "b-catchup-n", due),
    );

    await processDueAutoBewerbAttemptsForUser(ADMIN, 5);
    expect(tBatches().find((b) => b.id === "b-catchup-a")!.status).toBe("completed");
    expect(sendEmail).toHaveBeenCalledTimes(1);

    // The same page visit for the NORMAL user changes nothing:
    await processDueAutoBewerbAttemptsForUser(USER, 5);
    expect(tBatches().find((b) => b.id === "b-catchup-n")!.status).toBe("waiting");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Workspace flag (display only) — honest UI state.
// ---------------------------------------------------------------------------

describe("workspace.isAdmin (display-only flag)", () => {
  it("true for a public.admins member, false for a normal user", async () => {
    seed({ admin: true });
    expect((await getAutoBewerbWorkspace(ADMIN)).isAdmin).toBe(true);
    expect((await getAutoBewerbWorkspace(USER)).isAdmin).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Timezone + daylight saving (Europe/Berlin) — the decision ALWAYS follows
// Berlin wall clock (IANA), never a fixed UTC offset.
// ---------------------------------------------------------------------------

describe("Europe/Berlin timezone + DST transitions", () => {
  it("the window opens at 07:30 Berlin in BOTH seasons (06:30Z winter / 05:30Z summer)", () => {
    // Winter (CET, UTC+1):
    expect(isSendingWindowOpen(Date.UTC(2026, 0, 15, 6, 29, 59))).toBe(false); // 07:29:59
    expect(isSendingWindowOpen(Date.UTC(2026, 0, 15, 6, 30, 0))).toBe(true); // 07:30:00
    // Summer (CEST, UTC+2) — one day AFTER the 2026-03-29 spring-forward:
    expect(isSendingWindowOpen(Date.UTC(2026, 2, 30, 5, 29, 59))).toBe(false); // 07:29:59
    expect(isSendingWindowOpen(Date.UTC(2026, 2, 30, 5, 30, 0))).toBe(true); // 07:30:00
    // Spring-forward DAY (2026-03-29): the window opens at 05:30Z (CEST):
    expect(isSendingWindowOpen(Date.UTC(2026, 2, 29, 5, 30, 0))).toBe(true);
    // Fall-back DAY (2026-10-25, transition 01:00Z): 05:30Z is 06:30 Berlin
    // (already CET) → still CLOSED; the window opens at 06:30Z:
    expect(isSendingWindowOpen(Date.UTC(2026, 9, 25, 5, 30, 0))).toBe(false);
    expect(isSendingWindowOpen(Date.UTC(2026, 9, 25, 6, 30, 0))).toBe(true);
  });

  it("an admin's Berlin 02:00 schedule resolves to the correct UTC instant in winter (01:00Z) and summer (00:00Z)", async () => {
    seed({ admin: true });
    // Winter: now 02:00 Berlin 15.01 (01:00Z) → schedule 16.01 02:00 Berlin:
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 15, 1, 0, 0));
    const winter = await createAutoBewerbBatch(ADMIN, {
      companyIds: ["a1"],
      schedule: { timeZone: "Europe/Berlin", year: 2026, month: 1, day: 16, hour: 2, minute: 0 },
    });
    expect(winter.ok, JSON.stringify(winter)).toBe(true);
    expect(winter.scheduledAt).toBe("2026-01-16T01:00:00.000Z");

    // Summer (CEST): now 02:00 Berlin 15.04 (00:00Z) → schedule 16.04 02:00 Berlin:
    seed({ admin: true });
    vi.setSystemTime(Date.UTC(2026, 3, 15, 0, 0, 0));
    const summer = await createAutoBewerbBatch(ADMIN, {
      companyIds: ["a1"],
      schedule: { timeZone: "Europe/Berlin", year: 2026, month: 4, day: 16, hour: 2, minute: 0 },
    });
    expect(summer.ok, JSON.stringify(summer)).toBe(true);
    expect(summer.scheduledAt).toBe("2026-04-16T00:00:00.000Z");
  });

  it("a NORMAL user's Berlin 02:00 schedule is rejected in BOTH seasons (the bypass never leaks)", async () => {
    seed({});
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 15, 1, 0, 0));
    const winter = await createAutoBewerbBatch(USER, {
      companyIds: ["n1"],
      schedule: { timeZone: "Europe/Berlin", year: 2026, month: 1, day: 16, hour: 2, minute: 0 },
    });
    expect(winter.code).toBe("schedule_outside_window");

    seed({});
    vi.setSystemTime(Date.UTC(2026, 3, 15, 0, 0, 0));
    const summer = await createAutoBewerbBatch(USER, {
      companyIds: ["n1"],
      schedule: { timeZone: "Europe/Berlin", year: 2026, month: 4, day: 16, hour: 2, minute: 0 },
    });
    expect(summer.code).toBe("schedule_outside_window");
  });
});
