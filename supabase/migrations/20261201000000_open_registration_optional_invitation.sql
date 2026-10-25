-- ============================================================================
-- 20261201000000 — open registration: invitation code becomes OPTIONAL
--
-- Context (approved product decision, 2026-10-25):
--   Registration has been invitation-only since 20261021000000, where the
--   on_auth_user_created trigger (handle_new_user) makes the invitation code
--   a DATABASE invariant:
--     - sign-up WITHOUT a code      -> raise 'invitation_code_required'
--     - sign-up with an UNKNOWN /
--       inactive / exhausted code   -> raise 'invitation_code_invalid_or_exhausted'
--   (both errcodes P0001, surfaced by Supabase Auth as the opaque
--   "Database error saving new user" 500).
--
-- Approved change:
--   ANYONE may create an account; an invitation code, WHEN provided, is
--   still consumed — so the existing codes keep working exactly as before
--   for attribution and one-use integrity:
--     - no code in the sign-up metadata
--         -> the profile is created, nothing is consumed, no marker;
--     - a VALID code (active, unused uses remaining)
--         -> consumed ATOMICALLY in the same transaction as the
--            auth.users insert (same single
--            `UPDATE ... WHERE used_count < max_uses` as before — one of N
--            racing sign-ups wins, exactly as since 20261021), and the
--            `invitation_code_consumed` metadata marker is set so
--            activate_confirmed_user() never charges a second use;
--     - an INVALID / inactive / exhausted code
--         -> IGNORED: the profile is created, nothing is consumed, no
--            marker, NO exception. A code can never BLOCK a sign-up; the
--            application layer (register server action) gives the user
--            feedback for a code they explicitly entered.
--
-- What this does NOT change:
--   - No table, column, index, RLS policy, grant, revocation, seed row or
--     historical record is touched. invitation_codes / user_quota_upgrades
--     and the administrative tooling around them stay exactly as they are.
--   - Registration-type codes grant NO entitlements (they never did:
--     consume_invitation_code only increments used_count; quota upgrades
--     are the separate 'quota_upgrade' code type via
--     activate_quota_upgrade). Opening registration therefore grants no
--     Plus/Pro/trial/extra-email benefits to anyone.
--   - activate_confirmed_user() is UNCHANGED: its legacy consumption path
--     only fires when a code is present AND the consumed-marker is absent,
--     which is never the case for code-less sign-ups.
--   - Email verification is unchanged: the account still activates only
--     via the Supabase Auth confirmation link (profiles.account_status
--     'pending' -> 'active').
--   - Anti-abuse is unchanged: the per-IP registration rate limit lives in
--     the application (src/lib/rate-limit) and Supabase Auth's own limits
--     are independent of this trigger.
--   - The functions keep the same names, signatures, SECURITY DEFINER and
--     `set search_path = public`; the trigger wiring is re-asserted
--     idempotently (drop + create, same as 20261021).
--
-- Compatibility / rollout order:
--   The new trigger is strictly MORE permissive than the old one.
--   - new app + new DB (target state): open registration, codes optional.
--   - old app + new DB: the server action still REQUIRES a code, so
--     behavior is unchanged for users (the DB simply would have accepted
--     more than the app offers).
--   - new app + OLD DB (the one dangerous window): a code-less sign-up
--     reaches the old trigger and is rejected with the opaque database
--     error, which the app maps to a safe generic message — the account
--     is NOT created (fail closed). The migration must therefore be
--     applied to the production database BEFORE (or with) the app deploy.
--
-- Safety:
--   - Function replacement only (CREATE OR REPLACE) — idempotent, rerun-
--     safe, no user data read-modified or deleted.
--
-- Rollback (restore invitation-only registration):
--   Re-create the previous handle_new_user() body verbatim from
--   20261021000000_invitation_code_atomicity.sql (it is still in the
--   chain; nothing here is dropped). No data migration in either
--   direction — accounts created without a code are simply regular
--   accounts.
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_name text;
begin
  -- Registration is OPEN. An invitation code is OPTIONAL:
  --   * absent            -> nothing to consume, proceed;
  --   * valid             -> consumed atomically in THIS transaction
  --                          (same single `UPDATE ... WHERE
  --                          used_count < max_uses` as since 20261021 —
  --                          one of N racing sign-ups wins; the marker
  --                          below keeps confirmation from double-charging);
  --   * unknown/inactive/exhausted -> IGNORED, never an exception: a code
  --                          must never block a sign-up (the app layer
  --                          tells the user about a code they explicitly
  --                          entered).
  v_code := upper(trim(coalesce(new.raw_user_meta_data->>'invitation_code', '')));
  if v_code <> '' and public.consume_invitation_code(v_code, 'registration') then
    update auth.users
    set raw_user_meta_data =
          coalesce(raw_user_meta_data, '{}'::jsonb)
          || jsonb_build_object('invitation_code_consumed', true)
    where id = new.id;
  end if;

  -- Display name that can never violate profiles_full_name_check
  -- (2..120 chars after trim) — unchanged from 20261021000000
  -- (metadata -> email local part -> constant, clamped).
  v_name := trim(coalesce(new.raw_user_meta_data->>'full_name', ''));
  if char_length(v_name) < 2 then
    v_name := trim(split_part(coalesce(new.email, ''), '@', 1));
  end if;
  if char_length(v_name) < 2 then
    v_name := 'Nutzer';
  end if;
  v_name := left(v_name, 120);

  insert into public.profiles (id, full_name, email)
  values (new.id, v_name, new.email)
  on conflict (id) do nothing;

  return new;
end;
$$;

-- Trigger wiring unchanged (guarded + idempotent).
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();
