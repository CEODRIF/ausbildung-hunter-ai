create type public.ai_message_role as enum ('user', 'assistant', 'system');

create table public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New conversation',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index ai_conversations_user_updated_idx on public.ai_conversations(user_id, updated_at desc);

create table public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.ai_message_role not null,
  content text not null,
  created_at timestamptz not null default timezone('utc', now())
);

create index ai_messages_conversation_created_idx on public.ai_messages(conversation_id, created_at);
create index ai_messages_user_idx on public.ai_messages(user_id);

create table public.ai_file_uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null unique,
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  created_at timestamptz not null default timezone('utc', now())
);

create index ai_file_uploads_user_idx on public.ai_file_uploads(user_id);

create table public.ai_message_files (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.ai_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null unique,
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  created_at timestamptz not null default timezone('utc', now())
);

create index ai_message_files_message_idx on public.ai_message_files(message_id);
create index ai_message_files_user_idx on public.ai_message_files(user_id);

create table public.ai_generated_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  filename text not null,
  mime_type text not null,
  storage_path text not null unique,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 20971520),
  created_at timestamptz not null default timezone('utc', now())
);

create index ai_generated_files_user_idx on public.ai_generated_files(user_id);
create index ai_generated_files_conversation_idx on public.ai_generated_files(conversation_id);

create trigger ai_conversations_set_updated_at
before update on public.ai_conversations
for each row execute function public.set_updated_at();

alter table public.ai_conversations enable row level security;
alter table public.ai_file_uploads enable row level security;
alter table public.ai_messages enable row level security;

create policy "Users can manage their own AI uploads"
on public.ai_file_uploads for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
alter table public.ai_message_files enable row level security;
alter table public.ai_generated_files enable row level security;

create policy "Users can manage their own AI conversations"
on public.ai_conversations for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "Users can manage their own AI messages"
on public.ai_messages for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id and exists (select 1 from public.ai_conversations c where c.id = conversation_id and c.user_id = auth.uid()));

create policy "Users can manage their own AI message files"
on public.ai_message_files for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id and exists (select 1 from public.ai_messages m where m.id = message_id and m.user_id = auth.uid()));

create policy "Users can manage their own generated AI files"
on public.ai_generated_files for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id and exists (select 1 from public.ai_conversations c where c.id = conversation_id and c.user_id = auth.uid()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ai-files', 'ai-files', false, 10485760, array['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = excluded.allowed_mime_types;

create policy "Users can upload AI files into their own folder"
on storage.objects for insert to authenticated
with check (bucket_id = 'ai-files' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users can read their own AI files"
on storage.objects for select to authenticated
using (bucket_id = 'ai-files' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users can delete their own AI files"
on storage.objects for delete to authenticated
using (bucket_id = 'ai-files' and (storage.foldername(name))[1] = auth.uid()::text);

create or replace function public.reserve_ai_request(target_user_id uuid, max_requests integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_usage public.daily_usage%rowtype;
begin
  insert into public.daily_usage (user_id, date)
  values (target_user_id, (timezone('utc', now()))::date)
  on conflict (user_id, date) do nothing;
  select * into current_usage
  from public.daily_usage
  where user_id = target_user_id and date = (timezone('utc', now()))::date
  for update;
  if current_usage.ai_requests >= max_requests then
    raise exception 'ai_daily_limit_reached';
  end if;
  update public.daily_usage
  set ai_requests = ai_requests + 1
  where id = current_usage.id;
  return jsonb_build_object('date', current_usage.date, 'ai_requests', current_usage.ai_requests + 1, 'limit', max_requests);
end;
$$;

revoke all on function public.reserve_ai_request(uuid, integer) from public, anon, authenticated;
grant execute on function public.reserve_ai_request(uuid, integer) to service_role;
