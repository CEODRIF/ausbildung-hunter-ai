/**
 * AI Bewerbung Studio — migration static review (20261210000000).
 *
 * The migration is applied MANUALLY and must be safe to re-run and strictly
 * additive. These checks pin that contract without touching a database:
 *   - every object is created idempotently (IF NOT EXISTS / pg_type guard)
 *   - NO existing table, column, function or bucket is altered/dropped
 *   - RLS on all four studio tables: owner SELECT-only, explicit write revoke
 *   - scheduler RPCs service-role-only
 *   - idempotency anchors exist (unique idempotency keys)
 *   - no credentials/secrets in the SQL
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(join(process.cwd(), "supabase/migrations/20261210000000_bewerbung_studio.sql"), "utf8");
const lower = SQL.toLowerCase();

describe("idempotency (safe re-run)", () => {
  it("all CREATE TABLE statements use IF NOT EXISTS", () => {
    const creates = [...lower.matchAll(/create table(\s+if not exists)?/g)];
    expect(creates.length).toBe(4);
    for (const m of creates) expect(m[1]).toBeDefined();
  });

  it("all CREATE INDEX statements use IF NOT EXISTS", () => {
    const creates = [...lower.matchAll(/create index(\s+if not exists)?/g)];
    expect(creates.length).toBe(9);
    for (const m of creates) expect(m[1]).toBeDefined();
  });

  it("all three enums are pg_type-guarded", () => {
    for (const name of ["studio_app_status", "studio_doc_type", "studio_send_status"]) {
      expect(lower).toContain(`typname = '${name}'`);
    }
  });

  it("triggers and policies are drop-guarded before creation", () => {
    expect(lower.match(/drop trigger if exists studio_/g)?.length).toBe(2);
    expect(lower.match(/drop policy if exists "studio_/g)?.length).toBe(4);
  });

  it("RPCs use CREATE OR REPLACE (idempotent)", () => {
    expect(lower).toContain("create or replace function public.claim_due_studio_attempts");
    expect(lower).toContain("create or replace function public.recover_stale_studio_attempts");
  });
});

describe("backward compatibility (strictly additive)", () => {
  it("no ALTER TABLE on non-studio tables", () => {
    const alters = [...lower.matchAll(/alter table\s+public\.(\w+)/g)].map((m) => m[1]);
    expect(alters).toEqual(alters.filter((t) => t.startsWith("studio_")));
  });

  it("no DROP of tables, columns, functions or storage objects", () => {
    expect(lower).not.toMatch(/drop table\b/);
    expect(lower).not.toMatch(/drop column\b/);
    expect(lower).not.toMatch(/drop function\b/);
    expect(lower).not.toMatch(/drop storage|drop bucket/);
  });

  it("no changes to the existing application-attachments bucket", () => {
    expect(lower).not.toMatch(/alter (bucket|storage)|insert into storage/);
  });
});

describe("security contract", () => {
  const TABLES = ["studio_applications", "studio_documents", "studio_attachments", "studio_send_attempts"];

  it("RLS is enabled on all four studio tables", () => {
    for (const t of TABLES) expect(lower).toContain(`alter table public.${t} enable row level security`);
  });

  it("owner-SELECT policy on every table", () => {
    for (const t of TABLES) {
      expect(lower).toContain(`create policy "${t}_owner_select"`);
    }
    expect((lower.match(/using \(auth\.uid\(\) = user_id\)/g) ?? []).length).toBe(4);
  });

  it("writes are revoked from anon AND authenticated (service-role-only)", () => {
    for (const t of TABLES) {
      expect(lower).toContain(`revoke insert, update, delete on public.${t} from anon, authenticated`);
    }
  });

  it("scheduler RPCs are service-role-only", () => {
    expect(lower).toContain("revoke execute on function public.claim_due_studio_attempts(integer) from anon, authenticated");
    expect(lower).toContain("grant execute on function public.claim_due_studio_attempts(integer) to service_role");
    expect(lower).toContain("revoke execute on function public.recover_stale_studio_attempts() from anon, authenticated");
    expect(lower).toContain("grant execute on function public.recover_stale_studio_attempts() to service_role");
  });

  it("claim RPC never increments attempt_count (single counting point)", () => {
    const claimFn = SQL.slice(SQL.indexOf("claim_due_studio_attempts"), SQL.indexOf("recover_stale_studio_attempts"));
    expect(claimFn).not.toMatch(/attempt_count\s*\+\s*1/);
  });

  it("foreign keys reference existing tables with sane delete behavior", () => {
    expect(lower).toContain("references auth.users(id) on delete cascade");
    expect(lower).toContain("references public.email_accounts(id) on delete set null");
    expect(lower).toContain("references public.studio_applications(id) on delete cascade");
  });

  it("idempotency anchors: unique idempotency_key on applications AND attempts", () => {
    expect(lower).toContain("idempotency_key uuid unique"); // studio_applications
    expect(lower).toContain("idempotency_key uuid not null unique"); // studio_send_attempts
  });

  it("no credentials or secrets in the SQL", () => {
    expect(SQL).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    expect(SQL).not.toMatch(/service_role\s*token|eyJ[A-Za-z0-9_-]{20,}/);
    expect(SQL).not.toMatch(/password\s*=/i);
  });
});
