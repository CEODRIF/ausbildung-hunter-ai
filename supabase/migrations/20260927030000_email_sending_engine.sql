alter table public.daily_usage
  add column if not exists emails_reserved integer not null default 0 check (emails_reserved >= 0);

alter table public.email_accounts
  add column if not exists requires_reconnect boolean not null default false,
  add column if not exists reconnect_reason text;

create table public.user_quota_upgrades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code_id uuid not null references public.invitation_codes(id) on delete restrict,
  activated_at timestamptz not null default timezone('utc', now()),
  active boolean not null default true,
  unique (user_id, code_id)
);

create index user_quota_upgrades_user_idx on public.user_quota_upgrades(user_id);

create type public.email_campaign_status as enum ('draft', 'queued', 'sending', 'completed', 'partially_failed', 'failed', 'cancelled');
create type public.email_message_status as enum ('queued', 'sending', 'sent', 'failed', 'cancelled');

create table public.email_campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  draft_id uuid not null references public.application_drafts(id) on delete restrict,
  email_account_id uuid not null references public.email_accounts(id) on delete restrict,
  usage_date date not null default (timezone('utc', now()))::date,
  status public.email_campaign_status not null default 'draft',
  total_recipients integer not null default 0 check (total_recipients >= 0),
  queued_count integer not null default 0 check (queued_count >= 0),
  sending_count integer not null default 0 check (sending_count >= 0),
  sent_count integer not null default 0 check (sent_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  cancelled_count integer not null default 0 check (cancelled_count >= 0),
  reserved_count integer not null default 0 check (reserved_count >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  completed_at timestamptz
);

create table public.email_messages (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.email_campaigns(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  recipient_email text not null,
  company_name text,
  subject text not null,
  status public.email_message_status not null default 'queued',
  provider_message_id text,
  error_code text,
  error_message text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (campaign_id, recipient_email)
);

create index email_campaigns_user_id_idx on public.email_campaigns(user_id);
create index email_campaigns_status_idx on public.email_campaigns(status);
create index email_campaigns_created_at_idx on public.email_campaigns(created_at desc);
create index email_messages_campaign_id_idx on public.email_messages(campaign_id);
create index email_messages_user_id_idx on public.email_messages(user_id);
create index email_messages_status_idx on public.email_messages(status);
create index email_messages_created_at_idx on public.email_messages(created_at desc);
create index email_messages_retry_idx on public.email_messages(status, next_attempt_at);

create trigger email_messages_set_updated_at
before update on public.email_messages
for each row execute function public.set_updated_at();

alter table public.user_quota_upgrades enable row level security;
alter table public.email_campaigns enable row level security;
alter table public.email_messages enable row level security;

create policy "Users can read their own quota upgrades"
on public.user_quota_upgrades for select to authenticated using (auth.uid() = user_id);
create policy "Users can read their own campaigns"
on public.email_campaigns for select to authenticated using (auth.uid() = user_id);
create policy "Users can read their own messages"
on public.email_messages for select to authenticated using (auth.uid() = user_id);

revoke all on public.user_quota_upgrades from anon, authenticated;
revoke all on public.email_campaigns from anon, authenticated;
revoke all on public.email_messages from anon, authenticated;
grant select on public.user_quota_upgrades to authenticated;
grant select on public.email_campaigns to authenticated;
grant select on public.email_messages to authenticated;

do $$
begin
  update public.invitation_codes
  set max_uses = greatest(max_uses, 1000000), daily_email_limit = 100, is_active = true
  where code = 'DRIF089' and type = 'quota_upgrade';
end;
$$;

create or replace function public.effective_daily_email_limit(target_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  base_limit integer;
  upgrade_limit integer;
begin
  select daily_email_limit into base_limit from public.profiles where id = target_user_id;
  select max(ic.daily_email_limit) into upgrade_limit
  from public.user_quota_upgrades uqu
  join public.invitation_codes ic on ic.id = uqu.code_id
  where uqu.user_id = target_user_id and uqu.active = true and ic.is_active = true;
  return greatest(coalesce(base_limit, 50), coalesce(upgrade_limit, 0));
end;
$$;

create or replace function public.activate_quota_upgrade(target_user_id uuid, input_code text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  invitation public.invitation_codes%rowtype;
  activated_limit integer;
begin
  select * into invitation
  from public.invitation_codes
  where code = upper(trim(input_code)) and type = 'quota_upgrade' and is_active = true
  for update;
  if invitation.id is null or invitation.used_count >= invitation.max_uses then
    raise exception 'invalid_quota_code';
  end if;
  if exists (select 1 from public.user_quota_upgrades where user_id = target_user_id and code_id = invitation.id and active = true) then
    return coalesce(invitation.daily_email_limit, 100);
  end if;
  insert into public.user_quota_upgrades (user_id, code_id) values (target_user_id, invitation.id);
  update public.invitation_codes set used_count = used_count + 1 where id = invitation.id;
  activated_limit := coalesce(invitation.daily_email_limit, 100);
  return activated_limit;
end;
$$;

create or replace function public.get_daily_usage_snapshot(target_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  today public.daily_usage%rowtype;
  limit_value integer;
begin
  limit_value := public.effective_daily_email_limit(target_user_id);
  insert into public.daily_usage (user_id, date) values (target_user_id, (timezone('utc', now()))::date) on conflict (user_id, date) do nothing;
  select * into today from public.daily_usage where user_id = target_user_id and date = (timezone('utc', now()))::date;
  return jsonb_build_object('date', today.date, 'emails_sent', today.emails_sent, 'emails_reserved', today.emails_reserved, 'daily_limit', limit_value, 'remaining', greatest(limit_value - today.emails_sent - today.emails_reserved, 0));
end;
$$;

create or replace function public.reserve_email_capacity(target_user_id uuid, requested integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  today public.daily_usage%rowtype;
  limit_value integer;
  available integer;
begin
  if requested <= 0 or requested > 1000 then raise exception 'invalid_request_size'; end if;
  limit_value := public.effective_daily_email_limit(target_user_id);
  insert into public.daily_usage (user_id, date) values (target_user_id, (timezone('utc', now()))::date) on conflict (user_id, date) do nothing;
  select * into today from public.daily_usage where user_id = target_user_id and date = (timezone('utc', now()))::date for update;
  available := limit_value - today.emails_sent - today.emails_reserved;
  if requested > available then raise exception 'daily_quota_exceeded'; end if;
  update public.daily_usage set emails_reserved = emails_reserved + requested where id = today.id;
  return jsonb_build_object('date', today.date, 'daily_limit', limit_value, 'emails_sent', today.emails_sent, 'emails_reserved', today.emails_reserved + requested, 'remaining', available - requested);
end;
$$;

create or replace function public.release_email_capacity(target_user_id uuid, reservation_date date, released integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.daily_usage set emails_reserved = greatest(emails_reserved - greatest(released, 0), 0) where user_id = target_user_id and date = reservation_date;
end;
$$;

create or replace function public.claim_next_email_message(target_user_id uuid, target_campaign_id uuid)
returns public.email_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.email_messages%rowtype;
begin
  with candidate as (
    select m.id from public.email_messages m join public.email_campaigns c on c.id = m.campaign_id
    where m.user_id = target_user_id and m.campaign_id = target_campaign_id and m.status = 'queued' and (m.next_attempt_at is null or m.next_attempt_at <= timezone('utc', now())) and c.status in ('queued', 'sending')
    order by m.created_at for update skip locked limit 1
  )
  update public.email_messages m set status = 'sending', attempt_count = m.attempt_count + 1, updated_at = timezone('utc', now()) where m.id in (select id from candidate) returning m.* into claimed;
  if claimed.id is not null then
    update public.email_campaigns set status = 'sending', started_at = coalesce(started_at, timezone('utc', now())), queued_count = greatest(queued_count - 1, 0), sending_count = sending_count + 1 where id = target_campaign_id;
  end if;
  return claimed;
end;
$$;

create or replace function public.retry_email_message(target_message_id uuid, retry_code text, retry_message text, retry_after_seconds integer default 60)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated boolean;
  campaign_id_value uuid;
begin
  update public.email_messages set status = 'queued', error_code = retry_code, error_message = left(retry_message, 500), next_attempt_at = timezone('utc', now()) + make_interval(secs => greatest(retry_after_seconds, 1)) where id = target_message_id and status = 'sending' returning campaign_id into campaign_id_value;
  updated := campaign_id_value is not null;
  if updated then update public.email_campaigns set sending_count = greatest(sending_count - 1, 0), queued_count = queued_count + 1 where id = campaign_id_value; end if;
  return updated;
end;
$$;

create or replace function public.finalize_email_message(target_message_id uuid, succeeded boolean, provider_id text, failure_code text, failure_message text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  message_row public.email_messages%rowtype;
  campaign_row public.email_campaigns%rowtype;
  terminal_count integer;
  final_status public.email_campaign_status;
begin
  select * into message_row from public.email_messages where id = target_message_id for update;
  if message_row.id is null or message_row.status <> 'sending' then return false; end if;
  select * into campaign_row from public.email_campaigns where id = message_row.campaign_id for update;
  if succeeded then
    update public.email_messages set status = 'sent', provider_message_id = provider_id, sent_at = timezone('utc', now()), error_code = null, error_message = null where id = target_message_id;
    update public.email_campaigns set sending_count = greatest(sending_count - 1, 0), sent_count = sent_count + 1 where id = message_row.campaign_id;
    update public.daily_usage set emails_reserved = greatest(emails_reserved - 1, 0), emails_sent = emails_sent + 1 where user_id = message_row.user_id and date = campaign_row.usage_date;
  else
    update public.email_messages set status = 'failed', error_code = left(failure_code, 100), error_message = left(failure_message, 500) where id = target_message_id;
    update public.email_campaigns set sending_count = greatest(sending_count - 1, 0), failed_count = failed_count + 1 where id = message_row.campaign_id;
    update public.daily_usage set emails_reserved = greatest(emails_reserved - 1, 0) where user_id = message_row.user_id and date = campaign_row.usage_date;
  end if;
  select count(*) into terminal_count from public.email_messages where campaign_id = message_row.campaign_id and status in ('queued', 'sending');
  if terminal_count = 0 and campaign_row.status <> 'cancelled' then
    select case when failed_count + (case when succeeded then 0 else 1 end) = 0 then 'completed'::public.email_campaign_status else case when sent_count + (case when succeeded then 1 else 0 end) = 0 then 'failed'::public.email_campaign_status else 'partially_failed'::public.email_campaign_status end end into final_status from public.email_campaigns where id = message_row.campaign_id;
    update public.email_campaigns set status = final_status, completed_at = timezone('utc', now()), reserved_count = 0 where id = message_row.campaign_id;
  end if;
  return true;
end;
$$;

create or replace function public.cancel_queued_campaign(target_user_id uuid, target_campaign_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  campaign_row public.email_campaigns%rowtype;
  cancelled integer;
begin
  select * into campaign_row from public.email_campaigns where id = target_campaign_id and user_id = target_user_id for update;
  if campaign_row.id is null then return false; end if;
  update public.email_messages set status = 'cancelled', updated_at = timezone('utc', now()) where campaign_id = target_campaign_id and status = 'queued';
  get diagnostics cancelled = row_count;
  update public.email_campaigns set queued_count = greatest(queued_count - cancelled, 0), cancelled_count = cancelled_count + cancelled, status = case when sending_count = 0 then 'cancelled'::public.email_campaign_status else status end, completed_at = case when sending_count = 0 then timezone('utc', now()) else completed_at end where id = target_campaign_id;
  update public.daily_usage set emails_reserved = greatest(emails_reserved - cancelled, 0) where user_id = target_user_id and date = campaign_row.usage_date;
  return true;
end;
$$;

revoke all on function public.effective_daily_email_limit(uuid) from public, anon, authenticated;
revoke all on function public.activate_quota_upgrade(uuid, text) from public, anon, authenticated;
revoke all on function public.get_daily_usage_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.reserve_email_capacity(uuid, integer) from public, anon, authenticated;
revoke all on function public.release_email_capacity(uuid, date, integer) from public, anon, authenticated;
revoke all on function public.claim_next_email_message(uuid, uuid) from public, anon, authenticated;
revoke all on function public.retry_email_message(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.finalize_email_message(uuid, boolean, text, text, text) from public, anon, authenticated;
revoke all on function public.cancel_queued_campaign(uuid, uuid) from public, anon, authenticated;
grant execute on function public.effective_daily_email_limit(uuid) to service_role;
grant execute on function public.activate_quota_upgrade(uuid, text) to service_role;
grant execute on function public.get_daily_usage_snapshot(uuid) to service_role;
grant execute on function public.reserve_email_capacity(uuid, integer) to service_role;
grant execute on function public.release_email_capacity(uuid, date, integer) to service_role;
grant execute on function public.claim_next_email_message(uuid, uuid) to service_role;
grant execute on function public.retry_email_message(uuid, text, text, integer) to service_role;
grant execute on function public.finalize_email_message(uuid, boolean, text, text, text) to service_role;
grant execute on function public.cancel_queued_campaign(uuid, uuid) to service_role;
