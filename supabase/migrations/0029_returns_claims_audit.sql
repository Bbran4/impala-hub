create table if not exists public.returns_claims_audit (
  id bigint generated always as identity primary key, claim_id uuid not null references public.returns_claims(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id), action text not null, changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.returns_claims_audit enable row level security;
create policy "returns users read audit" on public.returns_claims_audit for select to authenticated using (public.is_active_user() and (public.has_role('administrator') or public.has_role('management') or public.has_role('returns')));
create policy "returns users write audit" on public.returns_claims_audit for insert to authenticated with check (public.is_active_user() and actor_user_id = auth.uid() and (public.has_role('administrator') or public.has_role('management') or public.has_role('returns')));
grant select, insert on public.returns_claims_audit to authenticated;
