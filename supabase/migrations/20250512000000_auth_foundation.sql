create extension if not exists pgcrypto;

create type public.account_status as enum ('pending', 'active', 'suspended');
create type public.goal_type as enum ('ausbildung', 'arbeit');
create type public.invitation_code_type as enum ('registration', 'quota_upgrade');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null check (char_length(trim(full_name)) between 2 and 120),
  email text not null,
  account_status public.account_status not null default 'pending',
  selected_goal public.goal_type,
  daily_email_limit integer not null default 50 check (daily_email_limit between 0 and 10000),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.invitation_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code = upper(code) and code ~ '^[A-Z0-9]{6,32}$'),
  type public.invitation_code_type not null,
  daily_email_limit integer check (daily_email_limit is null or daily_email_limit between 0 and 10000),
  is_active boolean not null default true,
  max_uses integer not null default 1 check (max_uses > 0),
  used_count integer not null default 0 check (used_count >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  constraint invitation_code_uses_valid check (used_count <= max_uses)
);

create table public.verification_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts > 0),
  used_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index verification_codes_user_id_idx on public.verification_codes(user_id);
create index verification_codes_active_idx on public.verification_codes(user_id, used_at, expires_at);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create or replace function public.validate_invitation_code(invitation_code text, invitation_type public.invitation_code_type)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return exists (
    select 1 from public.invitation_codes
    where code = upper(trim(invitation_code))
      and type = invitation_type
      and is_active = true
      and used_count < max_uses
  );
end;
$$;

create or replace function public.consume_invitation_code(invitation_code text, invitation_type public.invitation_code_type)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  consumed boolean;
begin
  update public.invitation_codes
  set used_count = used_count + 1
  where code = upper(trim(invitation_code))
    and type = invitation_type
    and is_active = true
    and used_count < max_uses
  returning true into consumed;
  return coalesce(consumed, false);
end;
$$;

create or replace function public.create_verification_code(target_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  raw_code text;
begin
  if exists (
    select 1 from public.verification_codes
    where user_id = target_user_id
      and created_at > timezone('utc', now()) - interval '60 seconds'
  ) then
    raise exception 'verification_rate_limited';
  end if;

  raw_code := lpad(floor(random() * 1000000)::text, 6, '0');
  update public.verification_codes
  set used_at = timezone('utc', now())
  where user_id = target_user_id and used_at is null;

  insert into public.verification_codes (user_id, code_hash, expires_at)
  values (target_user_id, crypt(raw_code, gen_salt('bf')), timezone('utc', now()) + interval '10 minutes');
  return raw_code;
end;
$$;

create or replace function public.verify_account_code(target_user_id uuid, submitted_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  verification public.verification_codes%rowtype;
  verified boolean := false;
begin
  select * into verification
  from public.verification_codes
  where user_id = target_user_id and used_at is null
  order by created_at desc limit 1
  for update;

  if verification.id is null or verification.expires_at <= timezone('utc', now()) or verification.attempts >= verification.max_attempts then
    return false;
  end if;

  update public.verification_codes set attempts = attempts + 1 where id = verification.id;
  if verification.code_hash = crypt(trim(submitted_code), verification.code_hash) then
    update public.verification_codes set used_at = timezone('utc', now()) where id = verification.id;
    update public.profiles set account_status = 'active' where id = target_user_id;
    verified := true;
  end if;
  return verified;
end;
$$;

alter table public.profiles enable row level security;
alter table public.invitation_codes enable row level security;
alter table public.verification_codes enable row level security;

create policy "Users can read their own profile"
on public.profiles for select to authenticated using (auth.uid() = id);

create policy "Users can update their own onboarding fields"
on public.profiles for update to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

revoke all on public.invitation_codes from anon, authenticated;
revoke all on public.verification_codes from anon, authenticated;
revoke all on function public.validate_invitation_code(text, public.invitation_code_type) from public, anon, authenticated;
revoke all on function public.consume_invitation_code(text, public.invitation_code_type) from public, anon, authenticated;
revoke all on function public.create_verification_code(uuid) from public, anon, authenticated;
revoke all on function public.verify_account_code(uuid, text) from public, anon, authenticated;
grant execute on function public.validate_invitation_code(text, public.invitation_code_type) to service_role;
grant execute on function public.consume_invitation_code(text, public.invitation_code_type) to service_role;
grant execute on function public.create_verification_code(uuid) to service_role;
grant execute on function public.verify_account_code(uuid, text) to service_role;

create or replace function public.protect_profile_system_fields()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.role() = 'authenticated' then
    new.id = old.id;
    new.account_status = old.account_status;
    new.daily_email_limit = old.daily_email_limit;
    new.full_name = old.full_name;
    new.email = old.email;
    new.created_at = old.created_at;
  end if;
  return new;
end;
$$;

create trigger profiles_protect_system_fields
before update on public.profiles
for each row execute function public.protect_profile_system_fields();

insert into public.invitation_codes (code, type, is_active, max_uses, daily_email_limit)
values
  ('DRIF928', 'registration', true, 1, 50),
  ('DRIF089', 'quota_upgrade', true, 1, 100)
on conflict (code) do update set is_active = excluded.is_active;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();
