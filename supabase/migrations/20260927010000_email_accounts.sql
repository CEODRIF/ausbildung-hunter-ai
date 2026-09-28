create type public.email_provider as enum ('gmail', 'outlook');

create table public.email_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider public.email_provider not null,
  provider_account_id text not null,
  email text not null,
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  token_expires_at timestamptz,
  scopes text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  last_used_at timestamptz,
  unique (user_id, provider, provider_account_id)
);

create index email_accounts_user_id_idx on public.email_accounts(user_id);
create index email_accounts_provider_idx on public.email_accounts(provider);
create index email_accounts_provider_account_id_idx on public.email_accounts(provider_account_id);

create trigger email_accounts_set_updated_at
before update on public.email_accounts
for each row execute function public.set_updated_at();

alter table public.email_accounts enable row level security;

create policy "Users can read safe fields from their email accounts"
on public.email_accounts for select to authenticated
using (auth.uid() = user_id);

create policy "Users can delete their own email accounts"
on public.email_accounts for delete to authenticated
using (auth.uid() = user_id);

revoke all on public.email_accounts from anon, authenticated;
grant select (id, user_id, provider, email, scopes, is_active, created_at, updated_at, last_used_at) on public.email_accounts to authenticated;
grant delete on public.email_accounts to authenticated;
