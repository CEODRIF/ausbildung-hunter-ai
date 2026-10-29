-- AUTO BEWERB (/auto-bewerb) — ISOLATED schema for the guided, multi-company
-- application workflow (CV analysis → companies → documents → tailored CV →
-- Anschreiben → email → review/send), up to 10 companies per workflow.
--
-- WHY A SEPARATE SCHEMA:
--   The Studio (/bewerbung-studio) is a per-application single-page editor
--   with its own 10-slot cap (studio_applications_user_slot_unique is keyed
--   on (user_id, slot_no) alone). AUTO BEWERB is a guided 7-step workflow
--   with a USER-LEVEL analyzed CV profile, a user-level supporting-document
--   library (documents are reused across companies by explicit selection),
--   ONE shared email-body template plus per-company email fields, and its
--   own 10-company cap. Sharing studio tables would couple the two features'
--   caps, statuses and invalidation rules. So AUTO BEWERB state lives in its
--   own `auto_bewerb_*` tables while SENDING reuses the existing safe
--   primitives (createEmailProvider, the private application-attachments
--   bucket) and the shared audit trail (activity_logs).
--
-- SAFETY CONTRACT (manual migration — this file is applied by hand, same as
-- every other migration in this repository):
--   * purely ADDITIVE: three new enums, seven new tables, indexes, triggers
--     and two RPCs. NO existing table, column, enum value, RPC or storage
--     bucket is altered or dropped.
--   * every auto_bewerb_* row is owner-scoped (user_id) and RLS-locked to
--     SELECT-only for the owner; all writes run with the service role after
--     an app-layer ownership check (identical contract to studio_*/bew_*).
--   * safe to re-run: pg_type-guarded enums, `if not exists`
--     tables/indexes, replaceable functions, drop-guarded triggers/policies.
--
-- DEPLOY ORDER: apply this migration BEFORE deploying code that references
-- auto_bewerb_profiles. Code deployed first degrades gracefully via the
-- getAutoBewerbMissingTables() probe ("setup pending" state, no crash).
--
-- REVERSIBILITY: drop the two RPCs, seven auto_bewerb_* tables and three
-- enums. No shared table, function, or storage bucket is dropped.
--
-- CAPS & DEDUPLICATION (race-proof, mirrors the studio's slot design):
--   * ≤ 10 companies per workflow: `slot_no` takes the smallest free value
--     in 1..10 at insert time; the partial UNIQUE index
--     (user_id, slot_no) WHERE slot_no > 0 is the database arbiter for
--     concurrent inserts (a lost race surfaces as a unique violation the
--     app layer maps to "workflow full").
--   * duplicate companies: `company_key` is a normalized company name set
--     by the app layer (lowercase, punctuation → space, collapsed); the
--     UNIQUE index (user_id, company_key) prevents adding the same company
--     twice within one workflow.
--
-- FILES: the analyzed CV and supporting documents live in the EXISTING
-- private bucket `application-attachments` (10 MB, pdf/doc/docx/png/jpeg)
-- under `${user_id}/auto-bewerb/...` — no new bucket, no public paths, no
-- signed URLs (the only consumer is the ownership-checked send path).

-- PostgreSQL has NO `CREATE TYPE IF NOT EXISTS` (42601). Guard with pg_type.
do $$
begin
  if not exists (
    select 1 from pg_type
    where typname = 'auto_bewerb_app_status'
      and typnamespace = 'public'::regnamespace
  ) then
    create type public.auto_bewerb_app_status as enum (
      'draft', 'ready', 'scheduled', 'sending', 'sent', 'failed', 'cancelled'
    );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_type
    where typname = 'auto_bewerb_doc_type'
      and typnamespace = 'public'::regnamespace
  ) then
    create type public.auto_bewerb_doc_type as enum (
      'cv', 'cover_letter'
    );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_type
    where typname = 'auto_bewerb_send_status'
      and typnamespace = 'public'::regnamespace
  ) then
    create type public.auto_bewerb_send_status as enum (
      'queued', 'sending', 'sent', 'failed', 'cancelled'
    );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The analyzed CV profile: ONE row per user (the workflow's single source
-- of truth for all generated documents — "never fabricate": the extraction
-- is reviewable/correctable in the UI and every generation is guarded
-- against it). cv_hash = sha256 of the uploaded bytes (dedupe/reuse:
-- re-uploading the identical file returns the stored extraction, no AI call).
-- ---------------------------------------------------------------------------
create table if not exists public.auto_bewerb_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  cv_file_name text not null check (char_length(trim(cv_file_name)) between 1 and 255),
  cv_mime_type text not null,
  cv_size_bytes integer not null default 0 check (cv_size_bytes >= 0),
  cv_storage_path text not null,
  cv_hash text not null,
  -- Extracted + user-corrected candidate profile (CandidateProfile jsonb,
  -- zod-validated; user edits replace it verbatim).
  extracted jsonb not null,
  analyzed_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists auto_bewerb_profiles_user_id_idx
  on public.auto_bewerb_profiles(user_id);

-- ---------------------------------------------------------------------------
-- Companies (one per job advertisement, max 10 active).
-- ---------------------------------------------------------------------------
create table if not exists public.auto_bewerb_companies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Display name (as the user/AI read it from the ad).
  company text not null check (char_length(trim(company)) between 1 and 200),
  -- Normalized dedupe key (app-layer: lowercase, punctuation → space,
  -- collapsed); empty ad company names are stored as '' and NOT deduped
  -- (the unique index excludes empty keys — see index below).
  company_key text not null default '',
  -- 1-based workflow slot (smallest free in 1..10); the partial UNIQUE
  -- index (user_id, slot_no) WHERE slot_no > 0 enforces the 10-company cap
  -- even under concurrent inserts.
  slot_no smallint not null default 0,
  -- The pasted advertisement text (untrusted input; prompt-fenced).
  ad_raw text not null check (char_length(ad_raw) between 1 and 30000),
  -- Structured, validated extraction (AdExtract jsonb; null until analysed).
  ad_extracted jsonb,
  -- Requirements + profile match report (AdAnalysis jsonb).
  ad_analysis jsonb,
  -- Candidate-facts fingerprint (profile cv_hash) at analysis time, so a
  -- re-analysis can prove the context is unchanged (reuse, no quota).
  profile_snapshot jsonb,
  status public.auto_bewerb_app_status not null default 'draft',
  -- Per-company email fields. email_subject is set per company;
  -- email_body NULL = use the SHARED template (auto_bewerb_email_templates),
  -- non-null = deliberate company-specific override. email_body_tokens is
  -- the stored shared/override template AFTER {company}/{position}/
  -- {contactName} substitution is applied at PREPARE time (never stored
  -- pre-rendered, so editing the shared template updates future sends).
  recipient_email text,
  email_subject text,
  email_body text,
  -- Whether the tailored CV / Anschreiben PDFs are attached to the email.
  email_attach_cv boolean not null default true,
  email_attach_letter boolean not null default true,
  email_account_id uuid references public.email_accounts(id) on delete set null,
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
  -- Explicit review confirmations (editing generated docs clears the
  -- matching timestamp — completion is re-derived server-side).
  ad_confirmed_at timestamptz,
  cv_reviewed_at timestamptz,
  letter_reviewed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists auto_bewerb_companies_user_id_idx
  on public.auto_bewerb_companies(user_id);
create index if not exists auto_bewerb_companies_status_idx
  on public.auto_bewerb_companies(status);
create index if not exists auto_bewerb_companies_user_created_idx
  on public.auto_bewerb_companies(user_id, created_at desc);
-- 10-company cap, race-proof (concurrent inserts: the loser gets a unique
-- violation, which the app layer maps to "workflow full").
create unique index if not exists auto_bewerb_companies_user_slot_unique
  on public.auto_bewerb_companies(user_id, slot_no)
  where slot_no > 0;
-- Duplicate-company prevention (empty keys are exempt: an ad without a
-- company name cannot be deduped by name).
create unique index if not exists auto_bewerb_companies_user_company_unique
  on public.auto_bewerb_companies(user_id, company_key)
  where company_key <> '';

-- ---------------------------------------------------------------------------
-- Versioned generated documents (per-company tailored CV / Anschreiben).
-- A new generation is a NEW version row — regenerating one company never
-- touches another company's documents.
-- ---------------------------------------------------------------------------
create table if not exists public.auto_bewerb_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.auto_bewerb_companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  doc_type public.auto_bewerb_doc_type not null,
  version integer not null default 1 check (version > 0),
  content jsonb not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (company_id, doc_type, version)
);

create index if not exists auto_bewerb_documents_user_id_idx
  on public.auto_bewerb_documents(user_id);
create index if not exists auto_bewerb_documents_company_idx
  on public.auto_bewerb_documents(company_id, doc_type, version desc);

-- ---------------------------------------------------------------------------
-- Supporting-document LIBRARY (user-level; reusable across companies).
-- The file itself lives in the existing private bucket
-- `application-attachments` under ${user_id}/auto-bewerb/docs/....
-- file_hash dedupes uploads: re-uploading identical bytes reuses the stored
-- row (no second storage object).
-- ---------------------------------------------------------------------------
create table if not exists public.auto_bewerb_attachments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 1 and 255),
  -- school_certificate | professional_qualification | language_certificate |
  -- reference | other (validated in TS; free text for forward-compat).
  doc_category text not null default 'other',
  mime_type text not null,
  size_bytes integer not null default 0 check (size_bytes >= 0),
  storage_path text not null,
  file_hash text not null,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists auto_bewerb_attachments_user_id_idx
  on public.auto_bewerb_attachments(user_id);
-- Upload dedupe: identical file bytes for the same user → one row.
create unique index if not exists auto_bewerb_attachments_user_hash_unique
  on public.auto_bewerb_attachments(user_id, file_hash);

-- ---------------------------------------------------------------------------
-- Per-company document selection: which library documents belong to which
-- application (the send path attaches exactly these, ownership-checked).
-- ---------------------------------------------------------------------------
create table if not exists public.auto_bewerb_company_attachments (
  company_id uuid not null references public.auto_bewerb_companies(id) on delete cascade,
  attachment_id uuid not null references public.auto_bewerb_attachments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (company_id, attachment_id)
);

create index if not exists auto_bewerb_company_attachments_user_id_idx
  on public.auto_bewerb_company_attachments(user_id);

-- ---------------------------------------------------------------------------
-- The SHARED email-body template: ONE row per user. Plain text; supports
-- the tokens {company}, {position}, {contactName} (substituted from each
-- company's stored extraction at send-preparation time — never stored
-- pre-rendered). NULL/empty = no template yet (the review step requires
-- one before sending).
-- ---------------------------------------------------------------------------
create table if not exists public.auto_bewerb_email_templates (
  user_id uuid primary key references auth.users(id) on delete cascade,
  body text not null default '',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists auto_bewerb_email_templates_set_updated_at on public.auto_bewerb_email_templates;
create trigger auto_bewerb_email_templates_set_updated_at
  before update on public.auto_bewerb_email_templates
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Durable dispatch state. ONE row per logical send; status transitions are
-- claimed atomically by the scheduler RPC (FOR UPDATE SKIP LOCKED).
-- ---------------------------------------------------------------------------
create table if not exists public.auto_bewerb_send_attempts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.auto_bewerb_companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key uuid not null unique,
  recipient_email text not null check (char_length(trim(recipient_email)) between 3 and 320),
  subject text not null check (char_length(trim(subject)) between 1 and 200),
  -- { html, text, attachments: [{filename, mimeType, storagePath}] }
  payload jsonb not null,
  status public.auto_bewerb_send_status not null default 'queued',
  -- NULL = send immediately; non-null = durable scheduled dispatch (UTC).
  scheduled_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz,
  provider_message_id text,
  failure_code text,
  failure_message text,
  sent_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists auto_bewerb_send_attempts_user_id_idx
  on public.auto_bewerb_send_attempts(user_id);
-- Scheduler hot path: due queued attempts only.
create index if not exists auto_bewerb_send_attempts_claim_idx
  on public.auto_bewerb_send_attempts(status, coalesce(next_attempt_at, scheduled_at))
  where status = 'queued';

-- updated_at triggers (drop-guarded so a partial rerun cannot leave a
-- broken trigger behind).
drop trigger if exists auto_bewerb_profiles_set_updated_at on public.auto_bewerb_profiles;
create trigger auto_bewerb_profiles_set_updated_at
  before update on public.auto_bewerb_profiles
  for each row execute function public.set_updated_at();

drop trigger if exists auto_bewerb_companies_set_updated_at on public.auto_bewerb_companies;
create trigger auto_bewerb_companies_set_updated_at
  before update on public.auto_bewerb_companies
  for each row execute function public.set_updated_at();

drop trigger if exists auto_bewerb_send_attempts_set_updated_at on public.auto_bewerb_send_attempts;
create trigger auto_bewerb_send_attempts_set_updated_at
  before update on public.auto_bewerb_send_attempts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: owner SELECT-only; all writes via the service role.
-- (Same contract as studio_*/bew_* — the application layer re-checks
-- ownership before every service-role write.)
-- ---------------------------------------------------------------------------
alter table public.auto_bewerb_profiles enable row level security;
alter table public.auto_bewerb_companies enable row level security;
alter table public.auto_bewerb_documents enable row level security;
alter table public.auto_bewerb_attachments enable row level security;
alter table public.auto_bewerb_company_attachments enable row level security;
alter table public.auto_bewerb_email_templates enable row level security;
alter table public.auto_bewerb_send_attempts enable row level security;

drop policy if exists "auto_bewerb_profiles_owner_select" on public.auto_bewerb_profiles;
create policy "auto_bewerb_profiles_owner_select"
  on public.auto_bewerb_profiles for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "auto_bewerb_companies_owner_select" on public.auto_bewerb_companies;
create policy "auto_bewerb_companies_owner_select"
  on public.auto_bewerb_companies for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "auto_bewerb_documents_owner_select" on public.auto_bewerb_documents;
create policy "auto_bewerb_documents_owner_select"
  on public.auto_bewerb_documents for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "auto_bewerb_attachments_owner_select" on public.auto_bewerb_attachments;
create policy "auto_bewerb_attachments_owner_select"
  on public.auto_bewerb_attachments for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "auto_bewerb_company_attachments_owner_select" on public.auto_bewerb_company_attachments;
create policy "auto_bewerb_company_attachments_owner_select"
  on public.auto_bewerb_company_attachments for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "auto_bewerb_email_templates_owner_select" on public.auto_bewerb_email_templates;
create policy "auto_bewerb_email_templates_owner_select"
  on public.auto_bewerb_email_templates for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "auto_bewerb_send_attempts_owner_select" on public.auto_bewerb_send_attempts;
create policy "auto_bewerb_send_attempts_owner_select"
  on public.auto_bewerb_send_attempts for select to authenticated
  using (auth.uid() = user_id);

-- Deny anon/authenticated writes explicitly (defense in depth).
revoke insert, update, delete on public.auto_bewerb_profiles from anon, authenticated;
revoke insert, update, delete on public.auto_bewerb_companies from anon, authenticated;
revoke insert, update, delete on public.auto_bewerb_documents from anon, authenticated;
revoke insert, update, delete on public.auto_bewerb_attachments from anon, authenticated;
revoke insert, update, delete on public.auto_bewerb_company_attachments from anon, authenticated;
revoke insert, update, delete on public.auto_bewerb_email_templates from anon, authenticated;
revoke insert, update, delete on public.auto_bewerb_send_attempts from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Scheduler RPCs (service role only — the cron route holds no user identity).
-- ---------------------------------------------------------------------------

-- Claim up to p_limit DUE queued attempts and flip them to 'sending'
-- atomically. Due = immediate (scheduled_at IS NULL) or past due, and no
-- pending retry backoff (next_attempt_at IS NULL or past). Rows already
-- claimed by another worker are skipped (FOR UPDATE SKIP LOCKED).
create or replace function public.claim_due_auto_bewerb_attempts(p_limit integer default 5)
returns setof public.auto_bewerb_send_attempts
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
begin
  -- NOTE: attempt_count is NOT incremented here — the application layer
  -- (dispatchAutoBewerbAttempt) increments it exactly once per claimed
  -- dispatch, so both claim paths count the same way.
  for rec in
    select id from public.auto_bewerb_send_attempts
    where status = 'queued'
      and (scheduled_at is null or scheduled_at <= now())
      and (next_attempt_at is null or next_attempt_at <= now())
    order by coalesce(scheduled_at, created_at) asc
    limit greatest(1, least(p_limit, 10))
    for update skip locked
  loop
    update public.auto_bewerb_send_attempts
    set status = 'sending'
    where id = rec.id
    returning * into rec;
    return next rec;
  end loop;
  return;
end;
$$;

revoke execute on function public.claim_due_auto_bewerb_attempts(integer) from anon, authenticated;
grant execute on function public.claim_due_auto_bewerb_attempts(integer) to service_role;

-- Stale recovery: 'sending' attempts stuck for > 15 minutes (crashed
-- worker) go back to 'queued' with a 1-minute backoff while attempts
-- remain, or to 'failed' when the budget (3) is exhausted.
create or replace function public.recover_stale_auto_bewerb_attempts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  recovered integer;
begin
  update public.auto_bewerb_send_attempts
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

revoke execute on function public.recover_stale_auto_bewerb_attempts() from anon, authenticated;
grant execute on function public.recover_stale_auto_bewerb_attempts() to service_role;
