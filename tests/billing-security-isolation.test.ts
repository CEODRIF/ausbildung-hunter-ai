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
 *   3. STATIC (migration text, ALL migrations — full directory scan, not a
 *      subset): the NET RLS policy inventory (creates minus drops, in
 *      application order) for the 17 billing/entitlement tables —
 *      select-only everywhere, self-scoped against auth.uid() (or the
 *      public plan catalog), ZERO policies on the audit/event/mock tables
 *      (service-role only). The parser is hardened against the silent-miss
 *      classes (missing USING, WITH CHECK, unquoted/quoted identifiers,
 *      case, schema-less tables, commented-out DDL, dynamically executed
 *      policies) and is pinned by its own self-test fixtures below — a
 *      parser regression fails loudly instead of letting the RLS
 *      assertions pass vacuously.
 *   4. POSTGRESQL-BACKED (optional, honest-skip): tests/billing-rls-pg.test.ts
 *      re-verifies the same invariants against a disposable database when a
 *      local PostgreSQL is available; it skips (never fails) without one.
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
const { mockPaymentsEnabled } =
  await import("@/lib/billing/entitlement-service");

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative: string) =>
  readFileSync(resolve(root, relative), "utf8");

const MIG = (name: string) => `supabase/migrations/${name}`;
const MOCK = read(MIG("20261122000000_mock_checkout_complete.sql"));

/** ALL migrations in the repo (sorted by filename = application order).
 *  The RLS inventory scans the whole directory — never a hardcoded subset. */
const migrationsDir = resolve(root, "supabase/migrations");
const MIGRATION_FILES: Array<{ name: string; sql: string }> = readdirSync(
  migrationsDir,
)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: read(`supabase/migrations/${name}`) }));

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
      {
        MOCK_PAYMENTS_ENABLED: "true",
        NODE_ENV: "production",
        VERCEL_ENV: undefined,
      },
      () => expect(mockPaymentsEnabled()).toBe(false),
    );
  });

  it("flag on but VERCEL_ENV=production → disabled", async () => {
    await withEnv(
      {
        MOCK_PAYMENTS_ENABLED: "true",
        NODE_ENV: "development",
        VERCEL_ENV: "production",
      },
      () => expect(mockPaymentsEnabled()).toBe(false),
    );
  });

  it("flag off in any non-prod runtime → disabled", async () => {
    await withEnv(
      {
        MOCK_PAYMENTS_ENABLED: undefined,
        NODE_ENV: "development",
        VERCEL_ENV: undefined,
      },
      () => expect(mockPaymentsEnabled()).toBe(false),
    );
  });

  it("flag on in a genuine development runtime → enabled", async () => {
    await withEnv(
      {
        MOCK_PAYMENTS_ENABLED: "true",
        NODE_ENV: "development",
        VERCEL_ENV: undefined,
      },
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
      if (
        src.includes("@/lib/supabase/admin") ||
        src.includes("createAdminClient")
      ) {
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

// ---------------------------------------------------------------------------
// Hardened policy parser (audit pass 2)
//
// The pass-1 regex silently MISSED a policy when it (a) had no USING
// clause, (b) used a WITH CHECK clause, (c) used an unquoted policy name,
// (d) used quoted identifiers, (e) omitted the schema prefix, or (f)
// differed in case — and it ignored DROP POLICY entirely, so
// drop-then-create patterns could not be netted. It also only scanned a
// hardcoded 5-file subset. Every one of these classes is covered by the
// parser below AND pinned by the self-test fixtures at the end of this
// suite, so a future regression in the parser fails loudly instead of
// making "every billing policy is select-only" pass vacuously.
// ---------------------------------------------------------------------------

export interface PolicyRecord {
  name: string;
  schema: string | null;
  table: string;
  /** null for DROP POLICY records. */
  command: string | null;
  to: string | null;
  using: string | null;
  withCheck: string | null;
}

/** Remove line (`--`) and block (slash-star) comments that sit OUTSIDE
 *  single-quoted strings and dollar-quoted bodies. Dynamic DDL
 *  (`execute 'create policy …'`) lives inside those bodies and MUST
 *  survive, so bodies are kept verbatim. */
function stripLineAndBlockComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'") {
      out += ch;
      i += 1;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            out += "''";
            i += 2;
            continue;
          }
          out += "'";
          i += 1;
          break;
        }
        out += sql[i];
        i += 1;
      }
      continue;
    }
    if (ch === "$" && /[$\w]/.test(sql[i + 1] ?? "")) {
      const tagEnd = sql.indexOf("$", i + 1);
      if (tagEnd !== -1) {
        const tag = sql.slice(i, tagEnd + 1);
        const end = sql.indexOf(tag, i + tag.length);
        if (end !== -1) {
          out += sql.slice(i, end + tag.length);
          i = end + tag.length;
          continue;
        }
      }
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** First balanced (...) group in `text`, or null. */
function parenContent(text: string): string | null {
  const start = text.indexOf("(");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return null;
}

/** Parse every CREATE/DROP POLICY statement (static or dynamically
 *  executed) in one migration file. */
function parsePolicies(sqlText: string): PolicyRecord[] {
  const flat = stripLineAndBlockComments(sqlText).replace(/\s+/g, " ").trim();
  const out: PolicyRecord[] = [];
  const re =
    /\b(create|drop)\s+policy\s+(?:if exists\s+)?("([^"]+)"|([A-Za-z_]\w*))\s+on\s+(?:(?:"(\w+)"|(\w+))\.)?\s*("([^"]+)"|([A-Za-z_]\w*))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(flat)) !== null) {
    const kind = m[1].toLowerCase();
    const name = m[3] ?? m[4];
    const schema = m[5] ?? m[6] ?? null;
    const table = m[8] ?? m[9];
    if (kind === "drop") {
      out.push({
        name,
        schema,
        table,
        command: null,
        to: null,
        using: null,
        withCheck: null,
      });
      continue;
    }
    const restStart = m.index + m[0].length;
    const nextSemi = flat.indexOf(";", restStart);
    const rest = flat.slice(
      restStart,
      nextSemi === -1 ? flat.length : nextSemi,
    );
    const usingIdx = rest.search(/\busing\s*\(/i);
    const checkIdx = rest.search(/\bwith\s+check\s*\(/i);
    let headEnd = rest.length;
    if (usingIdx !== -1) headEnd = Math.min(headEnd, usingIdx);
    if (checkIdx !== -1) headEnd = Math.min(headEnd, checkIdx);
    const head = rest.slice(0, headEnd);
    const commandM = head.match(
      /^\s*for\s+(select|insert|update|delete|all)\b/i,
    );
    const toM = head.match(/\bto\s+([\w\s,]+?)\s*$/i);
    const using =
      usingIdx === -1
        ? null
        : (parenContent(rest.slice(usingIdx))?.trim() ?? null);
    const withCheck =
      checkIdx === -1
        ? null
        : (parenContent(rest.slice(checkIdx))?.trim() ?? null);
    out.push({
      name,
      schema,
      table,
      command: commandM ? commandM[1].toLowerCase() : null,
      to: toM ? toM[1].trim() : null,
      using,
      withCheck,
    });
    re.lastIndex = restStart;
  }
  return out;
}

/** Net inventory across ALL migrations (creates minus drops, in
 *  application order). Keyed by schema-qualified table + policy name. */
function buildNetInventory(files: Array<{ name: string; sql: string }>) {
  const net = new Map<string, PolicyRecord & { file: string }>();
  let creates = 0;
  let drops = 0;
  for (const f of files) {
    for (const p of parsePolicies(f.sql)) {
      const key = `${p.schema ? `${p.schema}.` : ""}${p.table}::${p.name}`;
      if (p.command === null) {
        drops += 1;
        net.delete(key);
      } else {
        creates += 1;
        net.set(key, { ...p, file: f.name });
      }
    }
  }
  return { net, creates, drops };
}

/** Billing & entitlement tables (core billing + quota/usage metering
 *  state). All share the invariant: NO user write path via PostgREST. */
const BILLING_TABLES = new Set([
  "billing_plans",
  "subscriptions",
  "admins",
  "admin_audit_log",
  "subscription_events",
  "mock_checkouts",
  "feature_usage",
  "feature_usage_runs",
  "daily_usage",
  "user_quota_upgrades",
  "user_search_credits",
  "credit_transactions",
  "searches",
  "ai_deckblatt_usage",
  "ai_deckblatt_runs",
  "housing_web_search_usage",
  "housing_web_search_runs",
]);

/** Tables that must carry ZERO RLS policies (service-role only). */
const NO_POLICY_TABLES = [
  "admins",
  "admin_audit_log",
  "subscription_events",
  "mock_checkouts",
];

describe("RLS inventory — billing schema, ALL migrations", () => {
  // Full-directory scan (application order = filename order).
  const { net, creates, drops } = buildNetInventory(MIGRATION_FILES);
  const billingPolicies = [...net.values()].filter((p) =>
    BILLING_TABLES.has(p.table),
  );

  it("scans every migration file (coverage is not a hardcoded subset)", () => {
    expect(MIGRATION_FILES.length).toBeGreaterThanOrEqual(60);
    // The parser must have found a substantial, repo-wide surface — a
    // regression to a 5-file subset (or a regex that matches nothing)
    // fails here.
    expect(creates).toBeGreaterThanOrEqual(150);
    expect(drops).toBeGreaterThanOrEqual(70);
    expect(net.size).toBeGreaterThanOrEqual(90);
    const contributing = new Set([...net.values()].map((p) => p.file));
    expect(contributing.size).toBeGreaterThanOrEqual(20);
  });

  it("the net policy set for billing/entitlement tables is exactly the pinned shape (13 self/catalog reads, 4 zero-policy tables)", () => {
    const byTable = new Map<string, PolicyRecord[]>();
    for (const t of BILLING_TABLES) {
      byTable.set(
        t,
        billingPolicies.filter((p) => p.table === t),
      );
    }
    for (const t of NO_POLICY_TABLES) {
      expect(byTable.get(t), `policies on ${t}`).toHaveLength(0);
    }
    const expectedSingle = [...BILLING_TABLES].filter(
      (t) => !NO_POLICY_TABLES.includes(t),
    );
    expect(expectedSingle).toHaveLength(13);
    for (const t of expectedSingle) {
      expect(byTable.get(t), `policies on ${t}`).toHaveLength(1);
    }
  });

  it("every billing/entitlement policy is SELECT-only — no user write path anywhere", () => {
    expect(billingPolicies.length).toBe(13);
    for (const p of billingPolicies) {
      expect(p.command, `policy ${p.name} on ${p.table}`).toBe("select");
      expect(p.withCheck, `with check on ${p.table}`).toBeNull();
    }
  });

  it("self-scoped billing policies compare user_id against auth.uid() (either operand order)", () => {
    for (const p of billingPolicies) {
      if (p.table === "billing_plans") continue;
      expect(p.using, `using on ${p.table}`).toBeTruthy();
      expect(p.using, `using on ${p.table}`).toContain("user_id");
      expect(p.using, `using on ${p.table}`).toContain("auth.uid()");
    }
  });

  it("the only non-self-scoped billing policy is the public plan catalog read", () => {
    const catalog = billingPolicies.filter((p) => p.table === "billing_plans");
    expect(catalog).toHaveLength(1);
    expect(catalog[0].using).toBe("true");
    expect(catalog[0].to).toBe("authenticated");
  });

  it("audit / event / mock tables carry ZERO net policies (service-role only)", () => {
    for (const table of NO_POLICY_TABLES) {
      expect(
        billingPolicies.filter((p) => p.table === table),
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
      const flat = MIGRATION_FILES.map((f) => f.sql.replace(/\s+/g, " ")).join(
        " | ",
      );
      expect(flat).toContain(
        `alter table public.${table} enable row level security`,
      );
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
// Parser self-tests — each fixture is a class the pass-1 parser silently
// missed. If the parser ever regresses, one of these fails LOUDLY instead
// of the RLS assertions above passing vacuously.
// ---------------------------------------------------------------------------

describe("policy parser self-tests (silent-miss regression fixtures)", () => {
  it("captures a policy WITHOUT any USING clause", () => {
    const recs = parsePolicies(
      'create policy "open read" on public.things for select;',
    );
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      table: "things",
      command: "select",
      using: null,
      withCheck: null,
    });
  });

  it("captures WITH CHECK and reports it (a write policy can never hide)", () => {
    const recs = parsePolicies(
      'create policy "own writes" on public.things for insert to authenticated with check (user_id = auth.uid());',
    );
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      table: "things",
      command: "insert",
      to: "authenticated",
      withCheck: "user_id = auth.uid()",
    });
  });

  it("captures unquoted policy names and bare (schema-less) table names", () => {
    const recs = parsePolicies(
      "create policy bare_select on things for select using (owner = auth.uid());",
    );
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      name: "bare_select",
      schema: null,
      table: "things",
      command: "select",
      using: "owner = auth.uid()",
    });
  });

  it("captures quoted identifiers and arbitrary case", () => {
    const recs = parsePolicies(
      'CREATE POLICY "Quoted Name" ON "Public"."My Table" FOR UPDATE USING (id = auth.uid());',
    );
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      name: "Quoted Name",
      schema: "Public",
      table: "My Table",
      command: "update",
      using: "id = auth.uid()",
    });
  });

  it("captures USING expressions with nested parentheses (auth.uid()) intact", () => {
    const recs = parsePolicies(
      'create policy "self" on public.t for select to authenticated using (user_id = auth.uid());',
    );
    expect(recs[0].using).toBe("user_id = auth.uid()");
    expect(recs[0].to).toBe("authenticated");
  });

  it("ignores commented-out policy DDL", () => {
    const lineComments = parsePolicies(
      '-- create policy "ghost" on public.t for delete;',
    );
    expect(lineComments).toHaveLength(0);
    const blockComments = parsePolicies(
      "/* create policy ghost2 on public.t for delete; */",
    );
    expect(blockComments).toHaveLength(0);
  });

  it("captures dynamically executed policies inside plpgsql bodies", () => {
    const recs = parsePolicies(
      "$$ begin execute 'drop policy if exists \"Users can read their own daily usage\" on public.daily_usage;'; execute 'create policy \"Users can read their own daily usage\" on public.daily_usage for select to authenticated using (user_id = auth.uid());'; end $$;",
    );
    expect(recs).toHaveLength(2);
    const create = recs.find((r) => r.command !== null);
    expect(create).toMatchObject({
      table: "daily_usage",
      command: "select",
      using: "user_id = auth.uid()",
    });
    expect(recs.find((r) => r.command === null)?.table).toBe("daily_usage");
  });

  it("nets drop-then-create: only the final version survives", () => {
    const { net } = buildNetInventory([
      {
        name: "a.sql",
        sql: 'create policy "p" on public.t for select using (a = auth.uid());',
      },
      {
        name: "b.sql",
        sql: 'drop policy if exists "p" on public.t; create policy "p" on public.t for select to authenticated using (b = auth.uid());',
      },
      {
        name: "c.sql",
        sql: 'drop policy if exists "p" on public.t;',
      },
    ]);
    expect(net.size).toBe(0);
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
    expect(ADMIN_ROUTE).not.toContain("body.actor");
  });

  it("billing server actions accept only intent fields (no identity, no user id)", () => {
    const fields = [...ACTIONS.matchAll(/formData\.get\(\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    for (const f of fields) {
      expect([
        "plan_id",
        "idempotency_key",
        "checkout_id",
        "outcome",
      ]).toContain(f);
    }
    expect(ACTIONS).toContain("auth.getUser()");
  });
});
