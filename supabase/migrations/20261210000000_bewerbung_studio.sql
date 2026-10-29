-- AI Bewerbung Studio (/bewerbung-studio) — ISOLATED schema for the unified
-- single-application workflow.
--
-- WHY A SEPARATE SCHEMA:
--   The existing send engines (email_campaigns/email_messages, bew_*) model
--   BATCH campaigns (one letter per company, up to 100 recipients). The Studio
--   is the opposite: ONE application to ONE company with a job-specific CV,
--   cover letter, own attachments and its own email. Reusing the campaign
--   tables would either pollute the Applications list or force changes to the
--   protected worker. So Studio state lives in its own `studio_*` tables while
--   SENDING reuses the existing safe primitives (createEmailProvider,
--   application-attachments bucket) and the shared audit trail (activity_logs).
--
-- SAFETY CONTRACT (manual migration — this file is applied by hand):
--   * purely ADDITIVE: three new enums, four new tables, indexes, triggers and
--     two RPCs. NO existing table, column, enum value, RPC or storage bucket
--     is altered or dropped.
--   * every studio_* row is owner-scoped (user_id) and RLS-locked to
--     SELECT-only for the owner; all writes run with the service role
--     (identical contract to bew_*).
--   * safe to re-run: pg_type-guarded enums, `if not exists` tables/indexes,
--     replaceable functions, drop-guarded triggers and policies.
--
-- DEPLOY ORDER: apply this migration BEFORE deploying code that references
-- studio_applications. Code deployed first degrades gracefully via the
-- hasStudioSchema() probe ("setup pending" state instead of crashing).
--
-- REVERSIBILITY: drop the two RPCs, four studio_* tables and three enums.
-- No shared table, function, or storage bucket is dropped.

-- PostgreSQL has NO `CREATE TYPE IF NOT EXISTS` (42601). Guard with pg_type.
do $$
begin
  if not exists (
    select 1 from pg_type
    where typname = 'studio_app_status'
      and typnamespace = 'public'::regnamespace
  ) then
    create type public.studio_app_status as enum (
      'draft', 'ready', 'scheduled', 'sending', 'sent', 'failed', 'cancelled'
    );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_type
    where typname = 'studio_doc_type'
      and typnamespace = 'public'::regnamespace
  ) then
    create type public.studio_doc_type as enum (
      'cv', 'cover_letter', 'email'
    );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_type
    where typname = 'studio_send_status'
      and typnamespace = 'public'::regnamespace
  ) then
    create type public.studio_send_status as enum (
      'queued', 'sending', 'sent', 'failed', 'cancelled'
    );
  end if;
end
$$;

-- One Studio application = one target job (advertisement snapshot + state).
create table if not exists public.studio_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The pasted advertisement text (untrusted input; prompt-quoted).
  ad_raw text not null check (char_length(ad_raw) between 1 and 30000),
  -- Structured, validated extraction (AdExtract jsonb; null until analysed).
  ad_extracted jsonb,
  -- Requirements + profile match report (AdAnalysis jsonb).
  ad_analysis jsonb,
  -- The candidate facts used for generation (profile + CV snapshot) so later
  -- regeneration/review stays consistent even if the profile changes.
  profile_snapshot jsonb,
  status public.studio_app_status not null default 'draft',
  -- The connected Gmail/Outlook account that will send. Nullable: the user
  -- may prepare everything before (re)connecting. NULL = authorization
  -- required, no send possible until set.
  email_account_id uuid references public.email_accounts(id) on delete set null,
  recipient_email text,
  -- Set when a send attempt is created; unique so a duplicate dispatch can
  -- never be created for the same logical send (idempotency anchor).
  idempotency_key uuid unique,
  approved boolean not null default false,
  approved_at timestamptz,
  -- Durable scheduling (explicit timezone, displayed to the user).
  scheduled_at timestamptz,
  schedule_timezone text,
  sent_at timestamptz,
  provider_message_id text,
  last_failure_code text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists studio_applications_user_id_idx
  on public.studio_applications(user_id);
create index if not exists studio_applications_status_idx
  on public.studio_applications(status);
create index if not exists studio_applications_user_created_idx
  on public.studio_applications(user_id, created_at desc);

-- Versioned generated documents (job-specific CV / cover letter / email).
create table if not exists public.studio_documents (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.studio_applications(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  doc_type public.studio_doc_type not null,
  version integer not null default 1 check (version > 0),
  content jsonb not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (application_id, doc_type, version)
);

create index if not exists studio_documents_user_id_idx
  on public.studio_documents(user_id);
create index if not exists studio_documents_application_idx
  on public.studio_documents(application_id, doc_type, version desc);

-- Supporting documents (certificates, references). Files live in the
-- EXISTING private bucket `application-attachments` (10 MB, pdf/doc/docx/
-- png/jpeg) — no new bucket. storage_path is the bucket object path.
create table if not exists public.studio_attachments (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.studio_applications(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 1 and 255),
  -- school_certificate | professional_qualification | language_certificate |
  -- reference | other (validated in TS; free text here for forward-compat)
  doc_category text not null default 'other',
  mime_type text not null,
  size_bytes integer not null default 0 check (size_bytes >= 0),
  storage_path text not null,
  -- true when the advertisement explicitly requests this document type.
  required boolean not null default false,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists studio_attachments_user_id_idx
  on public.studio_attachments(user_id);
create index if not exists studio_attachments_application_idx
  on public.studio_attachments(application_id);

-- Durable dispatch state. ONE row per logical send; status transitions are
-- claimed atomically by the scheduler RPC (FOR UPDATE SKIP LOCKED).
create table if not exists public.studio_send_attempts (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.studio_applications(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key uuid not null unique,
  recipient_email text not null check (char_length(trim(recipient_email)) between 3 and 320),
  subject text not null check (char_length(trim(subject)) between 1 and 200),
  -- { html, text, attachments: [{filename, mimeType, storagePath}] }
  payload jsonb not null,
  status public.studio_send_status not null default 'queued',
  -- NULL = send immediately; non-null = durable scheduled dispatch (UTC).
  scheduled_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  -- Retry backoff target; null while not due.
  next_attempt_at timestamptz,
  provider_message_id text,
  failure_code text,
  failure_message text,
  sent_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists studio_send_attempts_user_id_idx
  on public.studio_send_attempts(user_id);
-- Scheduler hot path: due queued attempts only.
create index if not exists studio_send_attempts_claim_idx
  on public.studio_send_attempts(status, coalesce(next_attempt_at, scheduled_at))
  where status = 'queued';

-- updated_at triggers — both tables DO carry updated_at (no 42703 foot-gun;
-- drop-guarded so a partial rerun cannot leave a broken trigger behind).
drop trigger if exists studio_applications_set_updated_at on public.studio_applications;
create trigger studio_applications_set_updated_at
  before update on public.studio_applications
  for each row execute function public.set_updated_at();

drop trigger if exists studio_send_attempts_set_updated_at on public.studio_send_attempts;
create trigger studio_send_attempts_set_updated_at
  before update on public.studio_send_attempts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: owner SELECT-only; all writes via the service role.
-- (Same contract as bew_* — the application layer re-checks ownership.)
-- ---------------------------------------------------------------------------
alter table public.studio_applications enable row level security;
alter table public.studio_documents enable row level security;
alter table public.studio_attachments enable row level security;
alter table public.studio_send_attempts enable row level security;

drop policy if exists "studio_applications_owner_select" on public.studio_applications;
create policy "studio_applications_owner_select"
  on public.studio_applications for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "studio_documents_owner_select" on public.studio_documents;
create policy "studio_documents_owner_select"
  on public.studio_documents for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "studio_attachments_owner_select" on public.studio_attachments;
create policy "studio_attachments_owner_select"
  on public.studio_attachments for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "studio_send_attempts_owner_select" on public.studio_send_attempts;
create policy "studio_send_attempts_owner_select"
  on public.studio_send_attempts for select to authenticated
  using (auth.uid() = user_id);

-- Deny anon/authenticated writes explicitly (defense in depth: the default is
-- already deny when RLS is on and no insert/update/delete policy exists, but
-- be explicit like the bew_* schema).
revoke insert, update, delete on public.studio_applications from anon, authenticated;
revoke insert, update, delete on public.studio_documents from anon, authenticated;
revoke insert, update, delete on public.studio_attachments from anon, authenticated;
revoke insert, update, delete on public.studio_send_attempts from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Scheduler RPCs (service role only — the cron route holds no user identity).
-- ---------------------------------------------------------------------------

-- Claim up to p_limit DUE queued attempts and flip them to 'sending'
-- atomically. Due = immediate (scheduled_at IS NULL) or past due, and no
-- pending retry backoff (next_attempt_at IS NULL or past). Rows that were
-- already claimed by another worker are skipped (FOR UPDATE SKIP LOCKED).
create or replace function public.claim_due_studio_attempts(p_limit integer default 5)
returns setof public.studio_send_attempts
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
begin
  -- NOTE: attempt_count is NOT incremented here — the application layer
  -- (dispatchStudioAttempt) increments it exactly once per claimed dispatch,
  -- so both claim paths (this RPC and the inline atomic update) count the
  -- same way. Incrementing here as well would double-count.
  for rec in
    select id from public.studio_send_attempts
    where status = 'queued'
      and (scheduled_at is null or scheduled_at <= now())
      and (next_attempt_at is null or next_attempt_at <= now())
    order by coalesce(scheduled_at, created_at) asc
    limit greatest(1, least(p_limit, 10))
    for update skip locked
  loop
    update public.studio_send_attempts
    set status = 'sending'
    where id = rec.id
    returning * into rec;
    return next rec;
  end loop;
  return;
end;
$$;

revoke execute on function public.claim_due_studio_attempts(integer) from anon, authenticated;
grant execute on function public.claim_due_studio_attempts(integer) to service_role;

-- Stale recovery: 'sending' attempts stuck for > 15 minutes (crashed worker)
-- go back to 'queued' with a 1-minute backoff while attempts remain, or to
-- 'failed' when the budget (3) is exhausted. Mirrors recoverStaleCampaigns.
create or replace function public.recover_stale_studio_attempts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  recovered integer;
begin
  update public.studio_send_attempts
  set status = case
        when attempt_count >= 3 then 'failed'
        else 'queued'
      end,
      next_attempt_at = case
        when attempt_count >= 3 then null
        else timezone('utc', now()) + interval '1 minute'
      end,
      failure_code = case
        when attempt_count >= 3 then 'stale_exhausted'
        else failure_code
      end
  where status = 'sending'
    and updated_at < timezone('utc', now()) - interval '15 minutes';

  get diagnostics recovered = row_count;
  return recovered;
end;
$$;

revoke execute on function public.recover_stale_studio_attempts() from anon, authenticated;
grant execute on function public.recover_stale_studio_attempts() to service_role;
