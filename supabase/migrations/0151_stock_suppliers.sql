-- Smart Stock Control supplier master and part assignments.
create table if not exists public.stock_suppliers (
  id uuid primary key default gen_random_uuid(), supplier_code text not null, supplier_name text not null,
  is_active boolean not null default true, created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (char_length(btrim(supplier_code)) between 1 and 80), check (char_length(btrim(supplier_name)) between 1 and 240)
);
create unique index if not exists stock_suppliers_code_unique on public.stock_suppliers(lower(btrim(supplier_code)));
create table if not exists public.stock_part_suppliers (
  id uuid primary key default gen_random_uuid(), part_no text not null, supplier_id uuid not null references public.stock_suppliers(id) on delete restrict,
  is_active boolean not null default true, created_by uuid references auth.users(id) on delete set null, updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), check (char_length(btrim(part_no)) between 1 and 120)
);
create unique index if not exists stock_part_suppliers_unique on public.stock_part_suppliers(lower(btrim(part_no)),supplier_id);
create index if not exists stock_part_suppliers_part_idx on public.stock_part_suppliers(lower(btrim(part_no)));
alter table public.stock_suppliers enable row level security; alter table public.stock_part_suppliers enable row level security;
revoke all on public.stock_suppliers, public.stock_part_suppliers from public, anon; grant select,insert,update,delete on public.stock_suppliers, public.stock_part_suppliers to authenticated;
create policy "stock suppliers visible" on public.stock_suppliers for select to authenticated using (public.has_application_permission('stock_control','stock_control.view'));
create policy "stock suppliers editable" on public.stock_suppliers for all to authenticated using (public.has_application_permission('stock_control','stock_control.edit') or public.has_application_permission('stock_control','stock_control.delete')) with check (public.has_application_permission('stock_control','stock_control.edit'));
create policy "stock part suppliers visible" on public.stock_part_suppliers for select to authenticated using (public.has_application_permission('stock_control','stock_control.view'));
create policy "stock part suppliers editable" on public.stock_part_suppliers for all to authenticated using (public.has_application_permission('stock_control','stock_control.edit') or public.has_application_permission('stock_control','stock_control.delete')) with check (public.has_application_permission('stock_control','stock_control.edit'));
create or replace function public.import_stock_part_suppliers(p_rows jsonb) returns integer language plpgsql security definer set search_path=public as $$
declare item jsonb; supplier uuid; part text; code text; name text; inserted_count integer:=0;
begin
  if not public.has_application_permission('stock_control','stock_control.import') then raise exception 'Supplier import permission required' using errcode='42501'; end if;
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)<1 or jsonb_array_length(p_rows)>10000 then raise exception 'Provide between 1 and 10,000 supplier rows' using errcode='22023'; end if;
  for item in select elements.value from jsonb_array_elements(p_rows) elements(value) loop
    part:=btrim(item->>'part_no');code:=btrim(item->>'supplier_code');name:=btrim(item->>'supplier');
    if part='' or code='' or name='' then raise exception 'Each row requires Part No, SupplierCode and Supplier' using errcode='22023'; end if;
    insert into public.stock_suppliers(supplier_code,supplier_name,created_by,updated_by) values(code,name,auth.uid(),auth.uid()) on conflict (lower(btrim(supplier_code))) do update set supplier_name=excluded.supplier_name,updated_by=auth.uid(),updated_at=now() returning id into supplier;
    insert into public.stock_part_suppliers(part_no,supplier_id,created_by,updated_by) values(part,supplier,auth.uid(),auth.uid()) on conflict (lower(btrim(part_no)),supplier_id) do update set is_active=true,updated_by=auth.uid(),updated_at=now(); inserted_count:=inserted_count+1;
  end loop; return inserted_count;
end; $$;
revoke all on function public.import_stock_part_suppliers(jsonb) from public,anon; grant execute on function public.import_stock_part_suppliers(jsonb) to authenticated; notify pgrst,'reload schema';
