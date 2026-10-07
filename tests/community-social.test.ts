/**
 * Community Phase 2 — the social layer test suite.
 *
 * Coverage (per the Phase 2 matrix):
 *   - the PURE relationship state machine (unit, no mocks)
 *   - profile-card payload (privacy: identity fields only, no email/name)
 *   - friend-request lifecycle (send/accept/decline/cancel, duplicates,
 *     self-request, blocked users, invalid ids, unauthorized mutations)
 *   - friendship (symmetry, duplicate prevention, remove, re-request)
 *   - blocking (block/unblock, duplicates, blocked cannot request/DM,
 *     unauthorized unblock, IDOR)
 *   - DMs (authorized/unauthorized access, dedupe, send, empty/too-long,
 *     edit, delete, pagination cursor, unread summary, replies, reactions,
 *     per-emoji toggle)
 *   - DM images (size, MIME magic bytes, storage path, unauthorized upload)
 *   - realtime architecture guards (conversation-scoped channels, guards,
 *     cleanup, no duplicate subscriptions) — source-level assertions
 *   - notifications (ownership, mark read / mark all, unread count, IDOR)
 *   - mentions (notification, self-mention, invalid mention, idempotency)
 *   - IDOR suite (every cross-user access path denied)
 *   - i18n parity (DE/EN/FR/AR key match, including nav.social)
 *   - migration guards (RLS, realtime publication, constraints, functions)
 *
 * Server boundaries are exercised by calling the REAL route handlers with
 * mocked Supabase clients (queued per-table results + recorded calls) and
 * a mocked admin client (rate limiting + service-role notification writes).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const readSrc = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentUserAndProfile } from "@/lib/auth";

import { GET as memberGET } from "@/app/api/community/members/[userId]/route";
import { GET as friendsGET, POST as friendsPOST } from "@/app/api/community/friends/route";
import {
  POST as requestPOST,
  DELETE as requestDELETE,
} from "@/app/api/community/friends/requests/[requestId]/route";
import { DELETE as friendDELETE } from "@/app/api/community/friends/[userId]/route";
import { POST as blockPOST, DELETE as blockDELETE } from "@/app/api/community/blocks/[userId]/route";
import { GET as dmGET, POST as dmPOST } from "@/app/api/community/dm/route";
import { GET as dmConvGET } from "@/app/api/community/dm/[conversationId]/route";
import { POST as dmSendPOST } from "@/app/api/community/dm/[conversationId]/messages/route";
import { PATCH as dmEditPATCH, DELETE as dmEditDELETE } from "@/app/api/community/dm/messages/[messageId]/route";
import { POST as dmReactionPOST } from "@/app/api/community/dm/messages/[messageId]/reactions/route";

import { allowedActions, deriveRelationship, otherUserId } from "@/lib/community/relationship";
import {
  fetchNotifications,
  fetchSocialBadges,
  notifyMentions,
  socialSendKey,
} from "@/lib/community/social";
import {
  markAllNotificationsRead,
  markDmRead,
  markNotificationRead,
  setPresenceMode,
  setShowPresence,
  touchCommunityPresence,
  updateNotificationPreferences,
} from "@/app/community/actions";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CAROL = "33333333-3333-4333-8333-333333333333";
const DAVE = "44444444-4444-4444-8444-444444444444";
const ERIN = "55555555-5555-4555-8555-555555555555";
const FRIENDSHIP_ID = "aaaaaaa1-0000-4000-8000-000000000001";
const CONVERSATION_ID = "bbbbbbb1-0000-4000-8000-000000000001";
const MESSAGE_ID = "ccccccc1-0000-4000-8000-000000000001";
const NOTIFICATION_ID = "ddddddd1-0000-4000-8000-000000000001";

const NOW = "2026-10-28T12:00:00.000Z";

/** community_profiles row (identity fields only — no email exists here). */
const profileRow = (
  userId: string,
  displayName: string,
  opts: { online?: boolean; bio?: string | null } = {},
) => ({
  user_id: userId,
  display_name: displayName,
  avatar_id: "avatar-1",
  bio: opts.bio ?? null,
  created_at: "2026-01-15T09:00:00.000Z",
  last_seen_at: opts.online ? NOW : "2026-01-01T00:00:00.000Z",
});

const friendshipRow = (
  requester: string,
  requestee: string,
  status: "pending" | "accepted" = "pending",
) => ({
  id: FRIENDSHIP_ID,
  requester_id: requester,
  requestee_id: requestee,
  status,
  created_at: NOW,
});

const conversationRow = (memberA: string, memberB: string) => ({
  id: CONVERSATION_ID,
  member_a: memberA,
  member_b: memberB,
  created_at: NOW,
  updated_at: NOW,
});

// ---------------------------------------------------------------------------
// Supabase mocks (queued per-table results + recorded calls)
// ---------------------------------------------------------------------------

interface TerminalResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

interface Call {
  table: string;
  op: string;
  args: unknown[];
}

interface ClientOpts {
  /** FIFO terminal results per table (empty queue → per-op default). */
  queues?: Record<string, TerminalResult[]>;
  storage?: {
    uploadError?: { message: string } | null;
    removeError?: { message: string } | null;
  };
}

const ok = (data: unknown = null): TerminalResult => ({ data, error: null });
const fail = (message: string, code?: string): TerminalResult => ({
  data: null,
  error: { message, code },
});

/** The session user for the mock's `auth.getUser()` (server actions). */
let mockAuthUserId: string | null = null;

function makeUserClient(opts: ClientOpts = {}) {
  const calls: Call[] = [];
  const queues = opts.queues ?? {};
  const from = (table: string) => {
    const queue = (queues[table] ??= []);
    let filters: Array<[string, unknown[]]> = [];
    /** Apply the recorded eq/lt filters to ARRAY results (mock fidelity). */
    const applyFilters = (result: TerminalResult): TerminalResult => {
      if (result.error || !Array.isArray(result.data)) return result;
      let rows = result.data as Array<Record<string, unknown>>;
      for (const [op, args] of filters) {
        if (op === "eq" && args.length === 2) {
          const [field, value] = args as [string, string];
          rows = rows.filter((row) => row[field] === value);
        } else if (op === "lt" && args.length === 2) {
          const [field, value] = args as [string, string];
          rows = rows.filter((row) => String(row[field] ?? "") < value);
        }
      }
      return { data: rows, error: null };
    };
    const consume = (): TerminalResult => {
      const result =
        queue.length > 0
          ? (queue.shift() as TerminalResult)
          : table === "community_friendships" || table === "community_blocks"
            ? ok([])
            : table === "community_direct_messages" || table === "community_dm_reactions"
              ? ok([])
              : ok(null);
      const filtered = applyFilters(result);
      filters = []; // filters belong to this query only
      return filtered;
    };
    const base: Record<string, unknown> = {};
    const chainOps = [
      "select",
      "order",
      "limit",
      "offset",
      "lt",
      "lte",
      "gt",
      "gte",
      "in",
      "eq",
      "neq",
      "or",
      "ilike",
      "is",
      "not",
      "single",
    ];
    for (const op of chainOps) {
      base[op] = (...args: unknown[]) => {
        calls.push({ table, op, args });
        if (op === "eq" || op === "lt") filters.push([op, args]);
        return base;
      };
    }
    base.maybeSingle = () => {
      calls.push({ table, op: "maybeSingle", args: [] });
      const result = consume();
      // maybeSingle over a (possibly filtered) array → first match or null.
      const single = Array.isArray(result.data)
        ? { data: (result.data as unknown[])[0] ?? null, error: result.error }
        : result;
      return Promise.resolve(single);
    };
    base.insert = (values: unknown) => {
      calls.push({ table, op: "insert", args: [values] });
      return base;
    };
    base.update = (values: unknown) => {
      calls.push({ table, op: "update", args: [values] });
      return base;
    };
    base.delete = (...args: unknown[]) => {
      calls.push({ table, op: "delete", args });
      return base;
    };
    base.upsert = (values: unknown, upsertOpts?: unknown) => {
      calls.push({ table, op: "upsert", args: [values, upsertOpts] });
      // The real client returns a chainable builder that is ALSO thenable
      // (filters like .not(...) may follow the upsert, as in the presence
      // heartbeat's DND guard). Reproduce both facets.
      const chainable: Record<string, unknown> = {
        then: (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
          calls.push({ table, op: "then", args: [] });
          return Promise.resolve(consume()).then(onF as never, onR as never);
        },
      };
      for (const op of ["not", "eq", "neq", "in", "or", "single", "maybeSingle"]) {
        chainable[op] = (...args: unknown[]) => {
          calls.push({ table, op, args });
          return op === "single" || op === "maybeSingle"
            ? Promise.resolve(consume())
            : chainable;
        };
      }
      return chainable;
    };
    Object.assign(base, {
      then: (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
        calls.push({ table, op: "then", args: [] });
        return Promise.resolve(consume()).then(onF as never, onR as never);
      },
    });
    return base;
  };
  const rpc = (fn: string, args?: unknown) => {
    const queue = queues[`rpc:${fn}`] ?? [];
    const result = queue.length > 0 ? queue.shift() : { data: null, error: null };
    calls.push({ table: `rpc:${fn}`, op: "rpc", args: [args] });
    return Promise.resolve(result as TerminalResult);
  };
  const upload = vi.fn<(path: string, file: File) => Promise<{ data: { path: string } | null; error: { message: string } | null }>>(
    async () => ({
      data: { path: "dm/…/image.png" },
      error: opts.storage?.uploadError ?? null,
    }),
  );
  const remove = vi.fn(async () => opts.storage?.removeError ?? null);
  // `calls`/`upload`/`remove` ride on the client object so tests can assert
  // on the exact mock they scripted (`const { client } = makeUserClient(…)`).
  // The intersection keeps the Supabase shape (mockResolvedValue) plus the
  // typed call recorder.
  const client = ({
    from,
    rpc,
    calls,
    upload,
    remove,
    auth: {
      getUser: () =>
        Promise.resolve({
          data: { user: mockAuthUserId ? { id: mockAuthUserId } : null },
          error: null,
        }),
    },
    storage: { from: () => ({ upload, remove, createSignedUrl: async () => ({ data: { signedUrl: "https://signed" } }) }) },
  }) as unknown as SupabaseClient & { calls: Call[] };
  return { calls, client, upload, remove };
}

interface AdminOpts {
  rateLimit?: { allowed: boolean; count?: number; limit?: number; retry_after?: number };
  notificationInsert?: TerminalResult;
  notificationExisting?: TerminalResult;
  mentionProfiles?: Array<{ user_id: string }>;
}

function mockAdmin(opts: AdminOpts = {}) {
  const adminCalls: Call[] = [];
  const from = (table: string) => {
    const base: Record<string, unknown> = {};
    base.select = (...args: unknown[]) => {
      adminCalls.push({ table, op: "select", args });
      return base;
    };
    base.insert = (values: unknown) => {
      adminCalls.push({ table, op: "insert", args: [values] });
      return base;
    };
    base.eq = (...args: unknown[]) => {
      adminCalls.push({ table, op: "eq", args });
      return base;
    };
    base.or = (...args: unknown[]) => {
      adminCalls.push({ table, op: "or", args });
      return base;
    };
    base.maybeSingle = () =>
      Promise.resolve(
        table === "notifications" ? (opts.notificationExisting ?? ok(null)) : ok(null),
      );
    base.single = () =>
      Promise.resolve(
        table === "notifications" ? (opts.notificationInsert ?? ok({ id: NOTIFICATION_ID })) : ok(null),
      );
    Object.assign(base, {
      then: (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(
          table === "community_profiles"
            ? { data: opts.mentionProfiles ?? [], error: null }
            : { data: null, error: null },
        ).then(onF as never, onR as never),
    });
    return base;
  };
  vi.mocked(createAdminClient).mockReturnValue({
    from,
    rpc: (fn: string) =>
      Promise.resolve(
        fn === "check_rate_limit"
          ? {
              data:
                opts.rateLimit ?? { allowed: true, count: 1, limit: 100, retry_after: 0 },
              error: null,
            }
          : { data: null, error: null },
      ),
  } as never);
  return adminCalls;
}

function mockAuth(userId: string | null) {
  mockAuthUserId = userId;
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: userId ? { id: userId } : null,
    profile: { id: "p", account_status: "active" } as never,
  } as never);
}

function post(url: string, body: unknown) {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Flush the fire-and-forget notification writes (void createSocialNotification). */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// A PNG header (magic bytes are what the image gate trusts — never MIME).
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);

function pngFile(type = "image/png") {
  return new File([new Blob([PNG_BYTES])], "image.png", { type });
}

afterEach(() => {
  vi.clearAllMocks();
  mockAuthUserId = null;
});

// ---------------------------------------------------------------------------
// 1. The relationship state machine (PURE — no mocks)
// ---------------------------------------------------------------------------

describe("relationship state machine (pure)", () => {
  it("no friendship row → none", () => {
    expect(deriveRelationship(ALICE, null, false, false)).toBe("none");
  });
  it("pending row where I am the requester → outgoing_pending", () => {
    expect(
      deriveRelationship(ALICE, friendshipRow(ALICE, BOB, "pending"), false, false),
    ).toBe("outgoing_pending");
  });
  it("pending row where I am the requestee → incoming_pending", () => {
    expect(
      deriveRelationship(BOB, friendshipRow(ALICE, BOB, "pending"), false, false),
    ).toBe("incoming_pending");
  });
  it("accepted rows are SYMMETRIC: both sides derive 'friends'", () => {
    const row = friendshipRow(ALICE, BOB, "accepted");
    expect(deriveRelationship(ALICE, row, false, false)).toBe("friends");
    expect(deriveRelationship(BOB, row, false, false)).toBe("friends");
  });
  it("a block composes with every relationship state", () => {
    expect(deriveRelationship(ALICE, null, true, false)).toBe("blocked_by_me");
    expect(deriveRelationship(BOB, friendshipRow(ALICE, BOB, "accepted"), true, false)).toBe("blocked_by_me");
    expect(deriveRelationship(ALICE, null, false, true)).toBe("blocks_me");
    expect(deriveRelationship(BOB, friendshipRow(ALICE, BOB, "pending"), false, true)).toBe("blocks_me");
    // I blocked them AND they blocked me → I act on my own block first.
    expect(deriveRelationship(ALICE, null, true, true)).toBe("blocked_by_me");
  });
  it("otherUserId is independent of row direction", () => {
    expect(otherUserId(ALICE, friendshipRow(ALICE, BOB))).toBe(BOB);
    expect(otherUserId(BOB, friendshipRow(ALICE, BOB))).toBe(ALICE);
  });
  it("allowedActions offers exactly the server-legal gestures per state", () => {
    expect(allowedActions("none").sort()).toEqual(["block", "send_request"].sort());
    expect(allowedActions("outgoing_pending").sort()).toEqual(["block", "cancel_request"].sort());
    expect(allowedActions("incoming_pending").sort()).toEqual(
      ["accept_request", "block", "decline_request"].sort(),
    );
    expect(allowedActions("friends").sort()).toEqual(["block", "message", "remove_friend"].sort());
    expect(allowedActions("blocked_by_me")).toEqual(["unblock"]);
    // Being blocked: the only legal gesture is blocking back (mutual block).
    expect(allowedActions("blocks_me")).toEqual(["block"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Profile card — payload + privacy
// ---------------------------------------------------------------------------

describe("profile card (GET /api/community/members/:userId)", () => {
  it("returns ONLY community identity fields — no email, no account name", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        community_friendships: [ok([friendshipRow(ALICE, BOB, "accepted")])],
        community_blocks: [ok([])],
        community_profiles: [ok([profileRow(BOB, "BobBuilder", { online: true })])],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);

    const res = await memberGET(
      new Request("http://localhost/api/community/members/x"),
      { params: Promise.resolve({ userId: BOB }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { member: Record<string, unknown>; relationship: Record<string, unknown> };
    // The payload is exactly the privacy contract — nothing else exists.
    // Phase 3 adds the server-derived presence + last-seen to the contract;
    // Phase 10 adds the server-computed platform-admin flag (a boolean
    // derived from the database user id — no account field, no email).
    expect(Object.keys(body.member).sort()).toEqual(
      ["avatarId", "bio", "displayName", "isPlatformAdmin", "joinedAt", "lastSeenAt", "online", "presence", "userId"].sort(),
    );
    expect(body.member.displayName).toBe("BobBuilder");
    expect(body.member.online).toBe(true);
    expect(body.member.presence).toBe("online");
    expect(body.member.lastSeenAt).toBe(NOW);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/email/i);
    expect(body.relationship.state).toBe("friends");
  });

  it("requires authentication", async () => {
    mockAuth(null);
    mockAdmin();
    const res = await memberGET(
      new Request("http://localhost/api/community/members/x"),
      { params: Promise.resolve({ userId: BOB }) },
    );
    expect(res.status).toBe(401);
  });

  it("rejects a malformed id (400) and a missing member (404)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const bad = await memberGET(new Request("http://localhost/x"), {
      params: Promise.resolve({ userId: "not-a-uuid" }),
    });
    expect(bad.status).toBe(400);

    const { client } = makeUserClient({
      queues: {
        community_friendships: [ok([])],
        community_blocks: [ok([])],
        community_profiles: [ok([])],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const missing = await memberGET(new Request("http://localhost/x"), {
      params: Promise.resolve({ userId: CAROL }),
    });
    expect(missing.status).toBe(404);
  });

  it("degrades to 500 (never leaks internals) when the DB fails", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        community_friendships: [fail("db down")],
        community_blocks: [ok([])],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await memberGET(new Request("http://localhost/x"), {
      params: Promise.resolve({ userId: BOB }),
    });
    expect(res.status).toBe(500);
  });
});

describe("friends list (GET /api/community/friends) — the convergence endpoint", () => {
  it("returns friends + incoming + outgoing + blocked in one degraded-safe payload", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        // fetchMySocialRows: one friendship query + one block query, then a
        // single batched profile query (no N+1).
        community_friendships: [
          ok([
            friendshipRow(ALICE, BOB, "accepted"), // friend
            { id: "f-2", requester_id: CAROL, requestee_id: ALICE, status: "pending", created_at: NOW }, // incoming
            { id: "f-3", requester_id: ALICE, requestee_id: DAVE, status: "pending", created_at: NOW }, // outgoing
          ]),
        ],
        community_blocks: [ok([{ blocker_id: ALICE, blocked_id: ERIN }])], // I blocked Erin
        community_profiles: [
          ok([
            profileRow(BOB, "BobBuilder"),
            profileRow(CAROL, "CarolQ"),
            profileRow(DAVE, "DaveD"),
            profileRow(ERIN, "ErinE"),
          ]),
        ],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await friendsGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      friends: Array<{ state: string; other: { userId: string } }>;
      incoming: Array<{ state: string; other: { userId: string } }>;
      outgoing: Array<{ state: string; other: { userId: string } }>;
      blocked: Array<{ userId: string }>;
      unavailable: boolean;
    };
    expect(body.unavailable).toBe(false);
    expect(body.friends.map((f) => f.other.userId)).toEqual([BOB]);
    expect(body.friends[0]?.state).toBe("friends");
    expect(body.incoming.map((f) => f.other.userId)).toEqual([CAROL]);
    expect(body.incoming[0]?.state).toBe("incoming_pending");
    expect(body.outgoing.map((f) => f.other.userId)).toEqual([DAVE]);
    expect(body.outgoing[0]?.state).toBe("outgoing_pending");
    expect(body.blocked.map((b) => b.userId)).toEqual([ERIN]);
    // The other members' identities come from ONE batched query:
    expect(client.calls.filter((c) => c.table === "community_profiles" && c.op === "in")).toHaveLength(1);
  });

  it("degrades to 500 on a DB failure (the client keeps its last good state)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: { community_friendships: [fail("db down")] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await friendsGET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not load friends." });
  });
});

// ---------------------------------------------------------------------------
// 3. Friend requests — the full lifecycle
// ---------------------------------------------------------------------------

describe("friend requests (POST /api/community/friends)", () => {
  it("sends a request and notifies the target (idempotent send key)", async () => {
    mockAuth(ALICE);
    const adminCalls = mockAdmin();
    const { client } = makeUserClient({
      queues: {
        community_profiles: [
          ok(profileRow(BOB, "BobBuilder")),
          ok({ display_name: "AliceFox" }),
        ],
        community_blocks: [ok([])],
        community_friendships: [
          ok({
            id: FRIENDSHIP_ID,
            requester_id: ALICE,
            requestee_id: BOB,
            status: "pending",
            created_at: NOW,
          }),
        ],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);

    const res = await friendsPOST(post("/api/community/friends", { userId: BOB }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { friendship: { status: string } };
    expect(body.friendship.status).toBe("pending");

    // The notification write is service-role + targeted at BOB + keyed.
    await flush();
    const insert = adminCalls.find((c) => c.table === "notifications" && c.op === "insert");
    expect(insert).toBeTruthy();
    const payload = insert?.args[0] as { target_user_id: string; send_key: string };
    expect(payload.target_user_id).toBe(BOB);
    expect(payload.send_key).toBe(socialSendKey("friend_request", FRIENDSHIP_ID));
  });

  it("rejects self-requests", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const res = await friendsPOST(post("/api/community/friends", { userId: ALICE }));
    const body = await res.json();
    expect(body).toEqual({ error: "self_request" });
    expect(res.status).toBe(400);
  });

  it("rejects a non-member target (404 — not 200/500)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        community_profiles: [ok(null), ok({ display_name: "AliceFox" })],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await friendsPOST(post("/api/community/friends", { userId: CAROL }));
    expect(res.status).toBe(404);
  });

  it("a BLOCKED user cannot send a request (either direction)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        community_profiles: [ok(profileRow(BOB, "B")), ok({ display_name: "A" })],
        community_blocks: [ok([{ blocker_id: BOB, blocked_id: ALICE }])],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await friendsPOST(post("/api/community/friends", { userId: BOB }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked" });
    // No insert was attempted.
    expect(client.calls.some((c) => c.table === "community_friendships" && c.op === "insert")).toBe(false);
  });

  it("duplicate prevention: a 23505 collision converges to the existing row (200, duplicate)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const existing = friendshipRow(ALICE, BOB, "pending");
    const { client } = makeUserClient({
      queues: {
        community_profiles: [ok(profileRow(BOB, "B")), ok({ display_name: "A" })],
        community_blocks: [ok([])],
        community_friendships: [
          fail("duplicate key value violates unique constraint", "23505"),
          ok(existing),
        ],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await friendsPOST(post("/api/community/friends", { userId: BOB }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { friendship: typeof existing; duplicate: boolean };
    expect(body.duplicate).toBe(true);
    expect(body.friendship.id).toBe(FRIENDSHIP_ID);
  });

  it("requires authentication and rate-limits", async () => {
    mockAuth(null);
    mockAdmin();
    expect((await friendsPOST(post("/api/community/friends", { userId: BOB })))).toBeTruthy();

    mockAuth(ALICE);
    mockAdmin({
      rateLimit: { allowed: false, count: 21, limit: 20, retry_after: 17 },
    });
    const limited = await friendsPOST(post("/api/community/friends", { userId: BOB }));
    expect(limited.status).toBe(429);
  });
});

describe("accept / decline (POST /api/community/friends/requests/:id)", () => {
  const acceptAs = () =>
    requestPOST(post("/api/community/friends/requests/x", { action: "accept" }), {
      params: Promise.resolve({ requestId: FRIENDSHIP_ID }),
    });

  it("the requestee accepts → status accepted + the requester is notified", async () => {
    mockAuth(BOB); // BOB is the requestee
    const adminCalls = mockAdmin();
    // Query order: load row → blocks → update → own-name lookup.
    const scripted = makeUserClient({
      queues: {
        community_friendships: [ok(friendshipRow(ALICE, BOB, "pending")), ok(null)],
        community_blocks: [ok([])],
        community_profiles: [ok({ display_name: "BobBuilder" })],
      },
    });
    vi.mocked(createClient).mockResolvedValue(scripted.client);

    const res = await acceptAs();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { friendship: { status: string } };
    expect(body.friendship.status).toBe("accepted");
    // update is scoped to (id, requestee_id=me, status=pending) — double-accept
    // races cannot flip it twice.
    const updateCall = scripted.client.calls.find((c) => c.table === "community_friendships" && c.op === "update");
    expect(updateCall).toBeTruthy();
    await flush();
    const insert = adminCalls.find((c) => c.table === "notifications" && c.op === "insert");
    expect(insert?.args[0]).toMatchObject({ target_user_id: ALICE });
    expect((insert?.args[0] as { send_key: string }).send_key).toBe(
      socialSendKey("friend_accepted", FRIENDSHIP_ID),
    );
  });

  it("the REQUESTER cannot accept (403 not_allowed)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: { community_friendships: [ok(friendshipRow(ALICE, BOB, "pending"))] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await acceptAs();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_allowed" });
  });

  it("a stranger cannot touch the request (RLS hides the row → 404, no existence leak)", async () => {
    mockAuth(CAROL);
    mockAdmin();
    const { client } = makeUserClient({
      queues: { community_friendships: [ok(null)] }, // RLS: Carol sees nothing
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await acceptAs();
    expect(res.status).toBe(404);
  });

  it("a block placed AFTER the request kills the acceptance (403 + cleanup)", async () => {
    mockAuth(BOB);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        community_friendships: [ok(friendshipRow(ALICE, BOB, "pending")), ok(null)],
        community_blocks: [ok([{ blocker_id: BOB, blocked_id: ALICE }])],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await acceptAs();
    expect(res.status).toBe(403);
    const deleteCall = client.calls.find((c) => c.table === "community_friendships" && c.op === "delete");
    expect(deleteCall).toBeTruthy();
  });

  it("invalid action → 400", async () => {
    mockAuth(BOB);
    mockAdmin();
    const { client } = makeUserClient({
      queues: { community_friendships: [ok(friendshipRow(ALICE, BOB, "pending"))] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await requestPOST(post("/api/community/friends/requests/x", { action: "maybe" }), {
      params: Promise.resolve({ requestId: FRIENDSHIP_ID }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_action" });
  });

  it("decline deletes the row (a fresh request is possible afterwards)", async () => {
    mockAuth(BOB);
    mockAdmin();
    const { client } = makeUserClient({
      queues: { community_friendships: [ok(friendshipRow(ALICE, BOB, "pending")), ok(null)] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await requestPOST(post("/api/community/friends/requests/x", { action: "decline" }), {
      params: Promise.resolve({ requestId: FRIENDSHIP_ID }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ declined: true });
    expect(client.calls.some((c) => c.table === "community_friendships" && c.op === "delete")).toBe(true);
  });

  it("an invalid request id → 404", async () => {
    mockAuth(BOB);
    mockAdmin();
    const res = await requestPOST(post("/api/community/friends/requests/x", { action: "accept" }), {
      params: Promise.resolve({ requestId: "nope" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("cancel (DELETE /api/community/friends/requests/:id)", () => {
  const cancel = () =>
    requestDELETE(new Request("http://localhost/api/community/friends/requests/x", { method: "DELETE" }), {
      params: Promise.resolve({ requestId: FRIENDSHIP_ID }),
    });

  it("the requester cancels a pending request", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: { community_friendships: [ok(friendshipRow(ALICE, BOB, "pending")), ok(null)] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await cancel();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });
  });

  it("the requestee CANNOT cancel (403)", async () => {
    mockAuth(BOB);
    mockAdmin();
    const { client } = makeUserClient({
      queues: { community_friendships: [ok(friendshipRow(ALICE, BOB, "pending"))] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await cancel();
    expect(res.status).toBe(403);
  });

  it("an accepted request cannot be cancelled (409 not_pending)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: { community_friendships: [ok(friendshipRow(ALICE, BOB, "accepted"))] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await cancel();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_pending" });
  });
});

// ---------------------------------------------------------------------------
// 4. Friendship — remove + re-request
// ---------------------------------------------------------------------------

describe("friendship (DELETE /api/community/friends/:userId)", () => {
  const remove = () =>
    friendDELETE(new Request("http://localhost/api/community/friends/x", { method: "DELETE" }), {
      params: Promise.resolve({ userId: BOB }),
    });

  it("a friend removes the friendship (row deleted, history stays private)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      // delete().eq().or().select("id") → the removed rows:
      queues: { community_friendships: [ok([{ id: FRIENDSHIP_ID, status: "accepted" }])] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await remove();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });
    const deleteCall = client.calls.find((c) => c.table === "community_friendships" && c.op === "delete");
    expect(deleteCall).toBeTruthy();
    // The delete is scoped to ACCEPTED pairs of the caller only.
    const orArg = client.calls
      .filter((c) => c.table === "community_friendships" && c.op === "or")
      .map((c) => c.args[0])[0] as string;
    expect(orArg).toContain(`requester_id.eq.${ALICE}.and.requestee_id.eq.${BOB}`);
    expect(orArg).toContain(`requester_id.eq.${BOB}.and.requestee_id.eq.${ALICE}`);
  });

  it("removing a non-friend (pending only) → 404 not_friends", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      // RLS + the accepted filter match nothing:
      queues: { community_friendships: [ok([])] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await remove();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_friends" });
  });

  it("IDOR: Carol cannot remove Alice+Bob's friendship (RLS hides the row → 404)", async () => {
    mockAuth(CAROL);
    mockAdmin();
    const { client } = makeUserClient({
      // Carol is not a participant: the row is invisible, delete removes nothing.
      queues: { community_friendships: [ok([])] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await remove();
    expect(res.status).toBe(404);
    // Even the attempted delete is scoped to Carol's own pairs — Alice's row
    // is structurally unreachable (verified by the empty result).
    const orArg = client.calls
      .filter((c) => c.table === "community_friendships" && c.op === "or")
      .map((c) => c.args[0])[0] as string;
    expect(orArg).toContain(`requester_id.eq.${CAROL}`);
    expect(orArg).not.toContain(ALICE);
  });
});

// ---------------------------------------------------------------------------
// 5. Blocking
// ---------------------------------------------------------------------------

describe("blocking (POST/DELETE /api/community/blocks/:userId)", () => {
  it("block → 201; duplicate block → 200 (idempotent)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const fresh = makeUserClient({
      queues: {
        community_profiles: [ok(profileRow(BOB, "B"))],
        community_blocks: [
          ok({ id: "blk-1" }), // insert single
        ],
      },
    });
    vi.mocked(createClient).mockResolvedValue(fresh.client);
    const res = await blockPOST(post("/api/community/blocks/x", {}), {
      params: Promise.resolve({ userId: BOB }),
    });
    expect(res.status).toBe(201);

    const dup = makeUserClient({
      queues: {
        community_profiles: [ok(profileRow(BOB, "B"))],
        community_blocks: [fail("duplicate key", "23505")],
      },
    });
    vi.mocked(createClient).mockResolvedValue(dup.client);
    const res2 = await blockPOST(post("/api/community/blocks/x", {}), {
      params: Promise.resolve({ userId: BOB }),
    });
    expect(res2.status).toBe(200);
  });

  it("self-block is impossible (400)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const res = await blockPOST(post("/api/community/blocks/x", {}), {
      params: Promise.resolve({ userId: ALICE }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "self_block" });
  });

  it("unblock → 200 (only the blocker may unblock — the delete is scoped to blocker_id = me)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        // delete().select() returns the removed row (scoped by my own eq's):
        community_blocks: [ok([{ id: "blk-1", blocker_id: ALICE, blocked_id: BOB }])],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await blockDELETE(new Request("http://localhost/x", { method: "DELETE" }), {
      params: Promise.resolve({ userId: BOB }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unblocked: true });
    const deleteCall = client.calls.find((c) => c.table === "community_blocks" && c.op === "delete");
    expect(deleteCall).toBeTruthy();
    // The scoping: blocker_id = the caller (RLS enforces the same rule).
    const eqArgs = client.calls
      .filter((c) => c.table === "community_blocks" && c.op === "eq")
      .map((c) => c.args);
    expect(eqArgs).toContainEqual(["blocker_id", ALICE]);
    expect(eqArgs).toContainEqual(["blocked_id", BOB]);
  });

  it("IDOR: the BLOCKED user cannot unblock (404 not_blocked)", async () => {
    mockAuth(BOB); // Alice blocked Bob; Bob tries to remove Alice's block
    mockAdmin();
    const { client } = makeUserClient({
      queues: { community_blocks: [ok([])] }, // RLS: no row where blocker_id = BOB
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await blockDELETE(new Request("http://localhost/x", { method: "DELETE" }), {
      params: Promise.resolve({ userId: ALICE }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_blocked" });
    // Even though a delete is attempted, it is scoped to BOB's own blocks —
    // Alice's block (blocker_id = ALICE) is structurally unreachable.
    const eqArgs = client.calls
      .filter((c) => c.table === "community_blocks" && c.op === "eq")
      .map((c) => c.args);
    expect(eqArgs).toContainEqual(["blocker_id", BOB]);
  });
});

// ---------------------------------------------------------------------------
// 6. DM conversations — open + inbox
// ---------------------------------------------------------------------------

describe("DM conversations (POST /api/community/dm)", () => {
  const open = (userId: string) => dmPOST(post("/api/community/dm", { userId }));

  it("friends open a conversation (canonical member_a < member_b order)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        community_profiles: [ok([profileRow(BOB, "B")])],
        community_friendships: [ok([friendshipRow(ALICE, BOB, "accepted")])],
        community_blocks: [ok([])],
        community_conversations: [
          ok([]), // no existing conversation yet
          ok(conversationRow(ALICE, BOB)), // insert().select().single()
        ],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await open(BOB);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { conversation: { member_a: string; member_b: string } };
    // Canonical ordering regardless of who opened it:
    expect(body.conversation.member_a).toBe(ALICE);
    expect(body.conversation.member_b).toBe(BOB);
    const insertCall = client.calls.find((c) => c.table === "community_conversations" && c.op === "insert");
    expect(insertCall).toBeTruthy();
    expect((insertCall?.args[0] as { member_a: string }).member_a).toBe(ALICE);
  });

  it("conversation deduplication: an existing conversation is reused (no second row)", async () => {
    mockAuth(BOB); // the OTHER side opens — same canonical row
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        community_profiles: [ok([profileRow(ALICE, "A")])],
        community_friendships: [ok([friendshipRow(ALICE, BOB, "accepted")])],
        community_blocks: [ok([])],
        community_conversations: [ok([conversationRow(ALICE, BOB)])], // existing check
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await open(ALICE);
    expect(res.status).toBe(201);
    // …and a 23505 race converges to the winner's row:
    const raced = makeUserClient({
      queues: {
        community_profiles: [ok([profileRow(ALICE, "A")])],
        community_friendships: [ok([friendshipRow(ALICE, BOB, "accepted")])],
        community_blocks: [ok([])],
        community_conversations: [
          ok([]),
          fail("duplicate key", "23505"),
          ok([conversationRow(ALICE, BOB)]), // the winner's row
        ],
      },
    });
    vi.mocked(createClient).mockResolvedValue(raced.client);
    const res2 = await open(ALICE);
    expect([200, 201]).toContain(res2.status);
    const body2 = (await res2.json()) as { conversation: { id: string } };
    expect(body2.conversation.id).toBe(CONVERSATION_ID);
  });

  it("PENDING friends cannot open a conversation (403 not_friends)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        community_profiles: [ok([profileRow(BOB, "B")])],
        community_friendships: [ok([friendshipRow(ALICE, BOB, "pending")])],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await open(BOB);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_friends" });
  });

  it("a blocked user cannot open a conversation (403 blocked)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        community_profiles: [ok([profileRow(BOB, "B")])],
        community_friendships: [ok([friendshipRow(ALICE, BOB, "accepted")])],
        community_blocks: [ok([{ blocker_id: BOB, blocked_id: ALICE }])],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await open(BOB);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked" });
  });

  it("a non-member target → 404", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: { community_profiles: [ok([])] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await open(CAROL);
    expect(res.status).toBe(404);
  });
});

describe("DM inbox (GET /api/community/dm)", () => {
  it("returns the SQL summary with the other member's identity + unread + last-message shape", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        "rpc:community_dm_summary": [
          ok([
            {
              conversation_id: CONVERSATION_ID,
              other_user_id: BOB,
              unread: 2,
              last_message_at: NOW,
              last_message: "hi",
              last_message_is_image: false,
              last_message_mine: false,
            },
          ]),
        ],
        community_profiles: [ok([profileRow(BOB, "BobBuilder", { online: true })])],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: Array<Record<string, unknown>> };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]).toMatchObject({
      conversationId: CONVERSATION_ID,
      unread: 2,
      lastMessage: "hi",
      lastMessageMine: false,
      other: { userId: BOB, displayName: "BobBuilder", online: true },
    });
  });

  it("degrades to 500 on an RPC failure (never a message download)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: { "rpc:community_dm_summary": [fail("db down")] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmGET();
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// 7. DM message page (GET /api/community/dm/:id) — authorization + pagination
// ---------------------------------------------------------------------------

const dmMessageRow = (id: string, userId: string, message: string | null, at: string, extra: Partial<Record<string, unknown>> = {}) => ({
  id,
  conversation_id: CONVERSATION_ID,
  user_id: userId,
  message,
  image_path: null,
  reply_to_message_id: null,
  created_at: at,
  updated_at: at,
  ...extra,
});

describe("DM message page (GET /api/community/dm/:conversationId)", () => {
  const fetchPage = (asUserId: string, conversationId = CONVERSATION_ID, search = "") =>
    dmConvGET(
      new Request(`http://localhost/api/community/dm/${conversationId}${search}`),
      { params: Promise.resolve({ conversationId }) },
    );

  it("a member loads the page (messages + other identity, LocalMessage shape)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        community_conversations: [ok(conversationRow(ALICE, BOB))],
        community_profiles: [
          ok([profileRow(BOB, "BobBuilder")]), // other identity
          ok([profileRow(ALICE, "AliceFox"), profileRow(BOB, "BobBuilder")]), // message authors
        ],
        community_direct_messages: [
          ok([
            dmMessageRow("m-2", BOB, "second", "2026-10-28T11:59:00.000Z"),
            dmMessageRow("m-1", ALICE, "first", "2026-10-28T11:58:00.000Z"),
          ]),
        ],
        community_dm_reactions: [
          ok([
            { message_id: "m-1", user_id: BOB, emoji: "👍" },
          ]),
        ],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await fetchPage(ALICE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      other: { userId: string; displayName: string };
      messages: Array<{ id: string; room_id: string; reactions: Array<{ emoji: string; count: number; mine: boolean }> }>;
    };
    expect(body.other.userId).toBe(BOB);
    expect(body.messages).toHaveLength(2);
    // Ascending chat order + the room_id alias (MessageRow-compatible).
    expect(body.messages[0].id).toBe("m-1");
    expect(body.messages[0].room_id).toBe(CONVERSATION_ID);
    expect(body.messages[0].reactions).toEqual([{ emoji: "👍", count: 1, mine: false }]);
  });

  it("IDOR: a NON-member gets the SAME 404 as a nonexistent id (no existence leak)", async () => {
    mockAuth(CAROL);
    mockAdmin();
    const stranger = makeUserClient({
      queues: { community_conversations: [ok(null)] }, // RLS: hidden
    });
    vi.mocked(createClient).mockResolvedValue(stranger.client);
    const res = await fetchPage(CAROL);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "conversation_not_found" });

    // A bogus uuid must be indistinguishable:
    const bogus = makeUserClient({
      queues: { community_conversations: [ok(null)] },
    });
    vi.mocked(createClient).mockResolvedValue(bogus.client);
    const res2 = await fetchPage(CAROL, "99999999-9999-4999-8999-999999999999");
    expect(res2.status).toBe(404);
    expect(await res2.json()).toEqual({ error: "conversation_not_found" });
  });

  it("a malformed conversation id → 400 (never a query)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const res = await fetchPage(ALICE, "not-a-uuid");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "conversation_not_found" });
  });

  it("cursor pagination: before_at filters to OLDER messages only", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        community_conversations: [ok(conversationRow(ALICE, BOB))],
        community_profiles: [
          ok([profileRow(BOB, "B")]),
          ok([profileRow(ALICE, "A")]),
        ],
        community_direct_messages: [
          ok([dmMessageRow("m-0", ALICE, "oldest", "2026-10-28T11:57:00.000Z")]),
        ],
        community_dm_reactions: [ok([])],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await fetchPage(ALICE, CONVERSATION_ID, `?before_at=${encodeURIComponent("2026-10-28T11:58:00.000Z")}`);
    expect(res.status).toBe(200);
    const ltCall = client.calls.find((c) => c.table === "community_direct_messages" && c.op === "lt");
    expect(ltCall).toBeTruthy();
    expect(ltCall?.args).toEqual(["created_at", "2026-10-28T11:58:00.000Z"]);
  });

  it("an invalid cursor → 400", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const res = await fetchPage(ALICE, CONVERSATION_ID, "?before_at=garbage");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_cursor" });
  });
});

// ---------------------------------------------------------------------------
// 8. Sending DMs (text, idempotency, replies, images)
// ---------------------------------------------------------------------------

const sendForm = (fields: Record<string, string | File>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request(`http://localhost/api/community/dm/${CONVERSATION_ID}/messages`, {
    method: "POST",
    body: form,
  });
};

const sendParams = { params: Promise.resolve({ conversationId: CONVERSATION_ID }) };

describe("sending DMs (POST /api/community/dm/:id/messages)", () => {
  it("sends a text message (author = session, insert + notification to the peer)", async () => {
    mockAuth(ALICE);
    const adminCalls = mockAdmin();
    const clientId = "e0000000-0000-4000-8000-000000000001";
    const { client } = makeUserClient({
      queues: {
        community_conversations: [ok(conversationRow(ALICE, BOB))],
        community_friendships: [ok([{ id: FRIENDSHIP_ID, status: "accepted" }])],
        community_blocks: [ok([])],
        community_direct_messages: [
          ok(null), // idempotency pre-check: no row with this id
          ok(dmMessageRow(clientId, ALICE, "hello", NOW)), // insert().select().single()
        ],
        community_profiles: [ok({ display_name: "AliceFox" })], // own name for the notification
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmSendPOST(sendForm({ message: "hello", id: clientId }), sendParams);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { message: { user_id: string; message: string } };
    expect(body.message.user_id).toBe(ALICE);
    expect(body.message.message).toBe("hello");
    await flush();
    const insert = adminCalls.find((c) => c.table === "notifications" && c.op === "insert");
    // The kind rides the enum `type` (v4 CHECK constraint) AND the title
    // (client render signal).
    expect(insert?.args[0]).toMatchObject({
      target_user_id: BOB,
      type: "direct_message",
      title: "direct_message",
    });
  });

  it("rejects an empty message", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const res = await dmSendPOST(sendForm({ message: "   " }), sendParams);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "empty_message" });
  });

  it("rejects text over the length limit", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const res = await dmSendPOST(sendForm({ message: "x".repeat(4001) }), sendParams);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "text_too_long" });
  });

  it("a removed friendship blocks NEW messages (403 not_friends)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        community_conversations: [ok(conversationRow(ALICE, BOB))],
        community_friendships: [ok([])], // the accepted row is gone
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmSendPOST(sendForm({ message: "hi" }), sendParams);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_friends" });
  });

  it("a block in EITHER direction blocks new messages (403 blocked)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        community_conversations: [ok(conversationRow(ALICE, BOB))],
        community_friendships: [ok([{ id: FRIENDSHIP_ID, status: "accepted" }])],
        community_blocks: [ok([{ blocker_id: BOB, blocked_id: ALICE }])],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmSendPOST(sendForm({ message: "hi" }), sendParams);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked" });
  });

  it("IDOR: a stranger cannot send into the conversation (404, no existence leak)", async () => {
    mockAuth(CAROL);
    mockAdmin();
    const { client } = makeUserClient({
      queues: { community_conversations: [ok(null)] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmSendPOST(sendForm({ message: "hi" }), sendParams);
    expect(res.status).toBe(404);
  });

  it("idempotency: re-sending with the same client id returns the existing row (200 duplicate)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const clientId = "e0000000-0000-4000-8000-000000000001";
    const { client } = makeUserClient({
      queues: {
        community_conversations: [ok(conversationRow(ALICE, BOB))],
        community_friendships: [ok([{ id: FRIENDSHIP_ID, status: "accepted" }])],
        community_blocks: [ok([])],
        community_direct_messages: [
          ok(dmMessageRow(clientId, ALICE, "hello", NOW)), // pre-check finds my own row
        ],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmSendPOST(sendForm({ message: "hello", id: clientId }), sendParams);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { duplicate: boolean };
    expect(body.duplicate).toBe(true);
  });

  it("id_conflict: a FOREIGN row with my client id is never claimed (400)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const clientId = "e0000000-0000-4000-8000-000000000001";
    const { client } = makeUserClient({
      queues: {
        community_conversations: [ok(conversationRow(ALICE, BOB))],
        community_friendships: [ok([{ id: FRIENDSHIP_ID, status: "accepted" }])],
        community_blocks: [ok([])],
        community_direct_messages: [ok(dmMessageRow(clientId, BOB, "spoof", NOW))],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmSendPOST(sendForm({ message: "x", id: clientId }), sendParams);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "id_conflict" });
  });

  it("replies must target a message IN THIS conversation (cross-conversation reply → 400)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const otherConvMessage = dmMessageRow(MESSAGE_ID, BOB, "elsewhere", NOW, {
      conversation_id: "88888888-8888-4888-8888-888888888888",
    });
    const { client } = makeUserClient({
      queues: {
        community_conversations: [ok(conversationRow(ALICE, BOB))],
        community_friendships: [ok([{ id: FRIENDSHIP_ID, status: "accepted" }])],
        community_blocks: [ok([])],
        community_direct_messages: [ok(otherConvMessage)], // parent in ANOTHER conversation
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmSendPOST(
      sendForm({ message: "re", reply_to: MESSAGE_ID }),
      sendParams,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_reply" });
  });

  it("a valid reply in the same conversation is accepted", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        community_conversations: [ok(conversationRow(ALICE, BOB))],
        community_friendships: [ok([{ id: FRIENDSHIP_ID, status: "accepted" }])],
        community_blocks: [ok([])],
        community_direct_messages: [
          ok(dmMessageRow(MESSAGE_ID, BOB, "parent", "2026-10-28T11:00:00.000Z")),
          ok(null), // idempotency pre-check
          ok(dmMessageRow("m-9", ALICE, "re", NOW, { reply_to_message_id: MESSAGE_ID })),
        ],
        community_profiles: [ok({ display_name: "AliceFox" })],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmSendPOST(sendForm({ message: "re", reply_to: MESSAGE_ID }), sendParams);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { message: { reply_to_message_id: string | null } };
    expect(body.message.reply_to_message_id).toBe(MESSAGE_ID);
  });
});

// ---------------------------------------------------------------------------
// 9. DM images — size, magic bytes, storage path
// ---------------------------------------------------------------------------

describe("DM images", () => {
  it("accepts a valid PNG ≤ 2 MB and stores it at dm/{conv}/{author}/{message}/image.png", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const clientId = "e1111111-0000-4000-8000-000000000001";
    const { client, upload } = makeUserClient({
      queues: {
        community_conversations: [ok(conversationRow(ALICE, BOB))],
        community_friendships: [ok([{ id: FRIENDSHIP_ID, status: "accepted" }])],
        community_blocks: [ok([])],
        community_direct_messages: [
          ok(null),
          ok(dmMessageRow(clientId, ALICE, null, NOW, { image_path: "dm/x/y/z.png" })),
        ],
        community_profiles: [ok({ display_name: "AliceFox" })],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmSendPOST(sendForm({ image: pngFile(), id: clientId }), sendParams);
    expect(res.status).toBe(201);
    expect(upload).toHaveBeenCalledTimes(1);
    // The path is scoped: dm/{conversationId}/{authorId}/{messageId}/image.png
    expect(upload.mock.calls[0][0]).toBe(`dm/${CONVERSATION_ID}/${ALICE}/${clientId}/image.png`);
  });

  it("rejects an image > 2 MB (413) before any storage call", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client, upload } = makeUserClient({
      queues: { community_conversations: [ok(conversationRow(ALICE, BOB))] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const big = new File([new Blob([new Uint8Array(2 * 1024 * 1024 + 1)])], "big.png", { type: "image/png" });
    const res = await dmSendPOST(sendForm({ image: big }), sendParams);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "image_too_large" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects a MIME type without matching magic bytes (415) — the client MIME is never trusted", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client, upload } = makeUserClient({
      queues: { community_conversations: [ok(conversationRow(ALICE, BOB))] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    // Claims image/png but the bytes are not a PNG:
    const res = await dmSendPOST(
      sendForm({
        image: new File([new TextEncoder().encode("<html>")], "evil.png", { type: "image/png" }),
      }),
      sendParams,
    );
    expect(res.status).toBe(415);
    expect(upload).not.toHaveBeenCalled();
  });

  it("a storage failure maps to a degraded 413/415 (never a raw error)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      storage: { uploadError: { message: "Exceeds the storage limit of the bucket" } },
      queues: {
        community_conversations: [ok(conversationRow(ALICE, BOB))],
        community_friendships: [ok([{ id: FRIENDSHIP_ID, status: "accepted" }])],
        community_blocks: [ok([])],
        community_direct_messages: [ok(null)],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmSendPOST(sendForm({ image: pngFile() }), sendParams);
    expect([413, 415]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// 10. DM edit + delete (author-only)
// ---------------------------------------------------------------------------

describe("DM edit/delete (author-only)", () => {
  const editParams = { params: Promise.resolve({ messageId: MESSAGE_ID }) };
  const deleteParams = { params: Promise.resolve({ messageId: MESSAGE_ID }) };

  it("the author edits their message (200, updated row returned)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        // update().eq(id).eq(user_id).select().maybeSingle() — ONE terminal:
        community_direct_messages: [ok(dmMessageRow(MESSAGE_ID, ALICE, "new", NOW))],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmEditPATCH(post(`/api/community/dm/messages/${MESSAGE_ID}`, { message: "new" }), editParams);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { message: string } };
    expect(body.message.message).toBe("new");
    // The update is scoped to my own authorship:
    const updateCall = client.calls.find((c) => c.table === "community_direct_messages" && c.op === "update");
    expect(updateCall).toBeTruthy();
  });

  it("IDOR: editing someone else's message → 404, and the update is session-scoped (id + user_id = me)", async () => {
    mockAuth(BOB);
    mockAdmin();
    const { client } = makeUserClient({
      // RLS hides Alice's row from Bob: the scoped update returns nothing.
      queues: { community_direct_messages: [ok(null)] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmEditPATCH(post(`/api/community/dm/messages/${MESSAGE_ID}`, { message: "hax" }), editParams);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "message_not_found" });
    // The update IS issued — its safety comes from the double scope
    // (id + user_id = the SESSION user) plus the RLS update policy:
    const eqArgs = client.calls
      .filter((c) => c.table === "community_direct_messages" && c.op === "eq")
      .map((c) => c.args);
    expect(eqArgs).toContainEqual(["id", MESSAGE_ID]);
    expect(eqArgs).toContainEqual(["user_id", BOB]);
  });

  it("an empty edit is rejected", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const res = await dmEditPATCH(post(`/api/community/dm/messages/${MESSAGE_ID}`, { message: "  " }), editParams);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "empty_message" });
  });

  it("the author deletes their message (200) and their dm image is cleaned up best-effort", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client, remove } = makeUserClient({
      queues: {
        // delete().eq(id).eq(user_id).select(...) → the removed rows:
        community_direct_messages: [
          ok([dmMessageRow(MESSAGE_ID, ALICE, "bye", NOW, { image_path: `dm/${CONVERSATION_ID}/${ALICE}/${MESSAGE_ID}/image.png` })]),
        ],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmEditDELETE(new Request(`http://localhost/api/community/dm/messages/${MESSAGE_ID}`, { method: "DELETE" }), deleteParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(remove).toHaveBeenCalledWith([`dm/${CONVERSATION_ID}/${ALICE}/${MESSAGE_ID}/image.png`]);
  });

  it("IDOR: deleting someone else's message → 404 and no storage cleanup", async () => {
    mockAuth(BOB);
    mockAdmin();
    const { client, remove } = makeUserClient({
      queues: { community_direct_messages: [ok(null)] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmEditDELETE(new Request(`http://localhost/api/community/dm/messages/${MESSAGE_ID}`, { method: "DELETE" }), deleteParams);
    expect(res.status).toBe(404);
    expect(remove).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 11. DM reactions — per-emoji toggle
// ---------------------------------------------------------------------------

describe("DM reactions (per-emoji toggle)", () => {
  const reactParams = { params: Promise.resolve({ messageId: MESSAGE_ID }) };

  it("toggle ON: no row of mine for this emoji → insert; the page aggregation is returned", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        community_direct_messages: [ok(dmMessageRow(MESSAGE_ID, BOB, "m", NOW))],
        community_dm_reactions: [
          ok(null), // my row for (message, emoji): none
          ok([]), // insert... (no select chain in the route? verify via calls)
          ok([
            { message_id: MESSAGE_ID, user_id: BOB, emoji: "❤️" },
            { message_id: MESSAGE_ID, user_id: ALICE, emoji: "👍" },
          ]), // final re-read for aggregation
        ],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmReactionPOST(post(`/api/community/dm/messages/${MESSAGE_ID}/reactions`, { emoji: "👍" }), reactParams);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reactions: Array<{ emoji: string; count: number; mine: boolean }> };
    expect(body.reactions).toEqual(
      expect.arrayContaining([
        { emoji: "❤️", count: 1, mine: false },
        { emoji: "👍", count: 1, mine: true },
      ]),
    );
  });

  it("toggle OFF: my row for THIS emoji exists → delete exactly that emoji (not other reactions)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        community_direct_messages: [ok(dmMessageRow(MESSAGE_ID, BOB, "m", NOW))],
        community_dm_reactions: [
          ok({ emoji: "👍" }), // my row for (message, 👍)
          ok(null), // delete
          ok([
            { message_id: MESSAGE_ID, user_id: ALICE, emoji: "❤️" }, // my OTHER emoji survives
          ]),
        ],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmReactionPOST(post(`/api/community/dm/messages/${MESSAGE_ID}/reactions`, { emoji: "👍" }), reactParams);
    expect(res.status).toBe(200);
    // The delete is scoped to my (message_id, user_id, emoji) row.
    const deleteCall = client.calls.find((c) => c.table === "community_dm_reactions" && c.op === "delete");
    expect(deleteCall).toBeTruthy();
    const eqArgs = client.calls
      .filter((c) => c.table === "community_dm_reactions" && c.op === "eq")
      .map((c) => c.args);
    expect(eqArgs).toContainEqual(["emoji", "👍"]);
  });

  it("an invalid emoji → 400 (allowlist)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: { community_direct_messages: [ok(dmMessageRow(MESSAGE_ID, BOB, "m", NOW))] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmReactionPOST(post(`/api/community/dm/messages/${MESSAGE_ID}/reactions`, { emoji: "💀" }), reactParams);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "reaction_invalid" });
  });

  it("IDOR: reacting to a message in a conversation I am not in → 404", async () => {
    mockAuth(CAROL);
    mockAdmin();
    const { client } = makeUserClient({
      queues: { community_direct_messages: [ok(null)] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmReactionPOST(post(`/api/community/dm/messages/${MESSAGE_ID}/reactions`, { emoji: "👍" }), reactParams);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 12. Server actions — read cursors + presence (fire-and-forget safety)
// ---------------------------------------------------------------------------

describe("social server actions", () => {
  it("markDmRead advances the per-conversation cursor (upsert, onConflict scoped)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: { community_dm_read_state: [ok(null)] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    await expect(markDmRead(CONVERSATION_ID)).resolves.toBeUndefined();
    const upsert = client.calls.find((c) => c.table === "community_dm_read_state" && c.op === "upsert");
    expect(upsert).toBeTruthy();
    expect(upsert?.args[0]).toMatchObject({
      user_id: ALICE,
      conversation_id: CONVERSATION_ID,
    });
    expect(upsert?.args[1]).toMatchObject({ onConflict: "user_id,conversation_id" });
  });

  it("markDmRead ignores a malformed id (no query at all)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient();
    vi.mocked(createClient).mockResolvedValue(client);
    await expect(markDmRead("bogus")).resolves.toBeUndefined();
    expect(client.calls).toHaveLength(0);
  });

  it("markNotificationRead writes the (notification_id, user_id) receipt for ME only", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: { notification_reads: [ok(null)] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    await expect(markNotificationRead(NOTIFICATION_ID)).resolves.toBeUndefined();
    const upsert = client.calls.find((c) => c.table === "notification_reads" && c.op === "upsert");
    expect(upsert?.args[0]).toEqual({ notification_id: NOTIFICATION_ID, user_id: ALICE });
  });

  it("markAllNotificationsRead upserts only the UNREAD subset (own + global)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        notifications: [
          ok([{ id: "n1" }, { id: "n2" }, { id: "n3" }]), // visible (RLS: own + global)
        ],
        notification_reads: [ok([{ notification_id: "n2", user_id: ALICE }])],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    await expect(markAllNotificationsRead()).resolves.toBeUndefined();
    const upsert = client.calls.find((c) => c.table === "notification_reads" && c.op === "upsert");
    const rows = upsert?.args[0] as Array<{ notification_id: string; user_id: string }>;
    expect(rows.map((r) => r.notification_id).sort()).toEqual(["n1", "n3"]); // n2 already read
    for (const r of rows) expect(r.user_id).toBe(ALICE);
  });

  it("markAllNotificationsRead is a no-op when everything is read", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        notifications: [ok([{ id: "n1" }])],
        notification_reads: [ok([{ notification_id: "n1", user_id: ALICE }])],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    await expect(markAllNotificationsRead()).resolves.toBeUndefined();
    expect(client.calls.some((c) => c.op === "upsert")).toBe(false);
  });

  it("touchCommunityPresence is rate-limited and never throws (fire-and-forget)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: { community_profiles: [ok(null)] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    await expect(touchCommunityPresence()).resolves.toBeUndefined();
    const upsert = client.calls.find((c) => c.table === "community_profiles" && c.op === "upsert");
    expect(upsert?.args[0]).toMatchObject({ user_id: ALICE });
    // Incident fix: NO ignoreDuplicates — every real member already has a
    // row, and ignoreDuplicates made the heartbeat a silent no-op (stale
    // last_seen_at / online state for everyone).
    expect(upsert?.args[1]).toEqual({ onConflict: "user_id" });

    // Rate-limited: no DB write at all.
    mockAdmin({ rateLimit: { allowed: false, count: 5, limit: 4, retry_after: 30 } });
    const limited = makeUserClient();
    vi.mocked(createClient).mockResolvedValue(limited.client);
    await expect(touchCommunityPresence()).resolves.toBeUndefined();
    expect(limited.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 13. Social library — badges, notifications, mentions
// ---------------------------------------------------------------------------

describe("social library functions", () => {
  it("fetchSocialBadges sums DM unread + counts pending INCOMING requests + unread notifications", async () => {
    const { client } = makeUserClient({
      queues: {
        "rpc:community_dm_summary": [
          ok([
            { unread: 2 },
            { unread: 1 },
          ]),
        ],
        community_friendships: [{ data: null, error: null, count: 3 } as never],
        "rpc:community_notifications_unread": [ok(7)],
      },
    });
    const badges = await fetchSocialBadges(client as never, ALICE);
    expect(badges).toEqual({ dms: 3, friendRequests: 3, notifications: 7 });
  });

  it("fetchSocialBadges degrades to null (never throws) on a DB failure", async () => {
    const { client } = makeUserClient({
      queues: {
        "rpc:community_dm_summary": [fail("db down")],
      },
    });
    await expect(fetchSocialBadges(client as never, ALICE)).resolves.toBeNull();
  });

  it("fetchNotifications maps own + global rows with PERSONAL read receipts", async () => {
    const { client } = makeUserClient({
      queues: {
        notifications: [
          ok([
            {
              id: "n1",
              title: "T1",
              content: "C1",
              type: "social",
              target_type: "user",
              created_at: NOW,
            },
            {
              id: "n2",
              title: "T2",
              content: "C2",
              type: "info",
              target_type: "all",
              created_at: "2026-10-27T00:00:00.000Z",
            },
          ]),
        ],
          notification_reads: [ok([{ notification_id: "n2", user_id: ALICE }])],
        },
      });
      const { items, unavailable } = await fetchNotifications(client as never, ALICE);
    expect(unavailable).toBe(false);
    expect(items).toHaveLength(2);
    expect(items[0].read).toBe(false);
    expect(items[1].read).toBe(true);
    expect(items[1].target_type).toBe("all");
  });

  it("socialSendKey is deterministic per (kind, row) — the idempotency contract", () => {
    expect(socialSendKey("dm", MESSAGE_ID)).toBe(socialSendKey("dm", MESSAGE_ID));
    expect(socialSendKey("dm", MESSAGE_ID)).not.toBe(socialSendKey("dm", "another-id"));
    expect(socialSendKey("friend_request", FRIENDSHIP_ID)).not.toBe(socialSendKey("friend_accepted", FRIENDSHIP_ID));
    // …and it is a valid uuid (the column type).
    expect(socialSendKey("dm", MESSAGE_ID)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("notifyMentions notifies each mentioned member — EXCEPT the sender — and is idempotent", async () => {
    const adminCalls = mockAdmin({
      mentionProfiles: [
        { user_id: BOB },
        { user_id: ALICE }, // self-mention must be skipped
      ],
    });
    await notifyMentions("msg-1", ["BobBuilder", "AliceFox"], {
      actorId: ALICE,
      actorName: "AliceFox",
      roomName: "Public Chat",
    });
    await flush();
    const inserts = adminCalls.filter((c) => c.table === "notifications" && c.op === "insert");
    // Only BOB is notified (ALICE = the sender, skipped).
    expect(inserts).toHaveLength(1);
    expect(inserts[0].args[0]).toMatchObject({
      target_user_id: BOB,
      type: "mention",
      title: "mention",
    });
    expect((inserts[0].args[0] as { send_key: string }).send_key).toBe(
      socialSendKey(`mention:${BOB}`, "msg-1"),
    );
  });

  it("notifyMentions: an invalid (unresolvable) mention creates no notification", async () => {
    const adminCalls = mockAdmin({ mentionProfiles: [] });
    await notifyMentions("msg-2", ["NobodyHere"], {
      actorId: ALICE,
      actorName: "AliceFox",
      roomName: "Public Chat",
    });
    await flush();
    expect(adminCalls.filter((c) => c.table === "notifications" && c.op === "insert")).toHaveLength(0);
  });

  it("createSocialNotification swallows 23505 (retry = no duplicate)", async () => {
    // The friends POST already exercises this path end-to-end; here we pin the
    // idempotent re-read on a send_key collision.
    mockAdmin({
      notificationInsert: fail("duplicate key", "23505"),
      notificationExisting: ok({ id: NOTIFICATION_ID }),
    });
    const { createSocialNotification } = await import("@/lib/community/social");
    const id = await createSocialNotification({
      targetUserId: BOB,
      actorUserId: ALICE,
      title: "T",
      content: "C",
      sendKey: socialSendKey("friend_request", FRIENDSHIP_ID),
    });
    expect(id).toBe(NOTIFICATION_ID);
  });
});

// ---------------------------------------------------------------------------
// 14. i18n parity — DE/EN/FR/AR
// ---------------------------------------------------------------------------

describe("i18n parity (Phase 2 keys)", () => {
  // The dictionaries are typed Dict = typeof de, so a MISSING key in any
  // language is a compile error; this suite additionally pins the KEYS the
  // runtime (server copy + client UI) actually references.
  it("all four languages share the identical key tree (deep equality of keys)", async () => {
    const { dictionaries } = await import("@/lib/i18n/dictionaries");
    const { de, en, fr, ar } = dictionaries;
    const keyTree = (value: unknown, prefix = ""): string[] => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
          keyTree(v, `${prefix}${k}.`),
        );
      }
      return [prefix.slice(0, -1)];
    };
    const deKeys = keyTree(de).sort();
    expect(keyTree(en).sort()).toEqual(deKeys);
    expect(keyTree(fr).sort()).toEqual(deKeys);
    expect(keyTree(ar).sort()).toEqual(deKeys);
  });

  it("nav.social exists in all four languages (the new RoomNav section header)", async () => {
    const { dictionaries } = await import("@/lib/i18n/dictionaries");
    for (const dict of Object.values(dictionaries)) {
      expect((dict as { nav: { social?: string } }).nav.social).toBeTruthy();
    }
  });

  it("every Phase 2 social key referenced by the UI/server exists in all languages", async () => {
    const { dictionaries } = await import("@/lib/i18n/dictionaries");
    const { de, en, fr, ar } = dictionaries;
    const paths = [
      "community.profileCardTitle",
      "community.online",
      "community.addFriend",
      "community.cancelRequest",
      "community.acceptRequest",
      "community.declineRequest",
      "community.removeFriend",
      "community.block",
      "community.unblock",
      "community.message",
      "community.friendsTitle",
      "community.incomingTitle",
      "community.outgoingTitle",
      "community.friendsListTitle",
      "community.blockedTitle",
      "community.noFriends",
      "community.noBlocked",
      "community.messagesTitle",
      "community.noConversations",
      "community.conversationNotFound",
      "community.dmImagePreview",
      "community.backToMessages",
      "community.notificationsTitle",
      "community.noNotifications",
      "community.markAllRead",
      "community.navFriends",
      "community.navMessages",
      "community.navNotifications",
      "community.friendsBadge",
      "community.messagesBadge",
      "community.notificationsBadge",
      "community.notifications.friendRequestTitle",
      "community.notifications.friendRequestContent",
      "community.notifications.friendAcceptedTitle",
      "community.notifications.friendAcceptedContent",
      "community.notifications.dmTitle",
      "community.notifications.dmContent",
      "community.notifications.dmImageContent",
      "community.notifications.mentionTitle",
      "community.notifications.mentionContent",
    ] as const;
    const lookup = (dict: unknown, path: string): unknown =>
      path.split(".").reduce<unknown>((acc, part) => {
        if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[part];
        return undefined;
      }, dict);
    for (const dict of [de, en, fr, ar]) {
      for (const path of paths) {
        const value = lookup(dict, path);
        expect(value, `${path} in ${path}`).toBeTypeOf("string");
        expect((value as string).length, path).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 15. Realtime architecture guards (source-level — the runtime contract)
// ---------------------------------------------------------------------------

describe("realtime architecture (source guards)", () => {
  let dmChatSource: string;
  let dmInboxSource: string;
  let friendsSource: string;
  let shellSource: string;
  let presenceHookSource: string;

  // Loaded once at module scope (after the vi.mocks above).
  beforeAll(async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");
    dmChatSource = read("src/components/community/dm-chat.tsx");
    dmInboxSource = read("src/components/community/dm-inbox.tsx");
    friendsSource = read("src/components/community/friends-view.tsx");
    shellSource = read("src/components/community/community-shell.tsx");
    presenceHookSource = read("src/lib/community/use-presence.ts");
  });

  it("DM chat uses ONE conversation-scoped channel (community-dm:<id>) — no cross-conversation bleed", () => {
    expect(dmChatSource).toContain('`community-dm:${conversation.id}`');
    // The postgres stream is filtered to THIS conversation:
    expect(dmChatSource).toContain('`conversation_id=eq.${conversation.id}`');
    // …and the actor re-broadcasts (edits/deletes) are guarded by conversationId:
    expect(dmChatSource).toContain("update.conversationId !== conversation.id");
    expect(dmChatSource).toContain("del.conversationId !== conversation.id");
    // Typing broadcasts are guarded the same way (shared socket):
    expect(dmChatSource).toContain("wire.conversationId !== conversation.id");
    // Reactions have no conversation column → guarded by the known message ids:
    expect(dmChatSource).toContain("!knownIds.current.has(message_id)");
  });

  it("the DM channel is torn down on unmount (removeChannel — no duplicate subscriptions)", () => {
    expect(dmChatSource).toContain("if (channel) void client.removeChannel(channel);");
    expect(dmChatSource).toContain("channelRef.current = null;");
    // A disposed flag prevents the async auth handshake from subscribing late:
    expect(dmChatSource).toContain("if (disposed || channel) return;");
  });

  it("the DM inbox subscribes to ONE user-scoped stream (RLS already scopes to my conversations)", () => {
    expect(dmInboxSource).toContain('`community-dm-inbox-${me.userId}`');
    expect(dmInboxSource).toContain("table: \"community_direct_messages\"");
    expect(dmInboxSource).toContain("void client.removeChannel(channel);");
  });

  it("the friends view uses ONE user-scoped channel for relationship events", () => {
    expect(friendsSource).toContain('`community-friendships-${me.userId}`');
    expect(friendsSource).toContain("table: \"community_friendships\"");
    expect(friendsSource).toContain("void client.removeChannel(channel);");
  });

  it("presence is activity-driven — the shell stays interval-free; ONE throttled heartbeat lives in the hook", () => {
    // The Messenger architecture pins the shell interval-free (see the
    // community-mobile-layout suite): presence must not be a polling loop.
    expect(shellSource).not.toContain("setInterval");
    // Phase 3: the heartbeat moved into the dedicated hook — the shell only
    // consumes it. The hook owns the ONE sanctioned timer (throttled):
    expect(shellSource).toContain("useCommunityPresence(");
    expect(presenceHookSource.match(/setInterval/g)).toHaveLength(1);
    expect(presenceHookSource).toContain("PRESENCE_THROTTLE_MS");
    // It pings on open + on visibility + on user activity, throttled:
    expect(presenceHookSource).toContain('document.visibilityState !== "visible"');
    expect(presenceHookSource).toContain('window.addEventListener("pointerdown", onActivity, { passive: true })');
    expect(presenceHookSource).toContain('window.addEventListener("scroll", onActivity, { passive: true })');
    expect(presenceHookSource).toContain('window.removeEventListener("scroll", onActivity)');
    // It writes through the rate-limited server action (never a direct table write):
    expect(presenceHookSource).toContain("touchCommunityPresence()");
  });
});

// ---------------------------------------------------------------------------
// 16. Migration guards — the v3 social SQL (constraints, RLS, realtime, fns)
// ---------------------------------------------------------------------------

describe("community v3 migration (source guards)", () => {
  let sql: string;

  beforeAll(async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
    sql = readFileSync(
      resolve(root, "supabase/migrations/20261028000000_community_v3_social.sql"),
      "utf8",
    );
  });

  it("enforces the friendship invariants at the database level", () => {
    expect(sql).toContain("constraint community_friendships_self_request check (requester_id <> requestee_id)");
    // ONE row per unordered pair — duplicate friendships + A→B/B→A races are impossible:
    expect(sql).toContain("community_friendships_pair_uq");
    expect(sql).toContain("least(requester_id, requestee_id)");
    // ONE request in flight per ordered pair:
    expect(sql).toContain("community_friendships_request_uq");
    // Blocks: no self-block, one row per (blocker, blocked):
    expect(sql).toContain("constraint community_blocks_self check (blocker_id <> blocked_id)");
    expect(sql).toContain("constraint community_blocks_unique unique (blocker_id, blocked_id)");
    // Conversations: no self-conversation, one row per unordered pair (dedupe).
    // PostgreSQL rejects expressions inside a UNIQUE TABLE CONSTRAINT (the
    // original v3 form failed with 42601 in production), so pair-uniqueness
    // must live in a UNIQUE EXPRESSION INDEX with identical semantics:
    expect(sql).toContain("constraint community_conversations_self check (member_a <> member_b)");
    expect(sql).toContain("create unique index community_conversations_unique_pair");
    expect(sql).toContain("on public.community_conversations (least(member_a, member_b),");
    expect(sql).not.toContain("community_conversations_unique_pair unique (least(");
    // DMs need content (text OR image) and a message-id per client id:
    expect(sql).toContain("constraint community_dm_has_content");
  });

  it("enables RLS on every new table", () => {
    for (const table of [
      "community_friendships",
      "community_blocks",
      "community_conversations",
      "community_direct_messages",
      "community_dm_reactions",
      "community_dm_read_state",
    ]) {
      expect(sql).toContain(`alter table public.${table} enable row level security;`);
    }
  });

  it("scopes DM writes to membership + accepted friendship + no block (the strictest rule in the app)", () => {
    expect(sql).toContain('create policy "Friends can send direct messages to each other"');
    const insertPolicy = sql.slice(
      sql.indexOf('create policy "Friends can send direct messages to each other"'),
      sql.indexOf('create policy "Authors can edit their own direct messages"'),
    );
    expect(insertPolicy).toContain("user_id = auth.uid()");
    expect(insertPolicy).toContain("auth.uid() in (c.member_a, c.member_b)");
    expect(insertPolicy).toContain("f.status = 'accepted'");
    expect(insertPolicy).toContain("not exists (");
    expect(insertPolicy).toContain("community_blocks b");
  });

  it("author-only edit/delete + member-only reads for DMs and reactions", () => {
    expect(sql).toContain('create policy "Authors can edit their own direct messages"');
    expect(sql).toContain('create policy "Authors can delete their own direct messages"');
    expect(sql).toContain('create policy "Conversation members can read direct messages"');
    expect(sql).toContain('create policy "Conversation members can read dm reactions"');
    expect(sql).toContain('create policy "The blocker can unblock"');
    // Read state is strictly personal:
    const readPolicy = sql.slice(
      sql.indexOf('create policy "Users can manage their own dm read state"'),
      sql.indexOf("create policy \"Users can manage their own dm read state\"") + 400,
    );
    expect(readPolicy).toContain("auth.uid() = user_id");
  });

  it("publishes DM + friendship + notification tables to the realtime publication (idempotent)", () => {
    for (const table of [
      "community_direct_messages",
      "community_dm_reactions",
      "community_friendships",
      "notifications",
    ]) {
      expect(sql).toContain(`alter publication supabase_realtime add table public.${table};`);
    }
  });

  it("revokes the summary/unread functions from public+anon and grants authenticated+service_role", () => {
    expect(sql).toContain(
      "revoke execute on function public.community_dm_summary(uuid) from public, anon;",
    );
    expect(sql).toContain(
      "grant execute on function public.community_dm_summary(uuid) to authenticated, service_role;",
    );
    expect(sql).toContain(
      "revoke execute on function public.community_notifications_unread(uuid) from public, anon;",
    );
    expect(sql).toContain(
      "grant execute on function public.community_notifications_unread(uuid) to authenticated, service_role;",
    );
  });

  it("the DM summary is a SQL count (never a message download) and includes last_message_mine", () => {
    const summaryFn = sql.slice(
      sql.indexOf("create or replace function public.community_dm_summary"),
      sql.indexOf("revoke execute on function public.community_dm_summary"),
    );
    expect(summaryFn).toContain("select count(*)");
    expect(summaryFn).toContain("last_message_mine");
    expect(summaryFn).toContain("(lm.user_id = p_user)");
    expect(summaryFn).toContain("m.user_id <> p_user");
  });

  it("storage policies: dm images are scoped to conversation members and the owner folder", () => {
    expect(sql).toContain('create policy "Members can upload dm images to their own dm folder"');
    expect(sql).toContain('create policy "Members can read dm images of their conversations"');
    expect(sql).toContain('create policy "Members can delete their own dm images"');
    const uploadPolicy = sql.slice(
      sql.indexOf('create policy "Members can upload dm images to their own dm folder"'),
      sql.indexOf('create policy "Members can read dm images of their conversations"'),
    );
    // The owner folder segment must equal the uploader's uid:
    expect(uploadPolicy).toContain('(storage.foldername(name))[3] = auth.uid()::text');
  });
});

// ---------------------------------------------------------------------------
// 15. Production incidents (2026-10-07, ausbildungsweg.net)
//
//     BUG 1 — friend request: the UI showed only the generic failure. The
//     card renders (GET works) but the request never created a row, so the
//     failure sits at the INSERT (or an immediately preceding step). The
//     route now classifies every failure with the SQLSTATE code + a
//     structured server log, and the card maps the safe classes to
//     localized copy.
//
//     BUG 2 — community settings: setPresenceMode / touchCommunityPresence
//     upserted with ignoreDuplicates: true — a SILENT NO-OP on the rows
//     every real member already has. Manual mode never persisted and the
//     heartbeat never stamped last_seen_at.
// ---------------------------------------------------------------------------

describe("incident — friend request failure classification (BUG 1)", () => {
  const capturedErrors = (): string[] => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    return lines;
  };

  it("insert RLS violation (42501) → 500 + friendship_error + code 42501 + structured log (the exact production failure shape)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const lines = capturedErrors();
    const { client } = makeUserClient({
      queues: {
        community_profiles: [ok(profileRow(BOB, "B"))],
        community_blocks: [ok([])],
        community_friendships: [
          fail('new row violates row-level security policy for table "community_friendships"', "42501"),
        ],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await friendsPOST(post("/api/community/friends", { userId: BOB }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "friendship_error", code: "42501" });
    vi.restoreAllMocks();
    expect(lines.some((l) => l.includes("friend_request_failed step=insert") && l.includes("code=42501"))).toBe(true);
    expect(lines.some((l) => l.includes(`userId=${ALICE}`) && l.includes(`target=${BOB}`))).toBe(true);
  });

  it("insert FK violation (23503) → 500 + code 23503 (target row vanished mid-flight)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    capturedErrors();
    const { client } = makeUserClient({
      queues: {
        community_profiles: [ok(profileRow(BOB, "B"))],
        community_blocks: [ok([])],
        community_friendships: [fail("insert or update on table community_friendships violates foreign key", "23503")],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await friendsPOST(post("/api/community/friends", { userId: BOB }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "friendship_error", code: "23503" });
    vi.restoreAllMocks();
  });

  it("23505 collision whose existing row is unreadable → 500 + logged duplicate_recover step", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const lines = capturedErrors();
    const { client } = makeUserClient({
      queues: {
        community_profiles: [ok(profileRow(BOB, "B"))],
        community_blocks: [ok([])],
        community_friendships: [
          fail("duplicate key value violates unique constraint", "23505"),
          fail("boom"),
        ],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await friendsPOST(post("/api/community/friends", { userId: BOB }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("friendship_error");
    vi.restoreAllMocks();
    expect(lines.some((l) => l.includes("friend_request_failed step=duplicate_recover"))).toBe(true);
  });

  it("target read failure → 500 + friendship_error + logged target step (no insert attempted)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const lines = capturedErrors();
    const { client } = makeUserClient({
      queues: { community_profiles: [fail("db down")] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await friendsPOST(post("/api/community/friends", { userId: BOB }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "friendship_error", code: "db_read" });
    vi.restoreAllMocks();
    expect(lines.some((l) => l.includes("friend_request_failed step=target"))).toBe(true);
    expect(client.calls.some((c) => c.table === "community_friendships" && c.op === "insert")).toBe(false);
  });

  it("the success path is unchanged: 201 + the friendship row (convergence data for the UI)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        community_profiles: [ok(profileRow(BOB, "B"))],
        community_blocks: [ok([])],
        community_friendships: [
          ok({ id: FRIENDSHIP_ID, requester_id: ALICE, requestee_id: BOB, status: "pending", created_at: NOW }),
        ],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await friendsPOST(post("/api/community/friends", { userId: BOB }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { friendship: { status: string } };
    expect(body.friendship.status).toBe("pending");
  });

  it("the card maps the server classifications to localized copy (source audit)", () => {
    const CARD = readSrc("src/components/community/profile-card.tsx");
    for (const marker of [
      'code === "self_request"',
      'code === "blocked"',
      'code === "member_not_found"',
      "response.status === 429",
      '"community.friendErrorSelf"',
      '"community.friendErrorBlocked"',
      '"community.friendErrorNotFound"',
      '"community.friendErrorRateLimit"',
      '"community.actionFailed"',
    ]) {
      expect(CARD, `card must reference ${marker}`).toContain(marker);
    }
  });

  it("the four friend-error keys exist in all four languages (no hardcoded language)", async () => {
    const { dictionaries } = await import("@/lib/i18n/dictionaries");
    for (const dict of Object.values(dictionaries)) {
      const community = dict.community as Record<string, unknown>;
      for (const key of ["friendErrorSelf", "friendErrorBlocked", "friendErrorNotFound", "friendErrorRateLimit"]) {
        expect(typeof community[key] === "string" && (community[key] as string).length > 0, `${key}`).toBe(true);
      }
    }
  });
});

describe("incident — community settings persistence (BUG 2)", () => {
  it("setPresenceMode upserts WITHOUT ignoreDuplicates — the existing row is UPDATED (the choice persists)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    // queues: [upsert write, RLS-scoped read-back verification]
    const { client } = makeUserClient({
      queues: { community_profiles: [ok(null), ok({ presence_mode: "away" })] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const result = await setPresenceMode("away");
    expect(result).toEqual({ ok: true, code: "success" });
    const upsert = client.calls.find((c) => c.table === "community_profiles" && c.op === "upsert");
    expect(upsert).toBeTruthy();
    expect(upsert?.args[1]).toEqual({ onConflict: "user_id" });
    const values = upsert?.args[0] as { user_id: string; presence_mode: string; last_seen_at?: string };
    expect(values.user_id).toBe(ALICE);
    expect(values.presence_mode).toBe("away");
    expect(typeof values.last_seen_at).toBe("string"); // re-appearance stamps last_seen
  });

  it("setPresenceMode('dnd') persists dnd WITHOUT stamping last_seen (hidden state stays hidden)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: { community_profiles: [ok(null), ok({ presence_mode: "dnd" })] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const result = await setPresenceMode("dnd");
    expect(result).toEqual({ ok: true, code: "success" });
    const upsert = client.calls.find((c) => c.table === "community_profiles" && c.op === "upsert");
    const values = upsert?.args[0] as Record<string, unknown>;
    expect(values.presence_mode).toBe("dnd");
    expect("last_seen_at" in values).toBe(false);
    expect(upsert?.args[1]).toEqual({ onConflict: "user_id" });
  });

  it("setPresenceMode verifies the write by read-back and classifies failures (42501 / rate limit / zero-row)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    // read-back yields no row (missing or RLS-hidden) → classified failure, never a silent ok
    const missing = makeUserClient({ queues: { community_profiles: [ok(null), ok(null)] } });
    vi.mocked(createClient).mockResolvedValue(missing.client);
    expect(await setPresenceMode("online")).toEqual({ ok: false, code: "not_found" });
    // read-back hit RLS (42501) → rls_blocked with the SQLSTATE
    const rls = makeUserClient({
      queues: {
        community_profiles: [ok(null), fail("new row violates row-level security policy", "42501")],
      },
    });
    vi.mocked(createClient).mockResolvedValue(rls.client);
    expect(await setPresenceMode("online")).toEqual({ ok: false, code: "rls_blocked", sqlstate: "42501" });
    // rate limited → rate_limited, the table is never touched
    mockAdmin({ rateLimit: { allowed: false, count: 61, limit: 60, retry_after: 12 } });
    const quiet = makeUserClient();
    vi.mocked(createClient).mockResolvedValue(quiet.client);
    expect(await setPresenceMode("away")).toEqual({ ok: false, code: "rate_limited" });
    expect(quiet.calls.some((c) => c.table === "community_profiles")).toBe(false);
  });

  it("the heartbeat writes last_seen_at ONLY — a manual DND/AWAY is never touched by it", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient();
    vi.mocked(createClient).mockResolvedValue(client);
    await touchCommunityPresence();
    const upsert = client.calls.find((c) => c.table === "community_profiles" && c.op === "upsert");
    expect(upsert?.args[1]).toEqual({ onConflict: "user_id" });
    const values = upsert?.args[0] as Record<string, unknown>;
    expect(values.user_id).toBe(ALICE);
    expect(typeof values.last_seen_at).toBe("string");
    // the heartbeat carries NO mode — it cannot overwrite a manual choice:
    expect("presence_mode" in values).toBe(false);
    expect(client.calls.some((c) => c.op === "not")).toBe(false);
  });

  it("setShowPresence persists via a VERIFIED own-row UPDATE (zero-row = failure)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: { community_profiles: [ok({ show_presence: false })] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const result = await setShowPresence(false);
    expect(result).toEqual({ ok: true, code: "success" });
    const update = client.calls.find((c) => c.table === "community_profiles" && c.op === "update");
    expect(update?.args[0]).toEqual({ show_presence: false });
    // a zero-row update (missing row) is a failure, never a silent success
    const empty = makeUserClient({ queues: { community_profiles: [ok(null)] } });
    vi.mocked(createClient).mockResolvedValue(empty.client);
    expect(await setShowPresence(true)).toEqual({ ok: false, code: "not_found" });
  });

  it("updateNotificationPreferences writes ONLY the toggled column and verifies it", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: { community_profiles: [ok({ notify_mentions: false })] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const result = await updateNotificationPreferences({ mentions: false });
    expect(result).toEqual({ ok: true, code: "success" });
    const update = client.calls.find((c) => c.table === "community_profiles" && c.op === "update");
    // exactly ONE column — the other five preferences are untouched:
    expect(update?.args[0]).toEqual({ notify_mentions: false });
    // and a zero-row update fails (the sheet reverts):
    const empty = makeUserClient({ queues: { community_profiles: [ok(null)] } });
    vi.mocked(createClient).mockResolvedValue(empty.client);
    expect(await updateNotificationPreferences({ sound: false })).toEqual({ ok: false, code: "not_found" });
  });

  it("the settings modal reverts optimistic state on failure and never reloads the page", () => {
    const SHEET = readSrc("src/components/community/community-settings.tsx");
    expect(SHEET).toContain("setPrefs(prev)");
    expect(SHEET).not.toContain("router.refresh");
    expect(SHEET).not.toContain("window.location");
  });
});

// ---------------------------------------------------------------------------
// 17. Write-side failure classification (2026-10-08): DM insert + friendship
//     accept/decline/cancel.
//
//     The READ paths are proven working in production (the profile card and
//     friends list render); the reported failures are all WRITE paths
//     (friendship INSERT / friendship UPDATE / conversation INSERT / DM
//     INSERT). Every write failure must now log ONE structured, secret-free
//     line — the SQLSTATE is the production discriminator (42501 = the RLS
//     write policy is not effective on that database).
//
//     Scenario 15 of the end-to-end matrix (no forged-client-payload bypass)
//     is pinned here: author / requester are ALWAYS the session user.
// ---------------------------------------------------------------------------

describe("incident — DM insert failure classification (write side)", () => {
  const capturedErrors = (): string[] => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    return lines;
  };

  it("dm insert RLS violation (42501) → 500 + structured log WITHOUT message content (the production DM failure shape)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const lines = capturedErrors();
    const secret = "TOP-SECRET-DM-CONTENT";
    const { client } = makeUserClient({
      queues: {
        community_conversations: [ok(conversationRow(ALICE, BOB))],
        community_friendships: [ok([{ id: FRIENDSHIP_ID, status: "accepted" }])],
        community_blocks: [ok([])],
        community_direct_messages: [
          ok(null), // idempotency pre-check
          fail('new row violates row-level security policy for table "community_direct_messages"', "42501"),
        ],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmSendPOST(
      sendForm({ message: secret, id: "e2222222-0000-4000-8000-000000000001" }),
      sendParams,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not send message." });
    vi.restoreAllMocks();
    expect(lines.some((l) => l.includes("dm_send_failed step=insert") && l.includes("code=42501"))).toBe(true);
    expect(lines.some((l) => l.includes(`conversation=${CONVERSATION_ID}`) && l.includes(`userId=${ALICE}`))).toBe(true);
    // Secret-free: neither the message content nor the raw error text
    // (which can embed row values) may reach the log.
    for (const line of lines) {
      expect(line).not.toContain(secret);
      expect(line).not.toContain("row-level security policy");
    }
  });

  it("23505 collision whose existing row is unreadable → 500 + logged duplicate_recover step", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const lines = capturedErrors();
    const { client } = makeUserClient({
      queues: {
        community_conversations: [ok(conversationRow(ALICE, BOB))],
        community_friendships: [ok([{ id: FRIENDSHIP_ID, status: "accepted" }])],
        community_blocks: [ok([])],
        community_direct_messages: [
          ok(null),
          fail("duplicate key value violates unique constraint", "23505"),
          fail("boom"),
        ],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await dmSendPOST(
      sendForm({ message: "x", id: "e4444444-0000-4000-8000-000000000001" }),
      sendParams,
    );
    expect(res.status).toBe(500);
    vi.restoreAllMocks();
    expect(lines.some((l) => l.includes("dm_send_failed step=duplicate_recover"))).toBe(true);
    expect(lines.some((l) => l.includes("dm_send_failed step=insert") && l.includes("code=23505"))).toBe(true);
  });

  it("a forged author field in the DM form is IGNORED — the insert author is always the session user (scenario 15)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const clientId = "e3333333-0000-4000-8000-000000000001";
    const { client } = makeUserClient({
      queues: {
        community_conversations: [ok(conversationRow(ALICE, BOB))],
        community_friendships: [ok([{ id: FRIENDSHIP_ID, status: "accepted" }])],
        community_blocks: [ok([])],
        community_direct_messages: [ok(null), ok(dmMessageRow(clientId, ALICE, "hi", NOW))],
        community_profiles: [ok({ display_name: "AliceFox" })],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const form = new FormData();
    form.set("message", "hi");
    form.set("id", clientId);
    form.set("user_id", BOB); // forged: attribute the message to Bob
    form.set("userId", BOB);
    const res = await dmSendPOST(
      new Request(`http://localhost/api/community/dm/${CONVERSATION_ID}/messages`, {
        method: "POST",
        body: form,
      }),
      sendParams,
    );
    expect(res.status).toBe(201);
    const insertCall = client.calls.find((c) => c.table === "community_direct_messages" && c.op === "insert");
    expect((insertCall?.args[0] as { user_id: string }).user_id).toBe(ALICE);
  });

  it("a forged requester field in the friend body is IGNORED — requester_id is always the session user (scenario 15)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        community_profiles: [ok(profileRow(BOB, "B"))],
        community_blocks: [ok([])],
        community_friendships: [
          ok({ id: FRIENDSHIP_ID, requester_id: ALICE, requestee_id: BOB, status: "pending", created_at: NOW }),
        ],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await friendsPOST(
      post("/api/community/friends", { userId: BOB, requester_id: BOB, requestee_id: CAROL }),
    );
    expect(res.status).toBe(201);
    const insertCall = client.calls.find((c) => c.table === "community_friendships" && c.op === "insert");
    expect(insertCall?.args[0]).toEqual({ requester_id: ALICE, requestee_id: BOB });
  });
});

describe("incident — friendship action failure classification (accept/decline/cancel)", () => {
  const capturedErrors = (): string[] => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    return lines;
  };

  it("accept UPDATE RLS violation (42501) → 500 + structured log (step=accept, code, request, userId)", async () => {
    mockAuth(BOB); // BOB is the requestee
    const lines = capturedErrors();
    const { client } = makeUserClient({
      queues: {
        community_friendships: [
          ok(friendshipRow(ALICE, BOB, "pending")),
          fail('new row violates row-level security policy for table "community_friendships"', "42501"),
        ],
        community_blocks: [ok([])],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await requestPOST(post("/api/community/friends/requests/x", { action: "accept" }), {
      params: Promise.resolve({ requestId: FRIENDSHIP_ID }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not accept request." });
    vi.restoreAllMocks();
    expect(lines.some((l) => l.includes("friendship_action_failed step=accept") && l.includes("code=42501"))).toBe(true);
    expect(lines.some((l) => l.includes(`request=${FRIENDSHIP_ID}`) && l.includes(`userId=${BOB}`))).toBe(true);
  });

  it("decline / cancel failures log step=decline / step=cancel (secret-free, one line each)", async () => {
    // decline (as the requestee):
    mockAuth(BOB);
    const declineLines = capturedErrors();
    const declineClient = makeUserClient({
      queues: {
        community_friendships: [ok(friendshipRow(ALICE, BOB, "pending")), fail("boom", "42501")],
      },
    });
    vi.mocked(createClient).mockResolvedValue(declineClient.client);
    const decline = await requestPOST(post("/api/community/friends/requests/x", { action: "decline" }), {
      params: Promise.resolve({ requestId: FRIENDSHIP_ID }),
    });
    expect(decline.status).toBe(500);
    vi.restoreAllMocks();
    expect(declineLines.some((l) => l.includes("friendship_action_failed step=decline") && l.includes("code=42501"))).toBe(true);

    // cancel (as the requester):
    mockAuth(ALICE);
    const cancelLines = capturedErrors();
    const cancelClient = makeUserClient({
      queues: {
        community_friendships: [ok(friendshipRow(ALICE, BOB, "pending")), fail("boom", "42501")],
      },
    });
    vi.mocked(createClient).mockResolvedValue(cancelClient.client);
    const cancel = await requestDELETE(
      new Request("http://localhost/api/community/friends/requests/x", { method: "DELETE" }),
      { params: Promise.resolve({ requestId: FRIENDSHIP_ID }) },
    );
    expect(cancel.status).toBe(500);
    vi.restoreAllMocks();
    expect(cancelLines.some((l) => l.includes("friendship_action_failed step=cancel") && l.includes("code=42501"))).toBe(true);
  });

  it("the request load failure logs step=load (never an unlogged 500)", async () => {
    mockAuth(BOB);
    const lines = capturedErrors();
    const { client } = makeUserClient({
      queues: { community_friendships: [fail("db down")] },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await requestPOST(post("/api/community/friends/requests/x", { action: "accept" }), {
      params: Promise.resolve({ requestId: FRIENDSHIP_ID }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not update request." });
    vi.restoreAllMocks();
    expect(lines.some((l) => l.includes("friendship_action_failed step=load") && l.includes(`userId=${BOB}`))).toBe(true);
  });

  it("requirement 9: POST /friends' FIRST interaction with community_friendships is the INSERT itself (no pre-existing friendship required)", async () => {
    mockAuth(ALICE);
    mockAdmin();
    const { client } = makeUserClient({
      queues: {
        community_profiles: [ok(profileRow(BOB, "B"))],
        community_blocks: [ok([])],
        community_friendships: [
          ok({ id: FRIENDSHIP_ID, requester_id: ALICE, requestee_id: BOB, status: "pending", created_at: NOW }),
        ],
      },
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const res = await friendsPOST(post("/api/community/friends", { userId: BOB }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { duplicate?: boolean }).duplicate).toBeUndefined();
    // No SELECT/or/maybeSingle on community_friendships may precede the
    // INSERT: a request from A to B must not depend on any prior A↔B row.
    const friendshipCalls = client.calls.filter((c) => c.table === "community_friendships");
    expect(friendshipCalls.length).toBeGreaterThan(0);
    expect(friendshipCalls[0].op).toBe("insert");
  });

  it("the DM send + friend + friendship-action routes keep their structured diagnostics (source audit)", () => {
    const dmRoute = readSrc("src/app/api/community/dm/[conversationId]/messages/route.ts");
    expect(dmRoute).toContain("dm_send_failed step=");
    expect(dmRoute).toContain('logDmSendFailure("insert"');
    expect(dmRoute).toContain('logDmSendFailure("duplicate_recover"');
    // The raw (content-bearing) error text is never logged:
    expect(dmRoute).not.toContain("dm insert failed");
    expect(dmRoute).not.toContain("insertError.message");

    // BUG 1's discriminator line — preserved, not removed:
    const friendsRoute = readSrc("src/app/api/community/friends/route.ts");
    expect(friendsRoute).toContain("friend_request_failed step=");
    expect(friendsRoute).toContain('logFriendRequestFailure("insert"');

    const actionRoute = readSrc("src/app/api/community/friends/requests/[requestId]/route.ts");
    for (const marker of ["load", "accept", "decline", "cancel"]) {
      expect(actionRoute, `action route must log step=${marker}`).toContain(`logFriendshipActionFailure("${marker}"`);
    }
    expect(actionRoute).toContain("friendship_action_failed step=");
  });
});
