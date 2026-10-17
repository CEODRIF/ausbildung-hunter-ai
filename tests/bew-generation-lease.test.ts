/**
 * Generation lease + bounded quality attempts (engine, in-memory — no real
 * Supabase, no real e-mail, no real/paid AI).
 *
 * Pins the safety contract: a stuck "generating" row is reclaimable and can
 * never overwrite a letter that is already generated/sent; and a letter that
 * fails the deterministic quality gate gets AT MOST two attempts before it
 * becomes a clear, terminal quality failure (never silently accepted).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;

interface DB {
  profiles: Row[];
  candidate_profiles: Row[];
  bew_campaigns: Row[];
  bew_applications: Row[];
  bew_documents: Row[];
  bew_campaign_documents: Row[];
  aiRemaining: number;
  aiScripts: Array<string | (() => Error)>;
  pdfText: string;
}

const USER = "user-1";
const CAMPAIGN = "camp-1";
const NOW = () => new Date().toISOString();
const MIN = 60 * 1000;

function freshDb(): DB {
  return {
    profiles: [
      {
        id: USER,
        full_name: "Max Mustermann",
        email: "max@example.de",
        street: "Musterstraße 12",
        postal_code: "10115",
        city: "Berlin",
        country: "Deutschland",
        phone: "+49 151 0000000",
        account_status: "active",
      },
    ],
    candidate_profiles: [], // no scanned CV → engine falls back to the raw CV text
    bew_campaigns: [],
    bew_applications: [],
    bew_documents: [],
    bew_campaign_documents: [],
    aiRemaining: 100,
    aiScripts: [],
    pdfText: "LEBENSLAUF: Max Mustermann, Fachinformatiker, Berlin. Python, HTML, CSS, Teamfähigkeit.",
  };
}

let db: DB;

/* ------------------- In-memory Supabase-style query builder ------------------- */
function makeFrom(table: string) {
  const state = {
    op: "select" as "select" | "update" | "insert" | "delete" | "upsert",
    payload: undefined as any,
    filters: [] as Array<{ col: string; val: any }>,
    inFilters: [] as Array<{ col: string; values: any[] }>,
    ltFilters: [] as Array<{ col: string; val: any }>,
    orderBy: [] as Array<{ col: string; ascending: boolean }>,
    limitN: undefined as number | undefined,
    terminal: undefined as "single" | "maybeSingle" | undefined,
  };
  const bucket = (): Row[] => ((db as unknown as Record<string, Row[]>)[table] ?? []);
  function rows(): Row[] {
    let out = bucket().slice();
    for (const f of state.filters) out = out.filter((r: Row) => r[f.col] === f.val);
    for (const f of state.inFilters) out = out.filter((r: Row) => f.values.includes(r[f.col]));
    for (const f of state.ltFilters) out = out.filter((r: Row) => r[f.col] != null && r[f.col] < f.val);
    if (state.orderBy.length)
      out.sort((a: Row, b: Row) => {
        for (const o of state.orderBy) {
          const dir = o.ascending ? 1 : -1;
          if (a[o.col] < b[o.col]) return -1 * dir;
          if (a[o.col] > b[o.col]) return 1 * dir;
        }
        return 0;
      });
    if (state.limitN != null) out = out.slice(0, state.limitN);
    return out;
  }
  async function run(): Promise<any> {
    if (state.op === "insert") {
      const items = Array.isArray(state.payload) ? state.payload : [state.payload];
      const ins = items.map((r) => ({ ...r, id: r.id ?? `id-${Math.random()}` }));
      ((db as unknown as Record<string, Row[]>)[table] ??= []).push(...ins);
      return state.terminal === "single" ? { data: ins[0], error: null } : { data: ins, error: null };
    }
    if (state.op === "update") {
      const matched = rows();
      for (const m of matched) Object.assign(m, state.payload);
      if (state.terminal) return { data: matched[0] ?? null, error: null };
      return { data: matched, error: null };
    }
    if (state.op === "delete") {
      const matched = new Set(rows());
      const rec = db as unknown as Record<string, Row[]>;
      rec[table] = (rec[table] ?? []).filter((r: Row) => !matched.has(r));
      return { data: null, error: null };
    }
    // select
    const matched = rows();
    if (state.terminal) return { data: matched[0] ?? null, error: null };
    return { data: matched, error: null };
  }
  const chain: any = {
    eq: (col: string, val: any) => (state.filters.push({ col, val }), chain),
    in: (col: string, values: any[]) => (state.inFilters.push({ col, values }), chain),
    is: (col: string, val: any) => (state.filters.push({ col, val }), chain),
    lt: (col: string, val: any) => (state.ltFilters.push({ col, val }), chain),
    order: (col: string, o?: { ascending?: boolean }) => (state.orderBy.push({ col, ascending: o?.ascending ?? true }), chain),
    limit: (n: number) => (state.limitN = n, chain),
    select: () => chain,
    insert: (p: any) => ((state.op = "insert"), (state.payload = p), chain),
    update: (p: any) => ((state.op = "update"), (state.payload = p), chain),
    delete: () => ((state.op = "delete"), chain),
    single: () => ((state.terminal = "single"), chain),
    maybeSingle: () => ((state.terminal = "maybeSingle"), chain),
    then: (onF?: any, onR?: any) => run().then(onF, onR),
  };
  return chain;
}

vi.doMock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => makeFrom(table),
    rpc: () => Promise.resolve({ data: null, error: null }),
    storage: {
      from: () => ({
        download: async () => ({ data: { arrayBuffer: async () => new Uint8Array([1]).buffer }, error: null }),
        upload: async () => ({ error: null }),
        remove: async () => ({ error: null }),
      }),
    },
  }),
}));
vi.doMock("@/lib/ai-provider", () => ({
  createAIProvider: () => ({
    generateText: async () => {
      const s = db.aiScripts.shift();
      if (!s) return "Generischer Text.";
      if (typeof s === "function") throw s();
      return s;
    },
  }),
}));
vi.doMock("@/lib/ai-service", () => ({
  reserveAIUsage: async () => {
    if (db.aiRemaining <= 0) throw new Error("AI daily request limit reached. Please try again tomorrow.");
    db.aiRemaining -= 1;
  },
  storagePath: () => "x",
}));
vi.doMock("@/lib/pdf-extract", () => ({ extractPdfText: async () => db.pdfText }));
vi.doMock("@/lib/application-drafts", () => ({
  sanitizeEmailHtml: (h: string) => h,
  htmlToText: (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
}));
vi.doMock("@/lib/email-campaigns", () => ({
  getUsageSnapshot: async () => ({ remaining: 10, daily_limit: 50 }),
  reserveSenderSlot: async () => true,
}));
vi.doMock("@/lib/email-providers", () => ({
  createEmailProvider: async () => ({ sendEmail: async () => ({ ok: true, id: "m" }) }),
}));
vi.doMock("@/lib/bew-letter-pdf", () => ({
  BEW_ATTACHMENT_BUCKET: "b",
  ensureLetterPdf: async () => {},
  deleteLetterPdf: async () => {},
  letterPdfStoragePath: () => "p",
}));
vi.doMock("mammoth", () => ({ default: { extractRawText: async () => ({ value: "docx" }) } }));
vi.doMock("@/lib/contact-name-support", () => ({
  hasApplicantProfileColumns: () => Promise.resolve(true),
}));

const { generateBewLetters, reclaimStaleGenerating, resetBewPositionColumnsProbe } = await import("@/lib/bewerbung-engine");
const { createAdminClient } = await import("@/lib/supabase/admin");

function seedCampaign(status = "draft") {
  db.bew_campaigns.push({
    id: CAMPAIGN,
    user_id: USER,
    email_account_id: "acct-1",
    purpose: "ausbildung",
    status,
    requested_count: 1,
    valid_count: 1,
    total_count: 1,
    generated_count: 0,
    sent_count: 0,
    failed_count: 0,
    excluded_count: 0,
    usage_date: NOW().slice(0, 10),
    created_at: NOW(),
    started_at: null,
    completed_at: null,
    email_subject: "Bewerbung bei {{company_name}}",
    email_body_html: "<p>anbei meine Bewerbung.</p>",
    position_title: "Fachinformatikerin für Anwendungsentwicklung",
    position_brief: "Entwicklung moderner Webanwendungen",
    employer_facts: "",
  });
}
function seedDocs() {
  db.bew_documents.push({ id: "cv", user_id: USER, storage_path: `${USER}/cv.pdf`, filename: "cv.pdf", mime_type: "application/pdf", size_bytes: 10, kind: "cv" });
  db.bew_documents.push({ id: "cert", user_id: USER, storage_path: `${USER}/c.pdf`, filename: "c.pdf", mime_type: "application/pdf", size_bytes: 10, kind: "certificate" });
  db.bew_campaign_documents.push({ id: "d1", campaign_id: CAMPAIGN, document_id: "cv", user_id: USER, kind: "cv", storage_path: `${USER}/cv.pdf`, filename: "cv.pdf", mime_type: "application/pdf", size_bytes: 10 });
  db.bew_campaign_documents.push({ id: "d2", campaign_id: CAMPAIGN, document_id: "cert", user_id: USER, kind: "certificate", storage_path: `${USER}/c.pdf`, filename: "c.pdf", mime_type: "application/pdf", size_bytes: 10 });
}
function seedApp(seq: number, over: Partial<Row> = {}) {
  db.bew_applications.push({
    id: `app-${seq}`,
    campaign_id: CAMPAIGN,
    user_id: USER,
    seq,
    company_name: "ACME GmbH",
    contact_name: null,
    company_email: "jobs@acme.de",
    company_address: null,
    subject: "",
    body_html: "",
    body_text: "",
    status: "pending",
    error_code: null,
    error_message: null,
    attempt_count: 0,
    next_attempt_at: null,
    provider_message_id: null,
    sent_at: null,
    position_title: null,
    position_brief: null,
    employer_facts: null,
    quality_attempts: 0,
    generation_started_at: null,
    created_at: NOW(),
    updated_at: NOW(),
    ...over,
  });
}

/** A body that PASSES the deterministic gate (long enough, references role + employer). */
const GOOD_BODY =
  "Ihre Ausschreibung für die Ausbildung als Fachinformatikerin für Anwendungsentwicklung bei ACME " +
  "GmbH hat mich überzeugt, weil ich im Schulpraktikum eigene Webanwendungen mit HTML, CSS und " +
  "JavaScript entwickelt habe und Python sicher beherrsche. Dabei habe ich gelernt, Anforderungen " +
  "sauber in Code umzusetzen und in einem kleinen Team zusammenzuarbeiten — genau die Bereiche, die " +
  "in der Stellenbeschreibung betont werden. In der Schule erreichte ich im Fach Informatik " +
  "durchgehend gute Noten. Ich freue mich sehr über die Einladung zu einem persönlichen Gespräch " +
  "und darauf, Ihr Team zu unterstützen.";
/** A body that FAILS the deterministic gate (a single token → too_short). */
const BAD_BODY = "x";

beforeEach(() => {
  db = freshDb();
  resetBewPositionColumnsProbe();
});

/* ------------------------------------------------------------------ */
describe("bounded quality attempts", () => {
  const profileArg = { id: USER, full_name: "Max Mustermann", email: "max@example.de", account_status: "active" } as any;

  it("accepts on the second attempt after the first fails the gate", async () => {
    seedCampaign();
    seedDocs();
    seedApp(1);
    db.aiScripts = [BAD_BODY, GOOD_BODY];

    const res = await generateBewLetters(USER, CAMPAIGN, profileArg, { limit: 5 });
    expect(res.generated).toBe(1);
    expect(res.failed).toBe(0);
    const app = db.bew_applications[0];
    expect(app.status).toBe("generated");
    expect(app.quality_attempts).toBe(2);
    expect(db.aiRemaining).toBe(98); // two AI calls
    expect(app.body_html).toContain("ACME");
  });

  it("terminates with a clear quality_gate failure when two attempts both fail", async () => {
    seedCampaign();
    seedDocs();
    seedApp(1);
    db.aiScripts = [BAD_BODY, BAD_BODY];

    const res = await generateBewLetters(USER, CAMPAIGN, profileArg, { limit: 5 });
    expect(res.generated).toBe(0);
    expect(res.failed).toBe(1);
    const app = db.bew_applications[0];
    expect(app.status).toBe("failed");
    expect(app.error_code).toBe("quality_gate");
    expect(app.quality_attempts).toBe(2);
    expect(app.body_html).toBe(""); // no weak letter is stored
    expect(db.aiRemaining).toBe(98);
  });

  it("still fails on a provider error (not a quality failure)", async () => {
    seedCampaign();
    seedDocs();
    seedApp(1);
    db.aiScripts = [() => new Error("AI down")];

    const res = await generateBewLetters(USER, CAMPAIGN, profileArg, { limit: 5 });
    expect(res.failed).toBe(1);
    expect(db.bew_applications[0].status).toBe("failed");
    expect(db.bew_applications[0].error_code).toBe("generation_failed");
  });
});

/* ------------------------------------------------------------------ */
describe("stale-generation recovery", () => {
  it("reclaims a long-stuck 'generating' row back to 'pending'", async () => {
    seedCampaign("completed");
    seedApp(1, { status: "generating", generation_started_at: new Date(Date.now() - 11 * MIN).toISOString() });
    const admin: any = createAdminClient();
    const n = await reclaimStaleGenerating(admin, USER, CAMPAIGN);
    expect(n).toBe(1);
    expect(db.bew_applications[0].status).toBe("pending");
    expect(db.bew_applications[0].generation_started_at).toBe(null);
  });

  it("does NOT reclaim a recent 'generating' row (lease still valid)", async () => {
    seedCampaign("completed");
    seedApp(1, { status: "generating", generation_started_at: NOW() });
    const admin: any = createAdminClient();
    expect(await reclaimStaleGenerating(admin, USER, CAMPAIGN)).toBe(0);
    expect(db.bew_applications[0].status).toBe("generating");
  });

  it("NEVER overwrites a letter that already has a body or was sent", async () => {
    seedCampaign("completed");
    seedApp(1, { status: "generating", generation_started_at: new Date(Date.now() - 11 * MIN).toISOString(), body_html: "<p>fertig</p>" });
    seedApp(2, { status: "sent", generation_started_at: new Date(Date.now() - 11 * MIN).toISOString(), body_html: "<p>gesendet</p>", sent_at: NOW() });
    const admin: any = createAdminClient();
    expect(await reclaimStaleGenerating(admin, USER, CAMPAIGN)).toBe(0);
    expect(db.bew_applications[0].body_html).toBe("<p>fertig</p>");
    expect(db.bew_applications[1].status).toBe("sent");
  });

  it("reclaims multiple stuck rows at once and is idempotent on a second sweep", async () => {
    seedCampaign("completed");
    const old = new Date(Date.now() - 12 * MIN).toISOString();
    seedApp(1, { status: "generating", generation_started_at: old });
    seedApp(2, { status: "generating", generation_started_at: old });
    const admin: any = createAdminClient();
    expect(await reclaimStaleGenerating(admin, USER, CAMPAIGN)).toBe(2);
    expect(await reclaimStaleGenerating(admin, USER, CAMPAIGN)).toBe(0);
    expect(db.bew_applications.filter((a) => a.status === "pending")).toHaveLength(2);
  });

  it("only reclaims its own user's stuck rows (ownership)", async () => {
    seedCampaign("completed");
    const old = new Date(Date.now() - 11 * MIN).toISOString();
    seedApp(1, { status: "generating", generation_started_at: old }); // user-1
    db.bew_applications.push({ ...db.bew_applications[0], id: "other", user_id: "user-2" }); // user-2
    const admin: any = createAdminClient();
    // user-1 sweep reclaims ONLY its own row.
    expect(await reclaimStaleGenerating(admin, USER, CAMPAIGN)).toBe(1);
    // The other user's row is untouched.
    expect(db.bew_applications.find((a) => a.id === "other")!.status).toBe("generating");
    // user-2 sweep then reclaims its own row.
    expect(await reclaimStaleGenerating(admin, "user-2", CAMPAIGN)).toBe(1);
  });
});
