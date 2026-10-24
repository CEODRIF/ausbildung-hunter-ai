/**
 * Billing security & cross-user isolation — regression guards.
 *
 * The billing surface's security model is structural (who can read/write
 * what is pinned by migrations and server-only boundaries), so this suite
 * pins it in three layers:
 *
 *   1. RUNTIME (mocked Supabase boundary): cross-user isolation of the
 *      checkout read (dual id + user_id filter), the mock-payments
 *      production env matrix (fail closed in every production runtime).
 *   2. STATIC (source text): service-role boundary (no client component
 *      may import the admin client or reference service-role
 *      identifiers; all billing facades are `server-only`).
 *   3. STATIC (migration text): the RLS policy inventory of the billing
 *      schema — self-read-only policies, NO user write path on any
 *      billing table, and zero policies on the audit/event/mock tables
 *      (service-role only). Mock checkout RPCs: revoked from
 *      authenticated/public, granted to service_role.
 *
 * Companion document: docs/billing-security-audit-2026-10-24.md
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ admin: null as unknown }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => holder.admin,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => null,
}));

const { getMockCheckout } = await import("@/lib/billing/mock-checkout");
const { mockPaymentsEnabled } = await import(
  "@/lib/billing/entitlement-service"
);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");

const MIG = (name: string) => `supabase/migrations/${name}`;
const V1 = read(MIG("20261001000000_billing_and_admin.sql"));
const V2 = read(MIG("20261120000000_subscription_billing_v2.sql"));
const QUOTAS = read(MIG("20261121000000_feature_quotas.sql"));
const MOCK = read(MIG("20261122000000_mock_checkout_complete.sql"));
const CAPACITY = read(MIG("20261123000000_saved_application_capacity.sql"));
const ALL_MIGRATIONS = [V1, V2, QUOTAS, MOCK, CAPACITY];

const WEBHOOK = read("src/app/api/billing/webhook/route.ts");
const ADMIN_ROUTE = read("src/app/api/admin/users/[id]/route.ts");
const ACTIONS = read("src/app/settings/billing/actions.ts");

const USER = "11111111-1111-4111-8111-411111111111";
const CHECKOUT = "22222222-2222-4222-8222-222222222222";

// ---------------------------------------------------------------------------
// 1a. Cross-user isolation — checkout read is scoped by id AND user_id
// ---------------------------------------------------------------------------

interface Call {
  table: string;
  filters: Record<string, unknown>;
}

function makeScopedAdmin() {
  const calls: Call[] = [];
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const chain = {
      select: () => chain,
      eq: (c: string, v: unknown) => {
        filters[c] = v;
        return chain;
      },
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => {
        calls.push({ table, filters: { ...filters } });
        return { data: null, error: null };
      },
    };
    return chain;
  };
  return { from, calls };
}

describe("cross-user isolation — mock checkout read", () => {
  it("filters by checkout id AND the session user id (dual scope)", async () => {
    const admin = makeScopedAdmin();
    holder.admin = admin;
    const res = await getMockCheckout(USER, CHECKOUT);
    // No row returned → explicit not_found (never a guessed checkout):
    expect(res).toEqual({ ok: false, error: "not_found" });
    expect(admin.calls).toHaveLength(1);
    expect(admin.calls[0].table).toBe("mock_checkouts");
    expect(admin.calls[0].filters).toMatchObject({
      id: CHECKOUT,
      user_id: USER,
    });
  });

  it("rejects non-UUID ids without a database call", async () => {
    const admin = makeScopedAdmin();
    holder.admin = admin;
    expect(await getMockCheckout("x", CHECKOUT)).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(await getMockCheckout(USER, "not-a-uuid")).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(admin.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 1b. Mock payments — production env matrix (fail closed)
// ---------------------------------------------------------------------------

async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => unknown,
): Promise<unknown> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("mock payments — never enabled in production", () => {
  it("flag on but NODE_ENV=production → disabled", async () => {
    await withEnv(
      { MOCK_PAYMENTS_ENABLED: "true", NODE_ENV: "production", VERCEL_ENV: undefined },
      () => expect(mockPaymentsEnabled()).toBe(false),
    );
  });

  it("flag on but VERCEL_ENV=production → disabled", async () => {
    await withEnv(
      { MOCK_PAYMENTS_ENABLED: "true", NODE_ENV: "development", VERCEL_ENV: "production" },
      () => expect(mockPaymentsEnabled()).toBe(false),
    );
  });

  it("flag off in any non-prod runtime → disabled", async () => {
    await withEnv(
      { MOCK_PAYMENTS_ENABLED: undefined, NODE_ENV: "development", VERCEL_ENV: undefined },
      () => expect(mockPaymentsEnabled()).toBe(false),
    );
  });

  it("flag on in a genuine development runtime → enabled", async () => {
    await withEnv(
      { MOCK_PAYMENTS_ENABLED: "true", NODE_ENV: "development", VERCEL_ENV: undefined },
      () => expect(mockPaymentsEnabled()).toBe(true),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Service-role boundary — no client component may touch the admin client
// ---------------------------------------------------------------------------

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("service-role boundary", () => {
  const srcFiles = walk(resolve(root, "src"));
  const clientFiles = srcFiles.filter((f) =>
    readFileSync(f, "utf8").trimStart().startsWith('"use client"'),
  );

  it("there are client components to audit", () => {
    expect(clientFiles.length).toBeGreaterThan(10);
  });

  it("NO client component imports the admin client or references service-role identifiers", () => {
    for (const f of clientFiles) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toContain("@/lib/supabase/admin");
      expect(src, f).not.toContain("createAdminClient");
      expect(src, f).not.toContain("service_role");
      expect(src, f).not.toContain("SERVICE_ROLE");
      expect(src, f).not.toContain("supabaseAdmin");
    }
  });

  it("every billing module that touches Supabase is a server-only module", () => {
    const billingDir = resolve(root, "src/lib/billing");
    let found = 0;
    for (const entry of readdirSync(billingDir)) {
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      const src = read(`src/lib/billing/${entry}`);
      if (src.includes("@/lib/supabase/admin") || src.includes("createAdminClient")) {
        found += 1;
        expect(src.includes('import "server-only";'), entry).toBe(true);
      }
    }
    // The guard must actually cover the facades (not vacuously pass).
    expect(found).toBeGreaterThanOrEqual(5);
  });

  it("the admin client is constructed solely from server env (no client build path)", () => {
    const adminClient = read("src/lib/supabase/admin.ts");
    expect(adminClient).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(adminClient).toContain("process.env");
    expect(adminClient).toContain('import "server-only";');
  });
});

// ---------------------------------------------------------------------------
// 3. RLS inventory — the billing schema's policy surface is self-read only
// ---------------------------------------------------------------------------

/** Collect (table, command) pairs from `create policy` statements. */
function policyInventory(sqlText: string): Array<{ table: string; command: string; using: string | null }> {
  const flat = sqlText.replace(/\s+/g, " ");
  const out: Array<{ table: string; command: string; using: string | null }> = [];
  const re =
    /create policy "[^"]+" on public\.(\w+) for (select|insert|update|delete|all)(?: to (\w+))? using \(([^;]*)\);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(flat)) !== null) {
    out.push({ table: m[1], command: m[2], using: m[4] ?? null });
  }
  return out;
}

describe("RLS inventory — billing schema (migration text)", () => {
  const all = ALL_MIGRATIONS.flatMap(policyInventory);

  it("every policy is SELECT-only — no user write path on any billing table", () => {
    for (const p of all) {
      expect(p.command, `policy on ${p.table}`).toBe("select");
    }
  });

  it("self-scoped policies compare user_id against auth.uid()", () => {
    const selfScoped = all.filter((p) =>
      ["subscriptions", "feature_usage", "feature_usage_runs"].includes(p.table),
    );
    expect(selfScoped).toHaveLength(3);
    for (const p of selfScoped) {
      expect(p.using).toBeTruthy();
      expect(p.using).toContain("user_id");
      expect(p.using).toContain("auth.uid()");
    }
  });

  it("the only non-self-scoped policy is the public plan catalog read", () => {
    const catalog = all.filter((p) => p.table === "billing_plans");
    expect(catalog).toHaveLength(1);
    expect(catalog[0].using).toBe("true");
  });

  it("audit / event / mock tables carry ZERO policies (service-role only)", () => {
    for (const table of ["admins", "admin_audit_log", "subscription_events", "mock_checkouts"]) {
      expect(
        all.filter((p) => p.table === table),
        `policies on ${table}`,
      ).toEqual([]);
    }
  });

  it("RLS is enabled on every billing table", () => {
    for (const table of [
      "billing_plans",
      "subscriptions",
      "admins",
      "admin_audit_log",
      "subscription_events",
      "mock_checkouts",
      "feature_usage",
      "feature_usage_runs",
    ]) {
      const flat = ALL_MIGRATIONS.map((s) => s.replace(/\s+/g, " ")).join(" | ");
      expect(flat).toContain(`alter table public.${table} enable row level security`);
    }
  });

  it("mock checkout RPCs are revoked from public/anon/authenticated and granted to service_role only", () => {
    const flat = MOCK.replace(/\s+/g, " ");
    for (const fn of ["create_mock_checkout", "complete_mock_checkout"]) {
      expect(
        new RegExp(
          `revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated;`,
        ).test(flat),
        `revoke for ${fn}`,
      ).toBe(true);
      expect(
        new RegExp(
          `grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`,
        ).test(flat),
        `grant for ${fn}`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. API surface — webhook inert, admin route gated, actions session-only
// ---------------------------------------------------------------------------

describe("API surface contracts", () => {
  it("webhook route answers 501 billing_provider_not_configured and never pretends to process payments", () => {
    expect(WEBHOOK).toContain('"billing_provider_not_configured"');
    expect(WEBHOOK).toContain("status: 501");
    expect(WEBHOOK).toContain("verifyBillingWebhook");
    // The unconfigured path is terminal: the only success branch is
    // explicitly unreachable while no provider is configured.
    expect(WEBHOOK).toContain("Unreachable while no provider is configured");
  });

  it("admin route: requireAdmin before any action, uuid + rate limit + strict action enum", () => {
    expect(ADMIN_ROUTE).toContain("requireAdmin");
    expect(ADMIN_ROUTE).toContain("isUuid");
    expect(ADMIN_ROUTE).toContain("set_plan");
    expect(ADMIN_ROUTE).toContain("cancel_subscription");
    expect(ADMIN_ROUTE).toContain("reactivate_subscription");
    expect(ADMIN_ROUTE).toContain("grant_admin");
    expect(ADMIN_ROUTE).toContain("revoke_admin");
    // The actor is derived from the session, not the body:
    expect(ADMIN_ROUTE).toContain("adminUser.id");
    expect(ADMIN_ROUTE).not.toContain('body.actor');
  });

  it("billing server actions accept only intent fields (no identity, no user id)", () => {
    const fields = [...ACTIONS.matchAll(/formData\.get\(\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    for (const f of fields) {
      expect(["plan_id", "idempotency_key", "checkout_id", "outcome"]).toContain(f);
    }
    expect(ACTIONS).toContain("auth.getUser()");
  });
});
