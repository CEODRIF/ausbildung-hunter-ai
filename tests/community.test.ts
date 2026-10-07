/**
 * Community v2 (rooms) — comprehensive coverage:
 *  - identity: 4 avatars, generated-username format + schema
 *  - username generator (deterministic with injected RNG, non-human names)
 *  - image validation (MIME allowlist, 2 MB byte cap, magic bytes, spoofing)
 *  - storage path generation (UUID-only segments, no client filenames)
 *  - mention extraction (pure tokenizer input) + broadcast event parsers
 *  - realtime/message merge dedupe + chronological order
 *  - reaction aggregation (pure)
 *  - rate-limit budgets for the community scopes
 *  - GET/POST /api/community/messages (room scope, auth, validation,
 *    impersonation, replies, image accept/reject, storage path isolation)
 *  - GET /api/community/rooms, /api/community/members
 *  - POST /api/community/messages/:id/reactions (toggle)
 *  - PATCH/DELETE /api/community/messages/:id (own rows only)
 *  - per-room unread (SQL summary via admin rpc)
 *  - server actions (onboarding, generate username, identity edit, room read)
 *  - XSS source guard (messages render as plain text + safe mention chips)
 *  - migration guards (v1 kept + v2: rooms, RLS, reactions, mentions,
 *    read state, unique usernames, storage)
 *  - i18n parity (all keys incl. 21 room descriptions, four languages)
 *  - typing indicator (pure state machine, unchanged from v1)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommunityMessage, CommunityRoom, LocalMessage } from "@/lib/community";

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
  COMMUNITY_MAX_USERNAME_LENGTH,
  COMMUNITY_MIN_USERNAME_LENGTH,
  buildCommunityImagePath,
  communityAvatarUrl,
  communityProfileSchema,
  createOptimisticMessage,
  extractMentionUsernames,
  isValidCommunityUsername,
  mergeCommunityMessages,
  setSendStatus,
  validateCommunityImage,
} = await import("@/lib/community");
const {
  generateCommunityUsername,
  generateUniqueCandidate,
  isPlausibleCommunityUsername,
} = await import("@/lib/community/identity");
const {
  MESSAGE_DELETE_BROADCAST_EVENT,
  MESSAGE_UPDATE_BROADCAST_EVENT,
  parseMessageDeleteBroadcast,
  parseMessageUpdateBroadcast,
} = await import("@/lib/community/events");
const {
  aggregateReactions,
  fetchRoomUnreadMap,
} = await import("@/lib/community/rooms");
const { getCommunityUnreadCount } = await import("@/lib/community/server");
const { GET: messagesGET, POST: messagesPOST } = await import(
  "@/app/api/community/messages/route"
);
const { GET: roomsGET } = await import("@/app/api/community/rooms/route");
const { GET: membersGET } = await import("@/app/api/community/members/route");
const { POST: reactionsPOST } = await import(
  "@/app/api/community/messages/[id]/reactions/route"
);
const { PATCH: messagePATCH, DELETE: messageDELETE } = await import(
  "@/app/api/community/messages/[id]/route"
);
const {
  completeOnboarding,
  generateCommunityUsernameAction,
  markRoomRead,
  updateCommunityIdentity,
} = await import("@/app/community/actions");
const { RATE_LIMITS } = await import("@/lib/rate-limit");
const { dictionaries, SUPPORTED_LANGUAGES } = await import(
  "@/lib/i18n/dictionaries"
);
const { lookup, translate } = await import("@/lib/i18n/core");

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readSrc = (relative: string) => readFileSync(resolve(root, relative), "utf8");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
/** The seeded default room (#public-chat) — deterministic UUID from the v2 migration. */
const ROOM_ID = "b1000000-0000-4000-8000-000000000001";
const ROOM: CommunityRoom = {
  id: ROOM_ID,
  slug: "public-chat",
  name: "Public Chat",
  category_id: "b0000000-0000-4000-8000-000000000001",
  description: null,
  icon: "hash",
  position: 1,
  enabled: true,
  qna_enabled: false,
};

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface AdminOpts {
  rateLimit?: { allowed: boolean; count?: number; limit?: number; retry_after?: number } | null;
  rpcError?: { message: string } | null;
  /** community_room_unread_summary rows. */
  unread?: Array<{ room_id: string; unread: number } | null>;
  /** Mention resolution (.or on community_profiles). */
  mentionProfiles?: Array<{ user_id: string }>;
  throwFrom?: boolean;
}

/**
 * Admin-client mock. Branches on the RPC name (check_rate_limit vs
 * community_room_unread_summary) and on the table (mention resolution vs
 * mention persistence).
 */
function mockAdmin(opts: AdminOpts = {}) {
  vi.mocked(createAdminClient).mockReturnValue({
    rpc: (fn: string) =>
      Promise.resolve(
        opts.rpcError
          ? { data: null, error: opts.rpcError }
          : fn === "community_room_unread_summary"
            ? { data: opts.unread ?? [], error: null }
            : {
                data: opts.rateLimit ?? {
                  allowed: true,
                  count: 1,
                  limit: 100,
                  retry_after: 0,
                },
                error: null,
              },
      ),
    from: (table: string) => {
      if (opts.throwFrom) throw new Error("db down");
      const base: Record<string, unknown> = {};
      base.select = () => base;
      base.or = () => base;
      base.eq = () => base;
      base.upsert = () => base;
      base.delete = () => base;
      base.then = (onF?: unknown, onR?: unknown) =>
        Promise.resolve({
          data: table === "community_profiles" ? (opts.mentionProfiles ?? []) : null,
          error: null,
        }).then(onF as never, onR as never);
      return base;
    },
  } as never);
}

function allowRateLimits(limit = 100) {
  mockAdmin({ rateLimit: { allowed: true, count: 1, limit, retry_after: 0 } });
}

function denyRateLimits(scope: string) {
  const { max } = RATE_LIMITS[scope as keyof typeof RATE_LIMITS];
  mockAdmin({
    rateLimit: { allowed: false, count: max + 1, limit: max, retry_after: 17 },
  });
}

function mockAuth(userId: string | null) {
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: userId ? { id: userId } : null,
    profile: null,
  } as never);
}

/**
 * Mock row fixtures are plain objects (DB wire shape). `object` (not
 * Record<string, unknown>) so typed interfaces (CommunityRoom/…) can be
 * assigned without an index signature.
 */
interface ClientFixture {
  /** community_profiles maybeSingle (POST: sender must have onboarding done). */
  profile?: object | null;
  /** community_rooms maybeSingle (room lookup by slug). */
  room?: object | null;
  /** community_room_categories select (directory). */
  categories?: Array<object>;
  /** community_rooms select (directory listing). */
  rooms?: Array<object>;
  /** community_profiles select via thenable (author enrichment / members). */
  profiles?: Array<object>;
  /** community_messages select via thenable (room page / reply lookup). */
  messages?: Array<object>;
  /** community_message_reactions select via thenable (reaction list). */
  reactions?: Array<object>;
  /** community_messages .maybeSingle (reactions route: message exists). */
  messageRow?: object | null;
  /** community_message_reactions .maybeSingle (reactions route: my row). */
  myReaction?: object | null;
  /** POST: reply parent check (community_messages maybeSingle #1). */
  replyParent?: object | null;
  /** POST: client-id pre-check (community_messages maybeSingle). */
  existing?: object | null;
  /** POST: visible after a 23505 insert collision. */
  existingAfterInsert?: object | null;
  /** community_messages insert(...).single() result (POST). */
  inserted?: {
    data: Record<string, unknown> | null;
    error: { message: string; code?: string } | null;
  };
  /** storage.upload result (POST with image). */
  uploadError?: { message: string } | null;
  /** thenable error for community_messages (DB outage). */
  messageError?: { message: string } | null;
  /** thenable error for community_rooms (directory read, DB outage). */
  roomError?: { message: string } | null;
  /** maybeSingle error for community_rooms (room lookup, DB outage). */
  roomLookupError?: { message: string } | null;
  /** delete() result error (reactions toggle-off). */
  deleteError?: { message: string } | null;
}

interface RecordedCall {
  table: string;
  op: string;
  args: unknown[];
}

/** Supabase user-client mock that branches on table name + operation. */
function mockCommunityClient(f: ClientFixture = {}) {
  const calls: RecordedCall[] = [];
  let messagesMaybeSingleCalls = 0;
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
      base.or = makeOp("or");
      base.ilike = makeOp("ilike");
      base.upsert = makeOp("upsert");
      base.delete = makeOp("delete");
      Object.assign(base, {
        update: makeOp("update"),
        maybeSingle: async () => {
          if (table === "community_profiles")
            return { data: f.profile ?? null, error: null };
          if (table === "community_rooms")
            return {
              data: (f.room ?? null) as Record<string, unknown> | null,
              error: f.roomLookupError ?? null,
            };
          if (table === "community_message_reactions")
            return { data: (f.myReaction ?? null) as Record<string, unknown> | null, error: null };
          if (table === "community_messages") {
            messagesMaybeSingleCalls += 1;
            // Call order per route:
            //   POST + reply:  #1 parent check → #2 id pre-check → #3 23505 re-fetch
            //   POST no reply: #1 id pre-check → #2 23505 re-fetch
            //   PATCH/DELETE/reactions: #1 the row itself
            const replyFlow = f.replyParent !== undefined;
            const idx = messagesMaybeSingleCalls - (replyFlow ? 1 : 0);
            if (replyFlow && idx === 0)
              return { data: (f.replyParent ?? null) as Record<string, unknown> | null, error: null };
            const row =
              idx === 1
                ? ((f.existing ?? f.messageRow ?? null) as Record<string, unknown> | null)
                : ((f.existingAfterInsert ?? f.existing ?? f.messageRow ?? null) as
                    | Record<string, unknown>
                    | null);
            return { data: row, error: null };
          }
          return { data: null, error: null };
        },
        single: async () => {
          if (f.inserted) return f.inserted;
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
            table === "community_messages"
              ? (f.messages ?? [])
              : table === "community_profiles"
                ? (f.profiles ?? [])
                : table === "community_room_categories"
                  ? (f.categories ?? [])
                  : table === "community_rooms"
                    ? (f.rooms ?? [])
                    : table === "community_message_reactions"
                      ? (f.reactions ?? [])
                      : [],
          error:
            table === "community_messages"
              ? (f.messageError ?? null)
              : table === "community_rooms"
                ? (f.roomError ?? null)
                : null,
        }).then(onF as never, onR as never);
      return base;
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, blob: Blob, opts: unknown) => {
          calls.push({ table: bucket, op: "upload", args: [path, blob, opts] });
          return { error: f.uploadError ?? null };
        },
        remove: async (paths: string[]) => {
          calls.push({ table: bucket, op: "remove", args: [paths] });
          return { error: f.deleteError ?? null };
        },
      }),
    },
  } as never);
  return { calls };
}

/**
 * Session-client mock for the SERVER ACTIONS: auth.getUser + upsert (own
 * profile / room read state) + update (identity) + ilike select (username
 * candidate availability).
 */
interface ActionClientOpts {
  userId: string | null;
  upsertError?: { message: string; code?: string } | null;
  updateError?: { message: string; code?: string } | null;
  /** Candidate-availability rows for the LAST ilike() value. */
  candidatesData?: (candidate: string) => Array<Record<string, unknown>>;
  throwOnFrom?: boolean;
}

function mockActionClient(opts: ActionClientOpts) {
  const upserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const ilikeValues: string[] = [];
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({ data: { user: opts.userId ? { id: opts.userId } : null } }),
    },
    from: (table: string) => {
      if (opts.throwOnFrom) throw new Error("connection terminated");
      const base: Record<string, unknown> = {};
      base.select = () => base;
      base.eq = () => base;
      base.limit = () => base;
      base.ilike = (_column: string, value: string) => {
        ilikeValues.push(value);
        return base;
      };
      base.upsert = (payload: Record<string, unknown>) => {
        upserts.push({ table, payload });
        base.then = (onF?: unknown, onR?: unknown) =>
          Promise.resolve({ error: opts.upsertError ?? null }).then(onF as never, onR as never);
        return base;
      };
      base.update = (payload: Record<string, unknown>) => {
        updates.push({ table, payload });
        base.then = (onF?: unknown, onR?: unknown) =>
          Promise.resolve({ error: opts.updateError ?? null }).then(onF as never, onR as never);
        return base;
      };
      base.then = (onF?: unknown, onR?: unknown) =>
        Promise.resolve({
          data: opts.candidatesData
            ? opts.candidatesData(ilikeValues[ilikeValues.length - 1])
            : [],
          error: null,
        }).then(onF as never, onR as never);
      return base;
    },
  } as never);
  return { upserts, updates, ilikeValues };
}

/** A server-shaped message promoted to the client state shape. */
function asLocal(
  msg: CommunityMessage,
  author: { user_id: string; display_name: string; avatar_id: string } | null,
): LocalMessage {
  return { ...msg, author, reactions: [], replyTo: null };
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
    room_id: ROOM_ID,
    message: "text",
    image_path: null,
    reply_to_message_id: null,
    created_at: createdAt,
    updated_at: createdAt,
    ...extra,
  };
}

function postForm(build: (fd: FormData) => void) {
  const fd = new FormData();
  build(fd);
  return messagesPOST(
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
  mockAdmin();
  allowRateLimits();
});

// ---------------------------------------------------------------------------
// Identity — avatars (exactly four: 2 feminine, 2 masculine)
// ---------------------------------------------------------------------------

describe("avatars", () => {
  it("exposes exactly the four predefined ids", () => {
    expect([...COMMUNITY_AVATAR_IDS]).toEqual([
      "avatar-1",
      "avatar-2",
      "avatar-3",
      "avatar-4",
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
// Identity — generated usernames
// ---------------------------------------------------------------------------

describe("generated usernames", () => {
  it("is deterministic for an injected RNG", () => {
    // Sequential values: 0.1, 0.9, 0.1, 0.9, …
    let i = 0;
    const rng = () => (i++ % 2 === 0 ? 0.1 : 0.9);
    const first = generateCommunityUsername(rng);
    const second = generateCommunityUsername(rng);
    expect(first).toBe(second);
    expect(first).toMatch(/^[A-Za-z][A-Za-z0-9]{2,23}$/);
  });

  it("always yields a plausible username (3–24 chars, letters+digits)", () => {
    let i = 0;
    const rng = () => {
      i += 1;
      return (i * 0.6180339887) % 1; // golden-ratio sequence, full list coverage
    };
    for (let n = 0; n < 500; n++) {
      const name = generateCommunityUsername(rng);
      expect(name).toMatch(/^[A-Za-z][A-Za-z0-9]{2,23}$/);
      expect(name.length).toBeGreaterThanOrEqual(COMMUNITY_MIN_USERNAME_LENGTH);
      expect(name.length).toBeLessThanOrEqual(COMMUNITY_MAX_USERNAME_LENGTH);
      expect(isPlausibleCommunityUsername(name)).toBe(true);
      expect(isValidCommunityUsername(name)).toBe(true);
    }
  });

  it("never emits a personal first name (adjective+creature word lists only)", () => {
    const firstNames = new Set([
      "anna", "sara", "lena", "taha", "mike", "mustapha", "james", "emily",
    ]);
    let i = 0;
    const rng = () => {
      i += 1;
      return (i * 0.3819660113) % 1;
    };
    for (let n = 0; n < 500; n++) {
      const name = generateCommunityUsername(rng);
      expect(firstNames.has(name.toLowerCase())).toBe(false);
    }
  });

  it("generateUniqueCandidate avoids taken names and gives up gracefully", () => {
    const taken = new Set<string>();
    let i = 0;
    const rng = () => {
      i += 1;
      return (i * 0.6180339887) % 1;
    };
    // Force the first three candidates to be "taken" by a slow observer.
    const slow: string[] = [];
    const candidate = generateUniqueCandidate(
      (name) => {
        slow.push(name);
        if (slow.length <= 3) {
          taken.add(name);
          return true;
        }
        return taken.has(name);
      },
      rng,
    );
    expect(candidate).toBe(slow[3]);
    expect(candidate).not.toBe(slow[0]);
  });
});

// ---------------------------------------------------------------------------
// Username format + profile schema
// ---------------------------------------------------------------------------

describe("communityProfileSchema (username + avatar)", () => {
  it("accepts a valid username + one of the four avatars", () => {
    const parsed = communityProfileSchema.safeParse({
      displayName: "BlueFalcon",
      avatarId: "avatar-3",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ displayName: "BlueFalcon", avatarId: "avatar-3" });
    }
  });

  it("accepts every one of the four avatar ids", () => {
    for (const avatarId of COMMUNITY_AVATAR_IDS) {
      expect(
        communityProfileSchema
          .safeParse({ displayName: "SilverFox", avatarId })
          .success,
      ).toBe(true);
    }
  });

  it("trims surrounding whitespace from the name", () => {
    const parsed = communityProfileSchema.safeParse({
      displayName: "   SilverFox   ",
      avatarId: "avatar-1",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.displayName).toBe("SilverFox");
  });

  it("rejects names that violate the username format", () => {
    const badNames = [
      "", // empty
      "   ", // whitespace only
      "ab", // shorter than 3
      "1abc", // must start with a letter
      "Anna Marie", // no spaces (mention parsing needs word boundaries)
      "Anna-Marie", // no dashes
      "Anna.Marie", // no dots
      "a".repeat(COMMUNITY_MAX_USERNAME_LENGTH + 1), // longer than 24
    ];
    for (const displayName of badNames) {
      const parsed = communityProfileSchema.safeParse({
        displayName,
        avatarId: "avatar-1",
      });
      expect(parsed.success, JSON.stringify(displayName)).toBe(false);
      if (!parsed.success)
        expect(parsed.error.issues[0].path[0]).toBe("displayName");
    }
  });

  it(`accepts the boundary lengths ${COMMUNITY_MIN_USERNAME_LENGTH} and ${COMMUNITY_MAX_USERNAME_LENGTH}`, () => {
    expect(
      isValidCommunityUsername("a".repeat(COMMUNITY_MIN_USERNAME_LENGTH)),
    ).toBe(true);
    expect(
      isValidCommunityUsername("a".repeat(COMMUNITY_MAX_USERNAME_LENGTH)),
    ).toBe(true);
  });

  it("rejects avatar ids outside the predefined set (incl. the retired avatar-5)", () => {
    for (const bad of ["avatar-0", "avatar-5", "avatar-6", "custom", "avatar-1.png", ".."]) {
      const parsed = communityProfileSchema.safeParse({
        displayName: "SilverFox",
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
    expect(validateCommunityImage("image/jpeg", pdfBytes())).toEqual({
      ok: false,
      code: "invalid_image",
    });
    expect(validateCommunityImage("image/png", pdfBytes())).toEqual({
      ok: false,
      code: "invalid_image",
    });
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
// Mentions — token extraction (server-side resolution input)
// ---------------------------------------------------------------------------

describe("extractMentionUsernames", () => {
  it("extracts word-boundary @tokens, deduped case-insensitively", () => {
    expect(extractMentionUsernames("hi @Taha and @Sara, @TAHA again")).toEqual([
      "Taha",
      "Sara",
    ]);
  });

  it("accepts a mention at the very start of the message", () => {
    expect(extractMentionUsernames("@BlueFalcon welcome!")).toEqual(["BlueFalcon"]);
  });

  it("accepts mentions after opening punctuation/quotes", () => {
    expect(extractMentionUsernames("(@Taha) \"@Sara\" > @Lena [{@Mira}]")).toEqual([
      "Taha",
      "Sara",
      "Lena",
      "Mira",
    ]);
  });

  it("does not treat non-ASCII quote characters as word boundaries", () => {
    // „“ are not in the boundary class — only ASCII boundaries start a mention.
    expect(extractMentionUsernames("„@Sara“")).toEqual([]);
  });

  it("never matches inside a word, in an email address, or in a URL", () => {
    expect(extractMentionUsernames("email@x.com x@y.de")).toEqual([]);
    expect(extractMentionUsernames("https://example.com/@Taha")).toEqual([]);
  });

  it("respects the 2–24 username length and leading-letter rules", () => {
    expect(extractMentionUsernames("@ab @1abc @a")).toEqual(["ab"]);
    // 24 chars (1 + 23) is the longest token the extractor accepts…
    expect(extractMentionUsernames("@" + "a".repeat(24))).toEqual(
      ["a".repeat(24)],
    );
    // …and a 25th character is simply not part of the token.
    expect(extractMentionUsernames("@" + "a".repeat(25) + " b")).toEqual([
      "a".repeat(24),
    ]);
  });

  it("returns [] for null/empty text", () => {
    expect(extractMentionUsernames(null)).toEqual([]);
    expect(extractMentionUsernames("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Room broadcast events (untrusted wire data — strict parsers)
// ---------------------------------------------------------------------------

describe("message broadcast parsers", () => {
  const validMessage = {
    id: "77777777-7777-4777-8777-777777777777",
    user_id: USER_ID,
    message: "edited",
    image_path: null,
    reply_to_message_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:01.000Z",
  };

  it("accepts a well-formed update broadcast and pins room_id to the room", () => {
    const parsed = parseMessageUpdateBroadcast({
      roomId: ROOM_ID,
      message: validMessage,
    });
    expect(parsed).toEqual({
      roomId: ROOM_ID,
      message: { ...validMessage, room_id: ROOM_ID },
    });
  });

  it("accepts an optional reply_to_message_id (UUID) and image_path (string)", () => {
    const parsed = parseMessageUpdateBroadcast({
      roomId: ROOM_ID,
      message: {
        ...validMessage,
        image_path: `${USER_ID}/x/image.png`,
        reply_to_message_id: "88888888-8888-4888-8888-888888888888",
      },
    });
    expect(parsed?.message.image_path).toBe(`${USER_ID}/x/image.png`);
    expect(parsed?.message.reply_to_message_id).toBe(
      "88888888-8888-4888-8888-888888888888",
    );
  });

  it("rejects malformed update payloads (no partial trust)", () => {
    expect(parseMessageUpdateBroadcast(null)).toBeNull();
    expect(parseMessageUpdateBroadcast("junk")).toBeNull();
    expect(parseMessageUpdateBroadcast({})).toBeNull();
    expect(parseMessageUpdateBroadcast({ roomId: ROOM_ID })).toBeNull();
    expect(
      parseMessageUpdateBroadcast({ roomId: "not-a-uuid", message: validMessage }),
    ).toBeNull();
    expect(
      parseMessageUpdateBroadcast({
        roomId: ROOM_ID,
        message: { ...validMessage, id: "nope" },
      }),
    ).toBeNull();
    expect(
      parseMessageUpdateBroadcast({
        roomId: ROOM_ID,
        message: { ...validMessage, user_id: 42 },
      }),
    ).toBeNull();
    expect(
      parseMessageUpdateBroadcast({
        roomId: ROOM_ID,
        message: { ...validMessage, reply_to_message_id: "not-a-uuid" },
      })?.message.reply_to_message_id,
    ).toBeNull();
  });

  it("accepts a well-formed delete broadcast", () => {
    expect(
      parseMessageDeleteBroadcast({
        roomId: ROOM_ID,
        id: "77777777-7777-4777-8777-777777777777",
      }),
    ).toEqual({
      roomId: ROOM_ID,
      id: "77777777-7777-4777-8777-777777777777",
    });
  });

  it("rejects malformed delete payloads", () => {
    expect(parseMessageDeleteBroadcast(null)).toBeNull();
    expect(parseMessageDeleteBroadcast({ roomId: ROOM_ID })).toBeNull();
    expect(
      parseMessageDeleteBroadcast({ roomId: ROOM_ID, id: "../etc/passwd" }),
    ).toBeNull();
    expect(
      parseMessageDeleteBroadcast({
        roomId: "junk",
        id: "77777777-7777-4777-8777-777777777777",
      }),
    ).toBeNull();
  });

  it("publishes the two distinct, stable event names", () => {
    expect(MESSAGE_UPDATE_BROADCAST_EVENT).toBe("community_message_update");
    expect(MESSAGE_DELETE_BROADCAST_EVENT).toBe("community_message_delete");
  });
});

// ---------------------------------------------------------------------------
// Reaction aggregation (pure)
// ---------------------------------------------------------------------------

describe("aggregateReactions", () => {
  it("groups by message and emoji, counts, and flags the viewer's own rows", () => {
    const rows = [
      { message_id: "m1", emoji: "👍", user_id: USER_ID },
      { message_id: "m1", emoji: "👍", user_id: OTHER_USER_ID },
      { message_id: "m1", emoji: "❤️", user_id: OTHER_USER_ID },
      { message_id: "m2", emoji: "😂", user_id: USER_ID },
    ];
    const out = aggregateReactions(rows, USER_ID);
    expect(out.m1).toEqual([
      { emoji: "👍", count: 2, mine: true },
      { emoji: "❤️", count: 1, mine: false },
    ]);
    expect(out.m2).toEqual([{ emoji: "😂", count: 1, mine: true }]);
    expect(out.m3).toBeUndefined();
  });

  it("orders per-message aggregates by count (descending) and handles no viewer", () => {
    const rows = [
      { message_id: "m1", emoji: "🔥", user_id: "a" },
      { message_id: "m1", emoji: "✅", user_id: "a" },
      { message_id: "m1", emoji: "✅", user_id: "b" },
    ];
    const out = aggregateReactions(rows, null);
    expect(out.m1).toEqual([
      { emoji: "✅", count: 2, mine: false },
      { emoji: "🔥", count: 1, mine: false },
    ]);
  });

  it("is empty for no rows", () => {
    expect(aggregateReactions([], USER_ID)).toEqual({});
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
// Send/realtime dedupe contract (one room channel, stable message ids)
// ---------------------------------------------------------------------------

describe("send/realtime dedupe contract", () => {
  const sent = msgFixture("m1", USER_ID, "2026-01-01T10:00:00.000Z");

  it("the sender sees the message from the POST response and NOT twice when realtime echoes it", () => {
    const afterPost = mergeCommunityMessages([], [sent]);
    expect(afterPost).toHaveLength(1);
    const afterEcho = mergeCommunityMessages(afterPost, [sent]);
    expect(afterEcho).toHaveLength(1);
    expect(afterEcho[0].id).toBe("m1");
  });

  it("also yields exactly one message when realtime arrives BEFORE the POST response", () => {
    const afterRealtime = mergeCommunityMessages([], [sent]);
    const afterPost = mergeCommunityMessages(afterRealtime, [sent]);
    expect(afterPost).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Optimistic send lifecycle (pure state machine, room-scoped)
// ---------------------------------------------------------------------------

const OPT_ID = "90000000-0000-4000-8000-000000000001";
const ME_AUTHOR = { user_id: USER_ID, display_name: "Taha", avatar_id: "avatar-1" };
const OTHER_AUTHOR = { user_id: OTHER_USER_ID, display_name: "Sara", avatar_id: "avatar-2" };

function optimisticFixture(
  id: string,
  text = "salut",
  replyToMessageId: string | null = null,
): LocalMessage {
  return createOptimisticMessage({
    id,
    roomId: ROOM_ID,
    user: ME_AUTHOR,
    text: text || null,
    imagePath: null,
    replyToMessageId,
    createdAt: "2026-01-01T10:00:00.000Z",
  });
}

describe("optimistic send lifecycle (pure)", () => {
  it("createOptimisticMessage builds a render-ready row in 'sending' state", () => {
    const row = optimisticFixture(OPT_ID);
    expect(row).toMatchObject({
      id: OPT_ID,
      user_id: USER_ID,
      room_id: ROOM_ID,
      message: "salut",
      image_path: null,
      reply_to_message_id: null,
      sendStatus: "sending",
      author: ME_AUTHOR,
      reactions: [],
      replyTo: null,
    });
    expect(row.created_at).toBe("2026-01-01T10:00:00.000Z");
  });

  it("carries the reply target when replying", () => {
    const row = optimisticFixture(OPT_ID, "answer", "88888888-8888-4888-8888-888888888888");
    expect(row.reply_to_message_id).toBe("88888888-8888-4888-8888-888888888888");
  });

  it("setSendStatus is id-scoped and returns the SAME array on no-ops", () => {
    const list = mergeCommunityMessages([], [optimisticFixture("a"), optimisticFixture("b")]);
    expect(list.every((m) => m.sendStatus === "sending")).toBe(true);
    const afterFail = setSendStatus(list, "b", "failed");
    expect(afterFail.find((m) => m.id === "a")?.sendStatus).toBe("sending");
    expect(afterFail.find((m) => m.id === "b")?.sendStatus).toBe("failed");
    const afterSent = setSendStatus(afterFail, "a", "sent");
    expect(afterSent.find((m) => m.id === "a")?.sendStatus).toBe("sent");
    expect(setSendStatus(afterSent, "a", "sent")).toBe(afterSent); // no re-render
    expect(setSendStatus(afterSent, "unknown", "sent")).toBe(afterSent);
  });

  it("preferIncoming: the realtime echo wins the collision (server created_at, local author kept, status → sent)", () => {
    const local = mergeCommunityMessages([], [optimisticFixture(OPT_ID, "hello")]);
    const serverRow = asLocal(
      msgFixture(OPT_ID, USER_ID, "2026-01-01T10:00:00.123Z", { message: "hello" }),
      null,
    );
    const merged = mergeCommunityMessages(local, [serverRow], { preferIncoming: true });
    expect(merged).toHaveLength(1);
    expect(merged[0].created_at).toBe("2026-01-01T10:00:00.123Z");
    expect(merged[0].author).toEqual(ME_AUTHOR);
    expect(merged[0].sendStatus).toBe("sent");
  });

  it("preferIncoming: an enriched API row's author wins over the local one", () => {
    const local = mergeCommunityMessages([], [optimisticFixture(OPT_ID, "hello")]);
    const serverRow = asLocal(
      msgFixture(OPT_ID, USER_ID, "2026-01-01T10:00:00.123Z", { message: "hello" }),
      OTHER_AUTHOR,
    );
    const merged = mergeCommunityMessages(local, [serverRow], { preferIncoming: true });
    expect(merged[0].author).toEqual(OTHER_AUTHOR);
    expect(merged[0].sendStatus).toBe("sent");
  });

  it("a 'failed' row that the server echoes becomes 'sent' (lost response, not lost message)", () => {
    let local = mergeCommunityMessages([], [optimisticFixture(OPT_ID, "hello")]);
    local = setSendStatus(local, OPT_ID, "failed");
    const serverRow = asLocal(
      msgFixture(OPT_ID, USER_ID, "2026-01-01T10:00:00.123Z", { message: "hello" }),
      null,
    );
    const merged = mergeCommunityMessages(local, [serverRow], { preferIncoming: true });
    expect(merged).toHaveLength(1);
    expect(merged[0].sendStatus).toBe("sent");
  });

  it("default merge: the existing row wins (pagination stays authoritative)", () => {
    const local = mergeCommunityMessages([], [optimisticFixture(OPT_ID, "hello")]);
    const serverRow = msgFixture(OPT_ID, USER_ID, "2026-01-01T10:00:09.000Z");
    const merged = mergeCommunityMessages(local, [serverRow]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(local[0]); // same reference — nothing replaced
  });
});

describe("optimistic send + realtime flow (two-client simulation)", () => {
  it("A's optimistic row is visible instantly; B sees it via the realtime echo — both exactly once", () => {
    let a = mergeCommunityMessages([], [optimisticFixture(OPT_ID)]);
    expect(a).toHaveLength(1);
    expect(a[0].sendStatus).toBe("sending");
    expect(a[0].message).toBe("salut");
    let b: LocalMessage[] = [];

    const echo = () =>
      asLocal(msgFixture(OPT_ID, USER_ID, "2026-01-01T10:00:00.123Z", { message: "salut" }), null);
    a = mergeCommunityMessages(a, [echo()], { preferIncoming: true });
    b = mergeCommunityMessages(b, [echo()], { preferIncoming: true });

    expect(a).toHaveLength(1);
    expect(a[0].id).toBe(OPT_ID);
    expect(a[0].sendStatus).toBe("sent");
    expect(b).toHaveLength(1);
    expect(b[0].id).toBe(OPT_ID);
    expect(b[0].message).toBe("salut");
    expect(b[0].user_id).toBe(USER_ID);

    const postResponse = asLocal(
      msgFixture(OPT_ID, USER_ID, "2026-01-01T10:00:00.123Z", { message: "salut" }),
      ME_AUTHOR,
    );
    a = mergeCommunityMessages(a, [postResponse], { preferIncoming: true });
    expect(a).toHaveLength(1);
    expect(a[0].sendStatus).toBe("sent");
  });

  it("failed → retry with the SAME id → idempotent duplicate response → sent, still once", () => {
    let a = mergeCommunityMessages([], [optimisticFixture(OPT_ID)]);
    a = setSendStatus(a, OPT_ID, "failed");
    expect(a).toHaveLength(1);
    expect(a[0].sendStatus).toBe("failed");
    expect(a[0].message).toBe("salut"); // the user's text is preserved

    const idempotentResponse = asLocal(
      msgFixture(OPT_ID, USER_ID, "2026-01-01T10:00:00.123Z", { message: "salut" }),
      null,
    );
    a = setSendStatus(a, OPT_ID, "sending"); // retry re-arms the row
    a = mergeCommunityMessages(a, [idempotentResponse], { preferIncoming: true });
    expect(a).toHaveLength(1);
    expect(a[0].sendStatus).toBe("sent");
  });
});

// ---------------------------------------------------------------------------
// Rate-limit budgets
// ---------------------------------------------------------------------------

describe("community rate-limit budgets", () => {
  it("defines dedicated per-user scopes that do not weaken existing limits", () => {
    expect(RATE_LIMITS.community_message).toEqual({ max: 20, windowSeconds: 60 });
    expect(RATE_LIMITS.community_history).toEqual({ max: 30, windowSeconds: 60 });
    // The 1s poll gets its OWN higher bucket so a 1 req/s poll (60/min, with
    // headroom for several tabs) is feasible — WITHOUT weakening the 30/min
    // "load older" budget that community_history still enforces.
    expect(RATE_LIMITS.community_poll).toEqual({ max: 240, windowSeconds: 60 });
    expect(RATE_LIMITS.community_onboarding).toEqual({ max: 5, windowSeconds: 60 });
    // v2 message-level actions.
    expect(RATE_LIMITS.community_edit).toEqual({ max: 60, windowSeconds: 60 });
    expect(RATE_LIMITS.community_react).toEqual({ max: 60, windowSeconds: 60 });
    expect(RATE_LIMITS.community_delete).toEqual({ max: 20, windowSeconds: 60 });
    // Pre-existing scopes stay intact.
    expect(RATE_LIMITS.ai_chat.max).toBe(20);
    expect(RATE_LIMITS.opportunity_search.max).toBe(10);
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
    const { calls } = mockCommunityClient({ room: ROOM });
    const res = await postForm(() => {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("empty_message");
    expect(calls).toEqual([]);
  });

  it("treats whitespace-only text as empty", async () => {
    mockAuth(USER_ID);
    mockCommunityClient({ room: ROOM });
    const res = await postForm((fd) => fd.set("message", "   "));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("empty_message");
  });

  it(`rejects text longer than ${COMMUNITY_MAX_MESSAGE_LENGTH} chars`, async () => {
    mockAuth(USER_ID);
    mockCommunityClient({ room: ROOM });
    const res = await postForm((fd) =>
      fd.set("message", "x".repeat(COMMUNITY_MAX_MESSAGE_LENGTH + 1)),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("text_too_long");
  });

  it("rejects senders without a community profile (409, onboarding required)", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({ profile: null, room: ROOM });
    const res = await postForm((fd) => fd.set("message", "hi"));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("profile_required");
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("rejects unknown rooms with 404 (no room id can be smuggled)", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({ profile: { id: "p" }, room: null });
    const res = await postForm((fd) => {
      fd.set("message", "hi");
      fd.set("room", "does-not-exist");
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("room_not_found");
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("falls back to the default room (public-chat) when no room is given", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({ profile: { id: "p" }, room: ROOM });
    const res = await postForm((fd) => fd.set("message", "hi"));
    expect(res.status).toBe(201);
    const insert = calls.find((c) => c.op === "insert");
    expect((insert?.args[0] as { room_id: string }).room_id).toBe(ROOM_ID);
  });

  it("writes to the room resolved from the client slug", async () => {
    mockAuth(USER_ID);
    const otherRoom = { ...ROOM, id: "b1000000-0000-4000-8000-000000000004", slug: "ausbildung" };
    const { calls } = mockCommunityClient({ profile: { id: "p" }, room: otherRoom });
    const res = await postForm((fd) => {
      fd.set("message", "hi");
      fd.set("room", "ausbildung");
    });
    expect(res.status).toBe(201);
    const insert = calls.find((c) => c.op === "insert");
    expect((insert?.args[0] as { room_id: string }).room_id).toBe(otherRoom.id);
  });

  it("creates a text message as the SESSION user — a user_id in the body is ignored (no impersonation)", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({
      profile: { id: "profile-row" },
      room: ROOM,
      inserted: {
        data: {
          id: "msg-1",
          user_id: USER_ID,
          room_id: ROOM_ID,
          message: "hallo",
          image_path: null,
          reply_to_message_id: null,
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

  it("stores a reply only when the parent exists in the SAME room", async () => {
    const parentId = "88888888-8888-4888-8888-888888888888";
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({
      profile: { id: "p" },
      room: ROOM,
      replyParent: { id: parentId, room_id: ROOM_ID },
    });
    const res = await postForm((fd) => {
      fd.set("message", "answer");
      fd.set("reply_to", parentId);
    });
    expect(res.status).toBe(201);
    const insert = calls.find((c) => c.op === "insert");
    expect((insert?.args[0] as { reply_to_message_id: string }).reply_to_message_id).toBe(
      parentId,
    );
  });

  it("rejects a reply whose parent lives in ANOTHER room (400)", async () => {
    const parentId = "88888888-8888-4888-8888-888888888888";
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({
      profile: { id: "p" },
      room: ROOM,
      replyParent: { id: parentId, room_id: "b1000000-0000-4000-8000-000000000004" },
    });
    const res = await postForm((fd) => {
      fd.set("message", "answer");
      fd.set("reply_to", parentId);
    });
    expect(res.status).toBe(400);
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("rejects a reply to a non-existent parent (400)", async () => {
    const parentId = "88888888-8888-4888-8888-888888888888";
    mockAuth(USER_ID);
    mockCommunityClient({
      profile: { id: "p" },
      room: ROOM,
      replyParent: null,
    });
    const res = await postForm((fd) => {
      fd.set("message", "answer");
      fd.set("reply_to", parentId);
    });
    expect(res.status).toBe(400);
  });

  it("uploads an image to the server-generated owner-isolated path (upsert disabled)", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({
      profile: { id: "profile-row" },
      room: ROOM,
    });
    const fd = new FormData();
    fd.set("image", fileFixture(pngBytes(128), "image/png", "my photo.png"));
    const res = await messagesPOST(
      new Request("http://localhost/api/community/messages", { method: "POST", body: fd }),
    );
    expect(res.status).toBe(201);
    const upload = calls.find((c) => c.op === "upload");
    expect(upload?.table).toBe("community-images");
    const [path, , opts] = upload?.args as [string, Blob, Record<string, unknown>];
    expect(path).toMatch(new RegExp(`^${USER_ID}/[0-9a-f-]{36}/image\\.png$`));
    expect(opts.upsert).toBe(false);
    expect(opts.contentType).toBe("image/png");
    const insertCall = calls.find((c) => c.op === "insert");
    expect((insertCall?.args[0] as { image_path: string }).image_path).toBe(path);
    const body = (await res.json()) as { message: { image_path: string | null } };
    expect(body.message.image_path).toBe(path);
  });

  it("rejects an oversized image (2 MB + 1) with 413 before storage", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({ profile: { id: "p" }, room: ROOM });
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
    const { calls } = mockCommunityClient({ profile: { id: "p" }, room: ROOM });
    const res = await postForm((fd) =>
      fd.set("image", fileFixture(pdfBytes(), "application/pdf", "doc.pdf")),
    );
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_image");
    expect(calls.some((c) => c.op === "upload")).toBe(false);
  });

  it("rejects MIME-spoofed uploads (PDF bytes declared as image/png) with 415", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({ profile: { id: "p" }, room: ROOM });
    const res = await postForm((fd) =>
      fd.set("image", fileFixture(pdfBytes(), "image/png", "evil.png")),
    );
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_image");
    expect(calls.some((c) => c.op === "upload")).toBe(false);
  });

  it("rejects GIF and SVG content types", async () => {
    mockAuth(USER_ID);
    mockCommunityClient({ profile: { id: "p" }, room: ROOM });
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
      room: ROOM,
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
      room: ROOM,
      inserted: { data: null, error: { message: "db down" } },
    });
    const res = await postForm((fd) => fd.set("message", "hi"));
    expect(res.status).toBe(500);
  });

  it("500s (not 200s) when the room lookup itself fails", async () => {
    mockAuth(USER_ID);
    mockCommunityClient({
      profile: { id: "p" },
      roomLookupError: { message: "connection terminated" },
    });
    const res = await postForm((fd) => fd.set("message", "hi"));
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// POST /api/community/messages — idempotency (client-supplied id)
// ---------------------------------------------------------------------------

describe("POST idempotency (client id)", () => {
  it("accepts a client UUID: the row is created with exactly that id", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({ profile: { id: "p" }, room: ROOM });
    const res = await postForm((fd) => {
      fd.set("message", "hello");
      fd.set("id", "77777777-7777-4777-8777-777777777777");
    });
    expect(res.status).toBe(201);
    const insert = calls.find((c) => c.op === "insert");
    expect((insert?.args[0] as { id: string }).id).toBe("77777777-7777-4777-8777-777777777777");
    const body = (await res.json()) as { message: { id: string } };
    expect(body.message.id).toBe("77777777-7777-4777-8777-777777777777");
  });

  it("ignores a malformed client id (path-traversal string → generated UUID)", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({ profile: { id: "p" }, room: ROOM });
    const res = await postForm((fd) => {
      fd.set("message", "hello");
      fd.set("id", "../etc/passwd");
    });
    expect(res.status).toBe(201);
    const insert = calls.find((c) => c.op === "insert");
    const id = (insert?.args[0] as { id: string }).id;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(id).not.toBe("../etc/passwd");
  });

  it("duplicate id → 200 + the existing row, and NO second insert (idempotent retry)", async () => {
    mockAuth(USER_ID);
    const existingRow = {
      id: "77777777-7777-4777-8777-777777777777",
      user_id: USER_ID,
      room_id: ROOM_ID,
      message: "hello",
      image_path: null,
      reply_to_message_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const { calls } = mockCommunityClient({
      profile: { id: "p" },
      room: ROOM,
      existing: existingRow,
    });
    const res = await postForm((fd) => {
      fd.set("message", "hello");
      fd.set("id", existingRow.id as string);
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { id: string }; duplicate: boolean };
    expect(body.duplicate).toBe(true);
    expect(body.message.id).toBe(existingRow.id);
    expect(calls.filter((c) => c.op === "insert")).toHaveLength(0);
  });

  it("another user's row id → 400, never claimable, row never echoed", async () => {
    mockAuth(USER_ID);
    const foreignRow = {
      id: "88888888-8888-4888-8888-888888888888",
      user_id: OTHER_USER_ID,
      room_id: ROOM_ID,
      message: "foreign",
      image_path: null,
      reply_to_message_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const { calls } = mockCommunityClient({
      profile: { id: "p" },
      room: ROOM,
      existing: foreignRow,
    });
    const res = await postForm((fd) => {
      fd.set("message", "x");
      fd.set("id", foreignRow.id);
    });
    expect(res.status).toBe(400);
    expect(calls.filter((c) => c.op === "insert")).toHaveLength(0);
  });

  it("23505 race (pre-check empty, insert collides) → 200 + the existing row", async () => {
    mockAuth(USER_ID);
    const racingRow = {
      id: "77777777-7777-4777-8777-777777777777",
      user_id: USER_ID,
      room_id: ROOM_ID,
      message: "hello",
      image_path: null,
      reply_to_message_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const { calls } = mockCommunityClient({
      profile: { id: "p" },
      room: ROOM,
      existing: null, // not visible at the pre-check…
      existingAfterInsert: racingRow, // …but visible when the insert collides
      inserted: { data: null, error: { message: "duplicate key value", code: "23505" } },
    });
    const res = await postForm((fd) => {
      fd.set("message", "hello");
      fd.set("id", racingRow.id as string);
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { id: string }; duplicate: boolean };
    expect(body.duplicate).toBe(true);
    expect(body.message.id).toBe(racingRow.id);
    expect(calls.filter((c) => c.op === "insert")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET /api/community/messages (room-scoped page)
// ---------------------------------------------------------------------------

describe("GET /api/community/messages", () => {
  it("rejects unauthenticated requests with 401 (no DB access)", async () => {
    mockAuth(null);
    const { calls } = mockCommunityClient();
    const res = await messagesGET(new Request("http://localhost/api/community/messages"));
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("returns 429 for a rate-limited user before fetching messages", async () => {
    mockAuth(USER_ID);
    denyRateLimits("community_history");
    const res = await messagesGET(new Request("http://localhost/api/community/messages"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
  });

  it("only ?poll=1 uses the dedicated community_poll bucket (same auth + RLS path)", () => {
    const routeSrc = readFileSync(
      resolve(
        fileURLToPath(new URL("..", import.meta.url)),
        "src/app/api/community/messages/route.ts",
      ),
      "utf8",
    );
    // The poll flag is the ONLY thing that switches buckets…
    expect(routeSrc).toContain('url.searchParams.get("poll") === "1"');
    expect(routeSrc).toContain('isPoll ? "community_poll" : "community_history"');
    // …and auth is asserted FIRST (before any bucket / DB work) — a poll can
    // never bypass the session check, and RLS still scopes the room page.
    expect(routeSrc).toContain('const { user } = await getCurrentUserAndProfile();');
    expect(routeSrc.indexOf('if (!user)') < routeSrc.indexOf("isPoll")).toBe(true);
    expect(routeSrc).toContain("fetchRoomMessagePage(supabase, room.id, user.id,");
  });

  it("returns the room page ascending, enriched with authors/reactions/replies", async () => {
    mockAuth(USER_ID);
    allowRateLimits(30);
    const parentId = "88888888-8888-4888-8888-888888888888";
    mockCommunityClient({
      room: ROOM,
      messages: [
        msgFixture("m2", OTHER_USER_ID, "2026-01-02T10:00:00.000Z", {
          message: "reply",
          reply_to_message_id: parentId,
        }),
        msgFixture(parentId, OTHER_USER_ID, "2026-01-02T09:00:00.000Z", {
          message: "question",
        }),
        msgFixture("m1", USER_ID, "2026-01-01T09:00:00.000Z"),
      ],
      profiles: [
        {
          user_id: OTHER_USER_ID,
          display_name: "Lena",
          avatar_id: "avatar-2",
        },
      ],
      reactions: [
        { message_id: "m1", emoji: "👍", user_id: OTHER_USER_ID },
      ],
    });
    const res = await messagesGET(
      new Request(`http://localhost/api/community/messages?room=public-chat`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-limit")).toBe("30");
    const body = (await res.json()) as {
      room: CommunityRoom;
      items: Array<{
        id: string;
        room_id: string;
        author: { display_name: string; avatar_id: string } | null;
        reactions: Array<{ emoji: string; count: number; mine: boolean }>;
        replyTo: { id: string } | null;
      }>;
    };
    expect(body.room).toEqual(ROOM);
    // Ascending order despite newest-first DB fetch.
    expect(body.items.map((m) => m.id)).toEqual(["m1", parentId, "m2"]);
    expect(body.items.every((m) => m.room_id === ROOM_ID)).toBe(true);
    expect(body.items[0].author).toBeNull();
    expect(body.items[0].reactions).toEqual([
      { emoji: "👍", count: 1, mine: false },
    ]);
    // v2 authors carry the full identity row (user_id included).
    expect(body.items[1].author).toEqual({
      user_id: OTHER_USER_ID,
      display_name: "Lena",
      avatar_id: "avatar-2",
    });
    // The reply preview carries the parent's trimmed data + author.
    expect(body.items[2].replyTo).toMatchObject({
      id: parentId,
      message: "question",
      author: { display_name: "Lena" },
    });
  });

  it("queries the room and filters messages by room_id", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({ room: ROOM });
    await messagesGET(
      new Request("http://localhost/api/community/messages?room=public-chat"),
    );
    expect(
      calls.find((c) => c.table === "community_rooms" && c.op === "eq")?.args,
    ).toEqual(["slug", "public-chat"]);
    expect(
      calls.find((c) => c.table === "community_messages" && c.op === "eq")?.args,
    ).toEqual(["room_id", ROOM_ID]);
  });

  it("supports before_at pagination (lt filter) and rejects invalid cursors", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({ room: ROOM });
    const bad = await messagesGET(
      new Request(
        "http://localhost/api/community/messages?room=public-chat&before_at=not-a-date",
      ),
    );
    expect(bad.status).toBe(400);

    const cursor = "2026-01-03T00:00:00.000Z";
    const ok = await messagesGET(
      new Request(
        `http://localhost/api/community/messages?room=public-chat&before_at=${encodeURIComponent(cursor)}`,
      ),
    );
    expect(ok.status).toBe(200);
    const ltCall = calls.find(
      (c) => c.table === "community_messages" && c.op === "lt",
    );
    expect(ltCall?.args).toEqual(["created_at", cursor]);
  });

  it("returns 404 for unknown rooms and 500 when the room read fails", async () => {
    mockAuth(USER_ID);
    mockCommunityClient({ room: null });
    const missing = await messagesGET(
      new Request("http://localhost/api/community/messages?room=nope"),
    );
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("room_not_found");

    mockCommunityClient({ roomLookupError: { message: "connection terminated" } });
    const broken = await messagesGET(
      new Request("http://localhost/api/community/messages?room=public-chat"),
    );
    expect(broken.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// GET /api/community/rooms (directory)
// ---------------------------------------------------------------------------

describe("GET /api/community/rooms", () => {
  const CATEGORY = { id: "cat-1", slug: "allgemein", name: "ALLGEMEIN", position: 1 };

  it("rejects unauthenticated requests with 401", async () => {
    mockAuth(null);
    const res = await roomsGET();
    expect(res.status).toBe(401);
  });

  it("returns 429 for a rate-limited user", async () => {
    mockAuth(USER_ID);
    denyRateLimits("community_history");
    const res = await roomsGET();
    expect(res.status).toBe(429);
  });

  it("groups enabled rooms by category in position order", async () => {
    mockAuth(USER_ID);
    mockCommunityClient({
      categories: [CATEGORY],
      rooms: [
        {
          ...ROOM,
          id: "b1000000-0000-4000-8000-000000000002",
          slug: "fragen-und-antworten",
          name: "Fragen & Antworten",
          category_id: "cat-1",
          position: 2,
        },
        { ...ROOM, category_id: "cat-1", position: 1 },
      ],
    });
    const res = await roomsGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      categories: Array<{ id: string; rooms: Array<{ slug: string }> }>;
    };
    expect(body.categories).toHaveLength(1);
    expect(body.categories[0].id).toBe("cat-1");
    expect(body.categories[0].rooms.map((r) => r.slug)).toEqual([
      "public-chat",
      "fragen-und-antworten",
    ]);
  });

  it("returns 500 when the directory cannot be read", async () => {
    mockAuth(USER_ID);
    mockCommunityClient({ roomError: { message: "connection terminated" } });
    const res = await roomsGET();
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// GET /api/community/members (identity only)
// ---------------------------------------------------------------------------

describe("GET /api/community/members", () => {
  it("rejects unauthenticated requests with 401", async () => {
    mockAuth(null);
    const res = await membersGET();
    expect(res.status).toBe(401);
  });

  it("returns identity-only rows (no email or other profile fields)", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({
      profiles: [
        { user_id: USER_ID, display_name: "Taha", avatar_id: "avatar-1", last_seen_at: null },
        { user_id: OTHER_USER_ID, display_name: "Lena", avatar_id: "avatar-2", last_seen_at: null },
      ],
    });
    const res = await membersGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(2);
    // Phase 3: identity + the privacy-mapped presence (no last-seen here —
    // never email or any account field).
    expect(body.items[0]).toEqual({
      user_id: USER_ID,
      display_name: "Taha",
      avatar_id: "avatar-1",
      presence: "offline",
      last_seen_at: null,
    });
    expect(body.items[1].presence).toBe("offline");
    // The SELECT clause is the contract: exactly identity + presence columns.
    const selectCall = calls.find(
      (c) => c.table === "community_profiles" && c.op === "select",
    );
    expect(selectCall?.args[0]).toBe(
      "user_id,display_name,avatar_id,last_seen_at,presence_mode,show_presence",
    );
    // Bounded page (the members list is chrome, not a data dump).
    const limitCall = calls.find(
      (c) => c.table === "community_profiles" && c.op === "limit",
    );
    expect(limitCall?.args[0]).toBe(300);
  });

  it("returns 500 when the member read fails", async () => {
    mockAuth(USER_ID);
    vi.mocked(createClient).mockResolvedValue({
      from: () => {
        throw new Error("connection terminated");
      },
    } as never);
    const res = await membersGET();
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// POST /api/community/messages/:id/reactions (toggle)
// ---------------------------------------------------------------------------

function reactionsRequest(emoji: unknown, id = "77777777-7777-4777-8777-777777777777") {
  return reactionsPOST(
    new Request(`http://localhost/api/community/messages/${id}/reactions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emoji }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("POST reactions (toggle)", () => {
  it("rejects unauthenticated requests with 401", async () => {
    mockAuth(null);
    const res = await reactionsRequest("👍");
    expect(res.status).toBe(401);
  });

  it("returns 429 for a rate-limited user", async () => {
    mockAuth(USER_ID);
    denyRateLimits("community_react");
    const res = await reactionsRequest("👍");
    expect(res.status).toBe(429);
  });

  it("rejects non-UUID ids and emojis outside the fixed set", async () => {
    mockAuth(USER_ID);
    mockCommunityClient({ messageRow: { id: "x" } });
    const badId = await reactionsRequest("👍", "../../etc/passwd");
    expect(badId.status).toBe(400);
    const badEmoji = await reactionsRequest("🎉");
    expect(badEmoji.status).toBe(400);
    expect(((await badEmoji.json()) as { error: string }).error).toBe(
      "reaction_invalid",
    );
  });

  it("404s when the message does not exist", async () => {
    mockAuth(USER_ID);
    mockCommunityClient({ messageRow: null });
    const res = await reactionsRequest("👍");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("message_not_found");
  });

  it("INSERTs the viewer's own row when absent (user_id from the session)", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({
      messageRow: { id: "77777777-7777-4777-8777-777777777777" },
      myReaction: null,
      reactions: [{ message_id: "77777777-7777-4777-8777-777777777777", emoji: "👍", user_id: USER_ID }],
    });
    const res = await reactionsRequest("👍");
    expect(res.status).toBe(200);
    const insert = calls.find(
      (c) => c.table === "community_message_reactions" && c.op === "insert",
    );
    expect(insert?.args[0]).toEqual({
      message_id: "77777777-7777-4777-8777-777777777777",
      user_id: USER_ID,
      emoji: "👍",
    });
    const body = (await res.json()) as {
      reactions: Array<{ emoji: string; count: number; mine: boolean }>;
    };
    expect(body.reactions).toEqual([{ emoji: "👍", count: 1, mine: true }]);
    // …and it does NOT delete on the add path.
    expect(
      calls.some((c) => c.table === "community_message_reactions" && c.op === "delete"),
    ).toBe(false);
  });

  it("DELETEs the viewer's own row when present (toggle off)", async () => {
    mockAuth(USER_ID);
    const { calls } = mockCommunityClient({
      messageRow: { id: "77777777-7777-4777-8777-777777777777" },
      myReaction: { emoji: "👍" },
      reactions: [], // the list AFTER removal
    });
    const res = await reactionsRequest("👍");
    expect(res.status).toBe(200);
    const del = calls.find(
      (c) => c.table === "community_message_reactions" && c.op === "delete",
    );
    expect(del).toBeDefined();
    expect(
      calls.some(
        (c) => c.table === "community_message_reactions" && c.op === "insert",
      ),
    ).toBe(false);
    const body = (await res.json()) as { reactions: unknown[] };
    expect(body.reactions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PATCH / DELETE /api/community/messages/:id (own rows only)
// ---------------------------------------------------------------------------

function patchMessage(text: string, id = "77777777-7777-4777-8777-777777777777") {
  return messagePATCH(
    new Request(`http://localhost/api/community/messages/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function deleteMessage(id = "77777777-7777-4777-8777-777777777777") {
  return messageDELETE(
    new Request(`http://localhost/api/community/messages/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) },
  );
}

describe("PATCH message (own rows only)", () => {
  it("rejects unauthenticated requests with 401", async () => {
    mockAuth(null);
    const res = await patchMessage("x");
    expect(res.status).toBe(401);
  });

  it("returns 429 for a rate-limited user", async () => {
    mockAuth(USER_ID);
    denyRateLimits("community_edit");
    const res = await patchMessage("x");
    expect(res.status).toBe(429);
  });

  it("rejects non-UUID ids and empty/overlong text", async () => {
    mockAuth(USER_ID);
    mockCommunityClient({ existing: null });
    const badId = await patchMessage("x", "../../etc/passwd");
    expect(badId.status).toBe(400);
    const empty = await patchMessage("   ");
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toBe("empty_message");
    const long = await patchMessage("x".repeat(COMMUNITY_MAX_MESSAGE_LENGTH + 1));
    expect(long.status).toBe(400);
    expect(((await long.json()) as { error: string }).error).toBe("text_too_long");
  });

  it("404s when the row is not the caller's (RLS hides it)", async () => {
    mockAuth(USER_ID);
    mockCommunityClient({ existing: null });
    const res = await patchMessage("x");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("message_not_found");
  });

  it("updates the text and echoes the row (scoped to id + user_id)", async () => {
    mockAuth(USER_ID);
    const updated = msgFixture("77777777-7777-4777-8777-777777777777", USER_ID,
      "2026-01-01T00:00:00.000Z", { message: "new text" });
    const { calls } = mockCommunityClient({ existing: updated });
    const res = await patchMessage("new text");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { message: string } };
    expect(body.message.message).toBe("new text");
    expect(calls.find((c) => c.op === "update")?.args[0]).toEqual({
      message: "new text",
    });
    const eqs = calls
      .filter((c) => c.table === "community_messages" && c.op === "eq")
      .map((c) => c.args as string[]);
    // (toEqual + arrayContaining: toContain compares nested arrays by identity.)
    expect(eqs).toEqual(
      expect.arrayContaining([
        ["id", "77777777-7777-4777-8777-777777777777"],
        ["user_id", USER_ID],
      ]),
    );
  });
});

describe("DELETE message (own rows only)", () => {
  it("rejects unauthenticated requests with 401", async () => {
    mockAuth(null);
    const res = await deleteMessage();
    expect(res.status).toBe(401);
  });

  it("returns 429 for a rate-limited user", async () => {
    mockAuth(USER_ID);
    denyRateLimits("community_delete");
    const res = await deleteMessage();
    expect(res.status).toBe(429);
  });

  it("404s when the row is not the caller's", async () => {
    mockAuth(USER_ID);
    mockCommunityClient({ existing: null });
    const res = await deleteMessage();
    expect(res.status).toBe(404);
  });

  it("deletes the row and cleans up its uploaded image (owner folder)", async () => {
    mockAuth(USER_ID);
    const existing = msgFixture("77777777-7777-4777-8777-777777777777", USER_ID,
      "2026-01-01T00:00:00.000Z", {
        image_path: `${USER_ID}/77777777-7777-4777-8777-777777777777/image.png`,
      });
    const { calls } = mockCommunityClient({ existing });
    const res = await deleteMessage();
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.table === "community_messages" && c.op === "delete")).toBe(true);
    const remove = calls.find((c) => c.op === "remove");
    expect(remove?.table).toBe("community-images");
    expect(remove?.args[0]).toEqual([existing.image_path]);
  });

  it("succeeds even when the image cleanup fails (best effort)", async () => {
    mockAuth(USER_ID);
    const existing = msgFixture("77777777-7777-4777-8777-777777777777", USER_ID,
      "2026-01-01T00:00:00.000Z", {
        image_path: `${USER_ID}/77777777-7777-4777-8777-777777777777/image.png`,
      });
    vi.mocked(createClient).mockResolvedValue({
      from: (table: string) => {
        const base: Record<string, unknown> = {
          select: () => base,
          eq: () => base,
          delete: () => base,
        };
        base.maybeSingle = async () =>
          table === "community_messages"
            ? { data: existing, error: null }
            : { data: null, error: null };
        base.then = (onF?: unknown, onR?: unknown) =>
          Promise.resolve({ data: null, error: null }).then(onF as never, onR as never);
        return base;
      },
      storage: {
        from: () => ({
          remove: async () => {
            throw new Error("storage down");
          },
        }),
      },
    } as never);
    const res = await deleteMessage();
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Per-room unread (SQL summary via admin rpc)
// ---------------------------------------------------------------------------

describe("fetchRoomUnreadMap / getCommunityUnreadCount", () => {
  it("maps only rooms with unread > 0", async () => {
    const A = "b1000000-0000-4000-8000-000000000001";
    const B = "b1000000-0000-4000-8000-000000000002";
    const C = "b1000000-0000-4000-8000-000000000003";
    mockAdmin({
      unread: [
        { room_id: A, unread: 3 },
        { room_id: B, unread: 0 },
        { room_id: C, unread: 5 },
      ],
    });
    expect(await fetchRoomUnreadMap(USER_ID)).toEqual({ [A]: 3, [C]: 5 });
  });

  it("sums the room map for the nav badge", async () => {
    mockAdmin({
      unread: [
        { room_id: "b1000000-0000-4000-8000-000000000001", unread: 3 },
        { room_id: "b1000000-0000-4000-8000-000000000002", unread: 5 },
      ],
    });
    await expect(getCommunityUnreadCount(USER_ID)).resolves.toBe(8);
  });

  it("degrades to 0 / {} on any failure — the badge must never break a render", async () => {
    mockAdmin({ rpcError: { message: "db down" } });
    expect(await fetchRoomUnreadMap(USER_ID)).toEqual({});
    await expect(getCommunityUnreadCount(USER_ID)).resolves.toBe(0);

    vi.mocked(createAdminClient).mockReturnValue({
      rpc: () => {
        throw new Error("boom");
      },
    } as never);
    expect(await fetchRoomUnreadMap(USER_ID)).toEqual({});
    await expect(getCommunityUnreadCount(USER_ID)).resolves.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Server actions
// ---------------------------------------------------------------------------

describe("completeOnboarding (server action)", () => {
  it("fails with generic when there is no session user", async () => {
    mockActionClient({ userId: null });
    await expect(
      completeOnboarding({ displayName: "SilverFox", avatarId: "avatar-1" }),
    ).resolves.toEqual({ ok: false, code: "generic" });
  });

  it("maps validation errors to stable codes (username format / avatar)", async () => {
    mockActionClient({ userId: USER_ID });
    await expect(
      completeOnboarding({ displayName: "  ", avatarId: "avatar-1" }),
    ).resolves.toEqual({ ok: false, code: "username_invalid" });
    await expect(
      completeOnboarding({
        displayName: "Anna Marie",
        avatarId: "avatar-1",
      }),
    ).resolves.toEqual({ ok: false, code: "username_invalid" });
    await expect(
      completeOnboarding({
        displayName: "a".repeat(COMMUNITY_MAX_USERNAME_LENGTH + 1),
        avatarId: "avatar-1",
      }),
    ).resolves.toEqual({ ok: false, code: "username_invalid" });
    await expect(
      completeOnboarding({ displayName: "SilverFox", avatarId: "avatar-5" }),
    ).resolves.toEqual({ ok: false, code: "avatar_invalid" });
  });

  it("returns rate_limited and never upserts when limited", async () => {
    denyRateLimits("community_onboarding");
    const { upserts } = mockActionClient({ userId: USER_ID });
    await expect(
      completeOnboarding({ displayName: "SilverFox", avatarId: "avatar-1" }),
    ).resolves.toEqual({ ok: false, code: "rate_limited" });
    expect(upserts).toEqual([]);
  });

  it("upserts the session user's own profile (trimmed name) and revalidates /community", async () => {
    allowRateLimits(5);
    const { upserts } = mockActionClient({ userId: USER_ID });
    await expect(
      completeOnboarding({ displayName: "  SilverFox  ", avatarId: "avatar-4" }),
    ).resolves.toEqual({ ok: true });
    expect(upserts).toEqual([
      {
        table: "community_profiles",
        payload: {
          user_id: USER_ID,
          display_name: "SilverFox",
          avatar_id: "avatar-4",
        },
      },
    ]);
    expect(revalidatePath).toHaveBeenCalledWith("/community");
  });

  it("maps a uniqueness race (23505) to username_taken — the UI regenerates", async () => {
    allowRateLimits(5);
    mockActionClient({
      userId: USER_ID,
      upsertError: { message: "duplicate key value violates unique constraint", code: "23505" },
    });
    await expect(
      completeOnboarding({ displayName: "SilverFox", avatarId: "avatar-1" }),
    ).resolves.toEqual({ ok: false, code: "username_taken" });
  });

  it("returns generic when the upsert fails for other reasons", async () => {
    mockActionClient({ userId: USER_ID, upsertError: { message: "rls denied" } });
    await expect(
      completeOnboarding({ displayName: "SilverFox", avatarId: "avatar-1" }),
    ).resolves.toEqual({ ok: false, code: "generic" });
  });
});

describe("generateCommunityUsernameAction", () => {
  it("returns a plausible username when the candidate is free", async () => {
    mockActionClient({ userId: USER_ID });
    const res = await generateCommunityUsernameAction();
    expect(res.ok).toBe(true);
    if (res.ok && res.username) {
      expect(isPlausibleCommunityUsername(res.username)).toBe(true);
    }
  });

  it("returns not-ok without a session user", async () => {
    mockActionClient({ userId: null });
    await expect(generateCommunityUsernameAction()).resolves.toEqual({ ok: false });
  });

  it("retries on taken candidates and gives up after 5 attempts", async () => {
    const attempts: string[] = [];
    mockActionClient({
      userId: USER_ID,
      candidatesData: (candidate) => {
        attempts.push(candidate);
        return [{ user_id: "someone-else" }]; // always taken
      },
    });
    const res = await generateCommunityUsernameAction();
    expect(res).toEqual({ ok: false });
    expect(attempts).toHaveLength(5);
    expect(new Set(attempts).size).toBeGreaterThan(1); // real retries, not one value
  });

  it("survives a read hiccup (tries the next candidate)", async () => {
    let reads = 0;
    mockActionClient({
      userId: USER_ID,
      candidatesData: () => {
        reads += 1;
        if (reads === 1) throw new Error("connection terminated");
        return [];
      },
    });
    const res = await generateCommunityUsernameAction();
    expect(res.ok).toBe(true);
  });
});

describe("updateCommunityIdentity (server action)", () => {
  it("rejects an invalid username without touching Supabase", async () => {
    const { updates } = mockActionClient({ userId: USER_ID });
    await expect(
      updateCommunityIdentity({ displayName: "bad name!" }),
    ).resolves.toEqual({ ok: false, code: "username_invalid" });
    expect(updates).toEqual([]);
  });

  it("rejects an invalid avatar without touching Supabase", async () => {
    const { updates } = mockActionClient({ userId: USER_ID });
    await expect(updateCommunityIdentity({ avatarId: "avatar-9" })).resolves.toEqual({
      ok: false,
      code: "avatar_invalid",
    });
    expect(updates).toEqual([]);
  });

  it("rejects an empty edit (at least one field required)", async () => {
    mockActionClient({ userId: USER_ID });
    await expect(updateCommunityIdentity({})).resolves.toEqual({
      ok: false,
      code: "username_invalid",
    });
  });

  it("updates only the provided fields (name OR avatar)", async () => {
    const { updates } = mockActionClient({ userId: USER_ID });
    await expect(
      updateCommunityIdentity({ displayName: "GoldenOwl" }),
    ).resolves.toEqual({ ok: true });
    expect(updates).toEqual([
      { table: "community_profiles", payload: { display_name: "GoldenOwl" } },
    ]);

    updates.length = 0;
    await expect(
      updateCommunityIdentity({ avatarId: "avatar-2" }),
    ).resolves.toEqual({ ok: true });
    expect(updates).toEqual([
      { table: "community_profiles", payload: { avatar_id: "avatar-2" } },
    ]);
  });

  it("maps 23505 to username_taken on rename", async () => {
    mockActionClient({
      userId: USER_ID,
      updateError: { message: "duplicate key", code: "23505" },
    });
    await expect(
      updateCommunityIdentity({ displayName: "SilverFox" }),
    ).resolves.toEqual({ ok: false, code: "username_taken" });
  });

  it("returns rate_limited when limited and never writes", async () => {
    denyRateLimits("community_onboarding");
    const { updates } = mockActionClient({ userId: USER_ID });
    await expect(
      updateCommunityIdentity({ displayName: "GoldenOwl" }),
    ).resolves.toEqual({ ok: false, code: "rate_limited" });
    expect(updates).toEqual([]);
  });
});

describe("markRoomRead (server action)", () => {
  it("ignores non-UUID input without touching Supabase", async () => {
    mockActionClient({ userId: USER_ID });
    await markRoomRead("../../etc/passwd");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("upserts the session user's per-room read cursor (server-stamped time)", async () => {
    const { upserts } = mockActionClient({ userId: USER_ID });
    await markRoomRead(ROOM_ID);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].table).toBe("community_room_read_state");
    expect(upserts[0].payload).toMatchObject({
      user_id: USER_ID,
      room_id: ROOM_ID,
    });
    const stamp = new Date(upserts[0].payload.last_read_at as string);
    expect(Number.isNaN(stamp.getTime())).toBe(false);
    expect(Math.abs(stamp.getTime() - Date.now())).toBeLessThan(5000);
  });

  it("does nothing without a session user", async () => {
    const { upserts } = mockActionClient({ userId: null });
    await markRoomRead(ROOM_ID);
    expect(upserts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// XSS / rendering discipline (source-level guard)
// ---------------------------------------------------------------------------

describe("rendering security (source guard)", () => {
  const files = [
    "src/components/community/room-chat.tsx",
    "src/components/community/community-shell.tsx",
    "src/components/community/community-home.tsx",
    "src/components/community/composer.tsx",
    "src/components/community/message-row.tsx",
    "src/components/community/mention-text.tsx",
    "src/components/community/room-nav.tsx",
    "src/components/community/members-panel.tsx",
    "src/components/community/identity-dialog.tsx",
    "src/components/community-onboarding.tsx",
  ].map(readSrc);

  it("never injects raw HTML in any community UI", () => {
    for (const src of files) {
      expect(src).not.toContain("dangerouslySetInnerHTML");
    }
  });

  it("renders message text as plain text with safe wrapping (memoized row)", () => {
    const rowSrc = readSrc("src/components/community/message-row.tsx");
    expect(rowSrc).toContain("whitespace-pre-wrap");
    expect(rowSrc).toContain("break-words");
    expect(rowSrc).toContain("memo(");
  });

  it("links open in a new tab only with rel=noopener noreferrer", () => {
    const mentionSrc = readSrc("src/components/community/mention-text.tsx");
    expect(mentionSrc).toContain('rel="noopener noreferrer"');
    expect(mentionSrc).toContain('target="_blank"');
  });
});

// ---------------------------------------------------------------------------
// Migration guards (v1 kept intact + v2 additive)
// ---------------------------------------------------------------------------

describe("community migration guards (v1, untouched)", () => {
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

  it("storage: private bucket, 2 MB cap, jpeg/png/webp only, owner-folder writes, no overwrite", () => {
    expect(sql).toMatch(
      /values \('community-images', 'community-images', false, 2097152, array\['image\/jpeg', 'image\/png', 'image\/webp'\]\)/,
    );
    expect(sql).toMatch(
      /on storage\.objects for select to authenticated\s+using \(bucket_id = 'community-images'\)/i,
    );
    expect(sql).toMatch(
      /\(storage\.foldername\(name\)\)\[1\] = auth\.uid\(\)::text/,
    );
  });
});

describe("community migration guards (v2)", () => {
  const sql = readSrc("supabase/migrations/20261027000000_community_v2.sql");

  it("seeds the five categories + 21 rooms with deterministic UUIDs", () => {
    for (const slug of [
      "allgemein",
      "ausbildung-und-arbeit",
      "deutschland",
      "studium",
      "deutsch-und-pruefungen",
    ]) {
      expect(sql).toContain(`'${slug}'`);
    }
    // 21 room rows, each with a b1000000-… id (the 22nd b1000000-… literal in
    // the file is the room_id DEFAULT for legacy messages — asserted below).
    expect((sql.match(/\('b1000000-/g) ?? []).length).toBe(21);
    expect(sql).toContain(
      "default 'b1000000-0000-4000-8000-000000000001'",
    );
    for (const slug of [
      "public-chat",
      "fragen-und-antworten",
      "probleme",
      "ausbildung",
      "arbeit",
      "praktikum",
      "kuendigung",
      "bewerbungsunterlagen",
      "marokkaner-in-deutschland",
      "konsulat",
      "anerkennung-von-abschluessen",
      "visa",
      "studium",
      "a1",
      "a2",
      "b1",
      "b2",
      "goethe",
      "oesd",
      "telc",
      "ecl",
    ]) {
      expect(sql).toContain(`'${slug}'`);
    }
  });

  it("members see only ENABLED rooms", () => {
    expect(sql).toMatch(
      /on public\.community_rooms for select\s+to authenticated\s+using \(enabled = true\)/i,
    );
  });

  it("every message belongs to a room (default: #public-chat for legacy rows)", () => {
    expect(sql).toMatch(
      /add column room_id uuid not null\s+default 'b1000000-0000-4000-8000-000000000001'\s+references public\.community_rooms\(id\) on delete cascade/i,
    );
    expect(sql).toMatch(
      /create index community_messages_room_idx\s+on public\.community_messages \(room_id, created_at desc\)/i,
    );
  });

  it("replies survive the parent's deletion (on delete set null)", () => {
    expect(sql).toMatch(
      /add column reply_to_message_id uuid\s+references public\.community_messages\(id\) on delete set null/i,
    );
  });

  it("messages become editable/deletable BY THE AUTHOR ONLY (RLS)", () => {
    expect(sql).toMatch(
      /on public\.community_messages for update\s+to authenticated\s+using \(user_id = auth\.uid\(\)\)\s+with check \(user_id = auth\.uid\(\)\)/i,
    );
    expect(sql).toMatch(
      /on public\.community_messages for delete\s+to authenticated\s+using \(user_id = auth\.uid\(\)\)/i,
    );
  });

  it("reactions: fixed emoji set, PK (message,user,emoji), own-row writes only", () => {
    expect(sql).toMatch(
      /emoji text not null check \(emoji in \('👍', '❤️', '😂', '😮', '😢', '🔥', '✅'\)\)/,
    );
    expect(sql).toMatch(/primary key \(message_id, user_id, emoji\)/);
    expect(sql).toMatch(
      /on public\.community_message_reactions for select\s+to authenticated\s+using \(true\)/i,
    );
    expect(sql).toMatch(
      /on public\.community_message_reactions for insert\s+to authenticated\s+with check \(user_id = auth\.uid\(\)\)/i,
    );
    expect(sql).toMatch(
      /on public\.community_message_reactions for delete\s+to authenticated\s+using \(user_id = auth\.uid\(\)\)/i,
    );
    // Members can never UPDATE a reaction row (toggle = delete + insert).
    expect(sql).not.toMatch(
      /on public\.community_message_reactions for update/i,
    );
  });

  it("mentions: members can only READ that they were mentioned (no write policy)", () => {
    expect(sql).toMatch(
      /on public\.community_message_mentions for select\s+to authenticated\s+using \(user_id = auth\.uid\(\)\)/i,
    );
    expect(sql).not.toMatch(
      /on public\.community_message_mentions for (insert|update|delete|all)/i,
    );
  });

  it("per-room read state: own row only + the unread summary fn is member/service-role scoped", () => {
    expect(sql).toMatch(
      /on public\.community_room_read_state for all\s+to authenticated\s+using \(auth\.uid\(\) = user_id\)\s+with check \(auth\.uid\(\) = user_id\)/i,
    );
    expect(sql).toMatch(/create or replace function public\.community_room_unread_summary\(p_user uuid\)/i);
    expect(sql).toMatch(
      /revoke execute on function public\.community_room_unread_summary\(uuid\) from public, anon/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.community_room_unread_summary\(uuid\) to authenticated, service_role/i,
    );
  });

  it("identity: legacy avatar-5 remapped, avatar set tightened to four, names unique (case-insensitive)", () => {
    expect(sql).toMatch(
      /update public\.community_profiles\s+set avatar_id = 'avatar-1'\s+where avatar_id = 'avatar-5'/i,
    );
    expect(sql).toMatch(
      /add constraint community_profiles_avatar_id\s+check \(avatar_id in \('avatar-1', 'avatar-2', 'avatar-3', 'avatar-4'\)\)/i,
    );
    expect(sql).toMatch(
      /create unique index community_profiles_username_uq\s+on public\.community_profiles \(lower\(display_name\)\)/i,
    );
    // Duplicates are de-conflicted BEFORE the unique index exists.
    const deconflictIdx = sql.indexOf("left(display_name, 27)");
    const uniqueIdx = sql.indexOf("community_profiles_username_uq");
    expect(deconflictIdx).toBeGreaterThan(-1);
    expect(deconflictIdx).toBeLessThan(uniqueIdx);
  });

  it("storage: members may delete their OWN community images (owner folder)", () => {
    expect(sql).toMatch(
      /create policy "Members can delete their own community images"\s+on storage\.objects for delete\s+to authenticated\s+using \(bucket_id = 'community-images'\s+and \(storage\.foldername\(name\)\)\[1\] = auth\.uid\(\)::text\)/i,
    );
  });

  it("enables RLS on every new table", () => {
    expect((sql.match(/enable row level security/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// i18n — every Community key must resolve in all four languages
// ---------------------------------------------------------------------------

describe("community i18n parity", () => {
  const communityKeys = [
    // identity / onboarding
    "onboardingTitle",
    "onboardingHint",
    "identityTitle",
    "identitySubtitle",
    "nameLabel",
    "namePlaceholder",
    "nameHelp",
    "generateAnother",
    "usernameRegenerating",
    "usernameTaken",
    "usernameInvalid",
    "chooseAvatar",
    "complete",
    "avatarAlt",
    "nameRequired",
    "nameTooLong",
    "avatarInvalid",
    "onboardingFailed",
    "rateLimited",
    // rooms & home
    "homeTitle",
    "homeSubtitle",
    "homeRoomsTitle",
    "homeActivityTitle",
    "homeActivityEmpty",
    "roomMessageCount",
    "roomCount",
    "roomNotFoundTitle",
    "roomNotFoundText",
    "backToCommunity",
    "membersTitle",
    "membersEmpty",
    "openRoomList",
    "closeRoomList",
    "roomIntro",
    // message view + actions
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
    "historyUnavailable",
    "historyUnavailableRetry",
    "newMessages",
    "newMessagesCount",
    "membersCount",
    "retry",
    "notSent",
    "sending",
    "viewImage",
    "closeImage",
    "typingOne",
    "typingTwo",
    "typingMany",
    "unreadBadge",
    "replyToLabel",
    "replyToSelfLabel",
    "replyPlaceholder",
    "cancelReply",
    "editMessage",
    "deleteMessage",
    "editedLabel",
    "saveEdit",
    "cancelEdit",
    "addReaction",
    "reactionAria",
    "confirmDeleteTitle",
    "confirmDeleteText",
    "confirmDeleteAction",
    "mentionNotFound",
    "editIdentity",
    // v2 errors
    "roomNotFound",
    "reactionInvalid",
    "messageNotFound",
    "notAllowed",
  ];

  const roomSlugs = [
    "public-chat",
    "fragen-und-antworten",
    "probleme",
    "ausbildung",
    "arbeit",
    "praktikum",
    "kuendigung",
    "bewerbungsunterlagen",
    "marokkaner-in-deutschland",
    "konsulat",
    "anerkennung-von-abschluessen",
    "visa",
    "studium",
    "a1",
    "a2",
    "b1",
    "b2",
    "goethe",
    "oesd",
    "telc",
    "ecl",
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

  it("translates all 21 room descriptions in every language (room NAMES stay German)", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const dict = dictionaries[lang];
      for (const slug of roomSlugs) {
        expect(
          lookup(dict, `community.roomDescriptions.${slug}`),
          `${lang}:roomDescriptions.${slug}`,
        ).toBeTruthy();
      }
    }
  });

  it("the empty-state copy matches the product copy in English", () => {
    const en = dictionaries.en;
    expect(lookup(en, "community.emptyTitle")).toBe("Welcome to the Community");
    expect(lookup(en, "community.emptyText")).toBe(
      "Connect with other AusbildungsWeg members, share experiences and help each other.",
    );
    expect(lookup(en, "community.emptyCta")).toBe("Be the first to send a message.");
  });
});

// ---------------------------------------------------------------------------
// Realtime typing indicator (ephemeral presence — in-memory only)
// ---------------------------------------------------------------------------

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
    expect(parsed?.displayName).toBe("x".repeat(40));
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
    expect(selectActiveTypers(state, TYPING_TTL_MS + 1000)).toHaveLength(1);
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
    sender.onInput(true);
    expect(events).toEqual(["typing_start"]);
    for (let i = 0; i < 25; i++) sender.onInput(true);
    expect(events).toEqual(["typing_start"]);
    expect(sender.isTyping).toBe(true);
    sched.advance(60_000);
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
    sender.onInput(true);
    sched.advance(500);
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
    sched.advance(60_000);
    sender.onInput(true);
    expect(events).toEqual(["typing_start", "typing_stop"]);
  });
});

describe("typing indicator (source guard)", () => {
  const chatSrc = readSrc("src/components/community/room-chat.tsx");
  const cssSrc = readSrc("src/app/globals.css");
  const typingSrc = readSrc("src/lib/community/typing.ts");

  it("rides the PER-ROOM realtime channel — no extra channel, table or polling", () => {
    expect(TYPING_BROADCAST_EVENT).toBe("community_typing");
    expect(chatSrc).toContain(".channel(`community-room:${room.id}`)");
    // Exactly ONE channel per mount (typing + edits + deletes ride it).
    expect(chatSrc.match(/\.channel\(/g)).toHaveLength(1);
    // The listener is wired through the shared constant (single source of truth).
    expect(chatSrc).toContain('.on("broadcast", { event: TYPING_BROADCAST_EVENT }');
    // Room guard: typing from another room is dropped (shared socket).
    expect(chatSrc).toContain("wireRoom !== room.id");
    // Only the two Supabase reads (author enrichment + image signing):
    // typing added no database access.
    expect(chatSrc.match(/\.from\(/g)).toHaveLength(2);
    // Seven event-driven fetches (resync, load older, reaction toggle, edit,
    // delete, send, bounded deep-link walk) — typing added none, and none of
    // them poll.
    expect(chatSrc.match(/\bfetch\(/g)).toHaveLength(7);
  });

  it("stale cleanup is a local timer; reconnect clears stale peers; disconnect stops", () => {
    expect(chatSrc).toContain("window.setInterval(refreshTyping, TYPING_PRUNE_INTERVAL_MS)");
    expect(chatSrc).toContain("clearTyping()");
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
    expect(body).not.toContain("markRoomRead");
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
    expect(cssSrc).toContain("@media (prefers-reduced-motion: reduce)");
    expect(cssSrc).toMatch(/\.typing-dot\s*\{[^}]*opacity:\s*0\.6/);
    expect(chatSrc).toContain("typingLabel");
  });

  it("never writes to the database (pure module, no typing in the SQL)", () => {
    expect(typingSrc).not.toMatch(
      /supabase|\.from\(|insert|\.rpc\(|localStorage|sessionStorage|fetch\(/,
    );
    const sql = readSrc("supabase/migrations/20261027000000_community_v2.sql");
    expect(sql).not.toMatch(/typing/i);
  });
});

// ---------------------------------------------------------------------------
// Production realtime wiring (source guard)
// ---------------------------------------------------------------------------

describe("production realtime wiring (source guard)", () => {
  const chatSrc = readSrc("src/components/community/room-chat.tsx");

  it("initializes the browser session and attaches the JWT before joining", () => {
    expect(chatSrc).toContain("await client.auth.initialize()");
    expect(chatSrc).toContain("client.realtime.setAuth(session.access_token)");
    // …and the join happens after the token is attached (same async bootstrap).
    const rtEffect = chatSrc.slice(
      chatSrc.indexOf("const subscribeChannel = () =>"),
      chatSrc.indexOf("return () => {", chatSrc.indexOf("const subscribeChannel = () =>")),
    );
    expect(rtEffect.indexOf("client.realtime.setAuth(session.access_token)")).toBeLessThan(
      rtEffect.indexOf("subscribeChannel();"),
    );
  });

  it("keeps the socket token fresh across refreshes and sign-out", () => {
    expect(chatSrc).toContain("client.auth.onAuthStateChange");
    expect(chatSrc).toContain("client.realtime.setAuth();");
  });

  it("NEVER joins a channel without a JWT (RLS-backed realtime would stream zero rows)", () => {
    const rtEffect = chatSrc.slice(
      chatSrc.indexOf("const subscribeChannel = () =>"),
      chatSrc.indexOf("return () => {", chatSrc.indexOf("const subscribeChannel = () =>")),
    );
    expect(rtEffect).toContain("if (session?.access_token) {");
    expect(rtEffect).toContain(
      'if (event === "INITIAL_SESSION" || event === "SIGNED_IN") subscribeChannel();',
    );
  });

  it("creates at most ONE channel per mount (idempotent subscribe), torn down on unmount", () => {
    expect(chatSrc).toContain("if (disposed || channel) return;");
    expect(chatSrc).toContain("if (channel) void client.removeChannel(channel);");
  });

  it("never treats CONNECTING as a failure (no banner flash on load)", () => {
    expect(chatSrc).toContain('status === "TIMED_OUT"');
    expect(chatSrc).toContain('status === "CLOSED"');
    expect(chatSrc).toContain('status === "CHANNEL_ERROR"');
  });

  it("resyncs on foreground return ONLY after a real gap (no tab-switch polling)", () => {
    expect(chatSrc).toContain(
      "if (sawDisconnected.current || connectionRef.current !== \"connected\")",
    );
  });

  it("dev diagnostics are NODE_ENV-gated and never log secrets", () => {
    expect(chatSrc).toContain('const LOG_DEV = process.env.NODE_ENV === "development"');
    // The token is only ever logged as a boolean presence, never its value.
    expect(chatSrc).toContain('{ hasToken: true }');
    expect(chatSrc).not.toMatch(/devLog\([^)]*access_token\b(?!\))/);
  });

  it("no router.refresh / location.reload / polling of any kind", () => {
    expect(chatSrc).not.toMatch(/location\.reload|router\.refresh\(\)/);
    expect(chatSrc).not.toMatch(/setInterval\([^)]*fetch/);
  });

  it("edits + deletions are broadcast on the room channel (RLS reaches only the actor)", () => {
    expect(chatSrc).toContain('event: MESSAGE_UPDATE_BROADCAST_EVENT');
    expect(chatSrc).toContain('event: MESSAGE_DELETE_BROADCAST_EVENT');
    expect(chatSrc).toContain("parseMessageUpdateBroadcast(payload?.payload)");
    expect(chatSrc).toContain("parseMessageDeleteBroadcast(payload?.payload)");
    // Cross-room broadcasts are dropped.
    expect(chatSrc).toContain("update.roomId !== room.id");
    expect(chatSrc).toContain("del.roomId !== room.id");
  });
});

// ---------------------------------------------------------------------------
// DB-outage behaviour of the Community writes (no white page, ever)
// ---------------------------------------------------------------------------

describe("community writes during a database outage", () => {
  it("completeOnboarding resolves with 'generic' when the client itself throws (never rejects)", async () => {
    mockActionClient({ userId: USER_ID, throwOnFrom: true });
    await expect(
      completeOnboarding({ displayName: "SilverFox", avatarId: "avatar-1" }),
    ).resolves.toEqual({ ok: false, code: "generic" });
  });

  it("markRoomRead swallows a transport failure (the badge must never break)", async () => {
    mockActionClient({ userId: USER_ID, throwOnFrom: true });
    await expect(markRoomRead(ROOM_ID)).resolves.toBeUndefined();
  });

  it("is idempotent: completing onboarding twice writes the same conflict target", async () => {
    allowRateLimits(5);
    const { upserts } = mockActionClient({ userId: USER_ID });
    const input = { displayName: "SilverFox", avatarId: "avatar-3" };
    await expect(completeOnboarding(input)).resolves.toEqual({ ok: true });
    await expect(completeOnboarding(input)).resolves.toEqual({ ok: true });
    expect(upserts).toHaveLength(2);
    expect(upserts[0]).toEqual(upserts[1]);
    expect(upserts[0].payload).toEqual({
      user_id: USER_ID,
      display_name: "SilverFox",
      avatar_id: "avatar-3",
    });
  });
});
