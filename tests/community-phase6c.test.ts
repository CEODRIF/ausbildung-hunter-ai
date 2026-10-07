/**
 * Community Phase 6C — reliability & observability test suite.
 *
 * C-1 (env validation) lives in tests/check-env.test.ts (extends the
 * existing check:env framework — see "C-1 · LiveKit environment seam").
 *
 * C-2 — stale voice-session TTL sweep:
 *   * v9 migration guards (single secured RPC; explicit staleness criteria;
 *     converge-only — no delete / no count change / no cross-table / no
 *     LiveKit claim; bounded; idempotent by predicate; no 6A/6B/6D/6F)
 *   * /api/internal/voice-sweep behavior (worker-secret auth, strict body,
 *     clamped parameters, honest response, unavailable state)
 *
 * C-3 — structured logging:
 *   * stable event catalog + scalar/truncation/newline-safety guarantees
 *   * token route emits join / token_issued / join_denied with stable
 *     names and NO secrets/tokens in any console output
 *   * eviction honesty preserved (6B contract intact)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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
  COMMUNITY_VOICE_EVENTS,
  COMMUNITY_LOG_MAX_FIELD_LENGTH,
  communityLog,
} = await import("@/lib/community/log");
const {
  POST: voiceSweepPost,
  VOICE_SWEEP_DEFAULT_STALE_MINUTES,
  VOICE_SWEEP_DEFAULT_MAX,
} = await import("@/app/api/internal/voice-sweep/route");
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

const V9 = read("supabase/migrations/20261103000000_community_v9_voice_stale_sweep.sql");
const V9_CODE = V9.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

// ---------------------------------------------------------------------------
// C-2 · v9 migration guards (SQL text)
// ---------------------------------------------------------------------------
describe("C-2 · v9 migration guards", () => {
  it("is additive: exactly ONE function, secured per project convention", () => {
    const creates = V9_CODE.match(/create or replace function/g) ?? [];
    expect(creates).toHaveLength(1);
    expect(V9_CODE).toContain("create or replace function public.community_voice_sweep_stale(");
    expect(V9_CODE).toContain("security definer");
    expect(V9_CODE).toContain("set search_path = public");
    expect(V9_CODE).toContain(
      "revoke execute on function public.community_voice_sweep_stale(integer, integer) from public, anon",
    );
    expect(V9_CODE).toContain(
      "grant execute on function public.community_voice_sweep_stale(integer, integer) to service_role",
    );
    // no other DDL surface at all
    expect(V9_CODE).not.toMatch(/create table|alter table|drop |create index|create policy|create unique|insert into/i);
    expect(V9_CODE).not.toMatch(/grant (select|insert|update|delete)/i);
  });

  it("encodes the explicit staleness criteria (active + silent for the threshold)", () => {
    expect(V9_CODE).toContain("c.status = 'active'");
    expect(V9_CODE).toContain(
      "c.updated_at < timezone('utc', now()) - make_interval(mins => greatest(coalesce(p_stale_minutes, 15), 1))",
    );
    expect(V9_CODE).toContain("order by c.updated_at asc");
    expect(V9_CODE).toContain("limit least(greatest(coalesce(p_max, 25), 1), 100)");
  });

  it("converges ONLY (sets ended), never deletes, never touches counts/rooms, no cross-table joins", () => {
    expect(V9_CODE).toContain("set status = 'ended'");
    expect(V9_CODE).not.toMatch(/delete\s+from/i);
    const setClause = V9_CODE.split("update public.community_voice_conversations")[1].split("where")[0];
    expect(setClause).not.toContain("participant_count");
    expect(setClause).not.toContain("room_id");
    expect(setClause).not.toContain("provider");
    // the subquery reads ONLY the voice table (no join to rooms/users/any other table)
    const froms = V9_CODE.match(/from public\.\w+/g) ?? [];
    expect(new Set(froms)).toEqual(new Set(["from public.community_voice_conversations"]));
  });

  it("is idempotent by predicate (sweep sets ended; predicate requires active)", () => {
    // both facts in the same statement block
    expect(V9_CODE).toContain("set status = 'ended'");
    expect(V9_CODE).toContain("c.status = 'active'");
  });

  it("contains no 6A/6B/6D/6F content and documents its rollback", () => {
    expect(V9_CODE).not.toMatch(/storage|community_image|community_images|qna_enabled|community_blocks|livekit/i);
    expect(V9).toContain("drop function if exists public.community_voice_sweep_stale(integer, integer)");
  });
});

// ---------------------------------------------------------------------------
// C-2 · /api/internal/voice-sweep behavior
// ---------------------------------------------------------------------------
const WORKER_SECRET = "a-very-long-random-worker-secret-123";
const sweepRequest = (body: unknown, secret?: string | null) =>
  new Request("http://localhost/api/internal/voice-sweep", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret === null ? {} : { "x-email-worker-secret": secret ?? WORKER_SECRET }),
    },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });

/** Sequence of RPC outcomes: numbers = swept count, {error} = failure,
 *  strings = unknown data shape (fail-closed to 0). */
function mockSweepAdmin(sequence: Array<number | string | { error: string }>) {
  const calls: Array<{ name: string; args: unknown }> = [];
  vi.mocked(createAdminClient).mockReturnValue({
    rpc: vi.fn(async (name: string, args: unknown) => {
      calls.push({ name, args });
      const next = sequence.length > 1 ? sequence.shift() : sequence[0];
      if (next && typeof next === "object")
        return { data: null, error: { message: next.error } };
      if (typeof next === "string") return { data: next, error: null }; // unknown shape passes through
      return { data: typeof next === "number" ? next : 0, error: null };
    }),
  } as never);
  return { calls };
}

describe("C-2 · /api/internal/voice-sweep (stale-session TTL seam)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("7 · sweeps stale records per the explicit criteria and reports the honest count (defaults)", async () => {
    vi.stubEnv("EMAIL_WORKER_SECRET", WORKER_SECRET);
    const { calls } = mockSweepAdmin([3]);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const res = await voiceSweepPost(sweepRequest(undefined));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      swept: 3,
      staleMinutes: VOICE_SWEEP_DEFAULT_STALE_MINUTES,
      maxSwept: VOICE_SWEEP_DEFAULT_MAX,
    });
    expect(calls).toEqual([
      {
        name: "community_voice_sweep_stale",
        args: {
          p_stale_minutes: VOICE_SWEEP_DEFAULT_STALE_MINUTES,
          p_max: VOICE_SWEEP_DEFAULT_MAX,
        },
      },
    ]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("community.voice.cleanup swept=3"));
  });

  it("8 · fresh/active records survive: the threshold cannot be pushed below one minute and there is no bypass flag", async () => {
    vi.stubEnv("EMAIL_WORKER_SECRET", WORKER_SECRET);
    const { calls } = mockSweepAdmin([0]);
    // staleMinutes: 0 would sweep everything recent — rejected, never forwarded
    expect((await voiceSweepPost(sweepRequest({ staleMinutes: 0 }))).status).toBe(400);
    // the minimum expressible window is 1 minute
    expect((await voiceSweepPost(sweepRequest({ staleMinutes: 1 }))).status).toBe(200);
    expect(calls[0]?.args).toEqual({ p_stale_minutes: 1, p_max: VOICE_SWEEP_DEFAULT_MAX });
    // no "execute"/"force" concept exists (strict body)
    expect((await voiceSweepPost(sweepRequest({ execute: true }))).status).toBe(400);
    expect((await voiceSweepPost(sweepRequest({ force: true, staleMinutes: 1 }))).status).toBe(400);
  });

  it("9 · idempotent + safe to re-run (second tick honestly reports 0)", async () => {
    vi.stubEnv("EMAIL_WORKER_SECRET", WORKER_SECRET);
    mockSweepAdmin([3, 0]);
    const first = await voiceSweepPost(sweepRequest(undefined));
    const second = await voiceSweepPost(sweepRequest(undefined));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ swept: 3 });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ swept: 0 });
  });

  it("10 · bounded: the per-tick budget and window are clamped server-side", async () => {
    vi.stubEnv("EMAIL_WORKER_SECRET", WORKER_SECRET);
    const { calls } = mockSweepAdmin([1]);
    expect((await voiceSweepPost(sweepRequest({ maxSwept: 10000 }))).status).toBe(400);
    expect((await voiceSweepPost(sweepRequest({ staleMinutes: 99999 }))).status).toBe(400);
    expect((await voiceSweepPost(sweepRequest({ maxSwept: 50, staleMinutes: 30 }))).status).toBe(200);
    expect(calls[0]?.args).toEqual({ p_stale_minutes: 30, p_max: 50 });
  });

  it("11 · no cross-room modification: only the two scalar criteria ever reach the RPC", async () => {
    vi.stubEnv("EMAIL_WORKER_SECRET", WORKER_SECRET);
    const { calls } = mockSweepAdmin([0]);
    await voiceSweepPost(sweepRequest({ staleMinutes: 20 }));
    expect(calls[0]?.args).toEqual({ p_stale_minutes: 20, p_max: VOICE_SWEEP_DEFAULT_MAX });
    expect(JSON.stringify(calls[0]?.args)).not.toContain("room");
    // a room selector is not a thing (strict body)
    expect((await voiceSweepPost(sweepRequest({ room: "b1000000-0000-4000-8000-000000000001" }))).status).toBe(400);
  });

  it("12 · an unauthorized client cannot trigger the sweep (worker-secret trust boundary)", async () => {
    const { calls } = mockSweepAdmin([99]);
    // no worker secret configured at all
    vi.stubEnv("EMAIL_WORKER_SECRET", "");
    expect((await voiceSweepPost(sweepRequest(undefined, WORKER_SECRET))).status).toBe(401);
    // wrong secret
    vi.stubEnv("EMAIL_WORKER_SECRET", WORKER_SECRET);
    expect((await voiceSweepPost(sweepRequest(undefined, "wrong-secret"))).status).toBe(401);
    // no header
    expect((await voiceSweepPost(sweepRequest(undefined, null))).status).toBe(401);
    // nothing ever reached the RPC
    expect(calls).toHaveLength(0);
  });

  it("13 · malformed requests fail closed (400) — including non-integers and unknown keys", async () => {
    vi.stubEnv("EMAIL_WORKER_SECRET", WORKER_SECRET);
    mockSweepAdmin([1]);
    expect((await voiceSweepPost(sweepRequest({ staleMinutes: 1.5 }))).status).toBe(400);
    expect((await voiceSweepPost(sweepRequest({ maxSwept: "50" }))).status).toBe(400);
    expect((await voiceSweepPost(sweepRequest({ maxSwept: 0 }))).status).toBe(400);
    expect((await voiceSweepPost(sweepRequest({ unknown: true }))).status).toBe(400);
  });

  it("14a · the response and log make NO claim about LiveKit participant state", async () => {
    vi.stubEnv("EMAIL_WORKER_SECRET", WORKER_SECRET);
    mockSweepAdmin([2]);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const res = await voiceSweepPost(sweepRequest(undefined));
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["maxSwept", "staleMinutes", "swept"]);
    const line = info.mock.calls.map((c) => String(c[0])).join("\n");
    expect(line).toContain("community.voice.cleanup");
    expect(line).not.toMatch(/participant|room=|evict|empty/i);
  });

  it("14b · RPC failure → 500 + honest community.voice.unavailable (never a swept claim)", async () => {
    vi.stubEnv("EMAIL_WORKER_SECRET", WORKER_SECRET);
    mockSweepAdmin([{ error: "relation does not exist" }]);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await voiceSweepPost(sweepRequest(undefined));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Voice sweep failed" });
    expect(err).toHaveBeenCalledWith(expect.stringContaining("community.voice.unavailable"));
    expect(err).toHaveBeenCalledWith(expect.stringContaining("relation does not exist"));
  });

  it("14c · an unknown RPC data shape is reported as 0 swept (fail closed)", async () => {
    vi.stubEnv("EMAIL_WORKER_SECRET", WORKER_SECRET);
    mockSweepAdmin(["garbage"]);
    const res = await voiceSweepPost(sweepRequest(undefined));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ swept: 0 });
  });

  it("sweep is server-only: no API/community/client code references the sweep RPC", () => {
    for (const f of walk(join(ROOT, "src"))) {
      const rel = f.slice(ROOT.length + 1);
      const content = readFileSync(f, "utf8");
      if (content.includes("community_voice_sweep_stale")) {
        expect(rel).toBe("src/app/api/internal/voice-sweep/route.ts");
      }
      if (rel.includes("/api/community/") || rel.startsWith("src/components") || rel.startsWith("src/app/community")) {
        expect(content, rel).not.toContain("community_voice_sweep_stale");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// C-3 · structured logging
// ---------------------------------------------------------------------------
const LK_KEY = "lk_test_api_key";
const LK_SECRET = "lk_test_api_secret_0123456789abcdef0123456789";
const LK_URL = "wss://sfu.example.test";
const ALICE = "11111111-1111-4111-8111-111111111111";
const ROOM = "b1000000-0000-4000-8000-000000000001";

function mockAuth(userId: string | null) {
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: userId ? { id: userId } : null,
    profile: { id: "p", account_status: "active" } as never,
  } as never);
}

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

const voiceTokenRequest = () =>
  new Request("http://localhost/api/community/voice/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId: ROOM }),
  });

/** Capture EVERYTHING written to any console stream. */
function captureConsole() {
  const lines: string[] = [];
  const spy = (fn: "log" | "info" | "warn" | "error") =>
    vi.spyOn(console, fn).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  spy("log");
  spy("info");
  spy("warn");
  spy("error");
  return lines;
}

describe("C-3 · structured logging (community.voice.*)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("15 · the stable event catalog is exact", () => {
    expect(COMMUNITY_VOICE_EVENTS).toEqual([
      "community.voice.join",
      "community.voice.token_issued",
      "community.voice.join_denied",
      "community.voice.leave_sync",
      "community.voice.cleanup",
      "community.voice.eviction",
      "community.voice.unavailable",
    ]);
  });

  it("15b · the token route emits join + token_issued with stable names and fields", async () => {
    const lines = captureConsole();
    mockAuth(ALICE);
    mockAdminForRoute({ suspended: false });
    mockSessionForRoute();
    voiceEnv(true);
    const res = await voiceTokenPost(voiceTokenRequest());
    expect(res.status).toBe(200);
    const join = lines.find((l) => l.includes("community.voice.join userId="));
    expect(join).toContain(`roomId=${ROOM}`);
    const issued = lines.find((l) => l.includes("community.voice.token_issued"));
    expect(issued).toContain(`userId=${ALICE}`);
    expect(issued).toContain(`roomId=${ROOM}`);
    expect(issued).toContain(`room=croom-${ROOM}`);
    expect(issued).toContain("participantCount=2");
    expect(issued).toContain("ttlSeconds=600");
  });

  it("15c · a suspended user's denied join is logged (join_denied, reason=suspended)", async () => {
    const lines = captureConsole();
    mockAuth(ALICE);
    mockAdminForRoute({ suspended: true });
    mockSessionForRoute();
    voiceEnv(true);
    const res = await voiceTokenPost(voiceTokenRequest());
    expect(res.status).toBe(403);
    const denied = lines.find((l) => l.includes("community.voice.join_denied"));
    expect(denied).toContain("reason=suspended");
    expect(denied).toContain(`userId=${ALICE}`);
  });

  it("15d · an unconfigured voice stack logs join_denied reason=voice_unavailable (503)", async () => {
    const lines = captureConsole();
    mockAuth(ALICE);
    mockAdminForRoute({ suspended: false });
    mockSessionForRoute();
    voiceEnv(false);
    const res = await voiceTokenPost(voiceTokenRequest());
    expect(res.status).toBe(503);
    expect(lines.find((l) => l.includes("community.voice.join_denied"))).toContain(
      "reason=voice_unavailable",
    );
  });

  it("16 · no secret, API key, or join token is ever emitted (full console capture)", async () => {
    const lines = captureConsole();
    mockAuth(ALICE);
    mockAdminForRoute({ suspended: false });
    mockSessionForRoute();
    voiceEnv(true);
    const res = await voiceTokenPost(voiceTokenRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    // also exercise a denial in the same capture
    mockAdminForRoute({ suspended: true });
    await voiceTokenPost(voiceTokenRequest());
    const all = lines.join("\n");
    expect(all).not.toContain(LK_SECRET);
    expect(all).not.toContain(LK_KEY);
    expect(all).not.toContain(body.token);
    expect(all).not.toContain("eyJ"); // no JWT fragment at all
  });

  it("17 · signed URLs / long credential-like values are truncated, never emitted in full", () => {
    const lines = captureConsole();
    const signedUrl = `https://x.storage.supabase.co/object/sign/path/image.jpg?token=${"a1b2c3".repeat(40)}`;
    communityLog("community.voice.leave_sync", { url: signedUrl, count: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(signedUrl);
    expect(lines[0]).not.toContain("a1b2c3a1b2c3a1b2c3a1b2c3"); // no chunk of the token
    expect(lines[0]).toContain("…(len=");
    expect(lines[0]).toContain(`len=${signedUrl.length}`);
  });

  it("18 · message/image contents cannot leak in full (truncation) and cannot inject lines (newlines flattened)", () => {
    const lines = captureConsole();
    const content = "x".repeat(300);
    communityLog("community.voice.leave_sync", { sample: content });
    expect(lines[0]).not.toContain(content);
    expect(lines[0]).toContain("…(len=300)");
    expect(lines).toHaveLength(1);

    const injected = captureConsole();
    communityLog("community.voice.leave_sync", { detail: "first\nline2\rline3" });
    expect(injected).toHaveLength(1); // one event = ONE line
    expect(injected[0]).toContain("first line2 line3");
    expect(injected[0].split("\n")).toHaveLength(1);

    // scalar-only typing: the max length is exported for tests/audit
    expect(COMMUNITY_LOG_MAX_FIELD_LENGTH).toBe(120);
  });

  it("19 · eviction honesty is preserved (6B contract now via the 6C structured events)", () => {
    const mod = read("src/lib/community/moderation.ts");
    expect(mod).toContain("evictLiveKitParticipant(targetId)");
    // Phase 6D: eviction outcomes flow through the structured events with
    // explicit states — the unavailable state is logged at ERROR with its
    // detail, and success only ever as the honest `evicted` status.
    expect(mod).toContain('"community.voice.unavailable"');
    expect(mod).toContain('"community.voice.eviction"');
    expect(mod).toContain('status: "evicted"');
    expect(mod).toContain("eviction.detail");
    expect(mod).toContain('context: "eviction"');
  });

  it("20 · unavailable LiveKit/sweep states are represented honestly by event + level", () => {
    // catalog includes the unavailable event
    expect(COMMUNITY_VOICE_EVENTS).toContain("community.voice.unavailable");
    // and the sweep route logs it at ERROR level with the detail
    const lines = captureConsole();
    communityLog("community.voice.unavailable", { context: "stale_sweep", detail: "ECONNREFUSED" }, "error");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      "[community] community.voice.unavailable context=stale_sweep detail=ECONNREFUSED",
    );
  });
});
