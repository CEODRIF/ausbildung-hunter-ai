import { beforeEach, describe, expect, it, vi } from "vitest";

// The in-memory fake below mimics a DYNAMIC Supabase proxy builder; its
// surface is intentionally untyped (shape-proof against the real chains).
/* eslint-disable @typescript-eslint/no-explicit-any */

/* ------------------------------------------------------------------ *
 * In-memory fake of the pieces the engine depends on, so the SEND SAFETY
 * contract can be asserted with REAL state (claims, quota, sends) rather
 * than canned returns. No real e-mail, no real Supabase, no real AI.
 * ------------------------------------------------------------------ */

type Row = Record<string, any>;
type TableKey =
  | "bew_campaigns"
  | "bew_applications"
  | "bew_documents"
  | "bew_campaign_documents"
  | "email_accounts"
  | "daily_usage"
  | "profiles";

interface DB {
  bew_campaigns: Row[];
  bew_applications: Row[];
  bew_documents: Row[];
  bew_campaign_documents: Row[];
  email_accounts: Row[];
  daily_usage: Row[];
  profiles: Row[];
  aiRemaining: number;
  slotFree: boolean;
  /** Scripted provider outcomes, consumed one per sendEmail call. */
  sendScripts: Array<() => { ok: true; id: string } | (() => never)>;
  /** Scripted AI bodies, consumed one per generateText call. A function
   *  returns the Error that generateText should THROW for that letter. */
  aiScripts: Array<string | (() => Error)>;
  pdfText: string;
  /** Every message actually handed to the provider (the "out the door" log). */
  sendLog: Array<{
    to: string;
    subject: string;
    html: string;
    attachments: number;
    /** The attachment file names pre-fetched for this exact message. */
    attachmentFiles: string[];
  }>;
  /** Storage upload paths captured by the fake (owner-scoping proofs). */
  uploads: string[];
  /** Storage removal paths captured by the fake (compensation proofs). */
  removedPaths: string[];
  /** Tables whose INSERT should fail (compensation-path proofs). */
  insertFailTables: Set<string>;
  /** Simulate a database WITHOUT the scheduled_at column (20261116 pending):
   *  any query using `lte` fails, mirroring PostgREST's column-missing error. */
  failLte: boolean;
}

function freshDb(): DB {
  return {
    bew_campaigns: [],
    bew_applications: [],
    bew_documents: [],
    bew_campaign_documents: [],
    email_accounts: [
      { id: "acct-1", user_id: "user-1", email: "sender@gmail.com", is_active: true, requires_reconnect: false },
    ],
    daily_usage: [
      { user_id: "user-1", date: TODAY, emails_sent: 0, emails_reserved: 0, daily_limit: 50 },
    ],
    profiles: [
      {
        id: "user-1",
        full_name: "Max Mustermann",
        email: "max@example.de",
        street: "Musterstraße 12",
        postal_code: "12345",
        city: "Berlin",
        country: "Deutschland",
        phone: "+49 151 2345678",
      },
    ],
    aiRemaining: 100,
    slotFree: true,
    sendScripts: [],
    aiScripts: [],
    pdfText: "LEBENSLAUF: Max Mustermann, Fachinformatiker, Berlin.",
    sendLog: [],
    uploads: [],
    removedPaths: [],
    insertFailTables: new Set<string>(),
    failLte: false,
  };
}

const TODAY = new Date().toISOString().slice(0, 10);
const USER = "user-1";
const CAMPAIGN = "camp-1";

function daily(db: DB, userId: string): Row {
  let du = db.daily_usage.find((d) => d.user_id === userId);
  if (!du) {
    du = { user_id: userId, date: TODAY, emails_sent: 0, emails_reserved: 0, daily_limit: 50 };
    db.daily_usage.push(du);
  }
  return du;
}

function rpc(db: DB, name: string, args: any): Promise<{ data: any; error: any }> {
  switch (name) {
    case "reserve_email_capacity": {
      const du = daily(db, args.target_user_id);
      const limit = du.daily_limit ?? 50;
      const available = limit - du.emails_sent - du.emails_reserved;
      if (args.requested <= 0 || args.requested > 1000)
        return Promise.resolve({ data: null, error: { message: "invalid_request_size" } });
      if (args.requested > available)
        return Promise.resolve({ data: null, error: { message: "daily_quota_exceeded" } });
      du.emails_reserved += args.requested;
      return Promise.resolve({
        data: { date: du.date, daily_limit: limit, emails_sent: du.emails_sent, emails_reserved: du.emails_reserved, remaining: available - args.requested },
        error: null,
      });
    }
    case "release_email_capacity": {
      const du = db.daily_usage.find((d) => d.user_id === args.target_user_id && d.date === args.reservation_date);
      if (du) du.emails_reserved = Math.max(du.emails_reserved - args.released, 0);
      return Promise.resolve({ data: null, error: null });
    }
    case "bew_record_email_sent": {
      const du = db.daily_usage.find((d) => d.user_id === args.target_user_id && d.date === args.reservation_date);
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
      // Atomic: flip to sending immediately so a concurrent claim cannot take it.
      app.status = "sending";
      app.attempt_count = (app.attempt_count ?? 0) + 1;
      camp.status = "sending";
      if (!camp.started_at) camp.started_at = new Date().toISOString();
      return Promise.resolve({ data: { ...app }, error: null });
    }
    case "bew_cancel_queued": {
      const camp = db.bew_campaigns.find((c) => c.id === args.target_campaign_id && c.user_id === args.target_user_id);
      if (!camp) return Promise.resolve({ data: 0, error: null });
      let cancelled = 0;
      for (const a of db.bew_applications)
        if (a.campaign_id === camp.id && a.status === "queued") {
          a.status = "cancelled";
          cancelled++;
        }
      const du = db.daily_usage.find((d) => d.user_id === args.target_user_id && d.date === camp.usage_date);
      if (du) du.emails_reserved = Math.max(du.emails_reserved - cancelled, 0);
      const stillSending = db.bew_applications.some((a) => a.campaign_id === camp.id && a.status === "sending");
      if (!stillSending) camp.status = "cancelled";
      return Promise.resolve({ data: cancelled, error: null });
    }
    case "reserve_email_capacity_on": {
      // Date-parameterised reserve: reserves against args.on_date (the
      // scheduled date), mirroring the SQL RPC's daily_quota_exceeded.
      let du = db.daily_usage.find((d) => d.user_id === args.target_user_id && d.date === args.on_date);
      if (!du) {
        du = { user_id: args.target_user_id, date: args.on_date, emails_sent: 0, emails_reserved: 0, daily_limit: 50 };
        db.daily_usage.push(du);
      }
      const limit = du.daily_limit ?? 50;
      const available = limit - du.emails_sent - du.emails_reserved;
      if (args.requested <= 0 || args.requested > 1000)
        return Promise.resolve({ data: null, error: { message: "invalid_request_size" } });
      if (args.requested > available)
        return Promise.resolve({ data: null, error: { message: "daily_quota_exceeded" } });
      du.emails_reserved += args.requested;
      return Promise.resolve({ data: { date: du.date, remaining: available - args.requested }, error: null });
    }
    case "bew_reschedule": {
      const camp = db.bew_campaigns.find((c) => c.id === args.target_campaign_id && c.user_id === args.target_user_id);
      if (!camp) return Promise.resolve({ data: false, error: null });
      if (!args.new_scheduled_at || Date.parse(args.new_scheduled_at) <= Date.now()) return Promise.resolve({ data: false, error: null });
      if (camp.status !== "sending" || camp.started_at !== null) return Promise.resolve({ data: false, error: null });
      const reservedCount = db.bew_applications.filter((a) => a.campaign_id === camp.id && a.status === "queued").length;
      if (reservedCount === 0) return Promise.resolve({ data: false, error: null });
      if (camp.usage_date !== args.new_usage_date) {
        const oldDu = db.daily_usage.find((d) => d.user_id === camp.user_id && d.date === camp.usage_date);
        if (oldDu) oldDu.emails_reserved = Math.max(oldDu.emails_reserved - reservedCount, 0);
        let newDu = db.daily_usage.find((d) => d.user_id === camp.user_id && d.date === args.new_usage_date);
        if (!newDu) {
          newDu = { user_id: camp.user_id, date: args.new_usage_date, emails_sent: 0, emails_reserved: 0, daily_limit: 50 };
          db.daily_usage.push(newDu);
        }
        const avail = (newDu.daily_limit ?? 50) - newDu.emails_sent - newDu.emails_reserved;
        if (reservedCount > avail) return Promise.resolve({ data: null, error: { message: "daily_quota_exceeded" } });
        newDu.emails_reserved += reservedCount;
      }
      camp.scheduled_at = args.new_scheduled_at;
      camp.timezone = args.new_timezone;
      camp.usage_date = args.new_usage_date;
      for (const a of db.bew_applications)
        if (a.campaign_id === camp.id && a.status === "queued") a.next_attempt_at = args.new_scheduled_at;
      return Promise.resolve({ data: true, error: null });
    }
    default:
      return Promise.resolve({ data: null, error: { message: `unknown rpc ${name}` } });
  }
}

/** Minimal chainable query builder over the in-memory tables. */
function makeFrom(db: DB, table: TableKey) {
  const state = {
    op: "select" as string,
    payload: undefined as any,
    filters: [] as Array<{ col: string; val: any; negated?: boolean }>,
    inFilters: [] as Array<{ col: string; values: any[] }>,
    lteFilters: [] as Array<{ col: string; val: any }>,
    orderBy: [] as Array<{ col: string; ascending: boolean }>,
    limitN: undefined as number | undefined,
    selectCols: "*",
    selectOpts: undefined as any,
    terminal: undefined as "single" | "maybeSingle" | undefined,
    upsertConf: undefined as any,
  };

  function rows(): Row[] {
    let out = (db[table] ?? []).slice();
    for (const f of state.filters)
      out = out.filter((r) => (f.negated ? r[f.col] !== f.val : r[f.col] === f.val));
    for (const f of state.inFilters) out = out.filter((r) => f.values.includes(r[f.col]));
    // ISO-8601 strings compare chronologically as strings.
    for (const f of state.lteFilters)
      out = out.filter((r) => r[f.col] != null && r[f.col] <= f.val);
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
      if (db.insertFailTables.has(table)) {
        return { data: null, error: { message: "injected insert failure" } };
      }
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
      if (state.selectOpts) return { data: null, error: null, count: matched.length };
      return { data: matched, error: null };
    }
    if (state.op === "delete") {
      const matched = rows();
      (db[table] as Row[]) = (db[table] ?? []).filter((r) => !matched.includes(r));
      return { data: null, error: null };
    }
    if (state.op === "upsert") {
      const conf: string[] = state.upsertConf?.onConflict?.split(",") ?? [];
      const existing = (db[table] ?? []).find((r) => conf.every((c) => r[c.trim()] === state.payload[c.trim()]));
      if (existing) Object.assign(existing, state.payload);
      else (db[table] ??= []).push({ ...state.payload, id: `id-${Math.random()}` });
      return { data: existing ?? db[table][db[table].length - 1], error: null };
    }
    // select
    if (state.lteFilters.length > 0 && db.failLte)
      return { data: null, error: { message: "column scheduled_at does not exist (injected)" } };
    const matched = rows();
    if (state.selectOpts?.count) return { data: state.selectOpts.head ? null : matched, error: null, count: matched.length };
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
    is(col: string, val: any) {
      state.filters.push({ col, val });
      return chain;
    },
    not(col: string, op: string, val: any) {
      if (op !== "is") throw new Error("fake chain: not() supports 'is' only");
      state.filters.push({ col, val, negated: true });
      return chain;
    },
    lte(col: string, val: any) {
      state.lteFilters.push({ col, val });
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
    select(cols?: string, opts?: any) {
      state.selectCols = cols ?? "*";
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
    upsert(payload: any, conf?: any) {
      state.op = "upsert";
      state.payload = payload;
      state.upsertConf = conf;
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

let db: DB;

function installMocks() {
  vi.doMock("@/lib/supabase/admin", () => ({
    createAdminClient: () => ({
      from: (table: string) => makeFrom(db, table as TableKey),
      rpc: (name: string, args: any) => rpc(db, name, args),
      storage: {
        from: () => ({
          download: async () => ({ data: { arrayBuffer: async () => new Uint8Array([1]).buffer }, error: null }),
          upload: async (path: string) => {
            db.uploads.push(path);
            return { error: null };
          },
          remove: async (paths: string[]) => {
            for (const p of paths ?? []) db.removedPaths.push(p);
            return { error: null };
          },
        }),
      },
    }),
  }));
  vi.doMock("@/lib/email-campaigns", () => ({
    getUsageSnapshot: async (userId: string) => {
      const du = daily(db, userId);
      const limit = du.daily_limit ?? 50;
      return { date: du.date, emails_sent: du.emails_sent, emails_reserved: du.emails_reserved, daily_limit: limit, remaining: Math.max(limit - du.emails_sent - du.emails_reserved, 0) };
    },
    reserveSenderSlot: async () => db.slotFree,
  }));
  vi.doMock("@/lib/email-providers", () => ({
    // Mirrors the REAL contract: the provider pre-fetches the files given
    // at construction and attaches them to every sendEmail call (the engine
    // passes attachments: [] and relies on that).
    createEmailProvider: async (
      _userId: string,
      _accountId: string,
      paths: Array<{ filename: string; storagePath: string }> = [],
    ) => ({
      sendEmail: async (input: any) => {
        const script = db.sendScripts.shift();
        if (!script) throw Object.assign(new Error("no provider script"), { code: "provider_rejected", temporary: false });
        const attached = input.attachments?.length || paths.length || 0;
        db.sendLog.push({
          to: input.to,
          subject: input.subject,
          html: input.html,
          attachments: attached,
          attachmentFiles: paths.map((p) => p.filename),
        });
        const result = script();
        if (result && (result as { ok?: boolean }).ok) return { providerMessageId: (result as { id: string }).id };
        throw new Error("script should be handled");
      },
    }),
  }));
  vi.doMock("@/lib/ai-provider", () => ({
    createAIProvider: () => ({
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      generateText: async (_messages: any) => {
        const script = db.aiScripts.shift();
        if (!script) return "Generischer Text.";
        if (typeof script === "function") throw script();
        return script;
      },
    }),
  }));
  vi.doMock("@/lib/ai-service", () => ({
    reserveAIUsage: async () => {
      if (db.aiRemaining <= 0) throw new Error("AI daily request limit reached. Please try again tomorrow.");
      db.aiRemaining -= 1;
    },
    storagePath: (userId: string, filename: string) => `${userId}/doc-${filename}`,
  }));
  vi.doMock("@/lib/pdf-extract", () => ({ extractPdfText: async () => db.pdfText }));
  vi.doMock("@/lib/application-drafts", () => ({
    sanitizeEmailHtml: (h: string) => h,
    htmlToText: (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  }));
  vi.doMock("mammoth", () => ({ default: { extractRawText: async () => ({ value: "docx" }) } }));
}

installMocks();

const {
  attachBewDocument,
  cancelBewSend,
  detachBewDocument,
  generateBewLetters,
  listBewDocuments,
  listSendingBewCampaigns,
  processBewSendBatch,
  rescheduleBewSend,
  restoreBewApplication,
  startBewSend,
  uploadBewDocument,
} = await import("@/lib/bewerbung-engine");

/* ------------------------------------------------------------------ *
 * Seed helpers
 * ------------------------------------------------------------------ */

function seedCampaign(overrides: Partial<Row> = {}) {
  db.bew_campaigns.push({
    id: CAMPAIGN,
    user_id: USER,
    email_account_id: "acct-1",
    purpose: "ausbildung",
    status: "sending",
    requested_count: 3,
    usage_date: TODAY,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    // Campaign e-mail (independent from the per-company Anschreiben).
    // The subject template resolves per recipient; the body deliberately
    // carries NO {{candidate_name}} token (the fake profile name is empty).
    email_subject: "Bewerbung um einen Ausbildungsplatz bei {{company_name}}",
    email_body_html:
      "<p>Guten Tag,</p><p>anbei meine Bewerbung.</p><p>Mit freundlichen Grüssen</p>",
    ...overrides,
  });
}

function seedApp(seq: number, over: Partial<Row> = {}) {
  db.bew_applications.push({
    id: `app-${seq}`,
    campaign_id: CAMPAIGN,
    user_id: USER,
    seq,
    company_name: `Firma ${seq}`,
    contact_name: null,
    company_email: `jobs${seq}@firma${seq}.de`,
    company_address: null,
    subject: `Bewerbung um einen Ausbildungsplatz bei Firma ${seq}`,
    body_html: `<p>Sehr geehrte Damen und Herren,</p><p>Text ${seq}</p>`,
    body_text: `Text ${seq}`,
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

function seedDocuments() {
  db.bew_documents.push(
    { id: "doc-cv", user_id: USER, storage_path: `${USER}/cv.pdf`, filename: "cv.pdf", mime_type: "application/pdf", size_bytes: 1000, kind: "cv" },
    { id: "doc-cert", user_id: USER, storage_path: `${USER}/cert.pdf`, filename: "cert.pdf", mime_type: "application/pdf", size_bytes: 800, kind: "certificate" },
  );
  db.bew_campaign_documents.push(
    { id: "cd-1", campaign_id: CAMPAIGN, document_id: "doc-cv", user_id: USER, kind: "cv", storage_path: `${USER}/cv.pdf`, filename: "cv.pdf", mime_type: "application/pdf", size_bytes: 1000 },
    { id: "cd-2", campaign_id: CAMPAIGN, document_id: "doc-cert", user_id: USER, kind: "certificate", storage_path: `${USER}/cert.pdf`, filename: "cert.pdf", mime_type: "application/pdf", size_bytes: 800 },
  );
}

const okSend = (id: string) => () => ({ ok: true as const, id });
// The real provider THROWS a ProviderFailure on rejection — the scripts must
// too, so the engine sees the intended code/flags.
const failTemporary = () => {
  throw Object.assign(new Error("Gmail is temporarily unavailable."), { code: "provider_temporary", temporary: true });
};
const failDefinitive = () => {
  throw Object.assign(new Error("Gmail rejected this message."), { code: "provider_rejected", temporary: false });
};
const failReconnect = () => {
  throw Object.assign(new Error("Reconnect required."), { code: "reconnect_required", reconnect: true });
};
const rawNetworkError = () => {
  throw new Error("fetch failed");
};

beforeEach(() => {
  db = freshDb();
});

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe("processBewSendBatch — safe sending", () => {
  it("sends each app exactly once with the matching recipient, subject and attachments (1:1 association)", async () => {
    seedCampaign();
    seedDocuments();
    seedApp(1);
    seedApp(2);
    seedApp(3);
    db.sendScripts = [okSend("m1"), okSend("m2"), okSend("m3")];

    const result = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(result.sent).toBe(3);
    expect(result.failed).toBe(0);
    expect(db.sendLog).toHaveLength(3);
    // One-to-one: recipient + subject + attachment set preserved per app.
    // Every outgoing e-mail carries the CV, the certificate AND the
    // generated Anschreiben PDF for THAT company (sorted: kind, filename).
    expect(db.sendLog[0]).toMatchObject({
      to: "jobs1@firma1.de",
      subject: "Bewerbung um einen Ausbildungsplatz bei Firma 1",
      attachments: 3,
      attachmentFiles: ["cert.pdf", "cv.pdf", "Anschreiben_Firma_1.pdf"],
    });
    expect(db.sendLog[1].attachmentFiles).toEqual(["cert.pdf", "cv.pdf", "Anschreiben_Firma_2.pdf"]);
    expect(db.sendLog[2].attachmentFiles).toEqual(["cert.pdf", "cv.pdf", "Anschreiben_Firma_3.pdf"]);
    // provider_message_id captured (idempotency/audit).
    const sent = db.bew_applications.filter((a) => a.status === "sent");
    expect(sent.map((a) => a.provider_message_id).sort()).toEqual(["m1", "m2", "m3"]);
    // Quota consumed: 3 sent, 0 reserved.
    const du = daily(db, USER);
    expect(du.emails_sent).toBe(3);
    expect(du.emails_reserved).toBe(0);
  });

  it("is idempotent under concurrent drains (no double-send)", async () => {
    seedCampaign();
    seedDocuments();
    for (let i = 1; i <= 5; i++) seedApp(i);
    db.sendScripts = [okSend("a"), okSend("b"), okSend("c"), okSend("d"), okSend("e")];

    // Two overlapping drains (browser + cron) must not double-send.
    await Promise.all([
      processBewSendBatch(USER, CAMPAIGN, 5),
      processBewSendBatch(USER, CAMPAIGN, 5),
    ]);
    expect(db.sendLog).toHaveLength(5);
    const distinctRecipients = new Set(db.sendLog.map((m) => m.to));
    expect(distinctRecipients.size).toBe(5);
  });

  it("retries a TRANSIENT failure (back to queued, quota kept) then succeeds", async () => {
    seedCampaign();
    seedDocuments();
    seedApp(1);
    // First attempt: transient; second: success.
    db.sendScripts = [failTemporary, okSend("m1")];

    const first = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(first.sent).toBe(0);
    const app = db.bew_applications[0];
    expect(app.status).toBe("queued"); // re-queued for retry
    expect(app.next_attempt_at).not.toBeNull();
    // Quota still reserved (not released, not consumed).
    expect(daily(db, USER).emails_reserved).toBe(0); // note: no reservation in this direct test
    // Make it due now and drain again.
    app.next_attempt_at = new Date(0).toISOString();
    const second = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(second.sent).toBe(1);
    // Two attempts were handed to the provider: the failed transient one and
    // the successful one (sendLog records attempts, not successes).
    expect(db.sendLog).toHaveLength(2);
    expect(db.bew_applications[0].status).toBe("sent");
  });

  it("marks a DEFINITIVE failure as failed and does not retry", async () => {
    seedCampaign();
    seedDocuments();
    seedApp(1);
    db.sendScripts = [failDefinitive];
    const result = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(result.failed).toBe(1);
    expect(db.bew_applications[0].status).toBe("failed");
    // The rejected message WAS handed to the provider exactly once …
    expect(db.sendLog).toHaveLength(1);
    // …and a second drain must not re-attempt the failed (terminal) app.
    db.sendScripts = [okSend("should-not-send")];
    await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(db.sendLog).toHaveLength(1);
  });

  it("stops the batch on a RECONNECT failure (no further sends)", async () => {
    seedCampaign();
    seedDocuments();
    seedApp(1);
    seedApp(2);
    db.sendScripts = [failReconnect, okSend("nope")];
    const result = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(result.stop).toBe("reconnect");
    expect(db.bew_applications[0].status).toBe("needs_attention");
    // The second app was never touched.
    expect(db.bew_applications[1].status).toBe("queued");
    // One attempt (the rejected one) — the queued second app was not sent.
    expect(db.sendLog).toHaveLength(1);
  });

  it("treats an AMBIGUOUS (raw network) outcome as needs_attention and never auto-retries", async () => {
    seedCampaign();
    seedDocuments();
    seedApp(1);
    db.sendScripts = [rawNetworkError];
    const result = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(result.uncertain).toBe(1);
    expect(db.bew_applications[0].status).toBe("needs_attention");
    // Not re-queued → a later drain will not duplicate it: the log keeps
    // exactly the ORIGINAL attempt (the message may have been delivered).
    db.sendScripts = [okSend("dup?")];
    await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(db.sendLog).toHaveLength(1);
  });

  it("stops without claiming when the sender slot is busy", async () => {
    seedCampaign();
    seedDocuments();
    seedApp(1);
    db.slotFree = false;
    const result = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(result.slotBusy).toBe(true);
    expect(result.stop).toBe("slot-busy");
    expect(db.bew_applications[0].status).toBe("queued"); // untouched
    expect(db.sendLog).toHaveLength(0);
  });

  it("does nothing for another user's campaign (ownership)", async () => {
    seedCampaign({ user_id: "user-2" });
    seedApp(1, { user_id: "user-2" });
    const result = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(result.stop).toBe("not-sending");
    expect(db.sendLog).toHaveLength(0);
  });
});

describe("startBewSend — explicit, quota-aware entry point", () => {
  it("refuses when the quota is exhausted (nothing queued, nothing reserved)", async () => {
    seedCampaign({ status: "draft" });
    seedDocuments();
    seedApp(1, { status: "generated" });
    db.daily_usage[0].emails_sent = 50; // daily_limit 50 → remaining 0
    const result = await startBewSend(USER, CAMPAIGN);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("QUOTA_EXHAUSTED");
    expect(db.sendLog).toHaveLength(0);
    expect(daily(db, USER).emails_reserved).toBe(0);
    expect(db.bew_applications[0].status).toBe("generated"); // not queued
  });

  it("sends only the affordable batch when requested > remaining (explains the rest)", async () => {
    seedCampaign({ status: "draft" });
    seedDocuments();
    for (let i = 1; i <= 5; i++) seedApp(i, { status: "generated" });
    db.daily_usage[0].emails_sent = 47; // remaining 3 of 50
    db.sendScripts = [okSend("a"), okSend("b"), okSend("c")];

    const result = await startBewSend(USER, CAMPAIGN);
    expect(result.ok).toBe(true);
    expect(result.plan?.batch).toBe(3);
    expect(result.plan?.deferred).toBe(2);
    expect(result.plan?.overLimit).toBe(true);
    expect(result.queuedCount).toBe(3);
    // Only 3 more sent on top of the seeded 47; the other 2 stay generated
    // (sendable later) and the campaign stays open for the deferred batch.
    expect(daily(db, USER).emails_sent).toBe(47 + 3);
    expect(daily(db, USER).emails_reserved).toBe(0);
    expect(db.bew_campaigns[0].status).not.toBe("completed");
    const queued = db.bew_applications.filter((a) => a.status === "queued").length;
    const generated = db.bew_applications.filter((a) => a.status === "generated").length;
    expect(queued + generated).toBe(2); // the deferred remainder
  });

  it("refuses when required documents are missing (no CV)", async () => {
    seedCampaign({ status: "draft" });
    seedDocuments();
    db.bew_campaign_documents = db.bew_campaign_documents.filter((d) => d.kind !== "cv");
    seedApp(1, { status: "generated" });
    const result = await startBewSend(USER, CAMPAIGN);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("DOCUMENTS_MISSING");
    expect(result.hasCv).toBe(false);
    expect(db.sendLog).toHaveLength(0);
  });

  it("refuses with NO_SENDER when no account is attached", async () => {
    seedCampaign({ status: "draft", email_account_id: null });
    seedDocuments();
    seedApp(1, { status: "generated" });
    const result = await startBewSend(USER, CAMPAIGN);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("NO_SENDER");
  });

  it("refuses with SENDER_NOT_READY when the account needs reconnect", async () => {
    seedCampaign({ status: "draft" });
    db.email_accounts[0].requires_reconnect = true;
    seedDocuments();
    seedApp(1, { status: "generated" });
    const result = await startBewSend(USER, CAMPAIGN);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("SENDER_NOT_READY");
  });

  it("never sends incomplete apps (invalid e-mail or empty body)", async () => {
    seedCampaign({ status: "draft" });
    seedDocuments();
    seedApp(1, { status: "generated", company_email: "not-an-email" });
    seedApp(2, { status: "generated", body_html: "   " });
    seedApp(3, { status: "generated" }); // the only valid one
    db.sendScripts = [okSend("only-3")];
    const result = await startBewSend(USER, CAMPAIGN);
    expect(result.ok).toBe(true);
    expect(result.plan?.batch).toBe(1);
    expect(db.sendLog).toHaveLength(1);
    expect(db.sendLog[0].to).toBe("jobs3@firma3.de");
  });
});

describe("scheduled sending — reuses the existing scheduler (no second system)", () => {
  // Scheduled instants must fall on a LATER CALENDAR DAY than today: the
  // quota is keyed by usage_date = utcIso.slice(0,10), and a same-day "future"
  // instant would collide with today's quota row (the engine must reserve the
  // future date's quota, not today's). 24h guarantees a different day at any
  // execution time; extra hours keep the relative spacing of the cases.
  const futureIn = (hours: number) => new Date(Date.now() + (24 + hours) * 60 * 60 * 1000).toISOString();

  it("schedules: reserves the FUTURE date, future-dates the queue, leaves started_at null, sends NOTHING", async () => {
    seedCampaign({ status: "draft" });
    seedDocuments();
    seedApp(1, { status: "generated" });
    seedApp(2, { status: "generated" });
    seedApp(3, { status: "generated" });
    const future = futureIn(2);
    const usageDate = future.slice(0, 10);
    db.daily_usage.push({ user_id: USER, date: usageDate, emails_sent: 0, emails_reserved: 0, daily_limit: 50 });

    const result = await startBewSend(USER, CAMPAIGN, {
      selectedSeqs: [1, 2, 3],
      scheduling: { utcIso: future, timeZone: "Europe/Berlin" },
    });
    expect(result.ok).toBe(true);
    expect(result.queuedCount).toBe(3);
    // Persisted, not sent: NO immediate drain ran.
    expect(db.sendLog).toHaveLength(0);
    for (const a of db.bew_applications) {
      expect(a.status).toBe("queued");
      expect(a.next_attempt_at).toBe(future);
    }
    // Quota reserved on the FUTURE date, not today.
    expect(db.daily_usage.find((d) => d.date === usageDate)!.emails_reserved).toBe(3);
    expect(daily(db, USER).emails_reserved).toBe(0);
    // Campaign: canonical instant + zone + scheduled usage_date; started_at
    // stays NULL (pending → still cancellable / reschedulable; the first
    // claim stamps it at the due instant).
    const camp = db.bew_campaigns[0];
    expect(camp.status).toBe("sending");
    expect(camp.scheduled_at).toBe(future);
    expect(camp.timezone).toBe("Europe/Berlin");
    expect(camp.usage_date).toBe(usageDate);
    expect(camp.started_at).toBeNull();
  });

  it("the existing drain sends nothing BEFORE the due instant, then the SAME idempotency core sends it once when due", async () => {
    seedCampaign({ status: "draft" });
    seedDocuments();
    seedApp(1, { status: "generated" });
    const future = futureIn(1);
    db.daily_usage.push({ user_id: USER, date: future.slice(0, 10), emails_sent: 0, emails_reserved: 0, daily_limit: 50 });
    await startBewSend(USER, CAMPAIGN, {
      selectedSeqs: [1],
      scheduling: { utcIso: future, timeZone: "Europe/Berlin" },
    });
    // BEFORE due: the due-aware tick selection skips the pending batch
    // (nothing is claimable yet — no wasted campaign slot) and a direct drain
    // claims nothing → sends nothing.
    expect((await listSendingBewCampaigns()).map((c) => c.id)).not.toContain(CAMPAIGN);
    db.sendScripts = [okSend("too-early")];
    const early = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(early.sent).toBe(0);
    expect(db.sendLog).toHaveLength(0);
    expect(db.bew_applications[0].status).toBe("queued");

    // DUE (simulate time passing): the batch is now listed, and the SAME
    // idempotency core sends it exactly once.
    db.bew_campaigns[0].scheduled_at = new Date(0).toISOString();
    db.bew_applications[0].next_attempt_at = new Date(0).toISOString();
    expect((await listSendingBewCampaigns()).map((c) => c.id)).toContain(CAMPAIGN);
    const late = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(late.sent).toBe(1);
    expect(db.sendLog).toHaveLength(1);
    expect(db.bew_applications[0].status).toBe("sent");
  });

  it("reschedules a pending batch to a new future instant (moves quota + re-gates the queue), still sends nothing", async () => {
    seedCampaign({ status: "draft" });
    seedDocuments();
    seedApp(1, { status: "generated" });
    seedApp(2, { status: "generated" });
    const first = futureIn(1);
    const second = futureIn(25); // two days ahead (clearly a different quota date)
    db.daily_usage.push({ user_id: USER, date: first.slice(0, 10), emails_sent: 0, emails_reserved: 0, daily_limit: 50 });
    db.daily_usage.push({ user_id: USER, date: second.slice(0, 10), emails_sent: 0, emails_reserved: 0, daily_limit: 50 });
    await startBewSend(USER, CAMPAIGN, {
      selectedSeqs: [1, 2],
      scheduling: { utcIso: first, timeZone: "Europe/Berlin" },
    });
    expect(db.daily_usage.find((d) => d.date === first.slice(0, 10))!.emails_reserved).toBe(2);

    await rescheduleBewSend(USER, CAMPAIGN, { utcIso: second, timeZone: "Europe/Berlin" });

    const camp = db.bew_campaigns[0];
    expect(camp.scheduled_at).toBe(second);
    expect(camp.usage_date).toBe(second.slice(0, 10));
    for (const a of db.bew_applications) expect(a.next_attempt_at).toBe(second);
    // Quota moved off the first date onto the second (nothing leaked).
    expect(db.daily_usage.find((d) => d.date === first.slice(0, 10))!.emails_reserved).toBe(0);
    expect(db.daily_usage.find((d) => d.date === second.slice(0, 10))!.emails_reserved).toBe(2);
    expect(db.sendLog).toHaveLength(0);
  });

  it("refuses to reschedule once the batch has started (started_at set / row in flight)", async () => {
    seedCampaign({ status: "sending", started_at: new Date().toISOString() });
    seedDocuments();
    seedApp(1, { status: "sending" }); // a claim already happened
    await expect(
      rescheduleBewSend(USER, CAMPAIGN, { utcIso: futureIn(2), timeZone: "Europe/Berlin" }),
    ).rejects.toThrow("CANNOT_RESCHEDULE");
  });

  it("cancels a pending scheduled batch and releases the FUTURE-date quota", async () => {
    seedCampaign({ status: "draft" });
    seedDocuments();
    seedApp(1, { status: "generated" });
    seedApp(2, { status: "generated" });
    const future = futureIn(1);
    const usageDate = future.slice(0, 10);
    db.daily_usage.push({ user_id: USER, date: usageDate, emails_sent: 0, emails_reserved: 0, daily_limit: 50 });
    await startBewSend(USER, CAMPAIGN, {
      selectedSeqs: [1, 2],
      scheduling: { utcIso: future, timeZone: "Europe/Berlin" },
    });
    expect(db.daily_usage.find((d) => d.date === usageDate)!.emails_reserved).toBe(2);

    const { cancelled } = await cancelBewSend(USER, CAMPAIGN);
    expect(cancelled).toBe(2);
    expect(db.daily_usage.find((d) => d.date === usageDate)!.emails_reserved).toBe(0);
    expect(db.bew_applications.every((a) => a.status === "cancelled")).toBe(true);
    expect(db.bew_campaigns[0].status).toBe("cancelled");
    expect(db.sendLog).toHaveLength(0);
  });

  it("rejects a scheduled send that cannot be afforded on the FUTURE date (no partial reserve)", async () => {
    seedCampaign({ status: "draft" });
    seedDocuments();
    seedApp(1, { status: "generated" });
    seedApp(2, { status: "generated" });
    const future = futureIn(1);
    const usageDate = future.slice(0, 10);
    // Only 1 slot left on the future date → 2 requested cannot be reserved.
    db.daily_usage.push({ user_id: USER, date: usageDate, emails_sent: 49, emails_reserved: 0, daily_limit: 50 });
    const result = await startBewSend(USER, CAMPAIGN, {
      selectedSeqs: [1, 2],
      scheduling: { utcIso: future, timeZone: "Europe/Berlin" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("QUOTA_EXHAUSTED");
    // Nothing reserved, nothing queued, nothing sent.
    expect(db.daily_usage.find((d) => d.date === usageDate)!.emails_reserved).toBe(0);
    expect(db.bew_applications.every((a) => a.status === "generated")).toBe(true);
    expect(db.sendLog).toHaveLength(0);
  });
});

describe("listSendingBewCampaigns — due-aware selection (scheduled-batch starvation regression)", () => {
  /** Minimal campaign row for selection tests (only the read columns matter). */
  function seedRow(id: string, over: Partial<Row> = {}) {
    db.bew_campaigns.push({
      id,
      user_id: USER,
      status: "sending",
      started_at: null,
      scheduled_at: null,
      ...over,
    });
  }
  const pastIso = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const futureIso = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

  it("lists a scheduled batch that is NOW DUE (started_at null by design)", async () => {
    seedRow("camp-due", { scheduled_at: pastIso() });
    expect(await listSendingBewCampaigns()).toEqual([{ id: "camp-due", user_id: USER }]);
  });

  it("excludes a scheduled batch that is NOT yet due (nothing is claimable yet)", async () => {
    seedRow("camp-pending", { scheduled_at: futureIso() });
    expect(await listSendingBewCampaigns()).toEqual([]);
  });

  it("a due scheduled batch is not starved behind in-flight campaigns at the tick cap", async () => {
    seedRow("camp-inf-1", { started_at: pastIso() });
    seedRow("camp-inf-2", { started_at: pastIso() });
    seedRow("camp-inf-3", { started_at: pastIso() });
    seedRow("camp-due", { scheduled_at: pastIso() });

    // Even with due-aware ordering, at the OLD cap of 3 the due batch still
    // falls behind the three in-flight rows — which is why the cap had to be
    // raised to 10 together with the ordering fix (both halves of the fix).
    const oldCap = await listSendingBewCampaigns(3);
    expect(oldCap.map((c) => c.id)).toEqual(["camp-inf-1", "camp-inf-2", "camp-inf-3"]);

    // At the tick's cap (10): in-flight first (unchanged priority), then the
    // due batch — the regression where the pending batch sat behind the cap.
    const listed = await listSendingBewCampaigns(10);
    expect(listed.map((c) => c.id)).toEqual(["camp-inf-1", "camp-inf-2", "camp-inf-3", "camp-due"]);
  });

  it("keeps in-flight campaigns in FIFO order by started_at", async () => {
    seedRow("camp-new", { started_at: new Date(Date.now() - 30 * 60 * 1000).toISOString() });
    seedRow("camp-old", { started_at: new Date(Date.now() - 120 * 60 * 1000).toISOString() });
    const listed = await listSendingBewCampaigns();
    expect(listed.map((c) => c.id)).toEqual(["camp-old", "camp-new"]);
  });

  it("orders due batches by scheduled_at ascending (longest-waiting first)", async () => {
    seedRow("camp-far", { scheduled_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    seedRow("camp-near", { scheduled_at: new Date(Date.now() - 15 * 60 * 1000).toISOString() });
    const listed = await listSendingBewCampaigns();
    expect(listed.map((c) => c.id)).toEqual(["camp-far", "camp-near"]);
  });

  it("lists an in-flight campaign that STARTED from a schedule exactly once (no duplicate)", async () => {
    // After the first real claim the row carries BOTH timestamps.
    seedRow("camp-started-from-schedule", { started_at: pastIso(), scheduled_at: pastIso() });
    expect(await listSendingBewCampaigns()).toEqual([
      { id: "camp-started-from-schedule", user_id: USER },
    ]);
  });

  it("drains timestamp-less legacy rows last (never stranded, never prioritized)", async () => {
    seedRow("camp-legacy");
    seedRow("camp-inf", { started_at: pastIso() });
    seedRow("camp-due", { scheduled_at: pastIso() });
    const listed = await listSendingBewCampaigns();
    expect(listed.map((c) => c.id)).toEqual(["camp-inf", "camp-due", "camp-legacy"]);
  });

  it("on a database without the scheduled_at column the read degrades to the in-flight list — never empty", async () => {
    seedRow("camp-inf", { started_at: pastIso() });
    seedRow("camp-due", { scheduled_at: pastIso() });
    db.failLte = true; // the due/legacy reads fail as on a pre-20261116 database
    expect(await listSendingBewCampaigns()).toEqual([{ id: "camp-inf", user_id: USER }]);
  });
});

describe("generateBewLetters — one distinct letter per company", () => {
  const profile = { id: USER, full_name: "Max Mustermann", email: "max@example.de", account_status: "active" } as any;

  it("generates a unique letter per company and reserves AI usage per letter", async () => {
    seedCampaign({ status: "draft" });
    seedDocuments();
    seedApp(1, { status: "pending", company_name: "ACME", company_email: "a@acme.de" });
    seedApp(2, { status: "pending", company_name: "GLOBE", company_email: "g@globe.de" });
    db.aiScripts = ["Ich bewerbe mich bei ACME.", "Ich bewerbe mich bei GLOBE."];

    const result = await generateBewLetters(USER, CAMPAIGN, profile, { limit: 5 });
    expect(result.generated).toBe(2);
    expect(result.failed).toBe(0);
    expect(db.aiRemaining).toBe(98); // two AI reservations
    const [a1, a2] = db.bew_applications;
    expect(a1.status).toBe("generated");
    expect(a2.status).toBe("generated");
    expect(a1.body_html).toContain("ACME");
    expect(a2.body_html).toContain("GLOBE");
    expect(a1.body_html).not.toBe(a2.body_html);
    expect(a1.body_html).toContain("Sehr geehrte Damen und Herren,"); // neutral (no contact)
    expect(a1.body_html).toContain("Max Mustermann"); // profile signature
  });

  it("partial failure marks only the failed app; retry regenerates ONLY the failed one (no duplicate)", async () => {
    seedCampaign({ status: "draft" });
    seedDocuments();
    seedApp(1, { status: "pending", company_name: "ACME" });
    seedApp(2, { status: "pending", company_name: "GLOBE" });
    // First run: app1 ok, app2 AI throws.
    db.aiScripts = ["ACME body", () => new Error("AI down")];
    const first = await generateBewLetters(USER, CAMPAIGN, profile, { limit: 5 });
    expect(first.generated).toBe(1);
    expect(first.failed).toBe(1);
    expect(db.bew_applications[0].status).toBe("generated");
    expect(db.bew_applications[1].status).toBe("failed");

    // Retry ONLY the failed ones.
    db.aiScripts = ["GLOBE body retry"];
    const second = await generateBewLetters(USER, CAMPAIGN, profile, { limit: 5, onlyFailed: true });
    expect(second.generated).toBe(1);
    expect(db.bew_applications[0].body_html).toContain("ACME body"); // untouched (not regenerated)
    expect(db.bew_applications[1].status).toBe("generated");
    expect(db.bew_applications[1].body_html).toContain("GLOBE body retry");
  });

  it("stops cleanly on the AI daily quota (parks remaining as pending, reports aiQuotaHit)", async () => {
    seedCampaign({ status: "draft" });
    seedDocuments();
    seedApp(1, { status: "pending" });
    seedApp(2, { status: "pending" });
    db.aiRemaining = 1; // only one AI request left
    db.aiScripts = ["first body", "never used"];
    const result = await generateBewLetters(USER, CAMPAIGN, profile, { limit: 5 });
    expect(result.aiQuotaHit).toBe(true);
    expect(result.generated).toBe(1);
    expect(db.bew_applications[1].status).toBe("pending"); // parked, not failed
    expect(db.bew_applications[1].error_code).toBe("ai_quota");
  });
});

describe("cancelBewSend — release reserved quota for queued apps", () => {
  it("cancels queued applications and releases their quota", async () => {
    seedCampaign({ status: "sending" });
    seedDocuments();
    seedApp(1, { status: "queued" });
    seedApp(2, { status: "queued" });
    seedApp(3, { status: "sent" });
    daily(db, USER).emails_reserved = 2; // reserved for the two queued
    const { cancelled } = await cancelBewSend(USER, CAMPAIGN);
    expect(cancelled).toBe(2);
    expect(db.bew_applications.filter((a) => a.status === "cancelled")).toHaveLength(2);
    expect(db.bew_applications.find((a) => a.status === "sent")).toBeTruthy();
    expect(daily(db, USER).emails_reserved).toBe(0);
    expect(db.bew_campaigns[0].status).toBe("cancelled");
  });
});

/* ------------------------------------------------------------------ *
 * Step 2 — personal documents: ownership, validation, reuse
 * ------------------------------------------------------------------ */

function makeFile(name: string, type: string, bytes = 1024) {
  return new File([Buffer.alloc(bytes, 1)], name, { type });
}

describe("personal documents (step 2) — ownership + validation", () => {
  it("uploads under an owner-scoped path and records a library row", async () => {
    const doc = await uploadBewDocument(USER, makeFile("cv.pdf", "application/pdf"), "cv");
    expect(doc.user_id).toBe(USER);
    expect(doc.kind).toBe("cv");
    // Owner-scoped: the storage path is namespaced by the uploader's id.
    expect(db.uploads).toHaveLength(1);
    expect(db.uploads[0]).toBe(`${USER}/doc-cv.pdf`);
    expect(doc.storage_path).toBe(`${USER}/doc-cv.pdf`);
  });

  it("rejects an unsupported MIME type before any storage write", async () => {
    await expect(
      uploadBewDocument(USER, makeFile("malware.exe", "application/x-msdownload"), "cv"),
    ).rejects.toThrow("DOCUMENT_UNSUPPORTED");
    expect(db.uploads).toHaveLength(0); // nothing touched storage
    expect(db.bew_documents).toHaveLength(0);
  });

  it("rejects an oversized file before any storage write", async () => {
    await expect(
      uploadBewDocument(USER, makeFile("big.pdf", "application/pdf", 11 * 1024 * 1024), "cv"),
    ).rejects.toThrow("DOCUMENT_TOO-LARGE");
    expect(db.uploads).toHaveLength(0);
  });

  it("rejects an invalid kind", async () => {
    await expect(
      uploadBewDocument(USER, makeFile("cv.pdf", "application/pdf"), "invoice" as any),
    ).rejects.toThrow("INVALID_KIND");
  });

  it("compensates (removes) the storage object when the metadata insert fails", async () => {
    db.insertFailTables.add("bew_documents");
    // DOC_SAVE_FAILED: stable category (localizable in the UI) — the raw
    // "Unable to register the document." text must never reach the client.
    await expect(
      uploadBewDocument(USER, makeFile("cv.pdf", "application/pdf"), "cv"),
    ).rejects.toThrow("DOC_SAVE_FAILED");
    // The upload happened …
    expect(db.uploads).toHaveLength(1);
    // …and was compensated by removing the same path, leaving no orphan.
    expect(db.removedPaths).toEqual(db.uploads);
    expect(db.bew_documents).toHaveLength(0);
    db.insertFailTables.clear();
  });

  it("lists ONLY the caller's own documents (cross-user isolation)", async () => {
    await uploadBewDocument(USER, makeFile("mine.pdf", "application/pdf"), "cv");
    await uploadBewDocument("user-2", makeFile("theirs.pdf", "application/pdf"), "cv");
    const mine = await listBewDocuments(USER);
    const theirs = await listBewDocuments("user-2");
    expect(mine).toHaveLength(1);
    expect(mine[0].filename).toBe("mine.pdf");
    expect(theirs).toHaveLength(1);
    expect(theirs[0].filename).toBe("theirs.pdf");
    // No cross-leakage.
    expect(mine.some((d) => d.filename === "theirs.pdf")).toBe(false);
  });

  it("refuses to attach a document owned by ANOTHER user to a campaign", async () => {
    seedCampaign({ status: "draft" });
    // user-2 owns this document.
    await uploadBewDocument("user-2", makeFile("theirs.pdf", "application/pdf"), "cv");
    const foreign = db.bew_documents.find((d) => d.filename === "theirs.pdf")!;
    // USER tries to attach user-2's doc to USER's own campaign.
    await expect(
      attachBewDocument(USER, CAMPAIGN, foreign.id, "cv"),
    ).rejects.toThrow("NOT_FOUND");
    expect(db.bew_campaign_documents).toHaveLength(0);
  });

  it("attaches the owner's own document and reuses it across the campaign", async () => {
    seedCampaign({ status: "draft" });
    const doc = await uploadBewDocument(USER, makeFile("cv.pdf", "application/pdf"), "cv");
    const attached = await attachBewDocument(USER, CAMPAIGN, doc.id, "cv");
    expect(attached.campaign_id).toBe(CAMPAIGN);
    expect(attached.document_id).toBe(doc.id);
    // Detaching removes the campaign link but KEEPS the library file.
    await detachBewDocument(USER, CAMPAIGN, doc.id);
    expect(db.bew_campaign_documents).toHaveLength(0);
    expect(db.bew_documents.some((d) => d.id === doc.id)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Step 4 — restore an excluded application (keeps a complete letter)
 * ------------------------------------------------------------------ */

describe("restoreBewApplication (step 4)", () => {
  it("restores an excluded app WITH a complete letter back to 'generated'", async () => {
    seedCampaign({ status: "draft" });
    seedApp(1, { status: "excluded", body_html: "<p>Letter</p>", company_email: "jobs1@firma1.de" });
    const restored = await restoreBewApplication(USER, "app-1");
    expect(restored?.status).toBe("generated");
  });

  it("restores an excluded app WITHOUT a letter to 'pending' (regenerate)", async () => {
    seedCampaign({ status: "draft" });
    seedApp(1, { status: "excluded", body_html: "", company_email: "jobs1@firma1.de" });
    const restored = await restoreBewApplication(USER, "app-1");
    expect(restored?.status).toBe("pending");
  });

  it("restores an excluded app with an INVALID e-mail to 'pending' (not sendable)", async () => {
    seedCampaign({ status: "draft" });
    seedApp(1, { status: "excluded", body_html: "<p>Letter</p>", company_email: "not-an-email" });
    const restored = await restoreBewApplication(USER, "app-1");
    expect(restored?.status).toBe("pending");
  });

  it("refuses to restore an app that is not excluded (locked)", async () => {
    seedCampaign({ status: "draft" });
    seedApp(1, { status: "generated", body_html: "<p>Letter</p>" });
    await expect(restoreBewApplication(USER, "app-1")).rejects.toThrow("APPLICATION_LOCKED");
  });

  it("returns null for a foreign application (ownership)", async () => {
    seedCampaign({ status: "draft" });
    seedApp(1, { status: "excluded", user_id: "user-2" });
    const result = await restoreBewApplication(USER, "app-1");
    expect(result).toBeNull();
  });
});
