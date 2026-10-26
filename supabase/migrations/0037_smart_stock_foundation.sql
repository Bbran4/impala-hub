-- Smart Stock Control foundation.
-- This migration creates the Supabase data contract without switching the frontend.

create sequence if not exists public.stock_parts_query_reference_seq;

create or replace function public.next_stock_parts_query_reference()
returns text
language sql
volatile
security definer
set search_path = public
as $$
  select 'PQ-' || to_char(now() at time zone 'Africa/Johannesburg', 'YYYYMMDD') || '-' ||
    lpad(nextval('public.stock_parts_query_reference_seq')::text, 6, '0');
$$;

create or replace function public.can_operate_stock_control()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_user()
    and (public.has_role('administrator') or public.has_role('stock'));
$$;

create or replace function public.can_administer_stock_control()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_user() and public.has_role('administrator');
$$;

create table if not exists public.stock_development_statuses (
  name text primary key check (length(btrim(name)) between 1 and 80),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.stock_locations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  description text not null default '',
  vehicle_name text not null default '',
  supply_branch text not null default '' check (supply_branch in ('', 'er', 'pta')),
  color text not null default '#dff7ff' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists stock_locations_name_ci_unique on public.stock_locations (lower(name));
create unique index if not exists stock_locations_vehicle_ci_unique
  on public.stock_locations (lower(vehicle_name)) where btrim(vehicle_name) <> '';

create table if not exists public.stock_settings (
  singleton boolean primary key default true check (singleton),
  slow_max_avg_sales numeric(14,4) not null default 2 check (slow_max_avg_sales >= 0),
  ab_min_avg_sales numeric(14,4) not null default 10 check (ab_min_avg_sales >= 0),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ab_min_avg_sales >= slow_max_avg_sales)
);

create table if not exists public.stock_parts_queries (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  legacy_id text unique,
  part_number text not null check (length(btrim(part_number)) between 1 and 120),
  description text not null check (length(btrim(description)) between 1 and 500),
  qty integer not null check (qty between 1 and 1000000),
  sales_code_id uuid references public.sales_desk_sales_codes(id) on delete set null,
  development_status text not null references public.stock_development_statuses(name),
  status text not null default 'In Progress' check (status in ('In Progress', 'Submitted', 'Cancelled')),
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  deleted_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists stock_parts_queries_created_idx on public.stock_parts_queries (created_at desc);
create index if not exists stock_parts_queries_status_idx on public.stock_parts_queries (status, development_status);
create index if not exists stock_parts_queries_sales_code_idx on public.stock_parts_queries (sales_code_id);
create index if not exists stock_parts_queries_part_number_idx on public.stock_parts_queries (lower(part_number));

create table if not exists public.stock_parts_query_suppliers (
  id uuid primary key default gen_random_uuid(),
  query_id uuid not null references public.stock_parts_queries(id) on delete restrict,
  supplier text not null check (length(btrim(supplier)) between 1 and 160),
  qty integer not null default 1 check (qty between 1 and 1000000),
  cost numeric(16,2) check (cost is null or cost >= 0),
  msrp numeric(16,2) check (msrp is null or msrp >= 0),
  notes text not null default '' check (length(notes) <= 5000),
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists stock_parts_query_suppliers_query_idx on public.stock_parts_query_suppliers (query_id, created_at);
create index if not exists stock_parts_query_suppliers_name_idx on public.stock_parts_query_suppliers (lower(supplier));

create table if not exists public.stock_import_batches (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('manual_csv', 'manual_xlsx', 'google_sheets', 'qlik', 'sqlite_migration')),
  source_name text not null default '',
  source_checksum text,
  status text not null default 'staged' check (status in ('staged', 'validated', 'active', 'rejected', 'superseded')),
  booking_row_count integer not null default 0 check (booking_row_count >= 0),
  reordering_row_count integer not null default 0 check (reordering_row_count >= 0),
  rejected_row_count integer not null default 0 check (rejected_row_count >= 0),
  validation_errors jsonb not null default '[]'::jsonb check (jsonb_typeof(validation_errors) = 'array'),
  imported_by uuid not null references auth.users(id),
  activated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  validated_at timestamptz,
  activated_at timestamptz,
  superseded_at timestamptz
);
create unique index if not exists stock_import_batches_checksum_unique
  on public.stock_import_batches (source_checksum) where source_checksum is not null;
create unique index if not exists stock_import_batches_one_active
  on public.stock_import_batches ((status)) where status = 'active';
create index if not exists stock_import_batches_created_idx on public.stock_import_batches (created_at desc);

create table if not exists public.stock_booking_items (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references public.stock_import_batches(id) on delete restrict,
  source_row_number integer check (source_row_number is null or source_row_number > 0),
  legacy_id text,
  franchise text not null default '',
  part_number text not null check (length(btrim(part_number)) between 1 and 120),
  description text not null default '',
  unit_size text not null default '',
  supply_er integer not null default 0 check (supply_er >= 0),
  on_picking_slip_er integer not null default 0 check (on_picking_slip_er >= 0),
  qoh_er integer not null default 0,
  max_er integer not null default 0 check (max_er >= 0),
  supply_pta integer not null default 0 check (supply_pta >= 0),
  on_picking_slip_pta integer not null default 0 check (on_picking_slip_pta >= 0),
  qoh_pta integer not null default 0,
  max_pta integer not null default 0 check (max_pta >= 0),
  qoh_wh integer not null default 0,
  max_wh integer not null default 0 check (max_wh >= 0),
  bin_er text not null default '',
  bin_pta text not null default '',
  bin_wh text not null default '',
  created_at timestamptz not null default now(),
  unique (import_batch_id, part_number, franchise)
);
create index if not exists stock_booking_items_batch_idx on public.stock_booking_items (import_batch_id);
create index if not exists stock_booking_items_part_idx on public.stock_booking_items (lower(part_number));

create table if not exists public.stock_reordering_items (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references public.stock_import_batches(id) on delete restrict,
  source_row_number integer check (source_row_number is null or source_row_number > 0),
  legacy_id text,
  franchise text not null default '',
  part_number text not null check (length(btrim(part_number)) between 1 and 120),
  description text not null default '',
  alt_1 text not null default '',
  alt_2 text not null default '',
  alt_3 text not null default '',
  alt_4 text not null default '',
  qoh_er numeric(16,4) not null default 0,
  safety_er numeric(16,4) not null default 0 check (safety_er >= 0),
  qoh_pta numeric(16,4) not null default 0,
  safety_pta numeric(16,4) not null default 0 check (safety_pta >= 0),
  qoh_wh numeric(16,4) not null default 0,
  safety_wh numeric(16,4) not null default 0 check (safety_wh >= 0),
  global_safety numeric(16,4) not null default 0 check (global_safety >= 0),
  qty_on_order numeric(16,4) not null default 0 check (qty_on_order >= 0),
  qty_to_order numeric(16,4) not null default 0 check (qty_to_order >= 0),
  lead_time text not null default '',
  avg_sales numeric(16,4) not null default 0,
  sales_this_month numeric(16,4) not null default 0,
  gauge text not null default '',
  supplier text not null default '',
  last_cost numeric(16,2) check (last_cost is null or last_cost >= 0),
  supplier_type text not null default '' check (supplier_type in ('', 'local', 'international')),
  created_at timestamptz not null default now(),
  unique (import_batch_id, part_number, franchise)
);
create index if not exists stock_reordering_items_batch_idx on public.stock_reordering_items (import_batch_id);
create index if not exists stock_reordering_items_part_idx on public.stock_reordering_items (lower(part_number));
create index if not exists stock_reordering_items_supplier_idx on public.stock_reordering_items (lower(supplier), supplier_type);

create table if not exists public.stock_audit (
  id bigint generated always as identity primary key,
  entity_type text not null check (entity_type in ('parts_query', 'parts_query_supplier', 'development_status', 'location', 'settings', 'import_batch')),
  entity_id text not null,
  parts_query_id uuid references public.stock_parts_queries(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id),
  action text not null,
  changes jsonb not null default '{}'::jsonb check (jsonb_typeof(changes) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists stock_audit_entity_idx on public.stock_audit (entity_type, entity_id, created_at desc);
create index if not exists stock_audit_query_idx on public.stock_audit (parts_query_id, created_at desc);

insert into public.stock_development_statuses (name, sort_order) values
  ('New', 0), ('Under Review', 10), ('Approved', 20), ('Rejected', 30)
on conflict (name) do nothing;

insert into public.stock_settings (singleton, slow_max_avg_sales, ab_min_avg_sales)
values (true, 2, 10)
on conflict (singleton) do nothing;

insert into public.stock_locations (name, description, vehicle_name, supply_branch, color) values
  ('10', 'Warehouse', '', '', '#dff7ff'),
  ('ER', 'East Rand', 'ERBAKKIE', 'er', '#fff0cc'),
  ('PTA', 'Pretoria', 'PTABAKKIE', 'pta', '#e8ddff')
on conflict do nothing;

create or replace function public.set_stock_actor_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if to_jsonb(new) ? 'created_by' then new.created_by := auth.uid(); end if;
    if to_jsonb(new) ? 'updated_by' then new.updated_by := auth.uid(); end if;
    if to_jsonb(new) ? 'imported_by' then new.imported_by := auth.uid(); end if;
    new.created_at := now();
  else
    if to_jsonb(new) ? 'created_by' then new.created_by := old.created_by; end if;
    if to_jsonb(new) ? 'updated_by' then new.updated_by := auth.uid(); end if;
    if to_jsonb(new) ? 'imported_by' then new.imported_by := old.imported_by; end if;
    if to_jsonb(new) ? 'created_at' then new.created_at := old.created_at; end if;
    if to_jsonb(new) ? 'updated_at' then new.updated_at := now(); end if;
  end if;
  return new;
end;
$$;

create trigger stock_development_status_actor_fields before insert or update on public.stock_development_statuses
for each row execute function public.set_stock_actor_fields();
create trigger stock_location_actor_fields before insert or update on public.stock_locations
for each row execute function public.set_stock_actor_fields();
create trigger stock_settings_actor_fields before insert or update on public.stock_settings
for each row execute function public.set_stock_actor_fields();
create trigger stock_parts_query_actor_fields before insert or update on public.stock_parts_queries
for each row execute function public.set_stock_actor_fields();
create trigger stock_supplier_actor_fields before insert or update on public.stock_parts_query_suppliers
for each row execute function public.set_stock_actor_fields();
create trigger stock_import_actor_fields before insert or update on public.stock_import_batches
for each row execute function public.set_stock_actor_fields();

create or replace function public.validate_stock_parts_query_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.sales_code_id is not null and not exists (
      select 1 from public.sales_desk_sales_codes c
      where c.id = new.sales_code_id and c.is_active
    ) then raise exception 'Choose an active Sales Code'; end if;
    if not exists (
      select 1 from public.stock_development_statuses s
      where s.name = new.development_status and s.is_active
    ) then raise exception 'Choose an active Development Status'; end if;
  else
    if new.sales_code_id is distinct from old.sales_code_id and new.sales_code_id is not null and not exists (
      select 1 from public.sales_desk_sales_codes c
      where c.id = new.sales_code_id and c.is_active
    ) then raise exception 'Choose an active Sales Code'; end if;
    if new.development_status is distinct from old.development_status and not exists (
      select 1 from public.stock_development_statuses s
      where s.name = new.development_status and s.is_active
    ) then raise exception 'Choose an active Development Status'; end if;
  end if;

  if tg_op = 'INSERT' then
    new.reference := public.next_stock_parts_query_reference();
    if auth.uid() is not null then new.legacy_id := null; end if;
    new.deleted_at := null;
    new.deleted_by := null;
  else
    if old.deleted_at is not null then
      raise exception 'Archived Parts Queries cannot be edited';
    end if;
    new.reference := old.reference;
    new.legacy_id := old.legacy_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    if new.deleted_at is not null then
      if (to_jsonb(new) - array['deleted_at','deleted_by','updated_at','updated_by'])
          is distinct from (to_jsonb(old) - array['deleted_at','deleted_by','updated_at','updated_by']) then
        raise exception 'Archive the Parts Query without changing its other fields';
      end if;
      new.deleted_at := now();
      new.deleted_by := auth.uid();
    else
      new.deleted_by := old.deleted_by;
    end if;
  end if;
  return new;
end;
$$;

create trigger validate_stock_parts_query before insert or update on public.stock_parts_queries
for each row execute function public.validate_stock_parts_query_change();

create or replace function public.validate_stock_supplier_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then new.query_id := old.query_id; end if;
  return new;
end;
$$;

create trigger validate_stock_supplier before update on public.stock_parts_query_suppliers
for each row execute function public.validate_stock_supplier_change();

create or replace function public.protect_stock_location_availability()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.is_active then
    if tg_op = 'DELETE' and (select count(*) from public.stock_locations where is_active) <= 2 then
      raise exception 'At least two active stock locations are required';
    elsif tg_op = 'UPDATE' and not new.is_active and
          (select count(*) from public.stock_locations where is_active) <= 2 then
      raise exception 'At least two active stock locations are required';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

create trigger protect_stock_location_availability
before delete or update of is_active on public.stock_locations
for each row execute function public.protect_stock_location_availability();

create or replace function public.validate_stock_import_batch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'staged' then
      raise exception 'New stock imports must start in the staged state';
    end if;
    new.imported_by := auth.uid();
    new.activated_by := null;
    new.validated_at := null;
    new.activated_at := null;
    new.superseded_at := null;
    return new;
  end if;

  new.source_type := old.source_type;
  new.source_name := old.source_name;
  new.source_checksum := old.source_checksum;
  new.imported_by := old.imported_by;
  new.created_at := old.created_at;

  if old.status in ('rejected','superseded') then
    raise exception 'Completed stock import batches are immutable';
  end if;
  if old.status = 'validated' and new.status = 'validated' then
    raise exception 'Validated stock import batches can only be activated or rejected';
  end if;
  if old.status = 'active' and new.status <> 'superseded' then
    raise exception 'Active stock import batches can only be superseded';
  end if;
  if old.status = 'active' and
     (to_jsonb(new) - array['status','superseded_at']) is distinct from
     (to_jsonb(old) - array['status','superseded_at']) then
    raise exception 'Active stock import data is immutable';
  end if;

  if new.status <> old.status then
    if not (
      (old.status = 'staged' and new.status in ('validated','rejected')) or
      (old.status = 'validated' and new.status in ('active','rejected')) or
      (old.status = 'active' and new.status = 'superseded')
    ) then
      raise exception 'Invalid stock import status transition from % to %', old.status, new.status;
    end if;
    if new.status = 'validated' then new.validated_at := now(); end if;
    if new.status = 'active' then
      new.activated_at := now();
      new.activated_by := auth.uid();
    end if;
    if new.status = 'superseded' then new.superseded_at := now(); end if;
  end if;
  return new;
end;
$$;

create trigger validate_stock_import_batch before insert or update on public.stock_import_batches
for each row execute function public.validate_stock_import_batch();

create or replace function public.audit_stock_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  record_id text;
  query_id uuid;
  audit_action text;
  details jsonb := '{}'::jsonb;
begin
  if auth.uid() is null then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_table_name = 'stock_parts_queries' then
    record_id := coalesce(new.id, old.id)::text;
    query_id := coalesce(new.id, old.id);
    if tg_op = 'INSERT' then audit_action := 'created';
    elsif old.deleted_at is null and new.deleted_at is not null then audit_action := 'archived';
    else audit_action := 'updated'; end if;
  elsif tg_table_name = 'stock_parts_query_suppliers' then
    record_id := coalesce(new.id, old.id)::text;
    query_id := coalesce(new.query_id, old.query_id);
    audit_action := case tg_op when 'INSERT' then 'supplier_added' when 'UPDATE' then 'supplier_updated' else 'supplier_deleted' end;
  elsif tg_table_name = 'stock_development_statuses' then
    record_id := coalesce(new.name, old.name);
    audit_action := case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end;
  elsif tg_table_name = 'stock_locations' then
    record_id := coalesce(new.id, old.id)::text;
    audit_action := case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end;
  elsif tg_table_name = 'stock_settings' then
    record_id := 'global';
    audit_action := 'updated';
  elsif tg_table_name = 'stock_import_batches' then
    record_id := coalesce(new.id, old.id)::text;
    audit_action := case tg_op when 'INSERT' then 'created' else 'updated' end;
  end if;

  if tg_op = 'UPDATE' then
    details := jsonb_build_object('before', to_jsonb(old), 'after', to_jsonb(new));
  elsif tg_op = 'INSERT' then
    details := jsonb_build_object('record', to_jsonb(new));
  else
    details := jsonb_build_object('record', to_jsonb(old));
  end if;

  insert into public.stock_audit (entity_type, entity_id, parts_query_id, actor_user_id, action, changes)
  values (
    case tg_table_name
      when 'stock_parts_queries' then 'parts_query'
      when 'stock_parts_query_suppliers' then 'parts_query_supplier'
      when 'stock_development_statuses' then 'development_status'
      when 'stock_locations' then 'location'
      when 'stock_settings' then 'settings'
      else 'import_batch'
    end,
    record_id, query_id, auth.uid(), audit_action, details
  );
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

create trigger audit_stock_parts_query after insert or update on public.stock_parts_queries
for each row execute function public.audit_stock_change();
create trigger audit_stock_supplier after insert or update or delete on public.stock_parts_query_suppliers
for each row execute function public.audit_stock_change();
create trigger audit_stock_development_status after insert or update or delete on public.stock_development_statuses
for each row execute function public.audit_stock_change();
create trigger audit_stock_location after insert or update or delete on public.stock_locations
for each row execute function public.audit_stock_change();
create trigger audit_stock_settings after update on public.stock_settings
for each row execute function public.audit_stock_change();
create trigger audit_stock_import_batch after insert or update on public.stock_import_batches
for each row execute function public.audit_stock_change();

alter table public.stock_development_statuses enable row level security;
alter table public.stock_locations enable row level security;
alter table public.stock_settings enable row level security;
alter table public.stock_parts_queries enable row level security;
alter table public.stock_parts_query_suppliers enable row level security;
alter table public.stock_import_batches enable row level security;
alter table public.stock_booking_items enable row level security;
alter table public.stock_reordering_items enable row level security;
alter table public.stock_audit enable row level security;

create policy "stock workspace reads development statuses" on public.stock_development_statuses
for select to authenticated using (public.can_access_workspace('stock_control'));
create policy "stock admins manage development statuses" on public.stock_development_statuses
for all to authenticated using (public.can_administer_stock_control()) with check (public.can_administer_stock_control());

create policy "stock workspace reads locations" on public.stock_locations
for select to authenticated using (public.can_access_workspace('stock_control'));
create policy "stock admins manage locations" on public.stock_locations
for all to authenticated using (public.can_administer_stock_control()) with check (public.can_administer_stock_control());

create policy "stock workspace reads settings" on public.stock_settings
for select to authenticated using (public.can_access_workspace('stock_control'));
create policy "stock admins manage settings" on public.stock_settings
for all to authenticated using (public.can_administer_stock_control()) with check (public.can_administer_stock_control());

create policy "stock workspace reads parts queries" on public.stock_parts_queries
for select to authenticated using (public.can_access_workspace('stock_control'));
create policy "stock operators create parts queries" on public.stock_parts_queries
for insert to authenticated with check (public.can_operate_stock_control());
create policy "stock operators update parts queries" on public.stock_parts_queries
for update to authenticated using (public.can_operate_stock_control()) with check (public.can_operate_stock_control());

create policy "stock workspace reads query suppliers" on public.stock_parts_query_suppliers
for select to authenticated using (
  public.can_access_workspace('stock_control') and exists (
    select 1 from public.stock_parts_queries q where q.id = query_id
  )
);
create policy "stock operators create query suppliers" on public.stock_parts_query_suppliers
for insert to authenticated with check (
  public.can_operate_stock_control() and exists (
    select 1 from public.stock_parts_queries q where q.id = query_id and q.deleted_at is null
  )
);
create policy "stock operators update query suppliers" on public.stock_parts_query_suppliers
for update to authenticated using (public.can_operate_stock_control()) with check (
  public.can_operate_stock_control() and exists (
    select 1 from public.stock_parts_queries q where q.id = query_id and q.deleted_at is null
  )
);
create policy "stock operators delete query suppliers" on public.stock_parts_query_suppliers
for delete to authenticated using (
  public.can_operate_stock_control() and exists (
    select 1 from public.stock_parts_queries q where q.id = query_id and q.deleted_at is null
  )
);

create policy "stock workspace reads import batches" on public.stock_import_batches
for select to authenticated using (public.can_access_workspace('stock_control'));
create policy "stock admins create import batches" on public.stock_import_batches
for insert to authenticated with check (public.can_administer_stock_control());
create policy "stock admins update import batches" on public.stock_import_batches
for update to authenticated using (public.can_administer_stock_control()) with check (public.can_administer_stock_control());

create policy "stock workspace reads booking items" on public.stock_booking_items
for select to authenticated using (
  public.can_access_workspace('stock_control') and (
    public.can_administer_stock_control() or exists (
      select 1 from public.stock_import_batches b where b.id = import_batch_id and b.status = 'active'
    )
  )
);
create policy "stock admins import booking items" on public.stock_booking_items
for insert to authenticated with check (
  public.can_administer_stock_control() and exists (
    select 1 from public.stock_import_batches b where b.id = import_batch_id and b.status = 'staged'
  )
);
create policy "stock admins replace booking items" on public.stock_booking_items
for update to authenticated using (
  public.can_administer_stock_control() and exists (
    select 1 from public.stock_import_batches b where b.id = import_batch_id and b.status = 'staged'
  )
) with check (
  public.can_administer_stock_control() and exists (
    select 1 from public.stock_import_batches b where b.id = import_batch_id and b.status = 'staged'
  )
);
create policy "stock admins delete staged booking items" on public.stock_booking_items
for delete to authenticated using (
  public.can_administer_stock_control() and exists (
    select 1 from public.stock_import_batches b where b.id = import_batch_id and b.status <> 'active'
  )
);

create policy "stock workspace reads reordering items" on public.stock_reordering_items
for select to authenticated using (
  public.can_access_workspace('stock_control') and (
    public.can_administer_stock_control() or exists (
      select 1 from public.stock_import_batches b where b.id = import_batch_id and b.status = 'active'
    )
  )
);
create policy "stock admins import reordering items" on public.stock_reordering_items
for insert to authenticated with check (
  public.can_administer_stock_control() and exists (
    select 1 from public.stock_import_batches b where b.id = import_batch_id and b.status = 'staged'
  )
);
create policy "stock admins replace reordering items" on public.stock_reordering_items
for update to authenticated using (
  public.can_administer_stock_control() and exists (
    select 1 from public.stock_import_batches b where b.id = import_batch_id and b.status = 'staged'
  )
) with check (
  public.can_administer_stock_control() and exists (
    select 1 from public.stock_import_batches b where b.id = import_batch_id and b.status = 'staged'
  )
);
create policy "stock admins delete staged reordering items" on public.stock_reordering_items
for delete to authenticated using (
  public.can_administer_stock_control() and exists (
    select 1 from public.stock_import_batches b where b.id = import_batch_id and b.status <> 'active'
  )
);

create policy "stock workspace reads audit" on public.stock_audit
for select to authenticated using (public.can_access_workspace('stock_control'));

revoke all on public.stock_development_statuses, public.stock_locations, public.stock_settings,
  public.stock_parts_queries, public.stock_parts_query_suppliers, public.stock_import_batches,
  public.stock_booking_items, public.stock_reordering_items, public.stock_audit from anon;

grant select, insert, update, delete on public.stock_development_statuses, public.stock_locations to authenticated;
grant select, update on public.stock_settings to authenticated;
grant select, insert, update on public.stock_parts_queries to authenticated;
grant select, insert, update, delete on public.stock_parts_query_suppliers to authenticated;
grant select, insert, update on public.stock_import_batches to authenticated;
grant select, insert, update, delete on public.stock_booking_items, public.stock_reordering_items to authenticated;
grant select on public.stock_audit to authenticated;

revoke all on function public.next_stock_parts_query_reference() from public, anon;
revoke all on function public.can_operate_stock_control() from public, anon;
revoke all on function public.can_administer_stock_control() from public, anon;
grant execute on function public.next_stock_parts_query_reference() to authenticated;
grant execute on function public.can_operate_stock_control() to authenticated;
grant execute on function public.can_administer_stock_control() to authenticated;
grant usage, select on sequence public.stock_parts_query_reference_seq to authenticated;
