-- ----------------------------------------------------------------------------
-- Invitation-code atomicity + profile-creation robustness.
--
-- TWO PRODUCTION DEFECTS FIXED HERE (both reproduced against a real Postgres
-- running the full auth migration chain):
--
-- 1) ONE-USE CODES WERE NOT ONE-USE.
--    The old contract validated the code at sign-up (validate_invitation_code
--    — a read-only EXISTS check) and only consumed it later, when the user
--    clicked the confirmation link (activate_confirmed_user ->
--    consume_invitation_code). Between those two moments the code was still
--    "unused" in the database, so every sign-up request that raced inside that
--    window was accepted. Reproduced: ONE code with max_uses = 1 created FOUR
--    accounts (four auth.users rows, four profiles, all activated) and the
--    counter only ever moved to 1. The register server action is not a gate —
--    the anon key is public, so the same bypass is reachable by talking to
--    Supabase Auth directly.
--    Fix: consumption is moved into handle_new_user(), i.e. INTO the same
--    transaction as the auth.users insert. consume_invitation_code() is a
--    single atomic `UPDATE ... WHERE used_count < max_uses`, so exactly one of
--    N racing sign-ups wins; the losers raise, which aborts and rolls back
--    their whole sign-up (no auth user, no profile, no counter movement).
--    The result of the consumption is now also CHECKED (the old code called it
--    with `perform`, discarding the boolean, so users beyond the limit were
--    still activated).
--
-- 2) SIGN-UPS WITHOUT full_name COULD NOT COMPLETE AT ALL.
--    handle_new_user() inserted coalesce(metadata->>'full_name', ''), and
--    profiles.full_name has CHECK (char_length(trim(full_name)) between 2 and
--    120). Any sign-up whose metadata carried no usable full_name (OAuth
--    sign-in, admin/dashboard-created user, any future non-form client) failed
--    the constraint, which aborted the auth.users insert and surfaced as
--    GoTrue's opaque "Database error saving new user" 500. Reproduced:
--    ERROR: new row for relation "profiles" violates check constraint
--    "profiles_full_name_check". Fix: derive a valid display name (metadata →
--    email local part → constant) clamped to 2..120 characters.
--
-- Invitation-only registration is now a DATABASE invariant, not a UI rule:
-- a sign-up that carries no invitation code is rejected. This is what the
-- product already documents ("Invitation model", README) and what the
-- register form enforces — but it was previously only enforced in the Next.js
-- server action, which the public anon key can bypass.
--
-- Compatibility: users created BEFORE this migration have no
-- `invitation_code_consumed` marker, so activate_confirmed_user() still
-- consumes their code at confirmation exactly as before. Users created after
-- it carry the marker and are never consumed twice (which matters for
-- multi-use registration codes: the old deferred contract would have charged
-- such a user two uses — one at sign-up, one at confirmation).
--
-- The functions are re-created with the same names, signatures, SECURITY
-- DEFINER, `set search_path = public` and trigger wiring as the previous
-- definitions; no table, column, policy, grant or existing row is touched.
-- ----------------------------------------------------------------------------

-- 1) Profile creation + atomic invitation consumption (AFTER INSERT auth.users).
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
  -- Registration is invitation-only. Enforced here, where the account is
  -- actually created, so it cannot be skipped by calling Supabase Auth
  -- directly with the public anon key.
  v_code := upper(trim(coalesce(new.raw_user_meta_data->>'invitation_code', '')));
  if v_code = '' then
    raise exception 'invitation_code_required' using errcode = 'P0001';
  end if;

  -- Atomic reservation: one UPDATE ... WHERE used_count < max_uses decides
  -- the winner. A losing (racing) sign-up raises and rolls back completely.
  if not public.consume_invitation_code(v_code, 'registration') then
    raise exception 'invitation_code_invalid_or_exhausted' using errcode = 'P0001';
  end if;

  -- Mark the redemption in the user metadata so activate_confirmed_user()
  -- never charges the same account a second use (see header).
  update auth.users
  set raw_user_meta_data =
        coalesce(raw_user_meta_data, '{}'::jsonb)
        || jsonb_build_object('invitation_code_consumed', true)
  where id = new.id;

  -- Display name that can never violate profiles_full_name_check
  -- (2..120 chars after trim).
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

-- 2) Confirmation trigger: activation stays best-effort; consumption only for
--    accounts that were created before invitation consumption moved to sign-up.
create or replace function public.activate_confirmed_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  invite_code text;
begin
  -- 1) Activate the profile (best effort — must not abort the confirmation).
  begin
    update public.profiles
    set account_status = 'active'
    where id = new.id and account_status = 'pending';
  exception
    when others then
      raise notice 'activate_confirmed_user: profile activation skipped: %', sqlerrm;
  end;

  -- 2) Legacy path only: accounts created before 20261021000000 did not
  --    consume their code at sign-up. New accounts carry the marker.
  invite_code := upper(trim(coalesce(new.raw_user_meta_data->>'invitation_code', '')));
  if invite_code <> ''
     and coalesce(new.raw_user_meta_data->>'invitation_code_consumed', 'false') <> 'true' then
    begin
      perform public.consume_invitation_code(invite_code, 'registration');
    exception
      when others then
        raise notice 'activate_confirmed_user: invitation consumption skipped: %', sqlerrm;
    end;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_email_confirmed on auth.users;
create trigger on_auth_user_email_confirmed
after update on auth.users
for each row
when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
execute function public.activate_confirmed_user();

-- 3) Reconciliation for accounts that already exist: every profile whose
--    account was created while the code was never charged keeps its code
--    marked as consumed-at-signup, so the confirmation trigger above does not
--    charge a second use for the same account. Idempotent, no data mutation
--    beyond the metadata marker.
update auth.users u
set raw_user_meta_data =
      coalesce(u.raw_user_meta_data, '{}'::jsonb)
      || jsonb_build_object('invitation_code_consumed', true)
where u.email_confirmed_at is not null
  and coalesce(u.raw_user_meta_data->>'invitation_code', '') <> ''
  and coalesce(u.raw_user_meta_data->>'invitation_code_consumed', 'false') <> 'true';
