-- ----------------------------------------------------------------------------
-- Hardened confirmation trigger.
--
-- The on_auth_user_email_confirmed trigger runs INSIDE GoTrue's confirmation
-- transaction (in PKCE mode that transaction is the code exchange that
-- creates the user's session). If anything in the trigger raises, the whole
-- confirmation rolls back: the email is never confirmed and the PKCE
-- exchange returns an error, so no session is ever created.
--
-- Therefore profile activation and invitation consumption are each wrapped
-- in their own exception block: they are best-effort side effects and must
-- never block the confirmation / session creation itself.
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
  -- 1) Activate the profile (best effort — must not abort the confirmation).
  begin
    update public.profiles
    set account_status = 'active'
    where id = new.id and account_status = 'pending';
  exception
    when others then
      raise notice 'activate_confirmed_user: profile activation skipped: %', sqlerrm;
  end;

  -- 2) Consume the registration invitation stored in the user metadata at
  --    sign-up (best effort — a failure here must not prevent the session).
  invite_code := trim(coalesce(new.raw_user_meta_data->>'invitation_code', ''));
  if invite_code <> '' then
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

-- The trigger itself is unchanged; only the function body was hardened.
-- (A failed invocation now logs a NOTICE instead of aborting the
-- confirmation transaction.)
