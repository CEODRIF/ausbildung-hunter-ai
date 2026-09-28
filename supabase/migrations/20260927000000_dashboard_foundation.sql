create table public.applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  company_name text,
  status text not null default 'draft' check (status in ('draft', 'in_progress', 'submitted', 'withdrawn', 'closed')),
  created_at timestamptz not null default timezone('utc', now())
);

create index applications_user_id_idx on public.applications(user_id);

create table public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_type text not null check (char_length(trim(activity_type)) between 1 and 80),
  title text not null check (char_length(trim(title)) between 1 and 160),
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index activity_logs_user_created_idx on public.activity_logs(user_id, created_at desc);

create table public.daily_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null default (timezone('utc', now()))::date,
  emails_sent integer not null default 0 check (emails_sent >= 0),
  ai_requests integer not null default 0 check (ai_requests >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, date)
);

create index daily_usage_user_date_idx on public.daily_usage(user_id, date desc);

create trigger daily_usage_set_updated_at
before update on public.daily_usage
for each row execute function public.set_updated_at();

alter table public.applications enable row level security;
alter table public.activity_logs enable row level security;
alter table public.daily_usage enable row level security;

create policy "Users can read their own applications"
on public.applications for select to authenticated using (auth.uid() = user_id);

create policy "Users can read their own activity logs"
on public.activity_logs for select to authenticated using (auth.uid() = user_id);

create policy "Users can read their own daily usage"
on public.daily_usage for select to authenticated using (auth.uid() = user_id);

create or replace function public.get_or_create_daily_usage()
returns public.daily_usage
language plpgsql
security definer
set search_path = public
as $$
declare
  current_usage public.daily_usage;
  current_user_id uuid := auth.uid();
  current_date_utc date := (timezone('utc', now()))::date;
begin
  if current_user_id is null then
    raise exception 'not_authenticated';
  end if;

  insert into public.daily_usage (user_id, date)
  values (current_user_id, current_date_utc)
  on conflict (user_id, date) do nothing;

  select * into current_usage
  from public.daily_usage
  where user_id = current_user_id and date = current_date_utc;

  return current_usage;
end;
$$;

revoke all on public.applications from anon, authenticated;
revoke all on public.activity_logs from anon, authenticated;
revoke all on public.daily_usage from anon, authenticated;
revoke all on function public.get_or_create_daily_usage() from public, anon;
grant select on public.applications to authenticated;
grant select on public.activity_logs to authenticated;
grant select on public.daily_usage to authenticated;
grant execute on function public.get_or_create_daily_usage() to authenticated;
