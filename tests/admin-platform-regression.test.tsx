/**
 * Phase 10 — Platform administrator (announcements, community moderation,
 * bans, admin identity) — the comprehensive regression suite.
 *
 * Server boundaries are exercised with the REAL route handlers and REAL lib
 * functions against mocked Supabase clients (per-table result queues +
 * recorded calls), plus static source/migration guards for the security
 * invariants that mocks cannot prove:
 *
 *   AUTHORIZATION
 *     - admin accepted (stable id + admins membership), normal user
 *       rejected, anonymous rejected
 *     - a FORGED email (contact@ausbildungsweg.net) never authorizes — the
 *       id, not the email, is the identity
 *     - a forged user id in a request body is never read as the actor
 *     - client-side state cannot grant privileges (isPlatformAdminId is a
 *       pure id comparison; the profile flag is display-only)
 *   ANNOUNCEMENTS
 *     - admin can send (single target_type='all' row — no per-user
 *       fan-out), normal/anonymous cannot
 *     - malformed / oversized / http link / unknown type rejected
 *     - duplicate retry (23505 on send_key) converges to duplicate, no
 *       second audit row
 *     - audited 'admin_announcement'
 *   MESSAGE MODERATION
 *     - admin hides ANY message (soft model: only hidden_by/hidden_at are
 *       written — the update payload is exactly those two fields)
 *     - normal/anonymous cannot; invalid target → 400; missing → not_found
 *     - audited 'admin_message_delete' with the room slug in the reason
 *     - idempotent on an already-hidden message (no second audit)
 *   BANS
 *     - admin can ban / unban; normal/anonymous cannot
 *     - self-ban impossible; the platform admin itself is protected
 *     - banned user is blocked at the write gate (code 'banned'); an
 *       expired ban lifts itself
 *     - ban persisted (row, revoked_at=null); unban = timestamp, row stays
 *     - audited 'admin_ban_user' / 'admin_unban_user'
 *   ADMIN PROFILE
 *     - the designated admin's custom display name (1–40 chars, spaces,
 *       emoji; no control chars) while normal users keep the strict
 *       username rules
 *     - the red badge renders only from the server-enriched flag
 *     - isPlatformAdminId: true only for the stable id
 *   SECURITY (static guards)
 *     - privileged modules are server-only; no client component imports
 *       the service-role client
 *     - every /api/admin route authorizes with isPlatformAdmin()
 *     - v10 disables no RLS, grants no anon/public policy, and contains no
 *       executable ALTER TYPE (the enum value lives in the standalone,
 *       single-statement v10a migration)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/voice/livekit-api", () => ({
  evictLiveKitParticipant: vi.fn(async () => ({ status: "unavailable", detail: "mock" })),
}));

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  PLATFORM_ADMIN_EMAIL,
  PLATFORM_ADMIN_USER_ID,
  isPlatformAdmin,
  isPlatformAdminId,
  requirePlatformAdmin,
} from "@/lib/community/platform-admin";
import {
  adminHideMessage,
  announcementSchema,
  banUser,
  sendPlatformAnnouncement,
  unbanUser,
} from "@/lib/community/admin-ops";
import { fetchCommunityBanState, fetchCommunityWriteGate } from "@/lib/community/roles";
import {
  isValidAdminCommunityName,
  isValidCommunityUsername,
} from "@/lib/community";

import { POST as announcePOST } from "@/app/api/admin/announcements/route";
import { POST as banPOST } from "@/app/api/admin/community/users/[id]/ban/route";
import { GET as usersGET } from "@/app/api/admin/community/users/route";
import { POST as hidePOST } from "@/app/api/admin/community/messages/[id]/route";
import { AdminBadge } from "@/components/community/admin-badge";

// ---------------------------------------------------------------------------
// Fixtures + mocks
// ---------------------------------------------------------------------------

const ADMIN = PLATFORM_ADMIN_USER_ID;
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ROOT = join(__dirname, "..");

type Call = { op: string; table: string; args: unknown[] };
type Result = { data: unknown; error: { message: string; code?: string } | null };
type AdminMock = { calls: Call[]; queue: (table: string, ...results: Result[]) => void };

function mockAdminClient(): AdminMock {
  const calls: Call[] = [];
  const queues = new Map<string, Result[]>();
  const rate: Record<string, { allowed: boolean; count?: number; limit?: number; retry_after?: number }> = {};
  const client = {
    rpc: async (fn: string, args?: unknown) => {
      calls.push({ op: "rpc", table: fn, args: [args] });
      if (fn === "check_rate_limit") {
        const scope = (args as { scope?: string })?.scope ?? "default";
        return { data: rate[scope] ?? { allowed: true, count: 1, limit: 60, retry_after: 0 }, error: null };
      }
      const q = queues.get(fn) ?? [];
      return q.length ? q.shift()! : { data: null, error: null };
    },
    from: (table: string) => {
      const q = () => (queues.get(table) ?? []).shift() ?? { data: null, error: null };
      const rec = (op: string, ...args: unknown[]) => calls.push({ op, table, args });
      const chainable: Record<string, unknown> = {
        select: (sel: unknown) => (rec("select", sel), chainable),
        insert: (vals: unknown) => (rec("insert", vals), chainable),
        update: (vals: unknown) => (rec("update", vals), chainable),
        delete: () => (rec("delete"), chainable),
        eq: (c: string, v: unknown) => (rec("eq", c, v), chainable),
        in: (c: string, v: unknown) => (rec("in", c, v), chainable),
        is: (c: string, v: unknown) => (rec("is", c, v), chainable),
        ilike: (c: string, v: unknown) => (rec("ilike", c, v), chainable),
        order: () => chainable,
        limit: (n: number) => (rec("limit", n), chainable),
        maybeSingle: async () => (rec("maybeSingle"), q()),
        single: async () => (rec("single"), q()),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(q()).then(resolve, reject),
      };
      return chainable;
    },
  };
  vi.mocked(createAdminClient).mockReturnValue(client as never);
  return {
    calls,
    queue: (table, ...results) => queues.set(table, [...(queues.get(table) ?? []), ...results]),
  };
}

/** Mock the session for isPlatformAdmin (supabase.auth.getUser). */
function mockSession(user: { id: string; email?: string } | null) {
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user }, error: null })) },
  } as never);
}

function post(url: string, body?: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ANNOUNCE_VALID = {
  title: "Wartungsarbeiten am Samstag",
  content: "Das Forum ist am Samstag 02:00–04:00 UTC offline.",
  linkUrl: "",
  type: "maintenance",
  sendKey: "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0",
};

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// A. ADMIN IDENTITY
// ---------------------------------------------------------------------------

describe("platform admin identity", () => {
  it("accepts the designated session (stable id + admins membership)", async () => {
    const admin = mockAdminClient();
    admin.queue("admins", { data: { user_id: ADMIN }, error: null });
    mockSession({ id: ADMIN, email: PLATFORM_ADMIN_EMAIL });
    const check = await isPlatformAdmin();
    expect(check).toEqual({ ok: true, userId: ADMIN });
  });

  it("a FORGED email never authorizes — identity is the id, not the email", async () => {
    const admin = mockAdminClient();
    // Even with a matching admins row queued, a non-admin id must fail
    // before the DB is ever consulted.
    admin.queue("admins", { data: { user_id: ALICE }, error: null });
    mockSession({ id: ALICE, email: PLATFORM_ADMIN_EMAIL });
    const check = await isPlatformAdmin();
    expect(check).toEqual({ ok: false, code: "not_admin" });
    expect(admin.calls.filter((c) => c.table === "admins")).toHaveLength(0);
  });

  it("a matching id WITHOUT the admins row fails closed (not_bound)", async () => {
    const admin = mockAdminClient();
    admin.queue("admins", { data: null, error: null });
    mockSession({ id: ADMIN });
    expect(await isPlatformAdmin()).toEqual({ ok: false, code: "not_bound" });
  });

  it("an admins read error fails closed", async () => {
    const admin = mockAdminClient();
    admin.queue("admins", { data: null, error: { message: "boom" } });
    mockSession({ id: ADMIN });
    expect(await isPlatformAdmin()).toEqual({ ok: false, code: "not_bound" });
  });

  it("anonymous → unauthenticated; requirePlatformAdmin → null", async () => {
    mockAdminClient();
    mockSession(null);
    expect(await isPlatformAdmin()).toEqual({ ok: false, code: "unauthenticated" });
    expect(await requirePlatformAdmin()).toBeNull();
  });

  it("a session/DB throw fails closed (never grants)", async () => {
    mockAdminClient();
    vi.mocked(createClient).mockRejectedValue(new Error("jwt expired"));
    expect(await isPlatformAdmin()).toEqual({ ok: false, code: "not_bound" });
  });

  it("isPlatformAdminId: only the stable id (case-insensitive uuid) is true", () => {
    expect(isPlatformAdminId(ADMIN)).toBe(true);
    expect(isPlatformAdminId(ADMIN.toUpperCase())).toBe(true);
    expect(isPlatformAdminId(ALICE)).toBe(false);
    expect(isPlatformAdminId(PLATFORM_ADMIN_EMAIL)).toBe(false);
    expect(isPlatformAdminId("admin")).toBe(false);
    expect(isPlatformAdminId(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C. ANNOUNCEMENTS
// ---------------------------------------------------------------------------

describe("announcements", () => {
  it("admin can send — ONE target_type='all' row (no per-user fan-out), audited", async () => {
    const admin = mockAdminClient();
    admin.queue("notifications", { data: { id: "99999999-0000-4000-8000-000000000001" }, error: null });
    // the route hands the lib the POST-TRANSFORM payload (linkUrl "" → null)
    const transformed = announcementSchema.parse({ ...ANNOUNCE_VALID });
    const result = await sendPlatformAnnouncement({ actorId: ADMIN, payload: transformed });
    expect(result).toEqual({ ok: true, duplicate: false });

    const inserts = admin.calls.filter((c) => c.op === "insert" && c.table === "notifications");
    expect(inserts).toHaveLength(1);
    const payload = inserts[0].args[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: "maintenance",
      target_type: "all",
      target_user_id: null,
      created_by: ADMIN,
      actor_id: ADMIN,
      title: ANNOUNCE_VALID.title,
      content: ANNOUNCE_VALID.content,
      link_url: null,
      send_key: ANNOUNCE_VALID.sendKey,
    });

    const audits = admin.calls.filter((c) => c.op === "insert" && c.table === "community_moderation_actions");
    expect(audits).toHaveLength(1);
    expect(audits[0].args[0]).toMatchObject({
      moderator_id: ADMIN,
      action: "admin_announcement",
      target_type: "notification",
      target_id: "99999999-0000-4000-8000-000000000001",
      reason: ANNOUNCE_VALID.title,
    });
  });

  it("a duplicate retry (23505 on send_key) converges to duplicate — no second audit row", async () => {
    const admin = mockAdminClient();
    admin.queue("notifications", { data: null, error: { message: "duplicate key", code: "23505" } });
    const result = await sendPlatformAnnouncement({ actorId: ADMIN, payload: announcementSchema.parse({ ...ANNOUNCE_VALID }) });
    expect(result).toEqual({ ok: true, duplicate: true });
    expect(admin.calls.filter((c) => c.op === "insert" && c.table === "community_moderation_actions")).toHaveLength(0);
  });

  it("rejects malformed input (short title, unknown type, non-uuid sendKey, extra fields)", () => {
    for (const bad of [
      { ...ANNOUNCE_VALID, title: "ab" },
      { ...ANNOUNCE_VALID, type: "social" },
      { ...ANNOUNCE_VALID, sendKey: "not-a-uuid" },
      { ...ANNOUNCE_VALID, actor: ADMIN },
      { ...ANNOUNCE_VALID, linkUrl: "http://insecure.example" },
      { ...ANNOUNCE_VALID, linkUrl: "javascript:alert(1)" },
    ]) {
      expect(announcementSchema.safeParse(bad).success).toBe(false);
    }
    expect(
      announcementSchema.safeParse({ ...ANNOUNCE_VALID, linkUrl: "https://ausbildungsweg.net/faq" }).success,
    ).toBe(true);
  });

  it("rejects oversized input (title > 120, content > 2000)", () => {
    expect(announcementSchema.safeParse({ ...ANNOUNCE_VALID, title: "x".repeat(121) }).success).toBe(false);
    expect(announcementSchema.safeParse({ ...ANNOUNCE_VALID, content: "x".repeat(2001) }).success).toBe(false);
  });

  it("route: unauthenticated → 401, normal user → 403 (no insert work)", async () => {
    const admin = mockAdminClient();
    mockSession(null);
    expect((await announcePOST(post("http://x/api/admin/announcements", ANNOUNCE_VALID))).status).toBe(401);

    mockSession({ id: ALICE });
    const res = await announcePOST(post("http://x/api/admin/announcements", ANNOUNCE_VALID));
    expect(res.status).toBe(403);
    expect(admin.calls.filter((c) => c.op === "insert" && c.table === "notifications")).toHaveLength(0);
  });

  it("route: a forged body (claiming the admin as sender) is never the actor", async () => {
    mockAdminClient();
    mockSession({ id: ALICE });
    const res = await announcePOST(
      post("http://x/api/admin/announcements", { ...ANNOUNCE_VALID, created_by: ADMIN, actorId: ADMIN }),
    );
    expect(res.status).toBe(403);
  });

  it("route: admin send → 201 + rate-limit headers; retry → 200 duplicate", async () => {
    const admin = mockAdminClient();
    admin.queue("notifications", { data: { id: "99999999-0000-4000-8000-000000000001" }, error: null });
    admin.queue("notifications", { data: null, error: { message: "dup", code: "23505" } });
    mockSession({ id: ADMIN });
    admin.queue("admins", { data: { user_id: ADMIN }, error: null });
    admin.queue("admins", { data: { user_id: ADMIN }, error: null });

    const first = await announcePOST(post("http://x/api/admin/announcements", ANNOUNCE_VALID));
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ ok: true, duplicate: false });
    expect(first.headers.get("x-ratelimit-limit")).toBe("60");

    const retry = await announcePOST(post("http://x/api/admin/announcements", ANNOUNCE_VALID));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true, duplicate: true });
    // two insert ATTEMPTS (first send + retry), but only the first created
    // a row — the retry hit the 23505 unique-index rejection and produced
    // no second audit row
    expect(admin.calls.filter((c) => c.op === "insert" && c.table === "notifications")).toHaveLength(2);
    expect(admin.calls.filter((c) => c.op === "insert" && c.table === "community_moderation_actions")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// D. MESSAGE MODERATION
// ---------------------------------------------------------------------------

describe("message moderation", () => {
  const MSG = "44444444-4444-4444-8444-444444444444";
  const ROOM = "55555555-5555-4555-8555-555555555555";

  function seedVisibleMessage(admin: AdminMock) {
    admin.queue("community_messages", { data: { id: MSG, room_id: ROOM, hidden_by: null }, error: null });
    admin.queue("community_rooms", { data: { slug: "general" }, error: null });
    admin.queue("community_messages", { data: null, error: null }); // the update
  }

  it("admin hides ANY user's message — writes exactly hidden_by + hidden_at, audited with room slug", async () => {
    const admin = mockAdminClient();
    seedVisibleMessage(admin);
    const result = await adminHideMessage({ actorId: ADMIN, messageId: MSG, reason: "Spam" });
    expect(result).toEqual({ ok: true, alreadyHidden: false });

    const updates = admin.calls.filter((c) => c.op === "update" && c.table === "community_messages");
    expect(updates).toHaveLength(1);
    const payload = updates[0].args[0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["hidden_at", "hidden_by"]);
    expect(payload.hidden_by).toBe(ADMIN);

    const audits = admin.calls.filter((c) => c.op === "insert" && c.table === "community_moderation_actions");
    expect(audits).toHaveLength(1);
    expect(audits[0].args[0]).toMatchObject({
      moderator_id: ADMIN,
      action: "admin_message_delete",
      target_type: "message",
      target_id: MSG,
      reason: "room:general · Spam",
    });
  });

  it("idempotent on an already-hidden message — no second update, no second audit", async () => {
    const admin = mockAdminClient();
    admin.queue("community_messages", { data: { id: MSG, room_id: ROOM, hidden_by: BOB }, error: null });
    const result = await adminHideMessage({ actorId: ADMIN, messageId: MSG });
    expect(result).toEqual({ ok: true, alreadyHidden: true });
    expect(admin.calls.filter((c) => c.op === "update")).toHaveLength(0);
    expect(admin.calls.filter((c) => c.table === "community_moderation_actions")).toHaveLength(0);
  });

  it("invalid target → invalid; missing target → not_found", async () => {
    mockAdminClient();
    expect(await adminHideMessage({ actorId: ADMIN, messageId: "nope" })).toEqual({ ok: false, error: "invalid" });
    const admin2 = mockAdminClient();
    admin2.queue("community_messages", { data: null, error: null });
    expect(await adminHideMessage({ actorId: ADMIN, messageId: MSG })).toEqual({ ok: false, error: "not_found" });
  });

  it("route: unauthenticated → 401, normal user → 403, bad uuid → 400 (no hide work)", async () => {
    const admin = mockAdminClient();
    mockSession(null);
    expect((await hidePOST(post(`http://x/api/admin/community/messages/${MSG}`), { params: Promise.resolve({ id: MSG }) })).status).toBe(401);

    mockSession({ id: ALICE });
    expect((await hidePOST(post(`http://x/api/admin/community/messages/${MSG}`), { params: Promise.resolve({ id: MSG }) })).status).toBe(403);

    mockSession({ id: ADMIN });
    admin.queue("admins", { data: { user_id: ADMIN }, error: null });
    const res = await hidePOST(post("http://x/api/admin/community/messages/77777777-7777-4777-8777-77777777777x"), {
      params: Promise.resolve({ id: "77777777-7777-4777-8777-77777777777x" }),
    });
    expect(res.status).toBe(400);
    expect(admin.calls.filter((c) => c.op === "update")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// B. BANS
// ---------------------------------------------------------------------------

describe("bans", () => {
  function seedBannable(admin: AdminMock) {
    admin.queue("community_profiles", { data: { user_id: BOB, display_name: "bob" }, error: null });
    admin.queue("community_bans", { data: null, error: null }); // insert ok
  }

  it("route: user search — 401 anonymous, 400 short query, wildcards neutralized", async () => {
    const admin = mockAdminClient();
    mockSession(null);
    expect((await usersGET(new Request("http://x/api/admin/community/users?q=abc"))).status).toBe(401);

    mockSession({ id: ADMIN });
    admin.queue("admins", { data: { user_id: ADMIN }, error: null });
    expect((await usersGET(new Request("http://x/api/admin/community/users?q=ab"))).status).toBe(400);

    admin.queue("admins", { data: { user_id: ADMIN }, error: null });
    admin.queue("profiles", { data: [{ id: ALICE, email: "alice@example.com", full_name: "Alice", created_at: "2026-01-01T00:00:00Z" }], error: null });
    admin.queue("community_profiles", { data: [{ user_id: ALICE, display_name: "alice", created_at: "2026-01-01T00:00:00Z", community_suspended: false, community_muted_until: null }], error: null });
    admin.queue("community_bans", { data: [], error: null });
    admin.queue("community_memberships", { data: [{ user_id: ALICE, role: "member" }], error: null });
    const res = await usersGET(new Request("http://x/api/admin/community/users?q=a%25b%25c"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ userId: string; banned: boolean }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].userId).toBe(ALICE);
    expect(body.items[0].banned).toBe(false);
    // the LIKE metacharacters from the input must not survive into the
    // pattern ("a%b%c" → "abc" → "%abc%")
    const ilikes = admin.calls.filter((c) => c.op === "ilike");
    expect(ilikes.length).toBeGreaterThan(0);
    for (const c of ilikes) {
      expect(c.args[1]).toBe("%abc%");
    }
  });

  it("admin can ban — persisted row (banned_by=actor) + audit admin_ban_user", async () => {
    const admin = mockAdminClient();
    seedBannable(admin);
    const result = await banUser({ actorId: ADMIN, targetUserId: BOB, reason: "Toxic", durationKey: "7d" });
    expect(result).toEqual({ ok: true });

    const inserts = admin.calls.filter((c) => c.op === "insert" && c.table === "community_bans");
    expect(inserts).toHaveLength(1);
    const payload = inserts[0].args[0] as Record<string, unknown>;
    expect(payload.user_id).toBe(BOB);
    expect(payload.banned_by).toBe(ADMIN);
    expect(payload.reason).toBe("Toxic");
    expect(typeof payload.expires_at).toBe("string");

    const audits = admin.calls.filter((c) => c.op === "insert" && c.table === "community_moderation_actions");
    expect(audits).toHaveLength(1);
    const auditPayload = audits[0].args[0] as Record<string, unknown>;
    expect(auditPayload.action).toBe("admin_ban_user");
    expect(String(auditPayload.reason)).toContain("bob");
  });

  it("self-ban impossible; the platform admin itself is protected", async () => {
    mockAdminClient();
    expect(await banUser({ actorId: ADMIN, targetUserId: ADMIN })).toEqual({ ok: false, error: "self_ban" });
    // the guard is id-based and independent of the actor (a hypothetical
    // second sanctioned admin could never ban the platform admin):
    expect(await banUser({ actorId: ALICE, targetUserId: ADMIN })).toEqual({
      ok: false,
      error: "admin_protected",
    });
    // the lib guards the TARGET (actor authorization is the route's job —
    // the 403 for a normal user is covered in the route test). Unknown
    // community user → not_found.
    expect(await banUser({ actorId: ALICE, targetUserId: BOB })).toEqual({ ok: false, error: "not_found" });
  });

  it("duplicate active ban → already_banned (23505, the partial unique index)", async () => {
    const admin = mockAdminClient();
    admin.queue("community_profiles", { data: { user_id: BOB, display_name: "bob" }, error: null });
    admin.queue("community_bans", { data: null, error: { message: "dup", code: "23505" } });
    expect(await banUser({ actorId: ADMIN, targetUserId: BOB })).toEqual({ ok: false, error: "already_banned" });
  });

  it("ban of a non-community user → not_found", async () => {
    const admin = mockAdminClient();
    admin.queue("community_profiles", { data: null, error: null });
    expect(await banUser({ actorId: ADMIN, targetUserId: BOB })).toEqual({ ok: false, error: "not_found" });
  });

  it("route: unauthenticated → 401, normal user → 403 (no ban work)", async () => {
    const admin = mockAdminClient();
    mockSession(null);
    expect((await banPOST(post("http://x", { ban: true }), { params: Promise.resolve({ id: BOB }) })).status).toBe(401);
    mockSession({ id: ALICE });
    const res = await banPOST(post("http://x", { ban: true }), { params: Promise.resolve({ id: BOB }) });
    expect(res.status).toBe(403);
    expect(admin.calls.filter((c) => c.table === "community_bans")).toHaveLength(0);
  });

  it("admin can unban — revoked_at timestamp, the row survives (never deleted)", async () => {
    const admin = mockAdminClient();
    admin.queue("community_profiles", { data: { user_id: BOB, display_name: "bob" }, error: null });
    admin.queue("community_bans", { data: [{ id: "77777777-7777-4777-8777-777777777777" }], error: null });
    const result = await unbanUser({ actorId: ADMIN, targetUserId: BOB });
    expect(result).toEqual({ ok: true });

    const updates = admin.calls.filter((c) => c.op === "update" && c.table === "community_bans");
    expect(updates).toHaveLength(1);
    const payload = updates[0].args[0] as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["revoked_at"]);
    expect(admin.calls.filter((c) => c.op === "delete" && c.table === "community_bans")).toHaveLength(0);

    const audits = admin.calls.filter((c) => c.op === "insert" && c.table === "community_moderation_actions");
    expect(audits).toHaveLength(1);
    expect((audits[0].args[0] as Record<string, unknown>).action).toBe("admin_unban_user");
  });

  it("unban of a user without an active ban → not_banned", async () => {
    const admin = mockAdminClient();
    admin.queue("community_profiles", { data: null, error: null });
    admin.queue("community_bans", { data: [], error: null });
    expect(await unbanUser({ actorId: ADMIN, targetUserId: BOB })).toEqual({ ok: false, error: "not_banned" });
  });

  it("banned user is blocked from Community mutations (write gate → 'banned')", async () => {
    const admin = mockAdminClient();
    // two reads: the direct fetchCommunityBanState + the one inside the gate
    admin.queue("community_bans", { data: { reason: "Toxic", expires_at: null }, error: null });
    admin.queue("community_bans", { data: { reason: "Toxic", expires_at: null }, error: null });
    const ban = await fetchCommunityBanState(BOB);
    expect(ban).toEqual({ banned: true, reason: "Toxic", expiresAt: null });
    const gate = await fetchCommunityWriteGate(BOB);
    expect(gate).toEqual({ writable: false, code: "banned" });
  });

  it("an expired ban lifts itself (not banned, writable)", async () => {
    const admin = mockAdminClient();
    const past = new Date(Date.now() - 60_000).toISOString();
    admin.queue("community_bans", { data: { reason: "old", expires_at: past }, error: null });
    expect(await fetchCommunityBanState(BOB)).toEqual({ banned: false });
    admin.queue("community_profiles", { data: { community_suspended: false, community_muted_until: null }, error: null });
    expect(await fetchCommunityWriteGate(BOB)).toEqual({ writable: true });
  });
});

// ---------------------------------------------------------------------------
// E. ADMIN PROFILE / BADGE / NAME
// ---------------------------------------------------------------------------

describe("admin profile, name rules and badge", () => {
  it("the designated admin may use a custom display name (spaces, emoji, 1–40 chars)", () => {
    expect(isValidAdminCommunityName("Alex Müller 🇩🇪")).toBe(true);
    expect(isValidAdminCommunityName("a".repeat(40))).toBe(true);
    expect(isValidAdminCommunityName("a".repeat(41))).toBe(false);
    expect(isValidAdminCommunityName("")).toBe(false);
    expect(isValidAdminCommunityName("  ")).toBe(false);
    expect(isValidAdminCommunityName("bad\u0007control")).toBe(false);
  });

  it("normal users keep the strict username rules — the exception is admin-only", () => {
    // /^[A-Za-z][A-Za-z0-9]{2,23}$/ — letters+digits only, 3–24 chars
    expect(isValidCommunityUsername("BlueFalcon")).toBe(true);
    expect(isValidCommunityUsername("alex.mueller")).toBe(false); // no dots
    expect(isValidCommunityUsername("Alex Müller 🇩🇪")).toBe(false); // no spaces/emoji
    expect(isValidCommunityUsername("a".repeat(41))).toBe(false);
  });

  it("the badge renders red (bg-danger) with the localized accessible label", () => {
    const label = "Verifizierter Plattform-Administrator";
    const html = renderToString(
      React.createElement(AdminBadge, { label, size: 14 }),
    );
    expect(html).toContain("bg-danger");
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain("role=\"img\"");
  });
});

// ---------------------------------------------------------------------------
// SECURITY — static source / migration guards
// ---------------------------------------------------------------------------

const readSrc = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("security invariants (static)", () => {
  it("privileged modules are server-only", () => {
    expect(readSrc("src/lib/community/platform-admin.ts")).toMatch(/^import "server-only";/);
    expect(readSrc("src/lib/community/admin-ops.ts")).toMatch(/^import "server-only";/);
  });

  it("no client component imports the service-role client", () => {
    for (const f of [
      "src/components/admin-announcements.tsx",
      "src/components/admin-community.tsx",
      "src/components/admin-identity-form.tsx",
      "src/components/admin-nav.tsx",
      "src/components/community/admin-badge.tsx",
    ]) {
      expect(readSrc(f)).not.toMatch(/supabase\/admin|createAdminClient/);
    }
  });

  it("every new platform-admin API route authorizes with isPlatformAdmin()", () => {
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(p));
        else if (e.name === "route.ts") out.push(p);
      }
      return out;
    };
    const routes = [...walk(join(ROOT, "src/app/api/admin/announcements")), ...walk(join(ROOT, "src/app/api/admin/community"))];
    expect(routes.length).toBeGreaterThanOrEqual(4);
    for (const r of routes) {
      const src = readFileSync(r, "utf8");
      expect(src, r).toMatch(/isPlatformAdmin\(\)/);
    }
    // the pre-existing billing-admin routes keep their own gate
    for (const r of [join(ROOT, "src/app/api/admin/users/route.ts"), join(ROOT, "src/app/api/admin/users/[id]/route.ts")]) {
      expect(readFileSync(r, "utf8"), r).toMatch(/requireAdmin/);
    }
  });

  it("v10 disables no RLS, grants no anon/public policy, and has no executable ALTER TYPE", () => {
    const v10 = readSrc("supabase/migrations/20261104000000_community_v10_platform_admin.sql");
    expect(v10).not.toMatch(/disable row level security/i);
    expect(v10).not.toMatch(/to anon\b/i);
    expect(v10).not.toMatch(/\bto public\b/i);
    expect(v10).not.toMatch(/^\s*alter type\b/im);
    // the reference to the new enum value appears in EXECUTABLE code (the
    // CHECK constraint) — its value was committed by v10a in a PRIOR
    // transaction, so no same-transaction ADD VALUE is needed
    expect(v10.replace(/^--.*$/gm, "")).toContain("'announcement'");
  });

  it("v10a is a standalone, idempotent, single-statement enum migration", () => {
    const v10a = readSrc("supabase/migrations/20261103235900_community_v10a_announcement_enum.sql");
    const executable = v10a
      .replace(/^--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(executable).toHaveLength(1);
    expect(executable[0].toLowerCase()).toBe(
      "alter type public.notification_type add value if not exists 'announcement'",
    );
    expect(v10a).not.toMatch(/^\s*(insert|update|delete|alter table|create policy|drop policy)\b/im);
  });

  it("community_is_banned() stays fail-closed for anon and pinned to public", () => {
    const v10 = readSrc("supabase/migrations/20261104000000_community_v10_platform_admin.sql");
    expect(v10).toContain("revoke execute on function public.community_is_banned() from public, anon;");
    expect(v10).toContain("set search_path = public");
  });

  it("the email constant is documentation-only — never used as authorization", () => {
    const src = readSrc("src/lib/community/platform-admin.ts");
    const usages = src.split("PLATFORM_ADMIN_EMAIL").length - 1;
    expect(usages).toBe(1); // the single export line
  });
});
