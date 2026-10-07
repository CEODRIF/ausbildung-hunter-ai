/**
 * /admin route authorization — production incident regression suite.
 *
 * Incident (2026-10-08): the designated platform admin
 * (contact@ausbildungsweg.net) was redirected from /admin to the normal
 * user dashboard. Root-cause chain:
 *
 *   /admin layout gate = `public.admins` membership for the session user
 *   (requireAdmin). The ONLY code path that ever creates that row for the
 *   designated admin is the v10 seed — a one-shot, email-conditional insert
 *   that ran exclusively at v10 apply time. If it was a no-op then
 *   (account created later, email different, or v10 pending in production),
 *   no later deploy could repair it and the gate bounced the admin to
 *   /dashboard with zero diagnostics.
 *
 * This suite pins:
 *
 *   ROUTE DECISIONS (the layout gate, exercised through its real function)
 *     - configured admin id + membership  → access (ok / profile)
 *     - normal authenticated user         → denied (forbidden no_membership)
 *     - unauthenticated                   → denied (unauthenticated → /login)
 *     - spoofed client email              → denied (id is the identity)
 *     - wrong admin id WITH membership    → denied (id must be the configured one)
 *     - missing admin membership          → denied (not_bound / no_membership)
 *     - requireAdmin() wrapper behavior preserved (ok → profile, else null)
 *
 *   ROUTE REDIRECT CONTRACT (source invariants)
 *     - the /admin layout contains NO redirect("/dashboard") — a valid admin
 *       is never bounced to the user dashboard, and a non-member sees an
 *       explicit server-rendered 403 (AdminForbidden) instead of a silent
 *       bounce; the denial reason is logged server-side
 *     - unauthenticated still goes to /login
 *     - the 403 page is a dead end (no admin nav/content, user-initiated link)
 *     - the billing-admin path (platform check → /admin/users) is intact
 *
 *   CONFIGURATION
 *     - PLATFORM_ADMIN_USER_ID is a server-side constant, NOT an env var
 *       (nothing in platform-admin.ts reads process.env; no admin id exists
 *       in .env.example) — so a missing Vercel env var can never be the cause
 *
 *   MIGRATION v11 (the heal)
 *     - idempotent, keeps the v10 email guard verbatim, inserts ONLY for
 *       the designated UUID, touches no RLS/policies
 *
 *   API ROUTES (independent of the page gate)
 *     - /api/admin/announcements: 401 unauthenticated, 403 normal user
 *     - /api/admin/community/users: 401 unauthenticated, 403 normal user
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  diagnoseAdminAccess,
  requireAdmin,
} from "@/lib/billing/admin";
import {
  PLATFORM_ADMIN_EMAIL,
  PLATFORM_ADMIN_USER_ID,
  isPlatformAdmin,
  requirePlatformAdmin,
} from "@/lib/community/platform-admin";
import { AdminForbidden } from "@/components/admin-forbidden";

import { POST as announcePOST } from "@/app/api/admin/announcements/route";
import { GET as usersGET } from "@/app/api/admin/community/users/route";

// ---------------------------------------------------------------------------
// Fixtures + mocks
// ---------------------------------------------------------------------------

const ADMIN = PLATFORM_ADMIN_USER_ID; // 6fa45036-… (the configured id)
const ALICE = "11111111-1111-4111-8111-111111111111"; // normal user
const BOB = "22222222-2222-4222-8222-222222222222"; // wrong id, HAS membership
const ROOT = join(__dirname, "..");

type Result = { data: unknown; error: { message: string; code?: string } | null };
type AdminMock = {
  calls: Array<{ op: string; table: string; args: unknown[] }>;
  queue: (table: string, ...results: Result[]) => void;
};

function mockAdminClient(): AdminMock {
  const calls: AdminMock["calls"] = [];
  const queues = new Map<string, Result[]>();
  const client = {
    from: (table: string) => {
      const q = () => (queues.get(table) ?? []).shift() ?? { data: null, error: null };
      const rec = (op: string, ...args: unknown[]) => calls.push({ op, table, args });
      const chainable: Record<string, unknown> = {
        select: (sel: unknown) => (rec("select", sel), chainable),
        eq: (c: string, v: unknown) => (rec("eq", c, v), chainable),
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

function mockSession(user: { id: string; email?: string } | null) {
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user }, error: null })) },
  } as never);
}

const PROFILE = {
  id: ADMIN,
  email: PLATFORM_ADMIN_EMAIL,
  full_name: "Platform",
  avatar_url: null,
  selected_goal: null,
  daily_email_limit: 50,
  account_status: "active",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

afterEach(() => {
  vi.clearAllMocks();
});

const readSrc = (p: string) => readFileSync(join(ROOT, p), "utf8");

// ---------------------------------------------------------------------------
// A. ROUTE DECISIONS — the layout gate through its real function
// ---------------------------------------------------------------------------

describe("/admin route decisions (diagnoseAdminAccess)", () => {
  it("1. configured admin id + admins membership → access granted (ok + profile)", async () => {
    const admin = mockAdminClient();
    admin.queue("admins", { data: { user_id: ADMIN }, error: null });
    admin.queue("profiles", { data: PROFILE, error: null });
    mockSession({ id: ADMIN, email: PLATFORM_ADMIN_EMAIL });

    const access = await diagnoseAdminAccess();
    expect(access.status).toBe("ok");
    if (access.status === "ok") expect(access.profile.id).toBe(ADMIN);

    // the long-standing wrapper keeps its exact contract:
    admin.queue("admins", { data: { user_id: ADMIN }, error: null });
    admin.queue("profiles", { data: PROFILE, error: null });
    expect((await requireAdmin())?.id).toBe(ADMIN);
  });

  it("2. normal authenticated user → denied (forbidden: no_membership)", async () => {
    const admin = mockAdminClient();
    admin.queue("admins", { data: null, error: null });
    mockSession({ id: ALICE, email: "alice@example.com" });

    const access = await diagnoseAdminAccess();
    expect(access).toEqual({ status: "forbidden", reason: "no_membership", userId: ALICE });
    expect(await requireAdmin()).toBeNull();
  });

  it("3. unauthenticated → denied (unauthenticated; the layout sends this to /login)", async () => {
    mockAdminClient();
    mockSession(null);
    expect(await diagnoseAdminAccess()).toEqual({ status: "unauthenticated" });
    expect(await requireAdmin()).toBeNull();
    expect(await requirePlatformAdmin()).toBeNull();
    expect(await isPlatformAdmin()).toEqual({ ok: false, code: "unauthenticated" });
  });

  it("4. spoofed client email never authorizes — identity is the session id", async () => {
    const admin = mockAdminClient();
    mockSession({ id: ALICE, email: PLATFORM_ADMIN_EMAIL });

    // the platform check fails on the id BEFORE the DB is ever consulted:
    expect(await isPlatformAdmin()).toEqual({ ok: false, code: "not_admin" });
    expect(admin.calls.filter((c) => c.table === "admins")).toHaveLength(0);

    // and the route gate treats the same (no-membership) session as a
    // normal user:
    admin.queue("admins", { data: null, error: null });
    const access = await diagnoseAdminAccess();
    expect(access).toEqual({ status: "forbidden", reason: "no_membership", userId: ALICE });
  });

  it("5. wrong admin id WITH a real membership row → still denied", async () => {
    const admin = mockAdminClient();
    admin.queue("admins", { data: { user_id: BOB }, error: null });
    admin.queue("profiles", { data: { ...PROFILE, id: BOB }, error: null });
    mockSession({ id: BOB });

    // the PLATFORM check demands the configured id — membership alone
    // (e.g. a billing admin) does not grant platform admin:
    expect(await isPlatformAdmin()).toEqual({ ok: false, code: "not_admin" });
    // (the billing gate would pass for BOB — that is /admin/users, a
    //  different, intended surface; the platform surface is denied)
  });

  it("6. configured admin id but MISSING admins membership → denied", async () => {
    const admin = mockAdminClient();
    admin.queue("admins", { data: null, error: null });
    mockSession({ id: ADMIN, email: PLATFORM_ADMIN_EMAIL });

    expect(await isPlatformAdmin()).toEqual({ ok: false, code: "not_bound" });
    const access = await diagnoseAdminAccess();
    expect(access).toEqual({ status: "forbidden", reason: "no_membership", userId: ADMIN });
    expect(await requireAdmin()).toBeNull();
  });

  it("an admins read error fails closed (never grants)", async () => {
    const admin = mockAdminClient();
    admin.queue("admins", { data: null, error: { message: "boom" } });
    mockSession({ id: ADMIN });
    // the service-role read errored → treated as no membership:
    expect(await isPlatformAdmin()).toEqual({ ok: false, code: "not_bound" });
    expect((await diagnoseAdminAccess()).status).not.toBe("ok");
  });

  it("missing profile row → denied with the no_profile reason", async () => {
    const admin = mockAdminClient();
    admin.queue("admins", { data: { user_id: ADMIN }, error: null });
    admin.queue("profiles", { data: null, error: null });
    mockSession({ id: ADMIN });
    expect(await diagnoseAdminAccess()).toEqual({
      status: "forbidden",
      reason: "no_profile",
      userId: ADMIN,
    });
  });
});

// ---------------------------------------------------------------------------
// B. ROUTE REDIRECT CONTRACT (source invariants)
// ---------------------------------------------------------------------------

describe("/admin route redirect contract", () => {
  it("7. the layout NEVER redirects to /dashboard — a valid admin is not bounced", () => {
    const layout = readSrc("src/app/admin/layout.tsx");
    expect(layout).not.toContain('redirect("/dashboard")');
    expect(layout).not.toContain("redirect('/dashboard')");
  });

  it("unauthenticated still goes to /login (the only remaining redirect)", () => {
    const layout = readSrc("src/app/admin/layout.tsx");
    expect(layout).toContain('redirect("/login")');
    expect(layout).toContain("diagnoseAdminAccess");
  });

  it("authenticated non-members get the explicit 403 page + a server-side log", () => {
    const layout = readSrc("src/app/admin/layout.tsx");
    expect(layout).toContain("AdminForbidden");
    // the denial reason is logged server-side (user id + which check failed):
    expect(layout).toContain("access denied user=");
    expect(layout).toContain("reason=");
  });

  it("the 403 page is a dead end: no admin content, user-initiated link only", () => {
    const html = renderToString(React.createElement(AdminForbidden));
    expect(html).toContain("403");
    expect(html).toContain("No admin access");
    expect(html).toContain('href="/dashboard"');
    // no admin nav / platform sections leak into the denial page:
    expect(html).not.toContain("Announcements");
    expect(html).not.toContain("Moderation");
    expect(html).not.toContain('aria-label="Admin"');
  });

  it("the billing-admin path is intact: platform check → /admin/users for non-platform admins", () => {
    const page = readSrc("src/app/admin/page.tsx");
    expect(page).toContain("isPlatformAdmin()");
    expect(page).toContain('redirect("/admin/users")');
  });

  it("the gate runs server-side; the 403 page carries no client trust", () => {
    const layout = readSrc("src/app/admin/layout.tsx");
    expect(layout).not.toContain('"use client"');
    expect(readSrc("src/components/admin-forbidden.tsx")).not.toContain('"use client"');
    expect(readSrc("src/lib/billing/admin.ts")).toMatch(/^import "server-only";/);
  });
});

// ---------------------------------------------------------------------------
// C. CONFIGURATION — the admin id is a server constant, not an env var
// ---------------------------------------------------------------------------

describe("PLATFORM_ADMIN_USER_ID configuration", () => {
  it("is a literal server-side constant — no env var can be missing or spoofed", () => {
    const src = readSrc("src/lib/community/platform-admin.ts");
    expect(src).toMatch(/^import "server-only";/);
    expect(src).not.toContain("process.env");
    expect(src).toContain(`export const PLATFORM_ADMIN_USER_ID = "${ADMIN}";`);
    // .env.example does not define any admin-id variable (NOT USED by code):
    expect(readSrc(".env.example")).not.toMatch(/admin/i);
  });
});

// ---------------------------------------------------------------------------
// D. MIGRATION v11 — the idempotent heal
// ---------------------------------------------------------------------------

describe("v11 admin membership heal migration", () => {
  const V11 = () => readSrc("supabase/migrations/20261105000000_community_v11_admin_membership_heal.sql");
  const V10 = () => readSrc("supabase/migrations/20261104000000_community_v10_platform_admin.sql");

  it("keeps the v10 email guard verbatim (same UUID + same email double check)", () => {
    const v11 = V11().replace(/^--.*$/gm, "");
    const v10 = V10().replace(/^--.*$/gm, "");
    expect(v11).toContain(`where u.id = '${ADMIN}'`);
    expect(v11).toContain("lower(u.email) = 'contact@ausbildungsweg.net'");
    // identical guard semantics to v10:
    expect(v11).toMatch(/u\.id = '[0-9a-f-]{36}'[\s\S]*lower\(u\.email\) = 'contact@ausbildungsweg\.net'/);
    expect(v10).toContain("lower(u.email) = 'contact@ausbildungsweg.net'");
  });

  it("is idempotent (on conflict) and inserts ONLY for the designated UUID", () => {
    const v11 = V11().replace(/^--.*$/gm, "");
    expect(v11).toContain("on conflict (user_id) do nothing");
    const uuids = [...v11.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)];
    expect(new Set(uuids.map((m) => m[0].toLowerCase()))).toEqual(new Set([ADMIN.toLowerCase()]));
  });

  it("touches no RLS, grants no policy, and inserts no other accounts", () => {
    const v11 = V11().replace(/^--.*$/gm, "");
    expect(v11).not.toMatch(/disable row level security/i);
    expect(v11).not.toMatch(/create policy|drop policy|alter policy|grant\b/i);
    // the legacy owner UUID (99a30c47-…) must not appear anywhere:
    expect(v11).not.toContain("99a30c47");
  });
});

// ---------------------------------------------------------------------------
// E. API ROUTES — independent of the page gate
// ---------------------------------------------------------------------------

describe("admin API routes authorize independently", () => {
  function post(url: string, body: unknown): Request {
    return new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("/api/admin/announcements: unauthenticated → 401, normal user → 403", async () => {
    mockAdminClient();
    mockSession(null);
    expect((await announcePOST(post("http://x/api/admin/announcements", { title: "t".repeat(20) }))).status).toBe(401);

    mockSession({ id: ALICE, email: "alice@example.com" });
    const res = await announcePOST(
      post("http://x/api/admin/announcements", {
        title: "Wartungsarbeiten am Samstag",
        content: "offline",
        type: "maintenance",
        sendKey: "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("/api/admin/community/users: unauthenticated → 401, normal user → 403", async () => {
    mockAdminClient();
    mockSession(null);
    expect((await usersGET(new Request("http://x/api/admin/community/users?q=abc"))).status).toBe(401);

    mockSession({ id: ALICE });
    expect((await usersGET(new Request("http://x/api/admin/community/users?q=abc"))).status).toBe(403);
  });

  it("a forged body claiming the admin as actor is never the actor", async () => {
    const admin = mockAdminClient();
    mockSession({ id: ALICE });
    const res = await announcePOST(
      post("http://x/api/admin/announcements", {
        title: "Wartungsarbeiten am Samstag",
        content: "offline",
        type: "maintenance",
        sendKey: "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0",
        created_by: ADMIN,
        actorId: ADMIN,
      }),
    );
    expect(res.status).toBe(403);
    expect(admin.calls.filter((c) => c.op === "insert" && c.table === "notifications")).toHaveLength(0);
  });
});
