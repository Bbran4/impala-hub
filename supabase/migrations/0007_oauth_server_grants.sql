-- OAuth state and pending Page choices are server-only tables. The browser
-- roles remain denied; only the Vercel server role may manage these records.
create table if not exists public.oauth_states (
  state text primary key,
  provider text not null check (provider in ('facebook', 'instagram')),
  owner_id uuid not null references auth.users(id) on delete cascade,
  redirect_uri text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create table if not exists public.oauth_page_choices (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null check (provider = 'facebook'),
  pages jsonb not null default '[]'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.oauth_states enable row level security;
alter table public.oauth_page_choices enable row level security;
revoke all on public.oauth_states from anon, authenticated;
revoke all on public.oauth_page_choices from anon, authenticated;
grant usage on schema public to service_role;
grant select, insert, update, delete on public.oauth_states to service_role;
grant select, insert, update, delete on public.oauth_page_choices to service_role;
