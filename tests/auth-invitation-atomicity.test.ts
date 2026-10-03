import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Invitation-code atomicity contract (production defect, reproduced against a
 * real Postgres running this migration chain):
 *
 * The old flow validated the code at sign-up with `validate_invitation_code`
 * (a read-only EXISTS check) and only consumed it later, when the user clicked
 * the confirmation link. One `max_uses = 1` code therefore created FOUR
 * accounts in one window (four auth.users rows, four profiles, all activated)
 * while the counter only ever reached 1 — and the public anon key makes that
 * reachable without going through the app's server action at all.
 *
 * The contract these tests pin:
 *  - consumption happens INSIDE handle_new_user(), i.e. in the same
 *    transaction as the auth.users insert, via the single atomic
 *    `UPDATE ... WHERE used_count < max_uses` in consume_invitation_code();
 *  - the consumption result is CHECKED (a losing racer raises, which rolls the
 *    whole sign-up back) — the old code discarded it with `perform`;
 *  - a sign-up without an invitation code is rejected at the database level;
 *  - handle_new_user() can no longer violate profiles_full_name_check;
 *  - the confirmation trigger does not charge the same account a second use;
 *  - DRIF26 exists as an active single-use registration code.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = `${root}/supabase/migrations`;

const normalized = (source: string) => source.replace(/\s+/g, " ").trim();

/** Executable SQL only — explanatory comments may legitimately name the
 *  objects and codes a migration deliberately leaves alone. */
const executable = (source: string) =>
  normalized(
    source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n"),
  );

function readMigration(name: string): string {
  const source = readFileSync(`${migrationsDir}/${name}.sql`, "utf-8");
  expect(source.length).toBeGreaterThan(0);
  return source;
}

const ATOMICITY = "20261021000000_invitation_code_atomicity";
const DRIF26 = "20261022000000_seed_invitation_code_drif26";

describe("invitation consumption is atomic with account creation", () => {
  it("consumes the code inside handle_new_user (same transaction as the insert)", () => {
    const sql = normalized(readMigration(ATOMICITY));
    const fn = sql.slice(
      sql.indexOf("create or replace function public.handle_new_user()"),
      sql.indexOf("drop trigger if exists on_auth_user_created"),
    );
    expect(fn).toContain("public.consume_invitation_code(v_code, 'registration')");
    // The result must be checked, not discarded (the old `perform` call let
    // users beyond max_uses through).
    expect(fn).toContain("if not public.consume_invitation_code");
    expect(fn).toContain("raise exception 'invitation_code_invalid_or_exhausted'");
  });

  it("rejects a sign-up with no invitation code at the database level", () => {
    const sql = normalized(readMigration(ATOMICITY));
    expect(sql).toContain("raise exception 'invitation_code_required'");
    // …which is what closes the public-anon-key bypass of the server action.
    expect(sql).toContain(
      "v_code := upper(trim(coalesce(new.raw_user_meta_data->>'invitation_code', '')));",
    );
    expect(sql).toContain("if v_code = '' then");
  });

  it("keeps the trigger wiring on auth.users AFTER INSERT", () => {
    const sql = normalized(readMigration(ATOMICITY));
    expect(sql).toContain("drop trigger if exists on_auth_user_created on auth.users;");
    expect(sql).toContain(
      "create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();",
    );
    expect(sql).toContain("security definer set search_path = public");
  });

  it("can no longer violate profiles_full_name_check", () => {
    const sql = normalized(readMigration(ATOMICITY));
    // Falls back to the email local part, then a constant, then clamps.
    expect(sql).toContain("v_name := trim(split_part(coalesce(new.email, ''), '@', 1));");
    expect(sql).toContain("v_name := 'Nutzer';");
    expect(sql).toContain("v_name := left(v_name, 120);");
    // Never the old unconditional empty string.
    expect(sql).not.toContain("values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), new.email)");
  });

  it("never charges the same account a second time at confirmation", () => {
    const sql = normalized(readMigration(ATOMICITY));
    expect(sql).toContain("jsonb_build_object('invitation_code_consumed', true)");
    expect(sql).toContain(
      "coalesce(new.raw_user_meta_data->>'invitation_code_consumed', 'false') <> 'true'",
    );
    // Profile activation stays best-effort: it must never abort the
    // confirmation/session creation (hardening from 20261006000000).
    expect(sql).toContain("activate_confirmed_user: profile activation skipped");
    expect(sql).toContain("activate_confirmed_user: invitation consumption skipped");
  });

  it("is ordered after every migration it supersedes", () => {
    const names = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    const index = names.findIndex((f) => f.startsWith(ATOMICITY));
    expect(index).toBeGreaterThan(-1);
    for (const earlier of [
      "20250512000000_auth_foundation",
      "20261005000000_email_confirmation_activation",
      "20261006000000_harden_confirmation_trigger",
      "20261007000000_restore_profile_creation_trigger",
    ]) {
      expect(index).toBeGreaterThan(names.findIndex((f) => f.startsWith(earlier)));
    }
    expect(names.findIndex((f) => f.startsWith(DRIF26))).toBeGreaterThan(index);
  });
});

describe("DRIF26 registration code", () => {
  it("is seeded as an active single-use registration code", () => {
    const sql = normalized(readMigration(DRIF26));
    expect(sql).toContain(
      "insert into public.invitation_codes (code, type, is_active, max_uses, daily_email_limit) values ('DRIF26', 'registration', true, 1, 50)",
    );
  });

  it("is idempotent and never resurrects a spent code", () => {
    const sql = normalized(readMigration(DRIF26));
    expect(sql).toContain("on conflict (code) do update");
    // used_count / max_uses are deliberately absent from the update list.
    const update = sql.slice(sql.indexOf("on conflict (code) do update"));
    expect(update).not.toContain("used_count");
    expect(update).not.toContain("max_uses");
  });

  it("does not touch the historical codes", () => {
    const sql = executable(readMigration(DRIF26));
    expect(sql).not.toContain("DRIF928");
    expect(sql).not.toContain("DRIF089");
    expect(sql).not.toContain("delete from public.invitation_codes");
  });
});
