create table if not exists public.oauth_states (
  state text primary key,
  provider text not null check (provider in ('facebook', 'instagram')),
  owner_id uuid not null references auth.users(id) on delete cascade,
  redirect_uri text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table public.oauth_states enable row level security;
revoke all on public.oauth_states from anon, authenticated;
