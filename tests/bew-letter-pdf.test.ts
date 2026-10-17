/**
 * Bewerbung Automation — Anschreiben PDF regression suite.
 *
 * PRODUCTION GAP
 *   The review step showed the stored letter as RAW HTML in a textarea
 *   (`<p>…</p>` markup visible to the user), and the outgoing e-mail attached
 *   only the CV + certificates — the recipient never received a letter file.
 *
 * THE CONTRACT THIS SUITE PINS
 *   1. A REAL, VALID A4 PDF is generated per application (pdf-lib output,
 *      loadable, A4 size) matching the reference layout: sender block
 *      (name + e-mail, right-aligned, UPPERCASE), German date, recipient
 *      block (company/contact/address — only stored data, nothing invented),
 *      bold subject, formal greeting, justified body, closing + signature
 *      (kept together across page breaks).
 *   2. The UI never renders raw HTML: the preview is plain text (entities
 *      decoded, tags removed); editing is structured fields; save re-escapes.
 *   3. Every outgoing e-mail carries the CV, the certificates AND the
 *      generated `Anschreiben_<Company>.pdf` for THAT company (per-company
 *      pairing; deterministic sanitized file names).
 *   4. Persistence: deterministic owner-scoped path in the EXISTING
 *      `application-attachments` bucket — no migration, no new bucket.
 *      No duplicate generation; orphans (deleted/corrupt objects) are healed;
 *      edits re-write the SAME path; generation/storage failure returns null
 *      and the send path BLOCKS the application with `pdf_generation_failed`
 *      (no e-mail, quota released, not retried).
 *
 * No real e-mail, no real Supabase, no real AI. PDF extraction uses the
 * project's REAL `extractPdfText` (pdf.js) so the assertions prove readable
 * content, not a mock echo.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */

/* ------------------------------------------------------------------ *
 * In-memory fake (engine side) — same harness style as
 * bew-send-engine.test.ts, plus a content-addressed storage object map.
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

interface StorageState {
  objects: Map<string, { bytes: Uint8Array; contentType: string }>;
  failUploads: boolean;
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
  aiScripts: string[];
  /** Scripted provider message ids, consumed one per sendEmail call. */
  sendScripts: string[];
  /** Attachment file names at each createEmailProvider call. */
  providerAttachments: string[][];
  /** Every message handed to the provider (the "out the door" log). */
  sendLog: Array<{ to: string; subject: string; attachmentFiles: string[] }>;
}

const USER = "user-1";
const OTHER = "user-2";
const CAMPAIGN = "camp-1";
const TODAY = new Date().toISOString().slice(0, 10);
const FIX_DATE = new Date(Date.UTC(2026, 9, 17));

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
    profiles: [
      { id: USER, full_name: "Max Mustermann", email: "max@example.de" },
    ],
    storage: { objects: new Map(), failUploads: false, lastBucket: null, uploadCount: 0, removedPaths: [] },
    slotFree: true,
    aiRemaining: 100,
    aiScripts: [],
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

/** Minimal chainable query builder over the in-memory tables. */
function makeFrom(table: TableKey) {
  const state = {
    op: "select" as string,
    payload: undefined as any,
    filters: [] as Array<{ col: string; val: any }>,
    inFilters: [] as Array<{ col: string; values: any[] }>,
    orderBy: [] as Array<{ col: string; ascending: boolean }>,
    limitN: undefined as number | undefined,
    selectOpts: undefined as any,
    terminal: undefined as "single" | "maybeSingle" | undefined,
    upsertConf: undefined as any,
  };

  function rows(): Row[] {
    let out = (db[table] ?? []).slice();
    for (const f of state.filters) out = out.filter((r) => r[f.col] === f.val);
    for (const f of state.inFilters) out = out.filter((r) => f.values.includes(r[f.col]));
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
      const existing = (db[table] ?? []).find((r) =>
        conf.every((c) => r[c.trim()] === state.payload[c.trim()]),
      );
      if (existing) Object.assign(existing, state.payload);
      else (db[table] ??= []).push({ ...state.payload, id: `id-${Math.random()}` });
      return { data: existing ?? db[table][db[table].length - 1], error: null };
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
              return { error: { message: "simulated storage outage" } };
            db.storage.objects.set(path, {
              bytes,
              contentType: opts?.contentType ?? "application/octet-stream",
            });
            return { error: null };
          },
          remove: async (paths: string[]) => {
            for (const p of paths ?? []) {
              db.storage.removedPaths.push(p);
              db.storage.objects.delete(p);
            }
            return { error: null };
          },
          download: async (path: string) => {
            const obj = db.storage.objects.get(path);
            if (!obj) return { data: null, error: { message: "not found" } };
            const blob = new Blob([obj.bytes as any]);
            return { data: blob, error: null };
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
  // Mirrors the REAL contract: the provider pre-fetches the files given at
  // construction; a path missing from storage fails with attachment_unavailable.
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
        db.sendLog.push({
          to: input.to,
          subject: input.subject,
          attachmentFiles: db.providerAttachments[db.providerAttachments.length - 1],
        });
        return { providerMessageId: script };
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
    generateText: async (_messages: any) => {
      const script = db.aiScripts.shift();
      return script ?? "Generischer Text.";
    },
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

// NOTE: `@/lib/pdf-extract` is deliberately NOT mocked — the content
// assertions run against the project's REAL pdf.js extraction.

const {
  buildLetterFolio,
  deleteLetterPdf,
  ensureLetterPdf,
  generateLetterPdf,
  letterPdfFilename,
  letterPdfStoragePath,
} = await import("@/lib/bew-letter-pdf");
const {
  generateBewLetters,
  processBewSendBatch,
  updateBewLetter,
} = await import("@/lib/bewerbung-engine");
const { htmlToParagraphs, splitLetterParagraphs } = await import("@/lib/bewerbung-automation");
const { extractPdfText } = await import("@/lib/pdf-extract");
const { buildGermanCvPdf } = await import("./fixtures/de-cv");

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** A tiny real single-page PDF (certificate fixture). */
async function simplePdf(text: string): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const page = d.addPage([595.28, 841.89]);
  const f = await d.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 65, y: 800, size: 12, font: f });
  return d.save();
}

const profileArg = {
  id: USER,
  full_name: "Max Mustermann",
  email: "max@example.de",
} as any;

/** The canonical stored letter shape (what `assembleLetter` produces). */
function letterHtml(company: string, extraBody = ""): string {
  return [
    "<p>Sehr geehrte Damen und Herren,</p>",
    `<p>Ich bewerbe mich bei der ${company} um den Ausbildungsplatz.</p>`,
    extraBody,
    "<p>Mit freundlichen Grüßen</p>",
    "<p>Max Mustermann</p>",
  ]
    .filter(Boolean)
    .join("");
}

function seedCampaign(over: Partial<Row> = {}) {
  db.bew_campaigns.push({
    id: CAMPAIGN,
    user_id: USER,
    email_account_id: "acct-1",
    purpose: "ausbildung",
    status: "draft",
    requested_count: 2,
    valid_count: 2,
    total_count: 2,
    generated_count: 0,
    sent_count: 0,
    failed_count: 0,
    excluded_count: 0,
    usage_date: TODAY,
    created_at: new Date().toISOString(),
    started_at: null,
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
    status: "generated",
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

/** CV + certificate documents with REAL pdf bytes (extraction works). */
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

/** The generated letter PDF bytes for an application (from the fake storage). */
function letterBytes(appId: string): Uint8Array {
  const path = letterPdfStoragePath(USER, appId);
  const obj = db.storage.objects.get(path);
  expect(obj, `storage object ${path} must exist`).toBeTruthy();
  return obj!.bytes;
}

/** Per-page text via the project's pdf.js (real extraction, page-granular). */
let pdfjsReady: Promise<void> | null = null;
async function pdfPageTexts(bytes: Uint8Array): Promise<string[]> {
  pdfjsReady ??= (async () => {
    await import("@napi-rs/canvas");
    await import("pdfjs-dist/legacy/build/pdf.mjs");
  })();
  await pdfjsReady;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await (pdfjs as any).getDocument({ data: new Uint8Array(bytes) }).promise;
  try {
    const out: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      out.push(content.items.map((it: any) => it.str).join(" "));
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

const REF_APP = {
  id: "app-ref",
  company_name: "MusterTech GmbH",
  contact_name: "Herrn Dr. Beispiel",
  company_address: "Musterstraße 12, 80331 München, Deutschland",
  subject: "Bewerbung um einen Ausbildungsplatz bei MusterTech GmbH",
  body_html: letterHtml("MusterTech GmbH"),
};

/** REF_APP-shaped (snake_case app row) → buildLetterFolio (camelCase input). */
function refFolio(over: Record<string, any> = {}) {
  const a = { ...REF_APP, ...over };
  return buildLetterFolio({
    applicantName: "Max Mustermann",
    applicantEmail: "max@example.de",
    date: FIX_DATE,
    companyName: a.company_name,
    companyContactName: a.contact_name ?? null,
    companyAddress: a.company_address ?? null,
    subject: a.subject,
    bodyHtml: a.body_html,
  });
}

beforeEach(() => {
  db = freshDb();
});

/* ------------------------------------------------------------------ *
 * A. The renderer: a real, valid A4 PDF in the reference layout
 * ------------------------------------------------------------------ */

describe("generateLetterPdf — valid A4 document matching the reference", () => {
  it("produces a loadable PDF with A4 page size", async () => {
    const bytes = await generateLetterPdf(refFolio());
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    const size = doc.getPage(0).getSize();
    expect(size.width).toBeCloseTo(595.28, 1);
    expect(size.height).toBeCloseTo(841.89, 1);
  }, 30000);

  it("contains sender, date, recipient, subject, greeting, body, closing — as plain text, never HTML", async () => {
    const bytes = await generateLetterPdf(refFolio());
    const flat = (await extractPdfText(bytes)).replace(/\s+/g, " ");
    for (const snippet of [
      "MAX MUSTERMANN", // sender name (UPPERCASE, top right)
      "max@example.de", // sender contact — a REAL profile field
      "17. Oktober 2026", // German date style of the reference
      "MusterTech GmbH", // recipient company
      "Herrn Dr. Beispiel", // recipient contact
      "Musterstraße 12", // address line (umlauts intact)
      "80331 München",
      "Bewerbung um einen Ausbildungsplatz bei MusterTech GmbH", // subject
      "Sehr geehrte Damen und Herren,", // formal greeting
      "Ich bewerbe mich bei der MusterTech GmbH um den Ausbildungsplatz.", // body
      "Mit freundlichen Grüßen", // closing
      "Max Mustermann", // signature
    ]) {
      expect(flat, `expected "${snippet}" in the PDF text`).toContain(snippet);
    }
    // No markup, no entities — the recipient gets a document, not HTML.
    expect(flat).not.toContain("<");
    expect(flat).not.toContain("&amp;");
  }, 30000);

  it("omits missing optional data cleanly (never invents names/addresses)", () => {
    const folio = buildLetterFolio({
      applicantName: "Max Mustermann",
      applicantEmail: null, // no e-mail in the profile
      companyName: "Globex AG",
      companyContactName: null, // no contact person
      companyAddress: null, // no address
      subject: "Bewerbung bei Globex AG",
      bodyHtml: letterHtml("Globex AG"),
    });
    expect(folio.senderLines).toEqual([]);
    expect(folio.companyContactName).toBeNull();
    expect(folio.companyAddressLines).toEqual([]);
    expect(folio.greeting).toBe("Sehr geehrte Damen und Herren,");
  });

  it("wraps long letters across pages and keeps closing + signature together", async () => {
    const longBody = Array.from({ length: 12 }, (_, i) =>
      `<p>Absatz ${i + 1}: ${"Hier folgt fundierter, praxisnaher Inhalt. ".repeat(7)}</p>`,
    ).join("");
    const folio = refFolio({
      body_html: `<p>Sehr geehrte Damen und Herren,</p>${longBody}<p>Mit freundlichen Grüßen</p><p>Max Mustermann</p>`,
    });
    const bytes = await generateLetterPdf(folio);
    const doc = await PDFDocument.load(bytes);
    const pageCount = doc.getPageCount();
    expect(pageCount).toBeGreaterThanOrEqual(2);
    const pages = await pdfPageTexts(bytes);
    // The closing block must not be split: the LAST page carries both the
    // closing line and the signature (the reference's awkward page break
    // between them is deliberately not reproduced).
    const last = pages[pages.length - 1].replace(/\s+/g, " ");
    expect(last).toContain("Mit freundlichen Grüßen");
    expect(last).toContain("Max Mustermann");
  }, 60000);
});

/* ------------------------------------------------------------------ *
 * B. Attachment names: meaningful + filename-safe
 * ------------------------------------------------------------------ */

describe("letterPdfFilename — sanitized, meaningful names", () => {
  it("keeps readable company names, strips unsafe characters", () => {
    expect(letterPdfFilename("Muster-Tech GmbH")).toBe("Anschreiben_Muster-Tech_GmbH.pdf");
    // Umlauts fold to their base letters (ö → o), never to "oe".
    expect(letterPdfFilename("Müller & Söhne AG")).toBe("Anschreiben_Muller_Sohne_AG.pdf");
    expect(letterPdfFilename("Café/Bistro: Köln")).toBe("Anschreiben_Cafe_Bistro_Koln.pdf");
    expect(letterPdfFilename("   ")).toBe("Anschreiben_Unternehmen.pdf");
    expect(letterPdfFilename(null)).toBe("Anschreiben_Unternehmen.pdf");
  });

  it("is ASCII-only (raw MIME headers) and bounded in length", () => {
    const name = letterPdfFilename("A very long international company name GmbH & Co. KG");
    expect(name).toMatch(/^Anschreiben_[A-Za-z0-9._ -]+\.pdf$/);
    expect(name.length).toBeLessThanOrEqual("Anschreiben_".length + 60 + ".pdf".length);
    for (const c of name) expect(c.charCodeAt(0), `non-ASCII char "${c}"`).toBeLessThan(128);
  });

  it("different companies → different file names", () => {
    const a = letterPdfFilename("MusterTech GmbH");
    const b = letterPdfFilename("Globex AG");
    expect(a).not.toBe(b);
  });
});

/* ------------------------------------------------------------------ *
 * C. ensureLetterPdf — persistence semantics (no duplicates, heals,
 *    owner-scoped, deterministic)
 * ------------------------------------------------------------------ */

describe("ensureLetterPdf — persistence in the existing bucket", () => {
  const input = () => ({
    userId: USER,
    app: REF_APP,
    applicant: { name: "Max Mustermann", email: "max@example.de" },
  });

  it("generates on first call at the deterministic owner-scoped path (existing bucket)", async () => {
    const before = db.storage.objects.size;
    const ref = await ensureLetterPdf(input());
    expect(ref).not.toBeNull();
    expect(ref!.storagePath).toBe(`${USER}/bew-anschreiben/app-ref.pdf`);
    expect(ref!.mimeType).toBe("application/pdf");
    expect(ref!.filename).toBe("Anschreiben_MusterTech_GmbH.pdf");
    expect(db.storage.lastBucket).toBe("application-attachments");
    expect(db.storage.objects.size).toBe(before + 1);
    const bytes = letterBytes("app-ref");
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
  }, 30000);

  it("does NOT regenerate while the object exists (no duplicate generation)", async () => {
    await ensureLetterPdf(input());
    const countAfterFirst = db.storage.uploadCount;
    const bytesAfterFirst = Buffer.from(letterBytes("app-ref"));
    const ref = await ensureLetterPdf(input());
    expect(ref!.storagePath).toBe(letterPdfStoragePath(USER, "app-ref"));
    expect(db.storage.uploadCount).toBe(countAfterFirst); // no second upload
    expect(Buffer.from(letterBytes("app-ref"))).toEqual(bytesAfterFirst); // unchanged
  }, 30000);

  it("heals an orphan: a deleted object is regenerated on the next ensure", async () => {
    await ensureLetterPdf(input());
    db.storage.objects.delete(letterPdfStoragePath(USER, "app-ref"));
    const ref = await ensureLetterPdf(input());
    expect(ref).not.toBeNull();
    expect(db.storage.objects.has(letterPdfStoragePath(USER, "app-ref"))).toBe(true);
  }, 30000);

  it("heals a corrupt object (non-PDF bytes are replaced)", async () => {
    await ensureLetterPdf(input());
    db.storage.objects.set(letterPdfStoragePath(USER, "app-ref"), {
      bytes: new TextEncoder().encode("this is not a pdf"),
      contentType: "application/pdf",
    });
    const ref = await ensureLetterPdf(input());
    expect(ref).not.toBeNull();
    const bytes = letterBytes("app-ref");
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
  }, 30000);

  it("force (letter edited) re-writes the SAME path — still exactly one object", async () => {
    const first = await ensureLetterPdf(input());
    expect(first).not.toBeNull();
    const bytesBefore = Buffer.from(letterBytes("app-ref"));
    const second = await ensureLetterPdf({
      ...input(),
      force: true,
      app: { ...REF_APP, body_html: letterHtml("MusterTech GmbH", "<p>Geänderter Absatz nach dem Edit.</p>") },
    });
    expect(second!.storagePath).toBe(first!.storagePath); // same object, no duplicate
    expect(db.storage.objects.size).toBe(1);
    const bytesAfter = Buffer.from(letterBytes("app-ref"));
    expect(Buffer.compare(bytesBefore, bytesAfter)).not.toBe(0); // regenerated
    const flat = (await extractPdfText(bytesAfter)).replace(/\s+/g, " ");
    expect(flat).toContain("Geänderter Absatz nach dem Edit.");
  }, 60000);

  it("returns null for an empty letter (nothing to render) and writes nothing", async () => {
    const before = db.storage.objects.size;
    const ref = await ensureLetterPdf({ ...input(), app: { ...REF_APP, body_html: "   " } });
    expect(ref).toBeNull();
    expect(db.storage.objects.size).toBe(before);
  });

  it("returns null on storage failure (the send path then blocks the app)", async () => {
    db.storage.failUploads = true;
    const ref = await ensureLetterPdf(input());
    expect(ref).toBeNull();
    expect(db.storage.objects.size).toBe(0);
  }, 30000);

  it("deleteLetterPdf removes only the owner-scoped generated file", async () => {
    await ensureLetterPdf(input());
    const foreignPath = `${OTHER}/bew-anschreiben/app-other.pdf`;
    db.storage.objects.set(foreignPath, {
      bytes: new TextEncoder().encode("%PDF-1.7 other"),
      contentType: "application/pdf",
    });
    await deleteLetterPdf(USER, "app-ref");
    expect(db.storage.objects.has(letterPdfStoragePath(USER, "app-ref"))).toBe(false);
    expect(db.storage.objects.has(foreignPath)).toBe(true); // never touches other owners
    expect(db.storage.removedPaths).toEqual([letterPdfStoragePath(USER, "app-ref")]);
  }, 30000);
});

/* ------------------------------------------------------------------ *
 * D. Engine — one distinct PDF per company; edits are isolated
 * ------------------------------------------------------------------ */

describe("engine: distinct per-company PDFs + edit isolation", () => {
  it("generateBewLetters creates a distinct, valid PDF per company", async () => {
    seedCampaign();
    await seedDocs();
    seedApp(1, { status: "pending", company_name: "MusterTech GmbH", company_email: "jobs@muster-tech.de" });
    seedApp(2, { status: "pending", company_name: "Globex AG", company_email: "jobs@globex.de" });
    db.aiScripts = [
      "Ich bewerbe mich bei der MusterTech GmbH um den Ausbildungsplatz.",
      "Ich bewerbe mich bei der Globex AG um den Ausbildungsplatz.",
    ];

    const result = await generateBewLetters(USER, CAMPAIGN, profileArg, { limit: 5 });
    expect(result.generated).toBe(2);
    expect(result.failed).toBe(0);

    // Two generated PDF objects, deterministic owner-scoped paths.
    const p1 = letterPdfStoragePath(USER, "app-1");
    const p2 = letterPdfStoragePath(USER, "app-2");
    expect(db.storage.objects.has(p1)).toBe(true);
    expect(db.storage.objects.has(p2)).toBe(true);
    expect(Buffer.compare(letterBytes("app-1"), letterBytes("app-2"))).not.toBe(0);

    // Each PDF mentions ONLY its own company (per-company pairing).
    const flat1 = (await extractPdfText(letterBytes("app-1"))).replace(/\s+/g, " ");
    const flat2 = (await extractPdfText(letterBytes("app-2"))).replace(/\s+/g, " ");
    expect(flat1).toContain("MusterTech GmbH");
    expect(flat1).not.toContain("Globex AG");
    expect(flat2).toContain("Globex AG");
    expect(flat2).not.toContain("MusterTech GmbH");
    // Sender block from the REAL profile (nothing invented).
    expect(flat1).toContain("MAX MUSTERMANN");
    expect(flat1).toContain("max@example.de");
  }, 60000);

  it("editing company A's letter re-generates ONLY A's PDF (B is byte-identical)", async () => {
    seedCampaign();
    await seedDocs();
    seedApp(1, { status: "pending", company_name: "MusterTech GmbH" });
    seedApp(2, { status: "pending", company_name: "Globex AG" });
    db.aiScripts = ["A body one.", "B body two."];
    await generateBewLetters(USER, CAMPAIGN, profileArg, { limit: 5 });

    const bBefore = Buffer.from(letterBytes("app-2"));
    const objectsBefore = db.storage.objects.size;

    const updated = await updateBewLetter(USER, "app-1", {
      bodyHtml: letterHtml("MusterTech GmbH", "<p>NEUER EDIT-SATZ: Dieser Text wurde manuell ergänzt.</p>"),
    });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("generated");

    const aAfter = letterBytes("app-1");
    const flatA = (await extractPdfText(aAfter)).replace(/\s+/g, " ");
    expect(flatA).toContain("NEUER EDIT-SATZ"); // A's PDF reflects the edit
    expect(Buffer.from(letterBytes("app-2"))).toEqual(bBefore); // B untouched
    expect(db.storage.objects.size).toBe(objectsBefore); // no orphan, no duplicate
    expect(letterPdfStoragePath(USER, "app-1")).toBe(`${USER}/bew-anschreiben/app-1.pdf`);
  }, 90000);

  it("updateBewLetter ownership: foreign app → null, in-flight app → locked", async () => {
    seedCampaign();
    await seedDocs();
    seedApp(1);
    seedApp(2, { user_id: OTHER });
    expect(await updateBewLetter(USER, "app-2", { bodyHtml: letterHtml("X") })).toBeNull();

    db.bew_applications[0].status = "queued"; // in the send queue → locked
    await expect(
      updateBewLetter(USER, "app-1", { bodyHtml: letterHtml("X") }),
    ).rejects.toThrow("APPLICATION_LOCKED");
  }, 30000);
});

/* ------------------------------------------------------------------ *
 * E. Send — the e-mail carries CV + certificates + THAT company's PDF
 * ------------------------------------------------------------------ */

describe("processBewSendBatch — attachments + block-on-PDF-failure", () => {
  it("every outgoing e-mail includes the CV, the certificate and the correct company-specific PDF", async () => {
    seedCampaign({ status: "sending" });
    await seedDocs();
    seedApp(1, { status: "queued" });
    seedApp(2, { status: "queued" });
    daily(USER).emails_reserved = 2; // as reserved by startBewSend
    db.sendScripts = ["m1", "m2"];

    const result = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(db.sendLog).toHaveLength(2);

    // Per-company pairing: recipient + subject + the RIGHT Anschreiben file.
    // (campaign docs are sorted by kind: certificate → cv; the PDF is appended)
    expect(db.sendLog[0]).toMatchObject({
      to: "jobs1@firma1.de",
      subject: "Bewerbung um einen Ausbildungsplatz bei Firma 1",
      attachmentFiles: ["cert.pdf", "cv.pdf", "Anschreiben_Firma_1.pdf"],
    });
    expect(db.sendLog[1].attachmentFiles).toEqual([
      "cert.pdf",
      "cv.pdf",
      "Anschreiben_Firma_2.pdf",
    ]);
    // Post-send cleanup: each generated PDF was DELETED after the provider
    // confirmed its send — the CV + certificate remain untouched.
    expect(db.storage.objects.has(letterPdfStoragePath(USER, "app-1"))).toBe(false);
    expect(db.storage.objects.has(letterPdfStoragePath(USER, "app-2"))).toBe(false);
    expect(db.storage.objects.has(`${USER}/cv.pdf`)).toBe(true);
    expect(db.storage.objects.has(`${USER}/cert.pdf`)).toBe(true);
    expect(db.storage.removedPaths).toEqual([
      letterPdfStoragePath(USER, "app-1"),
      letterPdfStoragePath(USER, "app-2"),
    ]);
    // Quota consumed for both sends.
    expect(daily(USER).emails_sent).toBe(2);
    expect(daily(USER).emails_reserved).toBe(0);
  }, 90000);

  it("a failed PDF generation BLOCKS that application: no e-mail, stable error, quota released, other apps still sent", async () => {
    seedCampaign({ status: "sending" });
    await seedDocs();
    // app-1 has NO letter text → the PDF cannot be produced (null).
    seedApp(1, { status: "queued", body_html: "", body_text: "" });
    seedApp(2, { status: "queued" });
    daily(USER).emails_reserved = 2;
    db.sendScripts = ["only-app2"];

    const result = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);

    const blocked = db.bew_applications.find((a) => a.id === "app-1")!;
    expect(blocked.status).toBe("failed");
    expect(blocked.error_code).toBe("pdf_generation_failed");
    expect(blocked.error_message).toBeTruthy();
    // The blocked app was NEVER handed to the provider…
    expect(db.sendLog.map((m) => m.to)).toEqual(["jobs2@firma2.de"]);
    // …and its reserved slot was released (1 sent + 1 released = 0 reserved).
    expect(daily(USER).emails_reserved).toBe(0);
    expect(daily(USER).emails_sent).toBe(1);
  }, 90000);

  it("a PDF-blocked (failed) app is terminal: a second drain does not retry it", async () => {
    seedCampaign({ status: "sending" });
    await seedDocs();
    seedApp(1, { status: "queued", body_html: "", body_text: "" });
    seedApp(2, { status: "queued" });
    db.sendScripts = ["m2"];
    await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(db.sendLog).toHaveLength(1);

    db.sendScripts = ["must-not-send"];
    const second = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(second.sent).toBe(0);
    expect(db.sendLog).toHaveLength(1); // the blocked app was never retried
    expect(db.bew_applications.find((a) => a.id === "app-1")!.error_code).toBe("pdf_generation_failed");
  }, 90000);
});

/* ------------------------------------------------------------------ *
 * F. UI — the letter is never shown as raw HTML
 * ------------------------------------------------------------------ */

describe("review UI — readable A4 preview, structured edit, no raw HTML", () => {
  const app: any = {
    id: "app-1",
    seq: 1,
    company_name: "MusterTech GmbH",
    contact_name: "Herrn Dr. Beispiel",
    company_email: "bewerbung@muster-tech.example",
    company_address: "Musterstraße 12, 80331 München",
    subject: "Bewerbung um einen Ausbildungsplatz bei MusterTech GmbH",
    // Stored (server-sanitized) HTML — must NEVER surface as markup.
    body_html:
      "<p>Sehr geehrte Damen &amp; Herren,</p>" +
      "<p>Ich bewerbe mich bei der <strong>MusterTech GmbH</strong> um den Ausbildungsplatz.</p>" +
      "<p>Mit freundlichen Grüßen</p>" +
      "<p>Max Mustermann</p>",
    body_text: "",
    status: "generated",
    error_code: null,
    error_message: null,
    attempt_count: 0,
    provider_message_id: null,
    sent_at: null,
  };

  function viewFixture(): any {
    return {
      campaign: {
        id: CAMPAIGN,
        user_id: USER,
        email_account_id: "acct-1",
        purpose: "ausbildung",
        status: "draft",
        requested_count: 1,
        valid_count: 1,
        total_count: 1,
        generated_count: 1,
        sent_count: 0,
        failed_count: 0,
        excluded_count: 0,
        usage_date: TODAY,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
      },
      applications: [app],
      documents: [
        { id: "cd-1", campaign_id: CAMPAIGN, document_id: "doc-cv", user_id: USER, kind: "cv", storage_path: `${USER}/cv.pdf`, filename: "cv.pdf", mime_type: "application/pdf", size_bytes: 1, created_at: TODAY },
        { id: "cd-2", campaign_id: CAMPAIGN, document_id: "doc-cert", user_id: USER, kind: "certificate", storage_path: `${USER}/cert.pdf`, filename: "cert.pdf", mime_type: "application/pdf", size_bytes: 1, created_at: TODAY },
      ],
      usage: { remaining: 50, daily_limit: 50 },
      senderEmail: "sender@gmail.com",
    };
  }

  it("the table row shows a plain-text excerpt (no markup) and the PDF attachment name", async () => {
    const React = await import("react");
    const { renderToString } = await import("react-dom/server");
    const { I18nProvider } = await import("@/lib/i18n");
    const { ReviewStep } = await import("@/components/bewerbung-automation/review-step");
    const tree = React.createElement(
      I18nProvider,
      null,
      React.createElement(ReviewStep, {
        view: viewFixture(),
        refresh: async () => undefined,
        selectedIds: new Set([app.id]),
        onToggle: () => undefined,
        applicantName: "Max Mustermann",
        applicantEmail: "max@example.de",
      }),
    );
    const html = renderToString(tree);
    // The excerpt is the DECODED plain text (entities resolved, tags gone)…
    expect(html).toContain("Sehr geehrte Damen &amp; Herren,");
    // …never the raw stored markup, and never the PDF-internal HTML of the body.
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("bei der <strong>");
    expect(html).not.toContain(app.body_html.slice(0, 40)); // raw <p>…&amp;… not inlined
    // The table lists the generated attachment by its real, sanitized name.
    expect(html).toContain("Anschreiben_MusterTech_GmbH.pdf");
  });

  it("the preview modal renders the A4 letter as plain text (sender, date, recipient, subject, body, closing)", async () => {
    const React = await import("react");
    const { renderToString } = await import("react-dom/server");
    const { translate } = await import("@/lib/i18n");
    const { LetterModal } = await import("@/components/bewerbung-automation/review-step");
    const t = (k: string, v?: Record<string, string | number>) => translate("de", k, v);
    const html = renderToString(
      React.createElement(LetterModal, {
        app,
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
    // Sender block (real data only) + German date style.
    expect(html).toContain("Max Mustermann");
    expect(html).toContain("max@example.de");
    expect(html).toMatch(/\d{1,2}\. (Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember) 20\d\d/);
    // Recipient block.
    expect(html).toContain("MusterTech GmbH");
    expect(html).toContain("Herrn Dr. Beispiel");
    expect(html).toContain("Musterstraße 12");
    expect(html).toContain("80331 München");
    // Subject, greeting (entity decoded), body (tag stripped), closing.
    expect(html).toContain("Bewerbung um einen Ausbildungsplatz bei MusterTech GmbH");
    expect(html).toContain("Sehr geehrte Damen &amp; Herren,");
    expect(html).toContain("Ich bewerbe mich bei der MusterTech GmbH um den Ausbildungsplatz.");
    expect(html).toContain("Mit freundlichen Grüßen");
    // The attachments panel names the generated PDF.
    expect(html).toContain("Anschreiben_MusterTech_GmbH.pdf");
    // And NOWHERE the raw stored markup.
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("&amp;amp;"); // no double-escaped raw entities
  });

  it("the edit modal exposes structured fields with the plain text — never the raw HTML", async () => {
    const React = await import("react");
    const { renderToString } = await import("react-dom/server");
    const { translate } = await import("@/lib/i18n");
    const { LetterModal } = await import("@/components/bewerbung-automation/review-step");
    const t = (k: string, v?: Record<string, string | number>) => translate("de", k, v);
    const html = renderToString(
      React.createElement(LetterModal, {
        app,
        mode: "edit",
        view: viewFixture(),
        busy: false,
        applicantName: "Max Mustermann",
        applicantEmail: "max@example.de",
        onClose: () => undefined,
        onSave: async () => undefined,
        t,
      }),
    );
    // Structured labels (German catalog).
    expect(html).toContain("Anschreiben-Text");
    expect(html).toContain("Anrede");
    expect(html).toContain("Grußformel");
    // The body textarea carries the READABLE paragraph text (tags stripped)…
    expect(html).toContain("Ich bewerbe mich bei der MusterTech GmbH um den Ausbildungsplatz.");
    // …and no escaped markup anywhere in the form.
    expect(html).not.toContain("&lt;strong&gt;");
    expect(html).not.toContain("&lt;p&gt;");
    expect(html).not.toContain("font-mono"); // the old raw-HTML textarea is gone
  });

  it("guard: the review step source never renders unsanitized HTML", () => {
    const src = readFileSync(
      path.join(process.cwd(), "src/components/bewerbung-automation/review-step.tsx"),
      "utf8",
    );
    expect(src).not.toContain("dangerouslySetInnerHTML");
    expect(src).not.toContain("font-mono");
    // The letter is parsed through the shared pure helpers (one rule for
    // preview, edit and PDF).
    expect(src).toContain("htmlToParagraphs");
    expect(src).toContain("letterParagraphsToHtml");
  });
});

/* ------------------------------------------------------------------ *
 * G. Pure parsing contract (shared by preview, edit, PDF)
 * ------------------------------------------------------------------ */

describe("shared parsing: preview/edit/PDF see the SAME letter parts", () => {
  it("round-trips the stored letter into greeting/body/closing/signature", () => {
    const paragraphs = htmlToParagraphs(
      "<p>Sehr geehrte Frau Dr. Müller,</p><p>Erster Absatz.</p><p>Zweiter Absatz.</p><p>Mit freundlichen Grüßen</p><p>Max Mustermann</p>",
    );
    const parts = splitLetterParagraphs(paragraphs, "Max Mustermann");
    expect(parts.greeting).toBe("Sehr geehrte Frau Dr. Müller,");
    expect(parts.body).toEqual(["Erster Absatz.", "Zweiter Absatz."]);
    expect(parts.closing).toBe("Mit freundlichen Grüßen");
    expect(parts.signature).toBe("Max Mustermann");
  });

  it("is defensive for edited short bodies (1–3 paragraphs never throw)", () => {
    // 0–2 paragraphs: no signature present → the fallback name is used.
    for (const n of [0, 1, 2]) {
      const paras = Array.from({ length: n }, (_, i) => `P${i + 1}`);
      const parts = splitLetterParagraphs(paras, "Fallback Name");
      expect(typeof parts.greeting).toBe("string");
      expect(Array.isArray(parts.body)).toBe(true);
      expect(typeof parts.closing).toBe("string");
      expect(parts.signature).toBe("Fallback Name");
    }
    // 3 paragraphs: [greeting, closing, signature] — the last line IS the
    // signature (the canonical stored letter always carries 4+ paragraphs).
    const parts3 = splitLetterParagraphs(["P1", "P2", "P3"], "Fallback Name");
    expect(parts3.greeting).toBe("P1");
    expect(parts3.closing).toBe("P2");
    expect(parts3.signature).toBe("P3");
  });
});
