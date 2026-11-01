/**
 * AUTO BEWERB — REGRESSION: stale RELEASED slots must never block capacity.
 *
 * Production incident (2026-11-01): a company already 'sent' still held
 * slot_no = 1. The counter (reserved statuses only) said 0/100, the
 * allocator picked slot 1, and the status-BLIND partial unique index
 * `(user_id, slot_no) WHERE slot_no > 0` rejected the insert — mapped by
 * the app to a fabricated "workflow full". The account could never add a
 * company again until the row was repaired by hand.
 *
 * This suite pins the permanent fix (migration
 * 20261222000000_auto_bewerb_slot_index_reserved_only.sql + the bounded
 * retry in createAutoBewerbCompany):
 *
 *  S1  a 'sent' row with stale slot_no = 1 does NOT block claiming slot 1
 *  S2  a 'cancelled' row with a stale positive slot does NOT block reuse
 *  S3  the migration's normalization semantics (released slot>0 → 0,
 *      reserved untouched, idempotent)
 *  S3b the SHIPPED migration SQL matches the app's reserved set exactly
 *      (drift guard — the SQL file is parsed, not re-described)
 *  S4  the trigger frees the slot when status becomes 'sent'
 *      (even when the app write does not set slot_no itself)
 *  S5  the trigger frees the slot when status becomes 'cancelled'
 *  S6  the trigger REPAIRS a stale released row on a later update
 *      (no status change in the update)
 *  S7  exactly 100 reserved companies can exist for one user
 *  S8  the 101st reserved company is rejected (hard limit preserved)
 *  S9  concurrent creates at the limit: one wins, the loser is honestly
 *      rejected; concurrent creates below the limit: the bounded retry
 *      resolves the race and BOTH succeed
 *  S10 the incident reproduction — 100 stale 'sent' rows poisoning ALL
 *      slots — never produces a false workflow_full
 *  S11 sent/cancelled history is preserved (rows kept, only slot freed)
 *  S12 batch / attempt / company relationships remain intact
 *
 * The in-memory harness (helpers-studio.ts) models the POST-migration index
 * predicate EXACTLY: (user_id, slot_no) WHERE slot_no > 0 AND status IN
 * ('draft','ready','scheduled','sending','failed'), plus the strengthened
 * BEFORE-UPDATE release trigger (NEW.status released ⇒ slot_no := 0,
 * independent of OLD.status). S3b additionally asserts the shipped SQL
 * still says the same thing as this mirror and as schema.ts.
 *
 * NOTE: this sandbox has no PostgreSQL server, so the SQL itself is
 * validated by S3b's content contract (name/predicate/status-list/trigger/
 * no-CONCURRENTLY) plus the predicate-faithful mirrors — the strongest
 * verification available without a live database.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StudioDb } from "./helpers-studio";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/email-providers", () => ({ createEmailProvider: vi.fn() }));
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
  approveAutoBewerbCompany,
  createAutoBewerbCompany,
  getAutoBewerbSendHistory,
  prepareAutoBewerbSend,
  saveAutoBewerbDocument,
} = await import("@/lib/auto-bewerb/engine");
const { AUTO_BEWERB_COMPANY_LIMIT, AUTO_BEWERB_RESERVED_STATUSES } = await import("@/lib/auto-bewerb/schema");
const { createStudioDb } = await import("./helpers-studio");
const { cvEmpty } = await import("@/lib/templates/cv");

const USER = "11111111-1111-4111-8111-111111111111";
const ACCT = "33333333-3333-4333-8333-333333333333";
const TS = "2026-12-01T00:00:00.000Z";
const AD_RAW = "Ausbildung als Anlagenmechaniker (m/w/d) in Hamburg — Bewerbung per E-Mail bis 31.12.2026.";
const RESERVED_SET: string[] = [...AUTO_BEWERB_RESERVED_STATUSES];

let db: StudioDb;
let seq = 0;
const sendEmail = vi.fn();
const provider = { sendEmail };

type TCompany = Record<string, unknown> & { id: string; user_id: string; status: string; slot_no: number };
type TAttempt = Record<string, unknown> & { id: string; company_id: string; batch_id: string | null; status: string; attempt_count: number };
type TBatch = Record<string, unknown> & { id: string; user_id: string; status: string; snapshot: { items: unknown[] } };
const tCompanies = () => db.tables.auto_bewerb_companies as unknown as TCompany[];
const tAttempts = () => db.tables.auto_bewerb_send_attempts as unknown as TAttempt[];
const tBatches = () => db.tables.auto_bewerb_batches as unknown as TBatch[];
const harnessQuery = (table: string) =>
  (db.admin as unknown as {
    from: (t: string) => {
      update: (v: Record<string, unknown>) => { eq: (c: string, v: unknown) => Promise<unknown> };
    };
  }).from(table);
const idOf = (company: string): string => {
  const row = tCompanies().find((c) => c.company === company);
  if (!row) throw new Error(`no seeded company "${company}"`);
  return row.id;
};
/** The migration's one-time normalization UPDATE, row-by-row (its exact
 *  WHERE clause: released status AND still-held slot). */
function applyMigrationNormalization() {
  for (const r of tCompanies()) {
    if ((r.status === "sent" || r.status === "cancelled") && r.slot_no > 0) r.slot_no = 0;
  }
}

function extractFor(company: string, email: string, job: string) {
  return {
    jobTitle: job, occupation: job, company, companyAddress: "", location: "Hamburg",
    startDate: "", applicationDeadline: "", requiredQualifications: [], preferredQualifications: [],
    technicalSkills: [], softSkills: [], languageRequirements: [], educationRequirement: "",
    responsibilities: [], requestedDocuments: [], applicationMethod: "E-Mail", contactPerson: "",
    applicationEmail: email, companyNotes: [], missingOrAmbiguous: [],
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

function installRpc() {
  db.setRpc((fn: string) => {
    switch (fn) {
      case "reserve_sender_slot":
        return { data: { reserved: true, wait_ms: 0 }, error: null };
      case "recover_stale_auto_bewerb_attempts":
        return { data: 0, error: null };
      case "recover_stale_auto_bewerb_batches":
        return { data: 0, error: null };
      case "claim_startable_auto_bewerb_batches":
        return { data: [], error: null };
      case "claim_due_auto_bewerb_attempts":
        return { data: [], error: null };
      default:
        return { data: null, error: null };
    }
  });
}

function seedBase(companies: Array<{ user?: string; company: string; status?: string; slot?: number; approved?: boolean }>) {
  seq += 1;
  const rows: TCompany[] = companies.map((c) => {
    const user = c.user ?? USER;
    seq += 1;
    const id = `seed-${user.slice(0, 4)}-${seq}`;
    const status = c.status ?? "ready";
    return {
      id, user_id: user, company: c.company, company_key: `key-${c.company.toLowerCase().replace(/\s+/g, "-")}`,
      slot_no: c.slot ?? (status === "sent" || status === "cancelled" ? 0 : seq),
      ad_raw: AD_RAW, ad_extracted: extractFor(c.company, `jobs@seed-${seq}.de`, `Ausbildung ${c.company}`),
      ad_analysis: null, profile_snapshot: null, status, recipient_email: null, email_subject: null,
      email_body: null, email_attach_cv: true, email_attach_letter: true, email_account_id: ACCT,
      idempotency_key: null, approved: c.approved ?? false, approved_at: (c.approved ?? false) ? TS : null,
      scheduled_at: null, schedule_timezone: null, sent_at: null, provider_message_id: null,
      last_failure_code: null, ad_confirmed_at: TS, cv_reviewed_at: null, letter_reviewed_at: null,
      created_at: TS, updated_at: TS,
    };
  });
  db = createStudioDb({
    auto_bewerb_profiles: [],
    auto_bewerb_companies: rows,
    auto_bewerb_documents: [],
    auto_bewerb_attachments: [],
    auto_bewerb_company_attachments: [],
    auto_bewerb_email_templates: [
      { user_id: USER, body: "Sehr geehrte Damen und Herren,\n\nanbei meine Bewerbungsunterlagen.\n\nMit freundlichen Grüßen\nMustapha Drif", recipient: "", subject: "Bewerbung", account_id: ACCT, attach_cv: true, attach_letter: true },
    ],
    auto_bewerb_send_attempts: [],
    auto_bewerb_batches: [],
    email_accounts: [
      { id: ACCT, user_id: USER, provider: "gmail", email: "mail@example.de", is_active: true, requires_reconnect: false },
    ],
    activity_logs: [],
    profiles: [],
  });
  db.enableSlotUnique("auto_bewerb_companies");
  (createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ providerMessageId: "msg-ok" });
  (createEmailProvider as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(provider);
  installRpc();
}

async function withDocs(cid: string, company: string) {
  const cv = await saveAutoBewerbDocument(USER, cid, "cv", cvFor(company));
  expect(cv.ok).toBe(true);
  const lt = await saveAutoBewerbDocument(USER, cid, "cover_letter", letterFor(company));
  expect(lt.ok).toBe(true);
}

const createCo = (company: string) =>
  createAutoBewerbCompany(USER, {
    adRaw: AD_RAW,
    company,
    extract: extractFor(company, `jobs@${company.toLowerCase().replace(/\s+/g, "")}.de`, "Ausbildung"),
  });

// ---------------------------------------------------------------------------

describe("S1 — stale 'sent' row never blocks slot reuse", () => {
  it("a 'sent' row with stale slot_no = 1 does not block a new company claiming slot 1", async () => {
    seedBase([{ company: "Stale Sent", status: "sent", slot: 1 }]);
    const res = await createCo("Neu Eins");
    expect(res.ok).toBe(true);
    const row = tCompanies().find((c) => c.company === "Neu Eins")!;
    expect(row.slot_no).toBe(1); // the poisoned slot is reusable
    // The stale row is left alone by the create path (the migration repairs it):
    expect(tCompanies().find((c) => c.company === "Stale Sent")!.slot_no).toBe(1);
  });
});

describe("S2 — stale 'cancelled' row never blocks slot reuse", () => {
  it("a 'cancelled' row with a stale positive slot does not block reuse", async () => {
    seedBase([
      { company: "Hold One", status: "ready", slot: 1 }, // genuinely reserved: occupies slot 1
      { company: "Stale Cancelled", status: "cancelled", slot: 2 },
    ]);
    const res = await createCo("Neu Zwei");
    expect(res.ok).toBe(true);
    // The allocator skips slot 1 (reserved) and takes the stale slot 2:
    expect(tCompanies().find((c) => c.company === "Neu Zwei")!.slot_no).toBe(2);
  });
});

describe("S3 — migration normalization semantics", () => {
  it("normalizes every released row with slot_no > 0 to 0; reserved rows untouched; idempotent", async () => {
    seedBase([
      { company: "A", status: "draft", slot: 1 },
      { company: "B", status: "failed", slot: 4 },
      { company: "C", status: "sent", slot: 3 }, // stale
      { company: "D", status: "cancelled", slot: 7 }, // stale
      { company: "E", status: "sent", slot: 0 }, // already clean
    ]);
    applyMigrationNormalization();
    expect(tCompanies().find((c) => c.company === "A")!.slot_no).toBe(1);
    expect(tCompanies().find((c) => c.company === "B")!.slot_no).toBe(4);
    expect(tCompanies().find((c) => c.company === "C")!.slot_no).toBe(0);
    expect(tCompanies().find((c) => c.company === "D")!.slot_no).toBe(0);
    expect(tCompanies().find((c) => c.company === "E")!.slot_no).toBe(0);
    const before = JSON.stringify(tCompanies());
    applyMigrationNormalization(); // re-run: zero rows affected
    expect(JSON.stringify(tCompanies())).toBe(before);
  });

  it("S3b — the shipped migration SQL matches the app's reserved set exactly (drift guard)", () => {
    // vitest is always run from the repository root. Strip `--` comments so
    // the assertions test the STATEMENTS, not the documentation:
    const raw = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20261222000000_auto_bewerb_slot_index_reserved_only.sql"),
      "utf8",
    );
    const sql = raw
      .split("\n")
      .map((l) => l.replace(/--.*$/, ""))
      .join("\n");
    // Same index name preserved (the app's insert-error classification matches on it):
    expect(sql).toMatch(/create unique index\s+auto_bewerb_companies_user_slot_unique/i);
    // The new predicate's status list is EXACTLY the app's reserved set:
    const idxBlock = sql.slice(sql.toLowerCase().indexOf("create unique index auto_bewerb_companies_user_slot_unique"));
    const m = idxBlock.match(/status in \(([^)]+)\)/i);
    expect(m).toBeTruthy();
    expect(m![1].replace(/['"\s]/g, "").split(",").sort()).toEqual([...RESERVED_SET].sort());
    // The normalization UPDATE targets ONLY released statuses:
    const upd = sql.match(/update public\.auto_bewerb_companies\s+set slot_no = 0\s+where status in \(([^)]+)\)/i);
    expect(upd).toBeTruthy();
    expect(upd![1].replace(/['"\s]/g, "").split(",").sort()).toEqual(["cancelled", "sent"]);
    // The trigger forces the release from NEW.status — never from OLD.status:
    const fnStart = sql.indexOf("create or replace function public.ab_companies_release_slot");
    const fn = sql.slice(fnStart, sql.indexOf("drop trigger", fnStart));
    const body = fn.slice(fn.indexOf("as $$") + 4, fn.indexOf("$$;"));
    expect(body).toMatch(/new\.status in \('sent','cancelled'\)/i);
    expect(body).toMatch(/new\.slot_no := 0;/i);
    expect(body).not.toMatch(/\bold\b/i);
    // Transactional migration — never CONCURRENTLY:
    expect(sql).not.toMatch(/concurrently/i);
  });
});

describe("S4/S5 — the strengthened release trigger", () => {
  it("S4 — frees the slot when status becomes 'sent' (the app write carries no slot_no)", async () => {
    seedBase([{ company: "S4 Co", status: "ready", slot: 5 }]);
    await harnessQuery("auto_bewerb_companies").update({ status: "sent" }).eq("id", idOf("S4 Co"));
    expect(tCompanies().find((c) => c.company === "S4 Co")!.slot_no).toBe(0);
  });

  it("S5 — frees the slot when status becomes 'cancelled'", async () => {
    seedBase([{ company: "S5 Co", status: "sending", slot: 6 }]);
    await harnessQuery("auto_bewerb_companies").update({ status: "cancelled" }).eq("id", idOf("S5 Co"));
    expect(tCompanies().find((c) => c.company === "S5 Co")!.slot_no).toBe(0);
  });
});

describe("S6 — stale released rows self-repair on a later update", () => {
  it("a 'sent' row with a stale positive slot repairs itself when any other column is updated", async () => {
    seedBase([{ company: "Stale Six", status: "sent", slot: 9 }]);
    // A harmless later update (no status change — e.g. a re-validated ad text):
    await harnessQuery("auto_bewerb_companies").update({ ad_raw: `${AD_RAW} (aktualisiert)` }).eq("id", idOf("Stale Six"));
    expect(tCompanies().find((c) => c.company === "Stale Six")!.slot_no).toBe(0);
  });
});

describe("S7 — the hard 100-company limit", () => {
  it("exactly 100 reserved companies can exist for one user", async () => {
    seedBase([]);
    for (let i = 1; i <= AUTO_BEWERB_COMPANY_LIMIT; i++) {
      const r = await createCo(`Cap ${String(i).padStart(3, "0")}`);
      expect(r.ok, `create #${i} should succeed`).toBe(true);
    }
    const reserved = tCompanies().filter((c) => c.user_id === USER && RESERVED_SET.includes(c.status));
    expect(reserved).toHaveLength(AUTO_BEWERB_COMPANY_LIMIT);
    expect(new Set(reserved.map((c) => c.slot_no)).size).toBe(AUTO_BEWERB_COMPANY_LIMIT);
  });

  it("S8 — the 101st reserved company is rejected with a truthful workflow_full", async () => {
    seedBase(Array.from({ length: AUTO_BEWERB_COMPANY_LIMIT }, (_, i) => ({ company: `Full ${i + 1}`, status: "ready", slot: i + 1 })));
    const r = await createCo("One Hundred One");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("workflow_full");
    expect(tCompanies().length).toBe(AUTO_BEWERB_COMPANY_LIMIT); // no 101st row exists
  });
});

describe("S9 — concurrent allocation", () => {
  it("at the limit: exactly one concurrent create wins slot 100, the loser is honestly rejected", async () => {
    seedBase(Array.from({ length: 99 }, (_, i) => ({ company: `Nine ${i + 1}`, status: "ready", slot: i + 1 })));
    const [a, b] = await Promise.all([createCo("Race A"), createCo("Race B")]);
    const oks = [a, b].filter((r) => r.ok);
    const fulls = [a, b].filter((r) => !r.ok && r.code === "workflow_full");
    expect(oks).toHaveLength(1);
    expect(fulls).toHaveLength(1); // the retry re-counts 100 reserved → truthful limit
    expect(tCompanies().filter((c) => RESERVED_SET.includes(c.status))).toHaveLength(100);
    expect(tCompanies().filter((c) => c.slot_no === 100)).toHaveLength(1); // no double claim
  });

  it("below the limit: the bounded retry resolves the race and BOTH creates succeed", async () => {
    seedBase(Array.from({ length: 98 }, (_, i) => ({ company: `NinetyEight ${i + 1}`, status: "ready", slot: i + 1 })));
    const [a, b] = await Promise.all([createCo("Race A"), createCo("Race B")]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true); // the loser retried, reloaded, took the next free slot
    const slots = tCompanies()
      .filter((c) => c.company === "Race A" || c.company === "Race B")
      .map((c) => c.slot_no)
      .sort((x, y) => x - y);
    expect(slots).toEqual([99, 100]);
  });
});

describe("S10 — the incident reproduction", () => {
  it("100 stale 'sent' rows poisoning ALL slots never produce a false workflow_full", async () => {
    seedBase(Array.from({ length: AUTO_BEWERB_COMPANY_LIMIT }, (_, i) => ({ company: `Poison ${i + 1}`, status: "sent", slot: i + 1 })));
    const r = await createCo("Free At Last");
    expect(r.ok).toBe(true); // the 2026-11-01 incident — now impossible
    expect(tCompanies().find((c) => c.company === "Free At Last")!.slot_no).toBe(1);
    // Capacity is honest: exactly 1 reserved row out of 100
    expect(tCompanies().filter((c) => RESERVED_SET.includes(c.status))).toHaveLength(1);
  });
});

describe("S11 — history preservation", () => {
  it("sent/cancelled rows are KEPT after normalization (only the slot is freed); the new send lands in history", async () => {
    seedBase([
      { company: "Hist Sent", status: "sent", slot: 1 },
      { company: "Hist Cancelled", status: "cancelled", slot: 2 },
      { company: "Hist Live", status: "draft", slot: 3 },
    ]);
    const cid = idOf("Hist Live");
    const approved = await approveAutoBewerbCompany(USER, cid);
    expect(approved.ok).toBe(true);
    await withDocs(cid, "Hist Live");
    const prep = await prepareAutoBewerbSend(USER, { companyId: cid });
    expect(prep.ok).toBe(true);
    expect(tCompanies().find((c) => c.id === cid)!.status).toBe("sent");

    applyMigrationNormalization(); // the one-time repair of the two stale rows

    const sent = tCompanies().find((c) => c.company === "Hist Sent")!;
    const cancelled = tCompanies().find((c) => c.company === "Hist Cancelled")!;
    const live = tCompanies().find((c) => c.id === cid)!;
    expect(sent.status).toBe("sent");
    expect(sent.slot_no).toBe(0); // repaired — the row (and its history fields) intact
    expect(sent.company).toBe("Hist Sent");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.slot_no).toBe(0);
    expect(live.status).toBe("sent");
    expect(live.slot_no).toBe(0); // released by the normal dispatch path
    const hist = await getAutoBewerbSendHistory(USER);
    // The history keeps EVERY sent + cancelled record (2 seeded + 1 new):
    expect(hist).toHaveLength(3);
    expect(hist.some((h) => String((h as { company?: string }).company).includes("Hist Live"))).toBe(true);
    expect(tCompanies().length).toBe(3); // nothing deleted
  });
});

describe("S12 — relationship integrity", () => {
  it("batch / attempt / company relationships remain intact after normalization", async () => {
    seedBase([{ company: "Batch Co", status: "sent", slot: 1, approved: true }]);
    const cid = idOf("Batch Co");
    const batchId = "batch-1234";
    const attemptId = "attempt-1234";
    tBatches().push({
      id: batchId, user_id: USER, batch_no: 1,
      snapshot: { items: [{ companyId: cid, company: "Batch Co" }], subject: "Bewerbung", accountId: ACCT },
      account_id: ACCT, status: "completed", scheduled_at: null, started_at: TS, completed_at: TS,
      created_at: TS, updated_at: TS,
    } as TBatch);
    tAttempts().push({
      id: attemptId, user_id: USER, company_id: cid, batch_id: batchId,
      status: "sent", attempt_count: 1, scheduled_at: null, next_attempt_at: null,
      created_at: TS, updated_at: TS,
    } as TAttempt);

    applyMigrationNormalization();

    const b = tBatches().find((x) => x.id === batchId)!;
    const a = tAttempts().find((x) => x.id === attemptId)!;
    const c = tCompanies().find((x) => x.id === cid)!;
    expect(c.slot_no).toBe(0); // only the slot changed
    expect(c.status).toBe("sent");
    expect(a.batch_id).toBe(batchId); // attempts → batch intact
    expect(a.company_id).toBe(cid); // attempts → company intact
    expect(b.snapshot.items).toHaveLength(1); // batch snapshot intact
    // No orphaned references anywhere:
    for (const at of tAttempts()) {
      expect(tCompanies().some((x) => x.id === at.company_id)).toBe(true);
      if (at.batch_id) expect(tBatches().some((x) => x.id === at.batch_id)).toBe(true);
    }
  });
});
