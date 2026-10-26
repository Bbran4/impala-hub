create table if not exists public.returns_claims (
  id uuid primary key default gen_random_uuid(), date date not null, company text not null check (company in ('Warehouse','Eastrand','Pretoria')),
  rfc_book_number text not null, customer text not null, contact_person text not null, contact_number text not null,
  invoice_number text not null, invoice_date date not null, reason text not null check (reason in ('Core','Goods Damaged','Incorrect Goods Supplied','Claim')),
  part_number text not null, description text not null, qty integer not null check (qty > 0), outcome_request text,
  returned_by text not null default '', received_by text not null default '', supplier_received text not null default 'No',
  comments text not null default '', attachments jsonb not null default '[]'::jsonb,
  status text not null default 'In Progress', created_by uuid references auth.users(id), updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.returns_claims enable row level security;
create policy "returns users read claims" on public.returns_claims for select to authenticated using (public.is_active_user() and (public.has_role('administrator') or public.has_role('management') or public.has_role('returns')));
create policy "returns users manage claims" on public.returns_claims for all to authenticated using (public.is_active_user() and (public.has_role('administrator') or public.has_role('management') or public.has_role('returns'))) with check (public.is_active_user() and (public.has_role('administrator') or public.has_role('management') or public.has_role('returns')));
grant select, insert, update, delete on public.returns_claims to authenticated;
