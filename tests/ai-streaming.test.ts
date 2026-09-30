import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AI Assistant streaming — deterministic tests through the REAL route
 * (TransformStream + persistence + metadata frame).
 *
 * Proves the streaming contract:
 * 1. The FIRST chunk reaches the client while the stream is still open
 *    (a gated provider stream — the test holds back the rest of the
 *    answer; nothing in the route waits for completion before the client
 *    can read text).
 * 2. Chunks are delivered incrementally, in order (the route does not
 *    blob the whole answer into a single frame).
 * 3. The complete text is persisted exactly once with the real message id
 *    (regression guard: incremental consumption must not break persistence).
 * 4. Out-of-scope redirects stream immediately with zero model calls.
 */

// ---------------------------------------------------------------------------
// Mocks (route-level)
// ---------------------------------------------------------------------------

const providerCalls: unknown[][] = [];
type Step =
  | { kind: "plain"; chunks: string[] }
  | { kind: "gated"; before: string; after: string };
const providerSteps: Step[] = [];
let releaseGate: (() => void) | null = null;

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
      const step = providerSteps.shift() ?? { kind: "plain", chunks: ["ok"] };
      const encoder = new TextEncoder();
      if (step.kind === "plain") {
        return Promise.resolve(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of step.chunks)
                controller.enqueue(encoder.encode(chunk));
              controller.close();
            },
          }),
        );
      }
      // Gated stream: the first chunk is available immediately; the rest is
      // held back until the test releases the gate. Deterministic proof that
      // the client receives text while generation is still running.
      let released = false;
      return Promise.resolve(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (released) return;
            released = true;
            controller.enqueue(encoder.encode(step.before));
            await new Promise<void>((resolve) => {
              releaseGate = () => {
                releaseGate = null;
                resolve();
              };
            });
            controller.enqueue(encoder.encode(step.after));
            controller.close();
          },
          cancel() {
            // If the client aborts early, unblock the gate so tests never hang.
            releaseGate?.();
          },
        }),
      );
    },
    analyzeFile: vi.fn(async () => "doc-analysis"),
    analyzeImage: vi.fn(async () => "image-analysis"),
    generateFile: vi.fn(),
  })),
}));

const { createAdminClient } = await import("@/lib/supabase/admin");
const { createClient } = await import("@/lib/supabase/server");
const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { POST } = await import("@/app/api/ai/chat/route");
const { SCOPE_REDIRECTS } = await import("@/lib/ai-scope");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONV_ID = randomUUID();

// ---------------------------------------------------------------------------
// In-memory Supabase-shaped admin client (same rig as ai-scope.test.ts)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type DB = {
  ai_conversations: Row[];
  ai_messages: Row[];
  ai_file_uploads: Row[];
  ai_message_files: Row[];
};
let db: DB;
let seq = 0;
const nextTs = () =>
  new Date(Date.UTC(2026, 9, 1, 12, 0, 0) + seq++ * 1000).toISOString();

type TableName = keyof DB;
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
    storage: { from: () => ({ download: async () => ({ data: null, error: null }) }) },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitMeta(body: string): {
  text: string;
  meta: { messageId: string | null; saved: boolean } | null;
} {
  const cut = body.lastIndexOf("\u0000");
  if (cut === -1) return { text: body, meta: null };
  return {
    text: body.slice(0, cut),
    meta: JSON.parse(body.slice(cut + 1)).aiMeta,
  };
}
async function chat(content: string) {
  return POST(
    new Request("http://localhost/api/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: CONV_ID, content, fileIds: [] }),
    }),
  );
}
/** Read the stream chunk by chunk (Web Stream chunk boundaries are preserved). */
async function readChunks(response: Response): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }
  return chunks;
}

beforeEach(() => {
  db = {
    ai_conversations: [
      {
        id: CONV_ID,
        user_id: USER_ID,
        title: "New conversation",
        created_at: nextTs(),
        updated_at: nextTs(),
      },
    ],
    ai_messages: [],
    ai_file_uploads: [],
    ai_message_files: [],
  };
  seq = 0;
  providerCalls.length = 0;
  providerSteps.length = 0;
  releaseGate = null;
  (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(makeAdmin(db));
  (createClient as ReturnType<typeof vi.fn>).mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: { user: { id: USER_ID, email: "test@example.test" } },
        error: null,
      }),
    },
  } as never);
  (getCurrentUserAndProfile as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { id: USER_ID, email: "test@example.test" },
    profile: { id: "profile-1", account_status: "active" },
  });
});

// ---------------------------------------------------------------------------
// Streaming contract
// ---------------------------------------------------------------------------

describe("AI chat streaming contract", () => {
  it("delivers the FIRST chunk to the client before the answer is complete", async () => {
    providerSteps.push({ kind: "gated", before: "FIRST", after: " REST OF ANSWER" });
    const response = await chat("Wie schreibe ich ein gutes Anschreiben?");
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    // First read: must already contain the first chunk while the stream is
    // still open (the rest of the answer is held back by the gate).
    const first = await reader.read();
    expect(first.done).toBe(false);
    const firstText = decoder.decode(first.value!, { stream: true });
    expect(firstText).toContain("FIRST");
    expect(firstText).not.toContain("REST OF ANSWER");

    // Release the generation; the remainder + metadata frame follow.
    releaseGate!();
    let out = firstText;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      out += decoder.decode(next.value!, { stream: true });
    }
    const body = splitMeta(out);
    expect(body.text).toBe("FIRST REST OF ANSWER");
    expect(body.meta?.saved).toBe(true);
    // The complete text is persisted exactly once with the real message id.
    const assistant = db.ai_messages.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe("FIRST REST OF ANSWER");
    expect(body.meta?.messageId).toBe(assistant[0].id);
  });

  it("delivers multiple chunks incrementally, in order (not one blob)", async () => {
    providerSteps.push({
      kind: "plain",
      chunks: ["Teil ", "eins ", "und zwei."],
    });
    const response = await chat("Wie schreibe ich ein gutes Anschreiben?");
    expect(response.status).toBe(200);

    const chunks = await readChunks(response);
    // Each provider chunk survives the route's TransformStream: the client
    // sees growing pieces in order, never the whole text in a single frame.
    expect(chunks[0]).toBe("Teil ");
    expect(chunks[1]).toBe("eins ");
    // The metadata frame is delivered as the final frame.
    expect(chunks[chunks.length - 1]).toContain("\u0000");

    const body = splitMeta(chunks.join(""));
    expect(body.text).toBe("Teil eins und zwei.");
    expect(body.meta?.saved).toBe(true);
    const assistant = db.ai_messages.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe("Teil eins und zwei.");
  });

  it("streams the out-of-scope redirect immediately, without any model call", async () => {
    const response = await chat("Wer ist der Präsident von Frankreich?");
    expect(response.status).toBe(200);
    expect(providerCalls).toHaveLength(0);

    const chunks = await readChunks(response);
    const body = splitMeta(chunks.join(""));
    expect(body.text).toBe(SCOPE_REDIRECTS.de);
    expect(body.meta?.saved).toBe(true);
    const assistant = db.ai_messages.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe(SCOPE_REDIRECTS.de);
  });
});
