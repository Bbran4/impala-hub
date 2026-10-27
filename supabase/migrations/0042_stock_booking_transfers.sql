-- Persist Stock Booking transfers and validate every exported row against the
-- currently active stock snapshot. Browser users cannot write these tables
-- directly; stock operators use create_stock_booking_transfer atomically.

create sequence if not exists public.stock_transfer_reference_seq;

create or replace function public.next_stock_transfer_reference()
returns text
language sql
volatile
security definer
set search_path = public
as $$
  select 'ST-' || to_char(now() at time zone 'Africa/Johannesburg', 'YYYYMMDD') || '-' ||
    lpad(nextval('public.stock_transfer_reference_seq')::text, 6, '0');
$$;

create table if not exists public.stock_transfer_batches (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default public.next_stock_transfer_reference(),
  import_batch_id uuid not null references public.stock_import_batches(id) on delete restrict,
  from_location_id uuid not null references public.stock_locations(id) on delete restrict,
  to_location_id uuid not null references public.stock_locations(id) on delete restrict,
  from_location text not null,
  to_location text not null,
  supply_branch text not null check (supply_branch in ('er','pta')),
  remarks text not null check (length(btrim(remarks)) between 1 and 1000),
  item_count integer not null default 0 check (item_count > 0),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  check (from_location_id <> to_location_id)
);
create index if not exists stock_transfer_batches_created_idx on public.stock_transfer_batches (created_at desc);
create index if not exists stock_transfer_batches_import_idx on public.stock_transfer_batches (import_batch_id);

create table if not exists public.stock_transfer_items (
  id uuid primary key default gen_random_uuid(),
  transfer_batch_id uuid not null references public.stock_transfer_batches(id) on delete restrict,
  stock_booking_item_id uuid not null references public.stock_booking_items(id) on delete restrict,
  franchise text not null,
  part_number text not null,
  from_bin_location text not null default '',
  to_bin_location text not null default '',
  transfer_qty integer not null check (transfer_qty > 0),
  created_at timestamptz not null default now(),
  unique (transfer_batch_id, stock_booking_item_id)
);
create index if not exists stock_transfer_items_batch_idx on public.stock_transfer_items (transfer_batch_id);

alter table public.stock_audit drop constraint if exists stock_audit_entity_type_check;
alter table public.stock_audit add constraint stock_audit_entity_type_check
  check (entity_type in ('parts_query','parts_query_supplier','development_status','location','settings','import_batch','transfer_batch'));

create or replace function public.create_stock_booking_transfer(
  p_import_batch_id uuid,
  p_from_location_id uuid,
  p_to_location_id uuid,
  p_remarks text,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  active_batch_id uuid;
  source_location public.stock_locations%rowtype;
  destination_location public.stock_locations%rowtype;
  saved_batch_id uuid;
  saved_reference text;
  inserted_count integer;
  requested_count integer;
begin
  if not public.can_operate_stock_control() then
    raise exception using errcode = '42501', message = 'Stock operator access is required to create a booking transfer';
  end if;
  if length(btrim(coalesce(p_remarks,''))) not between 1 and 1000 then
    raise exception 'Transfer remarks must be between 1 and 1,000 characters';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Provide Stock Booking transfer rows';
  end if;
  requested_count := jsonb_array_length(p_rows);
  if requested_count not between 1 and 2000 then
    raise exception 'Select between 1 and 2,000 Stock Booking rows';
  end if;

  -- Serialize transfer creation so concurrent exports cannot overbook the same
  -- warehouse stock before either transaction can see the other's rows.
  perform pg_advisory_xact_lock(hashtext('stock-booking-transfer')::bigint);
  if (select count(distinct requested_row.stock_booking_item_id)
      from jsonb_to_recordset(p_rows) as requested_row(stock_booking_item_id uuid,transfer_qty integer)) <> requested_count then
    raise exception 'One or more transfer rows are duplicated';
  end if;

  select id into active_batch_id from public.stock_import_batches where status='active' for share;
  if active_batch_id is null then raise exception 'No active stock snapshot is available'; end if;
  if p_import_batch_id is distinct from active_batch_id then
    raise exception 'The active stock snapshot changed. Refresh Stock Booking and try again.';
  end if;

  select * into source_location from public.stock_locations where id=p_from_location_id and is_active;
  if source_location.id is null then raise exception 'Choose an active From location'; end if;
  select * into destination_location from public.stock_locations where id=p_to_location_id and is_active;
  if destination_location.id is null then raise exception 'Choose an active To location'; end if;
  if source_location.id=destination_location.id then raise exception 'Choose two different locations'; end if;
  if source_location.name <> '10' and lower(source_location.description) not like '%warehouse%' then
    raise exception 'Stock Booking transfers must start from location 10 — Warehouse';
  end if;
  if regexp_replace(lower(destination_location.vehicle_name),'[^a-z0-9]','','g') not in ('erbakkie','ptabakkie')
     or destination_location.supply_branch not in ('er','pta') then
    raise exception 'Choose ERBAKKIE or PTABAKKIE as the destination';
  end if;

  insert into public.stock_transfer_batches (
    import_batch_id,from_location_id,to_location_id,from_location,to_location,
    supply_branch,remarks,item_count,created_by
  ) values (
    active_batch_id,source_location.id,destination_location.id,source_location.name,
    destination_location.vehicle_name,destination_location.supply_branch,btrim(p_remarks),
    requested_count,auth.uid()
  ) returning id,reference into saved_batch_id,saved_reference;

  insert into public.stock_transfer_items (
    transfer_batch_id,stock_booking_item_id,franchise,part_number,
    from_bin_location,to_bin_location,transfer_qty
  )
  select saved_batch_id,item.id,
    coalesce(nullif(btrim(item.franchise),''),destination_location.vehicle_name),
    item.part_number,item.bin_wh,
    case destination_location.supply_branch when 'er' then item.bin_er else item.bin_pta end,
    requested.transfer_qty
  from jsonb_to_recordset(p_rows) as requested(stock_booking_item_id uuid,transfer_qty integer)
  join public.stock_booking_items item
    on item.id=requested.stock_booking_item_id and item.import_batch_id=active_batch_id
  left join (
    select transfer_item.stock_booking_item_id,sum(transfer_item.transfer_qty)::integer as booked_qty
    from public.stock_transfer_items transfer_item
    join public.stock_transfer_batches transfer_batch on transfer_batch.id=transfer_item.transfer_batch_id
    where transfer_batch.import_batch_id=active_batch_id
    group by transfer_item.stock_booking_item_id
  ) booked on booked.stock_booking_item_id=item.id
  where requested.transfer_qty > 0
    and requested.transfer_qty <= greatest(item.qoh_wh-coalesce(booked.booked_qty,0),0);

  get diagnostics inserted_count = row_count;
  if inserted_count <> requested_count then
    raise exception 'One or more transfer rows are invalid, stale, or exceed remaining warehouse stock';
  end if;

  insert into public.stock_audit(entity_type,entity_id,actor_user_id,action,changes)
  values ('transfer_batch',saved_batch_id::text,auth.uid(),'exported',jsonb_build_object(
    'reference',saved_reference,'import_batch_id',active_batch_id,'from_location',source_location.name,
    'to_location',destination_location.vehicle_name,'item_count',inserted_count
  ));

  return jsonb_build_object(
    'id',saved_batch_id,'reference',saved_reference,'import_batch_id',active_batch_id,
    'from_location',source_location.name,'to_location',destination_location.vehicle_name,
    'supply_branch',destination_location.supply_branch,'remarks',btrim(p_remarks),
    'item_count',inserted_count,'items',(
      select coalesce(jsonb_agg(jsonb_build_object(
        'franchise',i.franchise,'part_number',i.part_number,
        'from_location',source_location.name,'from_bin_location',i.from_bin_location,
        'to_location',destination_location.vehicle_name,'to_bin_location',i.to_bin_location,
        'transfer_qty',i.transfer_qty,'remarks',btrim(p_remarks)
      ) order by i.part_number),'[]'::jsonb)
      from public.stock_transfer_items i where i.transfer_batch_id=saved_batch_id
    )
  );
end;
$$;

alter table public.stock_transfer_batches enable row level security;
alter table public.stock_transfer_items enable row level security;

create policy "stock workspace reads transfer batches" on public.stock_transfer_batches
for select to authenticated using (public.can_access_workspace('stock_control'));
create policy "stock workspace reads transfer items" on public.stock_transfer_items
for select to authenticated using (
  public.can_access_workspace('stock_control') and exists (
    select 1 from public.stock_transfer_batches b where b.id=transfer_batch_id
  )
);

revoke all on public.stock_transfer_batches, public.stock_transfer_items from anon;
revoke insert, update, delete on public.stock_transfer_batches, public.stock_transfer_items from authenticated;
grant select on public.stock_transfer_batches, public.stock_transfer_items to authenticated;

revoke all on function public.next_stock_transfer_reference() from public, anon, authenticated;
revoke all on function public.create_stock_booking_transfer(uuid,uuid,uuid,text,jsonb) from public, anon;
grant execute on function public.create_stock_booking_transfer(uuid,uuid,uuid,text,jsonb) to authenticated;

