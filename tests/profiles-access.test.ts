import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Profiles access contract (production incident: confirmed + active users
 * bounced to /verify because the authenticated profiles SELECT saw no row):
 *  - the source of truth (20250512000000) defines the two RLS policies;
 *  - the restore migration (20261008000000) recreates the SAME policy
 *    definitions, idempotently, and grants SELECT/UPDATE to authenticated;
 *  - the restore migration is strictly additive (no drops/revokes/data).
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = `${root}/supabase/migrations`;

function readMigration(name: string): string {
  const source = readFileSync(`${migrationsDir}/${name}.sql`, "utf-8");
  expect(source.length).toBeGreaterThan(0);
  return source;
}

const normalized = (source: string) => source.replace(/\s+/g, " ").trim();
const executable = (source: string) =>
  normalized(source.replace(/--[^\n]*/g, " "));

describe("profiles access (RLS policies + grants)", () => {
  it("source-of-truth migration defines the original policy contract", () => {
    const base = normalized(readMigration("20250512000000_auth_foundation"));
    expect(base).toContain(
      'create policy "Users can read their own profile" on public.profiles for select to authenticated using (auth.uid() = id);',
    );
    expect(base).toContain(
      'create policy "Users can update their own onboarding fields" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);',
    );
    expect(base).toContain(
      "alter table public.profiles enable row level security;",
    );
  });

  it("restore migration re-creates the same policy bodies, idempotently", () => {
    const restore = normalized(
      readMigration("20261008000000_restore_profiles_access"),
    );
    expect(restore).toContain(
      'create policy "Users can read their own profile" on public.profiles for select to authenticated using (auth.uid() = id)',
    );
    expect(restore).toContain(
      'create policy "Users can update their own onboarding fields" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id)',
    );
    // Idempotency: policies are only created when missing.
    expect(restore).toContain("if not exists ( select 1 from pg_policies");
    expect(restore).toContain(
      "policyname = 'Users can read their own profile'",
    );
    expect(restore).toContain(
      "policyname = 'Users can update their own onboarding fields'",
    );
  });

  it("restore migration grants the app's authenticated access", () => {
    const restore = normalized(
      readMigration("20261008000000_restore_profiles_access"),
    );
    expect(restore).toContain(
      "grant select, update on public.profiles to authenticated;",
    );
    expect(restore).toContain(
      "grant select, insert, update on public.profiles to service_role;",
    );
    expect(restore).toContain(
      "alter table public.profiles enable row level security;",
    );
  });

  it("restore migration is strictly additive (no drops, revokes, or data changes)", () => {
    const sql = executable(
      readMigration("20261008000000_restore_profiles_access"),
    ).toLowerCase();
    expect(sql).not.toContain("drop");
    expect(sql).not.toContain("revoke");
    expect(sql).not.toContain("delete");
    expect(sql).not.toContain("update public.profiles");
    expect(sql).not.toContain("insert into public.profiles");
  });
});
