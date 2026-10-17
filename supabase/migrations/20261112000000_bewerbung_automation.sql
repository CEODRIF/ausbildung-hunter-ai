-- Bewerbung Automation (AusbildungsWeg) — ISOLATED schema for the new
-- /bewerbung-automation feature.
--
-- WHY A SEPARATE SCHEMA (and not the existing email engine tables):
--   The existing send engine stores ONE letter body per CAMPAIGN
--   (`email_campaigns.body_html`) and every campaign row surfaces in the
--   protected Applications list. This feature needs ONE DISTINCT, editable
--   Anschreiben PER COMPANY inside a single, unified campaign. Reusing
--   `email_campaigns`/`email_messages` would either pollute the protected
--   Applications page or require modifying the protected worker — both are
--   forbidden. So the feature's letters/attachments live in their own
--   `bew_*` tables, while the SENDING reuses the existing safe primitives
--   (`createEmailProvider`, `reserve_sender_slot`, `reserve_email_capacity`,
--   `release_email_capacity`) and the shared `daily_usage` quota counter.
--
-- SAFETY CONTRACT (manual migration — this file is applied by hand):
--   * purely ADDITIVE: two new enums, four new tables, indexes, and three RPCs.
--   * NO shared table, column, enum value, RPC or storage bucket is altered
--     or dropped. The existing send engine, Email Verification and the
--     standard application feature are untouched by this file.
--   * every `bew_*` row is owner-scoped (`user_id`) and RLS-locked to
--     SELECT-only for the owner; all writes run with the service role.
--   * safe to re-run: guarded enum/policy creation, `if not exists`
--     tables/indexes, replaceable functions, and drop-guarded triggers —
--     EXCEPT the broken `updated_at` trigger on bew_campaigns, which is
--     dropped and NOT recreated (42703 regression, see below).
--
-- DEPLOY ORDER: apply this migration BEFORE deploying code that references
-- `bew_documents` in src/lib/storage-reconcile.ts (the storage janitor keeps
-- uploaded CVs/certificates alive through that reference). Code deployed
-- first degrades gracefully via the hasBewAutomationSchema() probe (the
-- feature shows a "schema pending" state instead of crashing).
--
-- REVERSIBILITY: drop the three RPCs, four `bew_*` tables, and two enums.
-- No shared table, function, or storage bucket is dropped.

-- PostgreSQL has NO `CREATE TYPE IF NOT EXISTS` (unlike CREATE TABLE — it is
-- a syntax error, 42601). Guard with pg_type instead: idempotent, and the
-- enum values below are the fixed contract used by the engine.
do $$
begin
  if not exists (
    select 1 from pg_type
    where typname = 'bew_campaign_status'
      and typnamespace = 'public'::regnamespace
  ) then
    create type public.bew_campaign_status as enum (
      'draft', 'generating', 'sending', 'completed', 'partially_failed', 'cancelled'
    );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_type
    where typname = 'bew_app_status'
      and typnamespace = 'public'::regnamespace
  ) then
    create type public.bew_app_status as enum (
      'pending', 'generating', 'generated', 'excluded',
      'queued', 'sending', 'sent', 'failed', 'needs_attention', 'cancelled'
    );
  end if;
end
$$;

-- One automation run ("campaign"): the user's batch of 1..100 applications
-- prepared for a day. Owns the counter set and the quota usage_date.
create table if not exists public.bew_campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The connected Gmail/Outlook account that will send. Nullable: the user
  -- may prepare a campaign before (re)connecting. NULL means "authorization
  -- required" and no send is possible until it is set.
  email_account_id uuid references public.email_accounts(id) on delete set null,
  -- What the batch is for: 'ausbildung' | 'arbeit' | 'praktikum'. Drives the
  -- deterministic subject and the generation prompt (validated in TS).
  purpose text not null default 'ausbildung' check (purpose in ('ausbildung', 'arbeit', 'praktikum')),
  status public.bew_campaign_status not null default 'draft',
  -- The requested campaign size (1..100). A display/plan value and NOT a
  -- permission to exceed the effective daily quota.
  requested_count integer not null default 0 check (requested_count between 0 and 100),
  -- How many applications actually carry a company + recipient (valid rows).
  valid_count integer not null default 0 check (valid_count >= 0),
  total_count integer not null default 0 check (total_count >= 0),
  generated_count integer not null default 0 check (generated_count >= 0),
  sent_count integer not null default 0 check (sent_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  excluded_count integer not null default 0 check (excluded_count >= 0),
  -- The UTC day the quota reservation belongs to (mirrors email_campaigns).
  usage_date date not null default (timezone('utc', now()))::date,
  created_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  completed_at timestamptz
);

create index if not exists bew_campaigns_user_id_idx on public.bew_campaigns(user_id);
create index if not exists bew_campaigns_status_idx on public.bew_campaigns(status);
create index if not exists bew_campaigns_created_at_idx on public.bew_campaigns(created_at desc);

-- REGRESSION (42703): a previous revision of this migration attached the
-- shared set_updated_at() trigger to bew_campaigns — but this table has NO
-- updated_at column (only created_at / started_at / completed_at), so the
-- trigger made EVERY UPDATE fail with
--   column "updated_at" of relation "bew_campaigns" does not exist.
-- The application layer did not check the update errors, so the failure was
-- silent: most visibly the valid_count written after a company import never
-- landed, the wizard's step-2 gate stayed locked, and the user saw no way to
-- leave the Companies step. The trigger is therefore dropped (idempotently —
-- a rerun heals an already-broken database) and must NOT be recreated here.
-- bew_applications keeps its trigger (that table DOES have updated_at).
drop trigger if exists bew_campaigns_set_updated_at on public.bew_campaigns;

-- One row PER company = the work item. Carries its OWN Anschreiben
-- (body_html/body_text) — this is what makes "one distinct letter per
-- company" possible without touching the protected engine.
create table if not exists public.bew_applications (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.bew_campaigns(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- 1-based position in the campaign (stable ordering for the review table).
  seq integer not null check (seq >= 1),
  company_name text not null default '',
  contact_name text,
  company_email text not null,
  company_address text,
  subject text not null default '',
  -- The generated (and user-editable) Anschreiben for THIS company only.
  body_html text not null default '',
  body_text text not null default '',
  status public.bew_app_status not null default 'pending',
  error_code text,
  error_message text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz,
  -- Captured from the provider on success (idempotency / audit).
  provider_message_id text,
  sent_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (campaign_id, seq)
);

create index if not exists bew_applications_campaign_id_idx on public.bew_applications(campaign_id);
create index if not exists bew_applications_user_id_idx on public.bew_applications(user_id);
create index if not exists bew_applications_status_idx on public.bew_applications(status);
create index if not exists bew_applications_send_idx on public.bew_applications(status, next_attempt_at);

drop trigger if exists bew_applications_set_updated_at on public.bew_applications;
create trigger bew_applications_set_updated_at
  before update on public.bew_applications
  for each row execute function public.set_updated_at();

-- User-level document library (uploaded ONCE, reused across campaigns).
-- Objects live in the EXISTING private `application-attachments` bucket so
-- the unmodified send path (`fetchAttachmentContents`) can read them.
create table if not exists public.bew_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null unique,
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  kind text not null default 'certificate' check (kind in ('cv', 'certificate', 'supporting')),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists bew_documents_user_id_idx on public.bew_documents(user_id);

-- The campaign's attachment SET (shared by every application in the
-- campaign). Denormalizes the document fields so the send path can build
-- the provider attachment list without a join.
create table if not exists public.bew_campaign_documents (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.bew_campaigns(id) on delete cascade,
  document_id uuid not null references public.bew_documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('cv', 'certificate', 'supporting')),
  storage_path text not null,
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  created_at timestamptz not null default timezone('utc', now()),
  unique (campaign_id, document_id)
);

create index if not exists bew_campaign_documents_campaign_id_idx on public.bew_campaign_documents(campaign_id);

-- --------------------------------------------------------------------------
-- RLS: owner SELECT only; every write is service-role.
-- --------------------------------------------------------------------------
alter table public.bew_campaigns enable row level security;
alter table public.bew_applications enable row level security;
alter table public.bew_documents enable row level security;
alter table public.bew_campaign_documents enable row level security;

-- CREATE POLICY has no IF NOT EXISTS in PostgreSQL; the drop-then-create
-- pair keeps a rerun of this migration idempotent (drop only ever targets
-- the four policies declared in this file — no shared object is touched).
drop policy if exists "Users can read their own automation campaigns" on public.bew_campaigns;
create policy "Users can read their own automation campaigns"
  on public.bew_campaigns for select to authenticated using (auth.uid() = user_id);
drop policy if exists "Users can read their own automation applications" on public.bew_applications;
create policy "Users can read their own automation applications"
  on public.bew_applications for select to authenticated using (auth.uid() = user_id);
drop policy if exists "Users can read their own automation documents" on public.bew_documents;
create policy "Users can read their own automation documents"
  on public.bew_documents for select to authenticated using (auth.uid() = user_id);
drop policy if exists "Users can read their own automation campaign documents" on public.bew_campaign_documents;
create policy "Users can read their own automation campaign documents"
  on public.bew_campaign_documents for select to authenticated using (auth.uid() = user_id);

revoke all on public.bew_campaigns from anon, authenticated;
revoke all on public.bew_applications from anon, authenticated;
revoke all on public.bew_documents from anon, authenticated;
revoke all on public.bew_campaign_documents from anon, authenticated;
grant select on public.bew_campaigns to authenticated;
grant select on public.bew_applications to authenticated;
grant select on public.bew_documents to authenticated;
grant select on public.bew_campaign_documents to authenticated;

-- --------------------------------------------------------------------------
-- RPC 1 — atomic per-application claim (the durable idempotency core).
--
-- Mirrors public.claim_next_email_message: FOR UPDATE SKIP LOCKED guarantees
-- a queued application is claimed by AT MOST ONE worker at a time, so two
-- overlapping drains (browser + cron + worker) can never double-send. Only
-- `queued` + due applications of a non-terminal campaign are claimable.
-- --------------------------------------------------------------------------
create or replace function public.claim_next_bew_application(
  target_user_id uuid,
  target_campaign_id uuid
)
returns public.bew_applications
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.bew_applications%rowtype;
begin
  with candidate as (
    select a.id
    from public.bew_applications a
    join public.bew_campaigns c on c.id = a.campaign_id
    where a.user_id = target_user_id
      and a.campaign_id = target_campaign_id
      and a.status = 'queued'
      and (a.next_attempt_at is null or a.next_attempt_at <= timezone('utc', now()))
      and c.status in ('sending')
    order by a.seq
    for update skip locked
    limit 1
  )
  update public.bew_applications a
     set status = 'sending',
         attempt_count = a.attempt_count + 1,
         updated_at = timezone('utc', now())
   where a.id in (select id from candidate)
   returning a.* into claimed;

  if claimed.id is not null then
    update public.bew_campaigns
       set status = 'sending',
           started_at = coalesce(started_at, timezone('utc', now()))
     where id = target_campaign_id;
  end if;

  return claimed;
end;
$$;

-- --------------------------------------------------------------------------
-- RPC 2 — record a successful automation send against the SHARED daily
-- quota. Mirrors the success branch of public.finalize_email_message exactly
-- (reserved -1, sent +1 on the campaign's usage_date). This is what makes a
-- real automation send count against the user's platform daily limit.
-- --------------------------------------------------------------------------
create or replace function public.bew_record_email_sent(
  target_user_id uuid,
  reservation_date date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.daily_usage
     set emails_reserved = greatest(emails_reserved - 1, 0),
         emails_sent = emails_sent + 1
   where user_id = target_user_id and date = reservation_date;
end;
$$;

-- --------------------------------------------------------------------------
-- RPC 3 — cancel all still-queued applications of a campaign and release
-- their reserved quota in one transaction (mirrors cancel_queued_campaign).
-- --------------------------------------------------------------------------
create or replace function public.bew_cancel_queued(
  target_user_id uuid,
  target_campaign_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  campaign_row public.bew_campaigns%rowtype;
  cancelled integer;
begin
  select * into campaign_row
    from public.bew_campaigns
   where id = target_campaign_id and user_id = target_user_id
   for update;
  if campaign_row.id is null then return 0; end if;

  -- Cancel every still-queued application (in-flight `sending` rows are
  -- left to the worker to finalize — they are never silently dropped).
  update public.bew_applications
     set status = 'cancelled', updated_at = timezone('utc', now())
   where campaign_id = target_campaign_id and status = 'queued';
  get diagnostics cancelled = row_count;

  update public.bew_campaigns
     set status = case
             when (select count(*) from public.bew_applications
                   where campaign_id = target_campaign_id and status = 'sending') = 0
             then 'cancelled'::public.bew_campaign_status
             else status
           end,
         completed_at = case
             when (select count(*) from public.bew_applications
                   where campaign_id = target_campaign_id and status = 'sending') = 0
             then timezone('utc', now()) else completed_at
           end
   where id = target_campaign_id;

  -- Release the reserved quota for the cancelled (not-yet-sent) applications.
  if cancelled > 0 then
    update public.daily_usage
       set emails_reserved = greatest(emails_reserved - cancelled, 0)
     where user_id = target_user_id and date = campaign_row.usage_date;
  end if;

  return cancelled;
end;
$$;

revoke all on function public.claim_next_bew_application(uuid, uuid) from public, anon, authenticated;
revoke all on function public.bew_record_email_sent(uuid, date) from public, anon, authenticated;
revoke all on function public.bew_cancel_queued(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_next_bew_application(uuid, uuid) to service_role;
grant execute on function public.bew_record_email_sent(uuid, date) to service_role;
grant execute on function public.bew_cancel_queued(uuid, uuid) to service_role;
