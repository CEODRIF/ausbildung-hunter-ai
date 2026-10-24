/**
 * PostgreSQL-backed verification of the billing RLS invariants (OPTIONAL).
 *
 * When a local PostgreSQL server is reachable (psql on PATH, a cluster on
 * 127.0.0.1 or the local socket as user `postgres`), this suite:
 *
 *   1. creates a DISPOSABLE database (`billing_rls_audit_<pid>`);
 *   2. applies minimal Supabase-platform stubs (roles, auth.users,
 *      storage, publication — exactly what the repo migrations reference);
 *   3. applies the ENTIRE migration chain in filename order (continuing on
 *      individual statement errors — the only tolerated failure is the
 *      documented canonical `20261121` function-body defect, which has its
 *      own fix branch + production repair);
 *   4. re-verifies the invariants the text-based suite pins, at the
 *      DATABASE level: net pg_policies, pg_class.relrowsecurity, and
 *      has_function_privilege for the mock checkout RPCs, plus a LIVE
 *      cross-user isolation probe under SET ROLE (authenticated sees
 *      only its own rows; service_role bypasses, matching Supabase);
 *   5. drops the disposable database.
 *
 * HONEST-SKIP CONTRACT: if PostgreSQL is not available, the suite is
 * reported as SKIPPED (never passed, never failed) — a green repo suite
 * therefore NEVER claims database-level verification that was not
 * performed. No production credentials are used: local server only,
 * disposable database, stub rows only.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const SELF_SCOPED_TABLES = [
  "billing_plans",
  "subscriptions",
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
];
const NO_POLICY_TABLES = [
  "admins",
  "admin_audit_log",
  "subscription_events",
  "mock_checkouts",
];
const ALL_BILLING_TABLES = [...SELF_SCOPED_TABLES, ...NO_POLICY_TABLES];

/** Minimal Supabase-platform stubs — only what the repo migrations
 *  reference (mirror of the workspace pgtest stubs). */
const STUBS = [
  "do $$ begin",
  "  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;",
  "  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;",
  "  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;",
  // Roles are cluster-scoped (they survive the disposable database), so
  // BYPASSRLS — which Supabase grants service_role — must be enforced
  // idempotently, not only at role creation.
  "  alter role service_role bypassrls;",
  "end $$;",
  "create schema if not exists auth;",
  "create table if not exists auth.users (id uuid primary key, email text unique, email_confirmed_at timestamptz, raw_user_meta_data jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());",
  "create schema if not exists storage;",
  "create table if not exists storage.buckets (id text primary key, name text not null, owner uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), file_size_limit bigint, allowed_mime_types text[], public boolean not null default false);",
  "create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), metadata jsonb);",
  "create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;",
  "create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;",
  "create or replace function auth.role() returns text language sql stable as $$ select 'authenticated'::text $$;",
  "do $$ begin if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then create publication supabase_realtime; end if; end $$;",
].join("\n");

function psql(args: string[]): string {
  return execFileSync("psql", args, {
    encoding: "utf8",
    timeout: 180_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function psqlSoft(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: psql(args) };
  } catch (err) {
    return { ok: false, out: String(err) };
  }
}

const withServer = (db?: string) => {
  const a = ["-X", "-q", "-t", "-A"];
  if (db) a.push("-d", db);
  a.push("-h", "127.0.0.1", "-U", "postgres");
  return a;
};

/** Probe: psql present AND a local cluster reachable (tcp, then socket). */
function probe(): boolean {
  try {
    execFileSync("psql", ["--version"], { timeout: 5_000, stdio: "ignore" });
  } catch {
    return false;
  }
  const candidates = [withServer(), ["-X", "-q", "-t", "-A", "-U", "postgres"]];
  return candidates.some(
    (args) => psqlSoft([...args, "-c", "select 1"]).out.trim() === "1",
  );
}

const ready = probe();
const describeMaybe = ready ? describe : describe.skip;

describeMaybe(
  ready
    ? "billing RLS — PostgreSQL-backed (disposable local DB)"
    : "billing RLS — PostgreSQL-backed (SKIPPED: no local PostgreSQL reachable; database-level verification NOT performed in this environment)",
  () => {
    const db = `billing_rls_audit_${process.pid}`;
    const q = (sql: string) => psql([...withServer(db), "-c", sql]);
    let failedFiles: string[] = [];

    beforeAll(() => {
      const created = psqlSoft([
        ...withServer(),
        "-c",
        `create database ${db}`,
      ]);
      if (!created.ok)
        throw new Error(
          `disposable db creation failed: ${created.out.slice(0, 300)}`,
        );
      psql([...withServer(db), "-c", STUBS]);
      const files = readdirSync(resolve(root, "supabase/migrations"))
        .filter((f) => f.endsWith(".sql"))
        .sort();
      failedFiles = [];
      for (const f of files) {
        const r = psqlSoft([
          ...withServer(db),
          "-v",
          "ON_ERROR_STOP=0",
          "-f",
          resolve(root, "supabase/migrations", f),
        ]);
        // psqlSoft catches hard failures (psql missing); with
        // ON_ERROR_STOP=0 statement errors stay in the output.
        if (!r.ok || /ERROR/.test(r.out)) failedFiles.push(f);
      }
    }, 600_000);

    afterAll(() => {
      psqlSoft([...withServer(), "-c", `drop database if exists ${db}`]);
    });

    it("applied the full chain with at most the documented 20261121 function-body failure", () => {
      // The canonical 20261121 has a known CREATE FUNCTION defect (fixed on
      // fix/20261121-complete-feature-op-begin; production repair on
      // fix/20261124-production-repair). Its policy DDL still applies.
      const unexpected = failedFiles.filter((f) => !f.startsWith("20261121"));
      expect(
        unexpected,
        `unexpected migration failures: ${JSON.stringify(unexpected)}`,
      ).toEqual([]);
    });

    it("every billing table exists with RLS enabled (database level)", () => {
      const list = ALL_BILLING_TABLES.map((t) => `'${t}'`).join(", ");
      const out = q(
        `select c.relname || '|' || c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in (${list}) order by 1;`,
      );
      const rows = out.split("\n").filter(Boolean);
      expect(rows).toHaveLength(ALL_BILLING_TABLES.length);
      for (const row of rows) {
        // psql -A (unaligned) renders booleans as true/false, not t/f.
        const [name, flag] = row.split("|");
        expect(flag, `RLS not enabled on ${name ?? row}`).toBe("true");
      }
    });

    it("net pg_policies: exactly one SELECT policy per self-scoped billing table", () => {
      const list = SELF_SCOPED_TABLES.map((t) => `'${t}'`).join(", ");
      const out = q(
        `select tablename || '|' || cmd || '|' || coalesce(qual, '') from pg_policies where schemaname = 'public' and tablename in (${list}) order by tablename, cmd;`,
      );
      const rows = out.split("\n").filter(Boolean);
      expect(rows).toHaveLength(SELF_SCOPED_TABLES.length);
      for (const row of rows) {
        const [table, cmd, qual] = row.split("|");
        expect(cmd, row).toBe("SELECT");
        if (table === "billing_plans") {
          expect(qual.trim(), row).toBe("true");
        } else {
          expect(qual, row).toContain("user_id");
          expect(qual, row).toContain("auth.uid()");
        }
      }
    });

    it("zero RLS policies on audit/event/mock tables (service-role only)", () => {
      const list = NO_POLICY_TABLES.map((t) => `'${t}'`).join(", ");
      const out = q(
        `select count(*) from pg_policies where schemaname = 'public' and tablename in (${list});`,
      );
      expect(out.trim()).toBe("0");
    });

    it("mock checkout RPCs executable by service_role only (3-arg privilege form)", () => {
      const out = q(
        `select p.proname || '|' || has_function_privilege('anon', p.oid, 'execute')::int || '|' || has_function_privilege('authenticated', p.oid, 'execute')::int || '|' || has_function_privilege('service_role', p.oid, 'execute')::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('create_mock_checkout', 'complete_mock_checkout') order by 1;`,
      );
      const rows = out.split("\n").filter(Boolean);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.endsWith("|0|0|1"), row).toBe(true);
      }
    });

    it("LIVE cross-user isolation: authenticated sees only own rows; service_role bypasses", () => {
      const UA = "11111111-1111-4111-8111-111111111111";
      const UB = "22222222-2222-4222-8222-222222222222";
      // Rebind auth.uid() to a session GUC — the same per-session claim
      // mechanism Supabase uses for the JWT sub — so a disposable DB can
      // simulate an authenticated user without any Supabase runtime.
      q(`create or replace function auth.uid() returns uuid
         language sql stable as $$
           select nullif(current_setting('app.pgrls.test_uid', true), '')::uuid
         $$;`);
      // Fixture seeding only: the repo's invitation-only registration
      // trigger (handle_new_user) is irrelevant to RLS and is toggled
      // atomically within one transaction for the duration of the insert.
      q(
        `alter table auth.users disable trigger on_auth_user_created;
         insert into auth.users (id, email) values ('${UA}', 'rls-a@test.invalid'), ('${UB}', 'rls-b@test.invalid');
         alter table auth.users enable trigger on_auth_user_created;`,
      );
      q(
        `insert into public.daily_usage (user_id, date, emails_sent, ai_requests)
         values ('${UA}', date '2026-10-24', 1, 0), ('${UB}', date '2026-10-24', 5, 2);`,
      );
      // One session, one implicit transaction: act AS user A.
      // Expect "1|0|1": total visible = 1 (B's row is RLS-hidden even
      // though it exists), explicit ask for B's rows = 0, explicit ask
      // for A's rows = 1.
      const asA = q(
        `set local "app.pgrls.test_uid" = '${UA}';
         set role authenticated;
         select (select count(*) from public.daily_usage) || '|' ||
                (select count(*) from public.daily_usage where user_id = '${UB}') || '|' ||
                (select count(*) from public.daily_usage where user_id = '${UA}');`,
      );
      expect(asA.trim(), asA).toBe("1|0|1");
      // service_role (BYPASSRLS in Supabase, mirrored in the stub) sees
      // every row once it has table access — the service-side boundary
      // works in the opposite direction of the client-side self-scoping.
      // (Repo migrations grant service_role per-table; this fixture grant
      // establishes access so the assertion isolates the BYPASSRLS
      // property itself, not grant management.)
      q(`grant select on public.daily_usage to service_role;`);
      const asSvc = q(
        `set role service_role;
         select count(*) from public.daily_usage;`,
      );
      expect(asSvc.trim(), asSvc).toBe("2");
    });
  },
);

describe("billing RLS — PG suite availability (always runs, reports honestly)", () => {
  it("exposes the probe result so reviewers can see whether DB-level verification ran", () => {
    expect(typeof ready).toBe("boolean");
  });
});
