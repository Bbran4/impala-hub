create table if not exists public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('facebook', 'instagram')),
  owner_id uuid not null references auth.users(id) on delete cascade,
  account_id text,
  account_name text,
  page_id text,
  page_name text,
  token_ciphertext text,
  token_expires_at timestamptz,
  data_access_expires_at timestamptz,
  scopes text[] not null default '{}',
  status text not null default 'connected' check (status in ('connected', 'warning', 'error', 'disconnected')),
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, owner_id)
);

create index if not exists provider_connections_owner_idx on public.provider_connections (owner_id);
alter table public.provider_connections enable row level security;
grant select, insert, update, delete on public.provider_connections to authenticated;

create policy "users read own provider connections" on public.provider_connections
for select to authenticated using (owner_id = auth.uid() and public.is_active_user());
create policy "users manage own provider connections" on public.provider_connections
for all to authenticated using (owner_id = auth.uid() and public.is_active_user())
with check (owner_id = auth.uid() and public.is_active_user());

drop trigger if exists provider_connections_set_updated_at on public.provider_connections;
create trigger provider_connections_set_updated_at before update on public.provider_connections
for each row execute function public.set_updated_at();
