/**
 * AUTO BEWERB — Step 7 multi-batch sending & scheduling (ENGINE contract).
 *
 * Real engine, in-memory Supabase-style DB (tests/helpers-studio). The
 * Postgres-only primitives (sender slot, batch/attempt claim RPCs, stale
 * recovery) are faked with FAITHFUL semantics:
 *   - `reserve_sender_slot`: per-account last-reservation timestamp,
 *     `GREATEST(min_interval_ms, 5000)` floor — one winner per window;
 *   - `claim_startable_auto_bewerb_batches`: due (scheduled/waiting + time)
 *     AND the 3:30 inter-batch gate per sending account, conditional flip;
 *   - `claim_due_auto_bewerb_attempts`: only QUEUED + due attempts of
 *     'sending' batches (or legacy batch-less rows), flipped to 'sending'
 *     BEFORE being returned (exclusive claim);
 *   - `recover_stale_*`: >15 min 'sending' → back to the queue.
 *
 * Covered (required scenarios): batch cap 10 / immediate send / scheduling /
 * persistence / multiple batches / 3:30 inter-batch / 5s account interval /
 * concurrent workers / multiple sessions / restart dedupe / partial failure
 * + retry / no-resend of successes / failed stay available / cancellation /
 * completed leave the selection / new batch after scheduling / attachment
 * retention / user isolation / unverified recipient rejection / correct
 * sending account.
 */
import { describe, expect, it, vi } from "vitest";
import type { StudioDb } from "./helpers-studio";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/email-providers", () => ({ createEmailProvider: vi.fn() }));
// The sending window is pinned OPEN for these engine tests so immediate-
// batch behavior never depends on the wall clock; the window GATE itself is
// covered by tests/auto-bewerb-sending-window-gate.test.ts (real logic + fake time).
vi.mock("@/lib/auto-bewerb/sending-window", () => ({
  isSendingWindowOpen: () => true,
  nextWindowStartMs: () => null,
  windowLabel: () => "07:30\u201310:30 Europe/Berlin",
  isCampaignTimeInWindow: () => true,
  AUTO_BEWERB_SENDING_WINDOW: { timeZone: "Europe/Berlin", startHour: 7, startMinute: 30, endHour: 10, endMinute: 30 },
}));

const { createAdminClient } = await import("@/lib/supabase/admin");
const { createEmailProvider } = await import("@/lib/email-providers");
const {
  AUTO_BEWERB_INTER_BATCH_DELAY_MS,
  cancelAutoBewerbBatch,
  claimAndDispatchDueAutoBewerbAttempts,
  createAutoBewerbBatch,
  dispatchAutoBewerbAttempt,
  getAutoBewerbBatches,
  getAutoBewerbSendStats,
  processDueAutoBewerbAttemptsForUser,
  startAutoBewerbBatchesForUser,
} = await import("@/lib/auto-bewerb/engine");
const { reserveSenderSlot, sendIntervalMs } = await import("@/lib/email-rate-limit");
const { createStudioDb } = await import("./helpers-studio");
const { cvEmpty } = await import("@/lib/templates/cv");

const USER = "11111111-1111-4111-8111-111111111111";
const USER_B = "99999999-9999-4999-8999-999999999999";
const ACCT = "33333333-3333-4333-8333-333333333333";
const ACCT2 = "44444444-4444-4444-8444-444444444444";
const BUCKET = "application-attachments";
const TS = "2026-12-01T00:00:00.000Z";
const FUTURE = { timeZone: "Europe/Berlin", year: 2030, month: 6, day: 10, hour: 9, minute: 0 };

let db: StudioDb;

/** Typed row views over the harness rows (the harness stores Record<string, unknown>). */
type TAttempt = {
  id: string;
  company_id: string;
  batch_id: string | null;
  status: string;
  scheduled_at: string | null;
  next_attempt_at: string | null;
  attempt_count: number;
  idempotency_key: string;
  recipient_email: string;
  payload: { html: string; text: string; attachments: Array<{ storagePath: string }> };
};
type TBatch = {
  id: string;
  batch_no: number;
  status: string;
  account_id: string;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  snapshot: {
    items: Array<{ companyId: string; company: string; position: string; recipientEmail: string }>;
    subject: string;
    accountEmail: string;
    attachCv: boolean;
  };
};
type TCompany = {
  id: string;
  status: string;
  approved: boolean;
  idempotency_key: string | null;
  scheduled_at: string | null;
  last_failure_code: string | null;
};
const tAttempts = () => db.tables.auto_bewerb_send_attempts as unknown as TAttempt[];
const tBatches = () => db.tables.auto_bewerb_batches as unknown as TBatch[];
const tCompanies = () => db.tables.auto_bewerb_companies as unknown as TCompany[];

const sendEmail = vi.fn();
const provider = { sendEmail };

/** The company id scheme of seed() — company #i of user u. */
const cid = (i: number, user: string = USER) => `${user.slice(0, 8)}-company-${i}`;
const idsOf = (n: number, user: string = USER) => Array.from({ length: n }, (_, i) => cid(i + 1, user));

function extractFor(company: string, email: string, job: string, deadline: string) {
  return {
    jobTitle: job,
    occupation: job,
    company,
    companyAddress: "",
    location: "",
    startDate: "",
    applicationDeadline: deadline,
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

function companyRow(id: string, company: string, email: string, job: string, approved: boolean, deadline = "") {
  return {
    id,
    user_id: USER,
    company,
    company_key: company.toLowerCase(),
    slot_no: 1,
    ad_raw: "x".repeat(40),
    ad_extracted: extractFor(company, email, job, deadline),
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

// ---------------------------------------------------------------------------
// Faithful fakes for the Postgres-only primitives
// ---------------------------------------------------------------------------

/** Mirror of claim_startable_auto_bewerb_batches: due + 3:30 gate + flip. */
function claimStartableBatches(database: StudioDb, limit = 5) {
  const nowIso = new Date().toISOString();
  const now = Date.now();
  const due = database.tables.auto_bewerb_batches
    .filter(
      (b) =>
        (b.status === "scheduled" || b.status === "waiting") &&
        (b.scheduled_at === null || b.scheduled_at === undefined || b.scheduled_at <= nowIso),
    )
    .sort((a, b) => String(a.scheduled_at ?? a.created_at).localeCompare(String(b.scheduled_at ?? b.created_at)));
  const started: Record<string, unknown>[] = [];
  for (const b of due.slice(0, limit)) {
    const lastStart = database.tables.auto_bewerb_batches
      .filter((x) => x.account_id === b.account_id && x.id !== b.id && x.started_at)
      .map((x) => Date.parse(x.started_at as string))
      .sort((x, y) => x - y)
      .at(-1);
    if (lastStart !== undefined && lastStart + AUTO_BEWERB_INTER_BATCH_DELAY_MS > now) {
      if (b.status === "scheduled") b.status = "waiting";
      continue;
    }
    b.status = "sending";
    b.started_at = nowIso;
    started.push(b);
  }
  return started;
}

/** Mirror of claim_due_auto_bewerb_attempts: exclusive, batch-gated. */
function claimDueAttempts(database: StudioDb, limit = 5) {
  const nowIso = new Date().toISOString();
  const due = database.tables.auto_bewerb_send_attempts.filter(
    (a) =>
      a.status === "queued" &&
      (a.scheduled_at === null || a.scheduled_at === undefined || a.scheduled_at <= nowIso) &&
      (a.next_attempt_at === null || a.next_attempt_at === undefined || a.next_attempt_at <= nowIso) &&
      (a.batch_id === null ||
        a.batch_id === undefined ||
        database.tables.auto_bewerb_batches.find((b) => b.id === a.batch_id)?.status === "sending"),
  );
  const picked = due.slice(0, limit);
  for (const r of picked) r.status = "sending"; // exclusive claim BEFORE return
  return picked;
}

function installDefaultRpc() {
  db.setRpc((fn, args) => {
    switch (fn) {
      case "reserve_sender_slot":
        return { data: { reserved: true, wait_ms: 0 }, error: null };
      case "recover_stale_auto_bewerb_attempts":
        return { data: 0, error: null };
      case "recover_stale_auto_bewerb_batches":
        return { data: 0, error: null };
      case "claim_startable_auto_bewerb_batches":
        return { data: claimStartableBatches(db, Number(args.p_limit ?? 5)), error: null };
      case "claim_due_auto_bewerb_attempts":
        return { data: claimDueAttempts(db, Number(args.p_limit ?? 5)), error: null };
      default:
        return { data: null, error: null };
    }
  });
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

interface SeedOpts {
  user?: string;
  count?: number;
  /** 1-based company indices with NO verified e-mail (recipient unresolved). */
  noEmail?: number[];
  /** 1-based company indices that are NOT approved. */
  unapproved?: number[];
  /** 1-based company indices with an ad deadline (yyyy-mm-dd). */
  deadline?: Record<number, string>;
  extraAccounts?: Array<{ id: string; email: string }>;
  settingsAccount?: string;
}

function seed(opts: SeedOpts = {}) {
  const user = opts.user ?? USER;
  const count = opts.count ?? 2;
  const noEmail = new Set(opts.noEmail ?? []);
  const unapproved = new Set(opts.unapproved ?? []);
  const companies: Record<string, unknown>[] = [];
  const documents: Record<string, unknown>[] = [];
  for (let i = 1; i <= count; i++) {
    const id = cid(i, user);
    const email = noEmail.has(i) ? "" : `jobs@firma-${i}.de`;
    const row = companyRow(id, `Firma ${i} GmbH`, email, `Ausbildung ${i}`, !unapproved.has(i), opts.deadline?.[i] ?? "");
    row.user_id = user;
    companies.push(row);
    if (!noEmail.has(i)) {
      documents.push(
        { id: `cv-${id}`, user_id: user, company_id: id, doc_type: "cv", version: 1, content: cvFor(`Firma ${i} GmbH`), created_at: TS, updated_at: TS },
        { id: `lt-${id}`, user_id: user, company_id: id, doc_type: "cover_letter", version: 1, content: letterFor(`Firma ${i} GmbH`), created_at: TS, updated_at: TS },
      );
    }
  }
  db = createStudioDb({
    auto_bewerb_profiles: [],
    auto_bewerb_companies: companies,
    auto_bewerb_documents: documents,
    auto_bewerb_attachments: [
      {
        id: "att-1",
        user_id: user,
        display_name: "Abiturzeugnis.pdf",
        doc_category: "school_certificate",
        mime_type: "application/pdf",
        size_bytes: 1024,
        storage_path: `${user}/auto-bewerb/docs/att-1.pdf`,
        file_hash: "h1",
        created_at: TS,
        updated_at: TS,
      },
    ],
    auto_bewerb_company_attachments: [],
    auto_bewerb_email_templates: [
      {
        user_id: user,
        body: "Sehr geehrte Damen und Herren,\n\nanbei meine Bewerbungsunterlagen.\n\nMit freundlichen Grüßen\nMustapha Drif",
        recipient: "",
        subject: "Bewerbung um einen Ausbildungsplatz",
        account_id: opts.settingsAccount ?? ACCT,
        attach_cv: true,
        attach_letter: true,
      },
    ],
    auto_bewerb_send_attempts: [],
    auto_bewerb_batches: [],
    email_accounts: [
      { id: ACCT, user_id: user, provider: "gmail", email: "mail@example.de", is_active: true, requires_reconnect: false },
      ...(opts.extraAccounts ?? []).map((a) => ({ id: a.id, user_id: user, provider: "outlook", email: a.email, is_active: true, requires_reconnect: false })),
    ],
    activity_logs: [],
    profiles: [
      {
        id: user,
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
  // The shared library document is referenced by storage path in every payload —
  // place its object in the in-memory store so delivery reads succeed.
  db.seedObject(BUCKET, `${user}/auto-bewerb/docs/att-1.pdf`, "%PDF-1.4 fake-library-document");
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ providerMessageId: "msg-ok" });
  (createEmailProvider as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(provider);
  installDefaultRpc();
}

// ---------------------------------------------------------------------------
// Creation & all-or-nothing pre-validation
// ---------------------------------------------------------------------------

describe("createAutoBewerbBatch — creation & pre-validation", () => {
  it("(1) creates a batch of exactly 10 companies (the cap) with an immutable snapshot", async () => {
    seed({ count: 10 });
    const res = await createAutoBewerbBatch(USER, { companyIds: idsOf(10), schedule: FUTURE });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.batchNo).toBe(1);
    expect(res.status).toBe("scheduled");
    const batch = tBatches()[0];
    expect(batch.snapshot.items).toHaveLength(10);
    expect(batch.snapshot.items[0]).toMatchObject({ company: "Firma 1 GmbH", recipientEmail: "jobs@firma-1.de", position: "Ausbildung 1" });
    expect(batch.snapshot.accountEmail).toBe("mail@example.de");
    expect(batch.snapshot.subject).toBe("Bewerbung um einen Ausbildungsplatz");
    expect(batch.snapshot.attachCv).toBe(true);
    // Every company claimed as scheduled; every attempt queued with the batch ref:
    for (const c of tCompanies()) expect(c.status).toBe("scheduled");
    const attempts = tAttempts();
    expect(attempts).toHaveLength(10);
    for (const a of attempts) {
      expect(a.batch_id).toBe(batch.id);
      expect(a.status).toBe("queued");
      expect(a.scheduled_at).toBeTruthy();
    }
    // Scheduling must NEVER send immediately:
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("(1) rejects a 101-company batch (batch_too_large) without side effects", async () => {
    seed({ count: 101 });
    const res = await createAutoBewerbBatch(USER, { companyIds: idsOf(101), schedule: FUTURE });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("batch_too_large");
    expect(db.tables.auto_bewerb_batches).toHaveLength(0);
    expect(db.tables.auto_bewerb_send_attempts).toHaveLength(0);
  });

  it("rejects an empty selection", async () => {
    seed();
    const res = await createAutoBewerbBatch(USER, { companyIds: [], schedule: null });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("empty_selection");
  });

  it("(19) all-or-nothing: ONE unverified recipient blocks the WHOLE batch", async () => {
    seed({ count: 3, noEmail: [2] });
    const res = await createAutoBewerbBatch(USER, { companyIds: idsOf(3), schedule: FUTURE });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("batch_not_ready");
    expect(res.errors?.[0]).toMatchObject({ companyId: cid(2), code: "invalid_recipient" });
    expect(db.tables.auto_bewerb_batches).toHaveLength(0);
    expect(db.tables.auto_bewerb_send_attempts).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("(19) an unapproved company is rejected with the exact gap", async () => {
    seed({ count: 2, unapproved: [1] });
    const res = await createAutoBewerbBatch(USER, { companyIds: idsOf(2), schedule: null });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("batch_not_ready");
    expect(res.errors?.[0]).toMatchObject({ companyId: cid(1), code: "not_approved" });
    expect(db.tables.auto_bewerb_batches).toHaveLength(0);
  });

  it("(3) a past schedule is rejected (server-side, never client state)", async () => {
    seed();
    const res = await createAutoBewerbBatch(USER, {
      companyIds: idsOf(1),
      schedule: { timeZone: "Europe/Berlin", year: 2020, month: 1, day: 1, hour: 9, minute: 0 },
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("invalid_schedule");
    expect(db.tables.auto_bewerb_batches).toHaveLength(0);
  });

  it("(3) a schedule after the ad deadline is rejected per company", async () => {
    seed({ count: 1, deadline: { 1: "2026-12-31" } });
    const res = await createAutoBewerbBatch(USER, { companyIds: idsOf(1), schedule: FUTURE }); // 2030 > 2026-12-31
    expect(res.ok).toBe(false);
    expect(res.code).toBe("batch_not_ready");
    expect(res.errors?.[0].code).toBe("schedule_after_deadline");
  });

  it("(20) freezes the CORRECT sending account (settings) into snapshot + dispatch", async () => {
    seed({ count: 1, extraAccounts: [{ id: ACCT2, email: "andere@example.de" }], settingsAccount: ACCT2 });
    const res = await createAutoBewerbBatch(USER, { companyIds: idsOf(1), schedule: null });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.status).toBe("completed");
    const batch = tBatches()[0];
    expect(batch.account_id).toBe(ACCT2);
    expect(batch.snapshot.accountEmail).toBe("andere@example.de");
    expect(createEmailProvider).toHaveBeenCalledWith(USER, ACCT2, expect.any(Array));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((sendEmail.mock.calls[0][0] as { to: string }).to).toBe("jobs@firma-1.de");
  });

  it("(4) persistence: a fresh session read finds batch + payloads + storage objects (no client state)", async () => {
    seed({ count: 2 });
    await createAutoBewerbBatch(USER, { companyIds: idsOf(2), schedule: FUTURE });
    // A brand-new device/session reads the PERSISTED state:
    const batches = await getAutoBewerbBatches(USER);
    expect(batches).toHaveLength(1);
    expect(batches[0].snapshot.items).toHaveLength(2);
    expect(batches[0].sentCount).toBe(0);
    expect(batches[0].pendingCount).toBe(2);
    // The full e-mail payload + attachment references are durable:
    const att = tAttempts()[0];
    expect(att.payload.html).toContain("Bewerbungsunterlagen");
    const paths = att.payload.attachments.map((x) => x.storagePath);
    expect(paths.some((p) => p.includes(`cv/${USER}/`))).toBe(true);
    expect(paths.some((p) => p.includes(`letter/${USER}/`))).toBe(true);
    expect(paths.some((p) => p.includes("att-1.pdf"))).toBe(true);
    // The storage objects themselves are still readable for delivery:
    for (const p of paths) {
      const { data } = (await db.admin.storage.from(BUCKET).download(p)) as { data: Blob | null };
      expect(data, `object ${p} must be readable`).toBeTruthy();
    }
  });

  it("(18) user isolation: another user cannot cancel or reuse the batch / companies", async () => {
    seed({ count: 2 });
    await createAutoBewerbBatch(USER, { companyIds: idsOf(2), schedule: FUTURE });
    const batchId = tBatches()[0].id;
    const cancel = await cancelAutoBewerbBatch(USER_B, batchId);
    expect(cancel.ok).toBe(false);
    expect(cancel.code).toBe("not_found");
    expect(db.tables.auto_bewerb_batches[0].status).toBe("scheduled"); // untouched
    // USER_B (own settings + account) cannot create a batch from USER's companies:
    db.tables.auto_bewerb_email_templates.push({
      user_id: USER_B,
      body: "Guten Tag,\n\nanbei meine Bewerbung.",
      recipient: "",
      subject: "Bewerbung",
      account_id: ACCT,
      attach_cv: true,
      attach_letter: true,
    });
    db.tables.email_accounts.push({ id: ACCT, user_id: USER_B, provider: "gmail", email: "mail@example.de", is_active: true, requires_reconnect: false });
    const res = await createAutoBewerbBatch(USER_B, { companyIds: idsOf(2), schedule: FUTURE });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("batch_not_ready");
    expect(res.errors?.every((e) => e.code === "not_found")).toBe(true);
    // And USER_B's queue view is empty (owner-scoped):
    expect(await getAutoBewerbBatches(USER_B)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Immediate sending — completion, idempotency, Smart Sending pacing
// ---------------------------------------------------------------------------

describe("immediate batches — sending, intervals, idempotency", () => {
  it("(2) immediate batch: every company sent EXACTLY once, batch completed", async () => {
    seed({ count: 3 });
    const res = await createAutoBewerbBatch(USER, { companyIds: idsOf(3), schedule: null });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.status).toBe("completed");
    expect(res.items?.every((i) => i.ok && i.dispatchStatus === "sent")).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(3);
    for (const c of tCompanies()) expect(c.status).toBe("sent");
    const keys = tAttempts().map((a) => a.idempotency_key);
    expect(new Set(keys).size).toBe(3); // one idempotency key per e-mail
  });

  it("(7) a busy sender slot re-queues WITHOUT consuming the retry budget", async () => {
    seed();
    await createAutoBewerbBatch(USER, { companyIds: idsOf(1), schedule: FUTURE });
    const attempt = tAttempts()[0];
    // The account slot is busy (the DB says "wait 50ms"):
    db.setRpc((fn) => (fn === "reserve_sender_slot" ? { data: { reserved: false, wait_ms: 50 }, error: null } : { data: null, error: null }));
    const out = await dispatchAutoBewerbAttempt(attempt.id, { slotBudgetMs: 120 });
    expect(out).toMatchObject({ ok: false, duplicate: false, status: "queued", failureCode: "sender_slot_busy" });
    expect(attempt.status).toBe("queued"); // stays queued — the next tick re-checks the slot
    expect(attempt.attempt_count).toBe(0); // budget untouched — a busy slot is not a failure
    expect(sendEmail).not.toHaveBeenCalled();
    // The CLAIMED path (cron): a busy slot puts the row back to "queued" with
    // a short backoff (next_attempt_at), still without touching the budget:
    attempt.status = "sending"; // what the claim RPC would have done
    const out2 = await dispatchAutoBewerbAttempt(attempt.id, { claimed: true, slotBudgetMs: 120 });
    expect(out2).toMatchObject({ ok: false, status: "queued", failureCode: "sender_slot_busy" });
    expect(attempt.status).toBe("queued");
    expect(attempt.attempt_count).toBe(0);
    expect(attempt.next_attempt_at).toBeTruthy(); // re-queued with a backoff
  });

  it("(7) reserveSenderSlot: the account interval (6s, 5s floor) is per account — not per batch/worker", async () => {
    seed();
    vi.useFakeTimers();
    try {
      const last: Record<string, number> = {};
      const INTERVAL = sendIntervalMs(); // the engine's configured 6000ms
      db.setRpc((fn, args) => {
        if (fn !== "reserve_sender_slot") return { data: null, error: null };
        const acct = String(args.target_account_id);
        const min = Math.max(5000, Number(args.min_interval_ms ?? INTERVAL)); // the Postgres 5000ms floor
        const now = Date.now();
        const prev = last[acct] ?? -Infinity;
        if (now - prev < min) return { data: { reserved: false, wait_ms: min - (now - prev) }, error: null };
        last[acct] = now;
        return { data: { reserved: true, wait_ms: 0 }, error: null };
      });
      const t0 = Date.now();
      const first = await reserveSenderSlot(db.admin, ACCT, 10_000);
      expect(first).toEqual({ reserved: true, waitMs: 0 });
      // 100ms later the SAME account is still inside the window:
      await vi.advanceTimersByTimeAsync(100);
      const busy = await db.admin.rpc("reserve_sender_slot", { target_account_id: ACCT, min_interval_ms: INTERVAL });
      expect(busy.data).toEqual({ reserved: false, wait_ms: 5900 });
      // A DIFFERENT account is unaffected (the limit is per sending account):
      const other = await db.admin.rpc("reserve_sender_slot", { target_account_id: ACCT2, min_interval_ms: INTERVAL });
      expect(other.data).toMatchObject({ reserved: true });
      // After the window elapses the same account reserves again — ≥6s after t0:
      await vi.advanceTimersByTimeAsync(5900);
      const second = await reserveSenderSlot(db.admin, ACCT, 10_000);
      expect(second).toEqual({ reserved: true, waitMs: 0 });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(6000);
      // The engine always asks the DB for the configured interval:
      const slotCalls = db.calls.filter((c) => c.table === "reserve_sender_slot");
      expect(slotCalls.length).toBeGreaterThan(0);
      expect(slotCalls.every((c) => (c.args[0] as { min_interval_ms: number }).min_interval_ms === 6000)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// The 3:30 inter-batch gate (server-side, per sending account)
// ---------------------------------------------------------------------------

describe("the 3:30 inter-batch gate", () => {
  it("(6) the same account's second batch cannot start before 3:30 after the first STARTED", async () => {
    seed({ count: 2 });
    const b1 = await createAutoBewerbBatch(USER, { companyIds: [cid(1)], schedule: null });
    expect(b1.ok).toBe(true);
    expect(b1.status).toBe("completed");
    const batch1 = tBatches()[0];
    expect(batch1.started_at).toBeTruthy();

    // Second batch, same account, immediately after:
    const b2 = await createAutoBewerbBatch(USER, { companyIds: [cid(2)], schedule: null });
    expect(b2.ok).toBe(true);
    expect(b2.status).toBe("waiting"); // GATED — not started
    const batch2 = tBatches()[1];
    expect(batch2.started_at).toBeNull();
    expect(tCompanies()[1].status).toBe("sending"); // claimed, but not sent
    expect(sendEmail).toHaveBeenCalledTimes(1); // only batch 1's company

    // 3:29 after the first start — still gated:
    batch1.started_at = new Date(Date.now() - (AUTO_BEWERB_INTER_BATCH_DELAY_MS - 1000)).toISOString();
    expect(await startAutoBewerbBatchesForUser(USER)).toHaveLength(0);
    expect(batch2.status).toBe("waiting");

    // 3:31 after — the catch-up start fires, then dispatch completes:
    batch1.started_at = new Date(Date.now() - (AUTO_BEWERB_INTER_BATCH_DELAY_MS + 1000)).toISOString();
    const started = await startAutoBewerbBatchesForUser(USER);
    expect(started.map((b) => b.id)).toEqual([batch2.id]);
    expect(batch2.status).toBe("sending");
    expect(batch2.started_at).toBeTruthy();
    const out = await processDueAutoBewerbAttemptsForUser(USER, 5);
    expect(out.results.map((r) => r.status)).toEqual(["sent"]);
    expect(batch2.status).toBe("completed");
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("(6) the gate is START-TIME based: batch 2 starts 3:30 after batch 1 STARTED while batch 1 is STILL sending (no completion required); batch 3 chains off batch 2's actual start", async () => {
    seed({ count: 3 });
    // Batch 1: scheduled, made due, started through the real engine gate —
    // and deliberately NEVER dispatched, so it stays "sending":
    await createAutoBewerbBatch(USER, { companyIds: [cid(1)], schedule: FUTURE });
    const past = new Date(Date.now() - 60_000).toISOString();
    tBatches()[0].scheduled_at = past;
    tAttempts()[0].scheduled_at = past;
    expect(await startAutoBewerbBatchesForUser(USER)).toHaveLength(1);
    expect(tBatches()[0].status).toBe("sending");
    expect(tBatches()[0].completed_at).toBeNull();

    // Batch 2 is created while batch 1 is still inside the 3:30 window AFTER
    // batch 1's START — gated, although batch 1 has not finished:
    const b2 = await createAutoBewerbBatch(USER, { companyIds: [cid(2)], schedule: null });
    expect(b2.ok).toBe(true);
    expect(b2.status).toBe("waiting");
    expect(tBatches()[0].status).toBe("sending"); // still sending — no completion event
    expect(sendEmail).not.toHaveBeenCalled();

    // 3:29 after batch 1's actual started_at — still blocked:
    tBatches()[0].started_at = new Date(Date.now() - (AUTO_BEWERB_INTER_BATCH_DELAY_MS - 1000)).toISOString();
    expect(await startAutoBewerbBatchesForUser(USER)).toHaveLength(0);
    expect(tBatches()[1].status).toBe("waiting");

    // 3:31 after batch 1's actual started_at — batch 2 STARTS while batch 1
    // is still "sending" (a completion event was neither recorded nor required):
    tBatches()[0].started_at = new Date(Date.now() - (AUTO_BEWERB_INTER_BATCH_DELAY_MS + 1000)).toISOString();
    const started2 = await startAutoBewerbBatchesForUser(USER);
    expect(started2.map((b) => b.id)).toEqual([tBatches()[1].id]);
    expect(tBatches()[1].status).toBe("sending");
    expect(tBatches()[1].completed_at).toBeNull();
    expect(tBatches()[0].status).toBe("sending");
    expect(tBatches()[0].completed_at).toBeNull();
    expect(sendEmail).not.toHaveBeenCalled(); // start ≠ dispatch

    // Batch 3 chains off BATCH 2's actual started_at (not batch 1's, and no
    // completion state is ever consulted):
    const b3 = await createAutoBewerbBatch(USER, { companyIds: [cid(3)], schedule: null });
    expect(b3.ok).toBe(true);
    expect(b3.status).toBe("waiting"); // fresh start of batch 2 → gated
    expect(tBatches()[2].started_at).toBeNull();

    // 3:29 after batch 2's start — blocked, even though batch 1's start is much older:
    tBatches()[1].started_at = new Date(Date.now() - (AUTO_BEWERB_INTER_BATCH_DELAY_MS - 1000)).toISOString();
    expect(await startAutoBewerbBatchesForUser(USER)).toHaveLength(0);
    expect(tBatches()[2].status).toBe("waiting");

    // 3:31 after batch 2's start — allowed, with batches 1 AND 2 still "sending":
    tBatches()[1].started_at = new Date(Date.now() - (AUTO_BEWERB_INTER_BATCH_DELAY_MS + 1000)).toISOString();
    const started3 = await startAutoBewerbBatchesForUser(USER);
    expect(started3.map((b) => b.id)).toEqual([tBatches()[2].id]);
    expect(tBatches()[2].status).toBe("sending");
    expect(tBatches()[2].started_at).toBeTruthy();
    for (const b of tBatches()) {
      expect(b.status).toBe("sending");
      expect(b.completed_at).toBeNull(); // no batch completed — starts were purely start-time based
    }
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("(6)+(8) cron tick: the claim RPCs start due batches and dispatch each attempt exactly once", async () => {
    seed({ count: 1 });
    await createAutoBewerbBatch(USER, { companyIds: idsOf(1), schedule: FUTURE });
    // The scheduled time has passed:
    const past = new Date(Date.now() - 60_000).toISOString();
    const batch = tBatches()[0];
    batch.scheduled_at = past;
    tAttempts()[0].scheduled_at = past;

    const tick1 = await claimAndDispatchDueAutoBewerbAttempts(5, 30_000);
    expect(tick1.claimed).toBe(1);
    expect(tick1.results.map((r) => r.status)).toEqual(["sent"]);
    expect(batch.status).toBe("completed");
    expect(sendEmail).toHaveBeenCalledTimes(1);

    // An overlapping tick / worker restart: nothing left to claim, no double send:
    const tick2 = await claimAndDispatchDueAutoBewerbAttempts(5, 30_000);
    expect(tick2.claimed).toBe(0);
    expect(tick2.results).toHaveLength(0);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Concurrency: workers, sessions, restarts
// ---------------------------------------------------------------------------

describe("concurrent dispatch — atomic claims, no duplicates", () => {
  /** Put a fresh scheduled batch into the "started" state (gate passed). */
  async function makeSending() {
    seed({ count: 1 });
    await createAutoBewerbBatch(USER, { companyIds: idsOf(1), schedule: FUTURE });
    const batch = tBatches()[0];
    batch.status = "sending";
    batch.started_at = new Date().toISOString();
    const attempt = tAttempts()[0];
    attempt.scheduled_at = null; // due now
    return { batch, attempt };
  }

  it("(8) two concurrent dispatchers of the SAME attempt: exactly one e-mail", async () => {
    const { attempt } = await makeSending();
    const [r1, r2] = await Promise.all([dispatchAutoBewerbAttempt(attempt.id), dispatchAutoBewerbAttempt(attempt.id)]);
    expect([r1.status, r2.status].sort()).toEqual(["sent", "skipped"]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(attempt.status).toBe("sent");
    expect(attempt.attempt_count).toBe(1); // counted exactly once
  });

  it("(9) two browser sessions (page-load catch-up) on the same due attempt: one e-mail", async () => {
    const { attempt } = await makeSending();
    const [a, b] = await Promise.all([processDueAutoBewerbAttemptsForUser(USER, 5), processDueAutoBewerbAttemptsForUser(USER, 5)]);
    const sent = a.results.filter((r) => r.status === "sent").length + b.results.filter((r) => r.status === "sent").length;
    expect(sent).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(attempt.status).toBe("sent");
  });

  it("(10) after a worker restart, a delivered attempt is never sent again", async () => {
    seed({ count: 1 });
    await createAutoBewerbBatch(USER, { companyIds: idsOf(1), schedule: null }); // sent inline
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const attempt = tAttempts()[0];
    expect(attempt.status).toBe("sent");
    // A restarted worker re-dispatches the same attempt id:
    const out = await dispatchAutoBewerbAttempt(attempt.id, { claimed: true });
    expect(out).toMatchObject({ ok: true, duplicate: true, status: "sent" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // The claim RPC can never return a sent row:
    const rows = await db.admin.rpc("claim_due_auto_bewerb_attempts", { p_limit: 5 });
    expect((rows.data as unknown[])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Partial failure, retry, retention, cancellation
// ---------------------------------------------------------------------------

describe("partial failure, retry, retention, cancellation", () => {
  it("(11)+(12) temporary failure: only the failed company retries; successes are never resent", async () => {
    seed({ count: 2 });
    const email1 = "jobs@firma-1.de";
    const email2 = "jobs@firma-2.de";
    let failNext = true;
    sendEmail.mockImplementation(async ({ to }: { to: string }) => {
      if (to === email2 && failNext) {
        failNext = false;
        const e = new Error("429") as Error & { temporary?: boolean; code?: string };
        e.temporary = true;
        e.code = "rate_limited";
        throw e;
      }
      return { providerMessageId: `msg-${to}` };
    });
    const res = await createAutoBewerbBatch(USER, { companyIds: idsOf(2), schedule: null });
    expect(res.ok).toBe(true);
    expect(res.items?.find((i) => i.companyId === cid(1))?.dispatchStatus).toBe("sent");
    expect(res.items?.find((i) => i.companyId === cid(2))?.dispatchStatus).toBe("queued");
    const batch = tBatches()[0];
    expect(batch.status).toBe("sending"); // not terminal: company 2 still queued
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const attempt2 = tAttempts().find((a) => a.recipient_email === email2)!;
    expect(attempt2.status).toBe("queued");
    expect(attempt2.next_attempt_at).toBeTruthy(); // exponential backoff
    expect(attempt2.attempt_count).toBe(1);

    // The backoff window elapses → the catch-up retries ONLY company 2:
    attempt2.next_attempt_at = new Date(Date.now() - 1000).toISOString();
    const out = await processDueAutoBewerbAttemptsForUser(USER, 5);
    expect(out.results).toHaveLength(1);
    expect(out.results[0].status).toBe("sent");
    expect(batch.status).toBe("completed");
    expect(sendEmail).toHaveBeenCalledTimes(3);
    const toEmails = sendEmail.mock.calls.map((c) => (c[0] as { to: string }).to);
    expect(toEmails.filter((x) => x === email1)).toHaveLength(1); // NOT resent
    expect(toEmails.filter((x) => x === email2)).toHaveLength(2);
  });

  it("(11)+(13) terminal failure: batch → partially_failed; the failed company stays available for a new batch", async () => {
    seed({ count: 2 });
    const email2 = "jobs@firma-2.de";
    sendEmail.mockImplementation(async ({ to }: { to: string }) => {
      if (to === email2) {
        const e = new Error("bad address") as Error & { code?: string };
        e.code = "invalid_address"; // no `temporary` → terminal
        throw e;
      }
      return { providerMessageId: "msg-ok" };
    });
    const res = await createAutoBewerbBatch(USER, { companyIds: idsOf(2), schedule: null });
    expect(res.status).toBe("partially_failed");
    const c1 = tCompanies()[0];
    const c2 = tCompanies()[1];
    expect(c1.status).toBe("sent");
    expect(c2.status).toBe("failed");
    expect(c2.last_failure_code).toBe("invalid_address");

    // The failed company can be re-batched (data retained, NEW idempotency key):
    sendEmail.mockResolvedValue({ providerMessageId: "msg-retry" });
    const retry = await createAutoBewerbBatch(USER, { companyIds: [c2.id], schedule: null });
    expect(retry.ok, JSON.stringify(retry)).toBe(true);
    expect(retry.batchNo).toBe(2);
    // The 3:30 gate applies to the retry batch too (batch 1 started recently):
    expect(retry.status).toBe("waiting");
    const attemptsBefore = tAttempts().filter((a) => a.company_id === c2.id);
    expect(attemptsBefore).toHaveLength(2);
    expect(new Set(attemptsBefore.map((a) => a.idempotency_key)).size).toBe(2); // never the same key
    // The gate window elapses → the catch-up starts the retry batch and sends:
    tBatches()[0].started_at = new Date(Date.now() - (AUTO_BEWERB_INTER_BATCH_DELAY_MS + 1000)).toISOString();
    const out = await processDueAutoBewerbAttemptsForUser(USER, 5);
    expect(out.results.map((r) => r.status)).toEqual(["sent"]);
    const batch2 = tBatches()[1];
    expect(batch2.status).toBe("completed");
    expect(attemptsBefore[1].status).toBe("sent");
    expect(c2.status).toBe("sent");
  });

  it("uncertain failures are NEVER auto-retried (maybe-delivered → terminal)", async () => {
    seed({ count: 1 });
    const e = new Error("timeout") as Error & { uncertain?: boolean; code?: string };
    e.uncertain = true;
    e.code = "smtp_timeout";
    sendEmail.mockRejectedValue(e);
    const res = await createAutoBewerbBatch(USER, { companyIds: idsOf(1), schedule: null });
    expect(res.status).toBe("failed");
    const attempt = tAttempts()[0];
    expect(attempt.status).toBe("failed");
    expect(attempt.next_attempt_at).toBeNull(); // no auto-retry
    expect(attempt.attempt_count).toBe(1);
    expect(tCompanies()[0].status).toBe("failed");
    // A later dispatch of the same attempt is skipped (no second e-mail):
    const out = await dispatchAutoBewerbAttempt(attempt.id, { claimed: true });
    expect(out.status).toBe("skipped");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("(14) cancelling a scheduled batch releases ONLY the queue reservations", async () => {
    seed({ count: 2 });
    await createAutoBewerbBatch(USER, { companyIds: idsOf(2), schedule: FUTURE });
    const batch = tBatches()[0];
    const docsBefore = db.tables.auto_bewerb_documents.length;
    const out = await cancelAutoBewerbBatch(USER, batch.id);
    expect(out.ok).toBe(true);
    expect(batch.status).toBe("cancelled"); // the audit record is retained
    expect(batch.completed_at).toBeTruthy();
    for (const a of tAttempts()) expect(a.status).toBe("cancelled");
    for (const c of tCompanies()) {
      expect(c.status).toBe("ready"); // the company is selectable again
      expect(c.idempotency_key).toBeNull();
      expect(c.scheduled_at).toBeNull();
    }
    expect(db.tables.auto_bewerb_documents).toHaveLength(docsBefore); // source documents intact
    expect(db.tables.auto_bewerb_companies).toHaveLength(2); // applications retained
    expect(sendEmail).not.toHaveBeenCalled();
    // (17) the frozen attachment objects survive the cancellation:
    const paths = tAttempts().flatMap((a) => a.payload.attachments.map((x) => x.storagePath));
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      const { data } = (await db.admin.storage.from(BUCKET).download(p)) as { data: Blob | null };
      expect(data, `object ${p} must survive cancellation`).toBeTruthy();
    }
    // A cancelled batch cannot be cancelled twice:
    const again = await cancelAutoBewerbBatch(USER, batch.id);
    expect(again.ok).toBe(false);
    expect(again.code).toBe("batch_not_cancellable");
  });

  it("(14) a batch that already started can no longer be cancelled", async () => {
    seed({ count: 1 });
    await createAutoBewerbBatch(USER, { companyIds: idsOf(1), schedule: FUTURE });
    const batch = tBatches()[0];
    batch.status = "sending";
    batch.started_at = new Date().toISOString();
    const out = await cancelAutoBewerbBatch(USER, batch.id);
    expect(out.ok).toBe(false);
    expect(out.code).toBe("batch_not_cancellable");
    expect(batch.status).toBe("sending");
  });

  it("(15) a completed batch's companies leave the selectable set (already_sent)", async () => {
    seed({ count: 1 });
    await createAutoBewerbBatch(USER, { companyIds: idsOf(1), schedule: null });
    const res = await createAutoBewerbBatch(USER, { companyIds: idsOf(1), schedule: null });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("batch_not_ready");
    expect(res.errors?.[0].code).toBe("already_sent");
  });

  it("(16) a new batch can be prepared right after scheduling the previous one", async () => {
    seed({ count: 2 });
    const s1 = await createAutoBewerbBatch(USER, { companyIds: [cid(1)], schedule: FUTURE });
    expect(s1.status).toBe("scheduled");
    const s2 = await createAutoBewerbBatch(USER, { companyIds: [cid(2)], schedule: null });
    expect(s2.ok).toBe(true);
    expect(s2.batchNo).toBe(2);
    expect(tBatches()[0].status).toBe("scheduled"); // untouched, waits for its time
    expect(tBatches()[1].status).toBe("completed"); // no started batch yet → gate open
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Statistics + queue views (real persisted data only)
// ---------------------------------------------------------------------------

describe("queue views & statistics", () => {
  it("the queue view exposes per-batch outcome counts (sent/failed/pending)", async () => {
    seed({ count: 3 });
    const email3 = "jobs@firma-3.de";
    sendEmail.mockImplementation(async ({ to }: { to: string }) => {
      if (to === email3) {
        const e = new Error("nope") as Error & { code?: string };
        e.code = "invalid_address";
        throw e;
      }
      return { providerMessageId: "msg-ok" };
    });
    await createAutoBewerbBatch(USER, { companyIds: idsOf(3), schedule: null });
    const views = await getAutoBewerbBatches(USER);
    expect(views).toHaveLength(1);
    expect(views[0].status).toBe("partially_failed");
    expect(views[0].sentCount).toBe(2);
    expect(views[0].failedCount).toBe(1);
    expect(views[0].pendingCount).toBe(0);
  });

  it("statistics are derived from persisted data only (never demo numbers)", async () => {
    seed({ count: 2 });
    const now = await createAutoBewerbBatch(USER, { companyIds: [cid(1)], schedule: null }); // sent today
    const fut = await createAutoBewerbBatch(USER, { companyIds: [cid(2)], schedule: FUTURE }); // scheduled
    expect(now.ok).toBe(true);
    expect(fut.ok).toBe(true);
    const stats = await getAutoBewerbSendStats(USER);
    expect(stats).toEqual({ sentToday: 1, scheduled: 1, processing: 0, totalToday: 2, failed: 0 });
    // Another user sees zeros (user-scoped):
    expect(await getAutoBewerbSendStats(USER_B)).toEqual({ sentToday: 0, scheduled: 0, processing: 0, totalToday: 0, failed: 0 });
  });
});
