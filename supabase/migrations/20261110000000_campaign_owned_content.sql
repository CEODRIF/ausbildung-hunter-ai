-- Campaign-owned application content (removal of the Drafts feature).
--
-- After this migration an email_campaign is SELF-CONTAINED: it carries its
-- own subject, body template and goal, owns its attachment metadata, and may
-- exist without any application_draft (draft_id becomes nullable).
--
-- Safety contract (manual migration — this file is applied by hand):
--   * purely ADDITIVE: three new nullable-by-default columns, one widened
--     constraint (NOT NULL removed), one new table, one index;
--   * NO shared table, column, enum value or storage bucket is dropped;
--   * existing draft rows, recipient rows, attachment rows, campaigns and
--     messages are NEVER deleted or rewritten except the backfill below,
--     which only copies subject/body/goal FROM the (still-existing) draft
--     INTO the campaign row so historical campaigns keep working;
--   * idempotent: every statement uses `if not exists` / is safely
--     re-runnable (the backfill is a no-op on a second run because the
--     campaign columns already match the draft).
--
-- Reversibility: dropping the new columns/table and re-adding
-- `draft_id not null` (backfilled from the historical draft reference)
-- restores the previous schema — no data is lost either way.

alter table public.email_campaigns
  add column if not exists subject text not null default '',
  add column if not exists body_html text not null default '',
  add column if not exists goal public.application_goal not null default 'ausbildung';

-- Legacy campaigns keep working: rows created before this migration still
-- reference their draft (ON DELETE RESTRICT — the draft cannot disappear
-- while a campaign points at it). New, draft-free campaigns leave draft_id
-- NULL. Widening a constraint is safe and never touches existing rows.
alter table public.email_campaigns
  alter column draft_id drop not null;

-- Attachments a campaign sends. The objects live in the existing
-- `application-attachments` bucket (kept — it is shared with the legacy
-- draft attachments and the storage policies are per user-prefix).
-- `storage_path` is unique: one object is referenced by at most one campaign
-- (each composer upload creates a fresh, random path).
create table if not exists public.email_campaign_attachments (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.email_campaigns(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null unique,
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists email_campaign_attachments_campaign_id_idx
  on public.email_campaign_attachments(campaign_id);

alter table public.email_campaign_attachments enable row level security;

-- Same access shape as email_campaigns itself: users may read their own
-- rows; every write path runs with the service role (bypasses RLS).
create policy "Users can read their own campaign attachments"
  on public.email_campaign_attachments for select to authenticated
  using (auth.uid() = user_id);

revoke all on public.email_campaign_attachments from anon, authenticated;
grant select on public.email_campaign_attachments to authenticated;

-- Backfill: make every EXISTING campaign self-contained from its draft.
-- Reads only — the drafts themselves remain untouched and are never deleted
-- by this migration. Campaigns whose draft is missing (corrupt historical
-- data) keep the empty defaults and fall back to "Untitled application".
update public.email_campaigns c
set subject   = d.subject,
    body_html = d.body_html,
    goal      = d.goal
from public.application_drafts d
where c.draft_id is not null
  and c.draft_id = d.id;
