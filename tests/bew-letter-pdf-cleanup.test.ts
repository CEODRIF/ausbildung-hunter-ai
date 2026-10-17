/**
 * Bewerbung Automation — post-send Anschreiben PDF CLEANUP regression suite.
 *
 * THE CONTRACT
 *   After the provider AUTHORITATIVELY confirms a send (2xx + message id →
 *   row "sent"), the application's generated Anschreiben PDF is deleted from
 *   the existing private bucket to stop unnecessary storage growth.
 *
 *   The PDF is NEVER deleted for:
 *     - queued apps (incl. transient-retry apps: the file is needed again),
 *     - failed / pdf_generation_failed / needs_attention (ambiguous provider
 *       outcome — the message MAY have gone out; the letter stays for review),
 *     - pending / excluded / cancelled apps.
 *
 *   The CV and every certificate are campaign documents and are NEVER removed
 *   by this cleanup. Application rows, send log, campaign history and the
 *   stored letter text (body_html) are preserved — only the generated object
 *   goes.
 *
 *   Idempotence & safety:
 *     - the delete target is the deterministic, owner-scoped path
 *       `${userId}/bew-anschreiben/${appId}.pdf` — never client input;
 *     - deleting a missing object is a logged no-op (repeated cleanup safe);
 *     - a failed delete is NON-FATAL: the row stays "sent", the quota stays
 *       consumed, the e-mail is never re-sent — and the post-drain sweep
 *       (which runs on EVERY drain exit) retries the delete safely.
 *
 * No real e-mail, no real Supabase. CV/certificate fixtures are real PDFs so
 * the send flow behaves exactly as in production.
 */
import { PDFDocument, StandardFonts } from "pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;
type TableKey =
  | "bew_campaigns"
  | "bew_applications"
  | "bew_documents"
  | "bew_campaign_documents"
  | "email_accounts"
  | "daily_usage"
  | "profiles";

interface StorageState {
  objects: Map<string, { bytes: Uint8Array; contentType: string }>;
  failUploads: boolean;
  /** Simulate a failing delete (transient storage outage). */
  failDeletes: boolean;
  lastBucket: string | null;
  uploadCount: number;
  removedPaths: string[];
}

interface DB {
  bew_campaigns: Row[];
  bew_applications: Row[];
  bew_documents: Row[];
  bew_campaign_documents: Row[];
  email_accounts: Row[];
  daily_usage: Row[];
  profiles: Row[];
  storage: StorageState;
  slotFree: boolean;
  aiRemaining: number;
  /** One script per sendEmail call: resolve with an id, or throw. */
  sendScripts: Array<{ id: string } | { error: unknown }>;
  /** Attachment file names at each createEmailProvider call. */
  providerAttachments: string[][];
  /** Messages that actually went "out the door". */
  sendLog: Array<{ to: string; subject: string; attachmentFiles: string[] }>;
}

const USER = "user-1";
const OTHER = "user-2";
const CAMPAIGN = "camp-1";
const TODAY = new Date().toISOString().slice(0, 10);

function freshDb(): DB {
  return {
    bew_campaigns: [],
    bew_applications: [],
    bew_documents: [],
    bew_campaign_documents: [],
    email_accounts: [
      { id: "acct-1", user_id: USER, email: "sender@gmail.com", is_active: true, requires_reconnect: false },
    ],
    daily_usage: [
      { user_id: USER, date: TODAY, emails_sent: 0, emails_reserved: 0, daily_limit: 50 },
    ],
    profiles: [{ id: USER, full_name: "Max Mustermann", email: "max@example.de" }],
    storage: {
      objects: new Map(),
      failUploads: false,
      failDeletes: false,
      lastBucket: null,
      uploadCount: 0,
      removedPaths: [],
    },
    slotFree: true,
    aiRemaining: 100,
    sendScripts: [],
    providerAttachments: [],
    sendLog: [],
  };
}

let db: DB;

function daily(userId: string): Row {
  let du = db.daily_usage.find((d) => d.user_id === userId);
  if (!du) {
    du = { user_id: userId, date: TODAY, emails_sent: 0, emails_reserved: 0, daily_limit: 50 };
    db.daily_usage.push(du);
  }
  return du;
}

function rpc(name: string, args: any): Promise<{ data: any; error: any }> {
  switch (name) {
    case "reserve_email_capacity": {
      const du = daily(args.target_user_id);
      const available = (du.daily_limit ?? 50) - du.emails_sent - du.emails_reserved;
      if (args.requested > available)
        return Promise.resolve({ data: null, error: { message: "daily_quota_exceeded" } });
      du.emails_reserved += args.requested;
      return Promise.resolve({ data: { date: du.date, remaining: available - args.requested }, error: null });
    }
    case "release_email_capacity": {
      const du = db.daily_usage.find(
        (d) => d.user_id === args.target_user_id && d.date === args.reservation_date,
      );
      if (du) du.emails_reserved = Math.max(du.emails_reserved - args.released, 0);
      return Promise.resolve({ data: null, error: null });
    }
    case "bew_record_email_sent": {
      const du = db.daily_usage.find(
        (d) => d.user_id === args.target_user_id && d.date === args.reservation_date,
      );
      if (du) {
        du.emails_reserved = Math.max(du.emails_reserved - 1, 0);
        du.emails_sent += 1;
      }
      return Promise.resolve({ data: null, error: null });
    }
    case "claim_next_bew_application": {
      const camp = db.bew_campaigns.find((c) => c.id === args.target_campaign_id);
      if (!camp || camp.status !== "sending") return Promise.resolve({ data: null, error: null });
      const now = Date.now();
      const cands = db.bew_applications
        .filter(
          (a) =>
            a.user_id === args.target_user_id &&
            a.campaign_id === args.target_campaign_id &&
            a.status === "queued" &&
            (a.next_attempt_at == null || Date.parse(a.next_attempt_at) <= now),
        )
        .sort((x, y) => x.seq - y.seq);
      const app = cands[0];
      if (!app) return Promise.resolve({ data: null, error: null });
      app.status = "sending";
      app.attempt_count = (app.attempt_count ?? 0) + 1;
      if (!camp.started_at) camp.started_at = new Date().toISOString();
      return Promise.resolve({ data: { ...app }, error: null });
    }
    default:
      return Promise.resolve({ data: null, error: { message: `unknown rpc ${name}` } });
  }
}

function makeFrom(table: TableKey) {
  const state = {
    op: "select" as string,
    payload: undefined as any,
    filters: [] as Array<{ col: string; val: any }>,
    inFilters: [] as Array<{ col: string; values: any[] }>,
    gteFilters: [] as Array<{ col: string; val: any }>,
    orderBy: [] as Array<{ col: string; ascending: boolean }>,
    limitN: undefined as number | undefined,
    selectOpts: undefined as any,
    terminal: undefined as "single" | "maybeSingle" | undefined,
  };

  function rows(): Row[] {
    let out = (db[table] ?? []).slice();
    for (const f of state.filters) out = out.filter((r) => r[f.col] === f.val);
    for (const f of state.inFilters) out = out.filter((r) => f.values.includes(r[f.col]));
    for (const f of state.gteFilters) out = out.filter((r) => (r[f.col] ?? "") >= f.val);
    if (state.orderBy.length) {
      out.sort((a, b) => {
        for (const o of state.orderBy) {
          const dir = o.ascending ? 1 : -1;
          if (a[o.col] < b[o.col]) return -1 * dir;
          if (a[o.col] > b[o.col]) return 1 * dir;
        }
        return 0;
      });
    }
    if (state.limitN != null) out = out.slice(0, state.limitN);
    return out;
  }

  async function run(): Promise<any> {
    if (state.op === "insert") {
      const items = Array.isArray(state.payload) ? state.payload : [state.payload];
      const inserted = items.map((r) => ({ ...r, id: r.id ?? `id-${Math.random()}` }));
      (db[table] ??= []).push(...inserted);
      if (state.terminal === "single") return { data: inserted[0], error: null };
      return { data: inserted, error: null };
    }
    if (state.op === "update") {
      const matched = rows();
      for (const m of matched) Object.assign(m, state.payload);
      if (state.terminal === "single") return { data: matched[0] ?? null, error: null };
      if (state.terminal === "maybeSingle") return { data: matched[0] ?? null, error: null };
      return { data: matched, error: null };
    }
    const matched = rows();
    if (state.selectOpts?.count)
      return { data: state.selectOpts.head ? null : matched, error: null, count: matched.length };
    if (state.terminal === "single") return { data: matched[0] ?? null, error: null };
    if (state.terminal === "maybeSingle") return { data: matched[0] ?? null, error: null };
    return { data: matched, error: null };
  }

  const chain: any = {
    eq(col: string, val: any) {
      state.filters.push({ col, val });
      return chain;
    },
    in(col: string, values: any[]) {
      state.inFilters.push({ col, values });
      return chain;
    },
    gte(col: string, val: any) {
      state.gteFilters.push({ col, val });
      return chain;
    },
    order(col: string, o?: { ascending?: boolean }) {
      state.orderBy.push({ col, ascending: o?.ascending ?? true });
      return chain;
    },
    limit(n: number) {
      state.limitN = n;
      return chain;
    },
    select(_cols?: string, opts?: any) {
      state.selectOpts = opts;
      return chain;
    },
    insert(payload: any) {
      state.op = "insert";
      state.payload = payload;
      return chain;
    },
    update(payload: any) {
      state.op = "update";
      state.payload = payload;
      return chain;
    },
    delete() {
      state.op = "delete";
      return chain;
    },
    single() {
      state.terminal = "single";
      return chain;
    },
    maybeSingle() {
      state.terminal = "maybeSingle";
      return chain;
    },
    then(onF?: any, onR?: any) {
      return run().then(onF, onR);
    },
  };
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => makeFrom(table as TableKey),
    rpc: (name: string, args: any) => rpc(name, args),
    storage: {
      from: (bucket: string) => {
        db.storage.lastBucket = bucket;
        return {
          upload: async (path: string, bytes: Uint8Array, opts?: { contentType?: string }) => {
            db.storage.uploadCount += 1;
            if (db.storage.failUploads)
              return { error: { message: "simulated upload outage" } };
            db.storage.objects.set(path, {
              bytes,
              contentType: opts?.contentType ?? "application/octet-stream",
            });
            return { error: null };
          },
          remove: async (paths: string[]) => {
            if (db.storage.failDeletes)
              return { error: { message: "simulated delete outage" } };
            for (const p of paths ?? []) {
              db.storage.removedPaths.push(p);
              db.storage.objects.delete(p);
            }
            return { error: null };
          },
          download: async (path: string) => {
            const obj = db.storage.objects.get(path);
            if (!obj) return { data: null, error: { message: "not found" } };
            return { data: new Blob([obj.bytes as any]), error: null };
          },
        };
      },
    },
  }),
}));
vi.mock("@/lib/email-campaigns", () => ({
  getUsageSnapshot: async (userId: string) => {
    const du = daily(userId);
    return {
      date: du.date,
      emails_sent: du.emails_sent,
      emails_reserved: du.emails_reserved,
      daily_limit: du.daily_limit,
      remaining: Math.max((du.daily_limit ?? 50) - du.emails_sent - du.emails_reserved, 0),
    };
  },
  reserveSenderSlot: async () => db.slotFree,
}));
vi.mock("@/lib/email-providers", () => ({
  createEmailProvider: async (
    _userId: string,
    _accountId: string,
    paths: Array<{ filename: string; storagePath: string }> = [],
  ) => {
    db.providerAttachments.push(paths.map((p) => p.filename));
    for (const p of paths) {
      if (!db.storage.objects.has(p.storagePath))
        throw Object.assign(new Error("attachment unavailable"), { code: "attachment_unavailable" });
    }
    return {
      sendEmail: async (input: any) => {
        const script = db.sendScripts.shift();
        if (!script) throw new Error("no provider script");
        if ("error" in script) throw script.error;
        db.sendLog.push({
          to: input.to,
          subject: input.subject,
          attachmentFiles: db.providerAttachments[db.providerAttachments.length - 1],
        });
        return { providerMessageId: script.id };
      },
    };
  },
}));
vi.mock("@/lib/application-drafts", () => ({
  sanitizeEmailHtml: (h: string) => h,
  htmlToText: (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
}));
vi.mock("@/lib/ai-provider", () => ({
  createAIProvider: () => ({
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    generateText: async (_messages: any) => "Generischer Text.",
  }),
}));
vi.mock("@/lib/ai-service", () => ({
  reserveAIUsage: async () => {
    if (db.aiRemaining <= 0) throw new Error("AI daily request limit reached.");
    db.aiRemaining -= 1;
  },
  storagePath: (userId: string, filename: string) => `${userId}/doc-${filename}`,
}));
vi.mock("mammoth", () => ({ default: { extractRawText: async () => ({ value: "docx" }) } }));
vi.mock("@/app/bewerbung-automation/actions", () => ({
  bewExcludeApplication: vi.fn(),
  bewRestoreApplication: vi.fn(),
  bewUpdateLetter: vi.fn(),
}));

const {
  cleanupRecentlyCompletedBewLetterPdfs,
  processBewSendBatch,
} = await import("@/lib/bewerbung-engine");
const { letterPdfStoragePath } = await import("@/lib/bew-letter-pdf");
const { buildGermanCvPdf } = await import("./fixtures/de-cv");

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function simplePdf(text: string): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const page = d.addPage([595.28, 841.89]);
  const f = await d.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 65, y: 800, size: 12, font: f });
  return d.save();
}

function letterHtml(company: string): string {
  return [
    "<p>Sehr geehrte Damen und Herren,</p>",
    `<p>Ich bewerbe mich bei der ${company} um den Ausbildungsplatz.</p>`,
    "<p>Mit freundlichen Grüßen</p>",
    "<p>Max Mustermann</p>",
  ].join("");
}

function seedCampaign(over: Partial<Row> = {}) {
  db.bew_campaigns.push({
    id: CAMPAIGN,
    user_id: USER,
    email_account_id: "acct-1",
    purpose: "ausbildung",
    status: "sending",
    requested_count: 2,
    valid_count: 2,
    total_count: 2,
    generated_count: 2,
    sent_count: 0,
    failed_count: 0,
    excluded_count: 0,
    usage_date: TODAY,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
    ...over,
  });
}

function seedApp(seq: number, over: Partial<Row> = {}) {
  const company = `Firma ${seq}`;
  db.bew_applications.push({
    id: `app-${seq}`,
    campaign_id: CAMPAIGN,
    user_id: USER,
    seq,
    company_name: company,
    contact_name: null,
    company_email: `jobs${seq}@firma${seq}.de`,
    company_address: null,
    subject: `Bewerbung um einen Ausbildungsplatz bei ${company}`,
    body_html: letterHtml(company),
    body_text: `Bewerbung ${company}`,
    status: "queued",
    error_code: null,
    error_message: null,
    attempt_count: 0,
    next_attempt_at: null,
    provider_message_id: null,
    sent_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  });
}

async function seedDocs() {
  const cvBytes = new Uint8Array(buildGermanCvPdf());
  const certBytes = await simplePdf("ZERTIFIKAT: Digital Marketing, ausgestellt 2025.");
  db.bew_documents.push(
    { id: "doc-cv", user_id: USER, storage_path: `${USER}/cv.pdf`, filename: "cv.pdf", mime_type: "application/pdf", size_bytes: cvBytes.length, kind: "cv" },
    { id: "doc-cert", user_id: USER, storage_path: `${USER}/cert.pdf`, filename: "cert.pdf", mime_type: "application/pdf", size_bytes: certBytes.length, kind: "certificate" },
  );
  db.bew_campaign_documents.push(
    { id: "cd-1", campaign_id: CAMPAIGN, document_id: "doc-cv", user_id: USER, kind: "cv", storage_path: `${USER}/cv.pdf`, filename: "cv.pdf", mime_type: "application/pdf", size_bytes: cvBytes.length },
    { id: "cd-2", campaign_id: CAMPAIGN, document_id: "doc-cert", user_id: USER, kind: "certificate", storage_path: `${USER}/cert.pdf`, filename: "cert.pdf", mime_type: "application/pdf", size_bytes: certBytes.length },
  );
  db.storage.objects.set(`${USER}/cv.pdf`, { bytes: cvBytes, contentType: "application/pdf" });
  db.storage.objects.set(`${USER}/cert.pdf`, { bytes: certBytes, contentType: "application/pdf" });
}

function appRow(id: string): Row {
  const row = db.bew_applications.find((a) => a.id === id);
  expect(row, `application ${id} must exist`).toBeTruthy();
  return row!;
}

beforeEach(() => {
  db = freshDb();
});

/* ------------------------------------------------------------------ *
 * Cleanup behavior per send outcome
 * ------------------------------------------------------------------ */

describe("post-send cleanup by outcome", () => {
  it("a confirmed send deletes the PDF; CV, certificates, rows and history are preserved", async () => {
    seedCampaign();
    await seedDocs();
    seedApp(1);
    daily(USER).emails_reserved = 1;
    db.sendScripts = [{ id: "m1" }];

    const result = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);

    // The generated PDF is gone…
    expect(db.storage.objects.has(letterPdfStoragePath(USER, "app-1"))).toBe(false);
    expect(db.storage.removedPaths).toEqual([letterPdfStoragePath(USER, "app-1")]);
    // …from the EXISTING bucket only.
    expect(db.storage.lastBucket).toBe("application-attachments");
    // …the CV and the certificate survive untouched.
    expect(db.storage.objects.has(`${USER}/cv.pdf`)).toBe(true);
    expect(db.storage.objects.has(`${USER}/cert.pdf`)).toBe(true);
    // Application record, letter text and send history are preserved.
    const row = appRow("app-1");
    expect(row.status).toBe("sent");
    expect(row.provider_message_id).toBe("m1");
    expect(row.sent_at).toBeTruthy();
    expect(row.body_html).toContain("Ich bewerbe mich"); // text stays for review
    expect(db.bew_campaign_documents).toHaveLength(2);
    expect(db.bew_documents).toHaveLength(2);
    expect(db.bew_campaigns).toHaveLength(1);
    expect(db.sendLog).toHaveLength(1);
    expect(daily(USER).emails_sent).toBe(1);
    expect(daily(USER).emails_reserved).toBe(0);
  }, 90000);

  it("a transient failure keeps the PDF (the retry still needs it); the eventual success deletes it", async () => {
    seedCampaign();
    await seedDocs();
    seedApp(1);
    daily(USER).emails_reserved = 1;
    db.sendScripts = [{ error: { code: "provider_rate_limited", message: "rate limited", temporary: true } }];

    const first = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(first.sent).toBe(0);
    const row = appRow("app-1");
    expect(row.status).toBe("queued"); // retried later
    expect(row.error_code).toBe("provider_rate_limited");
    // The letter file MUST survive the failed attempt…
    expect(db.storage.objects.has(letterPdfStoragePath(USER, "app-1"))).toBe(true);
    expect(db.storage.removedPaths).toEqual([]);
    // …and the quota stays reserved for the retry.
    expect(daily(USER).emails_reserved).toBe(1);

    // The backoff window passes; the retry succeeds → NOW the file is deleted.
    row.next_attempt_at = new Date(Date.now() - 1000).toISOString();
    db.sendScripts = [{ id: "m1" }];
    const second = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(second.sent).toBe(1);
    expect(db.storage.objects.has(letterPdfStoragePath(USER, "app-1"))).toBe(false);
    expect(db.sendLog).toHaveLength(1);
  }, 90000);

  it("a definitive provider rejection (failed) retains the PDF", async () => {
    seedCampaign();
    await seedDocs();
    seedApp(1);
    daily(USER).emails_reserved = 1;
    db.sendScripts = [{ error: { code: "provider_rejected", message: "rejected" } }];

    const result = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(result.failed).toBe(1);
    expect(appRow("app-1").status).toBe("failed");
    // Kept for a later manual retry / review.
    expect(db.storage.objects.has(letterPdfStoragePath(USER, "app-1"))).toBe(true);
    expect(db.storage.removedPaths).toEqual([]);
    expect(db.sendLog).toHaveLength(0);
  }, 90000);

  it("an ambiguous provider outcome retains the PDF and NEVER auto-resends", async () => {
    seedCampaign();
    await seedDocs();
    seedApp(1);
    daily(USER).emails_reserved = 1;
    // A raw network error (no provider `code`) → uncertain: the message MAY
    // have reached the provider.
    db.sendScripts = [{ error: new Error("socket hang up") }];

    const result = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(result.uncertain).toBe(1);
    const row = appRow("app-1");
    expect(row.status).toBe("needs_attention");
    expect(row.error_code).toBe("provider_uncertain");
    // Quota consumed (safe side) — and the letter file is retained.
    expect(daily(USER).emails_sent).toBe(1);
    expect(db.storage.objects.has(letterPdfStoragePath(USER, "app-1"))).toBe(true);
    expect(db.storage.removedPaths).toEqual([]);

    // A second drain must NOT re-send (duplicate-delivery guard)…
    db.sendScripts = [{ id: "must-not-send" }];
    const second = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(second.sent).toBe(0);
    expect(db.sendLog).toHaveLength(0);
    expect(appRow("app-1").status).toBe("needs_attention");
    // …and the file is still there.
    expect(db.storage.objects.has(letterPdfStoragePath(USER, "app-1"))).toBe(true);
  }, 90000);

  it("a partial batch deletes only the successfully sent applications' PDFs", async () => {
    seedCampaign();
    await seedDocs();
    seedApp(1);
    seedApp(2);
    daily(USER).emails_reserved = 2;
    db.sendScripts = [{ id: "m1" }, { error: { code: "provider_rejected", message: "nope" } }];

    const result = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(db.storage.objects.has(letterPdfStoragePath(USER, "app-1"))).toBe(false); // sent → cleaned
    expect(db.storage.objects.has(letterPdfStoragePath(USER, "app-2"))).toBe(true); // failed → kept
    expect(db.storage.removedPaths).toEqual([letterPdfStoragePath(USER, "app-1")]);
    expect(db.storage.objects.has(`${USER}/cv.pdf`)).toBe(true);
    expect(db.storage.objects.has(`${USER}/cert.pdf`)).toBe(true);
  }, 90000);
});

/* ------------------------------------------------------------------ *
 * Cleanup failure: non-fatal, idempotent retry, no duplicate sends
 * ------------------------------------------------------------------ */

describe("cleanup failure safety", () => {
  it("a failing delete does not change the send result, and the post-drain sweep retries it", async () => {
    seedCampaign();
    await seedDocs();
    seedApp(1);
    daily(USER).emails_reserved = 1;
    db.sendScripts = [{ id: "m1" }];
    db.storage.failDeletes = true; // delete fails on every attempt

    const result = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(result.sent).toBe(1);
    const row = appRow("app-1");
    expect(row.status).toBe("sent"); // NOT flipped back to failed
    expect(row.provider_message_id).toBe("m1");
    expect(daily(USER).emails_sent).toBe(1);
    expect(daily(USER).emails_reserved).toBe(0); // quota consumed, not released
    // The object survived the failed delete…
    expect(db.storage.objects.has(letterPdfStoragePath(USER, "app-1"))).toBe(true);
    expect(db.storage.removedPaths).toEqual([]);

    // The final drain flipped the campaign to a terminal state, so plain
    // drains no longer touch it…
    const second = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(second.stop).toBe("not-sending");
    expect(db.sendLog).toHaveLength(1); // NO duplicate e-mail

    // …and the scheduler's bounded cleanup pass (the cron tick) retries the
    // failed delete safely once the outage passes.
    db.storage.failDeletes = false;
    db.sendScripts = [{ id: "must-not-resend" }];
    const cleanup = await cleanupRecentlyCompletedBewLetterPdfs();
    expect(cleanup.deleted).toBe(1);
    expect(db.sendLog).toHaveLength(1); // still no duplicate e-mail
    expect(appRow("app-1").status).toBe("sent");
    expect(db.storage.objects.has(letterPdfStoragePath(USER, "app-1"))).toBe(false);
    expect(db.storage.removedPaths).toEqual([letterPdfStoragePath(USER, "app-1")]);
  }, 90000);

  it("repeated cleanup is idempotent: no double delete, no state change, no re-send", async () => {
    seedCampaign();
    await seedDocs();
    seedApp(1);
    daily(USER).emails_reserved = 1;
    db.sendScripts = [{ id: "m1" }];
    await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(db.storage.removedPaths).toEqual([letterPdfStoragePath(USER, "app-1")]);

    // Two more drains with the object already gone (sweep no-ops)…
    db.sendScripts = [{ id: "x1" }, { id: "x2" }];
    await processBewSendBatch(USER, CAMPAIGN, 5);
    await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(db.sendLog).toHaveLength(1); // nothing re-sent
    expect(db.storage.removedPaths).toEqual([letterPdfStoragePath(USER, "app-1")]); // deleted exactly once
    expect(appRow("app-1").status).toBe("sent");
    expect(daily(USER).emails_sent).toBe(1);
  }, 90000);
});

/* ------------------------------------------------------------------ *
 * Sweep scoping: only sent rows, only this user, never campaign docs
 * ------------------------------------------------------------------ */

describe("cleanup scoping", () => {
  it("the sweep never deletes PDFs of non-sent applications (queued/failed/needs_attention/pending)", async () => {
    seedCampaign();
    await seedDocs();
    // A mix of terminal and non-terminal rows, each WITH a letter object.
    seedApp(1, { status: "sent", provider_message_id: "m0", sent_at: new Date().toISOString() });
    seedApp(2, { status: "queued", next_attempt_at: new Date(Date.now() + 3600_000).toISOString() }); // not claimable yet
    seedApp(3, { status: "failed", error_code: "provider_rejected", error_message: "rejected" });
    seedApp(4, { status: "needs_attention", error_code: "provider_uncertain", error_message: "unknown" });
    seedApp(5, { status: "pending" });
    seedApp(6, { status: "excluded" });
    seedApp(7, { status: "cancelled" });
    for (let s = 1; s <= 7; s++) {
      db.storage.objects.set(letterPdfStoragePath(USER, `app-${s}`), {
        bytes: new TextEncoder().encode("%PDF-1.7 fixture"),
        contentType: "application/pdf",
      });
    }

    // Nothing is claimable (the only queued app is still in backoff).
    await processBewSendBatch(USER, CAMPAIGN, 5);

    // Exactly the sent row's object was removed…
    expect(db.storage.removedPaths).toEqual([letterPdfStoragePath(USER, "app-1")]);
    // …and every non-sent row's file survived.
    for (const s of [2, 3, 4, 5, 6, 7])
      expect(db.storage.objects.has(letterPdfStoragePath(USER, `app-${s}`)), `app-${s} must be retained`).toBe(true);
    // The campaign documents are campaign-owned, not sweep-owned.
    expect(db.storage.objects.has(`${USER}/cv.pdf`)).toBe(true);
    expect(db.storage.objects.has(`${USER}/cert.pdf`)).toBe(true);
  }, 60000);

  it("the retry pass is bounded by recency: campaigns older than the window are not re-scanned", async () => {
    // Campaign A: completed 24 h + 1 min ago (outside the window), orphaned
    // PDF still present (a failed cleanup back then).
    seedCampaign({ id: "camp-old", status: "completed", completed_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
    seedApp(1, { campaign_id: "camp-old", status: "sent", provider_message_id: "m0", sent_at: new Date().toISOString() });
    // Campaign B: completed 1 h ago (inside the window), orphaned PDF too.
    seedCampaign({ id: "camp-new", status: "completed", completed_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    seedApp(2, { campaign_id: "camp-new", status: "sent", provider_message_id: "m1", sent_at: new Date().toISOString() });
    const oldPath = letterPdfStoragePath(USER, "app-1");
    const newPath = letterPdfStoragePath(USER, "app-2");
    db.storage.objects.set(oldPath, { bytes: new TextEncoder().encode("%PDF-1.7 orphan"), contentType: "application/pdf" });
    db.storage.objects.set(newPath, { bytes: new TextEncoder().encode("%PDF-1.7 orphan"), contentType: "application/pdf" });

    const result = await cleanupRecentlyCompletedBewLetterPdfs();
    expect(result.deleted).toBe(1); // only the recent campaign was swept
    expect(db.storage.objects.has(newPath)).toBe(false);
    expect(db.storage.objects.has(oldPath)).toBe(true); // aged out → untouched (bounded garbage, small)
    expect(db.storage.removedPaths).toEqual([newPath]);
  }, 60000);

  it("ownership isolation: the sweep only touches paths under this user, never another user's objects", async () => {
    seedCampaign();
    await seedDocs();
    seedApp(1);
    daily(USER).emails_reserved = 1;
    // A foreign owner's generated PDF (different user prefix) exists.
    const foreignPath = letterPdfStoragePath(OTHER, "app-1");
    db.storage.objects.set(foreignPath, {
      bytes: new TextEncoder().encode("%PDF-1.7 foreign"),
      contentType: "application/pdf",
    });
    db.sendScripts = [{ id: "m1" }];

    await processBewSendBatch(USER, CAMPAIGN, 5);

    expect(db.storage.objects.has(letterPdfStoragePath(USER, "app-1"))).toBe(false);
    expect(db.storage.objects.has(foreignPath)).toBe(true); // untouched
    for (const p of db.storage.removedPaths) {
      expect(p.startsWith(`${USER}/bew-anschreiben/`), `path must be owner-scoped: ${p}`).toBe(true);
    }
  }, 90000);
});

/* ------------------------------------------------------------------ *
 * UI: after a send, the letter view explains the PDF is no longer retained
 * ------------------------------------------------------------------ */

describe("UI note for sent applications", () => {
  const app: any = {
    id: "app-1",
    seq: 1,
    company_name: "MusterTech GmbH",
    contact_name: null,
    company_email: "bewerbung@muster-tech.example",
    company_address: null,
    subject: "Bewerbung um einen Ausbildungsplatz bei MusterTech GmbH",
    body_html:
      "<p>Sehr geehrte Damen und Herren,</p><p>Ich bewerbe mich um den Ausbildungsplatz.</p><p>Mit freundlichen Grüßen</p><p>Max Mustermann</p>",
    body_text: "",
    status: "sent",
    error_code: null,
    error_message: null,
    attempt_count: 1,
    provider_message_id: "m1",
    sent_at: new Date().toISOString(),
  };

  function viewFixture(): any {
    return {
      campaign: {
        id: CAMPAIGN,
        user_id: USER,
        email_account_id: "acct-1",
        purpose: "ausbildung",
        status: "completed",
        requested_count: 1,
        valid_count: 1,
        total_count: 1,
        generated_count: 1,
        sent_count: 1,
        failed_count: 0,
        excluded_count: 0,
        usage_date: TODAY,
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      },
      applications: [app],
      documents: [
        { id: "cd-1", campaign_id: CAMPAIGN, document_id: "doc-cv", user_id: USER, kind: "cv", storage_path: `${USER}/cv.pdf`, filename: "cv.pdf", mime_type: "application/pdf", size_bytes: 1, created_at: TODAY },
        { id: "cd-2", campaign_id: CAMPAIGN, document_id: "doc-cert", user_id: USER, kind: "certificate", storage_path: `${USER}/cert.pdf`, filename: "cert.pdf", mime_type: "application/pdf", size_bytes: 1, created_at: TODAY },
      ],
      usage: { remaining: 49, daily_limit: 50 },
      senderEmail: "sender@gmail.com",
    };
  }

  async function renderModal(status: string): Promise<string> {
    const React = await import("react");
    const { renderToString } = await import("react-dom/server");
    const { translate } = await import("@/lib/i18n");
    const { LetterModal } = await import("@/components/bewerbung-automation/review-step");
    const t = (k: string, v?: Record<string, string | number>) => translate("de", k, v);
    return renderToString(
      React.createElement(LetterModal, {
        app: { ...app, status },
        mode: "preview",
        view: viewFixture(),
        busy: false,
        applicantName: "Max Mustermann",
        applicantEmail: "max@example.de",
        onClose: () => undefined,
        onSave: async () => undefined,
        t,
      }),
    );
  }

  it("a SENT application explains that its PDF was deleted after sending", async () => {
    const html = await renderModal("sent");
    expect(html).toContain(
      "Nach erfolgreichem Versand wird das Anschreiben-PDF automatisch gelöscht",
    );
    // The readable letter (text) is still shown from the stored body_html.
    expect(html).toContain("Ich bewerbe mich um den Ausbildungsplatz.");
    expect(html).toContain("Anschreiben_MusterTech_GmbH.pdf");
  });

  it("a not-yet-sent application keeps the regular PDF note", async () => {
    const html = await renderModal("generated");
    expect(html).toContain("Wird automatisch generiert und jeder Bewerbung als Anhang beigefügt.");
    expect(html).not.toContain("wird das Anschreiben-PDF automatisch gelöscht");
  });
});
