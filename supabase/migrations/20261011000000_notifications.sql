-- Phase 11: in-app notifications (global platform updates + targeted owner
-- messages).
--
-- Design notes:
--   * ONE table, two target modes:
--       target_type = 'all'  → platform update, visible to every user
--       target_type = 'user' → visible to exactly target_user_id (nullable)
--   * IN-APP ONLY: nothing here triggers email/SMS/push.
--   * Writes happen ONLY from the admin service layer (service role); the
--     UI never gets write access. RLS gives each user SELECT on rows that
--     concern them (all-global + their own targeted) as defense in depth.
--   * `send_key` is a client-generated UUID used as an idempotency guard:
--     double-clicks / network retries with the same key cannot create
--     duplicate notifications (unique constraint, server resolves the
--     conflict by returning the original row).
--   * Read state is per (notification, user) in notification_reads —
--     global notifications get an individual receipt per user, so "read"
--     never leaks between users.

create type public.notification_type as enum
  ('info', 'important', 'maintenance', 'improvement');

create type public.notification_target_type as enum ('all', 'user');

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 3 and 120),
  content text not null check (char_length(content) between 3 and 2000),
  type public.notification_type not null default 'info',
  target_type public.notification_target_type not null default 'user',
  target_user_id uuid references auth.users(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  -- Idempotency: one send per key. NULL allowed only for legacy rows; the
  -- admin layer always provides a key.
  send_key uuid unique,
  created_at timestamptz not null default timezone('utc', now()),
  constraint notifications_target_consistency check (
    (target_type = 'all' and target_user_id is null)
    or (target_type = 'user' and target_user_id is not null)
  )
);

create index notifications_target_user_idx
  on public.notifications (target_user_id, created_at desc);
create index notifications_creator_idx
  on public.notifications (created_by, created_at desc);
create index notifications_global_idx
  on public.notifications (created_at desc) where target_type = 'all';

alter table public.notifications enable row level security;

-- Users may read exactly what concerns them: every global notification and
-- the notifications targeted at them. No user policy for insert/update/
-- delete — the service-role admin layer is the only writer.
create policy "Users can read their own notifications"
  on public.notifications for select
  to authenticated
  using (target_type = 'all' or target_user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Read receipts (per user, per notification)
-- ---------------------------------------------------------------------------

create table public.notification_reads (
  notification_id uuid not null references public.notifications(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default timezone('utc', now()),
  primary key (notification_id, user_id)
);

alter table public.notification_reads enable row level security;

create policy "Users can read their own read receipts"
  on public.notification_reads for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users can record their own read receipts"
  on public.notification_reads for insert
  to authenticated
  with check (user_id = auth.uid());
