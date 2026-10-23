insert into storage.buckets (id, name, public) values ('sales-desk-attachments', 'sales-desk-attachments', false)
on conflict (id) do update set public = false;
create policy "sales desk users upload attachments" on storage.objects for insert to authenticated
with check (bucket_id = 'sales-desk-attachments' and public.is_active_user());
create policy "sales desk users read attachments" on storage.objects for select to authenticated
using (bucket_id = 'sales-desk-attachments' and public.is_active_user());
create table if not exists public.sales_desk_rfq_audit (
  id bigint generated always as identity primary key,
  rfq_id uuid not null references public.sales_desk_rfqs(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id),
  action text not null,
  changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.sales_desk_rfq_audit enable row level security;
drop policy if exists "active users read sales desk audit" on public.sales_desk_rfq_audit;
create policy "active users read sales desk audit" on public.sales_desk_rfq_audit for select to authenticated using (public.is_active_user());
grant select, insert on public.sales_desk_rfq_audit to authenticated;
grant select, insert on public.sales_desk_rfq_attachments to authenticated;
