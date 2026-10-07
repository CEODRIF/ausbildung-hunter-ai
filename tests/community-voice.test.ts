/**
 * Community Phase 4 — voice (WebRTC/SFU) test suite.
 *
 * Coverage (per the Phase 4 matrix):
 *   - LiveKit token: structure, grants (minimal), expiry window, identity
 *     binding, signature, and that the server secret never appears in it
 *   - provider configuration: unconfigured → OFF (never faked)
 *   - POST /api/community/voice/token: auth (401), inactive (401), bad body
 *     (400), unknown room (404), rate limit (429), unconfigured (503),
 *     join failure (500), success (200 + EXACT response shape), and the
 *     server-derived provider room name (arbitrary-SFU-room injection is
 *     impossible — the client may only send a room id)
 *   - syncVoiceCount action: auth, room re-check, clamping, rate limit,
 *     the convergent SQL hand-off
 *   - outsider privacy: the token response carries no participant data;
 *     the migration has no participant table and no realtime publication;
 *     the page prefetch selects aggregate columns only
 *   - source audits: no getUserMedia in app code (LiveKit owns it), no
 *     intervals in the voice UI, no reloads, no media in Supabase, no
 *     service-role imports in client components, no notifications for
 *     voice events, presence left untouched, i18n parity for the new keys
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  VOICE_TOKEN_TTL_SECONDS,
  createLiveKitVoiceToken,
  getLiveKitVoiceConfig,
} from "@/lib/voice/livekit-token";
import { POST } from "@/app/api/community/voice/token/route";
import { syncVoiceCount } from "@/app/community/voice-actions";
import { dictionaries } from "@/lib/i18n/dictionaries";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const ALICE = "11111111-1111-4111-8111-111111111111";
const ROOM = "b1000000-0000-4000-8000-000000000001";
const PROVIDER_ROOM = `croom-${ROOM}`;
const LK_KEY = "lk_test_api_key";
const LK_SECRET = "lk_test_api_secret_0123456789abcdef0123456789";
const LK_URL = "wss://sfu.example.test";

const b64urlDecode = (s: string): string =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
function mockAuth(userId: string | null, account_status = "active") {
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: userId ? { id: userId } : null,
    profile: { id: "p", account_status } as never,
  } as never);
}

let rateLimitResult: {
  allowed: boolean;
  count: number;
  limit: number;
  retry_after: number;
} = { allowed: true, count: 1, limit: 20, retry_after: 0 };

interface ClientSpec {
  rooms?: Array<Record<string, unknown> | null>;
  profiles?: Array<Record<string, unknown> | null>;
  /** Queued rows for the community_voice_join RPC. */
  join?: Array<Record<string, unknown> | null>;
  /** Queued rows for any other RPC by name. */
  rpcQueue?: Record<string, Array<Record<string, unknown> | null>>;
  errors?: Record<string, { message: string } | null>;
}
function mockUserClient(spec: ClientSpec = {}) {
  const calls: Array<{ kind: "table" | "rpc"; name: string; op?: string }> = [];
  const client = {
    from(table: string) {
      calls.push({ kind: "table", name: table, op: "select" });
      const queue =
        table === "community_rooms"
          ? (spec.rooms ?? [])
          : table === "community_profiles"
            ? (spec.profiles ?? [])
            : [];
      const error = spec.errors?.[table] ?? null;
      const result = async () => ({
        data: queue.length > 1 ? (queue.shift() as Record<string, unknown> | null) : (queue[0] ?? null),
        error,
      });
      return {
        select: (selectArgs: unknown[]) => {
          calls.push({ kind: "table", name: `${table}.select`, op: String(selectArgs[0]) });
          return {
            eq: (eqArgs: unknown[]) => {
              calls.push({ kind: "table", name: `${table}.eq`, op: String(eqArgs[0]) });
              return { maybeSingle: result, single: result };
            },
          };
        },
      };
    },
    rpc(name: string, args?: unknown) {
      calls.push({ kind: "rpc", name, op: JSON.stringify(args) });
      const queue = name === "community_voice_join" ? (spec.join ?? []) : (spec.rpcQueue?.[name] ?? []);
      const error = spec.errors?.[`rpc:${name}`] ?? null;
      return Promise.resolve({
        data: queue.length > 1 ? (queue.shift() as Record<string, unknown> | null) : (queue[0] ?? null),
        error,
      });
    },
  };
  vi.mocked(createClient).mockResolvedValue(client as never);
  return { calls };
}

function mockRateLimit(result?: typeof rateLimitResult) {
  if (result) rateLimitResult = result;
  vi.mocked(createAdminClient).mockReturnValue({
    rpc: vi.fn(async (fn: string) =>
      fn === "check_rate_limit" ? { data: rateLimitResult, error: null } : { data: null, error: null },
    ),
  } as never);
}

function tokenRequest(body: unknown): Request {
  return new Request("http://localhost/api/community/voice/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function voiceEnv(on: boolean) {
  if (on) {
    vi.stubEnv("LIVEKIT_URL", LK_URL);
    vi.stubEnv("LIVEKIT_API_KEY", LK_KEY);
    vi.stubEnv("LIVEKIT_API_SECRET", LK_SECRET);
  } else {
    vi.stubEnv("LIVEKIT_URL", "");
    vi.stubEnv("LIVEKIT_API_KEY", "");
    vi.stubEnv("LIVEKIT_API_SECRET", "");
  }
}

afterEach(() => {
  vi.clearAllMocks();
  rateLimitResult = { allowed: true, count: 1, limit: 20, retry_after: 0 };
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Token builder (pure, server-side)
// ---------------------------------------------------------------------------
describe("LiveKit token builder", () => {
  const mint = () =>
    createLiveKitVoiceToken({
      apiKey: LK_KEY,
      apiSecret: LK_SECRET,
      identity: ALICE,
      room: PROVIDER_ROOM,
      name: "Alice",
      avatarId: "avatar-1",
    });

  it("is a well-formed HS256 JWT with the minimal grant set (current LiveKit `video` contract)", () => {
    const token = mint();
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(b64urlDecode(parts[0]));
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });
    const claims = JSON.parse(b64urlDecode(parts[1]));
    expect(claims.iss).toBe(LK_KEY);
    expect(claims.sub).toBe(ALICE); // identity = the caller, server-verified
    // Phase 6D (D-5): grants live under the `video` claim — the current
    // LiveKit contract (verified against the official server SDK source).
    // toEqual is exact: ANY extra grant would fail this assertion.
    expect(claims.video).toEqual({
      room: PROVIDER_ROOM,
      roomCreate: true,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });
    // D-5 items 4+5: ordinary participants get NO admin/list capability.
    expect(claims.video).not.toHaveProperty("roomAdmin");
    expect(claims.video).not.toHaveProperty("roomList");
    expect(claims.video).not.toHaveProperty("roomRecord");
    // Display name is a top-level claim (surfaced as Participant.name).
    expect(claims.name).toBe("Alice");
    // Custom data is the top-level metadata STRING the frozen UI parses
    // via JSON.parse(participant.metadata) for the avatarId.
    expect(typeof claims.metadata).toBe("string");
    expect(JSON.parse(claims.metadata)).toEqual({ avatarId: "avatar-1" });
  });

  it("grants roomCreate — the FIRST joiner must be able to create the ephemeral SFU room (production regression)", () => {
    // LiveKit rooms are ephemeral: the SFU room does not exist until the
    // first participant joins, and joining a not-yet-existing room with a
    // token LACKING roomCreate fails 404 "requested room does not exist"
    // (livekit/client-sdk-js#1883). That omission shipped in Phase 6D and
    // surfaced in production as "Verbindung unterbrochen" on every first
    // join. This pins the grant so a fresh deploy cannot regress it.
    const claims = JSON.parse(b64urlDecode(mint().split(".")[1]));
    expect(claims.video.roomCreate).toBe(true);
    expect(claims.video.roomJoin).toBe(true);
    // roomCreate is scoped to the single server-derived room — it cannot
    // create any other room (identity + room are both signed server-side).
    expect(claims.video.room).toBe(PROVIDER_ROOM);
    expect(claims.sub).toBe(ALICE);
  });

  it("expires after exactly the documented TTL", () => {
    const claims = JSON.parse(b64urlDecode(mint().split(".")[1]));
    expect(VOICE_TOKEN_TTL_SECONDS).toBe(600);
    expect(claims.exp - claims.nbf).toBe(VOICE_TOKEN_TTL_SECONDS);
  });

  it("D-5 · avatar round-trips through the frozen UI contract (JSON.parse(participant.metadata))", () => {
    const claims = JSON.parse(b64urlDecode(mint().split(".")[1]));
    expect(typeof claims.metadata).toBe("string");
    // use-voice.ts reads exactly: JSON.parse(p.metadata).avatarId
    expect(JSON.parse(claims.metadata)).toEqual({ avatarId: "avatar-1" });
    // a token without an avatar still yields valid, parseable metadata
    const noAvatar = createLiveKitVoiceToken({
      apiKey: LK_KEY,
      apiSecret: LK_SECRET,
      identity: ALICE,
      room: PROVIDER_ROOM,
      name: "Alice",
    });
    expect(JSON.parse(JSON.parse(b64urlDecode(noAvatar.split(".")[1])).metadata)).toEqual({
      avatarId: null,
    });
  });

  it("D-5 · the claim set is exactly the current-contract keys — nothing sensitive added", () => {
    const claims = JSON.parse(b64urlDecode(mint().split(".")[1]));
    expect(Object.keys(claims).sort()).toEqual(
      ["exp", "iss", "jti", "metadata", "name", "nbf", "sub", "video"].sort(),
    );
    expect(claims.metadata).not.toContain(LK_SECRET);
    expect(JSON.stringify(claims)).not.toContain(LK_SECRET);
  });

  it("verifies against the API secret (and fails with a wrong key)", () => {
    const token = mint();
    const [h, p, s] = token.split(".");
    const ok = createHmac("sha256", LK_SECRET)
      .update(`${h}.${p}`)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const bad = createHmac("sha256", "wrong-secret")
      .update(`${h}.${p}`)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(s).toBe(ok);
    expect(s).not.toBe(bad);
  });

  it("never contains the server secret", () => {
    expect(mint()).not.toContain(LK_SECRET);
  });
});

describe("provider configuration", () => {
  it("is 'unconfigured' when any env var is missing (voice is OFF, not faked)", () => {
    voiceEnv(false);
    expect(getLiveKitVoiceConfig()).toEqual({ kind: "unconfigured" });
    vi.stubEnv("LIVEKIT_URL", LK_URL);
    expect(getLiveKitVoiceConfig().kind).toBe("unconfigured");
    vi.stubEnv("LIVEKIT_API_KEY", LK_KEY);
    expect(getLiveKitVoiceConfig().kind).toBe("unconfigured");
  });

  it("is 'configured' only when all three values are present", () => {
    voiceEnv(true);
    expect(getLiveKitVoiceConfig()).toEqual({
      kind: "configured",
      url: LK_URL,
      apiKey: LK_KEY,
      apiSecret: LK_SECRET,
    });
  });
});

// ---------------------------------------------------------------------------
// POST /api/community/voice/token
// ---------------------------------------------------------------------------
describe("POST /api/community/voice/token", () => {
  const conversation = {
    id: "c1",
    room_id: ROOM,
    provider: "livekit",
    provider_room_name: PROVIDER_ROOM,
    status: "active",
    participant_count: 2,
  };

  it("rejects unauthenticated requests with 401 (no token, no join)", async () => {
    mockAuth(null);
    const { calls } = mockUserClient();
    const res = await POST(tokenRequest({ roomId: ROOM }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(calls).toHaveLength(0);
  });

  it("rejects inactive accounts with 401", async () => {
    mockAuth(ALICE, "suspended");
    mockUserClient();
    const res = await POST(tokenRequest({ roomId: ROOM }));
    expect(res.status).toBe(401);
  });

  it("rejects non-UUID room ids with 400 (the client may send only a room id)", async () => {
    mockAuth(ALICE);
    mockRateLimit();
    voiceEnv(true);
    const { calls } = mockUserClient();
    const res = await POST(tokenRequest({ roomId: "not-a-uuid" }));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rate-limits on the community_voice scope (429 + retry-after)", async () => {
    mockAuth(ALICE);
    mockRateLimit({ allowed: false, count: 21, limit: 20, retry_after: 9 });
    const res = await POST(tokenRequest({ roomId: ROOM }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("9");
  });

  it("answers 503 when voice is not configured (never a fake success)", async () => {
    mockAuth(ALICE);
    mockRateLimit();
    voiceEnv(false);
    const { calls } = mockUserClient();
    const res = await POST(tokenRequest({ roomId: ROOM }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "voice_unavailable" });
    // No join is attempted when the SFU is OFF.
    expect(calls.filter((c) => c.kind === "rpc")).toHaveLength(0);
  });

  it("answers 404 for unknown / disabled rooms (RLS hides disabled)", async () => {
    mockAuth(ALICE);
    mockRateLimit();
    voiceEnv(true);
    mockUserClient({ rooms: [null] });
    const res = await POST(tokenRequest({ roomId: ROOM }));
    expect(res.status).toBe(404);
  });

  it("answers 500 (no token) when the conversation join fails", async () => {
    mockAuth(ALICE);
    mockRateLimit();
    voiceEnv(true);
    mockUserClient({ rooms: [{ id: ROOM }], join: [null], errors: { "rpc:community_voice_join": { message: "boom" } } });
    const res = await POST(tokenRequest({ roomId: ROOM }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { token?: string };
    expect(body.token).toBeUndefined();
  });

  it("on success returns EXACTLY the connection config — no participant data", async () => {
    mockAuth(ALICE);
    mockRateLimit();
    voiceEnv(true);
    mockUserClient({ rooms: [{ id: ROOM }], profiles: [{ display_name: "Alice", avatar_id: "avatar-1" }], join: [conversation] });
    const res = await POST(tokenRequest({ roomId: ROOM }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["expiresInSeconds", "participantCount", "provider", "room", "token", "url"].sort(),
    );
    expect(body.provider).toBe("livekit");
    expect(body.url).toBe(LK_URL); // the endpoint — not a credential
    expect(body.participantCount).toBe(2);
    expect(body.expiresInSeconds).toBe(600);
    const token = String(body.token);
    expect(token.split(".")).toHaveLength(3);
    const claims = JSON.parse(b64urlDecode(token.split(".")[1]));
    expect(claims.sub).toBe(ALICE); // the caller's own identity — no impersonation
    expect(claims.video.room).toBe(PROVIDER_ROOM);
  });

  it("ignores any client-supplied provider room name (server-derived only)", async () => {
    mockAuth(ALICE);
    mockRateLimit();
    voiceEnv(true);
    mockUserClient({ rooms: [{ id: ROOM }], profiles: [{ display_name: "Alice", avatar_id: "avatar-1" }], join: [conversation] });
    const res = await POST(
      tokenRequest({ roomId: ROOM, providerRoomName: "somewhere-else", token: "forged" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { room: string };
    expect(body.room).toBe(PROVIDER_ROOM);
  });

  it("creates-or-reuses the active conversation via community_voice_join (1 per room)", async () => {
    mockAuth(ALICE);
    mockRateLimit();
    voiceEnv(true);
    const { calls } = mockUserClient({ rooms: [{ id: ROOM }], profiles: [{ display_name: "Alice", avatar_id: "avatar-1" }], join: [conversation] });
    await POST(tokenRequest({ roomId: ROOM }));
    const joinCall = calls.find((c) => c.kind === "rpc" && c.name === "community_voice_join");
    expect(joinCall?.op).toBe(JSON.stringify({ p_room: ROOM }));
  });

  it("never leaks the SFU secret in the response", async () => {
    mockAuth(ALICE);
    mockRateLimit();
    voiceEnv(true);
    mockUserClient({ rooms: [{ id: ROOM }], profiles: [{ display_name: "Alice", avatar_id: "avatar-1" }], join: [conversation] });
    const res = await POST(tokenRequest({ roomId: ROOM }));
    const text = JSON.stringify(await res.clone().json());
    expect(text).not.toContain(LK_SECRET);
  });
});

// ---------------------------------------------------------------------------
// syncVoiceCount (server action)
// ---------------------------------------------------------------------------
describe("syncVoiceCount (server action)", () => {
  it("refuses unauthenticated calls", async () => {
    mockAuth(null);
    expect(await syncVoiceCount(ROOM, 2)).toBe(false);
  });

  it("refuses invalid room ids and out-of-range counts", async () => {
    mockAuth(ALICE);
    mockUserClient();
    expect(await syncVoiceCount("nope", 2)).toBe(false);
    expect(await syncVoiceCount(ROOM, -1)).toBe(false);
    expect(await syncVoiceCount(ROOM, 51)).toBe(false);
    expect(await syncVoiceCount(ROOM, Number.NaN)).toBe(false);
  });

  it("re-checks the room server-side (no write for rooms the user cannot see)", async () => {
    mockAuth(ALICE);
    mockRateLimit();
    const { calls } = mockUserClient({ rooms: [null] });
    expect(await syncVoiceCount(ROOM, 2)).toBe(false);
    expect(calls.filter((c) => c.kind === "rpc")).toHaveLength(0);
  });

  it("respects the rate limit", async () => {
    mockAuth(ALICE);
    mockRateLimit({ allowed: false, count: 21, limit: 20, retry_after: 1 });
    expect(await syncVoiceCount(ROOM, 2)).toBe(false);
  });

  it("hands the observed count to the convergent SQL function", async () => {
    mockAuth(ALICE);
    mockRateLimit();
    const { calls } = mockUserClient({ rooms: [{ id: ROOM }] });
    expect(await syncVoiceCount(ROOM, 3)).toBe(true);
    const rpcCall = calls.find((c) => c.name === "community_voice_sync_count");
    expect(rpcCall?.op).toBe(JSON.stringify({ p_room: ROOM, p_count: 3 }));
  });
});

// ---------------------------------------------------------------------------
// Migration + schema guarantees
// ---------------------------------------------------------------------------
describe("migration v5 (schema guarantees)", () => {
  let migration: string;
  beforeAll(() => {
    migration = read("supabase/migrations/20261030000000_community_v5_voice.sql");
  });

  it("stores only durable aggregate state — no participants table, no audio", () => {
    expect(migration).not.toMatch(/community_voice_participants/i);
    // No media storage of any kind in the schema:
    expect(migration).not.toMatch(/\bblob\b|\bbytea\b|base64/i);
    expect(migration).not.toContain("create publication"); // no realtime publication
    // Aggregate count only, bounded, server-derived provider name:
    expect(migration).toContain("participant_count integer not null default 0");
    expect(migration).toContain("check (participant_count >= 0 and participant_count <= 50)");
    expect(migration).toContain("^croom-[0-9a-f]{8}");
  });

  it("enforces 0-or-1 ACTIVE conversation per room + RLS select-only", () => {
    expect(migration).toContain("where status = 'active'"); // partial unique index
    expect(migration).toContain("enable row level security");
    expect(migration).not.toMatch(/for insert/i); // no user write policies
    expect(migration).not.toMatch(/for update/i);
    expect(migration).not.toMatch(/for delete/i);
  });

  it("keeps the count write path convergent (decrease or exactly +1)", () => {
    expect(migration).toContain("<= participant_count");
    expect(migration).toContain("= participant_count + 1");
  });
});

// ---------------------------------------------------------------------------
// Outsider privacy + source audits
// ---------------------------------------------------------------------------
describe("outsider privacy + source audits", () => {
  it("the page prefetch selects aggregate columns only", () => {
    const rooms = read("src/lib/community/rooms.ts");
    expect(rooms).toContain('select("id,status,participant_count,updated_at")');
  });

  it("the voice broadcast carries ONLY the integer count (never identities)", () => {
    const hook = read("src/components/community/use-voice.ts");
    expect(hook).toContain('payload: { kind: "count", count: n }');
    // No identity field may ever ride the broadcast:
    expect(hook).not.toMatch(/payload: \{[^}]*identity/);
  });

  it("no getUserMedia anywhere in app code (LiveKit owns media capture)", () => {
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        const p = join(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) out.push(...walk(p));
        else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
      }
      return out;
    };
    for (const file of walk(join(ROOT, "src"))) {
      expect(readFileSync(file, "utf8"), file).not.toContain("getUserMedia");
    }
  });

  it("the voice UI has no timers, no reloads, no media in Supabase", () => {
    for (const rel of [
      "src/components/community/use-voice.ts",
      "src/components/community/voice-panel.tsx",
      "src/app/community/voice-actions.ts",
    ]) {
      const src = read(rel);
      expect(src, rel).not.toContain("setInterval");
      expect(src, rel).not.toContain("location.reload");
      expect(src, rel).not.toMatch(/data:audio|base64/i);
      expect(src, rel).not.toContain('from("notifications")'); // no notification spam
    }
  });

  it("client voice components never touch service-role / server-only modules", () => {
    for (const rel of [
      "src/components/community/use-voice.ts",
      "src/components/community/voice-panel.tsx",
    ]) {
      const src = read(rel);
      expect(src, rel).not.toContain("supabase/admin");
      expect(src, rel).not.toContain('import "server-only"');
      expect(src, rel).not.toContain("LIVEKIT_API_SECRET");
    }
  });

  it("the livekit SDK is lazy-loaded (only on an explicit join)", () => {
    const hook = read("src/components/community/use-voice.ts");
    expect(hook).toContain('await import("livekit-client")');
    expect(hook).not.toMatch(/^import \{[^}]*\} from "livekit-client";/m);
  });

  it("presence is untouched by voice (separate concepts, separate timers)", () => {
    const hook = read("src/components/community/use-voice.ts");
    expect(hook).not.toContain("touchCommunityPresence");
    expect(hook).not.toContain("use-presence");
  });

  it("the token route reads the SFU env only via the server-only module", () => {
    const route = read("src/app/api/community/voice/token/route.ts");
    expect(route).not.toContain("process.env");
    expect(route).toContain("getLiveKitVoiceConfig");
    const tokenModule = read("src/lib/voice/livekit-token.ts");
    expect(tokenModule).toContain('import "server-only"');
  });
});

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------
describe("i18n (Phase 4 voice keys)", () => {
  const KEYS = [
    "voiceTitle",
    "voiceParticipants",
    "voiceParticipantsOne",
    "voiceJoin",
    "voiceJoinDescription",
    "voiceStartHint",
    "voiceLeave",
    "voiceMute",
    "voiceUnmute",
    "voiceSpeaker",
    "voiceSpeakerDefault",
    "voiceYou",
    "voiceSpeaking",
    "voiceConnected",
    "voiceReconnecting",
    "voiceConnectionError",
    "voiceMicrophoneDenied",
    "voiceTryAgain",
    "voiceUnavailable",
    "voiceClose",
  ];

  it("exists in all four languages (DE/EN/FR/AR) and is non-empty", () => {
    for (const locale of ["de", "en", "fr", "ar"] as const) {
      const community = (dictionaries[locale] as unknown as {
        community: Record<string, unknown>;
      }).community;
      for (const key of KEYS) {
        expect(typeof community[key], `${locale}.${key}`).toBe("string");
        expect(String(community[key]).length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });
});
