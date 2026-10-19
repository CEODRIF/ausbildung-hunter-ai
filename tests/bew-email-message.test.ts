/**
 * Bewerbung Automation — the independent campaign e-mail message.
 *
 * Regression suite for the "letter-as-e-mail-body" fix:
 *   - the campaign e-mail (email_subject / email_body_html) IS the outgoing
 *     message; the per-company Anschreiben stays a PDF ATTACHMENT,
 *   - variables resolve per recipient (company / contact / candidate /
 *     greeting) — unresolved tokens never leave the building,
 *   - an empty subject/body blocks the send (start gate + defensive
 *     drain stop),
 *   - templates fill the draft only (send nothing, touch no letter),
 *   - the review shows the e-mail and the letter as distinct items,
 *   - letter-PDF cleanup happens ONLY after confirmed success.
 */
// The in-memory fake below mimics a DYNAMIC Supabase proxy builder; its
// rows are intentionally loosely typed (like the other engine test harnesses).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  BewApplicationDTO,
  BewCampaignDocumentDTO,
  BewViewDTO,
} from "@/components/bewerbung-automation/types";

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
  sendScripts: Array<() => { ok: true; id: string } | never>;
  sendLog: Array<{
    to: string;
    subject: string;
    html: string;
    text: string;
    attachmentFiles: string[];
  }>;
  /** Letter PDFs actually deleted (per-app + sweep, de-duplicated by state). */
  deletedLetters: string[];
  storage: { objects: Set<string> };
  slotFree: boolean;
}

const TODAY = new Date().toISOString().slice(0, 10);
const USER = "user-1";
const CAMPAIGN = "camp-1";

/** Default campaign e-mail: complete, WITHOUT the candidate token (the
 *  fake profile name is empty unless a test seeds one). */
const EMAIL_SUBJECT = "Bewerbung um einen Ausbildungsplatz bei {{company_name}}";
const EMAIL_BODY =
  "<p>{{greeting}}</p><p>anbei meine Bewerbung bei {{company_name}}.</p><p>Mit freundlichen Grüssen</p>";

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
    // The full applicant profile is part of a valid send fixture (the
    // letter PDF requires all seven fields). Tests that need an incomplete
    // profile override this row.
    profiles: [
      {
        id: USER,
        full_name: "Max Mustermann",
        email: "max@example.de",
        street: "Musterstraße 12",
        postal_code: "12345",
        city: "Berlin",
        country: "Deutschland",
        phone: "+49 151 2345678",
      },
    ],
    sendScripts: [],
    sendLog: [],
    deletedLetters: [],
    storage: { objects: new Set<string>() },
    slotFree: true,
  };
}

function daily(userId: string): Row {
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
      const du = daily(args.target_user_id);
      const limit = du.daily_limit ?? 50;
      const available = limit - du.emails_sent - du.emails_reserved;
      if (args.requested > available)
        return Promise.resolve({ data: null, error: { message: "daily_quota_exceeded" } });
      du.emails_reserved += args.requested;
      return Promise.resolve({
        data: {
          date: du.date,
          daily_limit: limit,
          emails_sent: du.emails_sent,
          emails_reserved: du.emails_reserved,
          remaining: available - args.requested,
        },
        error: null,
      });
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
      // Atomic: flip to sending immediately so a concurrent claim cannot take it.
      app.status = "sending";
      app.attempt_count = (app.attempt_count ?? 0) + 1;
      camp.status = "sending";
      if (!camp.started_at) camp.started_at = new Date().toISOString();
      return Promise.resolve({ data: { ...app }, error: null });
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
    filters: [] as Array<{ col: string; val: any }>,
    inFilters: [] as Array<{ col: string; values: any[] }>,
    orderBy: [] as Array<{ col: string; ascending: boolean }>,
    limitN: undefined as number | undefined,
    selectOpts: undefined as any,
    terminal: undefined as "single" | "maybeSingle" | undefined,
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
      if (state.terminal === "single" || state.terminal === "maybeSingle")
        return { data: matched[0] ?? null, error: null };
      return { data: matched, error: null };
    }
    if (state.op === "delete") {
      const matched = rows();
      (db[table] as Row[]) = (db[table] ?? []).filter((r) => !matched.includes(r));
      return { data: null, error: null };
    }
    // select
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
          download: async (objPath: string) => ({
            data: db.storage.objects.has(objPath)
              ? { arrayBuffer: async () => new Uint8Array([1]).buffer }
              : null,
            error: null,
          }),
          upload: async (objPath: string) => {
            db.storage.objects.add(objPath);
            return { error: null };
          },
          remove: async () => ({ error: null }),
        }),
      },
    }),
  }));
  vi.doMock("@/lib/email-campaigns", () => ({
    getUsageSnapshot: async (userId: string) => {
      const du = daily(userId);
      const limit = du.daily_limit ?? 50;
      return {
        date: du.date,
        emails_sent: du.emails_sent,
        emails_reserved: du.emails_reserved,
        daily_limit: limit,
        remaining: Math.max(limit - du.emails_sent - du.emails_reserved, 0),
      };
    },
    reserveSenderSlot: async () => db.slotFree,
  }));
  vi.doMock("@/lib/email-providers", () => ({
    // Mirrors the REAL contract: the provider pre-fetches the files given at
    // construction and attaches them to every sendEmail call.
    createEmailProvider: async (
      _userId: string,
      _accountId: string,
      paths: Array<{ filename: string; storagePath: string }> = [],
    ) => ({
      sendEmail: async (input: any) => {
        const script = db.sendScripts.shift();
        if (!script)
          throw Object.assign(new Error("no provider script"), {
            code: "provider_rejected",
            temporary: false,
          });
        db.sendLog.push({
          to: input.to,
          subject: input.subject,
          html: input.html,
          text: input.text,
          attachmentFiles: paths.map((p) => p.filename),
        });
        const result = script();
        if (result && (result as { ok?: boolean }).ok)
          return { providerMessageId: (result as { id: string }).id };
        throw new Error("script should be handled");
      },
    }),
  }));
  vi.doMock("@/lib/bew-letter-pdf", () => ({
    BEW_ATTACHMENT_BUCKET: "bew-letters",
    letterPdfStoragePath: (userId: string, appId: string) => `${userId}/letters/${appId}.pdf`,
    // The letter PDF "exists" in the fake storage once ensured (so the
    // post-drain sweep can find — or not find — the object, like in prod).
    ensureLetterPdf: async (args: { userId: string; app: Row }) => {
      const objPath = `${args.userId}/letters/${args.app.id}.pdf`;
      db.storage.objects.add(objPath);
      return {
        filename: `Anschreiben_${String(args.app.company_name).replace(/\s+/g, "_")}.pdf`,
        mimeType: "application/pdf",
        storagePath: objPath,
      };
    },
    deleteLetterPdf: async (userId: string, appId: string) => {
      const objPath = `${userId}/letters/${appId}.pdf`;
      if (!db.storage.objects.has(objPath)) return false;
      db.storage.objects.delete(objPath);
      db.deletedLetters.push(appId);
      return true;
    },
  }));
  vi.doMock("@/lib/application-drafts", () => ({
    // Faithful stand-in for the shared sanitizer: scripts and inline
    // handlers never survive a save.
    sanitizeEmailHtml: (h: string) =>
      (h ?? "")
        .replace(/<script\b[\s\S]*?<\/script>/gi, "")
        .replace(/\son\w+="[^"]*"/gi, ""),
    htmlToText: (h: string) => (h ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  }));
  vi.doMock("@/lib/ai-provider", () => ({
    createAIProvider: () => ({
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      generateText: async (_messages: any) => "Generischer Text.",
    }),
  }));
  vi.doMock("@/lib/ai-service", () => ({
    reserveAIUsage: async () => undefined,
    storagePath: (userId: string, filename: string) => `${userId}/doc-${filename}`,
  }));
  vi.doMock("@/lib/pdf-extract", () => ({ extractPdfText: async () => "" }));
  vi.doMock("mammoth", () => ({
    default: { extractRawText: async () => ({ value: "docx" }) },
  }));
  vi.doMock("@/app/bewerbung-automation/actions", () => ({
    bewSaveEmail: vi.fn(async () => ({ ok: true })),
    bewUpdateLetter: vi.fn(async () => ({ ok: true })),
    bewExcludeApplication: vi.fn(async () => ({ ok: true })),
    bewRestoreApplication: vi.fn(async () => ({ ok: true })),
  }));
}

installMocks();

const {
  getBewCampaignView,
  processBewSendBatch,
  startBewSend,
  updateBewCampaignEmail,
} = await import("@/lib/bewerbung-engine");
const { PersonalizationError, renderPersonalizedMessage } = await import("@/lib/personalization");
const { isBewEmailComplete } = await import("@/lib/bewerbung-automation");
const { bewEmailTemplateFor, bewEmailTemplates } = await import(
  "@/components/bewerbung-automation/email-templates"
);

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
    requested_count: 2,
    usage_date: TODAY,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
    email_subject: EMAIL_SUBJECT,
    email_body_html: EMAIL_BODY,
    ...overrides,
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
    body_html: `<p>Sehr geehrte Damen und Herren,</p><p>UNIKER-BRIEFMARKER-${seq}.</p><p>Mit freundlichen Grüssen</p><p>Max Mustermann</p>`,
    body_text: `UNIKER-BRIEFMARKER-${seq}`,
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

function seedProfile(name: string) {
  // The default fixture row already carries the complete profile; this only
  // overrides the name (e.g. the profile-less candidate-token scenarios set
  // it to ""). A full row is kept so other fields stay valid.
  if (db.profiles.length === 0) {
    db.profiles.push({
      id: USER,
      full_name: name,
      email: "max@example.de",
      street: "Musterstraße 12",
      postal_code: "12345",
      city: "Berlin",
      country: "Deutschland",
      phone: "+49 151 2345678",
    });
  } else {
    db.profiles[0].full_name = name;
  }
}

const okSend = (id: string) => () => ({ ok: true as const, id });
const failDefinitive = () => {
  throw Object.assign(new Error("Gmail rejected this message."), {
    code: "provider_rejected",
    temporary: false,
  });
};

beforeEach(() => {
  db = freshDb();
});

/* ------------------------------------------------------------------ *
 * A. Variables — per-recipient resolution (pure)
 * ------------------------------------------------------------------ */

describe("variables: per-recipient resolution (pure)", () => {
  const template = {
    subject: "Bewerbung bei {{company_name}}",
    bodyHtml:
      "<p>{{greeting}}</p><p>{{company_name}}</p><p>{{contact_name}}</p><p>{{candidate_name}}</p>",
    bodyText: "{{greeting}} {{candidate_name}}",
  };

  it("resolves company, salutation and candidate name per recipient", () => {
    const r1 = renderPersonalizedMessage(
      template,
      { email: "j@firma1.de", companyName: "Firma Ein", contactName: "Herr Weber" },
      { candidateName: "Max Mustermann" },
    );
    expect(r1.subject).toBe("Bewerbung bei Firma Ein");
    expect(r1.bodyHtml).toContain("Sehr geehrter Herr Weber,");
    expect(r1.bodyHtml).toContain("Firma Ein");
    expect(r1.bodyHtml).toContain("Herr Weber");
    expect(r1.bodyHtml).toContain("Max Mustermann");
    expect(r1.bodyText).toBe("Sehr geehrter Herr Weber, Max Mustermann");

    const r2 = renderPersonalizedMessage(
      template,
      { email: "j@firma2.de", companyName: "Firma Zwei", contactName: "Frau Dr. Schulz" },
      { candidateName: "Max Mustermann" },
    );
    expect(r2.subject).toBe("Bewerbung bei Firma Zwei");
    expect(r2.bodyHtml).toContain("Sehr geehrte Frau Dr. Schulz,");
  });

  it("missing contact person → neutral German greeting, never an invented name", () => {
    const r = renderPersonalizedMessage(
      template,
      { email: "j@firma3.de", companyName: "Firma Drei" },
      { candidateName: "Max Mustermann" },
    );
    expect(r.bodyHtml).toContain("Sehr geehrte Damen und Herren,");
    // The contact token falls back to "Damen und Herren" (pairs with "Sehr geehrte …").
    expect(r.bodyHtml).toContain("Damen und Herren");
  });

  it("hand-typed spaced tokens are never replaced → PersonalizationError (no leak)", () => {
    expect(() =>
      renderPersonalizedMessage(
        { subject: "x", bodyHtml: "<p>{{ company_name }}</p>", bodyText: "" },
        { email: "j@f.de", companyName: "Firma" },
      ),
    ).toThrow(PersonalizationError);
  });

  it("{{candidate_name}} without a profile name → PersonalizationError", () => {
    expect(() =>
      renderPersonalizedMessage(
        { subject: "x", bodyHtml: "<p>{{candidate_name}}</p>", bodyText: "" },
        { email: "j@f.de", companyName: "Firma" },
        { candidateName: "   " },
      ),
    ).toThrow(PersonalizationError);
    // The spaced variant is treated the same.
    expect(() =>
      renderPersonalizedMessage(
        { subject: "x", bodyHtml: "<p>{{ candidate_name }}</p>", bodyText: "" },
        { email: "j@f.de", companyName: "Firma" },
      ),
    ).toThrow(PersonalizationError);
  });

  it("escapes HTML in resolved values (text nodes only)", () => {
    const r = renderPersonalizedMessage(
      { subject: "x", bodyHtml: "<p>{{company_name}}</p>", bodyText: "" },
      { email: "j@f.de", companyName: "Firma & <Söhne>" },
    );
    expect(r.bodyHtml).not.toContain("<Söhne>");
    expect(r.bodyHtml).toContain("&lt;Söhne&gt;");
  });
});

/* ------------------------------------------------------------------ *
 * B. Completeness + German templates (pure)
 * ------------------------------------------------------------------ */

describe("email completeness + German templates (pure)", () => {
  it("isBewEmailComplete: subject AND visible body text are required", () => {
    expect(isBewEmailComplete("", "<p>x</p>")).toBe(false);
    expect(isBewEmailComplete("   ", "<p>x</p>")).toBe(false);
    expect(isBewEmailComplete("Betreff", "")).toBe(false);
    expect(isBewEmailComplete("Betreff", "<p></p><br/>")).toBe(false);
    expect(isBewEmailComplete("Betreff", "&nbsp;")).toBe(false);
    expect(isBewEmailComplete("Betreff", "<p>Schluss</p>")).toBe(true);
    expect(isBewEmailComplete("a".repeat(201), "<p>x</p>")).toBe(false);
    expect(isBewEmailComplete("a".repeat(200), "<p>x</p>")).toBe(true);
  });

  it("provides at least two editable German templates (subject + body)", () => {
    expect(Object.keys(bewEmailTemplates).length).toBeGreaterThanOrEqual(2);
    for (const purpose of ["ausbildung", "arbeit", "praktikum"] as const) {
      const tpl = bewEmailTemplateFor(purpose)!;
      expect(tpl.purpose).toBe(purpose);
      expect(tpl.subject.trim()).not.toBe("");
      expect(tpl.subject).toContain("{{company_name}}");
      expect(tpl.bodyHtml).toContain("{{greeting}}");
      expect(tpl.bodyHtml).toContain("{{candidate_name}}");
      // The templates reference the attachment (letter stays an attachment).
      expect(tpl.bodyHtml).toContain("Anhang");
    }
    expect(bewEmailTemplateFor("etwas-anderes")).toBeNull();
  });

  it("a template renders for a recipient with a profile name — no token survives", () => {
    const tpl = bewEmailTemplateFor("ausbildung")!;
    const r = renderPersonalizedMessage(
      { subject: tpl.subject, bodyHtml: tpl.bodyHtml, bodyText: "" },
      { email: "jobs@muster.de", companyName: "Muster GmbH", contactName: "Frau Krüger" },
      { candidateName: "Max Mustermann" },
    );
    expect(r.subject).toBe("Bewerbung um einen Ausbildungsplatz bei Muster GmbH");
    expect(r.bodyHtml).toContain("Sehr geehrte Frau Krüger,");
    expect(r.bodyHtml).toContain("Max Mustermann");
    expect(r.bodyHtml).not.toContain("{{");
  });
});

/* ------------------------------------------------------------------ *
 * C. updateBewCampaignEmail — isolated storage, sanitization, locks
 * ------------------------------------------------------------------ */

describe("updateBewCampaignEmail — isolated storage, sanitization, locks", () => {
  it("stores subject + sanitized body on the campaign — the letter is untouched", async () => {
    seedCampaign({ status: "draft", started_at: null });
    seedApp(1, { status: "generated", body_html: "<p>BRIEF</p>" });
    await updateBewCampaignEmail(USER, CAMPAIGN, {
      subject: "  Mein Betreff  ",
      bodyHtml: '<p><script>alert(1)</script>Grüße</p><p onclick="x()">Text</p>',
    });
    const camp = db.bew_campaigns[0];
    expect(camp.email_subject).toBe("Mein Betreff");
    expect(camp.email_body_html).not.toContain("<script");
    expect(camp.email_body_html).not.toContain("onclick");
    expect(camp.email_body_html).toContain("Grüße");
    // The per-company Anschreiben (row + its subject) is a separate artifact.
    const app = db.bew_applications[0];
    expect(app.body_html).toBe("<p>BRIEF</p>");
    expect(app.subject).not.toBe("Mein Betreff");
  });

  it("rejects an overlong subject", async () => {
    seedCampaign({ status: "draft", started_at: null });
    await expect(
      updateBewCampaignEmail(USER, CAMPAIGN, { subject: "a".repeat(201), bodyHtml: "<p>x</p>" }),
    ).rejects.toThrow("INVALID_PAYLOAD");
  });

  it("locks while a send is in flight (EMAIL_LOCKED)", async () => {
    seedCampaign({ status: "sending" });
    await expect(
      updateBewCampaignEmail(USER, CAMPAIGN, { subject: "x", bodyHtml: "<p>y</p>" }),
    ).rejects.toThrow("EMAIL_LOCKED");
  });

  it("locks in terminal states (CAMPAIGN_CLOSED)", async () => {
    seedCampaign({ status: "completed" });
    await expect(
      updateBewCampaignEmail(USER, CAMPAIGN, { subject: "x", bodyHtml: "<p>y</p>" }),
    ).rejects.toThrow("CAMPAIGN_CLOSED");
  });

  it("is owner-scoped (another user: NOT_FOUND)", async () => {
    seedCampaign({ status: "draft", started_at: null });
    await expect(
      updateBewCampaignEmail("intruder", CAMPAIGN, { subject: "x", bodyHtml: "<p>y</p>" }),
    ).rejects.toThrow("NOT_FOUND");
  });
});

/* ------------------------------------------------------------------ *
 * D. startBewSend — the e-mail message gates the send
 * ------------------------------------------------------------------ */

describe("startBewSend — the e-mail message gates the send", () => {
  function seedReadyCampaign(over: Partial<Row> = {}) {
    seedCampaign({ status: "draft", started_at: null, ...over });
    seedDocuments();
    seedApp(1, { status: "generated" });
    seedApp(2, { status: "generated" });
  }

  it("blocks with EMAIL_INCOMPLETE when the body is empty (no queue, no quota)", async () => {
    seedReadyCampaign({ email_body_html: "" });
    const res = await startBewSend(USER, CAMPAIGN);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("EMAIL_INCOMPLETE");
    expect(db.bew_applications.every((a) => a.status === "generated")).toBe(true);
    expect(daily(USER).emails_reserved).toBe(0);
    expect(daily(USER).emails_sent).toBe(0);
  });

  it("blocks with EMAIL_INCOMPLETE when only the subject is empty", async () => {
    seedReadyCampaign({ email_subject: "" });
    const res = await startBewSend(USER, CAMPAIGN);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("EMAIL_INCOMPLETE");
    expect(daily(USER).emails_reserved).toBe(0);
  });

  it("blocks with CANDIDATE_NAME_MISSING when the token is used but the profile has no name", async () => {
    seedReadyCampaign({ email_body_html: "<p>Grüße {{candidate_name}}</p>" });
    seedProfile(""); // the profile exists, but the name is empty
    const res = await startBewSend(USER, CAMPAIGN);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("CANDIDATE_NAME_MISSING");
    expect(db.bew_applications.every((a) => a.status === "generated")).toBe(true);
    expect(daily(USER).emails_reserved).toBe(0);
  });

  it("proceeds when the message is whole and the candidate name exists", async () => {
    seedReadyCampaign({ email_body_html: "<p>Grüße {{candidate_name}}</p>" });
    seedProfile("Max Mustermann");
    db.slotFree = false; // the drain does nothing — queue + quota stay observable
    const res = await startBewSend(USER, CAMPAIGN);
    expect(res.ok).toBe(true);
    expect(res.queuedCount).toBe(2);
    expect(db.bew_applications.every((a) => a.status === "queued")).toBe(true);
    expect(db.bew_campaigns[0].status).toBe("sending");
    expect(daily(USER).emails_reserved).toBe(2);
    expect(db.sendLog).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * E. processBewSendBatch — the outgoing message IS the campaign e-mail
 * ------------------------------------------------------------------ */

describe("processBewSendBatch — outgoing message is the CAMPAIGN e-mail", () => {
  it("sends the configured e-mail text (NOT the letter) with per-recipient resolution", async () => {
    seedCampaign({
      email_subject: "Bewerbung bei {{company_name}}",
      email_body_html:
        "<p>{{greeting}}</p><p>UNIKER-EMAILMARKER-55 bei {{company_name}}.</p><p>{{candidate_name}}</p>",
    });
    seedDocuments();
    seedApp(1, { contact_name: "Herr Weber" });
    seedApp(2, { contact_name: null });
    seedProfile("Max Mustermann");
    daily(USER).emails_reserved = 2;
    db.sendScripts = [okSend("m1"), okSend("m2")];

    const result = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(db.sendLog).toHaveLength(2);

    const [m1, m2] = db.sendLog;
    // Subject: the campaign e-mail subject, resolved per company.
    expect(m1.to).toBe("jobs1@firma1.de");
    expect(m2.to).toBe("jobs2@firma2.de");
    expect(m1.subject).toBe("Bewerbung bei Firma 1");
    expect(m2.subject).toBe("Bewerbung bei Firma 2");
    // Body: the configured e-mail text with EACH recipient's own values.
    expect(m1.html).toContain("UNIKER-EMAILMARKER-55 bei Firma 1.");
    expect(m1.html).toContain("Sehr geehrter Herr Weber,");
    expect(m1.html).toContain("Max Mustermann");
    expect(m2.html).toContain("UNIKER-EMAILMARKER-55 bei Firma 2.");
    expect(m2.html).toContain("Sehr geehrte Damen und Herren,");
    // Independence: the LETTER text never becomes the e-mail body.
    expect(m1.html).not.toContain("UNIKER-BRIEFMARKER-1");
    expect(m2.html).not.toContain("UNIKER-BRIEFMARKER-2");
    expect(m1.text).toContain("UNIKER-EMAILMARKER-55 bei Firma 1.");
    expect(m1.text).not.toContain("UNIKER-BRIEFMARKER-1");
    // Attachments: CV + certificate + the recipient's own Anschreiben PDF.
    expect(m1.attachmentFiles).toEqual(["cert.pdf", "cv.pdf", "Anschreiben_Firma_1.pdf"]);
    expect(m2.attachmentFiles).toEqual(["cert.pdf", "cv.pdf", "Anschreiben_Firma_2.pdf"]);
    // Quota consumed; the letter PDFs cleaned up after confirmed success.
    expect(daily(USER).emails_sent).toBe(2);
    expect(daily(USER).emails_reserved).toBe(0);
    expect([...db.deletedLetters].sort()).toEqual(["app-1", "app-2"]);
  });

  it("a malformed (spaced) token fails the rows — nothing sent, quota released, PDFs kept", async () => {
    seedCampaign({
      email_body_html: "<p>{{ company_name }}</p>", // hand-typed spacing
    });
    seedDocuments();
    seedApp(1);
    seedApp(2);
    daily(USER).emails_reserved = 2;
    db.sendScripts = [okSend("x"), okSend("y")];

    const result = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(result.failed).toBe(2);
    expect(result.sent).toBe(0);
    expect(db.sendLog).toHaveLength(0); // nothing left the building
    for (const a of db.bew_applications) {
      expect(a.status).toBe("failed");
      expect(a.error_code).toBe("personalization_failed");
    }
    expect(daily(USER).emails_reserved).toBe(0);
    expect(daily(USER).emails_sent).toBe(0);
    expect(db.deletedLetters).toHaveLength(0); // no success → no cleanup
  });

  it("a drain never ships an incomplete e-mail (defensive stop: no claim, no quota move)", async () => {
    seedCampaign({ email_body_html: "" });
    seedDocuments();
    seedApp(1);
    daily(USER).emails_reserved = 1;
    db.sendScripts = [okSend("must-not-send")];

    const result = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(result.stop).toBe("email-incomplete");
    expect(result.processed).toBe(0);
    expect(db.sendLog).toHaveLength(0);
    expect(db.bew_applications[0].status).toBe("queued"); // never claimed
    expect(daily(USER).emails_reserved).toBe(1); // untouched
  });

  it("a failed send keeps the letter PDF; a successful send deletes it", async () => {
    seedCampaign();
    seedDocuments();
    seedApp(1);
    seedApp(2);
    daily(USER).emails_reserved = 2;
    db.sendScripts = [failDefinitive, okSend("m2")];

    const result = await processBewSendBatch(USER, CAMPAIGN, 5);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    const failed = db.bew_applications.find((a) => a.id === "app-1")!;
    const ok = db.bew_applications.find((a) => a.id === "app-2")!;
    expect(failed.status).toBe("failed");
    expect(ok.status).toBe("sent");
    // Cleanup only after the confirmed success (app-2) — never for app-1.
    expect(db.deletedLetters).toEqual(["app-2"]);
    expect(db.storage.objects.has(`${USER}/letters/app-1.pdf`)).toBe(true);
    expect(db.storage.objects.has(`${USER}/letters/app-2.pdf`)).toBe(false);
    expect(daily(USER).emails_sent).toBe(1);
    expect(daily(USER).emails_reserved).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * F. View — the campaign e-mail is part of the polled view
 * ------------------------------------------------------------------ */

describe("getBewCampaignView — exposes the campaign e-mail", () => {
  it("returns the stored subject + body (for editor adoption and review)", async () => {
    seedCampaign({ status: "draft", started_at: null });
    const view = await getBewCampaignView(USER, CAMPAIGN);
    expect(view).not.toBeNull();
    expect(view!.campaign.email_subject).toBe(EMAIL_SUBJECT);
    expect(view!.campaign.email_body_html).toBe(EMAIL_BODY);
  });

  it("treats a pre-migration row (no columns) as empty e-mail", async () => {
    seedCampaign({ status: "draft", started_at: null });
    const row = db.bew_campaigns[0];
    delete row.email_subject;
    delete row.email_body_html;
    const view = await getBewCampaignView(USER, CAMPAIGN);
    expect(view!.campaign.email_subject).toBeUndefined();
    expect(isBewEmailComplete(view!.campaign.email_subject, view!.campaign.email_body_html)).toBe(
      false,
    );
  });
});

/* ------------------------------------------------------------------ *
 * G. UI (SSR) — the dedicated e-mail editor + the review separation
 * ------------------------------------------------------------------ */

// The components call useRouter() for re-authentication navigation — under
// renderToString there is no mounted app router (stub like the smart-input
// contract test does).
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));
const React = await import("react");
const { renderToString } = await import("react-dom/server");
const { I18nProvider, translate } = await import("@/lib/i18n");
const { EmailMessageCard } = await import("@/components/bewerbung-automation/email-message");
const { LetterModal } = await import("@/components/bewerbung-automation/review-step");

const t = (k: string, v?: Record<string, string | number>) => translate("de", k, v);

/** React SSR emits `<!-- -->` between adjacent text segments — normalize so
 *  string assertions see the rendered text. */
function plain(html: string): string {
  return html.replace(/<!-- -->/g, "");
}

function appDto(seq: number, over: Partial<BewApplicationDTO> = {}): BewApplicationDTO {
  return {
    id: `app-${seq}`,
    seq,
    company_name: `Firma ${seq}`,
    contact_name: null,
    company_email: `jobs${seq}@firma${seq}.de`,
    company_address: null,
    subject: `Bewerbung um einen Ausbildungsplatz bei Firma ${seq}`,
    body_html: `<p>Sehr geehrte Damen und Herren,</p><p>UNIKER-BRIEFMARKER-${seq}.</p><p>Mit freundlichen Grüssen</p><p>Max Mustermann</p>`,
    body_text: `UNIKER-BRIEFMARKER-${seq}`,
    status: "generated",
    error_code: null,
    error_message: null,
    attempt_count: 0,
    provider_message_id: null,
    sent_at: null,
    ...over,
  };
}

function docDto(id: string, kind: string, filename: string): BewCampaignDocumentDTO {
  return {
    id,
    campaign_id: "c1",
    document_id: id,
    user_id: "user-1",
    kind,
    storage_path: `user-1/${filename}`,
    filename,
    mime_type: "application/pdf",
    size_bytes: 100,
    created_at: new Date().toISOString(),
  };
}

function viewFixture(
  over: Partial<Row> = {},
  apps: BewApplicationDTO[] = [appDto(1, { contact_name: "Herr Weber" })],
  docs: BewCampaignDocumentDTO[] = [docDto("doc-cv", "cv", "cv.pdf"), docDto("doc-cert", "certificate", "cert.pdf")],
): BewViewDTO {
  return {
    campaign: {
      id: "c1",
      user_id: "user-1",
      email_account_id: "acct-1",
      purpose: "ausbildung",
      status: "draft",
      requested_count: apps.length,
      valid_count: apps.length,
      total_count: apps.length,
      generated_count: apps.length,
      sent_count: 0,
      failed_count: 0,
      excluded_count: 0,
      usage_date: TODAY,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      email_subject: "Bewerbung bei {{company_name}}",
      email_body_html: "<p>{{greeting}}</p><p>UNIKER-EMAILMARKER-88 bei {{company_name}}.</p>",
      ...over,
    },
    applications: apps,
    documents: docs,
    usage: { remaining: 50, daily_limit: 50 },
    senderEmail: "sender@gmail.com",
  } as unknown as BewViewDTO;
}

describe("EmailMessageCard (SSR)", () => {
  function renderCard(view: BewViewDTO): string {
    return plain(
      renderToString(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(EmailMessageCard, {
            view,
            refresh: async () => undefined,
            applicantName: "Max Mustermann",
          }),
        ),
      ),
    );
  }

  it("renders the dedicated e-mail editor (subject, message, variables, templates)", () => {
    const html = renderCard(viewFixture());
    // The labeled section + stored draft values.
    expect(html).toContain("E-Mail-Nachricht");
    expect(html).toContain('value="Bewerbung bei {{company_name}}"');
    // The rich-text body editor is present (content is filled client-side).
    expect(html).toContain('aria-label="Email message"');
    // Subject + message labels.
    expect(html).toContain("Betreff");
    expect(html).toContain("Nachricht");
    // The four insert-variable controls.
    expect(html).toContain("Bewerber-Name");
    expect(html).toContain("Ansprechpartner");
    expect(html).toContain("Firmenname");
    expect(html).toContain("Anrede");
    // The ready-made German templates (fill only — they never send).
    expect(html).toContain("Ausbildung Bewerbung");
    expect(html).toContain("Allgemeine Bewerbung");
    expect(html).toContain("Praktikum Bewerbung");
    // Save + preview actions.
    expect(html).toContain("E-Mail speichern");
    expect(html).toContain("Vorschau");
    // Complete message → no incomplete badge.
    expect(html).not.toContain("Betreff und Nachricht sind für den Versand erforderlich.");
  });

  it("flags an incomplete message (empty body) and hides the badge when whole", () => {
    const html = renderCard(viewFixture({ email_body_html: "" }));
    expect(html).toContain("Betreff und Nachricht sind für den Versand erforderlich.");
  });

  it("is locked while a send is running (banner + disabled save)", () => {
    const html = renderCard(viewFixture({ status: "sending" }));
    expect(html).toContain("Während des laufenden Versands");
  });
});

describe("LetterModal preview (SSR) — e-mail and letter are DISTINCT items", () => {
  it("shows the rendered campaign e-mail separately from the letter preview", () => {
    const html = plain(
      renderToString(
        React.createElement(LetterModal, {
          app: appDto(1, { contact_name: "Herr Weber" }),
          mode: "preview",
          view: viewFixture(),
          busy: false,
          applicantName: "Max Mustermann",
          applicantEmail: "max@example.de",
          onClose: () => undefined,
          onSave: async () => undefined,
          t,
        }),
      ),
    );
    // The e-mail block for THIS recipient, with the resolved values…
    expect(html).toContain("E-Mail (für diesen Empfänger)");
    expect(html).toContain("Bewerbung bei Firma 1");
    expect(html).toContain("UNIKER-EMAILMARKER-88 bei Firma 1.");
    expect(html).toContain("Sehr geehrter Herr Weber,");
    // …and the letter as its own (structured) preview.
    expect(html).toContain("UNIKER-BRIEFMARKER-1");
    // The e-mail block appears BEFORE the letter preview.
    const emailIdx = html.indexOf("UNIKER-EMAILMARKER-88");
    const letterIdx = html.indexOf("UNIKER-BRIEFMARKER-1");
    expect(emailIdx).toBeGreaterThan(-1);
    expect(letterIdx).toBeGreaterThan(-1);
    expect(emailIdx).toBeLessThan(letterIdx);
    // The attachments block lists the shared documents.
    expect(html).toContain("Anhänge");
    expect(html).toContain("cv.pdf");
    expect(html).toContain("cert.pdf");
  });

  it("points at the e-mail editor when no message is stored yet", () => {
    const html = plain(
      renderToString(
        React.createElement(LetterModal, {
          app: appDto(1),
          mode: "preview",
          view: viewFixture({ email_subject: "", email_body_html: "" }),
          busy: false,
          applicantName: "Max Mustermann",
          applicantEmail: "max@example.de",
          onClose: () => undefined,
          onSave: async () => undefined,
          t,
        }),
      ),
    );
    expect(html).toContain("E-Mail (für diesen Empfänger)");
    expect(html).toContain("Noch keine E-Mail-Nachricht gespeichert");
  });
});

/* ------------------------------------------------------------------ *
 * H. Static guards — persistence, wiring, and the no-send-from-template
 * ------------------------------------------------------------------ */

describe("static guards (source contracts)", () => {
  const src = (rel: string): string =>
    readFileSync(path.join(process.cwd(), rel), "utf8");

  it("keeps step 4 (review + e-mail editor) MOUNTED across wizard navigation", () => {
    expect(src("src/components/bewerbung-automation/client.tsx")).toContain(
      'step === 4 ? undefined : "hidden"',
    );
  });

  it("the send button is disabled while the e-mail message is incomplete", () => {
    const s = src("src/components/bewerbung-automation/send-step.tsx");
    expect(s).toContain("isBewEmailComplete");
    expect(s).toContain("!emailComplete");
    expect(s).toContain("flagEmailIncomplete");
  });

  it("templates fill the draft only — the card never sends and never edits the letter", () => {
    const s = src("src/components/bewerbung-automation/email-message.tsx");
    expect(s).toContain("setSubject(template.subject)");
    expect(s).toContain("setBodyHtml(template.bodyHtml)");
    expect(s).toContain("setDirty(true)");
    expect(s).not.toContain("bewStartSend");
    expect(s).not.toContain("bewUpdateLetter");
  });

  it("the review step carries the e-mail section (distinct from the letter rows)", () => {
    const s = src("src/components/bewerbung-automation/review-step.tsx");
    expect(s).toContain("<EmailMessageCard");
  });

  it("variable insertion happens at the cursor via the shared editor (insertText)", () => {
    const s = src("src/components/rich-email-editor.tsx");
    expect(s).toContain("execCommand");
    expect(s).toContain("insertText");
    expect(s).toContain("DEFAULT_VARIABLES"); // the standard campaign flow keeps its defaults
  });
});
