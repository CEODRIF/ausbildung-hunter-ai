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
import { execFile, execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { promisify } from "node:util";
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
      // Production fidelity: Supabase database sessions run in UTC. The
      // codebase's `timezone('utc', now())` idiom (all created_at defaults,
      // activate_trial, manage_subscription) computes correct absolute
      // instants ONLY in a UTC session; pin the disposable DB to UTC so
      // every timestamp assertion is deterministic and production-like.
      psql([
        ...withServer(db),
        "-c",
        `alter database ${db} set timezone = 'utc';`,
      ]);
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

    // ======================================================================
    // Open registration (migration 20261201000000) — verified on REAL
    // PostgreSQL with the FULL migration chain applied, so this runs the
    // EFFECTIVE (last-defined) handle_new_user:
    //   * code-less sign-up succeeds and consumes NOTHING;
    //   * a valid provided code is consumed atomically (+ consumed marker);
    //   * an unknown code and an exhausted code never block the sign-up
    //     and never consume.
    // ======================================================================
    describe("open registration — handle_new_user trigger (real PG)", () => {
      // Fixture identities — never reused elsewhere in this file.
      const OPEN_0 = "eeee0000-1111-4222-8333-444455556666"; // no metadata at all
      const OPEN_1 = "eeee1111-2222-4333-8444-555566667777"; // no code
      const OPEN_2 = "eeee2222-3333-4444-8555-666677778888"; // valid code
      const OPEN_3 = "eeee3333-4444-4555-8666-777788889999"; // unknown code
      const OPEN_4 = "eeee4444-5555-4666-8777-88889999aaaa"; // exhausted code
      const profileCount = (uid: string) =>
        q(`select count(*) from public.profiles where id = '${uid}'`).trim();
      const openUsedCount = () =>
        q(
          `select used_count from public.invitation_codes where code = 'OPENTEST'`,
        ).trim();
      const marker = (uid: string) =>
        q(
          `select coalesce(raw_user_meta_data->>'invitation_code_consumed', '') from auth.users where id = '${uid}'`,
        ).trim();

      it("fixture: the effective trigger is the OPEN one (no invitation_code_required)", () => {
        const prosrc = q(
          `select prosrc from pg_proc where proname = 'handle_new_user' and pronamespace = 'public'::regnamespace`,
        );
        expect(prosrc).toContain("consume_invitation_code");
        expect(prosrc).not.toContain("invitation_code_required");
        expect(prosrc).not.toContain("invitation_code_invalid_or_exhausted");
        // Single-use registration code for the fixture (max_uses 1, no
        // daily_email_limit — registration codes grant no quota anyway).
        q(
          `insert into public.invitation_codes (code, type, is_active, max_uses, daily_email_limit)
           values ('OPENTEST', 'registration', true, 1, 0)
           on conflict (code) do nothing;`,
        );
        expect(openUsedCount()).toBe("0");
      });

      it("code-less sign-up (no metadata at all) succeeds, consumes nothing, derives the name from the email", () => {
        q(
          `alter table auth.users enable trigger on_auth_user_created;
           insert into auth.users (id, email) values ('${OPEN_0}', 'openzero@test.invalid');
           alter table auth.users disable trigger on_auth_user_created;`,
        );
        expect(profileCount(OPEN_0)).toBe("1");
        expect(openUsedCount()).toBe("0");
        expect(marker(OPEN_0)).toBe("");
        expect(
          q(
            `select full_name from public.profiles where id = '${OPEN_0}'`,
          ).trim(),
        ).toBe("openzero");
      });

      it("code-less sign-up (metadata without a code) succeeds, consumes nothing", () => {
        q(
          `alter table auth.users enable trigger on_auth_user_created;
           insert into auth.users (id, email, raw_user_meta_data) values ('${OPEN_1}', 'openone@test.invalid', '{"full_name":"Open One"}'::jsonb);
           alter table auth.users disable trigger on_auth_user_created;`,
        );
        expect(profileCount(OPEN_1)).toBe("1");
        expect(openUsedCount()).toBe("0");
        expect(marker(OPEN_1)).toBe("");
      });

      it("a valid provided code is consumed atomically (+ consumed marker)", () => {
        q(
          `alter table auth.users enable trigger on_auth_user_created;
           insert into auth.users (id, email, raw_user_meta_data) values ('${OPEN_2}', 'opentwo@test.invalid', '{"full_name":"Open Two","invitation_code":"OPENTEST"}'::jsonb);
           alter table auth.users disable trigger on_auth_user_created;`,
        );
        expect(profileCount(OPEN_2)).toBe("1");
        expect(openUsedCount()).toBe("1");
        expect(marker(OPEN_2)).toBe("true");
      });

      it("an UNKNOWN code never blocks the sign-up and consumes nothing", () => {
        q(
          `alter table auth.users enable trigger on_auth_user_created;
           insert into auth.users (id, email, raw_user_meta_data) values ('${OPEN_3}', 'openthree@test.invalid', '{"full_name":"Open Three","invitation_code":"NOPE123"}'::jsonb);
           alter table auth.users disable trigger on_auth_user_created;`,
        );
        expect(profileCount(OPEN_3)).toBe("1");
        expect(openUsedCount()).toBe("1");
        expect(marker(OPEN_3)).toBe("");
      });

      it("an EXHAUSTED code never blocks the sign-up and is never double-consumed", () => {
        q(
          `alter table auth.users enable trigger on_auth_user_created;
           insert into auth.users (id, email, raw_user_meta_data) values ('${OPEN_4}', 'openfour@test.invalid', '{"full_name":"Open Four","invitation_code":"OPENTEST"}'::jsonb);
           alter table auth.users disable trigger on_auth_user_created;`,
        );
        expect(profileCount(OPEN_4)).toBe("1");
        // One use per max_uses — the loser of the race still gets an
        // account, but the code's single use was already granted above.
        expect(openUsedCount()).toBe("1");
        expect(marker(OPEN_4)).toBe("");
      });

      it("the pending profile activates via the confirmation trigger (email verification unchanged)", () => {
        expect(
          q(
            `select account_status from public.profiles where id = '${OPEN_0}'`,
          ).trim(),
        ).toBe("pending");
        // PRODUCTION FIDELITY: in Supabase the confirmation click runs
        // GoTrue's UPDATE as the `service_role` claim, and
        // protect_profile_system_fields() only reverts system fields for
        // the `authenticated` role. The suite's stub hardcodes
        // auth.role() = 'authenticated', so rebind it to the same
        // per-session claim mechanism (GUC) the suite already uses for
        // auth.uid(), run the confirmation under 'service_role', then
        // restore the stub verbatim.
        q(
          `create or replace function auth.role() returns text language sql stable as $$
             select coalesce(nullif(current_setting('app.pgrls.test_role', true), ''), 'authenticated')
           $$;`,
        );
        q(
          `select set_config('app.pgrls.test_role', 'service_role', false);
           update auth.users set email_confirmed_at = timezone('utc', now()) where id = '${OPEN_0}';`,
        );
        q(`select set_config('app.pgrls.test_role', '', false);`);
        q(
          `create or replace function auth.role() returns text language sql stable as $$ select 'authenticated'::text $$;`,
        );
        expect(
          q(
            `select account_status from public.profiles where id = '${OPEN_0}'`,
          ).trim(),
        ).toBe("active");
      });
    });

    // ======================================================================
    // manage_subscription — the atomic, audited admin plan RPC, verified on
    // REAL PostgreSQL (disposable DB, full migration chain already applied).
    // These are the database-level proofs for spec §4 (admin) and §2 (trial):
    // one canonical row per user, all-or-nothing writes, audit per change,
    // serialization of concurrent actions, service-role-only execution,
    // and every documented validation rejection.
    // ======================================================================
    describe("manage_subscription — atomic admin plan RPC (real PG)", () => {
      const execFileP = promisify(execFile);
      const q = (sql: string) => psql([...withServer(db), "-c", sql]);
      const qSoft = (sql: string) => psqlSoft([...withServer(db), "-c", sql]);
      const one = (sql: string) => q(sql).trim();
      const psqlPar = (sql: string) =>
        execFileP("psql", [...withServer(db), "-c", sql], {
          timeout: 60_000,
          encoding: "utf8",
        }).then(({ stdout }) => stdout.trim());

      // Fixture identities — never reused anywhere else in this file.
      const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // the admin
      const TGT1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const TGT2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const TGT3 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

      const subCount = (uid: string) =>
        one(
          `select count(*) from public.subscriptions where user_id = '${uid}'`,
        );
      const subField = (uid: string, col: string) =>
        one(
          `select ${col} from public.subscriptions where user_id = '${uid}' limit 1`,
        );
      // Exact span in EPOCH SECONDS (PostgreSQL's text rendering of an
      // interval is unit-dependent: 72 h renders as '3 days' — never assert
      // on the rendering).
      const subSpanSec = (uid: string) =>
        one(
          `select extract(epoch from current_period_end - current_period_start)::bigint from public.subscriptions where user_id = '${uid}' limit 1`,
        );
      const auditCount = (uid: string) =>
        one(
          `select count(*) from public.admin_audit_log where target_user_id = '${uid}'`,
        );
      const eventsCount = (uid: string) =>
        one(
          `select count(*) from public.subscription_events where user_id = '${uid}'`,
        );

      it("P0 pin: subscriptions(user_id) carries the UNIQUE constraint that ON CONFLICT (user_id) targets", () => {
        // An inline column-level `unique` produces a unique CONSTRAINT
        // (contype 'u') — exactly what the RPC's upsert conflict target
        // requires. Without it the RPC would fail at runtime.
        const n = one(
          `select count(*) from pg_constraint c
            join pg_class r on r.oid = c.conrelid
            join pg_namespace ns on ns.oid = r.relnamespace
           where r.relname = 'subscriptions' and ns.nspname = 'public' and c.contype = 'u'
             and c.conkey = array[(
                   select a.attnum from pg_attribute a
                    where a.attrelid = 'public.subscriptions'::regclass
                      and a.attname = 'user_id')]`,
        );
        expect(n, "unique constraint on subscriptions.user_id").toBe("1");
        // And the period oracle produces EXACT spans (epoch seconds, exact):
        expect(
          one(
            `select extract(epoch from public.subscription_period_end(now(), 'fixed_hours', 72) - now())::bigint`,
          ),
        ).toBe("259200"); // 72 h, exactly
        expect(
          one(
            `select extract(epoch from public.subscription_period_end(now(), 'fixed_days', 30) - now())::bigint`,
          ),
        ).toBe("2592000"); // 30 d, exactly
      });

      it("fixture: seed auth.users (FK targets for subscriptions / subscription_events)", () => {
        q(
          `alter table auth.users disable trigger on_auth_user_created;
           insert into auth.users (id, email) values
             ('${ACTOR}', 'pg-admin@test.invalid'),
             ('${TGT1}', 'pg-t1@test.invalid'),
             ('${TGT2}', 'pg-t2@test.invalid'),
             ('${TGT3}', 'pg-t3@test.invalid');
           alter table auth.users enable trigger on_auth_user_created;`,
        );
        expect(
          one(
            `select count(*) from auth.users where id in ('${ACTOR}','${TGT1}','${TGT2}','${TGT3}')`,
          ),
        ).toBe("4");
      });

      it("set_plan on a fresh user → ok, provider=manual (an admin grant, NOT a payment), exact 10-day span (plus = premium_10d tier), created_by=actor, ONE audit row with before/after, ONE billing event", () => {
        const out = JSON.parse(
          q(
            `select public.manage_subscription('${ACTOR}','${TGT1}','set_plan','plus',10,'pg_test')`,
          ),
        ) as Record<string, unknown>;
        expect(out.status).toBe("ok");
        expect(out.before, "no prior state for a fresh user").toEqual({});
        expect(out.after).toMatchObject({
          plan: "plus",
          status: "active",
          provider: "manual",
        });

        expect(subCount(TGT1)).toBe("1");
        expect(subField(TGT1, "plan")).toBe("plus");
        expect(subField(TGT1, "status")).toBe("active");
        expect(subField(TGT1, "provider")).toBe("manual");
        expect(subField(TGT1, "created_by")).toBe(ACTOR);
        expect(subSpanSec(TGT1)).toBe("864000"); // 10 d, exactly (plus)
        // Start is "now" (server clock), not client-supplied:
        expect(
          one(
            `select (now() - current_period_start) < interval '5 minutes' from public.subscriptions where user_id = '${TGT1}'`,
          ),
        ).toBe("t");

        expect(auditCount(TGT1)).toBe("1");
        const audit = JSON.parse(
          one(
            `select jsonb_build_object('actor', actor_id, 'action', action, 'reason', details->>'reason', 'before', details->'before', 'after', details->'after') from public.admin_audit_log where target_user_id = '${TGT1}'`,
          ),
        ) as Record<string, unknown>;
        expect(audit.actor).toBe(ACTOR);
        expect(audit.action).toBe("set_plan");
        expect(audit.reason).toBe("pg_test");
        expect(audit.before).toEqual({});
        expect(audit.after).toMatchObject({
          plan: "plus",
          status: "active",
          provider: "manual",
        });

        expect(eventsCount(TGT1)).toBe("1");
        expect(
          one(
            `select action || '|' || provider from public.subscription_events where user_id = '${TGT1}'`,
          ),
        ).toBe("subscription_activated|manual");
      });

      it("set_plan again (different plan + duration) UPDATES the same single row (one canonical row; before/after captured)", () => {
        const out = JSON.parse(
          q(
            `select public.manage_subscription('${ACTOR}','${TGT1}','set_plan','pro',30,'pg_test')`,
          ),
        ) as Record<string, unknown>;
        expect(out.status).toBe("ok");
        expect(out.before).toMatchObject({ plan: "plus", status: "active" });
        expect(out.after).toMatchObject({ plan: "pro", status: "active" });

        expect(subCount(TGT1), "still exactly one row").toBe("1");
        expect(subField(TGT1, "plan")).toBe("pro");
        expect(subSpanSec(TGT1)).toBe("2592000"); // 30 d, exactly (pro)
        expect(auditCount(TGT1)).toBe("2");
        expect(eventsCount(TGT1)).toBe("2");
      });

      it("cancel → canceled + canceled_at set (row PRESERVED for history, period end kept for display) + event; reactivate → active again, canceled_at cleared", () => {
        const c = JSON.parse(
          q(
            `select public.manage_subscription('${ACTOR}','${TGT1}','cancel_subscription',null,null,'pg_test')`,
          ),
        ) as Record<string, unknown>;
        expect(c.status).toBe("ok");
        expect(c.after).toMatchObject({ status: "canceled" });
        expect(subField(TGT1, "status")).toBe("canceled");
        expect(
          one(
            `select canceled_at is not null from public.subscriptions where user_id = '${TGT1}'`,
          ),
        ).toBe("t");
        expect(subCount(TGT1), "cancel keeps the row").toBe("1");
        expect(
          one(
            `select action from public.subscription_events where user_id = '${TGT1}' order by created_at desc limit 1`,
          ),
        ).toBe("subscription_canceled");

        const r = JSON.parse(
          q(
            `select public.manage_subscription('${ACTOR}','${TGT1}','reactivate_subscription','plus',10,'pg_test')`,
          ),
        ) as Record<string, unknown>;
        expect(r.status).toBe("ok");
        expect(r.before).toMatchObject({ status: "canceled" });
        expect(subField(TGT1, "status")).toBe("active");
        expect(subField(TGT1, "plan")).toBe("plus");
        // Reactivation re-grants the canonical plus duration (10 d):
        expect(subSpanSec(TGT1)).toBe("864000");
        expect(
          one(
            `select canceled_at is null from public.subscriptions where user_id = '${TGT1}'`,
          ),
        ).toBe("t");
        expect(subCount(TGT1)).toBe("1");
      });

      it("every documented validation rejection short-circuits with ZERO writes (invalid_args / invalid_action / invalid_plan / invalid_period / no_subscription)", () => {
        const calls: Array<[string, string]> = [
          [
            "invalid_args",
            `select public.manage_subscription(null, '${TGT2}', 'set_plan', 'plus', 10, 'x')`,
          ],
          [
            "invalid_action",
            `select public.manage_subscription('${ACTOR}', '${TGT2}', 'frobnicate', 'plus', 10, 'x')`,
          ],
          [
            "invalid_plan(trial)",
            `select public.manage_subscription('${ACTOR}', '${TGT2}', 'set_plan', 'trial', 10, 'x')`,
          ],
          [
            "invalid_plan(free)",
            `select public.manage_subscription('${ACTOR}', '${TGT2}', 'set_plan', 'free', 10, 'x')`,
          ],
          [
            "invalid_plan(unknown)",
            `select public.manage_subscription('${ACTOR}', '${TGT2}', 'set_plan', 'enterprise', 10, 'x')`,
          ],
          [
            "invalid_period(31)",
            `select public.manage_subscription('${ACTOR}', '${TGT2}', 'set_plan', 'plus', 31, 'x')`,
          ],
          [
            "invalid_period(0)",
            `select public.manage_subscription('${ACTOR}', '${TGT2}', 'set_plan', 'plus', 0, 'x')`,
          ],
          [
            "invalid_period(plus+30)",
            `select public.manage_subscription('${ACTOR}', '${TGT2}', 'set_plan', 'plus', 30, 'x')`,
          ],
          [
            "invalid_period(pro+10)",
            `select public.manage_subscription('${ACTOR}', '${TGT2}', 'set_plan', 'pro', 10, 'x')`,
          ],
          [
            "invalid_period(plus+1-retired)",
            `select public.manage_subscription('${ACTOR}', '${TGT2}', 'set_plan', 'plus', 1, 'x')`,
          ],
          [
            "invalid_period(pro+365-retired)",
            `select public.manage_subscription('${ACTOR}', '${TGT2}', 'set_plan', 'pro', 365, 'x')`,
          ],
          [
            "invalid_period(null)",
            `select public.manage_subscription('${ACTOR}', '${TGT2}', 'set_plan', 'plus', null, 'x')`,
          ],
          [
            "no_subscription",
            `select public.manage_subscription('${ACTOR}', '${TGT2}', 'cancel_subscription', null, null, 'x')`,
          ],
        ];
        for (const [label, sql] of calls) {
          const out = JSON.parse(q(sql)) as Record<string, string>;
          expect(out.status, label).toBe(label.split("(")[0]);
        }
        // And NOTHING was written for TGT2:
        expect(subCount(TGT2)).toBe("0");
        expect(auditCount(TGT2)).toBe("0");
        expect(eventsCount(TGT2)).toBe("0");
      });

      it("atomicity: a forced audit-insert failure rolls back the subscription write too (db_error, no partial state)", () => {
        // Force the failure AFTER the subscription upsert but BEFORE the
        // function returns: the plpgsql exception handler must roll back
        // the function's whole subtransaction.
        q(
          `create or replace function pg_test_fail_audit() returns trigger
              language plpgsql as $$ begin raise exception 'forced pg test failure'; end $$;
           drop trigger if exists pg_test_fail on public.admin_audit_log;
           create trigger pg_test_fail before insert on public.admin_audit_log
             for each row execute function pg_test_fail_audit();`,
        );
        try {
          const out = JSON.parse(
            q(
              `select public.manage_subscription('${ACTOR}','${TGT2}','set_plan','plus',10,'pg_atomic')`,
            ),
          ) as Record<string, string>;
          expect(out.status).toBe("db_error");
          // All-or-nothing: the upsert that already happened is rolled back.
          expect(subCount(TGT2), "subscription write rolled back").toBe("0");
          expect(auditCount(TGT2)).toBe("0");
          expect(eventsCount(TGT2)).toBe("0");
        } finally {
          q(
            `drop trigger if exists pg_test_fail on public.admin_audit_log; drop function if exists pg_test_fail_audit();`,
          );
        }
      });

      it("concurrent set_plan from two parallel sessions → BOTH succeed, exactly ONE canonical row remains (FOR UPDATE serializes)", async () => {
        const [a, b] = await Promise.all([
          psqlPar(
            `select public.manage_subscription('${ACTOR}','${TGT2}','set_plan','plus',10,'pg_conc_a')`,
          ),
          psqlPar(
            `select public.manage_subscription('${ACTOR}','${TGT2}','set_plan','pro',30,'pg_conc_b')`,
          ),
        ]);
        expect(JSON.parse(a).status).toBe("ok");
        expect(JSON.parse(b).status).toBe("ok");
        expect(subCount(TGT2), "exactly one canonical row").toBe("1");
        expect(["plus", "pro"]).toContain(subField(TGT2, "plan"));
        expect(subField(TGT2, "status")).toBe("active");
        expect(auditCount(TGT2), "both actions audited").toBe("2");
        expect(eventsCount(TGT2)).toBe("2");
      });

      it("DB-level grant enforcement: authenticated and anon CANNOT execute the RPC (denied, zero writes); service_role CAN", () => {
        const asAuth = qSoft(
          `set role authenticated; select public.manage_subscription('${ACTOR}','${TGT2}','set_plan','plus',10,'pg_denied');`,
        );
        expect(asAuth.ok).toBe(false);
        expect(asAuth.out).toContain(
          "permission denied for function manage_subscription",
        );

        const asAnon = qSoft(
          `set role anon; select public.manage_subscription('${ACTOR}','${TGT2}','set_plan','plus',10,'pg_denied');`,
        );
        expect(asAnon.ok).toBe(false);
        expect(asAnon.out).toContain(
          "permission denied for function manage_subscription",
        );

        // The denied attempts wrote nothing:
        expect(subCount(TGT2)).toBe("1");
        expect(auditCount(TGT2)).toBe("2");

        // The service-role grant is what the app's admin client uses:
        const asSvc = JSON.parse(
          q(
            `set role service_role; select public.manage_subscription('${ACTOR}','${TGT2}','reactivate_subscription','plus',10,'pg_service_role')`,
          ),
        ) as Record<string, string>;
        expect(asSvc.status).toBe("ok");
        expect(subField(TGT2, "status")).toBe("active");
      });

      it("target isolation: each target's row/audit holds EXACTLY the result of its own actions — nothing leaked across targets", () => {
        // TGT1's whole history was its own 4 actions (set plus, set pro,
        // cancel, reactivate plus). After every TGT2 action above, its
        // state must be precisely that — no stray row, no extra audit.
        expect(
          one(
            `select plan || '|' || status || '|' || provider || '|' || coalesce(canceled_at::text, '-') || '|' || coalesce(trial_activated_at::text, '-') from public.subscriptions where user_id = '${TGT1}'`,
          ),
          "TGT1 final row = its own cycle result",
        ).toBe("plus|active|manual|-|-");
        expect(auditCount(TGT1), "TGT1: exactly its own 4 audits").toBe("4");
        expect(eventsCount(TGT1), "TGT1: exactly its own 4 events").toBe("4");

        // TGT2's whole history: 2 concurrent set_plans + 1 service-role
        // reactivate → one row (plus/active/manual), 3 audits, 3 events.
        expect(
          one(
            `select plan || '|' || status || '|' || provider from public.subscriptions where user_id = '${TGT2}'`,
          ),
          "TGT2 final row = its own actions",
        ).toBe("plus|active|manual");
        expect(auditCount(TGT2), "TGT2: exactly its own 3 audits").toBe("3");
        expect(eventsCount(TGT2), "TGT2: exactly its own 3 events").toBe("3");

        // Every audit row references the same actor (server-derived in the
        // app layer) and never a null/foreign target:
        expect(
          one(
            `select count(*) from public.admin_audit_log where actor_id is null or target_user_id is null`,
          ),
        ).toBe("0");
      });

      it("trial (spec §2 at the DB level): two CONCURRENT first activations → exactly one 'activated' + one 'trial_already_used'; the stored span is EXACTLY 72 hours", async () => {
        expect(subCount(TGT3), "TGT3 starts with no subscription").toBe("0");
        const [a, b] = await Promise.all([
          psqlPar(`select public.activate_trial('${TGT3}')`),
          psqlPar(`select public.activate_trial('${TGT3}')`),
        ]);
        const statuses = [JSON.parse(a).status, JSON.parse(b).status].sort();
        expect(statuses).toEqual(["activated", "trial_already_used"]);
        expect(subCount(TGT3), "exactly one trial row").toBe("1");
        expect(subField(TGT3, "plan")).toBe("trial");
        expect(subField(TGT3, "status")).toBe("active");
        expect(subSpanSec(TGT3), "exactly 72 hours").toBe("259200");
        expect(
          one(
            `select trial_activated_at is not null from public.subscriptions where user_id = '${TGT3}'`,
          ),
        ).toBe("t");
      });

      it("trial cannot be restarted: a repeated sequential activation is 'trial_already_used' and does NOT move the stored start/end", async () => {
        const startBefore = subField(TGT3, "current_period_start");
        const out = JSON.parse(
          q(`select public.activate_trial('${TGT3}')`),
        ) as Record<string, unknown>;
        expect(out.status).toBe("trial_already_used");
        expect(subField(TGT3, "current_period_start"), "start unchanged").toBe(
          startBefore,
        );
        expect(subSpanSec(TGT3)).toBe("259200");
        expect(subCount(TGT3)).toBe("1");
      });

      it("a valid paid subscription is never downgraded by a trial request (paid_active, row untouched)", () => {
        const before = one(
          `select plan || '|' || status || '|' || trial_activated_at::text from public.subscriptions where user_id = '${TGT2}'`,
        );
        const out = JSON.parse(
          q(`select public.activate_trial('${TGT2}')`),
        ) as Record<string, string>;
        expect(out.status).toBe("paid_active");
        expect(out.plan_id).toBe(subField(TGT2, "plan"));
        expect(
          one(
            `select plan || '|' || status || '|' || trial_activated_at::text from public.subscriptions where user_id = '${TGT2}'`,
          ),
        ).toBe(before);
      });
    });

    // ---------------------------------------------------------------------
    // D9 — the permanent Free plan's DB-level deckblatt fallback (2/day) is
    // removed by migration 20261127. No-plan / historical-free users get
    // daily_limit 0 and a hard 'quota_exhausted' denial; active entitled
    // plans keep their matrix grants. (The full migration chain — including
    // 20261127 — was applied to this disposable DB in beforeAll.)
    // ---------------------------------------------------------------------

    describe("D9 — no-plan users get NO deckblatt grant at the DB level (migration 20261127)", () => {
      const one = (sql: string) => q(sql).trim();

      // Fixture identities — never reused anywhere else in this file.
      const NF1 = "91919191-9191-4191-8191-919191919191"; // no subscription row
      const NF2 = "92929292-9292-4292-8292-929292929292"; // historical 'free' row
      const NF3 = "93939393-9393-4393-8393-939393939393"; // will activate the trial

      it("fixture: seed auth.users for the no-plan identities (FK targets)", () => {
        q(
          `alter table auth.users disable trigger on_auth_user_created;
           insert into auth.users (id, email) values
             ('${NF1}', 'pg-nf1@test.invalid'),
             ('${NF2}', 'pg-nf2@test.invalid'),
             ('${NF3}', 'pg-nf3@test.invalid');
           alter table auth.users enable trigger on_auth_user_created;`,
        );
        expect(
          one(
            `select count(*) from auth.users where id in ('${NF1}','${NF2}','${NF3}')`,
          ),
        ).toBe("3");
      });

      it("NO subscription row → get_deckblatt_usage_status reports daily_limit 0 / remaining 0 (the former 2/day free fallback is gone)", () => {
        expect(
          one(
            `select daily_limit || '|' || used || '|' || remaining from public.get_deckblatt_usage_status('${NF1}')`,
          ),
        ).toBe("0|0|0");
      });

      it("NO subscription row → reserve_deckblatt_generation denies 'quota_exhausted' BEFORE any write (no run row, no usage row)", () => {
        const run = "94949494-9494-4494-8494-949494940001";
        expect(
          one(
            `select status from public.reserve_deckblatt_generation('${NF1}', '${run}')`,
          ),
        ).toBe("quota_exhausted");
        expect(
          one(
            `select count(*) from public.ai_deckblatt_runs where user_id = '${NF1}'`,
          ),
        ).toBe("0");
        expect(
          one(
            `select count(*) from public.ai_deckblatt_usage where user_id = '${NF1}'`,
          ),
        ).toBe("0");
        // A release of the phantom run is a no-op (nothing was ever reserved).
        expect(
          one(
            `select status from public.release_deckblatt_generation('${NF1}', '${run}')`,
          ),
        ).toBe("no_op");
      });

      it("historical 'free' row (production legacy state) → the same denial: free is history, never a grant", () => {
        q(
          `insert into public.subscriptions (user_id, plan, status, provider, current_period_start, current_period_end)
           values ('${NF2}', 'free', 'active', 'manual', timezone('utc', now()) - interval '30 days', null);`,
        );
        expect(
          one(
            `select daily_limit from public.get_deckblatt_usage_status('${NF2}')`,
          ),
        ).toBe("0");
        expect(
          one(
            `select status from public.reserve_deckblatt_generation('${NF2}', '94949494-9494-4494-8494-949494940002')`,
          ),
        ).toBe("quota_exhausted");
        expect(
          one(
            `select count(*) from public.ai_deckblatt_runs where user_id = '${NF2}'`,
          ),
        ).toBe("0");
      });

      it("an ACTIVE trial user keeps the trial matrix deckblatt grant (1/day) — D9 removed only the FREE fallback, not entitled plans", () => {
        const out = JSON.parse(
          q(`select public.activate_trial('${NF3}')`),
        ) as Record<string, string>;
        expect(out.status).toBe("activated");
        expect(
          one(
            `select daily_limit from public.get_deckblatt_usage_status('${NF3}')`,
          ),
        ).toBe("1");
        expect(
          one(
            `select status from public.reserve_deckblatt_generation('${NF3}', '94949494-9494-4494-8494-949494940003')`,
          ),
        ).toBe("reserved");
        // The trial cap is 1/day: the second generation is denied.
        expect(
          one(
            `select status from public.reserve_deckblatt_generation('${NF3}', '94949494-9494-4494-8494-949494940004')`,
          ),
        ).toBe("quota_exhausted");
      });
    });
    // -----------------------------------------------------------------------
    // Trial exclusivity (2026-10-25): a valid paid subscription and the free
    // trial must never coexist. One row, one plan — paid activation REPLACES
    // the trial plan, PRESERVES the historical trial_activated_at stamp and
    // the audit/event trail, and the consumed trial can never be re-granted.
    // -----------------------------------------------------------------------
    describe("trial exclusivity — paid and trial never coexist (DB level)", () => {
      const one = (sql: string) => q(sql).trim();
      // Fresh fixture ids — distinct from every other suite's fixtures
      // (the manage_subscription block above owns dddddddd-… as TGT3;
      // reusing it would collide on users_pkey in the same disposable DB).
      const T3 = "33333333-3333-4333-8333-333333333333"; // trial → paid
      const T4 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"; // paid → trial attempt
      const MC1 = "11111111-1111-4111-8111-111111111111";
      const ACT = "ffffffff-ffff-4fff-8fff-ffffffffffff"; // admin (this block)

      it("paid activation on top of a consumed trial: entitlement flips to paid, trial stamp + history PRESERVED, trial can never be re-activated", () => {
        // Idempotent fixture setup: wipe any residual rows for THIS test's
        // ids (defensive against a partially-failed prior iteration; the
        // disposable database itself is created fresh per run).
        q(
          `delete from public.subscription_events where user_id = '${T3}';
           delete from public.admin_audit_log where target_user_id = '${T3}';
           delete from public.mock_checkouts where user_id = '${T3}' or id = '${MC1}';
           delete from public.subscriptions where user_id = '${T3}';
           delete from auth.users where id = '${T3}';`,
        );
        // Fixture seeding: the invitation-only registration trigger is
        // toggled atomically within one transaction (same pattern as the
        // suite's user seeding above).
        q(
          `alter table auth.users disable trigger on_auth_user_created;
           insert into auth.users (id, email) values ('${T3}', 'trial3@test.invalid') on conflict (id) do nothing;
           alter table auth.users enable trigger on_auth_user_created;`,
        );
        // 1) One-shot 72 h trial
        const a1 = JSON.parse(
          q(`select public.activate_trial('${T3}')`),
        ) as Record<string, unknown>;
        expect(a1.status).toBe("activated");
        expect(
          one(`select plan from public.subscriptions where user_id = '${T3}'`),
        ).toBe("trial");
        expect(
          one(
            `select extract(epoch from current_period_end - current_period_start)::bigint from public.subscriptions where user_id = '${T3}'`,
          ),
        ).toBe("259200"); // 72 h
        expect(
          one(
            `select trial_activated_at is not null from public.subscriptions where user_id = '${T3}'`,
          ),
        ).toBe("t");

        // 2) Mock checkout (premium_10d) succeeds on top of the trial row
        q(
          `insert into public.mock_checkouts (id, user_id, plan_id, amount_cents, status, idempotency_key, is_mock, expires_at) values ('${MC1}', '${T3}', 'premium_10d', 1000, 'pending', 'pg_trial_excl_t3', true, (timezone('utc', now()) + interval '10 minutes'))`,
        );
        const a2 = JSON.parse(
          q(
            `select public.complete_mock_checkout('${MC1}', '${T3}', 'success')`,
          ),
        ) as Record<string, unknown>;
        expect(a2.status).toBe("succeeded");

        // 3) The single canonical row is now the PAID plan — the trial
        //    entitlement is gone (one row, one plan: no coexistence)
        expect(
          one(`select plan from public.subscriptions where user_id = '${T3}'`),
        ).toBe("premium_10d");
        expect(
          one(
            `select status from public.subscriptions where user_id = '${T3}'`,
          ),
        ).toBe("active");
        expect(
          one(
            `select provider from public.subscriptions where user_id = '${T3}'`,
          ),
        ).toBe("mock");
        expect(
          one(
            `select extract(epoch from current_period_end - current_period_start)::bigint from public.subscriptions where user_id = '${T3}'`,
          ),
        ).toBe("864000"); // premium_10d = exactly 10 days

        // 4) Historical trial record + audit trail preserved (nothing deleted)
        expect(
          one(
            `select trial_activated_at is not null from public.subscriptions where user_id = '${T3}'`,
          ),
        ).toBe("t");
        for (const ev of [
          "trial_activated",
          "mock_checkout_succeeded",
          "subscription_activated",
        ]) {
          expect(
            one(
              `select count(*) from public.subscription_events where user_id = '${T3}' and action = '${ev}'`,
            ),
          ).toBe("1");
        }

        // 5) The consumed trial is NEVER re-activated, paid or not
        const a3 = JSON.parse(
          q(`select public.activate_trial('${T3}')`),
        ) as Record<string, unknown>;
        expect(a3.status).toBe("trial_already_used");
        expect(
          one(`select plan from public.subscriptions where user_id = '${T3}'`),
        ).toBe("premium_10d"); // still paid — untouched by the refused retry
      });

      it("activate_trial against a valid paid (plus, 10 d) subscription → 'paid_active' with ZERO trial writes", () => {
        // Idempotent fixture setup (same defensive pattern as test 1).
        q(
          `delete from public.subscription_events where user_id = '${T4}';
           delete from public.admin_audit_log where target_user_id = '${T4}' or actor_id = '${ACT}';
           delete from public.subscriptions where user_id = '${T4}';
           delete from auth.users where id in ('${T4}', '${ACT}');`,
        );
        q(
          `alter table auth.users disable trigger on_auth_user_created;
           insert into auth.users (id, email) values ('${T4}', 'trial4@test.invalid'), ('${ACT}', 'admin-trial@test.invalid') on conflict (id) do nothing;
           alter table auth.users enable trigger on_auth_user_created;`,
        );
        const g = JSON.parse(
          q(
            `select public.manage_subscription('${ACT}', '${T4}', 'set_plan', 'plus', 10, 'pg_trial_excl')`,
          ),
        ) as Record<string, unknown>;
        expect(g.status).toBe("ok");

        const a = JSON.parse(
          q(`select public.activate_trial('${T4}')`),
        ) as Record<string, unknown>;
        expect(a.status).toBe("paid_active");
        expect(a.plan_id).toBe("plus");

        // No trial stamp written; the paid row untouched:
        expect(
          one(
            `select trial_activated_at is null from public.subscriptions where user_id = '${T4}'`,
          ),
        ).toBe("t");
        expect(
          one(`select plan from public.subscriptions where user_id = '${T4}'`),
        ).toBe("plus");
        expect(
          one(
            `select extract(epoch from current_period_end - current_period_start)::bigint from public.subscriptions where user_id = '${T4}'`,
          ),
        ).toBe("864000"); // plus stays exactly 10 days
        expect(
          one(
            `select count(*) from public.subscription_events where user_id = '${T4}' and action = 'trial_activated'`,
          ),
        ).toBe("0");
      });
    });

    // ---------------------------------------------------------------------
    // P0 quota audit (2026-10-25) — DB-level regressions:
    //   R3: effective_daily_email_limit is ENTITLEMENT-ONLY (20261129):
    //       no plan 0, historical free row 0, trial 3, premium_10d 100,
    //       premium_monthly 250, plus 150, pro 500, expired 0, canceled 0,
    //       invitation-code upgrades apply as max(plan, upgrade).
    //   Concurrency: parallel reserves cannot exceed the daily limit.
    //   Idempotency: the same run_id charges exactly once.
    //   UTC boundary: only the current UTC day counts.
    //   Release: a refund returns exactly one unit (no leak from the race).
    //   (The per_day quota architecture is verified through the deckblatt
    //   RPCs — the 20261121 `reserve_feature_op` body carries the
    //   documented function-body defect and is out of scope here.)
    // ---------------------------------------------------------------------
    describe("P0 quota audit — email limit entitlement-only + concurrency/UTC (DB level)", () => {
      const one = (sql: string) => q(sql).trim();

      // Fixture identities — never reused anywhere else in this file.
      const EL1 = "88888888-8888-4888-8888-888888880001"; // no subscription row
      const EL2 = "88888888-8888-4888-8888-888888880002"; // historical 'free' row
      const EL3 = "88888888-8888-4888-8888-888888880003"; // active trial (RPC)
      const EL4 = "88888888-8888-4888-8888-888888880004"; // premium_10d
      const EL5 = "88888888-8888-4888-8888-888888880005"; // premium_monthly
      const EL6 = "88888888-8888-4888-8888-888888880006"; // plus
      const EL7 = "88888888-8888-4888-8888-888888880007"; // pro
      const EL8 = "88888888-8888-4888-8888-888888880008"; // expired premium_10d
      const EL9 = "88888888-8888-4888-8888-888888880009"; // canceled premium_monthly
      const EL10 = "88888888-8888-4888-8888-888888880010"; // upgrade code only
      const EL11 = "88888888-8888-4888-8888-888888880011"; // trial (concurrency)
      const EL_CODE_A = "88888888-8888-4888-8888-8888888800f0";
      const EL_CODE_B = "88888888-8888-4888-8888-8888888800f1";

      it("fixture: seed users + the limit matrix (trials via the canonical RPC)", () => {
        q(`
          alter table auth.users disable trigger on_auth_user_created;
          insert into auth.users (id, email) values
            ('${EL1}', 'pg-el1@test.invalid'), ('${EL2}', 'pg-el2@test.invalid'),
            ('${EL3}', 'pg-el3@test.invalid'), ('${EL4}', 'pg-el4@test.invalid'),
            ('${EL5}', 'pg-el5@test.invalid'), ('${EL6}', 'pg-el6@test.invalid'),
            ('${EL7}', 'pg-el7@test.invalid'), ('${EL8}', 'pg-el8@test.invalid'),
            ('${EL9}', 'pg-el9@test.invalid'), ('${EL10}', 'pg-el10@test.invalid'),
            ('${EL11}', 'pg-el11@test.invalid')
          on conflict (id) do nothing;
          alter table auth.users enable trigger on_auth_user_created;
        `);
        q(`
          insert into public.subscriptions (user_id, plan, status, provider, current_period_start, current_period_end) values
            ('${EL2}', 'free', 'active', 'manual', timezone('utc', now()) - interval '30 days', null),
            ('${EL4}', 'premium_10d', 'active', 'mock', timezone('utc', now()) - interval '1 day', timezone('utc', now()) + interval '9 days'),
            ('${EL5}', 'premium_monthly', 'active', 'mock', timezone('utc', now()) - interval '1 day', timezone('utc', now()) + interval '29 days'),
            ('${EL6}', 'plus', 'active', 'manual', timezone('utc', now()) - interval '1 day', timezone('utc', now()) + interval '29 days'),
            ('${EL7}', 'pro', 'active', 'manual', timezone('utc', now()) - interval '1 day', timezone('utc', now()) + interval '29 days'),
            ('${EL8}', 'premium_10d', 'active', 'mock', timezone('utc', now()) - interval '11 days', timezone('utc', now()) - interval '1 day'),
            ('${EL9}', 'premium_monthly', 'canceled', 'mock', timezone('utc', now()) - interval '5 days', timezone('utc', now()) + interval '25 days')
          on conflict (user_id) do nothing;
        `);
        for (const trialUser of [EL3, EL11]) {
          const out = JSON.parse(
            q(`select public.activate_trial('${trialUser}')`),
          ) as Record<string, string>;
          expect(out.status, `activate_trial(${trialUser})`).toBe("activated");
        }
      });

      it("R3: NO subscription row → 0 (the former 50/day default floor is gone)", () => {
        expect(one(`select public.effective_daily_email_limit('${EL1}')`)).toBe(
          "0",
        );
      });

      it("R3+R4: historical 'free' row → 0 (free is history, never a grant)", () => {
        expect(one(`select public.effective_daily_email_limit('${EL2}')`)).toBe(
          "0",
        );
      });

      it("R3: active entitlement plans keep their documented emails_per_day values", () => {
        expect(one(`select public.effective_daily_email_limit('${EL3}')`)).toBe(
          "3",
        ); // trial
        expect(one(`select public.effective_daily_email_limit('${EL4}')`)).toBe(
          "100",
        ); // premium_10d
        expect(one(`select public.effective_daily_email_limit('${EL5}')`)).toBe(
          "250",
        ); // premium_monthly
        expect(one(`select public.effective_daily_email_limit('${EL6}')`)).toBe(
          "150",
        ); // plus
        expect(one(`select public.effective_daily_email_limit('${EL7}')`)).toBe(
          "500",
        ); // pro
      });

      it("R3: expired / canceled subscriptions → 0 (no stale capacity)", () => {
        expect(one(`select public.effective_daily_email_limit('${EL8}')`)).toBe(
          "0",
        );
        expect(one(`select public.effective_daily_email_limit('${EL9}')`)).toBe(
          "0",
        );
      });

      it("R3: invitation-code upgrades apply as max(plan, upgrade) — never a downgrade", () => {
        q(`
          insert into public.invitation_codes (id, code, type, daily_email_limit, is_active, max_uses)
          values ('${EL_CODE_A}', 'PGTESTQA', 'quota_upgrade', 200, true, 10),
                 ('${EL_CODE_B}', 'PGTESTQB', 'quota_upgrade', 10, true, 10)
          on conflict (id) do nothing;
          insert into public.user_quota_upgrades (user_id, code_id)
          values ('${EL10}', '${EL_CODE_A}'), ('${EL4}', '${EL_CODE_B}')
          on conflict (user_id, code_id) do nothing;
        `);
        // No plan: the upgrade alone grants its value (documented rule).
        expect(
          one(`select public.effective_daily_email_limit('${EL10}')`),
        ).toBe("200");
        // Upgrade BELOW the plan: the plan value wins.
        expect(one(`select public.effective_daily_email_limit('${EL4}')`)).toBe(
          "100",
        );
      });

      it("concurrency: 3 PARALLEL reserves → exactly ONE 'reserved', the rest 'quota_exhausted', counter = 1", async () => {
        const runs = [
          "88888888-8888-4888-8888-888888880101",
          "88888888-8888-4888-8888-888888880102",
          "88888888-8888-4888-8888-888888880103",
        ];
        const reserve = (run: string) =>
          new Promise<string>((resolve) => {
            execFile(
              "psql",
              [
                ...withServer(db),
                "-c",
                `select status from public.reserve_deckblatt_generation('${EL11}', '${run}')`,
              ],
              { encoding: "utf8", timeout: 60_000 },
              (err, stdout) =>
                resolve((err ? String(err.message) : stdout).trim()),
            );
          });
        const results = await Promise.all(runs.map(reserve));
        expect(results.filter((r) => r === "reserved")).toHaveLength(1);
        expect(results.filter((r) => r === "quota_exhausted")).toHaveLength(2);
        // The daily counter holds EXACTLY 1 — the race could not oversell.
        expect(
          one(
            `select generations_used from public.ai_deckblatt_usage where user_id = '${EL11}' and usage_date = (timezone('utc', now()))::date`,
          ),
        ).toBe("1");
        expect(
          one(
            `select count(*) from public.ai_deckblatt_runs where user_id = '${EL11}'`,
          ),
        ).toBe("1");
      });

      it("idempotency: repeating the winning run_id → 'already_reserved', counter stays 1", () => {
        const winner = one(
          `select run_id::text from public.ai_deckblatt_runs where user_id = '${EL11}'`,
        );
        expect(winner).toMatch(/^[0-9a-f-]{36}$/);
        expect(
          one(
            `select status from public.reserve_deckblatt_generation('${EL11}', '${winner}')`,
          ),
        ).toBe("already_reserved");
        expect(
          one(
            `select generations_used from public.ai_deckblatt_usage where user_id = '${EL11}' and usage_date = (timezone('utc', now()))::date`,
          ),
        ).toBe("1");
      });

      it("UTC boundary: yesterday's (UTC) usage rows do NOT count toward today", () => {
        q(`
          insert into public.ai_deckblatt_usage (user_id, usage_date, generations_used)
          values ('${EL11}', (timezone('utc', now()) - interval '1 day')::date, 5)
          on conflict (user_id, usage_date) do update set generations_used = 5;
        `);
        // The status RPC is a table function: read the columns explicitly.
        const [usedV, remainingV, limitV, dateV] = one(
          `select used || '|' || remaining || '|' || daily_limit || '|' || usage_date::text from public.get_deckblatt_usage_status('${EL11}')`,
        ).split("|");
        expect(dateV).toBe(one(`select (timezone('utc', now()))::date::text`));
        expect(usedV).toBe("1"); // only today's UTC day — not 1 + 5
        expect(remainingV).toBe("0");
        expect(limitV).toBe("1"); // trial matrix value, server-side
      });

      it("release refunds exactly one unit — no quota leak from the race", () => {
        const winner = one(
          `select run_id::text from public.ai_deckblatt_runs where user_id = '${EL11}' and status = 'reserved'`,
        );
        expect(winner).toMatch(/^[0-9a-f-]{36}$/);
        expect(
          one(
            `select status from public.release_deckblatt_generation('${EL11}', '${winner}')`,
          ),
        ).toBe("released");
        expect(
          one(
            `select generations_used from public.ai_deckblatt_usage where user_id = '${EL11}' and usage_date = (timezone('utc', now()))::date`,
          ),
        ).toBe("0");
        // The refunded unit is usable again — and then the day is truly full.
        expect(
          one(
            `select status from public.reserve_deckblatt_generation('${EL11}', '88888888-8888-4888-8888-888888880104')`,
          ),
        ).toBe("reserved");
        expect(
          one(
            `select status from public.reserve_deckblatt_generation('${EL11}', '88888888-8888-4888-8888-888888880105')`,
          ),
        ).toBe("quota_exhausted");
      });
    });
  },
);

describe("billing RLS — PG suite availability (always runs, reports honestly)", () => {
  it("exposes the probe result so reviewers can see whether DB-level verification ran", () => {
    expect(typeof ready).toBe("boolean");
  });
});
