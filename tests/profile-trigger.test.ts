import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Profile-creation trigger contract (production incident 2026-10):
 *  - the source of truth (20250512000000) defines handle_new_user +
 *    on_auth_user_created as AFTER INSERT on auth.users;
 *  - the restore migration (20261007000000) re-creates them with the same
 *    contract — security definer, full_name from raw_user_meta_data,
 *    idempotent, and WITHOUT touching invitation consumption (that belongs
 *    to on_auth_user_email_confirmed / activate_confirmed_user);
 *  - no migration in the chain ever drops handle_new_user.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = `${root}/supabase/migrations`;

function readMigration(name: string): string {
  const file = `${migrationsDir}/${name}.sql`;
  const source = readFileSync(file, "utf-8");
  expect(source.length).toBeGreaterThan(0);
  return source;
}

const normalized = (source: string) => source.replace(/\s+/g, " ").trim();

describe("profile creation trigger (handle_new_user)", () => {
  it("source-of-truth migration defines the function and AFTER INSERT trigger", () => {
    const base = normalized(readMigration("20250512000000_auth_foundation"));
    expect(base).toContain(
      "create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public",
    );
    expect(base).toContain(
      "insert into public.profiles (id, full_name, email) values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), new.email) on conflict (id) do nothing;",
    );
    expect(base).toContain(
      "create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();",
    );
  });

  it("restore migration re-creates the exact contract, idempotently", () => {
    const restore = normalized(
      readMigration("20261007000000_restore_profile_creation_trigger"),
    );
    expect(restore).toContain(
      "create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public",
    );
    expect(restore).toContain(
      "insert into public.profiles (id, full_name, email) values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), new.email) on conflict (id) do nothing;",
    );
    expect(restore).toContain(
      "drop trigger if exists on_auth_user_created on auth.users;",
    );
    expect(restore).toContain(
      "create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();",
    );
  });

  // The executable SQL (comments stripped) is what must stay untouched —
  // explanatory comments may legitimately name the objects they avoid.
  const executableSql = (source: string) =>
    normalized(source.replace(/--[^\n]*/g, " "));

  it("restore migration does NOT consume the invitation (that stays with email confirmation)", () => {
    const executable = executableSql(
      readMigration("20261007000000_restore_profile_creation_trigger"),
    );
    expect(executable).not.toContain("consume_invitation_code");
    expect(executable).not.toContain("invitation_code");
  });

  it("restore migration is additive: no drops of functions, tables, RLS, or verification objects", () => {
    const executable = executableSql(
      readMigration("20261007000000_restore_profile_creation_trigger"),
    );
    const lower = executable.toLowerCase();
    expect(lower).not.toContain("drop function");
    expect(lower).not.toContain("drop table");
    expect(lower).not.toContain("drop policy");
    expect(lower).not.toContain("alter table public.profiles");
    expect(lower).not.toContain("verification_codes");
  });

  it("no migration in the chain drops handle_new_user", () => {
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const source = readFileSync(`${migrationsDir}/${file}`, "utf-8");
      expect(source, file).not.toMatch(
        /drop\s+function\s+public\.handle_new_user/i,
      );
    }
  });
});
