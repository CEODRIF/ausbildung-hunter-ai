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

      it("set_plan on a fresh user → ok, provider=manual (an admin grant, NOT a payment), exact 30-day span, created_by=actor, ONE audit row with before/after, ONE billing event", () => {
        const out = JSON.parse(
          q(
            `select public.manage_subscription('${ACTOR}','${TGT1}','set_plan','plus',30,'pg_test')`,
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
        expect(subSpanSec(TGT1)).toBe("2592000"); // 30 d, exactly
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
            `select public.manage_subscription('${ACTOR}','${TGT1}','set_plan','pro',1,'pg_test')`,
          ),
        ) as Record<string, unknown>;
        expect(out.status).toBe("ok");
        expect(out.before).toMatchObject({ plan: "plus", status: "active" });
        expect(out.after).toMatchObject({ plan: "pro", status: "active" });

        expect(subCount(TGT1), "still exactly one row").toBe("1");
        expect(subField(TGT1, "plan")).toBe("pro");
        expect(subSpanSec(TGT1)).toBe("86400"); // 1 d, exactly
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
            `select public.manage_subscription('${ACTOR}','${TGT1}','reactivate_subscription','plus',30,'pg_test')`,
          ),
        ) as Record<string, unknown>;
        expect(r.status).toBe("ok");
        expect(r.before).toMatchObject({ status: "canceled" });
        expect(subField(TGT1, "status")).toBe("active");
        expect(subField(TGT1, "plan")).toBe("plus");
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
            `select public.manage_subscription(null, '${TGT2}', 'set_plan', 'plus', 30, 'x')`,
          ],
          [
            "invalid_action",
            `select public.manage_subscription('${ACTOR}', '${TGT2}', 'frobnicate', 'plus', 30, 'x')`,
          ],
          [
            "invalid_plan(trial)",
            `select public.manage_subscription('${ACTOR}', '${TGT2}', 'set_plan', 'trial', 30, 'x')`,
          ],
          [
            "invalid_plan(free)",
            `select public.manage_subscription('${ACTOR}', '${TGT2}', 'set_plan', 'free', 30, 'x')`,
          ],
          [
            "invalid_plan(unknown)",
            `select public.manage_subscription('${ACTOR}', '${TGT2}', 'set_plan', 'enterprise', 30, 'x')`,
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
              `select public.manage_subscription('${ACTOR}','${TGT2}','set_plan','plus',30,'pg_atomic')`,
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
            `select public.manage_subscription('${ACTOR}','${TGT2}','set_plan','plus',30,'pg_conc_a')`,
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
          `set role authenticated; select public.manage_subscription('${ACTOR}','${TGT2}','set_plan','plus',30,'pg_denied');`,
        );
        expect(asAuth.ok).toBe(false);
        expect(asAuth.out).toContain(
          "permission denied for function manage_subscription",
        );

        const asAnon = qSoft(
          `set role anon; select public.manage_subscription('${ACTOR}','${TGT2}','set_plan','plus',30,'pg_denied');`,
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
            `set role service_role; select public.manage_subscription('${ACTOR}','${TGT2}','reactivate_subscription','plus',30,'pg_service_role')`,
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
  },
);

describe("billing RLS — PG suite availability (always runs, reports honestly)", () => {
  it("exposes the probe result so reviewers can see whether DB-level verification ran", () => {
    expect(typeof ready).toBe("boolean");
  });
});
