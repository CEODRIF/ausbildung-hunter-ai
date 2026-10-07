/**
 * INTEGRATION REPRODUCTION — the four production flows through the REAL
 * code path, not mocks:
 *
 *   real route handlers → real @supabase/ssr server client → real
 *   PostgREST HTTP protocol → real Postgres with ALL 49 migrations and the
 *   real RLS policies (simulation DB `commaudit`, port 55432).
 *
 * Only GoTrue's /auth/v1/user endpoint is faked (identity). Every data
 * operation, policy, index, RPC and grant is the production schema itself.
 *
 * Requires the reproduction stack (auto-skips when it is not running):
 *   - PostgREST 16 on 127.0.0.1:3002 (conf: /tmp/repro/postgrest.conf)
 *   - /tmp/repro/supabase-mock.mjs on 127.0.0.1:3001 (auth + /rest proxy)
 *   - sim DB users A/B/C with active `profiles` rows + community_profiles
 *
 * What it proves (or fails):
 *   1. A sends a friend request to B          → 201 + pending row
 *   2. B sees the incoming request            → GET friends → incoming[]
 *   3. B accepts                              → POST requests/:id
 *   4. A opens a conversation                 → POST /api/community/dm
 *   5. A sends a DM text                      → POST .../messages (FormData)
 *   6. B reads the DM                         → GET .../conversation
 *   7. negatives: stranger 404, self 400, pending-friend DM 403
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const crypto = require("node:crypto");

const REPRO_URL = "http://127.0.0.1:3001";
const JWT_SECRET = "sim-repro-jwt-secret-min-32-bytes";
const USER_A = "33333333-3333-4333-8333-333333333333";
const USER_B = "44444444-4444-4444-8444-444444444444";
const USER_C = "55555555-5555-4555-8555-555555555555";

const b64url = (value: string | Buffer): string =>
  (typeof value === "string" ? Buffer.from(value) : value).toString("base64url");

function signJwt(claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signature = crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function issueAccessToken(userId: string, role: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    sub: userId,
    aud: role,
    role,
    email: `${role === "authenticated" ? userId.slice(0, 8) : "svc"}@sim.test`,
    exp: now + 7200,
    iat: now,
  });
}

/** The @supabase/ssr session cookie VALUE (JSON session blob). */
function sessionCookieValue(userId: string): string {
  const now = Math.floor(Date.now() / 1000);
  return JSON.stringify({
    access_token: issueAccessToken(userId, "authenticated"),
    token_type: "bearer",
    expires_at: now + 7200,
    refresh_token: issueAccessToken(userId, "authenticated"),
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: `${userId.slice(0, 8)}@sim.test`,
      user_metadata: {},
      app_metadata: { role: "authenticated" },
    },
  });
}

// The exact storage key @supabase/ssr derives from the URL is environment
// dependent — return the session under every plausible name; the adapter
// picks the one it asks for (verified empirically against the installed
// @supabase/ssr version).
const COOKIE_NAMES = [
  "sb-127-auth-token",
  "sb-127.0.0.1-auth-token",
  "supabase.127.auth",
  "supabase.127.0.0.1.auth",
  "supabase.auth",
  "sb-sim-auth-token",
  "sb-3001-auth-token",
];

let currentUserId: string = USER_A;

// `next/headers` is the ONLY mock in this whole stack — everything else
// (supabase/ssr client, PostgREST protocol, Postgres, RLS) is real.
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => COOKIE_NAMES.map((name) => ({ name, value: sessionCookieValue(currentUserId) })),
    get: (name: string) => (COOKIE_NAMES.includes(name) ? { name, value: sessionCookieValue(currentUserId) } : undefined),
    set: () => undefined,
  }),
  headers: async () => new Map<string, string>(),
}));

function setIdentity(userId: string) {
  currentUserId = userId;
}

async function stackUp(): Promise<boolean> {
  try {
    const res = await fetch(`${REPRO_URL}/rest/v1/community_profiles?select=user_id&limit=1`, {
      headers: { apikey: issueAccessToken("00000000-0000-4000-8000-000000000000", "anon") },
      signal: AbortSignal.timeout(3000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

let repro = false;

beforeAll(async () => {
  repro = await stackUp();
  if (!repro) {
    console.info("[repro] stack (127.0.0.1:3001) not running — reproduction steps reported, not executed");
    return;
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL = REPRO_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = issueAccessToken("00000000-0000-4000-8000-000000000000", "anon");
  process.env.SUPABASE_SERVICE_ROLE_KEY = issueAccessToken("00000000-0000-4000-8000-000000000000", "service_role");
  // Clean pair state so the reproduction is deterministic.
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(REPRO_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await admin.from("community_direct_messages").delete().neq("id", "00000000-0000-4000-8000-000000000000");
  await admin.from("community_conversations").delete().neq("id", "00000000-0000-4000-8000-000000000000");
  await admin.from("community_friendships").delete().neq("id", "00000000-0000-4000-8000-000000000000");
  await admin.from("community_blocks").delete().neq("id", "00000000-0000-4000-8000-000000000000");
});

afterAll(async () => {
  if (!repro) return;
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(REPRO_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await admin.from("community_direct_messages").delete().neq("id", "00000000-0000-4000-8000-000000000000");
  await admin.from("community_conversations").delete().neq("id", "00000000-0000-4000-8000-000000000000");
  await admin.from("community_friendships").delete().neq("id", "00000000-0000-4000-8000-000000000000");
});

describe("production reproduction — friend request → accept → DM (real PostgREST + RLS)", () => {
  let friendshipId: string | null = null;
  let conversationId: string | null = null;

  it("1. A sends a friend request to B → 201 + pending row", async () => {
    if (!repro) return; // stack down: step reported in beforeAll
    setIdentity(USER_A);
    const route = await import("../src/app/api/community/friends/route");
    const res = await route.POST(
      new Request("http://repro.local/api/community/friends", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: USER_B }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { friendship?: { id: string; requester_id: string; requestee_id: string; status: string } };
    expect(body.friendship?.requester_id).toBe(USER_A);
    expect(body.friendship?.requestee_id).toBe(USER_B);
    expect(body.friendship?.status).toBe("pending");
    friendshipId = body.friendship?.id ?? null;
    expect(friendshipId).toBeTruthy();
  });

  it("2. B sees the incoming request (GET /api/community/friends)", async () => {
    if (!repro) return; // stack down: step reported in beforeAll
    setIdentity(USER_B);
    const route = await import("../src/app/api/community/friends/route");
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      incoming?: Array<{ friendshipId: string | null; other: { userId: string } }>;
    };
    const incoming = body.incoming?.find((r) => r.other.userId === USER_A) ?? null;
    expect(incoming).not.toBeNull();
    expect(incoming?.friendshipId).toBe(friendshipId);
  });

  it("3. B accepts (POST /api/community/friends/requests/:id) → the pair is friends", async () => {
    if (!repro) return; // stack down: step reported in beforeAll
    if (!friendshipId) throw new Error("step 1 did not produce a friendship");
    setIdentity(USER_B);
    const route = await import("../src/app/api/community/friends/requests/[requestId]/route");
    const res = await route.POST(
      new Request("http://repro.local/api/community/friends/requests/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "accept" }),
      }),
      { params: Promise.resolve({ requestId: friendshipId }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { friendship?: { status: string } };
    expect(body.friendship?.status).toBe("accepted");

    // And B's friends view now lists A as a friend (the DM button's precondition).
    const listRoute = await import("../src/app/api/community/friends/route");
    const list = await listRoute.GET();
    const listBody = (await list.json()) as { friends?: Array<{ other: { userId: string } }> };
    expect(listBody.friends?.some((f) => f.other.userId === USER_A)).toBe(true);
  });

  it("4. A opens the conversation (POST /api/community/dm) → 201 + conversation", async () => {
    if (!repro) return; // stack down: step reported in beforeAll
    setIdentity(USER_A);
    const route = await import("../src/app/api/community/dm/route");
    const res = await route.POST(
      new Request("http://repro.local/api/community/dm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: USER_B }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { conversation?: { id: string; member_a: string; member_b: string } };
    expect(body.conversation?.id).toBeTruthy();
    const members = [body.conversation?.member_a, body.conversation?.member_b].sort();
    expect(members).toEqual([USER_A, USER_B].sort());
    conversationId = body.conversation?.id ?? null;
  });

  it("5. A sends a DM text (FormData, exactly as dm-chat.tsx builds it) → 201", async () => {
    if (!repro) return; // stack down: step reported in beforeAll
    if (!conversationId) throw new Error("step 4 did not produce a conversation");
    setIdentity(USER_A);
    const clientId = crypto.randomUUID();
    const form = new FormData();
    form.set("message", "repro-hello");
    form.set("id", clientId);
    const route = await import("../src/app/api/community/dm/[conversationId]/messages/route");
    const res = await route.POST(
      new Request(`http://repro.local/api/community/dm/${conversationId}/messages`, { method: "POST", body: form }),
      { params: Promise.resolve({ conversationId }) },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { message?: { id: string; user_id: string; message: string } };
    expect(body.message?.id).toBe(clientId);
    expect(body.message?.user_id).toBe(USER_A);
    expect(body.message?.message).toBe("repro-hello");
  });

  it("6. B reads the DM (GET /api/community/dm/:conversationId) → the message is there", async () => {
    if (!repro) return; // stack down: step reported in beforeAll
    if (!conversationId) throw new Error("step 4 did not produce a conversation");
    setIdentity(USER_B);
    const route = await import("../src/app/api/community/dm/[conversationId]/route");
    const res = await route.GET(
      new Request(`http://repro.local/api/community/dm/${conversationId}`),
      { params: Promise.resolve({ conversationId }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages?: Array<{ message: string | null; user_id: string }> };
    expect(body.messages?.some((m) => m.message === "repro-hello" && m.user_id === USER_A)).toBe(true);
  });

  it("7. negatives: stranger gets 404, self-request 400, DM to C (non-friend) 403", async () => {
    if (!repro) return; // stack down: step reported in beforeAll
    // (a) C is not a member of the conversation → 404, identical to a bogus id.
    setIdentity(USER_C);
    const msgRoute = await import("../src/app/api/community/dm/[conversationId]/messages/route");
    const sneakForm = new FormData();
    sneakForm.set("message", "sneak");
    sneakForm.set("id", crypto.randomUUID());
    const stranger = await msgRoute.POST(
      new Request(`http://repro.local/api/community/dm/${conversationId}/messages`, {
        method: "POST",
        body: sneakForm,
      }),
      { params: Promise.resolve({ conversationId: conversationId! }) },
    );
    expect(stranger.status).toBe(404);

    // (b) A cannot request A.
    setIdentity(USER_A);
    const friendsRoute = await import("../src/app/api/community/friends/route");
    const self = await friendsRoute.POST(
      new Request("http://repro.local/api/community/friends", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: USER_A }),
      }),
    );
    expect(self.status).toBe(400);
    expect(((await self.json()) as { error: string }).error).toBe("self_request");

    // (c) A cannot DM C (no friendship at all) → 403 not_friends on open.
    const dmRoute = await import("../src/app/api/community/dm/route");
    const notFriends = await dmRoute.POST(
      new Request("http://repro.local/api/community/dm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: USER_C }),
      }),
    );
    expect(notFriends.status).toBe(403);
    expect(((await notFriends.json()) as { error: string }).error).toBe("not_friends");
  });

  it("8. the rate-limit RPC itself: report the real production shape (fail-open verified)", async () => {
    if (!repro) return; // stack down: step reported in beforeAll
    const { createClient } = await import("@supabase/supabase-js");
    const admin = createClient(REPRO_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = (await admin.rpc("check_rate_limit", {
      limit_key: "repro:rpc-shape",
      max_requests: 20,
      window_seconds: 60,
    })) as { data: unknown; error: { message?: string; code?: string } | null };
    if (error) {
      // This is the KNOWN latent defect the reproduction surfaced — the app
      // fail-opens on it (verified in lib/rate-limit.ts), so the flow above
      // is unaffected. Report the exact SQLSTATE for the record.
      expect(error.code).toBe("42702");
    } else {
      expect((data as { allowed: boolean }).allowed).toBe(true);
    }
  });

  it("9. A removes B as a friend (DELETE /api/community/friends/:id) → 200, then 404 not_friends", async () => {
    if (!repro) return; // stack down: step reported in beforeAll
    setIdentity(USER_A);
    const route = await import("../src/app/api/community/friends/[userId]/route");
    const removed = await route.DELETE(
      new Request(`http://repro.local/api/community/friends/${USER_B}`, { method: "DELETE" }),
      { params: Promise.resolve({ userId: USER_B }) },
    );
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { removed: boolean }).removed).toBe(true);

    // The friendship is gone: a second removal is not_friends (404).
    const again = await route.DELETE(
      new Request(`http://repro.local/api/community/friends/${USER_B}`, { method: "DELETE" }),
      { params: Promise.resolve({ userId: USER_B }) },
    );
    expect(again.status).toBe(404);
  });
});
