import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Deutsch Bibliothek — quota migration source invariants.
 *
 * The repository applies Supabase migrations BY HAND, so the security
 * contract of the daily download quota is a property of this file. These
 * tests pin the boundary that makes the quota unmanipulable from the
 * browser — a regression here would be a privilege-escalation or
 * quota-bypass defect:
 *
 *   1. ONE new table (book_download_quota): PK (user_id, quota_day),
 *      cascade-FK to auth.users, RLS ON, NO user-facing policies.
 *   2. ONE new RPC (reserve_book_download): security definer, pinned
 *      search_path, UTC day key (the app-wide daily-counter convention —
 *      a new day is a new row, i.e. the reset), row lock (FOR UPDATE =
 *      the concurrency guard), 10 s same-book dedup window, limit bound
 *      check, service_role-only grants.
 *   3. NOTHING else: no other table created/altered/written, no seeds,
 *      no credentials, no touch of the subscription system.
 */

const MIGRATION = readFileSync(
  join(__dirname, "..", "supabase", "migrations", "20261204000000_book_download_quota.sql"),
  "utf8",
);

/** Strip SQL comments so assertions match code, not prose. */
function codeOnly(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const CODE = codeOnly(MIGRATION);

describe("book_download_quota table", () => {
  it("creates exactly one new table, keyed per user per day", () => {
    const created = CODE.match(/create table if not exists (\S+)/g) ?? [];
    expect(created).toEqual(["create table if not exists public.book_download_quota"]);
    expect(CODE).toMatch(/primary key \(user_id, quota_day\)/);
  });

  it("the day key defaults to the UTC day (the app-wide counter convention)", () => {
    expect(CODE).toMatch(
      /quota_day\s+date not null default \(timezone\('utc', now\(\)\)\)::date/,
    );
  });

  it("rows cascade away with the auth account (no orphan counters)", () => {
    expect(CODE).toMatch(
      /user_id\s+uuid not null references auth\.users\(id\) on delete cascade/,
    );
  });

  it("the counter is bounded (sanity check, no negative/huge counts)", () => {
    expect(CODE).toMatch(/check \(used_count >= 0 and used_count <= 10000\)/);
  });

  it("enables RLS and creates NO user-facing policy (service-role only access)", () => {
    expect(CODE).toMatch(
      /alter table public\.book_download_quota enable row level security/,
    );
    expect(CODE).not.toMatch(
      /create policy[^;]*on public\.book_download_quota[^;]*;/,
    );
    expect(CODE).not.toMatch(/create policy[^;]*for (insert|update|delete)[^;]*book_download_quota/);
  });

  it("no user privilege grant exists on the table at all", () => {
    expect(CODE).not.toMatch(/grant (select|insert|update|delete)[^;]*on public\.book_download_quota/);
  });
});

describe("reserve_book_download RPC", () => {
  it("is security definer with a pinned search_path (house RPC pattern)", () => {
    expect(CODE).toMatch(
      /create function public\.reserve_book_download\(p_user_id uuid, p_book_id uuid, p_limit integer\)/,
    );
    expect(CODE).toMatch(/language plpgsql/);
    expect(CODE).toMatch(/security definer/);
    expect(CODE).toMatch(/set search_path = public/);
  });

  it("scopes the counter to the UTC day (day key = daily reset, no cron)", () => {
    // The RPC variable and the table default must agree on the day.
    expect(CODE).toMatch(
      /v_today date := \(timezone\('utc', now\(\)\)\)::date/,
    );
    expect(CODE).toMatch(
      /where user_id = p_user_id and quota_day = v_today/,
    );
    const dayKeyCount = CODE.match(/timezone\('utc', now\(\)\)\)::date/g) ?? [];
    expect(dayKeyCount.length).toBeGreaterThanOrEqual(2);
  });

  it("consumes atomically: upsert-then-FOR UPDATE row lock (concurrent requests serialize)", () => {
    expect(CODE).toMatch(
      /insert into public\.book_download_quota \(user_id, quota_day, used_count\)\s*values \(p_user_id, v_today, 0\)\s*on conflict \(user_id, quota_day\) do nothing/,
    );
    expect(CODE).toMatch(/for update/);
    // The increment is a single conditional update — no read-then-write gap.
    expect(CODE).toMatch(/set used_count = used_count \+ 1/);
  });

  it("denies at the limit (fail closed, granted=false)", () => {
    expect(CODE).toMatch(/if current_usage\.used_count >= p_limit then/);
    expect(CODE).toMatch(/'granted', false/);
  });

  it("dedups the same book within 10 seconds (retries are not double-counted)", () => {
    expect(CODE).toMatch(
      /last_book_id = p_book_id[\s\S]*?interval '10 seconds'/,
    );
    expect(CODE).toMatch(/'granted', true, 'deduplicated', true/);
  });

  it("bounds the server-supplied limit (garbage cannot break the counter)", () => {
    expect(CODE).toMatch(/if p_limit < 0 or p_limit > 10000 then/);
    expect(CODE).toMatch(/raise exception 'invalid_quota_limit'/);
  });

  it("is callable ONLY by service_role (browser cannot invoke or inflate)", () => {
    expect(CODE).toMatch(
      /revoke all on function public\.reserve_book_download\(uuid, uuid, integer\) from public, anon, authenticated/,
    );
    expect(CODE).toMatch(
      /grant execute on function public\.reserve_book_download\(uuid, uuid, integer\) to service_role/,
    );
  });
});

describe("scope hygiene (narrowly additive)", () => {
  const SENSITIVE = [
    "subscriptions",
    "billing_plans",
    "profiles",
    "daily_usage",
    "german_books",
    "storage.buckets",
    "storage.objects",
  ];

  it("touches NO existing table or policy (comment-stripped code)", () => {
    for (const name of SENSITIVE) {
      expect(CODE, `must not reference ${name}`).not.toMatch(new RegExp(name));
    }
    const altered = CODE.match(/alter table (public\.\w+)/g) ?? [];
    expect(altered).toEqual(["alter table public.book_download_quota"]);
  });

  it("writes ONLY its own counter row inside the RPC (no seeds anywhere)", () => {
    const inserts = CODE.match(/insert into (\S+)/g) ?? [];
    expect(inserts).toEqual(["insert into public.book_download_quota"]);
  });

  it("drops only what it creates itself (idempotent re-apply)", () => {
    const drops = CODE.match(/drop (function|table|policy) if exists ([^;\s]+)/g) ?? [];
    for (const d of drops) {
      expect(d).toMatch(/reserve_book_download/);
    }
    expect(CODE).toContain("create table if not exists");
  });

  it("contains no credential or secret reference", () => {
    expect(MIGRATION).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
    expect(CODE).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|service_role_key/i);
  });
});
