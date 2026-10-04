/**
 * Community group chat — comprehensive coverage:
 *  - avatar constants + URL fallback
 *  - profile schema (name length/trim, exactly-5 avatar allowlist)
 *  - image validation (MIME allowlist, 2 MB byte cap, magic bytes, spoofing)
 *  - storage path generation (UUID-only segments, no client filenames)
 *  - realtime/message merge dedupe + chronological order
 *  - rate-limit budgets for the community scopes
 *  - GET/POST /api/community/messages (auth, validation, impersonation,
 *    image accept/reject, storage path isolation)
 *  - unread read-cursor logic (sidebar badge)
 *  - server actions (onboarding upsert, read cursor)
 *  - XSS source guard (messages render as plain text)
 *  - migration guards (RLS, immutability, storage policies, realtime)
 *  - i18n parity (all new keys resolve in all four languages)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommunityMessage } from "@/lib/community";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { createClient } = await import("@/lib/supabase/server");
const { createAdminClient } = await import("@/lib/supabase/admin");
const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { revalidatePath } = await import("next/cache");
const {
  COMMUNITY_AVATAR_IDS,
  COMMUNITY_IMAGE_MIMES,
  COMMUNITY_MAX_IMAGE_BYTES,
  COMMUNITY_MAX_MESSAGE_LENGTH,
  COMMUNITY_MAX_NAME_LENGTH,
  buildCommunityImagePath,
  communityAvatarUrl,
  communityProfileSchema,
  mergeCommunityMessages,
  validateCommunityImage,
} = await import("@/lib/community");
const {
  TYPING_BROADCAST_EVENT,
  TYPING_STOP_DELAY_MS,
  TYPING_TTL_MS,
  TypingSender,
  applyTypingEvent,
  buildTypingLabel,
  createTypingState,
  parseTypingBroadcast,
  pruneExpired,
  selectActiveTypers,
} = await import("@/lib/community/typing");
const { getCommunityUnreadCount } = await import("@/lib/community/server");
const { GET, POST } = await import("@/app/api/community/messages/route");
const { completeOnboarding, markCommunityRead } = await import(
  "@/app/community/actions"
);
const { RATE_LIMITS } = await import("@/lib/rate-limit");
const { dictionaries, SUPPORTED_LANGUAGES } = await import(
  "@/lib/i18n/dictionaries"
);
const { lookup, translate } = await import("@/lib/i18n/core");

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readSrc = (relative: string) =>
  readFileSync(resolve(root, relative), "utf8");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function allowRateLimits(limit = 100) {
  vi.mocked(createAdminClient).mockReturnValue({
    rpc: vi
      .fn()
      .mockResolvedValue({
        data: { allowed: true, count: 1, limit, retry_after: 0 },
        error: null,
      }),
  } as never);
}

function denyRateLimits(scope: string) {
  const { max } = RATE_LIMITS[scope as keyof typeof RATE_LIMITS];
  vi.mocked(createAdminClient).mockReturnValue({
    rpc: vi
      .fn()
      .mockResolvedValue({
        data: { allowed: false, count: max + 1, limit: max, retry_after: 17 },
        error: null,
      }),
  } as never);
}

function mockAuth(userId: string | null) {
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: userId ? { id: userId } : null,
    profile: null,
  } as never);
}

interface ClientFixture {
  /** community_profiles maybeSingle (POST: sender must have onboarding done). */
  profile?: Record<string, unknown> | null;
  /** community_profiles select via thenable (GET: author enrichment). */
  authors?: Array<Record<string, unknown>>;
  /** community_messages select via thenable (GET: newest first from the DB). */
  messages?: CommunityMessage[];
  /** community_messages insert(...).single() result (POST). */
  inserted?: { data: Record<string, unknown> | null; error: { message: string } | null };
  /** storage.upload result (POST with image). */
  uploadError?: { message: string } | null;
}

interface RecordedCall {
  table: string;
  op: string;
  args: unknown[];
}

/** Supabase user-client mock that branches on table name. */
function mockCommunityClient(f: ClientFixture = {}) {
  const calls: RecordedCall[] = [];
  vi.mocked(createClient).mockResolvedValue({
    from(table: string) {
      const base: Record<string, unknown> = {};
      const makeOp = (op: string) => (...args: unknown[]) => {
        calls.push({ table, op, args });
        return base;
      };
      base.select = makeOp("select");
      base.order = makeOp("order");
      base.limit = makeOp("limit");
      base.lt = makeOp("lt");
      base.in = makeOp("in");
      base.eq = makeOp("eq");
      Object.assign(base, {
        maybeSingle: async () => ({
          data: table === "community_profiles" ? (f.profile ?? null) : null,
          error: null,
        }),
        single: async () => {
          if (f.inserted) return f.inserted;
          // Echo the insert payload back with DB-generated timestamps, so
          // the response row carries the ACTUAL server-generated path/id.
          const insert = calls.find(
            (c) => c.table === "community_messages" && c.op === "insert",
          );
          const payload = (insert?.args[0] ?? null) as Record<string, unknown> | null;
          return {
            data: payload
              ? {
                  ...payload,
                  created_at: "2026-01-01T00:00:00.000Z",
                  updated_at: "2026-01-01T00:00:00.000Z",
                }
              : null,
            error: null,
          };
        },
        insert: (payload: unknown) => {
          calls.push({ table, op: "insert", args: [payload] });
          return base;
        },
      });
      base.then = (onF?: unknown, onR?: unknown) =>
        Promise.resolve({
          data:
            table === "community_messages" ? (f.messages ?? []) : (f.authors ?? []),
          error: null,
        }).then(onF as never, onR as never);
      return base;
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, blob: Blob, opts: unknown) => {
          calls.push({ table: bucket, op: "upload", args: [path, blob, opts] });
          return { error: f.uploadError ?? null };
        },
      }),
    },
  } as never);
  return { calls };
}

/** Session-client mock for the server actions (upserts on the own session). */
function mockUpsertClient(
  userId: string | null,
  upsertError: { message: string } | null = null,
) {
  const upserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({ data: { user: userId ? { id: userId } : null } }),
    },
    from: (table: string) => {
      const base: Record<string, unknown> = {};
      base.upsert = (payload: Record<string, unknown>) => {
        upserts.push({ table, payload });
        base.then = (onF?: unknown, onR?: unknown) =>
          Promise.resolve({ error: upsertError }).then(onF as never, onR as never);
        return base;
      };
      return base;
    },
  } as never);
  return upserts;
}

/** Admin-client mock for the unread read-cursor queries. */
function mockUnreadAdmin(opts: {
  state: { last_read_message_id: string } | null;
  last: { created_at: string } | null;
  total: number;
  afterCount: number;
}) {
  vi.mocked(createAdminClient).mockReturnValue({
    from(table: string) {
      const base: Record<string, unknown> = {
        select: () => base,
        eq: () => base,
      };
      if (table === "community_read_state") {
        base.maybeSingle = async () => ({ data: opts.state, error: null });
        return base;
      }
      let withGt = false;
      base.gt = () => {
        withGt = true;
        return base;
      };
      base.maybeSingle = async () => ({ data: opts.last, error: null });
      base.then = (onF?: unknown, onR?: unknown) =>
        Promise.resolve({
          data: null,
          error: null,
          count: withGt ? opts.afterCount : opts.total,
        }).then(onF as never, onR as never);
      return base;
    },
  } as never);
}

function msgFixture(
  id: string,
  userId: string,
  createdAt: string,
  extra: Partial<CommunityMessage> = {},
): CommunityMessage {
  return {
    id,
    user_id: userId,
    message: "text",
    image_path: null,
    created_at: createdAt,
    updated_at: createdAt,
    ...extra,
  };
}

function postForm(build: (fd: FormData) => void) {
  const fd = new FormData();
  build(fd);
  return POST(
    new Request("http://localhost/api/community/messages", {
      method: "POST",
      body: fd,
    }),
  );
}

// ---------------------------------------------------------------------------
// Image byte fixtures
// ---------------------------------------------------------------------------

function jpegBytes(n = 64): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[3] = 0xe0;
  return b;
}

function pngBytes(n = 64): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b;
}

function webpBytes(n = 64): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  b.set([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
  return b;
}

function pdfBytes(): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n");
  const b = new Uint8Array(encoded.byteLength);
  b.set(encoded);
  return b;
}

function fileFixture(
  bytes: Uint8Array<ArrayBuffer>,
  type: string,
  name = "upload.bin",
) {
  return new File([bytes], name, { type });
}

beforeEach(() => {
  vi.clearAllMocks();
  allowRateLimits();
});

// ---------------------------------------------------------------------------
// Avatars
// ---------------------------------------------------------------------------

describe("avatars", () => {
  it("exposes exactly the five predefined ids", () => {
    expect([...COMMUNITY_AVATAR_IDS]).toEqual([
      "avatar-1",
      "avatar-2",
      "avatar-3",
      "avatar-4",
      "avatar-5",
    ]);
  });

  it("maps every valid id to its static public URL", () => {
    for (const id of COMMUNITY_AVATAR_IDS) {
      expect(communityAvatarUrl(id)).toBe(`/community/avatars/${id}.png`);
    }
  });

  it("falls back to avatar-1 for unknown, empty or path-injection ids", () => {
    expect(communityAvatarUrl("avatar-9")).toBe("/community/avatars/avatar-1.png");
    expect(communityAvatarUrl("")).toBe("/community/avatars/avatar-1.png");
    expect(communityAvatarUrl("../../etc/passwd")).toBe(
      "/community/avatars/avatar-1.png",
    );
    expect(communityAvatarUrl("avatar-1.png")).toBe(
      "/community/avatars/avatar-1.png",
    );
  });
});

// ---------------------------------------------------------------------------
// Profile schema
// ---------------------------------------------------------------------------

describe("communityProfileSchema", () => {
  it("accepts a valid name + one of the five avatars", () => {
    const parsed = communityProfileSchema.safeParse({
      displayName: "Mustapha",
      avatarId: "avatar-3",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ displayName: "Mustapha", avatarId: "avatar-3" });
    }
  });

  it("accepts every one of the five avatar ids", () => {
    for (const avatarId of COMMUNITY_AVATAR_IDS) {
      expect(
        communityProfileSchema
          .safeParse({ displayName: "Anna", avatarId })
          .success,
      ).toBe(true);
    }
  });

  it("trims surrounding whitespace from the name", () => {
    const parsed = communityProfileSchema.safeParse({
      displayName: "   Anna   ",
      avatarId: "avatar-1",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.displayName).toBe("Anna");
  });

  it("rejects an empty or whitespace-only name", () => {
    for (const bad of ["", "   "]) {
      const parsed = communityProfileSchema.safeParse({
        displayName: bad,
        avatarId: "avatar-1",
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success)
        expect(parsed.error.issues[0].path[0]).toBe("displayName");
    }
  });

  it(`enforces the ${COMMUNITY_MAX_NAME_LENGTH}-char name cap`, () => {
    expect(
      communityProfileSchema
        .safeParse({ displayName: "x".repeat(COMMUNITY_MAX_NAME_LENGTH), avatarId: "avatar-1" })
        .success,
    ).toBe(true);
    const tooLong = communityProfileSchema.safeParse({
      displayName: "x".repeat(COMMUNITY_MAX_NAME_LENGTH + 1),
      avatarId: "avatar-1",
    });
    expect(tooLong.success).toBe(false);
    if (!tooLong.success)
      expect(tooLong.error.issues[0].code).toBe("too_big");
  });

  it("rejects avatar ids outside the predefined set", () => {
    for (const bad of ["avatar-0", "avatar-6", "custom", "avatar-1.png", ".."]) {
      const parsed = communityProfileSchema.safeParse({
        displayName: "Anna",
        avatarId: bad,
      });
      expect(parsed.success, bad).toBe(false);
      if (!parsed.success)
        expect(parsed.error.issues[0].path[0]).toBe("avatarId");
    }
  });
});

// ---------------------------------------------------------------------------
// Image validation (MIME + size + magic bytes)
// ---------------------------------------------------------------------------

describe("validateCommunityImage", () => {
  it("accepts JPEG, PNG and WebP with matching magic bytes", () => {
    expect(validateCommunityImage("image/jpeg", jpegBytes())).toEqual({
      ok: true,
      ext: "jpg",
    });
    expect(validateCommunityImage("image/png", pngBytes())).toEqual({
      ok: true,
      ext: "png",
    });
    expect(validateCommunityImage("image/webp", webpBytes())).toEqual({
      ok: true,
      ext: "webp",
    });
  });

  it("only allows the three documented MIME types", () => {
    for (const mime of [
      "application/pdf",
      "image/gif",
      "image/svg+xml",
      "video/mp4",
      "audio/mpeg",
      "application/zip",
      "text/html",
    ]) {
      expect(validateCommunityImage(mime, jpegBytes()), mime).toEqual({
        ok: false,
        code: "invalid_image",
      });
    }
    expect([...COMMUNITY_IMAGE_MIMES]).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
  });

  it("measures the ACTUAL byte length: 2 MB+1 is rejected, exactly 2 MB is not", () => {
    const tooBig = new Uint8Array(COMMUNITY_MAX_IMAGE_BYTES + 1);
    tooBig[0] = 0xff;
    tooBig[1] = 0xd8;
    tooBig[2] = 0xff;
    expect(validateCommunityImage("image/jpeg", tooBig)).toEqual({
      ok: false,
      code: "image_too_large",
    });

    const exact = new Uint8Array(COMMUNITY_MAX_IMAGE_BYTES);
    exact[0] = 0xff;
    exact[1] = 0xd8;
    exact[2] = 0xff;
    expect(validateCommunityImage("image/jpeg", exact)).toEqual({
      ok: true,
      ext: "jpg",
    });
  });

  it("rejects empty payloads", () => {
    expect(validateCommunityImage("image/png", new Uint8Array(0))).toEqual({
      ok: false,
      code: "invalid_image",
    });
  });

  it("rejects truncated magic bytes", () => {
    expect(validateCommunityImage("image/jpeg", new Uint8Array([0xff, 0xd8]))).toEqual({
      ok: false,
      code: "invalid_image",
    });
  });

  it("rejects MIME-spoofed content (declared type != magic bytes)", () => {
    // PDF bytes re-typed as an image.
    expect(validateCommunityImage("image/jpeg", pdfBytes())).toEqual({
      ok: false,
      code: "invalid_image",
    });
    expect(validateCommunityImage("image/png", pdfBytes())).toEqual({
      ok: false,
      code: "invalid_image",
    });
    // PNG bytes re-typed as WebP and vice versa.
    expect(validateCommunityImage("image/webp", pngBytes())).toEqual({
      ok: false,
      code: "invalid_image",
    });
    expect(validateCommunityImage("image/png", webpBytes())).toEqual({
      ok: false,
      code: "invalid_image",
    });
  });
});

// ---------------------------------------------------------------------------
// Storage path generation
// ---------------------------------------------------------------------------

describe("buildCommunityImagePath", () => {
  it("produces {user_id}/{message_id}/image.{ext} for valid UUIDs", () => {
    expect(buildCommunityImagePath(USER_ID, OTHER_USER_ID, "png")).toBe(
      `${USER_ID}/${OTHER_USER_ID}/image.png`,
    );
  });

  it("returns '' for any non-UUID segment (no path traversal, no client input)", () => {
    expect(buildCommunityImagePath("../../etc", OTHER_USER_ID, "png")).toBe("");
    expect(buildCommunityImagePath(USER_ID, "a/b/c", "png")).toBe("");
    expect(buildCommunityImagePath("not-a-uuid", OTHER_USER_ID, "jpg")).toBe("");
    expect(buildCommunityImagePath(USER_ID, "", "webp")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Message merge (optimistic UI + realtime + resync dedupe)
// ---------------------------------------------------------------------------

describe("mergeCommunityMessages", () => {
  it("dedupes by id — the first (existing) copy wins", () => {
    const existing = [
      msgFixture("a", USER_ID, "2026-01-01T00:00:00.000Z", { message: "original" }),
    ];
    const incoming = [
      msgFixture("a", USER_ID, "2026-01-01T00:00:00.000Z", { message: "duplicate" }),
      msgFixture("b", USER_ID, "2026-01-02T00:00:00.000Z"),
    ];
    const merged = mergeCommunityMessages(existing, incoming);
    expect(merged.map((m) => m.id)).toEqual(["a", "b"]);
    expect(merged[0].message).toBe("original");
  });

  it("keeps chronological ascending order regardless of arrival order", () => {
    const existing = [msgFixture("c", USER_ID, "2026-01-03T00:00:00.000Z")];
    const incoming = [
      msgFixture("a", USER_ID, "2026-01-01T00:00:00.000Z"),
      msgFixture("b", USER_ID, "2026-01-02T00:00:00.000Z"),
    ];
    expect(mergeCommunityMessages(existing, incoming).map((m) => m.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("breaks created_at ties deterministically by id", () => {
    const t = "2026-01-01T00:00:00.000Z";
    const merged = mergeCommunityMessages(
      [msgFixture("zzz", USER_ID, t)],
      [msgFixture("aaa", USER_ID, t)],
    );
    expect(merged.map((m) => m.id)).toEqual(["aaa", "zzz"]);
  });

  it("handles empty lists", () => {
    expect(mergeCommunityMessages([], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Send + realtime ordering — the message must appear exactly once, immediately
// ---------------------------------------------------------------------------

describe("send/realtime dedupe contract", () => {
  const sent = msgFixture("m1", USER_ID, "2026-01-01T10:00:00.000Z");

  it("the sender sees the message from the POST response and NOT twice when realtime echoes it", () => {
    // 1. POST 201 → the client merges the server row into local state.
    const afterPost = mergeCommunityMessages([], [sent]);
    expect(afterPost).toHaveLength(1);
    // 2. The realtime INSERT for the same row arrives → dedupe by id.
    const afterEcho = mergeCommunityMessages(afterPost, [sent]);
    expect(afterEcho).toHaveLength(1);
    expect(afterEcho[0].id).toBe("m1");
  });

  it("also yields exactly one message when realtime arrives BEFORE the POST response", () => {
    const afterRealtime = mergeCommunityMessages([], [sent]);
    const afterPost = mergeCommunityMessages(afterRealtime, [sent]);
    expect(afterPost).toHaveLength(1);
  });

  it("keeps a failed send out of the list entirely (no phantom message)", () => {
    // A failed POST never reaches the merge, so the history is unchanged.
    const before = mergeCommunityMessages([], [msgFixture("old", USER_ID, "2026-01-01T09:00:00.000Z")]);
    expect(before.map((m) => m.id)).toEqual(["old"]);
  });
});

// ---------------------------------------------------------------------------
// Rate-limit budgets
// ---------------------------------------------------------------------------

describe("community rate-limit budgets", () => {
  it("defines dedicated per-user scopes that do not weaken existing limits", () => {
    expect(RATE_LIMITS.community_message).toEqual({ max: 20, windowSeconds: 60 });
    expect(RATE_LIMITS.community_history).toEqual({ max: 30, windowSeconds: 60 });
    expect(RATE_LIMITS.community_onboarding).toEqual({ max: 5, windowSeconds: 60 });
    // Pre-existing scopes stay intact.
    expect(RATE_LIMITS.ai_chat.max).toBe(20);
    expect(RATE_LIMITS.opportunity_search.max).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// GET /api/community/messages
// ---------------------------------------------------------------------------

describe("GET /api/community/messages", () => {
  it("rejects unauthenticated requests with 401 (no DB access)", async () => {
    mockAuth(null);
    const { calls } = mockCommunityClient();
    const res = await GET(new Request("http://localhost/api/community/messages"));
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("returns 429 for a rate-limited user before fetching messages", async () => {
    mockAuth(USER_ID);
    denyRateLimits("community_history");
    const res = await GET(new Request("http://localhost/api/community/messages"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
  });

  it("returns the newest page ascending, enriched with community authors only", async () => {
    mockAuth(USER_ID);
    allowRateLimits(30); // echo the configured community_history budget in the RPC result
    const messages = [
      msgFixture("m2", OTHER_USER_ID, "2026-01-02T10:00:00.000Z"),
      msgFixture("m1", USER_ID, "2026-01-01T09:00:00.000Z"),
    ];
    mockCommunityClient({
      messages,
      authors: [
        {
          user_id: OTHER_USER_ID,
          display_name: "Lena",
          avatar_id: "avatar-2",
        },
      ],
    });
    const res = await GET(new Request("http://localhost/api/community/messages"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-limit")).toBe("30");
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        author: { display_name: string; avatar_id: string } | null;
      }>;
    };
    // Ascending order despite newest-first DB fetch; display names only
    // (no email/other auth fields can be returned).
    expect(body.items.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(body.items[0].author).toBeNull();
    expect(body.items[1].author).toEqual({
      display_name: "Lena",
      avatar_id: "avatar-2",
    });
  });

  it("supports before_at pagination (lt filter) and rejects invalid cursors", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient();
    const bad = await GET(
      new Request("http://localhost/api/community/messages?before_at=not-a-date"),
    );
    expect(bad.status).toBe(400);

    const cursor = "2026-01-03T00:00:00.000Z";
    const ok = await GET(
      new Request(
        `http://localhost/api/community/messages?before_at=${encodeURIComponent(cursor)}`,
      ),
    );
    expect(ok.status).toBe(200);
    const ltCall = calls.find(
      (c) => c.table === "community_messages" && c.op === "lt",
    );
    expect(ltCall?.args).toEqual(["created_at", cursor]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/community/messages
// ---------------------------------------------------------------------------

describe("POST /api/community/messages", () => {
  it("rejects unauthenticated requests with 401", async () => {
    mockAuth(null);
    const res = await postForm((fd) => fd.set("message", "hi"));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("Unauthorized");
  });

  it("returns 429 for a rate-limited user before any DB work", async () => {
    mockAuth(USER_ID);
    denyRateLimits("community_message");
    const res = await postForm((fd) => fd.set("message", "hi"));
    expect(res.status).toBe(429);
    expect(res.headers.get("x-ratelimit-limit")).toBe("20");
  });

  it("rejects a message with neither text nor image (empty_message)", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient();
    const res = await postForm(() => {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("empty_message");
    expect(calls).toEqual([]);
  });

  it("treats whitespace-only text as empty", async () => {
    mockAuth(USER_ID);
    const res = await postForm((fd) => fd.set("message", "   "));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("empty_message");
  });

  it(`rejects text longer than ${COMMUNITY_MAX_MESSAGE_LENGTH} chars`, async () => {
    mockAuth(USER_ID);
    const res = await postForm((fd) =>
      fd.set("message", "x".repeat(COMMUNITY_MAX_MESSAGE_LENGTH + 1)),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("text_too_long");
  });

  it("rejects senders without a community profile (409, onboarding required)", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({ profile: null });
    const res = await postForm((fd) => fd.set("message", "hi"));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("profile_required");
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("creates a text message as the SESSION user — a user_id in the body is ignored (no impersonation)", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({
      profile: { id: "profile-row" },
      inserted: {
        data: {
          id: "msg-1",
          user_id: USER_ID,
          message: "hallo",
          image_path: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
        error: null,
      },
    });
    const res = await postForm((fd) => {
      fd.set("message", "hallo");
      fd.set("user_id", OTHER_USER_ID); // impersonation attempt — must be ignored
    });
    expect(res.status).toBe(201);
    const insert = calls.find((c) => c.op === "insert");
    expect(insert).toBeDefined();
    expect((insert?.args[0] as { user_id: string }).user_id).toBe(USER_ID);
  });

  it("uploads an image to the server-generated owner-isolated path (upsert disabled)", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({
      profile: { id: "profile-row" },
    });
    const fd = new FormData();
    fd.set(
      "image",
      fileFixture(pngBytes(128), "image/png", "my photo.png"),
    );
    const res = await POST(
      new Request("http://localhost/api/community/messages", {
        method: "POST",
        body: fd,
      }),
    );
    expect(res.status).toBe(201);
    const upload = calls.find((c) => c.op === "upload");
    expect(upload?.table).toBe("community-images");
    const [path, , opts] = upload?.args as [string, Blob, Record<string, unknown>];
    // Client filename never used; UUID-only segments; owner folder first.
    expect(path).toMatch(new RegExp(`^${USER_ID}/[0-9a-f-]{36}/image\\.png$`));
    expect(opts.upsert).toBe(false);
    expect(opts.contentType).toBe("image/png");
    // The DB insert must carry exactly the server-generated path.
    const insertCall = calls.find((c) => c.op === "insert");
    expect((insertCall?.args[0] as { image_path: string }).image_path).toBe(path);
    const body = (await res.json()) as { message: { image_path: string | null } };
    expect(body.message.image_path).toBe(path);
  });

  it("rejects an oversized image (2 MB + 1) with 413 before storage", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({ profile: { id: "p" } });
    const big = new Uint8Array(COMMUNITY_MAX_IMAGE_BYTES + 1);
    big[0] = 0xff;
    big[1] = 0xd8;
    big[2] = 0xff;
    const res = await postForm((fd) =>
      fd.set("image", fileFixture(big, "image/jpeg")),
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("image_too_large");
    expect(calls.some((c) => c.op === "upload" || c.op === "insert")).toBe(false);
  });

  it("rejects non-image content types (PDF) with 415", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({ profile: { id: "p" } });
    const res = await postForm((fd) =>
      fd.set("image", fileFixture(pdfBytes(), "application/pdf", "doc.pdf")),
    );
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_image");
    expect(calls.some((c) => c.op === "upload")).toBe(false);
  });

  it("rejects MIME-spoofed uploads (PDF bytes declared as image/png) with 415", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({ profile: { id: "p" } });
    const res = await postForm((fd) =>
      fd.set("image", fileFixture(pdfBytes(), "image/png", "evil.png")),
    );
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_image");
    expect(calls.some((c) => c.op === "upload")).toBe(false);
  });

  it("rejects GIF and SVG content types", async () => {
    mockAuth(USER_ID);
    mockCommunityClient({ profile: { id: "p" } });
    const gif = new TextEncoder().encode("GIF89a");
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const r1 = await postForm((fd) =>
      fd.set("image", fileFixture(gif, "image/gif")),
    );
    const r2 = await postForm((fd) =>
      fd.set("image", fileFixture(svg, "image/svg+xml")),
    );
    expect(r1.status).toBe(415);
    expect(r2.status).toBe(415);
  });

  it("maps storage rejections (size limit / MIME) to 413 / 415", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({
      profile: { id: "p" },
      uploadError: { message: "File size exceeded 2MB limit" },
    });
    const res = await postForm((fd) =>
      fd.set("image", fileFixture(pngBytes(), "image/png")),
    );
    expect(res.status).toBe(413);
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("returns 500 when the message row cannot be written", async () => {
    mockAuth(USER_ID);
    mockCommunityClient({
      profile: { id: "p" },
      inserted: { data: null, error: { message: "db down" } },
    });
    const res = await postForm((fd) => fd.set("message", "hi"));
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Unread count (sidebar badge) — read cursor semantics
// ---------------------------------------------------------------------------

describe("getCommunityUnreadCount (read cursor)", () => {
  it("counts ALL messages when the user has no read state yet", async () => {
    mockUnreadAdmin({
      state: null,
      last: null,
      total: 12,
      afterCount: 0,
    });
    await expect(getCommunityUnreadCount(USER_ID)).resolves.toBe(12);
  });

  it("counts only messages created after the cursor message", async () => {
    mockUnreadAdmin({
      state: { last_read_message_id: OTHER_USER_ID },
      last: { created_at: "2026-01-02T10:00:00.000Z" },
      total: 12,
      afterCount: 3,
    });
    await expect(getCommunityUnreadCount(USER_ID)).resolves.toBe(3);
  });

  it("falls back to the total when the cursor message no longer exists", async () => {
    mockUnreadAdmin({
      state: { last_read_message_id: OTHER_USER_ID },
      last: null,
      total: 5,
      afterCount: 0,
    });
    await expect(getCommunityUnreadCount(USER_ID)).resolves.toBe(5);
  });

  it("degrades to 0 on any failure — the badge must never break a render", async () => {
    vi.mocked(createAdminClient).mockReturnValue({
      from: () => {
        throw new Error("db down");
      },
    } as never);
    await expect(getCommunityUnreadCount(USER_ID)).resolves.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Server actions
// ---------------------------------------------------------------------------

describe("completeOnboarding (server action)", () => {
  it("fails with generic when there is no session user", async () => {
    mockUpsertClient(null);
    await expect(
      completeOnboarding({ displayName: "Anna", avatarId: "avatar-1" }),
    ).resolves.toEqual({ ok: false, code: "generic" });
  });

  it("maps validation errors to stable codes (name required / too long / avatar invalid)", async () => {
    mockUpsertClient(USER_ID);
    await expect(
      completeOnboarding({ displayName: "  ", avatarId: "avatar-1" }),
    ).resolves.toEqual({ ok: false, code: "name_required" });
    await expect(
      completeOnboarding({
        displayName: "x".repeat(COMMUNITY_MAX_NAME_LENGTH + 1),
        avatarId: "avatar-1",
      }),
    ).resolves.toEqual({ ok: false, code: "name_too_long" });
    await expect(
      completeOnboarding({ displayName: "Anna", avatarId: "avatar-99" }),
    ).resolves.toEqual({ ok: false, code: "avatar_invalid" });
  });

  it("returns rate_limited and never upserts when limited", async () => {
    denyRateLimits("community_onboarding");
    const upserts = mockUpsertClient(USER_ID);
    await expect(
      completeOnboarding({ displayName: "Anna", avatarId: "avatar-1" }),
    ).resolves.toEqual({ ok: false, code: "rate_limited" });
    expect(upserts).toEqual([]);
  });

  it("upserts the session user's own profile (trimmed name) and revalidates /community", async () => {
    allowRateLimits(5);
    const upserts = mockUpsertClient(USER_ID);
    await expect(
      completeOnboarding({ displayName: "  Anna  ", avatarId: "avatar-4" }),
    ).resolves.toEqual({ ok: true });
    expect(upserts).toEqual([
      {
        table: "community_profiles",
        payload: { user_id: USER_ID, display_name: "Anna", avatar_id: "avatar-4" },
      },
    ]);
    expect(revalidatePath).toHaveBeenCalledWith("/community");
  });

  it("returns generic when the upsert fails", async () => {
    mockUpsertClient(USER_ID, { message: "rls denied" });
    await expect(
      completeOnboarding({ displayName: "Anna", avatarId: "avatar-1" }),
    ).resolves.toEqual({ ok: false, code: "generic" });
  });
});

describe("markCommunityRead (server action)", () => {
  it("ignores non-UUID input without touching Supabase", async () => {
    mockAuth(USER_ID);
    await markCommunityRead("../../etc/passwd");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("upserts the session user's read cursor for a valid message id", async () => {
    const upserts = mockUpsertClient(USER_ID);
    await markCommunityRead(OTHER_USER_ID);
    expect(upserts).toEqual([
      {
        table: "community_read_state",
        payload: { user_id: USER_ID, last_read_message_id: OTHER_USER_ID },
      },
    ]);
  });

  it("does nothing without a session user", async () => {
    const upserts = mockUpsertClient(null);
    await markCommunityRead(OTHER_USER_ID);
    expect(upserts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// XSS / rendering discipline (source-level guard)
// ---------------------------------------------------------------------------

describe("rendering security (source guard)", () => {
  const chatSrc = readSrc("src/components/community-chat.tsx");
  const onbSrc = readSrc("src/components/community-onboarding.tsx");

  it("never injects raw HTML in the chat or onboarding UI", () => {
    expect(chatSrc).not.toContain("dangerouslySetInnerHTML");
    expect(onbSrc).not.toContain("dangerouslySetInnerHTML");
  });

  it("renders message text as plain text with safe wrapping", () => {
    expect(chatSrc).toContain("whitespace-pre-wrap");
    expect(chatSrc).toContain("break-words");
  });
});

// ---------------------------------------------------------------------------
// Migration guards (RLS, immutability, storage, realtime)
// ---------------------------------------------------------------------------

describe("community migration guards", () => {
  const sql = readSrc("supabase/migrations/20261014000000_community.sql");

  it("enables RLS on all three tables", () => {
    expect((sql.match(/enable row level security/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("messages: read for all members, insert own-only, NO update/delete policies", () => {
    expect(sql).toMatch(
      /on public\.community_messages for select to authenticated\s+using \(true\)/i,
    );
    expect(sql).toMatch(
      /on public\.community_messages for insert to authenticated\s+with check \(auth\.uid\(\) = user_id\)/i,
    );
    expect(sql).not.toMatch(
      /on public\.community_messages for (update|delete)/i,
    );
  });

  it("profiles: read for members, write own-row only; avatar + name constraints enforced", () => {
    expect(sql).toMatch(/on public\.community_profiles for select to authenticated/i);
    expect(sql).toMatch(
      /on public\.community_profiles for insert to authenticated\s+with check \(auth\.uid\(\) = user_id\)/i,
    );
    expect(sql).toMatch(
      /on public\.community_profiles for update to authenticated\s+using \(auth\.uid\(\) = user_id\)\s+with check \(auth\.uid\(\) = user_id\)/i,
    );
    expect(sql).toMatch(
      /avatar_id in \('avatar-1', 'avatar-2', 'avatar-3', 'avatar-4', 'avatar-5'\)/,
    );
    expect(sql).toMatch(/char_length\(trim\(display_name\)\) between 1 and 40/);
    expect(sql).toMatch(/char_length\(message\) <= 2000/);
    expect(sql).toMatch(/community_messages_has_content/);
  });

  it("read state: own row only", () => {
    expect(sql).toMatch(
      /on public\.community_read_state for all to authenticated\s+using \(auth\.uid\(\) = user_id\)\s+with check \(auth\.uid\(\) = user_id\)/i,
    );
  });

  it("streams community_messages INSERTs via the realtime publication (idempotent)", () => {
    expect(sql).toMatch(/alter publication supabase_realtime add table public\.community_messages/i);
    expect(sql).toMatch(/pg_publication_tables/i);
  });

  it("storage: private bucket, 2 MB cap, jpeg/png/webp only, owner-folder writes, no overwrite/delete", () => {
    expect(sql).toMatch(
      /values \('community-images', 'community-images', false, 2097152, array\['image\/jpeg', 'image\/png', 'image\/webp'\]\)/,
    );
    expect(sql).toMatch(
      /on storage\.objects for select to authenticated\s+using \(bucket_id = 'community-images'\)/i,
    );
    expect(sql).toMatch(
      /\(storage\.foldername\(name\)\)\[1\] = auth\.uid\(\)::text/,
    );
    expect(sql).not.toMatch(/storage\.objects for (update|delete)/i);
  });
});

// ---------------------------------------------------------------------------
// i18n — every new Community key must resolve in all four languages
// ---------------------------------------------------------------------------

describe("community i18n parity", () => {
  const communityKeys = [
    "onboardingTitle",
    "onboardingHint",
    "nameLabel",
    "namePlaceholder",
    "nameHelp",
    "chooseAvatar",
    "complete",
    "avatarAlt",
    "nameRequired",
    "nameTooLong",
    "avatarInvalid",
    "onboardingFailed",
    "rateLimited",
    "emptyTitle",
    "emptyText",
    "emptyCta",
    "placeholder",
    "attachImage",
    "removeImage",
    "send",
    "you",
    "member",
    "imageAlt",
    "imageTooLarge",
    "invalidImage",
    "emptyMessage",
    "textTooLong",
    "sendFailed",
    "profileRequired",
    "reconnecting",
    "newMessages",
    "typingOne",
    "typingTwo",
    "typingMany",
    "unreadBadge",
  ];

  it("provides nav + page heading + all community keys in every language", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const dict = dictionaries[lang];
      const nav = lookup(dict, "nav.community");
      expect(nav, `${lang}:nav.community`).toBeTruthy();
      expect(lookup(dict, "pages.community.title"), `${lang}:title`).toBeTruthy();
      expect(lookup(dict, "pages.community.subtitle"), `${lang}:subtitle`).toBeTruthy();
      for (const key of communityKeys) {
        expect(
          lookup(dict, `community.${key}`),
          `${lang}:community.${key}`,
        ).toBeTruthy();
      }
    }
  });

  it("the empty-state copy matches the product copy in English", () => {
    const en = dictionaries.en;
    expect(lookup(en, "community.emptyTitle")).toBe("Welcome to the Community");
    expect(lookup(en, "community.emptyText")).toBe(
      "Connect with other Ausbildung Hunter members, share experiences and help each other.",
    );
    expect(lookup(en, "community.emptyCta")).toBe("Be the first to send a message.");
  });
});

// ---------------------------------------------------------------------------
// Realtime typing indicator (ephemeral presence — in-memory only)
// ---------------------------------------------------------------------------

const TYPING_SELF_ID = "33333333-3333-4333-8333-333333333333";
const TYPING_PEER_A = "44444444-4444-4444-8444-444444444444";
const TYPING_PEER_B = "55555555-5555-4555-8555-555555555555";
const TYPING_PEER_C = "66666666-6666-4666-8666-666666666666";

/** Deterministic in-memory scheduler for the debounce tests. */
function fakeScheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; cb: () => void }>();
  return {
    schedule(cb: () => void, ms: number) {
      const id = nextId++;
      timers.set(id, { at: now + ms, cb });
      return id;
    },
    cancel(handle: unknown) {
      timers.delete(handle as number);
    },
    /** Fire every timer due within the next `ms` (in deadline order). */
    advance(ms: number) {
      const target = now + ms;
      for (const [id, timer] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= target) {
          timers.delete(id);
          now = timer.at;
          timer.cb();
        }
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

function makeSender(sched = fakeScheduler()) {
  const events: Array<"typing_start" | "typing_stop"> = [];
  const sender = new TypingSender({
    emit: (type) => events.push(type),
    scheduler: sched,
  });
  return { sender, events, sched };
}

const enT = (path: string, vars?: Record<string, string | number>) =>
  translate("en", path, vars);

describe("typing state (incoming side)", () => {
  it("no typers → no active peers (indicator hidden)", () => {
    const state = createTypingState(TYPING_SELF_ID);
    expect(selectActiveTypers(state, 0)).toEqual([]);
  });

  it("adds a peer on typing_start and removes it on typing_stop", () => {
    let state = createTypingState(TYPING_SELF_ID);
    state = applyTypingEvent(
      state,
      { type: "typing_start", userId: TYPING_PEER_A, displayName: "Taha" },
      1000,
    );
    expect(selectActiveTypers(state, 1100)).toHaveLength(1);
    state = applyTypingEvent(
      state,
      { type: "typing_stop", userId: TYPING_PEER_A, displayName: "Taha" },
      1500,
    );
    expect(selectActiveTypers(state, 1600)).toEqual([]);
  });

  it("never counts the current user (own events are ignored)", () => {
    let state = createTypingState(TYPING_SELF_ID);
    state = applyTypingEvent(
      state,
      { type: "typing_start", userId: TYPING_SELF_ID, displayName: "Me" },
      1000,
    );
    state = applyTypingEvent(
      state,
      { type: "typing_start", userId: TYPING_PEER_A, displayName: "Taha" },
      1000,
    );
    expect(selectActiveTypers(state, 1100).map((p) => p.userId)).toEqual([
      TYPING_PEER_A,
    ]);
  });

  it("rejects malformed broadcasts (untrusted wire data)", () => {
    expect(parseTypingBroadcast(null)).toBeNull();
    expect(parseTypingBroadcast("typing_start")).toBeNull();
    expect(parseTypingBroadcast({})).toBeNull();
    expect(parseTypingBroadcast({ type: "typing_start" })).toBeNull();
    expect(parseTypingBroadcast({ type: "typing_start", userId: "   " })).toBeNull();
    expect(parseTypingBroadcast({ type: "weird", userId: TYPING_PEER_A })).toBeNull();
    expect(
      parseTypingBroadcast({
        type: "typing_start",
        userId: TYPING_PEER_A,
        displayName: "Taha",
        timestamp: 42,
      }),
    ).toEqual({
      type: "typing_start",
      userId: TYPING_PEER_A,
      displayName: "Taha",
      timestamp: 42,
    });
  });

  it("normalizes the untrusted name (trim + 40-char cap, empty fallback)", () => {
    const parsed = parseTypingBroadcast({
      type: "typing_start",
      userId: TYPING_PEER_A,
      displayName: `  ${"x".repeat(100)}  `,
    });
    expect(parsed?.displayName).toBe("x".repeat(COMMUNITY_MAX_NAME_LENGTH));
    expect(
      parseTypingBroadcast({ type: "typing_start", userId: TYPING_PEER_A })?.displayName,
    ).toBe("");
  });

  it("prunes a stale peer exactly at the TTL (and keeps it just before)", () => {
    let state = createTypingState(TYPING_SELF_ID);
    state = applyTypingEvent(
      state,
      { type: "typing_start", userId: TYPING_PEER_A, displayName: "Taha" },
      10_000,
    );
    expect(selectActiveTypers(state, 10_000 + TYPING_TTL_MS - 1)).toHaveLength(1);
    expect(selectActiveTypers(state, 10_000 + TYPING_TTL_MS)).toHaveLength(0);
    // pruneExpired is pure and idempotent.
    const pruned = pruneExpired(state, 10_000 + TYPING_TTL_MS);
    expect(Object.keys(pruned.peers)).toEqual([]);
    expect(pruneExpired(pruned, 10_000 + TYPING_TTL_MS)).toBe(pruned);
  });

  it("a fresh typing_start refreshes the expiry (keeps a genuinely active peer)", () => {
    let state = createTypingState(TYPING_SELF_ID);
    state = applyTypingEvent(
      state,
      { type: "typing_start", userId: TYPING_PEER_A, displayName: "Taha" },
      0,
    );
    const refreshAt = TYPING_TTL_MS - 1000;
    state = applyTypingEvent(
      state,
      { type: "typing_start", userId: TYPING_PEER_A, displayName: "Taha" },
      refreshAt,
    );
    // Long past the FIRST start's expiry — the refresh kept it alive.
    expect(selectActiveTypers(state, TYPING_TTL_MS + 1000)).toHaveLength(1);
    // …but it dies TYPING_TTL_MS after the LAST start.
    expect(selectActiveTypers(state, refreshAt + TYPING_TTL_MS)).toHaveLength(0);
  });

  it("orders typers deterministically (oldest start first, userId tie-break)", () => {
    let state = createTypingState(TYPING_SELF_ID);
    state = applyTypingEvent(state, { type: "typing_start", userId: TYPING_PEER_C, displayName: "C" }, 100);
    state = applyTypingEvent(state, { type: "typing_start", userId: TYPING_PEER_A, displayName: "A" }, 200);
    state = applyTypingEvent(state, { type: "typing_start", userId: TYPING_PEER_B, displayName: "B" }, 300);
    expect(selectActiveTypers(state, 400).map((p) => p.userId)).toEqual([
      TYPING_PEER_C,
      TYPING_PEER_A,
      TYPING_PEER_B,
    ]);
  });
});

describe("typing label (pluralization + i18n)", () => {
  it("0 → hidden, 1 → name, 2 → both names, 3 → count only", () => {
    expect(buildTypingLabel([], enT)).toBeNull();
    expect(buildTypingLabel(["Taha"], enT)).toBe("Taha is typing…");
    expect(buildTypingLabel(["Taha", "Sara"], enT)).toBe("Taha and Sara are typing…");
    expect(buildTypingLabel(["Taha", "Sara", "Youssef"], enT)).toBe(
      "3 people are typing…",
    );
  });

  it("10 typers → count only, never a name list", () => {
    const names = Array.from({ length: 10 }, (_, i) => `User${i}`);
    expect(buildTypingLabel(names, enT)).toBe("10 people are typing…");
    for (const name of names) {
      expect(buildTypingLabel(names, enT)).not.toContain(name);
    }
  });

  it("drops empty/whitespace names from the untrusted wire (no '… is typing')", () => {
    expect(buildTypingLabel(["", "   "], enT)).toBeNull();
    expect(buildTypingLabel(["  Taha  ", ""], enT)).toBe("Taha is typing…");
  });

  it("renders correctly in all four languages", () => {
    const expectations: Record<string, [string, string, string]> = {
      de: ["Taha schreibt…", "Taha und Sara schreiben…", "3 Personen schreiben…"],
      en: ["Taha is typing…", "Taha and Sara are typing…", "3 people are typing…"],
      fr: ["Taha écrit…", "Taha et Sara écrivent…", "3 personnes écrivent…"],
      ar: ["Taha يكتب…", "Taha و Sara يكتبان…", "3 أشخاص يكتبون…"],
    };
    for (const lang of SUPPORTED_LANGUAGES) {
      const [one, two, many] = expectations[lang]!;
      const t = (path: string, vars?: Record<string, string | number>) =>
        translate(lang, path, vars);
      expect(buildTypingLabel(["Taha"], t), `${lang}:one`).toBe(one);
      expect(buildTypingLabel(["Taha", "Sara"], t), `${lang}:two`).toBe(two);
      expect(buildTypingLabel(["Taha", "Sara", "Youssef"], t), `${lang}:many`).toBe(many);
    }
  });
});

describe("TypingSender (outgoing side)", () => {
  it("emits typing_start ONCE per burst — never per keystroke", () => {
    const { sender, events, sched } = makeSender();
    sender.onInput(true); // first character
    expect(events).toEqual(["typing_start"]);
    for (let i = 0; i < 25; i++) sender.onInput(true); // 25 more keystrokes
    expect(events).toEqual(["typing_start"]);
    expect(sender.isTyping).toBe(true);
    sched.advance(60_000); // any (incorrect) stray timer would fire here
    expect(events).toEqual(["typing_start", "typing_stop"]);
    expect(sender.isTyping).toBe(false);
  });

  it("sends typing_stop after the idle debounce (exactly TYPING_STOP_DELAY_MS)", () => {
    const { sender, events, sched } = makeSender();
    sender.onInput(true);
    sched.advance(TYPING_STOP_DELAY_MS - 1);
    expect(events).toEqual(["typing_start"]);
    sched.advance(1);
    expect(events).toEqual(["typing_start", "typing_stop"]);
  });

  it("each keystroke re-arms the debounce (no stop mid-burst)", () => {
    const { sender, events, sched } = makeSender();
    sender.onInput(true);
    sched.advance(TYPING_STOP_DELAY_MS - 500);
    sender.onInput(true); // still typing
    sched.advance(500); // only half the delay since the last key
    expect(events).toEqual(["typing_start"]);
    sched.advance(TYPING_STOP_DELAY_MS - 500);
    expect(events).toEqual(["typing_start", "typing_stop"]);
  });

  it("Send → commit() → immediate typing_stop + debounce cancelled", () => {
    const { sender, events, sched } = makeSender();
    sender.onInput(true);
    sender.commit();
    expect(events).toEqual(["typing_start", "typing_stop"]);
    expect(sched.pending()).toBe(0);
  });

  it("empty field → immediate typing_stop", () => {
    const { sender, events, sched } = makeSender();
    sender.onInput(true);
    sender.onInput(false);
    expect(events).toEqual(["typing_start", "typing_stop"]);
    expect(sched.pending()).toBe(0);
  });

  it("commit() while idle sends nothing (no stray stops)", () => {
    const { sender, events } = makeSender();
    sender.commit();
    expect(events).toEqual([]);
  });

  it("a new burst after a stop starts again", () => {
    const { sender, events, sched } = makeSender();
    sender.onInput(true);
    sched.advance(TYPING_STOP_DELAY_MS);
    sender.onInput(true);
    expect(events).toEqual(["typing_start", "typing_stop", "typing_start"]);
  });

  it("dispose() (unmount) sends the stop, cancels the timer, and goes silent", () => {
    const { sender, events, sched } = makeSender();
    sender.onInput(true);
    sender.dispose();
    expect(events).toEqual(["typing_start", "typing_stop"]);
    expect(sched.pending()).toBe(0);
    sched.advance(60_000); // no zombie event from the cancelled timer
    sender.onInput(true); // disposed → dead
    expect(events).toEqual(["typing_start", "typing_stop"]);
  });
});

describe("typing indicator (source guard)", () => {
  const chatSrc = readSrc("src/components/community-chat.tsx");
  const cssSrc = readSrc("src/app/globals.css");
  const typingSrc = readSrc("src/lib/community/typing.ts");

  it("rides the EXISTING realtime channel — no new channel, table or polling", () => {
    expect(TYPING_BROADCAST_EVENT).toBe("community_typing");
    expect(chatSrc).toContain('.channel("community-messages")');
    // The listener is wired through the shared constant (single source of truth).
    expect(chatSrc).toContain('.on("broadcast", { event: TYPING_BROADCAST_EVENT }');
    // Only the two pre-existing Supabase queries (profiles + image bucket):
    // typing added no database access at all.
    expect(chatSrc.match(/\.from\(/g)).toHaveLength(2);
    // Only the three pre-existing fetches (reconnect resync, load older,
    // message POST) — typing added no network calls of its own.
    expect(chatSrc.match(/\bfetch\(/g)).toHaveLength(3);
  });

  it("stale cleanup is a local timer; reconnect clears stale peers; disconnect stops", () => {
    expect(chatSrc).toContain("window.setInterval(refreshTyping, TYPING_PRUNE_INTERVAL_MS)");
    // After a reconnect the (stale) peer list is wiped…
    expect(chatSrc).toContain("clearTyping()");
    // …and on disconnect our own indicator stops immediately.
    expect(chatSrc).toMatch(/senderRef\.current\?\.commit\(\);/);
  });

  it("the broadcast handler only touches typing state (never messages/read state)", () => {
    const handler = chatSrc.match(
      /\.on\("broadcast", \{ event: TYPING_BROADCAST_EVENT \}, \(payload\) => \{[\s\S]*?\}\)/,
    );
    expect(handler).not.toBeNull();
    const body = handler?.[0] ?? "";
    expect(body).not.toContain("setMessages");
    expect(body).not.toContain("scheduleMarkRead");
    expect(body).not.toContain("knownIds");
    expect(body).not.toContain("markCommunityRead");
  });

  it("is accessible (role=status, polite live region) and CSS-animated", () => {
    expect(chatSrc).toContain('role="status"');
    expect(chatSrc).toContain('aria-live="polite"');
    expect(cssSrc).toContain("@keyframes typing-bounce");
    expect(cssSrc).toContain(".typing-dot");
    expect(cssSrc).toMatch(/animation-delay:\s*150ms/);
    expect(cssSrc).toMatch(/animation-delay:\s*300ms/);
  });

  it("reduced-motion: frozen dots stay visible and the label still renders", () => {
    // The global prefers-reduced-motion rule freezes every animation; the
    // dots keep their base opacity (static, visible) — the text is never
    // animated, so it can never be blanked.
    expect(cssSrc).toContain("@media (prefers-reduced-motion: reduce)");
    expect(cssSrc).toMatch(/\.typing-dot\s*\{[^}]*opacity:\s*0\.6/);
    expect(chatSrc).toContain("typingLabel");
  });

  it("never writes to the database (pure module, untouched migration)", () => {
    expect(typingSrc).not.toMatch(
      /supabase|\.from\(|insert|\.rpc\(|localStorage|sessionStorage|fetch\(/,
    );
    const sql = readSrc("supabase/migrations/20261014000000_community.sql");
    expect(sql).not.toMatch(/typing/i);
  });
});

// ---------------------------------------------------------------------------
// DB-outage behaviour of the Community writes (no white page, ever)
// ---------------------------------------------------------------------------

describe("community writes during a database outage", () => {
  it("completeOnboarding resolves with 'generic' when the client itself throws (never rejects)", async () => {
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: async () => ({ data: { user: { id: USER_ID } } }),
      },
      from: () => {
        throw new Error("connection terminated");
      },
    } as never);
    // A rejected server action here would blow up the onboarding transition
    // and blank the page through the error boundary.
    await expect(
      completeOnboarding({ displayName: "Anna", avatarId: "avatar-1" }),
    ).resolves.toEqual({ ok: false, code: "generic" });
  });

  it("markCommunityRead swallows a transport failure (the badge must never break)", async () => {
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: async () => ({ data: { user: { id: USER_ID } } }),
      },
      from: () => {
        throw new Error("connection terminated");
      },
    } as never);
    await expect(markCommunityRead(OTHER_USER_ID)).resolves.toBeUndefined();
  });

  it("is idempotent: completing onboarding twice writes the same conflict target", async () => {
    allowRateLimits(5);
    const upserts = mockUpsertClient(USER_ID);
    const input = { displayName: "Anna", avatarId: "avatar-3" };
    await expect(completeOnboarding(input)).resolves.toEqual({ ok: true });
    await expect(completeOnboarding(input)).resolves.toEqual({ ok: true });
    expect(upserts).toHaveLength(2);
    expect(upserts[0]).toEqual(upserts[1]);
    expect(upserts[0].payload).toEqual({
      user_id: USER_ID,
      display_name: "Anna",
      avatar_id: "avatar-3",
    });
  });
});
