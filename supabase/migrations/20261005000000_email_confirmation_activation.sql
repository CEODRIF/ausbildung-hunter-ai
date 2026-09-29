-- ----------------------------------------------------------------------------
-- Email-confirmation activation (replaces the 6-digit verification code flow).
--
-- Users are now created through the standard Supabase Auth sign-up, which
-- sends the confirmation email itself. When the user clicks the link and
-- GoTrue confirms the email, `auth.users.email_confirmed_at` flips from
-- null to a timestamp. The trigger below then:
--   1. activates the profile (pending -> active) so the onboarding gate
--      passes, and
--   2. consumes the registration invitation code that was stored in the
--      user metadata at sign-up (the invitation system is unchanged).
--
-- The verification_codes table, its indexes, and create_verification_code /
-- verify_account_code are intentionally NOT dropped: existing rows and the
-- migration history are preserved; the application simply no longer uses
-- them. A later migration may archive/remove them if desired.
-- ----------------------------------------------------------------------------

create or replace function public.activate_confirmed_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  invite_code text;
begin
  -- The profile is created by handle_new_user() at sign-up time; activate it.
  update public.profiles
  set account_status = 'active'
  where id = new.id and account_status = 'pending';

  invite_code := trim(coalesce(new.raw_user_meta_data->>'invitation_code', ''));
  if invite_code <> '' then
    perform public.consume_invitation_code(invite_code, 'registration');
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

-- One-time backfill: users created under the previous flow (admin-created
-- with email already confirmed, profile stuck at 'pending') are already
-- email-verified — activate them so they can continue to onboarding.
update public.profiles p
set account_status = 'active'
from auth.users u
where p.id = u.id
  and p.account_status = 'pending'
  and u.email_confirmed_at is not null;
