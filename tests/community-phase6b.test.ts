/**
 * Community Phase 6B — security hardening test suite.
 *
 * B-1 — Room-scoped storage READ policies for community-images:
 *   * v8 migration guards (SQL text: the exact obsolete policy is the only
 *     drop; the two replacements are row-pinned, fail-closed, non-dm-scoped;
 *     bucket privacy / uploads / 6A surface untouched; no 6C/6D/6F content)
 *   * policy BEHAVIOR via a literal TypeScript mirror of the v8 using()
 *     expressions (the guards pin the SQL text; the mirror exercises the
 *     authorization logic): member vs non-member, hidden, disabled room,
 *     block in either direction, DM participant vs outsider, path-knowledge
 *     bypass, malformed shapes, case-insensitive id matching
 *
 * B-2 — Suspend → LiveKit eviction:
 *   * admin token (HS256, minimal per-call grants, no identity, no secret
 *     leakage)
 *   * livekit-api eviction flow against a mocked LiveKit Server API
 *     (Twirp URLs, auth header, room derivation, per-request timeout,
 *     honest result states: not_configured / not_in_any_room / evicted /
 *     unavailable — never a fake success)
 *   * suspension integration: the sanction succeeds, eviction is
 *     best-effort + explicitly logged, unreachable SFU never blocks or
 *     fails the action, only `suspend_user` evicts
 *   * token-route regression: suspended/muted users get no NEW session,
 *     active users are unaffected
 *   * boundaries: eviction is server-only, no API endpoint exposes it,
 *     no client code imports the LiveKit admin surface
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { createClient } = await import("@/lib/supabase/server");
const { createAdminClient } = await import("@/lib/supabase/admin");
const {
  LIVEKIT_ADMIN_TOKEN_TTL_SECONDS,
  LIVEKIT_MAX_CANDIDATE_ROOMS,
  LIVEKIT_ROOM_PREFIX,
  createLiveKitAdminToken,
  evictLiveKitParticipant,
  liveKitApiBase,
} = await import("@/lib/voice/livekit-api");
const { performModerationAction } = await import("@/lib/community/moderation");
const { POST: voiceTokenPost } = await import("@/app/api/community/voice/token/route");

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const walk = (dir: string, acc: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) acc.push(full);
  }
  return acc;
};

const V8 = read("supabase/migrations/20261102000000_community_v8_image_read_policies.sql");
/** Executable SQL only — header comments (incl. the documented rollback) excluded. */
const V8_CODE = V8.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

// ---------------------------------------------------------------------------
// B-1 · v8 migration guards (SQL text)
// ---------------------------------------------------------------------------
describe("B-1 · v8 migration guards", () => {
  const policyNames = [...V8_CODE.matchAll(/create policy "([^"]+)"/g)].map((m) => m[1]);
  const droppedNames = [...V8_CODE.matchAll(/drop policy if exists "([^"]+)"/g)].map((m) => m[1]);

  it("drops EXACTLY the one obsolete broad-read policy", () => {
    expect(droppedNames).toEqual(["Community members can read community images"]);
  });

  it("creates EXACTLY two SELECT policies (message images + question images)", () => {
    expect(policyNames).toEqual([
      "Room-scoped members can read message images",
      "Room-scoped members can read question images",
    ]);
    const selectCount = (V8_CODE.match(/for select to authenticated/g) ?? []).length;
    expect(selectCount).toBe(2);
    expect(V8_CODE).not.toMatch(/for (insert|update|delete)/);
  });

  it("message policy is row-pinned and fail-closed (live row, exact path, non-hidden, enabled room)", () => {
    const msg = V8_CODE.split('create policy "Room-scoped members can read message images"')[1]
      .split(");")[0];
    expect(msg).toContain("community_messages");
    expect(msg).toContain("bucket_id = 'community-images'");
    expect(msg).toContain("(storage.foldername(name))[1] <> 'dm'");
    expect(msg).toContain("m.image_path = name");
    expect(msg).toContain("m.hidden_by is null");
    expect(msg).toContain("r.enabled");
    // no raising casts on path segments (text comparison only)
    expect(msg).not.toMatch(/\[2\]::uuid/);
    expect(msg).not.toMatch(/\[1\]::uuid/);
  });

  it("question policy mirrors the question read RLS (enabled room + block in EITHER direction)", () => {
    const q = V8.split('create policy "Room-scoped members can read question images"')[1].split(");")[0];
    expect(q).toContain("community_questions");
    expect(q).toContain("q.image_path = name");
    expect(q).toContain("r.enabled");
    expect(q).toContain("community_blocks");
    expect(q).toContain("b.blocker_id = auth.uid() and b.blocked_id = q.author_id");
    expect(q).toContain("b.blocker_id = q.author_id and b.blocked_id = auth.uid()");
    expect(q).not.toMatch(/\[2\]::uuid/);
  });

  it("reintroduces NO broad bucket read (every SELECT policy row-pins a live DB row)", () => {
    const selects = V8_CODE.split("create policy").slice(1);
    for (const block of selects) {
      expect(block).toMatch(/exists \(\s*select 1\s+from public\.(community_messages|community_questions)/);
    }
  });

  it("leaves the bucket PRIVATE and all other storage policies untouched", () => {
    expect(V8).not.toMatch(/storage\.buckets/);
    expect(V8).not.toMatch(/insert into|update storage|truncate/i);
    expect(V8).not.toMatch(/alter table|create table|create (or replace )?function|grant /i);
  });

  it("contains no Phase 6C/6D/6F content and no data statements", () => {
    expect(V8_CODE).not.toMatch(/community_voice_conversations|voice.*ttl|revoke_token|search_credits|qna_enabled|status in \(/i);
    expect(V8_CODE).not.toMatch(/\bupdate public\./i);
  });

  it("the v1 bucket definition stays private end-to-end (no later migration flips public)", () => {
    const v1 = read("supabase/migrations/20261014000000_community.sql");
    const bucketLine = v1.split("\n").find((l) => l.includes("values ('community-images'")) ?? "";
    expect(bucketLine).toMatch(/false/); // (id, name, public=false, ...)
    for (const f of readdirSync(join(ROOT, "supabase/migrations"))) {
      if (!f.endsWith(".sql") || f.startsWith("20261102")) continue;
      const sql = read(join("supabase/migrations", f));
      if (/storage\.buckets/.test(sql)) {
        expect(sql, f).not.toMatch(/update\s+storage\.buckets[^;]*public\s*=\s*true/i);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// B-1 · policy BEHAVIOR — literal TS mirror of the v8 using() expressions
// (plus the unchanged v3 DM policy) evaluated against fixture rows.
// ---------------------------------------------------------------------------
interface MsgRow {
  id: string;
  user_id: string;
  room_id: string;
  image_path: string | null;
  hidden_by: string | null;
}
interface QRow {
  id: string;
  author_id: string;
  room_id: string;
  image_path: string | null;
}
interface BlockRow {
  blocker_id: string;
  blocked_id: string;
}
interface Db {
  messages: MsgRow[];
  questions: QRow[];
  rooms: Array<{ id: string; enabled: boolean }>;
  blocks: BlockRow[];
  conversations: Array<{ id: string; member_a: string; member_b: string }>;
}

const seg = (name: string): string[] => name.split("/").filter(Boolean);
const lower = (s: string | undefined): string => (s ?? "").toLowerCase();

/** v8 "Room-scoped members can read message images" (mirror). */
function canReadMessageImage(name: string, db: Db): boolean {
  const s = seg(name);
  if (s[0] === "dm") return false; // (foldername(name))[1] <> 'dm'
  return db.messages.some(
    (m) =>
      m.image_path === name &&
      m.id.toLowerCase() === lower(s[1]) &&
      m.user_id.toLowerCase() === lower(s[0]) &&
      m.hidden_by === null &&
      db.rooms.some((r) => r.id === m.room_id && r.enabled),
  );
}

/** v8 "Room-scoped members can read question images" (mirror). */
function canReadQuestionImage(name: string, viewer: string, db: Db): boolean {
  const s = seg(name);
  if (s[0] === "dm") return false;
  return db.questions.some(
    (q) =>
      q.image_path === name &&
      q.id.toLowerCase() === lower(s[1]) &&
      q.author_id.toLowerCase() === lower(s[0]) &&
      db.rooms.some((r) => r.id === q.room_id && r.enabled) &&
      !db.blocks.some(
        (b) =>
          (b.blocker_id === viewer && b.blocked_id === q.author_id) ||
          (b.blocker_id === q.author_id && b.blocked_id === viewer),
      ),
  );
}

/** v3 "Members can read dm images of their conversations" (UNCHANGED, mirror). */
function canReadDmImage(name: string, viewer: string, db: Db): boolean {
  const s = seg(name);
  if (s[0] !== "dm") return false;
  return db.conversations.some(
    (c) => c.id === s[1] && (c.member_a === viewer || c.member_b === viewer),
  );
}

/** The effective v8+ storage SELECT result for one object + viewer. */
const canReadCommunityImage = (name: string, viewer: string, db: Db): boolean =>
  canReadMessageImage(name, db) || canReadQuestionImage(name, viewer, db) || canReadDmImage(name, viewer, db);

describe("B-1 · room-scoped image read policy (behavior)", () => {
  const ALICE = "11111111-1111-4111-8111-111111111111"; // the viewer
  const BOB = "22222222-2222-4222-8222-222222222222"; // the author
  const ROOM_ON = "b1000000-0000-4000-8000-000000000001";
  const ROOM_OFF = "b1000000-0000-4000-8000-00000000000f";
  const CONV = "33333333-3333-4333-8333-333333333333";
  const MSG = "44444444-4444-4444-8444-444444444444";
  const MSG_HIDDEN = "44444444-4444-4444-8444-444444444445";
  const MSG_OFF = "44444444-4444-4444-8444-444444444446";
  const Q1 = "55555555-5555-4555-8555-555555555555";
  const Q_BLOCKED = "55555555-5555-4555-8555-555555555556";
  const Q_OFF = "55555555-5555-4555-8555-555555555557";
  const DM_MSG = "66666666-6666-4666-8666-666666666666";

  const db: Db = {
    rooms: [
      { id: ROOM_ON, enabled: true },
      { id: ROOM_OFF, enabled: false },
    ],
    messages: [
      { id: MSG, user_id: BOB, room_id: ROOM_ON, image_path: `${BOB}/${MSG}/image.jpg`, hidden_by: null },
      { id: MSG_HIDDEN, user_id: BOB, room_id: ROOM_ON, image_path: `${BOB}/${MSG_HIDDEN}/image.jpg`, hidden_by: ALICE },
      { id: MSG_OFF, user_id: BOB, room_id: ROOM_OFF, image_path: `${BOB}/${MSG_OFF}/image.jpg`, hidden_by: null },
    ],
    questions: [
      { id: Q1, author_id: BOB, room_id: ROOM_ON, image_path: `${BOB}/${Q1}/image.png` },
      { id: Q_BLOCKED, author_id: BOB, room_id: ROOM_ON, image_path: `${BOB}/${Q_BLOCKED}/image.png` },
      { id: Q_OFF, author_id: BOB, room_id: ROOM_OFF, image_path: `${BOB}/${Q_OFF}/image.webp` },
    ],
    blocks: [{ blocker_id: ALICE, blocked_id: BOB }], // ALICE blocked BOB
    conversations: [{ id: CONV, member_a: ALICE, member_b: BOB }],
  };

  // NOTE: the fixture's block (ALICE→BOB) only affects QUESTION reads —
  // question read RLS is block-scoped; message read RLS is not.
  const msgImage = `${BOB}/${MSG}/image.jpg`;
  const dmImage = `dm/${CONV}/${BOB}/${DM_MSG}/image.jpg`;

  it("1 · an authorized room member can read a room message image", () => {
    expect(canReadMessageImage(msgImage, db)).toBe(true);
  });

  it("2 · a user without access to the room cannot read its image (disabled room)", () => {
    expect(canReadMessageImage(`${BOB}/${MSG_OFF}/image.jpg`, db)).toBe(false);
  });

  it("2b · a moderator-hidden message image is unreadable by everyone", () => {
    expect(canReadMessageImage(`${BOB}/${MSG_HIDDEN}/image.jpg`, db)).toBe(false);
  });

  it("3 · an authorized question viewer can read a question image (no block, enabled room)", () => {
    const noBlocks: Db = { ...db, blocks: [] };
    expect(canReadQuestionImage(`${BOB}/${Q1}/image.png`, ALICE, noBlocks)).toBe(true);
  });

  it("4 · an unauthorized user cannot read a question image (blocked author OR disabled room)", () => {
    expect(canReadQuestionImage(`${BOB}/${Q_BLOCKED}/image.png`, ALICE, db)).toBe(false);
    expect(canReadQuestionImage(`${BOB}/${Q_OFF}/image.webp`, ALICE, db)).toBe(false);
  });

  it("4b · a block in the REVERSE direction also denies the question image", () => {
    const reversed: Db = { ...db, blocks: [{ blocker_id: BOB, blocked_id: ALICE }] };
    expect(canReadQuestionImage(`${BOB}/${Q1}/image.png`, ALICE, reversed)).toBe(false);
  });

  it("5 · a DM participant can read a DM image", () => {
    expect(canReadDmImage(dmImage, ALICE, db)).toBe(true);
    expect(canReadDmImage(dmImage, BOB, db)).toBe(true);
  });

  it("6 · a DM non-participant cannot read a DM image (path knowledge is useless)", () => {
    const EVIL = "99999999-9999-4999-8999-999999999999";
    expect(canReadDmImage(dmImage, EVIL, db)).toBe(false);
  });

  it("7 · knowing the exact object path does NOT bypass authorization (no live row)", () => {
    const ghost = `${BOB}/99999999-9999-4999-8999-999999999999/image.jpg`; // deleted row
    expect(canReadCommunityImage(ghost, ALICE, db)).toBe(false);
    expect(canReadCommunityImage(`${BOB}/not-a-uuid/image.jpg`, ALICE, db)).toBe(false); // malformed
    expect(canReadCommunityImage("stray.jpg", ALICE, db)).toBe(false); // top-level
    // row exists but under ANOTHER user's folder → author-segment mismatch
    expect(canReadCommunityImage(`${ALICE}/${MSG}/image.jpg`, ALICE, db)).toBe(false);
  });

  it("7b · id comparison is case-insensitive (uuid::text is lowercase; paths may not be)", () => {
    expect(canReadMessageImage(`${BOB.toUpperCase()}/${MSG.toUpperCase()}/image.jpg`, db)).toBe(true);
  });

  it("8 · the bucket stays private (v8 changes no bucket definition; policy grants nothing to anon)", () => {
    expect(V8).not.toMatch(/storage\.buckets/);
    expect(V8).not.toMatch(/to (anon|public)/);
  });

  it("9 · the signed-URL flow is unchanged for authorized users and denied for unauthorized ones", () => {
    // The three display components still sign with the SESSION client
    // (RLS-gated createSignedUrl) — v8 only narrows WHO passes that gate.
    for (const f of [
      "src/components/community/room-chat.tsx",
      "src/components/community/dm-chat.tsx",
      "src/components/community/question-detail.tsx",
    ]) {
      expect(read(f), f).toContain(".createSignedUrl(");
      expect(read(f), f).not.toContain("service_role");
    }
    // Same session client → same gate: allowed user signs, denied user does not.
    expect(canReadCommunityImage(msgImage, ALICE, db)).toBe(true);
    expect(canReadCommunityImage(`${BOB}/${MSG_OFF}/image.jpg`, ALICE, db)).toBe(false);
  });

  it("10 · Phase 6A deletion/export/janitor remain intact (service-role surface unchanged)", () => {
    const quota = read("src/lib/community/image-quota.ts");
    expect(quota).toContain('import "server-only"');
    expect(quota).toContain("community_image_storage_usage");
    const gdpr = read("src/lib/account-data.ts");
    expect(gdpr).toContain('import "server-only"');
    expect(gdpr).toContain("community-images");
    const janitor = read("src/lib/storage-reconcile.ts");
    expect(janitor).toContain('import "server-only"');
    expect(janitor).toContain("community-images");
    // Service-role clients bypass storage RLS by construction → the 6A
    // flows are unaffected by the v8 SELECT swap (their tests stay green).
    expect(read("tests/community-phase6a.test.ts")).toContain("describe(");
  });
});

// ---------------------------------------------------------------------------
// B-2 · LiveKit admin token (pure, server-side)
// ---------------------------------------------------------------------------
const LK_KEY = "lk_test_api_key";
const LK_SECRET = "lk_test_api_secret_0123456789abcdef0123456789";
const LK_URL = "wss://sfu.example.test";
const b64urlDecode = (s: string): string =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

describe("B-2 · LiveKit admin token", () => {
  const adminToken = (video: Record<string, unknown>) =>
    createLiveKitAdminToken(LK_KEY, LK_SECRET, video);

  it("is a well-formed HS256 JWT with iss=apiKey, NO identity, and the exact video grant", () => {
    const token = adminToken({ roomAdmin: true, room: "croom-1" });
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(b64urlDecode(parts[0]));
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });
    const claims = JSON.parse(b64urlDecode(parts[1]));
    expect(claims.iss).toBe(LK_KEY);
    expect(claims).not.toHaveProperty("sub"); // service call — no participant identity
    expect(claims.video).toEqual({ roomAdmin: true, room: "croom-1" });
    expect(claims.exp - claims.nbf).toBe(LIVEKIT_ADMIN_TOKEN_TTL_SECONDS);
  });

  it("grants carry no join/publish capability (ListRooms: roomList only)", () => {
    const claims = JSON.parse(b64urlDecode(adminToken({ roomList: true }).split(".")[1]));
    expect(claims.video).toEqual({ roomList: true });
    expect(claims.video).not.toHaveProperty("roomJoin");
    expect(claims.video).not.toHaveProperty("canPublish");
    expect(claims.video).not.toHaveProperty("canSubscribe");
  });

  it("verifies against the API secret (and fails with a wrong secret)", () => {
    const token = adminToken({ roomList: true });
    const [h, p, s] = token.split(".");
    const ok = createHmac("sha256", LK_SECRET).update(`${h}.${p}`).digest("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const bad = createHmac("sha256", "wrong-secret").update(`${h}.${p}`).digest("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(s).toBe(ok);
    expect(s).not.toBe(bad);
  });

  it("never contains the server secret", () => {
    expect(adminToken({ roomList: true })).not.toContain(LK_SECRET);
  });
});

// ---------------------------------------------------------------------------
// B-2 · livekit-api eviction flow (mocked LiveKit Server API)
// ---------------------------------------------------------------------------
interface LkCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function mockLkFetch(
  handler: (call: LkCall) => { status?: number; json?: unknown; networkFail?: string },
): LkCall[] {
  const calls: LkCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const call: LkCall = { url, method: String(init?.method ?? "GET"), headers, body };
      calls.push(call);
      const out = handler(call);
      if (out.networkFail) throw new Error(out.networkFail);
      const status = out.status ?? 200;
      const json = out.json ?? {};
      return { ok: status < 400, status, json: async () => json } as unknown as Response;
    }),
  );
  return calls;
}

/** Decode + inspect the Bearer admin token of a captured call. */
function claimsOf(call: LkCall): Record<string, unknown> {
  const auth = call.headers["authorization"] ?? "";
  expect(auth.startsWith("Bearer ")).toBe(true);
  return JSON.parse(b64urlDecode(auth.slice("Bearer ".length).split(".")[1]));
}

const voiceEnv = (on: boolean) => {
  if (on) {
    vi.stubEnv("LIVEKIT_URL", LK_URL);
    vi.stubEnv("LIVEKIT_API_KEY", LK_KEY);
    vi.stubEnv("LIVEKIT_API_SECRET", LK_SECRET);
  } else {
    vi.stubEnv("LIVEKIT_URL", "");
    vi.stubEnv("LIVEKIT_API_KEY", "");
    vi.stubEnv("LIVEKIT_API_SECRET", "");
  }
};

const SUSPENDED_USER = "77777777-7777-4777-8777-777777777777";
const LK_ROOM_A = `croom-b1000000-0000-4000-8000-000000000001`;
const LK_ROOM_B = `croom-b1000000-0000-4000-8000-000000000002`;
const roomsJson = (names: Array<{ name: string; num_participants?: number }>) => ({ rooms: names });
const partsJson = (identities: string[]) => ({
  participants: identities.map((identity) => ({ identity, state: "ACTIVE" })),
});

describe("B-2 · LiveKit eviction flow (mocked Server API)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("converts the configured ws URL to the HTTP API base", () => {
    expect(liveKitApiBase("wss://sfu.example.test")).toBe("https://sfu.example.test");
    expect(liveKitApiBase("ws://sfu.local:7881/")).toBe("http://sfu.local:7881");
    expect(liveKitApiBase("https://already.http.test/")).toBe("https://already.http.test");
  });

  it("unconfigured env → `not_configured`, zero network calls (voice OFF is a no-op, not a failure)", async () => {
    voiceEnv(false);
    const calls = mockLkFetch(() => ({ networkFail: "must not be called" }));
    const result = await evictLiveKitParticipant(SUSPENDED_USER);
    expect(result).toEqual({ status: "not_configured" });
    expect(calls).toHaveLength(0);
  });

  it("evicts a user from the rooms they are in (correct Twirp URLs, bodies, and per-call grants)", async () => {
    voiceEnv(true);
    const calls = mockLkFetch((call) => {
      if (call.url.endsWith("/ListRooms")) return { json: roomsJson([{ name: LK_ROOM_A, num_participants: 3 }]) };
      if (call.url.endsWith("/ListParticipants")) return { json: partsJson(["someone-else", SUSPENDED_USER]) };
      if (call.url.endsWith("/RemoveParticipant")) return { json: {} };
      return { status: 500, json: { msg: "unexpected" } };
    });
    const result = await evictLiveKitParticipant(SUSPENDED_USER);
    expect(result).toEqual({ status: "evicted", rooms: [LK_ROOM_A] });

    // 1. ListRooms — no body, roomList-only grant
    expect(calls[0].url).toBe(`https://sfu.example.test/twirp/livekit.RoomService/ListRooms`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({});
    expect(claimsOf(calls[0]).video).toEqual({ roomList: true });
    // 2. ListParticipants — room-scoped, roomAdmin grant bound to that room
    expect(calls[1].url).toBe(`https://sfu.example.test/twirp/livekit.RoomService/ListParticipants`);
    expect(calls[1].body).toEqual({ room: LK_ROOM_A });
    expect(claimsOf(calls[1]).video).toEqual({ roomAdmin: true, room: LK_ROOM_A });
    // 3. RemoveParticipant — identity = the suspended user (server-supplied)
    expect(calls[2].url).toBe(`https://sfu.example.test/twirp/livekit.RoomService/RemoveParticipant`);
    expect(calls[2].body).toEqual({ room: LK_ROOM_A, identity: SUSPENDED_USER });
    expect(claimsOf(calls[2]).video).toEqual({ roomAdmin: true, room: LK_ROOM_A });
    // Admin tokens are short-lived service tokens — no participant identity
    for (const call of calls) expect(claimsOf(call)).not.toHaveProperty("sub");
  });

  it("evicts from EVERY room the user is in and skips empty rooms (no ListParticipants on them)", async () => {
    voiceEnv(true);
    const calls = mockLkFetch((call) => {
      if (call.url.endsWith("/ListRooms"))
        return {
          json: roomsJson([
            { name: LK_ROOM_A, num_participants: 2 },
            { name: LK_ROOM_B, num_participants: 1 },
            { name: "croom-empty", num_participants: 0 },
          ]),
        };
      if (call.url.endsWith("/ListParticipants")) {
        return {
          json:
            call.body.room === LK_ROOM_A
              ? partsJson([SUSPENDED_USER])
              : partsJson([SUSPENDED_USER, "another"]),
        };
      }
      if (call.url.endsWith("/RemoveParticipant")) return { json: {} };
      return { status: 500, json: { msg: "unexpected" } };
    });
    const result = await evictLiveKitParticipant(SUSPENDED_USER);
    expect(result).toEqual({ status: "evicted", rooms: [LK_ROOM_A, LK_ROOM_B] });
    const scanned = calls.filter((c) => c.url.endsWith("/ListParticipants")).map((c) => c.body.room);
    expect(scanned).toEqual([LK_ROOM_A, LK_ROOM_B]); // empty room never scanned
    expect(calls.filter((c) => c.url.endsWith("/RemoveParticipant"))).toHaveLength(2);
  });

  it("tolerates camelCase numParticipants (proto3 JSON may emit either case)", async () => {
    voiceEnv(true);
    mockLkFetch((call) => {
      if (call.url.endsWith("/ListRooms"))
        return { json: { rooms: [{ name: LK_ROOM_A, numParticipants: 1 }] } };
      if (call.url.endsWith("/ListParticipants")) return { json: partsJson([SUSPENDED_USER]) };
      return { json: {} };
    });
    const result = await evictLiveKitParticipant(SUSPENDED_USER);
    expect(result).toEqual({ status: "evicted", rooms: [LK_ROOM_A] });
  });

  it("user not in any room → `not_in_any_room` (honest: nothing to evict, no RemoveParticipant calls)", async () => {
    voiceEnv(true);
    const calls = mockLkFetch((call) => {
      if (call.url.endsWith("/ListRooms"))
        return { json: roomsJson([{ name: LK_ROOM_A, num_participants: 4 }]) };
      if (call.url.endsWith("/ListParticipants")) return { json: partsJson(["a", "b", "c", "d"]) };
      return { status: 500, json: { msg: "must not remove" } };
    });
    const result = await evictLiveKitParticipant(SUSPENDED_USER);
    expect(result).toEqual({ status: "not_in_any_room" });
    expect(calls.some((c) => c.url.endsWith("/RemoveParticipant"))).toBe(false);
  });

  it("ignores rooms outside this app's provider namespace (croom-*)", async () => {
    voiceEnv(true);
    const calls = mockLkFetch((call) => {
      if (call.url.endsWith("/ListRooms"))
        return { json: roomsJson([{ name: "sip-bridge", num_participants: 9 }, { name: LK_ROOM_A, num_participants: 1 }]) };
      if (call.url.endsWith("/ListParticipants")) return { json: partsJson([SUSPENDED_USER]) };
      return { json: {} };
    });
    const result = await evictLiveKitParticipant(SUSPENDED_USER);
    expect(result).toEqual({ status: "evicted", rooms: [LK_ROOM_A] });
    expect(calls.some((c) => c.url.includes("sip-bridge"))).toBe(false);
  });

  it("network failure → `unavailable` with detail — never throws, never claims success", async () => {
    voiceEnv(true);
    mockLkFetch(() => ({ networkFail: "ENOTFOUND sfu.example.test" }));
    const result = await evictLiveKitParticipant(SUSPENDED_USER);
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") expect(result.detail).toContain("ENOTFOUND");
  });

  it("API refusal (non-2xx) → `unavailable` with the Twirp message", async () => {
    voiceEnv(true);
    mockLkFetch(() => ({ status: 401, json: { code: 16, msg: "api key not found" } }));
    const result = await evictLiveKitParticipant(SUSPENDED_USER);
    expect(result).toEqual({ status: "unavailable", detail: "api key not found" });
  });

  it("partial failure (one room removed, one refused) → `unavailable` with both facts", async () => {
    voiceEnv(true);
    mockLkFetch((call) => {
      if (call.url.endsWith("/ListRooms"))
        return { json: roomsJson([{ name: LK_ROOM_A, num_participants: 1 }, { name: LK_ROOM_B, num_participants: 1 }]) };
      if (call.url.endsWith("/ListParticipants")) return { json: partsJson([SUSPENDED_USER]) };
      if (call.url.endsWith("/RemoveParticipant")) {
        return call.body.room === LK_ROOM_A ? { json: {} } : { status: 500, json: { msg: "node busy" } };
      }
      return { json: {} };
    });
    const result = await evictLiveKitParticipant(SUSPENDED_USER);
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.detail).toContain(LK_ROOM_A); // what DID work
      expect(result.detail).toContain("node busy"); // what failed
    }
  });

  it("caps the room scan at LIVEKIT_MAX_CANDIDATE_ROOMS", async () => {
    voiceEnv(true);
    const many = Array.from(
      { length: LIVEKIT_MAX_CANDIDATE_ROOMS + 10 },
      (_, i) => ({ name: `${LIVEKIT_ROOM_PREFIX}room-${String(i).padStart(2, "0")}`, num_participants: 1 }),
    );
    const calls = mockLkFetch((call) => {
      if (call.url.endsWith("/ListRooms")) return { json: { rooms: many } };
      if (call.url.endsWith("/ListParticipants")) return { json: partsJson([]) };
      return { json: {} };
    });
    const result = await evictLiveKitParticipant(SUSPENDED_USER);
    expect(result).toEqual({ status: "not_in_any_room" });
    expect(calls.filter((c) => c.url.endsWith("/ListParticipants"))).toHaveLength(
      LIVEKIT_MAX_CANDIDATE_ROOMS,
    );
  });
});

// ---------------------------------------------------------------------------
// B-2 · suspension → eviction integration (performModerationAction)
// ---------------------------------------------------------------------------
function scriptedAdmin(
  terminal?: (table: string, op: string) => Promise<{ data: unknown; error: null }>,
) {
  const calls: Array<{ table: string; op: string; args: unknown[] }> = [];
  const client = {
    rpc: () => Promise.resolve({ data: null, error: null }),
    storage: { from: () => ({ remove: async () => undefined }) },
    from: (table: string) => {
      const base: Record<string, unknown> = {};
      const op = (name: string) => (...args: unknown[]) => {
        calls.push({ table, op: name, args });
        return base;
      };
      base.select = op("select");
      base.eq = op("eq");
      base.update = op("update");
      base.insert = op("insert");
      const terminalFor = (opName: string) => {
        const p = (async () => (terminal ? terminal(table, opName) : { data: null, error: null }))();
        p.catch(() => undefined); // keep the inner promise settled
        return p;
      };
      base.maybeSingle = () => terminalFor("maybeSingle");
      base.single = () => terminalFor("single");
      base.then = (onF: (v: unknown) => unknown, onR: (v: unknown) => unknown) =>
        terminalFor("select").then(onF as never, onR as never);
      return base;
    },
  };
  vi.mocked(createAdminClient).mockReturnValue(client as never);
  return { calls };
}

const suspendAdmin = () =>
  scriptedAdmin(async (table, op) => {
    if (table === "community_profiles" && op === "maybeSingle")
      return { data: { user_id: SUSPENDED_USER, display_name: "Bob" }, error: null };
    return { data: null, error: null };
  });

describe("B-2 · suspend_user → LiveKit eviction (server-side, best-effort)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("12 · suspension evicts an active LiveKit session when the infrastructure exists (sanction + eviction)", async () => {
    voiceEnv(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const calls = mockLkFetch((call) => {
      if (call.url.endsWith("/ListRooms")) return { json: roomsJson([{ name: LK_ROOM_A, num_participants: 2 }]) };
      if (call.url.endsWith("/ListParticipants")) return { json: partsJson([SUSPENDED_USER]) };
      return { json: {} };
    });
    const adminCalls = suspendAdmin();

    const res = await performModerationAction({
      actorId: "88888888-8888-4888-8888-888888888888",
      action: "suspend_user",
      targetType: "profile",
      targetId: SUSPENDED_USER,
    });

    expect(res).toEqual({ ok: true });
    // the sanction itself happened first and completely
    const update = adminCalls.calls.find((c) => c.table === "community_profiles" && c.op === "update");
    expect(update?.args[0]).toEqual({ community_suspended: true });
    expect(adminCalls.calls.some((c) => c.table === "community_moderation_actions" && c.op === "insert")).toBe(true);
    // and the LIVE session was removed — identity = the sanctioned target
    const removal = calls.find((c) => c.url.endsWith("/RemoveParticipant"));
    expect(removal?.body).toEqual({ room: LK_ROOM_A, identity: SUSPENDED_USER });
    // Phase 6D: success is reported via the structured eviction event
    // (stable name + the exact rooms) — never a fabricated state.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`community.voice.eviction userId=${SUSPENDED_USER} status=evicted rooms=${LK_ROOM_A}`),
    );
  });

  it("suspension with voice unconfigured: sanction succeeds, eviction is an explicit no-op (no network)", async () => {
    voiceEnv(false);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const calls = mockLkFetch(() => ({ networkFail: "must not call" }));
    suspendAdmin();
    const res = await performModerationAction({
      actorId: "88888888-8888-4888-8888-888888888888",
      action: "suspend_user",
      targetType: "profile",
      targetId: SUSPENDED_USER,
    });
    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(`community.voice.eviction userId=${SUSPENDED_USER} status=not_configured`),
    );
  });

  it("15 · unreachable SFU: the sanction still succeeds and the UNAVAILABLE state is explicit (no fake success)", async () => {
    voiceEnv(true);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockLkFetch(() => ({ networkFail: "ECONNREFUSED 10.0.0.8:7880" }));
    suspendAdmin();
    const res = await performModerationAction({
      actorId: "88888888-8888-4888-8888-888888888888",
      action: "suspend_user",
      targetType: "profile",
      targetId: SUSPENDED_USER,
    });
    expect(res).toEqual({ ok: true }); // the suspension definitely happened
    // Phase 6D: the explicit unavailable state is the structured event,
    // carrying the failure detail — at error level.
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining("community.voice.unavailable"),
    );
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining("context=eviction detail=ECONNREFUSED 10.0.0.8:7880"),
    );
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("status=evicted")); // no eviction claim
  });

  it("other sanctions (timeout_user) never trigger LiveKit eviction", async () => {
    voiceEnv(true);
    const calls = mockLkFetch(() => ({ json: {} }));
    suspendAdmin();
    const res = await performModerationAction({
      actorId: "88888888-8888-4888-8888-888888888888",
      action: "timeout_user",
      targetType: "profile",
      targetId: SUSPENDED_USER,
      timeoutKey: "1h",
    });
    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });

  it("reinstatement does NOT evict (a restored user keeps any live session)", async () => {
    voiceEnv(true);
    const calls = mockLkFetch(() => ({ json: {} }));
    suspendAdmin();
    const res = await performModerationAction({
      actorId: "88888888-8888-4888-8888-888888888888",
      action: "reinstate_user",
      targetType: "profile",
      targetId: SUSPENDED_USER,
    });
    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// B-2 · token route: new-session gate regression (11 · suspended / 16 · active)
// ---------------------------------------------------------------------------
const ALICE = "11111111-1111-4111-8111-111111111111";
const ROOM = "b1000000-0000-4000-8000-000000000001";

function mockAuth(userId: string | null, account_status = "active") {
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: userId ? { id: userId } : null,
    profile: { id: "p", account_status } as never,
  } as never);
}

/** Admin client serving BOTH checkRateLimit (rpc) and the write gate (from). */
function mockAdminForRoute(gate: { suspended?: boolean; mutedUntil?: string | null }) {
  vi.mocked(createAdminClient).mockReturnValue({
    rpc: vi.fn(async (fn: string) =>
      fn === "check_rate_limit"
        ? { data: { allowed: true, count: 1, limit: 20, retry_after: 0 }, error: null }
        : { data: null, error: null },
    ),
    from: vi.fn((table: string) => {
      const base: Record<string, unknown> = {};
      base.select = () => base;
      base.eq = () => base;
      base.maybeSingle = async () =>
        table === "community_profiles"
          ? {
              data: {
                user_id: ALICE,
                community_suspended: gate.suspended ?? false,
                community_muted_until: gate.mutedUntil ?? null,
              },
              error: null,
            }
          : { data: null, error: null };
      return base;
    }),
  } as never);
}

function mockSessionForRoute() {
  vi.mocked(createClient).mockResolvedValue({
    from: vi.fn((table: string) => {
      const base: Record<string, unknown> = {};
      base.select = () => base;
      base.eq = () => base;
      base.maybeSingle = async () =>
        table === "community_rooms"
          ? { data: { id: ROOM }, error: null }
          : table === "community_profiles"
            ? { data: { display_name: "Alice", avatar_id: null }, error: null }
            : { data: null, error: null };
      return base;
    }),
    rpc: vi.fn(async (name: string) =>
      name === "community_voice_join"
        ? { data: { provider_room_name: `croom-${ROOM}`, participant_count: 2 }, error: null }
        : { data: null, error: null },
    ),
  } as never);
}

const voiceTokenRequest = () =>
  new Request("http://localhost/api/community/voice/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId: ROOM }),
  });

describe("B-2 · voice token route: suspended users get no NEW session", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("11 · a community-suspended user is rejected with 403 `suspended` (no join RPC, no token)", async () => {
    mockAuth(ALICE);
    mockAdminForRoute({ suspended: true });
    mockSessionForRoute();
    voiceEnv(true);
    const res = await voiceTokenPost(voiceTokenRequest());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "suspended" });
  });

  it("a muted (timed-out) user is likewise rejected with 403 `muted`", async () => {
    mockAuth(ALICE);
    mockAdminForRoute({ mutedUntil: new Date(Date.now() + 3600_000).toISOString() });
    mockSessionForRoute();
    voiceEnv(true);
    const res = await voiceTokenPost(voiceTokenRequest());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "muted" });
  });

  it("16 · an active, unsuspended user continues to work normally (200 + join token)", async () => {
    mockAuth(ALICE);
    mockAdminForRoute({ suspended: false });
    mockSessionForRoute();
    voiceEnv(true);
    const res = await voiceTokenPost(voiceTokenRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.provider).toBe("livekit");
    expect(body.room).toBe(`croom-${ROOM}`);
    expect(body.url).toBe(LK_URL);
    expect(body.participantCount).toBe(2);
    expect(body.expiresInSeconds).toBe(600);
    expect(typeof body.token).toBe("string");
    expect(String(body.token)).not.toContain(LK_SECRET);
  });
});

// ---------------------------------------------------------------------------
// B-2 · authorization boundaries (13 · 14) — no client-reachable eviction
// ---------------------------------------------------------------------------
describe("B-2 · eviction is server-authorized only", () => {
  const srcFiles = (): Array<[string, string]> =>
    walk(join(ROOT, "src")).map((f) => [f.slice(ROOT.length + 1), readFileSync(f, "utf8")]);

  it("13 · no API route exposes eviction (livekit-api is imported only by the server-side sanction lib)", () => {
    for (const [rel, content] of srcFiles()) {
      if (rel.includes("/api/") && rel.endsWith(".ts")) {
        expect(content, rel).not.toContain("livekit-api");
        expect(content, rel).not.toContain("evictLiveKitParticipant");
      }
    }
    const importers = srcFiles()
      .filter(([, c]) => c.includes('from "@/lib/voice/livekit-api"'))
      .map(([rel]) => rel);
    expect(importers).toEqual(["src/lib/community/moderation.ts"]);
  });

  it("14 · the evicted identity is the sanctioned target (server-derived) — no route/client parameter selects it", () => {
    // The only call site passes `targetId` — the uuid-validated,
    // admin-role-gated sanction target from performModerationActionAction.
    const mod = read("src/lib/community/moderation.ts");
    expect(mod).toContain("evictLiveKitParticipant(targetId)");
    // No client (use client) code may import the LiveKit admin surface.
    for (const [rel, content] of srcFiles()) {
      if (content.includes('"use client"') || content.includes("'use client'")) {
        expect(content, rel).not.toContain("livekit-api");
        expect(content, rel).not.toContain("livekit-token");
        expect(content, rel).not.toContain("LIVEKIT_API_SECRET");
      }
    }
  });

  it("the admin surface is server-only and reads credentials only via the existing config helper", () => {
    const api = read("src/lib/voice/livekit-api.ts");
    expect(api).toContain('import "server-only"');
    expect(api).toContain("getLiveKitVoiceConfig");
    // credentials come from env only inside the server-only module —
    // never hardcoded, never exported
    expect(api).not.toContain("LIVEKIT_API_SECRET =");
    expect(api).not.toMatch(/export const (apiKey|apiSecret)/);
    // the token route (the only credential-adjacent surface) is unchanged
    const route = read("src/app/api/community/voice/token/route.ts");
    expect(route).not.toContain("livekit-api");
  });

  it("no livekit admin operation exists client-side anywhere (roomServiceClient / removeParticipant)", () => {
    for (const [rel, content] of srcFiles()) {
      if (rel.startsWith("src/app") || rel.startsWith("src/components")) {
        expect(content, rel).not.toMatch(/removeParticipant|RemoveParticipant|roomServiceClient/i);
      }
    }
  });
});
