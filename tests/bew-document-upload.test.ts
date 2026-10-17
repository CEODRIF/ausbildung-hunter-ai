/**
 * Bewerbung Automation — document upload regression (second-document bug).
 *
 * PRODUCTION SYMPTOM
 *   Documents step: the CV (CV.pdf) uploads fine; a second file as
 *   "Certificate / diploma" fails with the generic
 *   "Something went wrong. Please try again." The CV stays attached, the
 *   certificate slot stays required.
 *
 * ROOT CAUSE
 *   The upload ran as a Next.js SERVER ACTION, whose request body is capped
 *   at 1 MB by default (serverActions.bodySizeLimit). A one-page CV
 *   (a few hundred KB) passes; a multi-page certificate scan (>1 MB) is
 *   rejected by the framework with a 413 BEFORE the engine runs — a
 *   non-stable-code error the UI maps to the generic UNKNOWN message.
 *   The fix moves the upload (and the sibling PDF import) to ROUTE
 *   HANDLERS (the project's established pattern for file uploads:
 *   /api/ai/files, /api/bewerbung-scanner/files) and turns every engine
 *   failure on this path into a stable, user-visible error category.
 *
 * What this suite pins (engine runs against the in-memory fake that models
 * the REAL schema constraints — unique storage_path, upsert on
 * (campaign_id, document_id) — plus storage object tracking):
 *   - CV upload + attach succeeds; a SECOND document after the first
 *     succeeds too (the exact repro), and the CV is preserved;
 *   - invalid MIME / oversized files fail with stable codes, no side effects;
 *   - ownership isolation (another user's document/campaign is NOT_FOUND);
 *   - a failed metadata insert removes the storage object (compensating)
 *     and surfaces DOC_SAVE_FAILED — never a silent half-upload.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;
type TableKey =
  | "bew_campaigns"
  | "bew_applications"
  | "bew_documents"
  | "bew_campaign_documents"
  | "email_accounts";

interface StorageState {
  objects: Map<string, { buffer: Uint8Array; contentType: string }>;
  /** Fail every upload (simulates a storage outage). */
  failUploads: boolean;
  /** Last bucket the engine addressed (regression guard on the bucket choice). */
  lastBucket: string | null;
}

interface DB {
  bew_campaigns: Row[];
  bew_applications: Row[];
  bew_documents: Row[];
  bew_campaign_documents: Row[];
  email_accounts: Row[];
  storage: StorageState;
  /** Tables whose INSERT should fail (simulates a DB write failure). */
  insertFailTables: Set<string>;
}

const USER = "user-1";
const OTHER = "user-2";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const DEFAULTS: Partial<Record<TableKey, Row>> = {
  bew_campaigns: {
    email_account_id: null,
    purpose: "ausbildung",
    status: "draft",
    requested_count: 10,
    valid_count: 0,
    total_count: 10,
    generated_count: 0,
    sent_count: 0,
    failed_count: 0,
    excluded_count: 0,
    usage_date: new Date().toISOString().slice(0, 10),
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
  },
  bew_documents: {
    created_at: new Date().toISOString(),
  },
  bew_campaign_documents: {
    created_at: new Date().toISOString(),
  },
};

function freshDb(): DB {
  return {
    bew_campaigns: [
      {
        id: "camp-1",
        user_id: USER,
        email_account_id: "acct-1",
        purpose: "ausbildung",
        status: "draft",
        requested_count: 10,
        valid_count: 10,
        total_count: 10,
        generated_count: 0,
        sent_count: 0,
        failed_count: 0,
        excluded_count: 0,
        usage_date: new Date().toISOString().slice(0, 10),
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
      },
    ],
    bew_applications: [],
    bew_documents: [],
    bew_campaign_documents: [],
    email_accounts: [
      {
        id: "acct-1",
        user_id: USER,
        email: "sender@gmail.com",
        is_active: true,
        requires_reconnect: false,
        created_at: new Date().toISOString(),
      },
    ],
    storage: { objects: new Map(), failUploads: false, lastBucket: null },
    insertFailTables: new Set(),
  };
}

let db: DB;

/** Chainable builder mirroring the real Supabase proxy surface used by the engine. */
function makeFrom(table: TableKey) {
  const state = {
    op: "select" as string,
    payload: undefined as any,
    onConflict: undefined as string[] | undefined,
    filters: [] as Array<{ col: string; val: any }>,
    orderBy: [] as Array<{ col: string; ascending: boolean }>,
    limitN: undefined as number | undefined,
    terminal: undefined as "single" | "maybeSingle" | undefined,
  };

  function rows(): Row[] {
    let out = (db[table] ?? []).slice();
    for (const f of state.filters) out = out.filter((r) => r[f.col] === f.val);
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
        return { data: null, error: { message: "simulated insert failure" } };
      }
      const items = Array.isArray(state.payload) ? state.payload : [state.payload];
      const inserted = items.map((r) => ({
        ...DEFAULTS[table],
        ...r,
        id: r.id ?? `id-${Math.random()}`,
      }));
      for (const row of inserted) {
        // bew_documents.storage_path is UNIQUE in the schema — a duplicate
        // insert must fail exactly like the real database.
        if (
          table === "bew_documents" &&
          db.bew_documents.some((x) => x.storage_path === row.storage_path)
        ) {
          return {
            data: null,
            error: {
              message:
                'duplicate key value violates unique constraint "bew_documents_storage_path_unique"',
            },
          };
        }
      }
      (db[table] ??= []).push(...inserted);
      if (state.terminal === "single") return { data: inserted[0], error: null };
      return { data: inserted, error: null };
    }
    if (state.op === "upsert") {
      const cols = state.onConflict ?? [];
      const existing = (db[table] ?? []).find((r) =>
        cols.every((c) => r[c] === state.payload[c]),
      );
      if (existing) {
        Object.assign(existing, state.payload);
        if (state.terminal === "single") return { data: existing, error: null };
        return { data: [existing], error: null };
      }
      const row = {
        ...DEFAULTS[table],
        ...state.payload,
        id: state.payload.id ?? `id-${Math.random()}`,
      };
      (db[table] ??= []).push(row);
      if (state.terminal === "single") return { data: row, error: null };
      return { data: [row], error: null };
    }
    if (state.op === "update") {
      const matched = rows();
      for (const m of matched) Object.assign(m, state.payload);
      if (state.terminal === "single") return { data: matched[0] ?? null, error: null };
      if (state.terminal === "maybeSingle") return { data: matched[0] ?? null, error: null };
      return { data: matched, error: null };
    }
    if (state.op === "delete") {
      const matched = rows();
      (db[table] as Row[]) = (db[table] ?? []).filter((r) => !matched.includes(r));
      return { data: null, error: null };
    }
    const matched = rows();
    if (state.terminal === "single") return { data: matched[0] ?? null, error: null };
    if (state.terminal === "maybeSingle") return { data: matched[0] ?? null, error: null };
    return { data: matched, error: null };
  }

  const chain: any = {
    eq(col: string, val: any) {
      state.filters.push({ col, val });
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
    select() {
      return chain;
    },
    insert(payload: any) {
      state.op = "insert";
      state.payload = payload;
      return chain;
    },
    upsert(payload: any, opts?: { onConflict?: string }) {
      state.op = "upsert";
      state.payload = payload;
      state.onConflict = opts?.onConflict ? opts.onConflict.split(",") : [];
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
    rpc: async () => ({ data: null, error: null }),
    storage: {
      from: (bucket: string) => {
        // The engine must target the shared, already-provisioned bucket.
        db.storage.lastBucket = bucket;
        return {
        upload: async (path: string, buffer: Uint8Array, opts?: { contentType?: string }) => {
          if (db.storage.failUploads) return { error: { message: "simulated storage outage" } };
          if (!db.storage.objects.has(path)) {
            db.storage.objects.set(path, {
              buffer,
              contentType: opts?.contentType ?? "application/octet-stream",
            });
          }
          return { error: null };
        },
        remove: async (paths: string[]) => {
          for (const p of paths) db.storage.objects.delete(p);
          return { error: null };
        },
        download: async (path: string) => {
          const obj = db.storage.objects.get(path);
          if (!obj) return { data: null, error: { message: "not found" } };
          const blob = new Blob([obj.buffer as any]);
          return { data: blob, error: null };
        },
        };
      },
    },
  }),
}));
vi.mock("@/lib/email-campaigns", () => ({
  getUsageSnapshot: async () => ({
    date: new Date().toISOString().slice(0, 10),
    emails_sent: 0,
    emails_reserved: 0,
    daily_limit: 50,
    remaining: 50,
  }),
  reserveSenderSlot: async () => true,
}));
vi.mock("@/lib/email-providers", () => ({
  createEmailProvider: async () => ({ sendEmail: async () => ({ providerMessageId: "m" }) }),
}));
vi.mock("@/lib/application-drafts", () => ({
  sanitizeEmailHtml: (h: string) => h,
  htmlToText: (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
}));
vi.mock("@/lib/ai-provider", () => ({
  createAIProvider: () => ({ generateText: async () => "Text." }),
}));
vi.mock("@/lib/ai-service", () => ({
  // A DETERMINISTIC path (no randomUUID) so tests can assert on storage
  // objects; the shape (owner-scoped, unique per upload) matches production.
  storagePath: (userId: string, filename: string) => `${userId}/test-${filename}`,
  reserveAIUsage: async () => undefined,
}));
vi.mock("@/lib/pdf-extract", () => ({ extractPdfText: async () => "" }));
vi.mock("mammoth", () => ({ default: { extractRawText: async () => ({ value: "docx" }) } }));

// The documents-step imports the actions module; keep its import graph
// hermetic (no auth/supabase-server loading in the node test env).
vi.mock("@/app/bewerbung-automation/actions", () => ({
  bewAttachDocument: vi.fn(),
  bewDetachDocument: vi.fn(),
  bewListDocuments: vi.fn(async () => []),
}));

const {
  attachBewDocument,
  detachBewDocument,
  listBewDocuments,
  uploadBewDocument,
} = await import("@/lib/bewerbung-engine");
const { errMessage } = await import("@/components/bewerbung-automation/documents-step");
const { translate } = await import("@/lib/i18n");
const { DEFAULT_LANGUAGE } = await import("@/lib/i18n/dictionaries");

function fileOf(name: string, mime: string, bytes = 8): File {
  return new File([new Uint8Array(bytes)], name, { type: mime });
}

function campaignDocs(): Row[] {
  return db.bew_campaign_documents.filter((r) => r.campaign_id === "camp-1");
}

/* ------------------------------------------------------------------ *
 * Engine — the repro: a second document after a successful first
 * ------------------------------------------------------------------ */

describe("documents: upload + attach, first and second", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("uploads and attaches a CV (the path that always worked)", async () => {
    const doc = await uploadBewDocument(USER, fileOf("CV.pdf", "application/pdf"), "cv");
    expect(doc.kind).toBe("cv");
    expect(db.bew_documents).toHaveLength(1);
    expect(db.storage.objects.size).toBe(1);
    // The send path reads from this exact (already provisioned) bucket.
    expect(db.storage.lastBucket).toBe("application-attachments");

    const attached = await attachBewDocument(USER, "camp-1", doc.id, "cv");
    expect(attached.kind).toBe("cv");
    expect(campaignDocs()).toHaveLength(1);
  });

  it("uploads and attaches a SECOND document (certificate) after the first — the exact repro, and preserves the CV", async () => {
    // 1st: CV.
    const cv = await uploadBewDocument(USER, fileOf("CV.pdf", "application/pdf"), "cv");
    await attachBewDocument(USER, "camp-1", cv.id, "cv");

    // 2nd: certificate (previously 413'd at the framework layer for >1 MB;
    // here the engine path must complete cleanly for any valid size).
    const cert = await uploadBewDocument(
      USER,
      fileOf("Diplom.pdf", "application/pdf", 2_500_000),
      "certificate",
    );
    expect(cert.id).not.toBe(cv.id);
    await attachBewDocument(USER, "camp-1", cert.id, "certificate");

    // Both library rows, both storage objects — nothing was overwritten.
    expect(db.bew_documents).toHaveLength(2);
    expect(db.storage.objects.size).toBe(2);

    // Both attached with their own kinds; the CV row is UNTOUCHED.
    const docs = campaignDocs();
    expect(docs).toHaveLength(2);
    const byKind = Object.fromEntries(docs.map((d) => [d.kind, d]));
    expect(byKind.cv.filename).toBe("CV.pdf");
    expect(byKind.certificate.filename).toBe("Diplom.pdf");
    expect(byKind.cv.document_id).toBe(cv.id);
  });

  it("re-attaching the same document is idempotent (upsert on campaign+document)", async () => {
    const doc = await uploadBewDocument(USER, fileOf("CV.pdf", "application/pdf"), "cv");
    await attachBewDocument(USER, "camp-1", doc.id, "cv");
    await attachBewDocument(USER, "camp-1", doc.id, "certificate"); // kind corrected
    expect(campaignDocs()).toHaveLength(1);
    expect(campaignDocs()[0].kind).toBe("certificate");
  });

  it("detaching removes the campaign link but keeps the library file", async () => {
    const doc = await uploadBewDocument(USER, fileOf("CV.pdf", "application/pdf"), "cv");
    await attachBewDocument(USER, "camp-1", doc.id, "cv");
    await detachBewDocument(USER, "camp-1", doc.id);
    expect(campaignDocs()).toHaveLength(0);
    expect(db.bew_documents).toHaveLength(1);
    expect(db.storage.objects.size).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Validation + failure paths (stable codes, no half-states)
 * ------------------------------------------------------------------ */

describe("documents: validation and failure cleanup", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("rejects an unsupported MIME before any storage/DB write", async () => {
    await expect(
      uploadBewDocument(USER, fileOf("notes.txt", "text/plain"), "certificate"),
    ).rejects.toThrow("DOCUMENT_UNSUPPORTED");
    expect(db.storage.objects.size).toBe(0);
    expect(db.bew_documents).toHaveLength(0);
  });

  it("rejects an oversized file before any storage/DB write", async () => {
    const tooBig = 10 * 1024 * 1024 + 1;
    await expect(
      uploadBewDocument(USER, fileOf("huge.pdf", "application/pdf", tooBig), "cv"),
    ).rejects.toThrow("DOCUMENT_TOO-LARGE");
    expect(db.storage.objects.size).toBe(0);
    expect(db.bew_documents).toHaveLength(0);
  });

  it("rejects an invalid kind", async () => {
    await expect(
      uploadBewDocument(USER, fileOf("x.pdf", "application/pdf"), "nope" as never),
    ).rejects.toThrow("INVALID_KIND");
  });

  it("removes the storage object when the metadata insert fails (no orphan)", async () => {
    db.insertFailTables.add("bew_documents");
    await expect(
      uploadBewDocument(USER, fileOf("CV.pdf", "application/pdf"), "cv"),
    ).rejects.toThrow("DOC_SAVE_FAILED");
    // The file WAS written, then compensated — nothing may remain.
    expect(db.storage.objects.size).toBe(0);
    expect(db.bew_documents).toHaveLength(0);
  });

  it("surfaces a storage outage as the stable DOC_UPLOAD_FAILED category", async () => {
    db.storage.failUploads = true;
    await expect(
      uploadBewDocument(USER, fileOf("CV.pdf", "application/pdf"), "cv"),
    ).rejects.toThrow("DOC_UPLOAD_FAILED");
    expect(db.bew_documents).toHaveLength(0);
  });

  it("a failed attach keeps the library document (user can retry the attach)", async () => {
    const doc = await uploadBewDocument(USER, fileOf("CV.pdf", "application/pdf"), "cv");
    // Campaign in a terminal state → attach must refuse (CAMPAIGN_CLOSED).
    db.bew_campaigns[0].status = "completed";
    await expect(attachBewDocument(USER, "camp-1", doc.id, "cv")).rejects.toThrow(
      "CAMPAIGN_CLOSED",
    );
    expect(db.bew_documents).toHaveLength(1); // the upload itself is preserved
    expect(campaignDocs()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Ownership isolation
 * ------------------------------------------------------------------ */

describe("documents: ownership isolation", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("another user cannot attach someone else's document (NOT_FOUND, not just blocked)", async () => {
    const doc = await uploadBewDocument(USER, fileOf("CV.pdf", "application/pdf"), "cv");
    // The other user sees NO trace of the document (id-based lookup by owner).
    await expect(attachBewDocument(OTHER, "camp-1", doc.id, "cv")).rejects.toThrow("NOT_FOUND");
    expect(campaignDocs()).toHaveLength(0);
  });

  it("the library listing is owner-scoped", async () => {
    await uploadBewDocument(USER, fileOf("CV.pdf", "application/pdf"), "cv");
    await uploadBewDocument(OTHER, fileOf("cert.docx", DOCX_MIME), "certificate");
    const mine = await listBewDocuments(USER);
    const theirs = await listBewDocuments(OTHER);
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(mine[0].filename).toBe("CV.pdf");
    expect(theirs[0].filename).toBe("cert.docx");
  });

  it("attaching into a campaign that is not yours fails (ownership, not a silent skip)", async () => {
    const doc = await uploadBewDocument(OTHER, fileOf("cert.docx", DOCX_MIME), "certificate");
    // camp-1 belongs to USER; OTHER attaching to it must NOT touch it.
    await expect(attachBewDocument(OTHER, "camp-1", doc.id, "certificate")).rejects.toThrow(
      "NOT_FOUND",
    );
    expect(campaignDocs()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Client — the safe error category must reach the user (no more generic)
 * ------------------------------------------------------------------ */

describe("client errMessage: stable codes map to localized text", () => {
  const t = (k: string, v?: Record<string, string | number>) =>
    translate(DEFAULT_LANGUAGE, k, v);

  it.each([
    "DOC_UPLOAD_FAILED",
    "DOC_SAVE_FAILED",
    "DOC_ATTACH_FAILED",
    "DOCUMENT_TOO-LARGE",
    "DOCUMENT_UNSUPPORTED",
    "PDF_REQUIRED",
  ] as const)("%s renders its dedicated message, not the generic fallback", (code) => {
    const msg = errMessage(new Error(code), t);
    expect(msg).not.toBe(t("bewauto.err.UNKNOWN"));
    expect(msg).not.toBe(`bewauto.err.${code}`); // actually translated
  });

  it("an unknown/garbage error falls back to the generic message", () => {
    expect(errMessage(new Error("weird-raw-text"), t)).toBe(t("bewauto.err.UNKNOWN"));
    expect(errMessage("not even an Error", t)).toBe(t("bewauto.err.UNKNOWN"));
  });
});
