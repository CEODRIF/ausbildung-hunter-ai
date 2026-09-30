import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AI Assistant chat pipeline — the real request path the UI drives:
 *
 *   POST /api/ai/chat → prepareChat (user message + attachments +
 *   idempotent retry) → getAIContext (ordered history + file context) →
 *   provider streamText → progressive streaming → persistence of the final
 *   (or partial, on abort) assistant message with its real database id.
 *
 * Deterministic coverage:
 *   1  new user message is persisted
 *   2  assistant response is persisted (full streamed text)
 *   3  every assistant response gets its own message id
 *   4  two different questions → two different provider requests
 *   5  the previous assistant response is never reused
 *   6  the conversation history sent to the model is correct & ordered
 *   7  refresh (getConversation) loads all messages
 *   8  messages survive logout/login (user-scoped rows)
 *   9  streaming delivers tokens progressively without losing any that
 *      straddle network-chunk boundaries (SSE parser regression)
 *   10 the streamed final text is exactly what gets persisted
 *   11 a stale request cannot overwrite a newer one (no crossed saves)
 *   12 retry does not duplicate the user message
 *   13 retry after an empty failure creates exactly one assistant message
 *   14 attachments are not broken (association + file context)
 *   15 a user cannot access another user's conversation
 *   16 a failure does not persist a fake "successful" assistant message
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

type TextChunkStream = { chunks: string[] };
type ThrowStep = { throw: Error };
type Step = TextChunkStream | ThrowStep;

const providerSteps: Step[] = [];
const providerCalls: unknown[][] = [];

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
vi.mock("@/lib/billing/entitlements", () => ({
  getEntitlements: vi.fn(async () => ({ aiPerDay: 100 })),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    count: 1,
    limit: 20,
    retryAfterSeconds: 0,
  })),
  rateLimitHeaders: vi.fn(() => ({})),
  tooManyRequests: vi.fn(() => new Response("too many", { status: 429 })),
}));
vi.mock("@/lib/ai-provider", () => ({
  createAIProvider: vi.fn(() => ({
    generateText: vi.fn(),
    streamText: (messages: unknown[]) => {
      providerCalls.push(messages);
      const step = providerSteps.shift();
      if (!step) return Promise.resolve(textStream([]));
      if ("throw" in step) return Promise.reject(step.throw);
      return Promise.resolve(textStream(step.chunks));
    },
    analyzeFile: vi.fn(async () => "doc-analysis"),
    analyzeImage: vi.fn(async () => "image-analysis"),
    generateFile: vi.fn(),
  })),
}));

const { createAdminClient } = await import("@/lib/supabase/admin");
const { createClient } = await import("@/lib/supabase/server");
const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { getConversation, getAIContext } = await import("@/lib/ai-service");
const { POST } = await import("@/app/api/ai/chat/route");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = randomUUID();

function textStream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// In-memory Supabase-shaped admin client (same rig pattern as
// ai-assistant-files.test.ts, with monotonic timestamps so ordering is
// deterministic).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type DB = {
  ai_conversations: Row[];
  ai_messages: Row[];
  ai_file_uploads: Row[];
  ai_message_files: Row[];
  storageFiles: Record<string, Buffer>;
};

let db: DB;
let seq = 0;
const nextTs = () => new Date(Date.UTC(2026, 9, 1, 12, 0, 0) + seq++ * 1000).toISOString();

function makeDb(): DB {
  return {
    ai_conversations: [],
    ai_messages: [],
    ai_file_uploads: [],
    ai_message_files: [],
    storageFiles: {},
  };
}
type TableName =
  | "ai_conversations"
  | "ai_messages"
  | "ai_file_uploads"
  | "ai_message_files";
function makeAdmin(database: DB) {
  const tables = database as Record<TableName, Row[]>;
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
        const created = insert.map((row) => ({
          id: randomUUID(),
          created_at: nextTs(),
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
          error: rows.length === 1 ? null : (error ?? { message: "no rows" }),
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
        download: async (path: string) =>
          database.storageFiles[path]
            ? {
                data: new Blob([new Uint8Array(database.storageFiles[path])]),
                error: null,
              }
            : { data: null, error: { message: "Object not found" } },
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedConversation(id: string = CONV_ID, userId: string = USER_ID) {
  const row: Row = {
    id,
    user_id: userId,
    title: "New conversation",
    created_at: nextTs(),
    updated_at: nextTs(),
  };
  db.ai_conversations.push(row);
  return { id };
}
function seedUpload(filename = "note.txt", content = "LEADERSHIP PROFILE") {
  const id = randomUUID();
  const storagePath = `${USER_ID}/${id}-${filename}`;
  db.storageFiles[storagePath] = Buffer.from(content);
  const row: Row = {
    id,
    user_id: USER_ID,
    storage_path: storagePath,
    filename,
    mime_type: "text/plain",
    size_bytes: content.length,
    created_at: nextTs(),
  };
  db.ai_file_uploads.push(row);
  return { id, storagePath };
}
async function chat(
  content: string,
  opts: { conversationId?: string; fileIds?: string[] } = {},
) {
  return POST(
    new Request("http://localhost/api/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: opts.conversationId ?? CONV_ID,
        content,
        fileIds: opts.fileIds ?? [],
      }),
    }),
  );
}
/** Consume the streamed response like the browser client does. */
async function consume(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}
/** Split the body into model text + the server's metadata frame. */
function splitMeta(body: string): {
  text: string;
  meta: { messageId: string | null; saved: boolean } | null;
} {
  const cut = body.lastIndexOf("\u0000");
  if (cut === -1) return { text: body, meta: null };
  const meta = JSON.parse(body.slice(cut + 1)).aiMeta;
  return { text: body.slice(0, cut), meta };
}
const userMessages = () => db.ai_messages.filter((m) => m.role === "user");
const assistantMessages = () =>
  db.ai_messages.filter((m) => m.role === "assistant");

beforeEach(() => {
  db = makeDb();
  seq = 0;
  providerSteps.length = 0;
  providerCalls.length = 0;
  seedConversation();
  (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(
    makeAdmin(db),
  );
  (createClient as ReturnType<typeof vi.fn>).mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: { user: { id: USER_ID, email: "test@example.test" } },
        error: null,
      }),
    },
  } as never);
  (
    getCurrentUserAndProfile as ReturnType<typeof vi.fn>
  ).mockResolvedValue({
    user: { id: USER_ID, email: "test@example.test" },
    profile: { id: "profile-1", account_status: "active" },
  });
});

// ---------------------------------------------------------------------------
// Persistence contract
// ---------------------------------------------------------------------------

describe("persistence contract", () => {
  it("1. a new user message is persisted", async () => {
    providerSteps.push({ chunks: ["ok"] });
    const response = await chat("سلام");
    expect(response.status).toBe(200);
    await consume(response);
    const users = userMessages();
    expect(users).toHaveLength(1);
    expect(users[0].content).toBe("سلام");
    expect(users[0].conversation_id).toBe(CONV_ID);
    expect(users[0].user_id).toBe(USER_ID);
  });

  it("2. the assistant response is persisted with the full streamed text", async () => {
    providerSteps.push({ chunks: ["وعليكم ال", "سلام، كيف ", "أخدمك؟"] });
    const response = await chat("سلام");
    const body = splitMeta(await consume(response));
    expect(body.text).toBe("وعليكم السلام، كيف أخدمك؟");
    const assistants = assistantMessages();
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBe("وعليكم السلام، كيف أخدمك؟");
    // The client receives the persisted message's real database id.
    expect(body.meta?.saved).toBe(true);
    expect(body.meta?.messageId).toBe(assistants[0].id);
  });

  it("3. every assistant response gets its own message id", async () => {
    providerSteps.push({ chunks: ["A1"] }, { chunks: ["A2"] });
    const r1 = await chat("سؤال أول");
    const r2 = await chat("سؤال ثانٍ");
    const b1 = splitMeta(await consume(r1));
    const b2 = splitMeta(await consume(r2));
    expect(b1.meta?.saved).toBe(true);
    expect(b2.meta?.saved).toBe(true);
    expect(b1.meta?.messageId).toBeTruthy();
    expect(b2.meta?.messageId).toBeTruthy();
    expect(b1.meta?.messageId).not.toBe(b2.meta?.messageId);
    const ids = assistantMessages().map((m) => m.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(b1.meta?.messageId);
    expect(ids).toContain(b2.meta?.messageId);
  });

  it("4. two different questions produce two different provider requests", async () => {
    providerSteps.push({ chunks: ["A1"] }, { chunks: ["A2"] });
    await consume(await chat("من أنا؟"));
    await consume(await chat("ما هي Ausbildung؟"));
    expect(providerCalls).toHaveLength(2);
    const first = providerCalls[0] as Array<{ role: string; content: string }>;
    const second = providerCalls[1] as Array<{ role: string; content: string }>;
    // First request: only the first question.
    expect(first).toEqual([{ role: "user", content: "من أنا؟" }]);
    // Second request: the full ordered history, ending in the new question.
    expect(second.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:من أنا؟",
      "assistant:A1",
      "user:ما هي Ausbildung؟",
    ]);
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(second));
  });

  it("5. the previous assistant response is never reused", async () => {
    providerSteps.push({ chunks: ["الجواب-القديم"] }, { chunks: ["الجواب-الجديد"] });
    await consume(await chat("سؤال 1"));
    const body = splitMeta(await consume(await chat("سؤال 2")));
    expect(body.text).toBe("الجواب-الجديد");
    expect(body.text).not.toContain("الجواب-القديم");
    expect(assistantMessages().map((m) => m.content)).toEqual([
      "الجواب-القديم",
      "الجواب-الجديد",
    ]);
  });

  it("6. the conversation history sent to the model is correct and ordered", async () => {
    providerSteps.push(
      { chunks: ["A1"] },
      { chunks: ["A2"] },
      { chunks: ["A3"] },
    );
    await consume(await chat("Q1"));
    await consume(await chat("Q2"));
    await consume(await chat("Q3"));
    const last = providerCalls[2] as Array<{ role: string; content: string }>;
    expect(last).toEqual([
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
      { role: "assistant", content: "A2" },
      { role: "user", content: "Q3" },
    ]);
  });

  it("7. a refresh (getConversation) loads every message in order", async () => {
    providerSteps.push({ chunks: ["A1"] }, { chunks: ["A2"] });
    await consume(await chat("Q1"));
    await consume(await chat("Q2"));
    const { messages } = await getConversation(CONV_ID);
    expect(
      messages.map((m) => `${m.role}:${m.content}`),
    ).toEqual(["user:Q1", "assistant:A1", "user:Q2", "assistant:A2"]);
    for (const message of messages) expect(message.id).toBeTruthy();
  });

  it("8. messages survive logout/login (rows are keyed by user_id, not by client state)", async () => {
    providerSteps.push({ chunks: ["A1"] });
    await consume(await chat("Q1"));
    // A brand-new "session" (same user) sees everything through the same
    // server-owned read path.
    (
      getCurrentUserAndProfile as ReturnType<typeof vi.fn>
    ).mockClear();
    const { messages } = await getConversation(CONV_ID);
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.user_id === USER_ID)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe("streaming", () => {
  it("9. the real provider parser loses no token that straddles a chunk boundary", async () => {
    const actual = await vi.importActual<typeof import("@/lib/ai-provider")>(
      "@/lib/ai-provider",
    );
    const full = "Ausbildung ist ein duales Ausbildungsmodell in Deutschland.";
    // One SSE event whose `data:` line is split across two network chunks —
    // the exact boundary the old per-chunk parser corrupted.
    const eventA = `data: ${JSON.stringify({ choices: [{ delta: { content: full.slice(0, 20) } }] })}`;
    const eventB = `data: ${JSON.stringify({ choices: [{ delta: { content: full.slice(20) } }] })}`;
    const rawChunks = [
      eventA.slice(0, 25), // mid-line, mid-JSON
      eventA.slice(25) + "\n\n" + eventB.slice(0, 40),
      eventB.slice(40) + "\n\ndata: [DONE]\n\n",
    ];
    const prevKey = process.env.AI_API_KEY;
    const prevModel = process.env.AI_MODEL;
    process.env.AI_API_KEY = "test-key";
    process.env.AI_MODEL = "test-model";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              for (const chunk of rawChunks)
                controller.enqueue(encoder.encode(chunk));
              controller.close();
            },
          }),
          { status: 200 },
        ),
      ),
    );
    try {
      const stream = await actual
        .createAIProvider()
        .streamText([{ role: "user", content: "hi" }]);
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let out = "";
      let emissions = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
        emissions++;
      }
      expect(out).toBe(full); // nothing dropped, nothing reordered
      expect(emissions).toBeGreaterThan(1); // progressive, not one blob
    } finally {
      vi.unstubAllGlobals();
      if (prevKey === undefined) delete process.env.AI_API_KEY;
      else process.env.AI_API_KEY = prevKey;
      if (prevModel === undefined) delete process.env.AI_MODEL;
      else process.env.AI_MODEL = prevModel;
    }
  });

  it("10. the streamed final text is exactly what gets persisted", async () => {
    providerSteps.push({ chunks: ["Te", "xt ", "mit", " Markdown"] });
    const response = await chat("fmt");
    const body = splitMeta(await consume(response));
    expect(body.text).toBe("Text mit Markdown");
    expect(assistantMessages()[0].content).toBe("Text mit Markdown");
  });

  it("11. a stale request cannot overwrite a newer one (no crossed saves)", async () => {
    providerSteps.push({ chunks: ["ANSWER-OLD"] }, { chunks: ["ANSWER-NEW"] });
    // Q1 is in flight; Q2 starts before Q1's stream is consumed.
    const r1 = await chat("alter frage");
    const r2 = await chat("neue frage");
    const b2 = splitMeta(await consume(r2)); // consume the newer one first
    const b1 = splitMeta(await consume(r1));
    expect(b1.text).toBe("ANSWER-OLD");
    expect(b2.text).toBe("ANSWER-NEW");
    // Each save landed in its own row, nothing crossed (insertion order
    // follows stream-completion order, which is consumption order here).
    const rows = db.ai_messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.content)
      .sort();
    expect(rows).toEqual(["ANSWER-NEW", "ANSWER-OLD"].sort());
    // And each model request was scoped to the history that existed at
    // request time: Q2 was sent while Q1's stream was still in flight, so
    // Q1's answer (persisted at stream end) was not — correctly — part of
    // Q2's history. The invariant that matters here is the one asserted
    // above: the two streams never crossed each other's content.
    const second = providerCalls[1] as Array<{ role: string; content: string }>;
    expect(second.map((m) => m.content)).toEqual([
      "alter frage",
      "neue frage",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Failure & retry
// ---------------------------------------------------------------------------

describe("failure & retry", () => {
  it("12. a retry does not duplicate the user message", async () => {
    providerSteps.push(
      { throw: new Error("The AI provider is temporarily unavailable.") },
      { chunks: ["okay"] },
    );
    const failed = await chat("bitte");
    expect(failed.status).toBe(400);
    expect(userMessages()).toHaveLength(1); // persisted despite the failure
    const retried = await chat("bitte"); // identical resend = retry
    expect(retried.status).toBe(200);
    await consume(retried);
    const users = userMessages();
    expect(users).toHaveLength(1); // deduplicated, not re-inserted
    expect(users[0].content).toBe("bitte");
    expect(assistantMessages()).toHaveLength(1);
  });

  it("13. a retry after an empty failure creates exactly one assistant message", async () => {
    providerSteps.push({ chunks: [] }, { chunks: ["die antwort"] });
    const empty = await chat("leer?");
    expect(empty.status).toBe(200);
    const firstBody = splitMeta(await consume(empty));
    expect(firstBody.text).toBe("");
    expect(firstBody.meta?.saved).toBe(false); // no fake empty message
    expect(assistantMessages()).toHaveLength(0);
    const retried = await chat("leer?"); // same content → reuses the user row
    expect(retried.status).toBe(200);
    await consume(retried);
    expect(userMessages()).toHaveLength(1);
    expect(assistantMessages()).toHaveLength(1);
    expect(assistantMessages()[0].content).toBe("die antwort");
  });

  it("16. a failure before any token persists no assistant message and keeps the user message", async () => {
    providerSteps.push({
      throw: new Error("The AI provider is temporarily unavailable."),
    });
    const response = await chat("wird fehlschlagen");
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("temporarily unavailable");
    expect(userMessages()).toHaveLength(1);
    expect(userMessages()[0].content).toBe("wird fehlschlagen");
    expect(assistantMessages()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Attachments & isolation
// ---------------------------------------------------------------------------

describe("attachments & isolation", () => {
  it("14. attachments stay associated with the user message and reach the model", async () => {
    const upload = seedUpload("profil.txt", "LEADERSHIP PROFILE");
    providerSteps.push({ chunks: ["analysiert"] });
    const response = await chat("Analysiere mein Profil", {
      fileIds: [upload.id],
    });
    expect(response.status).toBe(200);
    await consume(response);
    const user = userMessages()[0];
    expect(user.content).toBe("Analysiere mein Profil");
    const link = db.ai_message_files.find((f) => f.message_id === user.id);
    expect(link).toBeTruthy();
    expect(link?.filename).toBe("profil.txt");
    expect(link?.user_id).toBe(USER_ID);
    // The model received the ordered history plus the file context.
    const sent = providerCalls[0] as Array<{ role: string; content: string }>;
    expect(sent.map((m) => m.role)).toEqual(["user", "user"]);
    expect(sent[0].content).toBe("Analysiere mein Profil");
    expect(sent[1].content).toContain("untrusted reference material");
    expect(sent[1].content).toContain("FILE profil.txt");
    expect(sent[1].content).toContain("LEADERSHIP PROFILE");
  });

  it("15. a user cannot chat in another user's conversation", async () => {
    const otherConv = seedConversation(randomUUID(), OTHER_ID);
    providerSteps.push({ chunks: ["should never happen"] });
    const response = await chat("hack", {
      conversationId: otherConv.id,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Conversation not found.");
    expect(providerCalls).toHaveLength(0); // the model was never contacted
    expect(db.ai_messages).toHaveLength(0);
    // The service layer scopes every read to the session user as well:
    // another user's conversation is invisible (rejected, not empty).
    (
      getCurrentUserAndProfile as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      user: { id: OTHER_ID, email: "other@example.test" },
      profile: { id: "profile-2", account_status: "active" },
    });
    await expect(getConversation(CONV_ID)).rejects.toThrow(
      "Conversation not found.",
    );
  });

  it("getAIContext builds history from the database, never from client input", async () => {
    providerSteps.push({ chunks: ["A1"] });
    await consume(await chat("Q1"));
    const context = await getAIContext(USER_ID, CONV_ID);
    expect(context.messages).toEqual([
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
    ]);
  });
});
