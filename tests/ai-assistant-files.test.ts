import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_CHAT_MAX_FILE_SIZE,
  canSendWith,
  checkClientFile,
  composerFileKey,
  fileBadge,
  formatFileSize,
  isImageMime,
} from "@/lib/ai-chat-files";

/**
 * AI Assistant attachment pipeline — server-side contract tests.
 *
 * Covers the real request path the chat UI drives:
 *   upload (content sniffing, ownership) → prepareChat (association,
 *   idempotent retry) → getAIContext (file context, follow-ups) →
 *   getConversation (per-message attachment visibility)
 * plus the /api/ai/files route (auth, invalid file rejection).
 */

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
vi.mock("@/lib/billing/entitlements", () => ({
  getEntitlements: vi.fn(async () => ({ aiPerDay: 100 })),
}));
vi.mock("@/lib/ai-provider", () => ({
  createAIProvider: vi.fn(() => ({
    analyzeFile: vi.fn(async () => "doc-analysis"),
    analyzeImage: vi.fn(async () => "image-analysis"),
  })),
}));
// The upload route now applies its per-user burst limit (ai_upload) before the
// body is buffered. The limiter library has its own suite; here it must simply
// ALLOW, so these tests keep describing the upload contract.
vi.mock("@/lib/rate-limit", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
  return {
    ...actual,
    checkRateLimit: vi.fn(async () => ({
      allowed: true,
      count: 1,
      limit: 30,
      retryAfterSeconds: 0,
    })),
  };
});

const { createAdminClient } = await import("@/lib/supabase/admin");
const { createClient } = await import("@/lib/supabase/server");
const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { getAIContext } = await import("@/lib/ai-context");
const {
  detectFileType,
  prepareChat,
  uploadAIFile,
  getConversation,
  validateAIFile,
} = await import("@/lib/ai-service");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

// ---------------------------------------------------------------------------
// In-memory Supabase-shaped admin client (only the chains ai-service uses).
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
type DB = {
  ai_conversations: Row[];
  ai_messages: Row[];
  ai_file_uploads: Row[];
  ai_message_files: Row[];
  storageFiles: Record<string, Buffer>;
  storageMeta: Record<string, { contentType?: string }>;
  failInsertForTable?: string;
};
function makeDb(): DB {
  return {
    ai_conversations: [],
    ai_messages: [],
    ai_file_uploads: [],
    ai_message_files: [],
    storageFiles: {},
    storageMeta: {},
  };
}
type TableName =
  | "ai_conversations"
  | "ai_messages"
  | "ai_file_uploads"
  | "ai_message_files";
function makeAdmin(db: DB) {
  const tables = db as Record<TableName, Row[]>;
  const project = (rows: Row[], cols: string[] | null): Row[] =>
    cols?.length
      ? rows.map((row) =>
          Object.fromEntries(cols.map((c) => [c, row[c] ?? null])),
        )
      : rows;
  const makeTable = (name: TableName) => {
    let cols: string[] | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    let order: { col: string; asc: boolean } | null = null;
    let limit: number | null = null;
    let insert: Row[] | null = null;
    let update: Row | null = null;
    let deleting = false;
    const exec = async () => {
      const all = tables[name];
      const matched = all.filter((r) => filters.every((f) => f(r)));
      if (insert) {
        if (db.failInsertForTable === name) {
          db.failInsertForTable = undefined;
          return { data: null, error: { message: "insert failed" } };
        }
        const created = insert.map((row) => ({
          id: randomUUID(),
          created_at: new Date().toISOString(),
          ...row,
        }));
        tables[name] = [...all, ...created];
        return { data: project(created, cols), error: null };
      }
      if (update) {
        tables[name] = all.map((r) =>
          filters.every((f) => f(r)) ? { ...r, ...update } : r,
        );
        return {
          data: project(matched.map((r) => ({ ...r, ...update })), cols),
          error: null,
        };
      }
      if (deleting) {
        tables[name] = all.filter((r) => !filters.every((f) => f(r)));
        return { data: project(matched, cols), error: null };
      }
      let result = [...matched];
      if (order) {
        const ord = order;
        result.sort((a, b) =>
          String(a[ord.col]) < String(b[ord.col])
            ? ord.asc
              ? -1
              : 1
            : ord.asc
              ? 1
              : -1,
        );
      }
      if (limit) result = result.slice(0, limit);
      return { data: project(result, cols), error: null };
    };
    const q = {
      select: (c: string) => {
        cols = c.split(",").map((s) => s.trim());
        return q;
      },
      eq: (k: string, v: unknown) => {
        filters.push((r) => r[k] === v);
        return q;
      },
      in: (k: string, arr: unknown[]) => {
        filters.push((r) => arr.includes(r[k]));
        return q;
      },
      order: (col: string, opts: { ascending?: boolean } = {}) => {
        order = { col, asc: opts.ascending !== false };
        return q;
      },
      limit: (n: number) => {
        limit = n;
        return q;
      },
      insert: (rows: Row | Row[]) => {
        insert = Array.isArray(rows) ? rows : [rows];
        return q;
      },
      update: (u: Row) => {
        update = u;
        return q;
      },
      delete: () => {
        deleting = true;
        return q;
      },
      single: async () => {
        const { data, error } = await exec();
        const rows = (data ?? []) as Row[];
        return {
          data: rows[0] ?? null,
          error:
            rows.length === 1 ? null : (error ?? { message: "no rows" }),
        };
      },
      then: (
        res: (v: unknown) => unknown,
        rej?: (e: unknown) => unknown,
      ) => Promise.resolve(exec()).then(res, rej),
    };
    return q;
  };
  return {
    from: (name: string) => makeTable(name as TableName),
    rpc: async () => ({ data: { remaining: 99 }, error: null }),
    storage: {
      from: () => ({
        upload: async (
          path: string,
          data: Buffer,
          opts: { contentType?: string } = {},
        ) => {
          db.storageFiles[path] = Buffer.isBuffer(data)
            ? data
            : Buffer.from(await (data as Blob).arrayBuffer());
          db.storageMeta[path] = { contentType: opts.contentType };
          return { error: null };
        },
        download: async (path: string) =>
          db.storageFiles[path]
            ? {
                data: new Blob([
                  new Uint8Array(db.storageFiles[path]),
                ]),
                error: null,
              }
            : { data: null, error: { message: "Object not found" } },
        remove: async (paths: string[]) => {
          for (const p of paths) delete db.storageFiles[p];
          return { error: null };
        },
      }),
    },
  };
}

let db: DB;
beforeEach(() => {
  db = makeDb();
  (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(
    makeAdmin(db),
  );
  (getCurrentUserAndProfile as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { id: USER_ID, email: "test@example.test" },
    profile: { id: "profile-1", account_status: "active" },
  });
});

function seedConversation(id = randomUUID(), userId = USER_ID) {
  const row: Row = {
    id,
    user_id: userId,
    title: "New conversation",
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:00:00Z",
  };
  db.ai_conversations.push(row);
  return row;
}
function seedUpload(opts: {
  id?: string;
  userId?: string;
  filename?: string;
  mime?: string;
  content?: Buffer;
} = {}) {
  const userId = opts.userId ?? USER_ID;
  const filename = opts.filename ?? "note.txt";
  const content = opts.content ?? Buffer.from("hello context");
  const storagePath = `${userId}/${randomUUID()}-${filename}`;
  db.storageFiles[storagePath] = content;
  const row: Row = {
    id: opts.id ?? randomUUID(),
    user_id: userId,
    storage_path: storagePath,
    filename,
    mime_type: opts.mime ?? "text/plain",
    size_bytes: content.length,
    created_at: "2026-09-01T10:00:00Z",
  };
  db.ai_file_uploads.push(row);
  return row;
}
function seedMessage(opts: {
  content?: string;
  role?: "user" | "assistant";
  conversationId: string;
  files?: Array<{ storagePath: string; filename: string; mime: string; size: number }>;
}) {
  const row: Row = {
    id: randomUUID(),
    conversation_id: opts.conversationId,
    user_id: USER_ID,
    role: opts.role ?? "user",
    content: opts.content ?? "message",
    created_at: new Date(Date.now() - 1000).toISOString(),
  };
  db.ai_messages.push(row);
  for (const file of opts.files ?? []) {
    db.ai_message_files.push({
      id: randomUUID(),
      message_id: row.id,
      user_id: USER_ID,
      storage_path: file.storagePath,
      filename: file.filename,
      mime_type: file.mime,
      size_bytes: file.size,
      created_at: row.created_at,
    });
  }
  return row;
}

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");
const DOC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const DOCX = Buffer.from(
  "PK\x03\x04dummyword/document.xml[Content_Types].xml",
  "latin1",
);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP = Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "latin1");

// ---------------------------------------------------------------------------
// Content-based type detection (the browser's File.type is NOT trusted).
// ---------------------------------------------------------------------------
describe("detectFileType (magic bytes)", () => {
  it("detects pdf, doc, docx, txt, png, jpeg, webp", () => {
    expect(detectFileType(PDF)).toBe("pdf");
    expect(detectFileType(DOC)).toBe("doc");
    expect(detectFileType(DOCX)).toBe("docx");
    expect(detectFileType(Buffer.from("Lebenslauf\nMax Mustermann"))).toBe(
      "txt",
    );
    expect(detectFileType(PNG)).toBe("png");
    expect(detectFileType(JPEG)).toBe("jpeg");
    expect(detectFileType(WEBP)).toBe("webp");
  });
  it("rejects unknown binary content, plain zips, and empty input", () => {
    expect(detectFileType(Buffer.from([1, 2, 3, 4, 250, 251, 0, 9]))).toBe(
      null,
    );
    expect(detectFileType(Buffer.from("PK\x03\x04just-a-zip", "latin1"))).toBe(
      null,
    );
    expect(detectFileType(Buffer.alloc(0))).toBeNull();
  });
});

describe("validateAIFile (server-side, content-based)", () => {
  it("accepts a PDF even when the browser reports an EMPTY type", () => {
    const file = new File([PDF], "cv.pdf", { type: "" });
    expect(validateAIFile(file, Buffer.from(PDF))).toBe("pdf");
  });
  it("accepts an octet-stream hint (content decides)", () => {
    const file = new File([DOCX], "cv.docx", {
      type: "application/octet-stream",
    });
    expect(validateAIFile(file, Buffer.from(DOCX))).toBe("docx");
  });
  it("rejects a hint that contradicts the content", () => {
    const file = new File([PDF], "cv.pdf", { type: "text/plain" });
    expect(() => validateAIFile(file, Buffer.from(PDF))).toThrow(
      "does not match",
    );
  });
  it("rejects files over 10 MB", () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61);
    const file = new File([big], "big.txt", { type: "text/plain" });
    expect(() => validateAIFile(file, big)).toThrow("10 MB");
  });
  it("rejects unsupported content", () => {
    const file = new File([Buffer.from([1, 2, 3, 4])], "evil.bin", {
      type: "application/octet-stream",
    });
    expect(() => validateAIFile(file, Buffer.from([1, 2, 3, 4]))).toThrow(
      "not supported",
    );
  });
});

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------
describe("uploadAIFile", () => {
  it("stores the CONTENT-DETECTED mime type, not the browser's", async () => {
    const file = new File([PDF], "Lebenslauf.pdf", { type: "" });
    const result = await uploadAIFile(file);
    expect(result.mime_type).toBe("application/pdf");
    expect(result.filename).toBe("Lebenslauf.pdf");
    expect(result.id).toBeTruthy();
    const paths = Object.keys(db.storageFiles);
    expect(paths).toHaveLength(1);
    // User-scoped storage prefix (ownership by construction) + original name.
    expect(paths[0].startsWith(`${USER_ID}/`)).toBe(true);
    expect(paths[0].endsWith("-Lebenslauf.pdf")).toBe(true);
    expect(db.storageMeta[paths[0]].contentType).toBe("application/pdf");
    const row = db.ai_file_uploads[0];
    expect(row.user_id).toBe(USER_ID);
    expect(row.mime_type).toBe("application/pdf");
  });
  it("rejects contradicting metadata without storing anything", async () => {
    const file = new File([PDF], "cv.pdf", { type: "text/plain" });
    await expect(uploadAIFile(file)).rejects.toThrow("does not match");
    expect(Object.keys(db.storageFiles)).toHaveLength(0);
    expect(db.ai_file_uploads).toHaveLength(0);
  });
  it("cleans up the storage object when metadata insert fails", async () => {
    db.failInsertForTable = "ai_file_uploads";
    const file = new File([PDF], "cv.pdf", { type: "application/pdf" });
    await expect(uploadAIFile(file)).rejects.toThrow(
      "Unable to save uploaded file metadata",
    );
    expect(Object.keys(db.storageFiles)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// prepareChat — association + ownership + idempotent retry
// ---------------------------------------------------------------------------
describe("prepareChat", () => {
  it("rejects an empty message without attachments", async () => {
    const conv = seedConversation();
    await expect(
      prepareChat(USER_ID, conv.id as string, "  ", []),
    ).rejects.toThrow("Enter a message or attach a file.");
  });
  it("associates the uploaded files with the new user message", async () => {
    const conv = seedConversation();
    const upload = seedUpload({
      filename: "cv.txt",
      content: Buffer.from("cv text"),
    });
    const message = await prepareChat(
      USER_ID,
      conv.id as string,
      "Analysiere meinen Lebenslauf",
      [upload.id as string],
    );
    expect(db.ai_messages).toHaveLength(1);
    expect(db.ai_messages[0].role).toBe("user");
    expect(db.ai_message_files).toHaveLength(1);
    expect(db.ai_message_files[0].message_id).toBe(message.id);
    expect(db.ai_message_files[0].user_id).toBe(USER_ID);
    expect(db.ai_conversations[0].updated_at).not.toBe(
      "2026-09-01T10:00:00Z",
    );
  });
  it("dedupes repeated file ids instead of failing the count check", async () => {
    const conv = seedConversation();
    const upload = seedUpload();
    await expect(
      prepareChat(USER_ID, conv.id as string, "Hi", [
        upload.id as string,
        upload.id as string,
      ]),
    ).resolves.toBeTruthy();
    expect(db.ai_message_files).toHaveLength(1);
  });
  it("rejects files owned by ANOTHER user (unauthorized attachment access)", async () => {
    const conv = seedConversation();
    const foreign = seedUpload({ userId: OTHER_ID });
    await expect(
      prepareChat(USER_ID, conv.id as string, "Hi", [foreign.id as string]),
    ).rejects.toThrow("not available");
    expect(db.ai_messages).toHaveLength(0);
  });
  it("retries are idempotent: same content + files create ONE user row", async () => {
    const conv = seedConversation();
    const upload = seedUpload();
    const first = await prepareChat(USER_ID, conv.id as string, "Hi", [
      upload.id as string,
    ]);
    const second = await prepareChat(USER_ID, conv.id as string, "Hi", [
      upload.id as string,
    ]);
    expect(db.ai_messages).toHaveLength(1);
    expect(db.ai_message_files).toHaveLength(1);
    expect(second.id).toBe(first.id);
  });
  it("a different message after a retry still creates a new row", async () => {
    const conv = seedConversation();
    await prepareChat(USER_ID, conv.id as string, "Hi", []);
    const second = await prepareChat(USER_ID, conv.id as string, "Follow-up", []);
    expect(db.ai_messages).toHaveLength(2);
    expect(second.role).toBe("user");
  });
  it("fails loudly when the association insert fails (no silent drop)", async () => {
    const conv = seedConversation();
    const upload = seedUpload();
    db.failInsertForTable = "ai_message_files";
    await expect(
      prepareChat(USER_ID, conv.id as string, "Hi", [upload.id as string]),
    ).rejects.toThrow("Unable to attach the selected files.");
  });
});

// ---------------------------------------------------------------------------
// getAIContext — the AI actually receives the file content
// ---------------------------------------------------------------------------
describe("getAIContext", () => {
  it("includes the attached document content with the untrusted-material prefix", async () => {
    const conv = seedConversation();
    const upload = seedUpload({
      filename: "cv.txt",
      content: Buffer.from("Lebenslauf: Max Mustermann"),
    });
    seedMessage({
      conversationId: conv.id as string,
      content: "Analysiere meinen Lebenslauf",
      files: [
        {
          storagePath: upload.storage_path as string,
          filename: "cv.txt",
          mime: "text/plain",
          size: 28,
        },
      ],
    });
    const context = await getAIContext(USER_ID, conv.id as string);
    const last = context.messages.at(-1);
    expect(last?.role).toBe("user");
    expect(String(last?.content)).toContain("untrusted reference material");
    expect(String(last?.content)).toContain("Lebenslauf: Max Mustermann");
    // The context message comes AFTER the conversation history.
    expect(context.messages.length).toBeGreaterThanOrEqual(2);
    expect(context.messages.at(-2)?.content).toBe(
      "Analysiere meinen Lebenslauf",
    );
  });
  it("keeps the file context for FOLLOW-UP questions (walks back)", async () => {
    const conv = seedConversation();
    const upload = seedUpload({
      filename: "cv.txt",
      content: Buffer.from("Lebenslauf: Anna Beispiel"),
    });
    seedMessage({
      conversationId: conv.id as string,
      content: "Analysiere meinen Lebenslauf",
      files: [
        {
          storagePath: upload.storage_path as string,
          filename: "cv.txt",
          mime: "text/plain",
          size: 27,
        },
      ],
    });
    seedMessage({
      conversationId: conv.id as string,
      content: "Was fehlt mir noch?",
    });
    const context = await getAIContext(USER_ID, conv.id as string);
    const last = String(context.messages.at(-1)?.content ?? "");
    expect(last).toContain("Lebenslauf: Anna Beispiel");
  });
  it("uses the existing vision capability for image attachments", async () => {
    const conv = seedConversation();
    const upload = seedUpload({
      filename: "screenshot.png",
      mime: "image/png",
      content: Buffer.from(PNG),
    });
    seedMessage({
      conversationId: conv.id as string,
      content: "Was steht auf dem Bild?",
      files: [
        {
          storagePath: upload.storage_path as string,
          filename: "screenshot.png",
          mime: "image/png",
          size: PNG.length,
        },
      ],
    });
    const context = await getAIContext(USER_ID, conv.id as string);
    const last = String(context.messages.at(-1)?.content ?? "");
    expect(last).toContain("IMAGE ANALYSIS screenshot.png");
    expect(last).toContain("image-analysis");
  });
  it("routes legacy .doc through the existing document analysis capability", async () => {
    const conv = seedConversation();
    const upload = seedUpload({
      filename: "alt.doc",
      mime: "application/msword",
      content: Buffer.from(DOC),
    });
    seedMessage({
      conversationId: conv.id as string,
      content: "Analysiere das Dokument",
      files: [
        {
          storagePath: upload.storage_path as string,
          filename: "alt.doc",
          mime: "application/msword",
          size: DOC.length,
        },
      ],
    });
    const context = await getAIContext(USER_ID, conv.id as string);
    const last = String(context.messages.at(-1)?.content ?? "");
    expect(last).toContain("FILE alt.doc");
    expect(last).toContain("doc-analysis");
  });
  it("adds no context message when no attachment exists", async () => {
    const conv = seedConversation();
    seedMessage({ conversationId: conv.id as string, content: "Hallo" });
    const context = await getAIContext(USER_ID, conv.id as string);
    expect(context.messages).toHaveLength(1);
    expect(String(context.messages[0].content)).not.toContain(
      "untrusted reference material",
    );
  });
});

// ---------------------------------------------------------------------------
// getConversation — attachments stay visible on the sent message
// ---------------------------------------------------------------------------
describe("getConversation", () => {
  it("returns per-message attachment metadata (no storage paths)", async () => {
    const conv = seedConversation();
    const upload = seedUpload({
      filename: "cv.txt",
      content: Buffer.from("cv"),
    });
    const userMsg = seedMessage({
      conversationId: conv.id as string,
      content: "Analysiere",
      files: [
        {
          storagePath: upload.storage_path as string,
          filename: "cv.txt",
          mime: "text/plain",
          size: 2,
        },
      ],
    });
    seedMessage({
      conversationId: conv.id as string,
      role: "assistant",
      content: "Gerne.",
    });
    const data = await getConversation(conv.id as string);
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0].files).toEqual([
      { filename: "cv.txt", mime_type: "text/plain", size_bytes: 2 },
    ]);
    expect(data.messages[1].files).toEqual([]);
    expect(userMsg.id).toBe(data.messages[0].id);
  });
});

// ---------------------------------------------------------------------------
// /api/ai/files route — auth + invalid file rejection
// ---------------------------------------------------------------------------
describe("/api/ai/files", () => {
  async function routeRequest(body: BodyInit, userId: string | null) {
    (createClient as ReturnType<typeof vi.fn>).mockReturnValue({
      auth: {
        getUser: async () => ({
          data: { user: userId ? { id: userId } : null },
        }),
      },
    });
    const { POST } = await import("@/app/api/ai/files/route");
    return POST(
      new Request("http://localhost/api/ai/files", { method: "POST", body }),
    );
  }
  it("rejects unauthenticated uploads with 401", async () => {
    const form = new FormData();
    form.set("file", new File([PDF], "cv.pdf", { type: "application/pdf" }));
    const response = await routeRequest(form, null);
    expect(response.status).toBe(401);
  });
  it("rejects an unsupported file (non-text binary) with 400", async () => {
    const form = new FormData();
    form.set(
      "file",
      new File([Buffer.from([1, 2, 3, 4, 250, 251, 0, 9])], "evil.bin", {
        type: "application/octet-stream",
      }),
    );
    const response = await routeRequest(form, USER_ID);
    expect(response.status).toBe(400);
    const result = (await response.json()) as { error: string };
    expect(result.error).toBe("This file type is not supported.");
    expect(db.ai_file_uploads).toHaveLength(0);
  });
  it("uploads a valid PDF and returns the stored metadata", async () => {
    const form = new FormData();
    form.set("file", new File([PDF], "cv.pdf", { type: "application/pdf" }));
    const response = await routeRequest(form, USER_ID);
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      id: string;
      filename: string;
      mime_type: string;
    };
    expect(result.filename).toBe("cv.pdf");
    expect(result.mime_type).toBe("application/pdf");
    expect(db.ai_file_uploads).toHaveLength(1);
  });
  it("does not expose storage paths in the response", async () => {
    const form = new FormData();
    form.set("file", new File([PDF], "cv.pdf", { type: "application/pdf" }));
    const response = await routeRequest(form, USER_ID);
    const raw = await response.text();
    expect(raw).not.toContain(USER_ID);
    expect(raw).not.toContain(".pdf/");
  });
});

// ---------------------------------------------------------------------------
// Composer helpers (attachment selection validation, dedupe, send gating)
// ---------------------------------------------------------------------------
describe("composer helpers (ai-chat-files)", () => {
  it("validates size, extension and empty files before upload", () => {
    expect(checkClientFile({ name: "cv.pdf", size: 100 }).ok).toBe(true);
    expect(checkClientFile({ name: "cv", size: 100 }).ok).toBe(false);
    expect(checkClientFile({ name: "cv.exe", size: 100 }).ok).toBe(false);
    expect(checkClientFile({ name: "cv.pdf", size: 0 }).ok).toBe(false);
    expect(
      checkClientFile({ name: "cv.pdf", size: AI_CHAT_MAX_FILE_SIZE + 1 }),
    ).toEqual(expect.objectContaining({ ok: false }));
    expect(
      checkClientFile({ name: "cv.pdf", size: AI_CHAT_MAX_FILE_SIZE }).ok,
    ).toBe(true);
  });
  it("dedupes by name+size and gates sending correctly", () => {
    expect(composerFileKey("cv.pdf", 100)).toBe(composerFileKey("cv.pdf", 100));
    expect(composerFileKey("cv.pdf", 100)).not.toBe(composerFileKey("cv.pdf", 101));
    expect(canSendWith(true, 0, false, false)).toBe(true);
    expect(canSendWith(false, 1, false, false)).toBe(true);
    expect(canSendWith(false, 0, false, false)).toBe(false);
    expect(canSendWith(true, 0, true, false)).toBe(false); // upload running
    expect(canSendWith(true, 0, false, true)).toBe(false); // streaming
  });
  it("formats sizes German-style and badges extensions", () => {
    expect(formatFileSize(900)).toBe("900 B");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(Math.round(2.4 * 1024 * 1024))).toBe("2,4 MB");
    expect(fileBadge("Lebenslauf.pdf")).toBe("PDF");
    expect(fileBadge("bild.jpeg")).toBe("JPG");
    expect(fileBadge("keine-endung")).toBe("DATEI");
    expect(isImageMime("image/png")).toBe(true);
    expect(isImageMime("application/pdf")).toBe(false);
  });
});
