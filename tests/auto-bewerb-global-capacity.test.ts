/**
 * AUTO BEWERB — GLOBAL 100-company capacity + automatic removal (ENGINE contract).
 *
 * Real engine, in-memory Supabase-style DB (tests/helpers-studio) with the
 * OPT-IN slot-unique enforcement enabled — the harness models the partial
 * unique index (user_id, slot_no) WHERE slot_no > 0 (the database arbiter
 * that keeps concurrent reservations at ≤ 100) and the
 * ab_companies_release_slot trigger (the idempotent release backstop).
 *
 * Required regression scenarios:
 *  (1)  exactly 100 companies can be reserved
 *  (2)  the 101st company is rejected (workflow_full)
 *  (3)  capacity is calculated globally across multiple batches
 *  (4)  a user with 70 reserved companies can reserve 30 more
 *  (5)  two concurrent reservation requests cannot exceed 100
 *  (6)  successful delivery immediately removes the company from the active list
 *  (7)  successful delivery releases exactly one reservation
 *  (8)  failed delivery preserves the company AND the reservation
 *  (9)  retry works without duplicate email delivery
 *  (10) partial batch success removes only the successfully sent companies
 *  (11) scheduled companies cannot be manually deleted while pending
 *  (12) cancelled scheduled applications release capacity safely (no leak,
 *       no double free — the company returns to normal active management)
 *  (13) historical records remain available after active-list removal
 *  (14) capacity is not released twice
 *  (15) different users cannot affect each other's reservations
 *  (16) the 5-second hard email pacing floor remains intact
 *  (17) the 6-second recommended pacing remains intact
 *  (18) the 3:30 batch start-time gate remains intact
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
  createAutoBewerbBatch,
  createAutoBewerbCompany,
  deleteAutoBewerbCompany,
  dispatchAutoBewerbAttempt,
  getAutoBewerbBatches,
  getAutoBewerbCapacity,
  getAutoBewerbSendHistory,
  listAutoBewerbCompanies,
  processDueAutoBewerbAttemptsForUser,
  startAutoBewerbBatchesForUser,
} = await import("@/lib/auto-bewerb/engine");
const {
  HARD_MIN_SEND_INTERVAL_MS,
  MAX_SEND_INTERVAL_MS,
  MIN_SEND_INTERVAL_MS,
  clampSendIntervalMs,
  sendIntervalMs,
} = await import("@/lib/email-rate-limit");
const { AUTO_BEWERB_COMPANY_LIMIT } = await import("@/lib/auto-bewerb/schema");
const { createStudioDb } = await import("./helpers-studio");
const { cvEmpty } = await import("@/lib/templates/cv");

const USER = "11111111-1111-4111-8111-111111111111";
const USER_B = "99999999-9999-4999-8999-999999999999";
const ACCT = "33333333-3333-4333-8333-333333333333";
const ACCT2 = "44444444-4444-4444-8444-444444444444";
const BUCKET = "application-attachments";
const TS = "2026-12-01T00:00:00.000Z";
const FUTURE = { timeZone: "Europe/Berlin", year: 2030, month: 6, day: 10, hour: 9, minute: 0 };
const AD_RAW = "Ausbildung als Mechatroniker (m/w/d) in Hamburg — Bewerbung per E-Mail bis 31.12.2026.";
const RESERVED_SET = ["draft", "ready", "scheduled", "sending", "failed"];

let db: StudioDb;
let seq = 0;

type TCompany = Record<string, unknown> & { id: string; status: string; slot_no: number };
const tCompanies = () => db.tables.auto_bewerb_companies as unknown as TCompany[];
const tBatches = () => db.tables.auto_bewerb_batches as Array<Record<string, unknown>>;
const tAttempts = () => db.tables.auto_bewerb_send_attempts as Array<Record<string, unknown>>;

function extractFor(company: string, email: string, job: string) {
  return {
    jobTitle: job,
    occupation: job,
    company,
    companyAddress: "",
    location: "Hamburg",
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
    applicationMethod: "E-Mail",
    contactPerson: "",
    applicationEmail: email,
    companyNotes: [],
    missingOrAmbiguous: [],
  };
}

function cvFor(company: string) {
  const cv = cvEmpty();
  cv.personal = { ...cv.personal, fullName: "Mustapha Drif" };
  cv.summary = `Maßgeschneiderte Zusammenfassung für ${company}.`;
  return cv;
}

const letterFor = (company: string) => ({
  text: `Sehr geehrte Damen und Herren,\n\nhiermit bewerbe ich mich bei ${company}.\n\nMit freundlichen Grüßen\nMustapha Drif`,
  tone: "professional" as const,
});

/** Seed a company row DIRECTLY (bypassing the create API) with a distinct
 *  reserved slot — the slot-unique index is enabled, so slots must be valid. */
function seedCompany(
  user: string,
  company: string,
  status: string = "ready",
  opts: { approved?: boolean; slot?: number } = {},
): TCompany {
  seq += 1;
  const id = `seed-${user.slice(0, 4)}-${seq}`;
  const slot = opts.slot ?? (status === "sent" || status === "cancelled" ? 0 : seq);
  const email = `jobs@seed-${company.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.de`;
  const row: TCompany = {
    id,
    user_id: user,
    company,
    company_key: company.toLowerCase(),
    slot_no: slot,
    ad_raw: AD_RAW,
    ad_extracted: extractFor(company, email, `Ausbildung ${company}`),
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
    approved: opts.approved ?? false,
    approved_at: (opts.approved ?? false) ? TS : null,
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
  tCompanies().push(row);
  // Sendable documents when approved (needed by the batch prepare step):
  if (opts.approved) {
    (db.tables.auto_bewerb_documents as Array<Record<string, unknown>>).push(
      { id: `cv-${id}`, user_id: user, company_id: id, doc_type: "cv", version: 1, content: cvFor(company), created_at: TS, updated_at: TS },
      { id: `lt-${id}`, user_id: user, company_id: id, doc_type: "cover_letter", version: 1, content: letterFor(company), created_at: TS, updated_at: TS },
    );
  }
  return row;
}

/** Count reserved (capacity-consuming) companies of a user — the persisted
 *  ground truth the engine must always agree with. */
const reservedCount = (user: string) =>
  tCompanies().filter((c) => c.user_id === user && RESERVED_SET.includes(c.status)).length;

/** Read the capacity through the HONEST result contract (a failed read is
 *  `ok: false`, never a fake zero) and unwrap the numbers. */
async function capacityOf(user: string): Promise<{ reserved: number; capacity: number; available: number }> {
  const res = await getAutoBewerbCapacity(user);
  expect(res.ok, `capacity for ${user.slice(0, 4)}… must be readable in this scenario`).toBe(true);
  return (res as { ok: true; capacity: { reserved: number; capacity: number; available: number } }).capacity;
}

/** Read the active list through the HONEST result contract (a failed read is
 *  `ok: false`, never a disguised empty list) and unwrap the rows. */
async function activeCompanies(user: string): Promise<Array<{ id: string }>> {
  const res = await listAutoBewerbCompanies(user);
  expect(res.ok, "the active list must be readable in this scenario").toBe(true);
  return (res as { ok: true; companies: Array<{ id: string }> }).companies;
}

const sendEmail = vi.fn();
const provider = { sendEmail };

function seedBase() {
  seq = 0;
  db = createStudioDb({
    auto_bewerb_profiles: [],
    auto_bewerb_companies: [],
    auto_bewerb_documents: [],
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
    email_accounts: [
      { id: ACCT, user_id: USER, provider: "gmail", email: "mail@example.de", is_active: true, requires_reconnect: false },
      { id: ACCT2, user_id: USER, provider: "outlook", email: "outlook@example.de", is_active: true, requires_reconnect: false },
    ],
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
  // THE capacity arbiter (migration 20261220000000) is modeled: slot grabs are
  // unique per user, and the release trigger fires on reserved → released.
  db.enableSlotUnique("auto_bewerb_companies");
  (createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
  db.seedObject(BUCKET, `${USER}/auto-bewerb/docs/att-1.pdf`, "%PDF-1.4 fake-library-document");
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ providerMessageId: "msg-ok" });
  (createEmailProvider as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(provider);
  db.setRpc((fn) => {
    switch (fn) {
      case "reserve_sender_slot":
        return { data: { reserved: true, wait_ms: 0 }, error: null };
      case "recover_stale_auto_bewerb_attempts":
        return { data: 0, error: null };
      case "recover_stale_auto_bewerb_batches":
        return { data: 0, error: null };
      default:
        // NO ab_user_capacity fake by default: the engine must fall back to
        // its persisted count query with identical semantics.
        return { data: null, error: null };
    }
  });
}

// ---------------------------------------------------------------------------
// Scenarios 1–5 — the global 100-company reservation (server-enforced)
// ---------------------------------------------------------------------------

describe("global 100-company capacity — reservation", () => {
  it("(1) a user can reserve exactly 100 companies (distinct slots 1..100)", async () => {
    seedBase();
    expect(AUTO_BEWERB_COMPANY_LIMIT).toBe(100);
    for (let i = 1; i <= 100; i += 1) {
      const res = await createAutoBewerbCompany(USER, {
        adRaw: AD_RAW,
        company: `Reserve ${i} GmbH`,
        extract: extractFor(`Reserve ${i} GmbH`, `jobs@reserve-${i}.de`, `Ausbildung ${i}`),
        analysis: null,
      });
      expect(res.ok, `company ${i} should reserve`);
    }
    expect(tCompanies()).toHaveLength(100);
    const slots = tCompanies().map((c) => c.slot_no).sort((a, b) => a - b);
    expect(slots).toEqual(Array.from({ length: 100 }, (_, i) => i + 1)); // one unit each
    const cap = await capacityOf(USER);
    expect(cap).toEqual({ reserved: 100, capacity: 100, available: 0 });
  });

  it("(2) the 101st company is rejected with a clear capacity error", async () => {
    seedBase();
    for (let i = 1; i <= 100; i += 1) {
      await createAutoBewerbCompany(USER, {
        adRaw: AD_RAW,
        company: `Reserve ${i} GmbH`,
        extract: extractFor(`Reserve ${i} GmbH`, `jobs@reserve-${i}.de`, `Ausbildung ${i}`),
        analysis: null,
      });
    }
    const overflow = await createAutoBewerbCompany(USER, {
      adRaw: AD_RAW,
      company: "Reserve 101 GmbH",
      extract: extractFor("Reserve 101 GmbH", "jobs@reserve-101.de", "Ausbildung 101"),
      analysis: null,
    });
    expect(overflow).toMatchObject({ ok: false, code: "workflow_full" });
    expect(overflow).not.toMatchObject({ ok: true });
    expect(tCompanies()).toHaveLength(100); // no 101st row exists
  });

  it("(3) capacity is calculated GLOBALLY across multiple coexisting batches", async () => {
    seedBase();
    // 30 reserved companies → two scheduled batches of 15 each.
    const batchIds: string[] = [];
    for (let i = 1; i <= 30; i += 1) seedCompany(USER, `Multi ${i} GmbH`, "ready", { approved: true });
    const first = await createAutoBewerbBatch(USER, {
      companyIds: tCompanies().slice(0, 15).map((c) => c.id),
      schedule: FUTURE,
    });
    const second = await createAutoBewerbBatch(USER, {
      companyIds: tCompanies().slice(15, 30).map((c) => c.id),
      schedule: FUTURE,
    });
    expect(first.ok && second.ok).toBe(true);
    batchIds.push(first.batchId!, second.batchId!);
    expect(tBatches()).toHaveLength(2); // two batches coexist
    // Global capacity = the union over ALL batches (scheduled companies still reserve).
    expect(await capacityOf(USER)).toEqual({ reserved: 30, capacity: 100, available: 70 });
    // Exactly 70 more companies may be reserved — the 71st is refused.
    let added = 0;
    for (let i = 1; i <= 71; i += 1) {
      const res = await createAutoBewerbCompany(USER, {
        adRaw: AD_RAW,
        company: `Extra ${i} GmbH`,
        extract: extractFor(`Extra ${i} GmbH`, `jobs@extra-${i}.de`, `Ausbildung ${i}`),
        analysis: null,
      });
      if (res.ok) added += 1;
      else break;
    }
    expect(added).toBe(70);
    expect(tCompanies()).toHaveLength(100);
    expect(await capacityOf(USER)).toEqual({ reserved: 100, capacity: 100, available: 0 });
    // The batches' own snapshots are untouched by the capacity math:
    const views = await getAutoBewerbBatches(USER);
    expect(views.map((v) => v.id)).toContain(batchIds[0]);
    expect(views.map((v) => v.id)).toContain(batchIds[1]);
  });

  it("(4) a user with 70 reserved companies can reserve exactly 30 more", async () => {
    seedBase();
    // 70 reserved across the FULL pipeline state set (all of them consume capacity):
    for (let i = 1; i <= 20; i += 1) seedCompany(USER, `Ready ${i} GmbH`, "ready");
    for (let i = 1; i <= 20; i += 1) seedCompany(USER, `Scheduled ${i} GmbH`, "scheduled");
    for (let i = 1; i <= 20; i += 1) seedCompany(USER, `Sending ${i} GmbH`, "sending");
    for (let i = 1; i <= 10; i += 1) seedCompany(USER, `Failed ${i} GmbH`, "failed");
    expect(reservedCount(USER)).toBe(70);
    expect(await capacityOf(USER)).toEqual({ reserved: 70, capacity: 100, available: 30 });
    let added = 0;
    for (let i = 1; i <= 31; i += 1) {
      const res = await createAutoBewerbCompany(USER, {
        adRaw: AD_RAW,
        company: `More ${i} GmbH`,
        extract: extractFor(`More ${i} GmbH`, `jobs@more-${i}.de`, `Ausbildung ${i}`),
        analysis: null,
      });
      if (res.ok) added += 1;
      else {
        expect(res).toMatchObject({ ok: false, code: "workflow_full" });
        break;
      }
    }
    expect(added).toBe(30);
    expect(await capacityOf(USER)).toEqual({ reserved: 100, capacity: 100, available: 0 });
  });

  it("(5) concurrent reservation requests cannot exceed 100 (unique slot arbiter)", async () => {
    seedBase();
    for (let i = 1; i <= 99; i += 1) seedCompany(USER, `Base ${i} GmbH`, "ready");
    expect(reservedCount(USER)).toBe(99);
    // Three simultaneous creates all compute the same free slot (100) — the
    // database arbiter (modeled unique index) lets exactly ONE through.
    const results = await Promise.all(
      ["A", "B", "C"].map((suffix) =>
        createAutoBewerbCompany(USER, {
          adRaw: AD_RAW,
          company: `Race ${suffix} GmbH`,
          extract: extractFor(`Race ${suffix} GmbH`, `jobs@race-${suffix.toLowerCase()}.de`, "Ausbildung Race"),
          analysis: null,
        }),
      ),
    );
    const okCount = results.filter((r) => r.ok).length;
    const fullCount = results.filter((r) => !r.ok && r.code === "workflow_full").length;
    expect(okCount).toBe(1);
    expect(fullCount).toBe(2);
    expect(reservedCount(USER)).toBe(100); // never 101
    expect(await capacityOf(USER)).toEqual({ reserved: 100, capacity: 100, available: 0 });
  });

  it("counters come from PERSISTED server data — the ROW COUNT is canonical; an RPC disagreement is logged, never served", async () => {
    seedBase();
    seedCompany(USER, "Persisted GmbH", "ready");
    // A drifted/incorrect RPC (55) must NOT be served over the persisted rows
    // (1) — the rows are exactly what the create path enforces. The
    // disagreement is reported server-side (safe diagnostic), not silent.
    db.setRpc((fn) => {
      if (fn === "ab_user_capacity") {
        return { data: [{ reserved: 55, capacity: 100, available: 45 }], error: null };
      }
      return { data: null, error: null };
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await getAutoBewerbCapacity(USER);
      expect(res).toEqual({ ok: true, source: "query", capacity: { reserved: 1, capacity: 100, available: 99 } });
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("rpc_query_disagreement"))).toBe(true);
      // … and when the ROW QUERY itself fails, the RPC is the honest
      // fallback (still persisted server data, source: "rpc"):
      db.failSelect("auto_bewerb_companies", "slot_no", "simulated transient outage");
      expect(await getAutoBewerbCapacity(USER)).toEqual({
        ok: true,
        source: "rpc",
        capacity: { reserved: 55, capacity: 100, available: 45 },
      });
      db.clearSelectFail();
      expect(await getAutoBewerbCapacity(USER)).toEqual({
        ok: true,
        source: "query",
        capacity: { reserved: 1, capacity: 100, available: 99 },
      });
    } finally {
      errSpy.mockRestore();
    }
    // Without the RPC (pre-migration) the persisted count query has the same semantics:
    db.setRpc(() => ({ data: null, error: null }));
    expect(await getAutoBewerbCapacity(USER)).toEqual({ ok: true, source: "query", capacity: { reserved: 1, capacity: 100, available: 99 } });
  });
});

// ---------------------------------------------------------------------------
// Scenarios 6–10 — automatic removal, release, failure + retry
// ---------------------------------------------------------------------------

describe("global capacity — automatic removal + release", () => {
  it("(6) successful delivery immediately removes the company from the active list", async () => {
    seedBase();
    const a = seedCompany(USER, "AutoRemove A GmbH", "ready", { approved: true });
    const b = seedCompany(USER, "AutoRemove B GmbH", "ready", { approved: true });
    expect((await activeCompanies(USER)).map((c) => c.id)).toEqual([a.id, b.id]);
    // Send ONLY company A (immediate batch of one — inline dispatch):
    const res = await createAutoBewerbBatch(USER, { companyIds: [a.id], schedule: null });
    expect(res.ok).toBe(true);
    // A is GONE from the active list, B remains — no reload, no batch finish:
    const active = (await activeCompanies(USER)).map((c) => c.id);
    expect(active).not.toContain(a.id);
    expect(active).toEqual([b.id]);
    // The row is preserved (history), only its status changed:
    expect(tCompanies().find((c) => c.id === a.id)?.status).toBe("sent");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("(7) successful delivery releases exactly ONE reservation", async () => {
    seedBase();
    const a = seedCompany(USER, "Release A GmbH", "ready", { approved: true });
    const b = seedCompany(USER, "Release B GmbH", "ready", { approved: true });
    expect(await capacityOf(USER)).toEqual({ reserved: 2, capacity: 100, available: 98 });
    const res = await createAutoBewerbBatch(USER, { companyIds: [a.id], schedule: null });
    expect(res.ok).toBe(true);
    // One unit freed — the other company still reserves its slot:
    expect(await capacityOf(USER)).toEqual({ reserved: 1, capacity: 100, available: 99 });
    expect(tCompanies().find((c) => c.id === a.id)?.slot_no).toBe(0); // token released
    expect(tCompanies().find((c) => c.id === b.id)?.slot_no).toBeGreaterThan(0); // untouched
    // The freed slot is immediately reusable:
    const again = await createAutoBewerbCompany(USER, {
      adRaw: AD_RAW,
      company: "Reused Slot GmbH",
      extract: extractFor("Reused Slot GmbH", "jobs@reused-slot.de", "Ausbildung Reuse"),
      analysis: null,
    });
    expect(again.ok).toBe(true);
    expect(await capacityOf(USER)).toEqual({ reserved: 2, capacity: 100, available: 98 });
  });

  it("(8) failed delivery preserves the company AND its reservation", async () => {
    seedBase();
    const a = seedCompany(USER, "KeepMe GmbH", "ready", { approved: true });
    const terminal = new Error("550 mailbox unavailable") as Error & { code?: string };
    terminal.code = "mailbox_unavailable"; // no `temporary` → terminal failure
    sendEmail.mockRejectedValueOnce(terminal);
    const res = await createAutoBewerbBatch(USER, { companyIds: [a.id], schedule: null });
    expect(res.ok).toBe(true);
    // Terminal failure: the company STAYS in the active list as retryable …
    const active = (await activeCompanies(USER)).map((c) => c.id);
    expect(active).toEqual([a.id]);
    expect(tCompanies().find((c) => c.id === a.id)?.status).toBe("failed");
    expect(tCompanies().find((c) => c.id === a.id)?.slot_no).toBeGreaterThan(0);
    // … and its reservation is NOT released:
    expect(await capacityOf(USER)).toEqual({ reserved: 1, capacity: 100, available: 99 });
  });

  it("(8b) a temporary (retryable) failure keeps company + reservation queued", async () => {
    seedBase();
    const a = seedCompany(USER, "Transient GmbH", "ready", { approved: true });
    const transient = new Error("429 rate limited") as Error & { temporary?: boolean; code?: string };
    transient.temporary = true;
    transient.code = "rate_limited";
    sendEmail.mockRejectedValueOnce(transient);
    const res = await createAutoBewerbBatch(USER, { companyIds: [a.id], schedule: null });
    expect(res.ok).toBe(true);
    const row = tCompanies().find((c) => c.id === a.id)!;
    expect(RESERVED_SET).toContain(row.status); // still reserved (sending or ready/failed)
    expect(row.slot_no).toBeGreaterThan(0);
    expect((await activeCompanies(USER)).map((c) => c.id)).toContain(a.id);
    expect(await capacityOf(USER)).toEqual({ reserved: 1, capacity: 100, available: 99 });
    // The attempt is re-queued (backoff) — the retry path below picks it up:
    const attempt = tAttempts().find((x) => x.company_id === a.id)!;
    expect(attempt.status).toBe("queued");
    expect(attempt.next_attempt_at).toBeTruthy();
  });

  it("(9) retry works WITHOUT duplicate email delivery (idempotent claim)", async () => {
    seedBase();
    const a = seedCompany(USER, "RetryMe GmbH", "ready", { approved: true });
    const transient = new Error("503") as Error & { temporary?: boolean; code?: string };
    transient.temporary = true;
    transient.code = "provider_503";
    sendEmail.mockRejectedValueOnce(transient); // first delivery attempt fails
    sendEmail.mockResolvedValue({ providerMessageId: "msg-retry" }); // retry succeeds
    const res = await createAutoBewerbBatch(USER, { companyIds: [a.id], schedule: null });
    expect(res.ok).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // Backoff elapsed → the due attempt is re-dispatched by the sweep:
    const attempt = tAttempts().find((x) => x.company_id === a.id)!;
    attempt.next_attempt_at = new Date(Date.now() - 1000).toISOString(); // simulate the retry time arriving
    await processDueAutoBewerbAttemptsForUser(USER, 5);
    expect(sendEmail).toHaveBeenCalledTimes(2); // exactly one MORE delivery — never a duplicate of the success
    expect(attempt.status).toBe("sent");
    expect(attempt.attempt_count).toBe(2);
    expect(tCompanies().find((c) => c.id === a.id)?.status).toBe("sent");
    // A second (stale) dispatch of the same attempt is a no-op:
    const stale = await dispatchAutoBewerbAttempt(attempt.id as string);
    expect(stale).toEqual({ ok: true, duplicate: true, status: "sent" });
    expect(sendEmail).toHaveBeenCalledTimes(2); // still exactly two
  });

  it("(10) partial batch success removes ONLY the successfully sent companies", async () => {
    seedBase();
    const okA = seedCompany(USER, "Partial A GmbH", "ready", { approved: true });
    const badB = seedCompany(USER, "Partial B GmbH", "ready", { approved: true });
    const okC = seedCompany(USER, "Partial C GmbH", "ready", { approved: true });
    const terminal = new Error("550") as Error & { code?: string };
    terminal.code = "mailbox_unavailable";
    sendEmail.mockImplementation(async ({ to }: { to: string }) => {
      if (to.includes("partial-b")) throw terminal;
      return { providerMessageId: `msg-${to}` };
    });
    const res = await createAutoBewerbBatch(USER, {
      companyIds: [okA.id, badB.id, okC.id],
      schedule: null,
    });
    expect(res.ok).toBe(true);
    // Exactly the two successes left the active list; the failure stayed:
    const active = (await activeCompanies(USER)).map((c) => c.id);
    expect(active).toEqual([badB.id]);
    expect(tCompanies().find((c) => c.id === badB.id)?.status).toBe("failed");
    // Capacity released exactly for the two successes:
    expect(await capacityOf(USER)).toEqual({ reserved: 1, capacity: 100, available: 99 });
    // The batch settled honestly as partially_failed:
    const views = await getAutoBewerbBatches(USER);
    expect(views[0].status).toBe("partially_failed");
    expect(views[0].sentCount).toBe(2);
    expect(views[0].failedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scenarios 11–14 — scheduled protection, cancel safety, history, idempotent release
// ---------------------------------------------------------------------------

describe("global capacity — scheduled protection + history integrity", () => {
  it("(11) scheduled companies cannot be manually deleted while pending", async () => {
    seedBase();
    const a = seedCompany(USER, "Protected A GmbH", "ready", { approved: true });
    const b = seedCompany(USER, "Protected B GmbH", "ready", { approved: true });
    const res = await createAutoBewerbBatch(USER, { companyIds: [a.id, b.id], schedule: FUTURE });
    expect(res.ok).toBe(true);
    // Both are now pending (scheduled) — deletion is refused, row + snapshot intact:
    const delA = await deleteAutoBewerbCompany(USER, a.id);
    expect(delA).toMatchObject({ ok: false, code: "scheduled_protected" });
    const delB = await deleteAutoBewerbCompany(USER, b.id);
    expect(delB).toMatchObject({ ok: false, code: "scheduled_protected" });
    expect(tCompanies().filter((c) => [a.id, b.id].includes(c.id))).toHaveLength(2);
    const batch = tBatches()[0];
    expect((batch.snapshot as { items: unknown[] }).items).toHaveLength(2); // snapshot preserved
    expect(tAttempts().filter((x) => x.status === "queued")).toHaveLength(2); // queue preserved
    expect(reservedCount(USER)).toBe(2); // still reserved
  });

  it("(12) cancelling a scheduled application releases capacity SAFELY (no leak, no double free)", async () => {
    seedBase();
    const a = seedCompany(USER, "CancelMe A GmbH", "ready", { approved: true });
    const b = seedCompany(USER, "CancelMe B GmbH", "ready", { approved: true });
    const res = await createAutoBewerbBatch(USER, { companyIds: [a.id, b.id], schedule: FUTURE });
    expect(res.ok).toBe(true);
    expect(await capacityOf(USER)).toEqual({ reserved: 2, capacity: 100, available: 98 });
    // Cancel the pending scheduled application:
    const cancel = await cancelAutoBewerbBatch(USER, res.batchId!);
    expect(cancel.ok).toBe(true);
    // The companies return to NORMAL active-list management (ready again, deletable) —
    // their capacity is held as ACTIVE companies (no leak, and no double free):
    expect(tCompanies().find((c) => c.id === a.id)?.status).toBe("ready");
    expect(tCompanies().find((c) => c.id === b.id)?.status).toBe("ready");
    expect(await capacityOf(USER)).toEqual({ reserved: 2, capacity: 100, available: 98 });
    // … and are now safely deletable, releasing exactly one unit each:
    expect((await deleteAutoBewerbCompany(USER, a.id)).ok).toBe(true);
    expect(await capacityOf(USER)).toEqual({ reserved: 1, capacity: 100, available: 99 });
    expect((await deleteAutoBewerbCompany(USER, b.id)).ok).toBe(true);
    expect(await capacityOf(USER)).toEqual({ reserved: 0, capacity: 100, available: 100 });
  });

  it("(13) historical records remain available after active-list removal", async () => {
    seedBase();
    const a = seedCompany(USER, "History GmbH", "ready", { approved: true });
    const res = await createAutoBewerbBatch(USER, { companyIds: [a.id], schedule: null });
    expect(res.ok).toBe(true);
    // Gone from the active list:
    expect((await activeCompanies(USER)).map((c) => c.id)).not.toContain(a.id);
    // The preserved record carries every required audit field:
    const history = await getAutoBewerbSendHistory(USER);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      companyId: a.id,
      company: "History GmbH",
      position: "Ausbildung History GmbH",
      recipient: "jobs@seed-history-gmbh.de",
      status: "sent",
      accountId: ACCT,
      accountEmail: "mail@example.de",
      batchId: res.batchId,
    });
    expect(history[0].sentAt).toBeTruthy();
    // The row itself was NEVER cascade-deleted:
    expect(tCompanies().find((c) => c.id === a.id)).toBeTruthy();
    expect(tCompanies().find((c) => c.id === a.id)?.status).toBe("sent");
    // The attempt (delivery result) + the batch record stay intact:
    expect(tAttempts().find((x) => x.company_id === a.id)?.status).toBe("sent");
    expect(tBatches().find((x) => x.id === res.batchId)).toBeTruthy();
  });

  it("(14) capacity is not released twice (idempotent release)", async () => {
    seedBase();
    const a = seedCompany(USER, "Once GmbH", "ready", { approved: true });
    const res = await createAutoBewerbBatch(USER, { companyIds: [a.id], schedule: null });
    expect(res.ok).toBe(true);
    expect(await capacityOf(USER)).toEqual({ reserved: 0, capacity: 100, available: 100 });
    const row = tCompanies().find((c) => c.id === a.id)!;
    expect(row.slot_no).toBe(0); // released exactly once
    // A STRAY second release into the same released state (the trigger fires on
    // reserved → released only; a repeated write to "sent" is a no-op):
    const harnessQuery = (table: string) =>
      (db.admin as unknown as {
        from: (t: string) => {
          update: (v: Record<string, unknown>) => { eq: (c: string, v: unknown) => Promise<unknown> };
        };
      }).from(table);
    await harnessQuery("auto_bewerb_companies").update({ status: "sent", last_failure_code: null }).eq("id", a.id);
    expect(row.slot_no).toBe(0); // unchanged — nothing to release a second time
    expect(await capacityOf(USER)).toEqual({ reserved: 0, capacity: 100, available: 100 });
    // A stale duplicate dispatch is likewise a no-op (no double send, no double free):
    const attempt = tAttempts().find((x) => x.company_id === a.id)!;
    const stale = await dispatchAutoBewerbAttempt(attempt.id as string);
    expect(stale).toEqual({ ok: true, duplicate: true, status: "sent" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(await capacityOf(USER)).toEqual({ reserved: 0, capacity: 100, available: 100 });
  });
});

// ---------------------------------------------------------------------------
// Scenario 15 — user isolation
// ---------------------------------------------------------------------------

describe("global capacity — user isolation", () => {
  it("(15) different users cannot affect each other's reservations", async () => {
    seedBase();
    // User A fills their own global limit (100 reserved):
    for (let i = 1; i <= 100; i += 1) seedCompany(USER, `Isolated A${i} GmbH`, "ready");
    expect(await capacityOf(USER)).toEqual({ reserved: 100, capacity: 100, available: 0 });
    // User B is completely unaffected:
    expect(await capacityOf(USER_B)).toEqual({ reserved: 0, capacity: 100, available: 100 });
    const bAdd = await createAutoBewerbCompany(USER_B, {
      adRaw: AD_RAW,
      company: "Isolated B GmbH",
      extract: extractFor("Isolated B GmbH", "jobs@iso-b.de", "Ausbildung B"),
      analysis: null,
    });
    expect(bAdd.ok).toBe(true);
    expect(await capacityOf(USER_B)).toEqual({ reserved: 1, capacity: 100, available: 99 });
    // … and A is still exactly at the cap (B's add changed nothing for A):
    expect(await capacityOf(USER)).toEqual({ reserved: 100, capacity: 100, available: 0 });
    const aOverflow = await createAutoBewerbCompany(USER, {
      adRaw: AD_RAW,
      company: "Isolated A-Overflow GmbH",
      extract: extractFor("Isolated A-Overflow GmbH", "jobs@iso-a-ov.de", "Ausbildung O"),
      analysis: null,
    });
    expect(aOverflow).toMatchObject({ ok: false, code: "workflow_full" });
  });
});

// ---------------------------------------------------------------------------
// Scenarios 16–18 — the existing timing rules remain UNCHANGED
// ---------------------------------------------------------------------------

describe("timing rules preserved (5s floor / 6s recommended / 3:30 gate)", () => {
  it("(16)+(17) 5s hard floor and 6s recommended pacing remain intact", async () => {
    seedBase();
    vi.useFakeTimers();
    try {
      // The constants the engine paces with:
      expect(HARD_MIN_SEND_INTERVAL_MS).toBe(5000);
      expect(MIN_SEND_INTERVAL_MS).toBe(6000);
      expect(MAX_SEND_INTERVAL_MS).toBe(6000);
      expect(sendIntervalMs()).toBe(6000);
      // The floor can never be lowered below 5s by configuration:
      expect(clampSendIntervalMs(1000)).toBe(5000);
      expect(clampSendIntervalMs(3000)).toBe(5000);
      // Faithful reserve_sender_slot semantics (same as the batch-engine fake):
      const INTERVAL = sendIntervalMs();
      const last: Record<string, number> = {};
      db.setRpc((fn, args) => {
        if (fn !== "reserve_sender_slot") return { data: null, error: null };
        const acct = String(args.target_account_id);
        const min = Math.max(5000, Number(args.min_interval_ms ?? INTERVAL));
        const now = Date.now();
        const prev = last[acct] ?? -Infinity;
        if (now - prev < min) return { data: { reserved: false, wait_ms: min - (now - prev) }, error: null };
        last[acct] = now;
        return { data: { reserved: true, wait_ms: 0 }, error: null };
      });
      const first = await db.admin.rpc("reserve_sender_slot", { target_account_id: ACCT, min_interval_ms: INTERVAL });
      expect(first.data).toMatchObject({ reserved: true, wait_ms: 0 });
      // 3 s later — inside the 6 s window: refused with a positive wait:
      vi.advanceTimersByTime(3000);
      const busy = await db.admin.rpc("reserve_sender_slot", { target_account_id: ACCT, min_interval_ms: INTERVAL });
      expect(busy.data).toMatchObject({ reserved: false });
      expect(Number((busy.data as { wait_ms: number }).wait_ms)).toBe(3000);
      // Pacing is PER ACCOUNT: a different account is unaffected:
      const other = await db.admin.rpc("reserve_sender_slot", { target_account_id: ACCT2, min_interval_ms: INTERVAL });
      expect(other.data).toMatchObject({ reserved: true });
      // After the full 6 s interval: allowed again:
      vi.advanceTimersByTime(6000);
      const again = await db.admin.rpc("reserve_sender_slot", { target_account_id: ACCT, min_interval_ms: INTERVAL });
      expect(again.data).toMatchObject({ reserved: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("(18) the 3:30 inter-batch start gate (from started_at) remains intact", async () => {
    seedBase();
    expect(AUTO_BEWERB_INTER_BATCH_DELAY_MS).toBe(3 * 60_000 + 30_000);
    const b1 = seedCompany(USER, "Gate 1 GmbH", "ready", { approved: true });
    const b2 = seedCompany(USER, "Gate 2 GmbH", "ready", { approved: true });
    // Batch 1 starts immediately (same sending account as batch 2). Its single
    // company is dispatched inline, so by return it is "sending" or already
    // settled "completed" — the gate only ever looks at its started_at:
    const first = await createAutoBewerbBatch(USER, { companyIds: [b1.id], schedule: null });
    expect(first.ok).toBe(true);
    expect(["sending", "completed"]).toContain(first.status);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // Batch 2 (same account) is gated: 3:30 have not elapsed since batch 1 STARTED:
    const second = await createAutoBewerbBatch(USER, { companyIds: [b2.id], schedule: null });
    expect(second.ok).toBe(true);
    expect(second.status).toBe("waiting");
    expect(tBatches().find((x) => x.id === second.batchId)?.started_at).toBeNull();
    // … and its attempts must NOT have fired yet:
    expect(sendEmail).toHaveBeenCalledTimes(1); // only batch 1's email
    // Fast-forward: batch 1 started 4 minutes ago (≥ 3:30) → batch 2 becomes eligible:
    const batch1 = tBatches().find((x) => x.id === first.batchId)!;
    batch1.started_at = new Date(Date.now() - 4 * 60_000).toISOString();
    const started = await startAutoBewerbBatchesForUser(USER, 5);
    expect(started.map((x) => x.id)).toContain(second.batchId!);
    expect(tBatches().find((x) => x.id === second.batchId)?.status).toBe("sending");
    // The completed batch does NOT need to have finished for the gate — only
    // started_at matters (batch 1 is already terminal; the gate used its START time).
  });
});
