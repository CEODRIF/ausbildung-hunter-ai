import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * OPEN REGISTRATION contract (approved 2026-10-25 — migration
 * 20261201000000 supersedes the invitation-only invariant of
 * 20261021000000 at the database level):
 *
 *  - anyone can create an account: the NEW handle_new_user() must never
 *    raise for a missing, unknown, inactive or exhausted invitation code;
 *  - a PROVIDED valid code is still consumed atomically in the same
 *    transaction as the auth.users insert (same single
 *    `UPDATE ... WHERE used_count < max_uses` as since 20261021 — one of N
 *    racers wins), with the consumed-marker so confirmation never
 *    double-charges;
 *  - codes grant NO entitlements (registration-type codes only increment
 *    used_count) — nothing in this change touches plans, quotas, trials or
 *    user_quota_upgrades;
 *  - the application keeps every anti-abuse control: per-IP rate limit,
 *    terms acceptance, email verification, scrubbed error logging; the
 *    invitation field leaves the signup UI but a directly posted code is
 *    still pre-validated for clear feedback;
 *  - nothing destructive: no table/policy/grant/seed changes, and the
 *    historical migrations (incl. the 20261021 invitation-only invariant)
 *    remain untouched in the chain.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = `${root}/supabase/migrations`;

const normalized = (source: string) => source.replace(/\s+/g, " ").trim();

/** Executable SQL only — explanatory comments may legitimately name the
 *  objects a migration deliberately leaves alone. */
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

const OPEN = "20261201000000_open_registration_optional_invitation";
const ATOMICITY = "20261021000000_invitation_code_atomicity";
const DRIF26 = "20261022000000_seed_invitation_code_drif26";

describe("open registration — database level (new migration pins the last definition)", () => {
  it("exists and is ordered AFTER the invitation-only invariant it supersedes", () => {
    const names = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const index = names.findIndex((f) => f.startsWith(OPEN));
    expect(index).toBeGreaterThan(-1);
    for (const earlier of [ATOMICITY, DRIF26]) {
      expect(index).toBeGreaterThan(
        names.findIndex((f) => f.startsWith(earlier)),
      );
    }
  });

  it("never raises for a missing, unknown or exhausted invitation code", () => {
    const sql = executable(readMigration(OPEN));
    expect(sql).not.toContain("invitation_code_required");
    expect(sql).not.toContain("invitation_code_invalid_or_exhausted");
    // No exception of any kind in the new trigger body:
    const fn = sql.slice(
      sql.indexOf("create or replace function public.handle_new_user()"),
      sql.indexOf("drop trigger if exists on_auth_user_created"),
    );
    expect(fn).not.toContain("raise exception");
  });

  it("still consumes a provided valid code atomically, in the same transaction", () => {
    const sql = normalized(readMigration(OPEN));
    const fn = sql.slice(
      sql.indexOf("create or replace function public.handle_new_user()"),
      sql.indexOf("drop trigger if exists on_auth_user_created"),
    );
    // ONE conditional consumption — the atomic `UPDATE ... WHERE
    // used_count < max_uses` inside consume_invitation_code decides; the
    // codeless path skips it entirely.
    expect(fn).toContain(
      "if v_code <> '' and public.consume_invitation_code(v_code, 'registration') then",
    );
    // The marker (so activate_confirmed_user never double-charges) is set
    // ONLY on successful consumption.
    expect(fn).toContain(
      "jsonb_build_object('invitation_code_consumed', true)",
    );
    // Code extraction unchanged (upper/trim of the metadata value).
    expect(fn).toContain(
      "v_code := upper(trim(coalesce(new.raw_user_meta_data->>'invitation_code', '')));",
    );
  });

  it("keeps the full_name robustness and the profile insert from 20261021", () => {
    const sql = normalized(readMigration(OPEN));
    expect(sql).toContain(
      "v_name := trim(split_part(coalesce(new.email, ''), '@', 1));",
    );
    expect(sql).toContain("v_name := 'Nutzer';");
    expect(sql).toContain("v_name := left(v_name, 120);");
    expect(sql).toContain(
      "insert into public.profiles (id, full_name, email) values (new.id, v_name, new.email) on conflict (id) do nothing;",
    );
  });

  it("keeps the trigger wiring, security definer and search_path contract", () => {
    const sql = normalized(readMigration(OPEN));
    expect(sql).toContain(
      "drop trigger if exists on_auth_user_created on auth.users;",
    );
    expect(sql).toContain(
      "create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();",
    );
    expect(sql).toContain("security definer set search_path = public");
  });

  it("is non-destructive: no table, policy, grant, seed or data changes", () => {
    const sql = executable(readMigration(OPEN));
    expect(sql).not.toContain("drop table");
    expect(sql).not.toContain("drop function");
    expect(sql).not.toContain("drop policy");
    expect(sql).not.toContain("create policy");
    expect(sql).not.toContain("alter table public.invitation_codes");
    expect(sql).not.toContain("grant ");
    expect(sql).not.toContain("revoke ");
    expect(sql).not.toContain("delete from");
    expect(sql).not.toContain("truncate");
    expect(sql).not.toContain("update public.invitation_codes");
    expect(sql).not.toContain("insert into public.invitation_codes");
  });
});

describe("historical chain integrity (nothing previously applied is edited)", () => {
  it("20261021 keeps the invitation-only invariant in the chain (superseded, not rewritten)", () => {
    const sql = executable(readMigration(ATOMICITY));
    expect(sql).toContain("raise exception 'invitation_code_required'");
  });

  it("20250512 keeps the closed client-side surface (RPCs service-role only)", () => {
    const sql = executable(readMigration("20250512000000_auth_foundation"));
    expect(sql).toContain(
      "revoke all on function public.validate_invitation_code(text, public.invitation_code_type) from public, anon, authenticated;",
    );
    expect(sql).toContain(
      "revoke all on function public.consume_invitation_code(text, public.invitation_code_type) from public, anon, authenticated;",
    );
    expect(sql).toContain(
      "grant execute on function public.validate_invitation_code(text, public.invitation_code_type) to service_role;",
    );
  });
});

describe("open registration — application level", () => {
  const actions = normalized(
    readFileSync(`${root}/src/app/register/actions.ts`, "utf8"),
  );
  const form = readFileSync(
    `${root}/src/app/register/register-form.tsx`,
    "utf8",
  );
  const dictionaries = readFileSync(
    `${root}/src/lib/i18n/dictionaries.ts`,
    "utf8",
  );

  it("the signup form no longer renders the invitation-code field", () => {
    expect(form).not.toContain('name="invitationCode"');
    expect(form).not.toContain("auth.form.invitationCode");
  });

  it("the removed i18n keys are gone from every language (no dangling refs)", () => {
    expect(dictionaries).not.toContain("invitationCode:");
    expect(dictionaries).not.toContain("invitationPlaceholder:");
    expect(form).not.toContain("invitationPlaceholder");
  });

  it("the code is optional in the schema; a malformed explicit code is still rejected", () => {
    expect(actions).toContain(".optional()");
    expect(actions).toContain("Enter a valid invitation code.");
  });

  it("a provided code is pre-validated; a missing one is never sent", () => {
    // Pre-check only for an explicitly provided code:
    expect(actions).toContain(
      'if (code && !(await validateInvitationCode(code, "registration")))',
    );
    // Metadata carries the code only when present:
    expect(actions).toContain("invitation_code: code,");
    expect(actions).toContain(
      'invitationCode: formData.get("invitationCode") ?? "",',
    );
  });

  it("anti-abuse controls remain: rate limit, terms, scrubbed logging, safe error mapping", () => {
    expect(actions).toContain('checkRateLimit("register", ipKey)');
    expect(actions).toContain(
      "Please accept the Terms of Service and Privacy Policy to continue.",
    );
    expect(actions).toContain("logRegistrationError");
    expect(actions).toContain("isInvitationRejection");
  });
});
