/**
 * Static drift guard for the subscription & billing v2 migrations.
 *
 * Three new migrations define the commercial-plan data, the quota
 * accounting, and the mock checkout RPCs:
 *   - supabase/migrations/20261120000000_subscription_billing_v2.sql
 *   - supabase/migrations/20261121000000_feature_quotas.sql
 *   - supabase/migrations/20261122000000_mock_checkout_complete.sql
 *
 * The sandbox has no Postgres, so this suite does NOT execute SQL. It
 * instead parses the migration TEXT and pins:
 *
 *   1. SEED <-> CATALOGUE DRIFT GUARD: the three billing_plans seed rows
 *      must match src/lib/billing/commercial-plans.ts (COMMERCIAL_PLANS)
 *      field by field — id, label, emails/ai per day, price in cents,
 *      duration kind + value, is_commercial, and the 12-key feature_limits
 *      map (null = no plan quota, 0 = explicitly disabled).
 *   2. Structural invariants: additive-only DDL, drop-guarded
 *      triggers/policies, fail-closed RLS (no policies on the audit +
 *      mock tables), service-role-only RPCs, the atomic reservation
 *      contract, UTC-pinned calendar-month arithmetic, the legacy deckblatt
 *      fallback (2/day) and the untouched complete_deckblatt_generation.
 *   3. No `create type if not exists` (Postgres 42601) and no
 *      real-payment data columns anywhere in the mock ledger.
 *
 * A drift in either direction (SQL edited without the TS, or the TS edited
 * without the SQL) breaks the build.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { CommercialPlanDef, FeatureId } from "@/lib/billing/commercial-plans";

const holder = vi.hoisted(() => ({
  admin: null as unknown,
  user: null as unknown,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => holder.admin,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => holder.user,
}));

const {
  COMMERCIAL_PLAN_IDS,
  COMMERCIAL_PLANS,
  FEATURE_QUOTA_KIND,
  isCommercialPlanId,
} = await import("@/lib/billing/commercial-plans");
const { ALL_FEATURE_IDS } = await import("@/lib/billing/entitlement-service");

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");

const V2_FILE = "20261120000000_subscription_billing_v2.sql";
const QUOTAS_FILE = "20261121000000_feature_quotas.sql";
const DECKBLATT_FILE = "20261020000000_deckblatt_usage.sql";
const MOCK_FILE = "20261122000000_mock_checkout_complete.sql";

const v2Sql = read(`supabase/migrations/${V2_FILE}`);
const quotasSql = read(`supabase/migrations/${QUOTAS_FILE}`);
const deckblattSql = read(`supabase/migrations/${DECKBLATT_FILE}`);
const mockSql = read(`supabase/migrations/${MOCK_FILE}`);

/** Collapse whitespace runs to single spaces (formatting-independent pins). */
function flatten(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** DDL only: strip plpgsql bodies ($$...$$), line comments, string literals. */
function ddlOnly(sql: string): string {
  return sql
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, " ");
}

const v2Flat = flatten(v2Sql);
const quotasFlat = flatten(quotasSql);
const deckblattFlat = flatten(deckblattSql);
const v2Ddl = flatten(ddlOnly(v2Sql));
const quotasDdl = flatten(ddlOnly(quotasSql));
const mockFlat = flatten(mockSql);
const mockDdl = flatten(ddlOnly(mockSql));

/** Split on commas at paren depth 0, outside single-quoted literals. */
function topLevelItems(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      current += ch;
      if (ch === "'") {
        if (text[i + 1] === "'") {
          current += "'";
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) items.push(current);
  return items.map((s) => s.trim());
}

function unwrapTuple(text: string): string {
  const t = text.trim();
  expect(t.startsWith("(")).toBe(true);
  expect(t.endsWith(")")).toBe(true);
  return t.slice(1, -1);
}

function unquoteLiteral(text: string): string {
  const t = text.trim();
  expect(t.startsWith("'")).toBe(true);
  expect(t.endsWith("'")).toBe(true);
  return t.slice(1, -1).replace(/''/g, "'");
}

function assertDropGuards(flat: string, label: string): { triggers: number; policies: number } {
  const triggers = [...flat.matchAll(/create\s+trigger\s+(\w+)\s+before\s+update\s+on\s+public\.(\w+)/g)];
  for (const m of triggers) {
    expect(flat, `${label}: trigger ${m[1]} must be drop-guarded`).toContain(
      `drop trigger if exists ${m[1]} on public.${m[2]}`,
    );
  }
  const policies = [...flat.matchAll(/create\s+policy\s+"([^"]+)"\s+on\s+public\.(\w+)/g)];
  for (const m of policies) {
    expect(flat, `${label}: policy "${m[1]}" must be drop-guarded`).toContain(
      `drop policy if exists "${m[1]}" on public.${m[2]}`,
    );
  }
  return { triggers: triggers.length, policies: policies.length };
}

// ---------------------------------------------------------------------------
// File presence + run order
// ---------------------------------------------------------------------------

describe("migration files", () => {
  it("all new migrations exist in supabase/migrations", () => {
    const files = readdirSync(resolve(root, "supabase", "migrations"));
    expect(files).toContain(V2_FILE);
    expect(files).toContain(QUOTAS_FILE);
    expect(files).toContain(MOCK_FILE);
  });

  it("files are substantial (negative control against empty files)", () => {
    expect(v2Sql.length).toBeGreaterThan(5000);
    expect(quotasSql.length).toBeGreaterThan(5000);
    expect(mockSql.length).toBeGreaterThan(5000);
  });

  it("headers document the run order (v2 first, then quotas, then mock)", () => {
    expect(v2Flat).toContain(V2_FILE.split("_").slice(1).join("_").length > 0 ? QUOTAS_FILE : "");
    expect(quotasFlat).toContain(V2_FILE);
    expect(mockFlat).toContain(V2_FILE);
    expect(mockFlat).toContain(QUOTAS_FILE);
  });
});

// ---------------------------------------------------------------------------
// Seed rows must mirror the typed catalogue (drift guard)
// ---------------------------------------------------------------------------

describe("billing_plans seed rows mirror COMMERCIAL_PLANS", () => {
  const SEED_MARKER =
    "insert into public.billing_plans (plan_id, label, emails_per_day, ai_requests_per_day, price_cents, duration_kind, duration_value, is_commercial, feature_limits) values";

  function parseSeedFields(): string[][] {
    const start = v2Flat.indexOf(SEED_MARKER);
    expect(start, "seed statement not found").toBeGreaterThanOrEqual(0);
    const end = v2Flat.indexOf("on conflict (plan_id) do update set", start);
    expect(end, "on-conflict clause not found after seed").toBeGreaterThan(start);
    const tuples = topLevelItems(v2Flat.slice(start + SEED_MARKER.length, end));
    expect(tuples.length).toBe(COMMERCIAL_PLAN_IDS.length);
    return tuples.map((t) => topLevelItems(unwrapTuple(t)));
  }

  it("seeds exactly the three commercial plan ids (no more, no less)", () => {
    const fieldsList = parseSeedFields();
    const ids = fieldsList.map((f) => unquoteLiteral(f[0]));
    for (const id of ids) {
      expect(isCommercialPlanId(id), `unexpected plan id ${id}`).toBe(true);
    }
    expect([...ids].sort()).toEqual([...COMMERCIAL_PLAN_IDS].sort());
  });

  it("every seeded row matches the catalogue field by field", () => {
    for (const fields of parseSeedFields()) {
      expect(fields.length, "seed row must have exactly 9 fields").toBe(9);
      const id = unquoteLiteral(fields[0]);
      expect(isCommercialPlanId(id)).toBe(true);
      const def: CommercialPlanDef = COMMERCIAL_PLANS[
        isCommercialPlanId(id) ? id : "trial"
      ];

      expect(unquoteLiteral(fields[1]), `${id}.label`).toBe(def.label);
      expect(Number(fields[2]), `${id}.emails_per_day`).toBe(def.emailsPerDay);
      expect(Number(fields[3]), `${id}.ai_requests_per_day`).toBe(def.aiRequestsPerDay);
      expect(Number(fields[4]), `${id}.price_cents`).toBe(def.priceCents);
      expect(unquoteLiteral(fields[5]), `${id}.duration_kind`).toBe(def.duration.kind);
      const expectedDurationValue =
        def.duration.kind === "fixed_hours"
          ? def.duration.hours
          : def.duration.kind === "fixed_days"
            ? def.duration.days
            : def.duration.kind === "calendar_month"
              ? def.duration.months
              : 0;
      expect(Number(fields[6]), `${id}.duration_value`).toBe(expectedDurationValue);
      expect(fields[7], `${id}.is_commercial`).toBe(String(def.isCommercial));

      const limitsText = fields[8];
      expect(limitsText.endsWith("'::jsonb"), `${id}.feature_limits must be cast to jsonb`).toBe(true);
      const parsed = JSON.parse(
        unquoteLiteral(limitsText.slice(0, -"::jsonb".length)),
      ) as Record<string, number | null>;
      expect(Object.keys(parsed).sort(), `${id}.feature_limits keys`).toEqual(
        Object.keys(FEATURE_QUOTA_KIND).sort(),
      );
      for (const key of Object.keys(FEATURE_QUOTA_KIND) as FeatureId[]) {
        const sqlValue = parsed[key];
        const tsValue = def.featureLimits[key] ?? null;
        expect(sqlValue, `${id}.feature_limits.${key}`).toBe(tsValue);
      }
    }
  });

  it("spec prices/durations are what the spec says (USD cents)", () => {
    expect(COMMERCIAL_PLANS.trial.priceCents).toBe(0);
    expect(COMMERCIAL_PLANS.trial.duration).toEqual({ kind: "fixed_hours", hours: 72 });
    expect(COMMERCIAL_PLANS.premium_10d.priceCents).toBe(1000);
    expect(COMMERCIAL_PLANS.premium_10d.duration).toEqual({ kind: "fixed_days", days: 10 });
    expect(COMMERCIAL_PLANS.premium_monthly.priceCents).toBe(2000);
    expect(COMMERCIAL_PLANS.premium_monthly.duration).toEqual({ kind: "calendar_month", months: 1 });
  });

  it("the seed is idempotent: on conflict refreshes every mutable column", () => {
    expect(v2Flat).toContain(
      "on conflict (plan_id) do update set label = excluded.label, emails_per_day = excluded.emails_per_day, ai_requests_per_day = excluded.ai_requests_per_day, price_cents = excluded.price_cents, duration_kind = excluded.duration_kind, duration_value = excluded.duration_value, is_commercial = excluded.is_commercial, feature_limits = excluded.feature_limits;",
    );
  });
});

// ---------------------------------------------------------------------------
// v2 structural invariants
// ---------------------------------------------------------------------------

describe(`${V2_FILE} — structure`, () => {
  it("extends billing_plans with the five commercial columns", () => {
    expect(v2Flat).toContain(
      "alter table public.billing_plans add column if not exists price_cents integer not null default 0,",
    );
    expect(v2Flat).toContain(
      "add column if not exists duration_kind text not null default 'none' check (duration_kind in ('none', 'fixed_hours', 'fixed_days', 'calendar_month'))",
    );
    expect(v2Flat).toContain("add column if not exists duration_value integer not null default 0,");
    expect(v2Flat).toContain("add column if not exists is_commercial boolean not null default false,");
    expect(v2Flat).toContain(
      "add column if not exists feature_limits jsonb not null default '{}'::jsonb;",
    );
  });

  it("widens the plan/provider checks and adds the trial stamp", () => {
    expect(v2Flat).toContain(
      "check (plan_id in ('free', 'plus', 'pro', 'trial', 'premium_10d', 'premium_monthly'))",
    );
    expect(v2Flat).toContain(
      "check (plan in ('free', 'plus', 'pro', 'trial', 'premium_10d', 'premium_monthly'))",
    );
    expect(v2Flat).toContain("check (provider in ('manual', 'mock'))");
    expect(v2Flat).toContain("add column if not exists trial_activated_at timestamptz");
  });

  it("creates the append-only audit table with all nine actions", () => {
    expect(v2Flat).toContain("create table if not exists public.subscription_events (");
    expect(v2Flat).toContain("check (action in (");
    for (const action of [
      "trial_activated",
      "subscription_activated",
      "subscription_canceled",
      "subscription_expired",
      "mock_checkout_created",
      "mock_checkout_succeeded",
      "mock_checkout_failed",
      "mock_checkout_canceled",
      "mock_checkout_expired",
    ]) {
      expect(v2Flat, `audit action ${action}`).toContain(`'${action}'`);
    }
    expect(v2Flat).toContain("alter table public.subscription_events enable row level security;");
  });

  it("creates the mock checkout ledger (mock-only, idempotent, USD)", () => {
    expect(v2Flat).toContain("create table if not exists public.mock_checkouts (");
    expect(v2Flat).toContain("check (plan_id in ('premium_10d', 'premium_monthly'))");
    expect(v2Flat).toContain("amount_cents integer not null check (amount_cents > 0)");
    expect(v2Flat).toContain("check (currency = 'USD')");
    expect(v2Flat).toContain(
      "check (status in ('pending', 'succeeded', 'failed', 'canceled', 'expired'))",
    );
    expect(v2Flat).toContain("idempotency_key text not null unique");
    expect(v2Flat).toContain("constraint mock_checkouts_is_mock_check check (is_mock = true)");
    expect(v2Flat).toContain("alter table public.mock_checkouts enable row level security;");
  });

  it("pins the calendar-month clamp semantics in the header", () => {
    expect(v2Flat).toContain("2026-01-31");
    expect(v2Flat).toContain("2026-02-28");
    expect(v2Flat).toContain("2026-10-31");
    expect(v2Flat).toContain("2026-11-30");
  });

  it("subscription_period_end is UTC-pinned with end-of-month clamping", () => {
    expect(v2Flat).toContain(
      "create or replace function public.subscription_period_end( p_start timestamptz, p_kind text, p_value integer ) returns timestamptz",
    );
    expect(v2Flat).toContain("timezone('utc', p_start)");
    expect(v2Flat).toContain("date_trunc('month', b.ts) + make_interval(months => p_value)");
    expect(v2Flat).toContain(
      "least(s.src_day, (extract(day from s.target_month + make_interval(months => 1) - interval '1 day')::integer))",
    );
    expect(v2Flat).toContain("p_start + make_interval(hours => p_value)");
    expect(v2Flat).toContain("p_start + make_interval(days => p_value)");
    expect(v2Flat).toContain("at time zone 'utc'");
    expect(v2Flat).toContain("else null");
  });

  it("activate_trial enforces one trial per account without downgrading paid plans", () => {
    expect(v2Flat).toContain(
      "create or replace function public.activate_trial(p_user_id uuid) returns jsonb",
    );
    expect(v2Flat).toContain(
      "trial_end := public.subscription_period_end(now_ts, 'fixed_hours', 72);",
    );
    expect(v2Flat).toContain("'status', 'activated'");
    expect(v2Flat).toContain("'trial_already_used'");
    expect(v2Flat).toContain("'paid_active'");
    expect(v2Flat).toContain("on conflict (user_id) do nothing");
    expect(v2Flat).toContain("raise exception 'subscription_race';");
  });
});

// ---------------------------------------------------------------------------
// quotas structural invariants
// ---------------------------------------------------------------------------

describe(`${QUOTAS_FILE} — structure`, () => {
  it("creates the counter + ledger tables with composite keys and RLS", () => {
    expect(quotasFlat).toContain("create table if not exists public.feature_usage (");
    expect(quotasFlat).toContain("primary key (user_id, feature_id, period_key)");
    expect(quotasFlat).toContain("create table if not exists public.feature_usage_runs (");
    expect(quotasFlat).toContain(
      "constraint feature_usage_runs_user_feature_run_unique unique (user_id, feature_id, run_id)",
    );
    expect(quotasFlat).toContain(
      "check (status in ('reserved', 'succeeded', 'failed', 'released'))",
    );
    expect(quotasFlat).toContain("check (used >= 0 and used <= 1000000)");
    expect(quotasFlat).toContain("alter table public.feature_usage enable row level security;");
    expect(quotasFlat).toContain(
      "alter table public.feature_usage_runs enable row level security;",
    );
  });

  it("the generic reserve/complete/release RPCs follow the atomic contract", () => {
    expect(quotasFlat).toContain("if plan_limit <= 0 then");
    expect(quotasFlat).toContain("where public.feature_usage.used < plan_limit");
    expect(quotasFlat).toContain("on conflict (run_id) do nothing");
    expect(quotasFlat).toContain("if not found then");
    expect(quotasFlat).toContain(
      "return query select 'unmetered'::text, null::integer, null::integer;",
    );
    expect(quotasFlat).toContain("return query select 'already_reserved'::text,");
    expect(quotasFlat).toContain("return query select 'quota_exhausted'::text, plan_limit, 0;");
    expect(quotasFlat).toContain(
      "return query select 'reserved'::text, cur_used, greatest(plan_limit - cur_used, 0);",
    );
    expect(quotasFlat).toContain("return query select 'completed'::text;");
    expect(quotasFlat).toContain("return query select 'no_op'::text;");
    expect(quotasFlat).toContain("return query select 'released'::text;");
  });

  it("resolves plan limits from billing_plans.feature_limits with a numeric guard", () => {
    expect(quotasFlat).toContain("bp.feature_limits ->> p_feature_id ~ '^-?[0-9]+$'");
  });

  it("the stale-run sweeper is a rerun-safe best-effort safety net", () => {
    expect(quotasFlat).toContain("with stale_runs as (");
    expect(quotasFlat).toContain("return coalesce(stale_count, 0);");
  });

  it("meter reads return epoch-millisecond resets (entitlement service contract)", () => {
    expect(quotasFlat).toContain("(extract(epoch from resets_at) * 1000)::bigint");
    expect(quotasFlat).toContain("and d.date = (now() at time zone 'utc')::date");
  });

  it("the deckblatt RPCs are plan-aware with the legacy fallback of 2/day", () => {
    expect(quotasFlat).toContain(
      "drop constraint if exists ai_deckblatt_usage_generations_used_check",
    );
    expect(quotasFlat).toContain("check (generations_used >= 0 and generations_used <= 60)");
    expect(quotasFlat).toContain("coalesce(public.plan_feature_limit(target_user_id, 'deckblatt'), 2)");
    expect(quotasFlat).toContain(
      "create or replace function public.get_deckblatt_usage_status(target_user_id uuid)",
    );
    expect(quotasFlat).toContain("create or replace function public.reserve_deckblatt_generation(");
    expect(quotasFlat).toContain("create or replace function public.release_deckblatt_generation(");
    // complete_deckblatt_generation() returns void and must NOT be redefined.
    expect(quotasFlat).not.toContain(
      "create or replace function public.complete_deckblatt_generation",
    );
  });

  it("raises the ai-files bucket ceiling to the largest plan cap (15 MB)", () => {
    expect(quotasFlat).toContain(
      "update storage.buckets set file_size_limit = 15728640 where id = 'ai-files';",
    );
  });

  it("lists all twelve feature ids and matches the TS feature universe", () => {
    expect([...ALL_FEATURE_IDS].sort()).toEqual(Object.keys(FEATURE_QUOTA_KIND).sort());
    for (const feature of Object.keys(FEATURE_QUOTA_KIND)) {
      const occurrences = quotasFlat.split(`'${feature}'`).length - 1;
      expect(occurrences, `feature id ${feature} under-represented`).toBeGreaterThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------
// mock checkout structural invariants
// ---------------------------------------------------------------------------

describe(`${MOCK_FILE} — structure`, () => {
  it("defines exactly two create-or-replace functions, security definer + pinned search_path", () => {
    expect(mockFlat).toContain(
      "create or replace function public.create_mock_checkout( p_user_id uuid, p_plan_id text, p_idempotency_key text ) returns jsonb language plpgsql security definer set search_path = public",
    );
    expect(mockFlat).toContain(
      "create or replace function public.complete_mock_checkout( p_checkout_id uuid, p_user_id uuid, p_outcome text ) returns jsonb language plpgsql security definer set search_path = public",
    );
  });

  it("price and plan validity come from the server catalogue only", () => {
    expect(mockFlat).toContain("and bp.is_commercial = true and bp.price_cents > 0;");
    expect(mockFlat).toContain("raise exception 'invalid_plan';");
    // Amount is the catalogue price (bp_price), never a client-supplied value;
    // ledger rows are USD + pending + is_mock = true by construction.
    expect(mockFlat).toContain("(p_user_id, p_plan_id, bp_price, 'USD', 'pending', p_idempotency_key, true, expires_ts)");
  });

  it("idempotency: unique key with a user-scoped lost-race reselect", () => {
    expect(mockFlat).toContain("on conflict (idempotency_key) do nothing");
    expect(mockFlat).toContain(
      "where mc.idempotency_key = p_idempotency_key and mc.user_id = p_user_id;",
    );
    expect(mockFlat).toContain("raise exception 'idempotency_conflict';");
  });

  it("pending checkouts expire after 15 minutes (server-enforced)", () => {
    expect(mockFlat).toContain("now_ts + interval '15 minutes';");
    expect(mockFlat).toContain("if mc_expires <= now_ts then");
    expect(mockFlat).toContain("set status = 'expired', updated_at = now_ts");
  });

  it("completion is a locked, user-scoped transition with an outcome allowlist", () => {
    expect(mockFlat).toContain("where mc.id = p_checkout_id and mc.user_id = p_user_id for update;");
    expect(mockFlat).toContain(
      "if p_outcome is null or p_outcome not in ('success', 'failed', 'canceled') then",
    );
  });

  it("returns the full outcome vocabulary (fail-closed statuses included)", () => {
    for (const s of [
      "'status', 'created'",
      "'status', 'existing'",
      "'status', 'not_found'",
      "'status', 'already_succeeded'",
      "'status', 'terminal'",
      "'status', 'expired'",
      "'status', 'failed'",
      "'status', 'canceled'",
      "'status', 'plan_error'",
      "'status', 'succeeded'",
    ]) {
      expect(mockFlat, s).toContain(s);
    }
  });

  it("writes the full mock audit trail to subscription_events", () => {
    for (const action of [
      "mock_checkout_created",
      "mock_checkout_succeeded",
      "mock_checkout_failed",
      "mock_checkout_canceled",
      "mock_checkout_expired",
      "subscription_activated",
    ]) {
      expect(mockFlat, action).toContain(`'${action}'`);
    }
  });

  it("activation uses the shared period-end oracle and upserts the subscription", () => {
    expect(mockFlat).toContain(
      "period_end := public.subscription_period_end(now_ts, bp_kind, bp_value);",
    );
    expect(mockFlat).toContain(
      "insert into public.subscriptions (user_id, plan, status, provider, current_period_start, current_period_end, updated_at)",
    );
    expect(mockFlat).toContain("'active', 'mock', now_ts, period_end, now_ts");
    expect(mockFlat).toContain("on conflict (user_id) do update set");
  });

  it("a mock purchase never touches the trial stamp", () => {
    expect(mockFlat).not.toContain("trial_activated_at");
  });

  it("the success payload is unambiguously mock-labeled", () => {
    expect(mockFlat).toContain("'provider', 'mock',");
    expect(mockFlat).toContain("'mock', true");
  });
});

// ---------------------------------------------------------------------------
// Permissions: service-role-only new RPCs, user-facing deckblatt kept
// ---------------------------------------------------------------------------

describe("RPC permission surface", () => {
  const v2ServiceRpcs = [
    "activate_trial(uuid)",
    "subscription_period_end(timestamptz, text, integer)",
  ];
  const quotasServiceRpcs = [
    "feature_quota_kind(text)",
    "plan_feature_limit(uuid, text)",
    "reserve_feature_op(uuid, text, uuid)",
    "complete_feature_op(uuid, uuid)",
    "release_feature_op(uuid, uuid)",
    "expire_stale_feature_runs(integer)",
    "feature_quota_status(uuid, text)",
    "feature_capacity_status(uuid, text)",
    "release_ai_request(uuid)",
  ];
  const deckblattUserRpcs = [
    "get_deckblatt_usage_status(uuid)",
    "reserve_deckblatt_generation(uuid, uuid)",
    "release_deckblatt_generation(uuid, uuid)",
  ];
  const mockServiceRpcs = [
    "create_mock_checkout(uuid, text, text)",
    "complete_mock_checkout(uuid, uuid, text)",
  ];

  it("v2: the new RPCs are service_role only (no anon/authenticated grants)", () => {
    for (const sig of v2ServiceRpcs) {
      expect(v2Flat).toContain(`revoke all on function public.${sig} from public, anon, authenticated;`);
      expect(v2Flat).toContain(`grant execute on function public.${sig} to service_role;`);
      expect(v2Flat).not.toContain(`grant execute on function public.${sig} to authenticated`);
      expect(v2Flat).not.toContain(`grant execute on function public.${sig} to anon`);
    }
  });

  it("quotas: all nine new RPCs are service_role only", () => {
    for (const sig of quotasServiceRpcs) {
      expect(quotasFlat).toContain(`revoke all on function public.${sig} from public, anon, authenticated;`);
      expect(quotasFlat).toContain(`grant execute on function public.${sig} to service_role;`);
      expect(quotasFlat).not.toContain(`grant execute on function public.${sig} to authenticated`);
      expect(quotasFlat).not.toContain(`grant execute on function public.${sig} to anon`);
    }
  });

  it("quotas: the rewritten deckblatt RPCs stay user-facing (authenticated)", () => {
    for (const sig of deckblattUserRpcs) {
      expect(quotasFlat).toContain(`revoke execute on function public.${sig} from public, anon;`);
      expect(quotasFlat).toContain(`grant execute on function public.${sig} to authenticated;`);
    }
  });

  it("mock: both checkout RPCs are service_role only", () => {
    for (const sig of mockServiceRpcs) {
      expect(mockFlat).toContain(`revoke all on function public.${sig} from public, anon, authenticated;`);
      expect(mockFlat).toContain(`grant execute on function public.${sig} to service_role;`);
      expect(mockFlat).not.toContain(`grant execute on function public.${sig} to authenticated`);
      expect(mockFlat).not.toContain(`grant execute on function public.${sig} to anon`);
    }
  });
});

// ---------------------------------------------------------------------------
// Rerun-safety + additive-only guarantees
// ---------------------------------------------------------------------------

describe("rerun-safety and additive-only DDL", () => {
  it("v2: triggers are drop-guarded; audit + mock tables intentionally have NO policies", () => {
    const r = assertDropGuards(v2Flat, "v2");
    expect(r.triggers).toBeGreaterThanOrEqual(1);
    expect(r.policies).toBe(0);
    expect(v2Flat).not.toContain("create policy");
  });

  it("quotas: every trigger and policy is drop-guarded", () => {
    const r = assertDropGuards(quotasFlat, "quotas");
    expect(r.triggers).toBeGreaterThanOrEqual(2);
    expect(r.policies).toBeGreaterThanOrEqual(2);
  });

  it("mock: no triggers or policies are created (functions only)", () => {
    const r = assertDropGuards(mockFlat, "mock");
    expect(r.triggers).toBe(0);
    expect(r.policies).toBe(0);
    expect(mockFlat).not.toContain("create policy");
  });

  it("no migration uses create type if not exists (Postgres 42601)", () => {
    expect(v2Ddl).not.toMatch(/create\s+type\s+if\s+not\s+exists/i);
    expect(quotasDdl).not.toMatch(/create\s+type\s+if\s+not\s+exists/i);
    expect(mockDdl).not.toMatch(/create\s+type\s+if\s+not\s+exists/i);
  });

  it("no DDL drops tables/columns/functions or deletes user data", () => {
    for (const [label, ddl] of [
      ["v2", v2Ddl],
      ["quotas", quotasDdl],
      ["mock", mockDdl],
    ] as const) {
      expect(ddl, label).not.toMatch(/\bdrop\s+(table|column|database|schema|function)\b/i);
      expect(ddl, label).not.toMatch(/\bdelete\s+from\b/i);
      expect(ddl, label).not.toMatch(/\btruncate\b/i);
    }
  });

  it("existing subscription rows are never rewritten outside function bodies", () => {
    expect(v2Ddl).not.toMatch(/\bupdate\s+public\.subscriptions\b/i);
    expect(v2Ddl).not.toMatch(/\binsert\s+into\s+public\.subscriptions\b/i);
    expect(quotasDdl).not.toMatch(/\bupdate\s+public\.subscriptions\b/i);
    expect(quotasDdl).not.toMatch(/\binsert\s+into\s+public\.(billing_plans|subscriptions)\b/i);
    expect(mockDdl).not.toMatch(/\bupdate\s+public\.subscriptions\b/i);
    expect(mockDdl).not.toMatch(/\binsert\s+into\s+public\.subscriptions\b/i);
  });

  it("the mock ledger stores no real payment data", () => {
    for (const s of ["card_number", "cvv", "card_token", "stripe", "paypal"]) {
      expect(v2Flat).not.toContain(s);
      expect(mockFlat).not.toContain(s);
    }
  });

  it("complete_deckblatt_generation still returns void in the original migration", () => {
    expect(deckblattFlat).toContain(
      "create or replace function public.complete_deckblatt_generation( target_user_id uuid, p_run_id uuid ) returns void",
    );
  });
});
