create type public.application_goal as enum ('ausbildung', 'arbeit');
create type public.recipient_validation_status as enum ('valid', 'invalid', 'duplicate');

create table public.application_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal public.application_goal not null,
  sender_email_account_id uuid not null references public.email_accounts(id) on delete restrict,
  subject text not null default '',
  body_html text not null default '',
  body_text text not null default '',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index application_drafts_user_id_idx on public.application_drafts(user_id);
create index application_drafts_sender_account_idx on public.application_drafts(sender_email_account_id);

create table public.application_draft_recipients (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.application_drafts(id) on delete cascade,
  email text not null,
  company_name text,
  validation_status public.recipient_validation_status not null default 'valid',
  created_at timestamptz not null default timezone('utc', now())
);

create index application_draft_recipients_draft_id_idx on public.application_draft_recipients(draft_id);

create table public.application_draft_attachments (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.application_drafts(id) on delete cascade,
  storage_path text not null unique,
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  created_at timestamptz not null default timezone('utc', now())
);

create index application_draft_attachments_draft_id_idx on public.application_draft_attachments(draft_id);

create trigger application_drafts_set_updated_at
before update on public.application_drafts
for each row execute function public.set_updated_at();

alter table public.application_drafts enable row level security;
alter table public.application_draft_recipients enable row level security;
alter table public.application_draft_attachments enable row level security;

create policy "Users can manage their own drafts"
on public.application_drafts for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "Users can manage recipients in their own drafts"
on public.application_draft_recipients for all to authenticated
using (exists (select 1 from public.application_drafts d where d.id = draft_id and d.user_id = auth.uid()))
with check (exists (select 1 from public.application_drafts d where d.id = draft_id and d.user_id = auth.uid()));

create policy "Users can manage attachments in their own drafts"
on public.application_draft_attachments for all to authenticated
using (exists (select 1 from public.application_drafts d where d.id = draft_id and d.user_id = auth.uid()))
with check (exists (select 1 from public.application_drafts d where d.id = draft_id and d.user_id = auth.uid()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('application-attachments', 'application-attachments', false, 10485760, array['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/png', 'image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = excluded.allowed_mime_types;

create policy "Users can upload application attachments to their own folder"
on storage.objects for insert to authenticated
with check (bucket_id = 'application-attachments' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users can read their own application attachments"
on storage.objects for select to authenticated
using (bucket_id = 'application-attachments' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users can delete their own application attachments"
on storage.objects for delete to authenticated
using (bucket_id = 'application-attachments' and (storage.foldername(name))[1] = auth.uid()::text);
