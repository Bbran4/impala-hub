alter table public.sales_desk_rfqs add column if not exists deleted_at timestamptz;
alter table public.sales_desk_rfqs add column if not exists deleted_by uuid references auth.users(id);
create index if not exists sales_desk_rfqs_active_idx on public.sales_desk_rfqs(deleted_at) where deleted_at is null;
