alter table public.returns_claims add column if not exists deleted_at timestamptz;
alter table public.returns_claims add column if not exists deleted_by uuid references auth.users(id);
create index if not exists returns_claims_active_idx on public.returns_claims(deleted_at) where deleted_at is null;
