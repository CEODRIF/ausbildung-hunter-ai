create type public.bewerbung_scan_goal as enum ('ausbildung', 'arbeit');
create type public.bewerbung_scan_status as enum ('uploading', 'analyzing', 'completed', 'failed');

create table public.bewerbung_scans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal public.bewerbung_scan_goal not null,
  status public.bewerbung_scan_status not null default 'uploading',
  created_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  error_message text
);

create index bewerbung_scans_user_created_idx on public.bewerbung_scans(user_id, created_at desc);

create table public.candidate_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  scan_id uuid not null unique references public.bewerbung_scans(id) on delete cascade,
  profile_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index candidate_profiles_user_idx on public.candidate_profiles(user_id);

create table public.bewerbung_scan_files (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.bewerbung_scans(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  storage_file_id uuid not null references public.ai_file_uploads(id) on delete restrict,
  filename text not null,
  mime_type text not null,
  created_at timestamptz not null default timezone('utc', now())
);

create index bewerbung_scan_files_scan_idx on public.bewerbung_scan_files(scan_id);
create index bewerbung_scan_files_user_idx on public.bewerbung_scan_files(user_id);

create trigger candidate_profiles_set_updated_at
before update on public.candidate_profiles
for each row execute function public.set_updated_at();

alter table public.bewerbung_scans enable row level security;
alter table public.candidate_profiles enable row level security;
alter table public.bewerbung_scan_files enable row level security;

create policy "Users can manage their own Bewerbung scans"
on public.bewerbung_scans for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "Users can manage their own candidate profiles"
on public.candidate_profiles for all to authenticated
using (auth.uid() = user_id and exists (select 1 from public.bewerbung_scans s where s.id = scan_id and s.user_id = auth.uid()))
with check (auth.uid() = user_id and exists (select 1 from public.bewerbung_scans s where s.id = scan_id and s.user_id = auth.uid()));

create policy "Users can manage their own scan files"
on public.bewerbung_scan_files for all to authenticated
using (auth.uid() = user_id and exists (select 1 from public.bewerbung_scans s where s.id = scan_id and s.user_id = auth.uid()))
with check (auth.uid() = user_id and exists (select 1 from public.bewerbung_scans s where s.id = scan_id and s.user_id = auth.uid()));
