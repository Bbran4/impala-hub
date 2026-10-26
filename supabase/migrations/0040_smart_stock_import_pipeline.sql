-- Versioned Smart Stock import pipeline. Browser clients can stage rows only
-- through bounded RPCs and can never mutate an active snapshot directly.

create or replace function public.create_stock_import_batch(
  p_source_type text,
  p_source_name text,
  p_source_checksum text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare batch_id uuid;
begin
  if not public.can_administer_stock_control() then
    raise exception using errcode = '42501', message = 'Administrator access is required to import stock data';
  end if;
  if p_source_type not in ('manual_csv','manual_xlsx','google_sheets','qlik','sqlite_migration') then
    raise exception 'Choose a valid stock import source type';
  end if;
  if length(btrim(coalesce(p_source_name,''))) not between 1 and 255 then
    raise exception 'Stock import source name must be between 1 and 255 characters';
  end if;
  if coalesce(btrim(p_source_checksum),'') !~ '^[0-9a-fA-F]{64}$' then
    raise exception 'Stock import checksum must be a SHA-256 value';
  end if;
  if nullif(btrim(coalesce(p_source_checksum,'')), '') is not null and exists (
    select 1 from public.stock_import_batches where source_checksum = lower(btrim(p_source_checksum))
  ) then
    raise exception 'This stock file has already been imported';
  end if;

  insert into public.stock_import_batches (source_type,source_name,source_checksum,imported_by)
  values (p_source_type,btrim(p_source_name),lower(btrim(p_source_checksum)),auth.uid())
  returning id into batch_id;
  insert into public.stock_audit(entity_type,entity_id,actor_user_id,action,changes)
  values ('import_batch',batch_id::text,auth.uid(),'staging_started',jsonb_build_object('source_type',p_source_type,'source_name',btrim(p_source_name),'source_checksum',lower(btrim(p_source_checksum))));
  return batch_id;
end;
$$;

create or replace function public.append_stock_booking_items(p_batch_id uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  batch_status text;
  row_offset integer;
  inserted_count integer := 0;
  error_message text;
  error_state text;
begin
  if not public.can_administer_stock_control() then
    raise exception using errcode = '42501', message = 'Administrator access is required to import stock data';
  end if;
  select status into batch_status from public.stock_import_batches where id=p_batch_id for update;
  if batch_status is null then raise exception 'Stock import batch not found'; end if;
  if batch_status <> 'staged' then raise exception 'Only staged stock imports can receive rows'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 1 then raise exception 'Provide at least one Stock Booking row'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'Stock Booking rows must be uploaded in batches of 2,000 or fewer'; end if;
  select count(*) into row_offset from public.stock_booking_items where import_batch_id=p_batch_id;

  begin
    insert into public.stock_booking_items (
      import_batch_id,source_row_number,legacy_id,franchise,part_number,description,unit_size,
      supply_er,on_picking_slip_er,qoh_er,max_er,supply_pta,on_picking_slip_pta,qoh_pta,max_pta,
      qoh_wh,max_wh,bin_er,bin_pta,bin_wh
    )
    select p_batch_id, row_offset + item.ordinality::integer, nullif(btrim(item.value->>'id'),''),
      btrim(coalesce(item.value->>'franchise','')),btrim(coalesce(item.value->>'part_number','')),
      btrim(coalesce(item.value->>'description','')),btrim(coalesce(item.value->>'unit_size','')),
      greatest(0,coalesce(nullif(item.value->>'max_er',''),'0')::integer - coalesce(nullif(item.value->>'qoh_er',''),'0')::integer - coalesce(nullif(item.value->>'on_picking_slip_er',''),'0')::integer),
      coalesce(nullif(item.value->>'on_picking_slip_er',''),'0')::integer,
      coalesce(nullif(item.value->>'qoh_er',''),'0')::integer,
      coalesce(nullif(item.value->>'max_er',''),'0')::integer,
      greatest(0,coalesce(nullif(item.value->>'max_pta',''),'0')::integer - coalesce(nullif(item.value->>'qoh_pta',''),'0')::integer - coalesce(nullif(item.value->>'on_picking_slip_pta',''),'0')::integer),
      coalesce(nullif(item.value->>'on_picking_slip_pta',''),'0')::integer,
      coalesce(nullif(item.value->>'qoh_pta',''),'0')::integer,
      coalesce(nullif(item.value->>'max_pta',''),'0')::integer,
      coalesce(nullif(item.value->>'qoh_wh',''),'0')::integer,
      coalesce(nullif(item.value->>'max_wh',''),'0')::integer,
      btrim(coalesce(item.value->>'bin_er','')),btrim(coalesce(item.value->>'bin_pta','')),btrim(coalesce(item.value->>'bin_wh',''))
    from jsonb_array_elements(p_rows) with ordinality as item(value,ordinality);
    get diagnostics inserted_count = row_count;
    update public.stock_import_batches set booking_row_count=(select count(*) from public.stock_booking_items where import_batch_id=p_batch_id) where id=p_batch_id;
    insert into public.stock_audit(entity_type,entity_id,actor_user_id,action,changes)
    values ('import_batch',p_batch_id::text,auth.uid(),'booking_rows_staged',jsonb_build_object('row_start',row_offset+1,'row_count',inserted_count));
  exception when others then
    get stacked diagnostics error_message = message_text, error_state = returned_sqlstate;
    update public.stock_import_batches
    set rejected_row_count=rejected_row_count + jsonb_array_length(p_rows),
        validation_errors=validation_errors || jsonb_build_array(jsonb_build_object('dataset','booking','row_start',row_offset+1,'row_end',row_offset+jsonb_array_length(p_rows),'sqlstate',error_state,'message',error_message))
    where id=p_batch_id;
    insert into public.stock_audit(entity_type,entity_id,actor_user_id,action,changes)
    values ('import_batch',p_batch_id::text,auth.uid(),'booking_chunk_rejected',jsonb_build_object('row_start',row_offset+1,'row_count',jsonb_array_length(p_rows),'sqlstate',error_state,'message',error_message));
    return 0;
  end;
  return inserted_count;
end;
$$;

create or replace function public.append_stock_reordering_items(p_batch_id uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  batch_status text;
  row_offset integer;
  inserted_count integer := 0;
  error_message text;
  error_state text;
begin
  if not public.can_administer_stock_control() then
    raise exception using errcode = '42501', message = 'Administrator access is required to import stock data';
  end if;
  select status into batch_status from public.stock_import_batches where id=p_batch_id for update;
  if batch_status is null then raise exception 'Stock import batch not found'; end if;
  if batch_status <> 'staged' then raise exception 'Only staged stock imports can receive rows'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 1 then raise exception 'Provide at least one Stock Reordering row'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'Stock Reordering rows must be uploaded in batches of 2,000 or fewer'; end if;
  select count(*) into row_offset from public.stock_reordering_items where import_batch_id=p_batch_id;

  begin
    insert into public.stock_reordering_items (
      import_batch_id,source_row_number,legacy_id,franchise,part_number,description,alt_1,alt_2,alt_3,alt_4,
      qoh_er,safety_er,qoh_pta,safety_pta,qoh_wh,safety_wh,global_safety,qty_on_order,qty_to_order,
      lead_time,avg_sales,sales_this_month,gauge,supplier,last_cost,supplier_type
    )
    select p_batch_id, row_offset + item.ordinality::integer, nullif(btrim(item.value->>'id'),''),
      btrim(coalesce(item.value->>'franchise','')),btrim(coalesce(item.value->>'part_number','')),
      btrim(coalesce(item.value->>'description','')),btrim(coalesce(item.value->>'alt_1','')),
      btrim(coalesce(item.value->>'alt_2','')),btrim(coalesce(item.value->>'alt_3','')),btrim(coalesce(item.value->>'alt_4','')),
      coalesce(nullif(item.value->>'qoh_er',''),'0')::numeric,
      coalesce(nullif(item.value->>'safety_er',''),'0')::numeric,
      coalesce(nullif(item.value->>'qoh_pta',''),'0')::numeric,
      coalesce(nullif(item.value->>'safety_pta',''),'0')::numeric,
      coalesce(nullif(item.value->>'qoh_wh',''),'0')::numeric,
      coalesce(nullif(item.value->>'safety_wh',''),'0')::numeric,
      coalesce(nullif(item.value->>'global_safety',''),'0')::numeric,
      coalesce(nullif(item.value->>'qty_on_order',''),'0')::numeric,
      coalesce(nullif(item.value->>'qty_to_order',''),'0')::numeric,
      btrim(coalesce(item.value->>'lead_time','')),
      coalesce(nullif(item.value->>'avg_sales',''),'0')::numeric,
      coalesce(nullif(item.value->>'sales_this_month',''),'0')::numeric,
      btrim(coalesce(item.value->>'gauge','')),btrim(coalesce(item.value->>'supplier','')),
      case when nullif(item.value->>'last_cost','') is null then null else (item.value->>'last_cost')::numeric end,
      lower(btrim(coalesce(item.value->>'supplier_type','')))
    from jsonb_array_elements(p_rows) with ordinality as item(value,ordinality);
    get diagnostics inserted_count = row_count;
    update public.stock_import_batches set reordering_row_count=(select count(*) from public.stock_reordering_items where import_batch_id=p_batch_id) where id=p_batch_id;
    insert into public.stock_audit(entity_type,entity_id,actor_user_id,action,changes)
    values ('import_batch',p_batch_id::text,auth.uid(),'reordering_rows_staged',jsonb_build_object('row_start',row_offset+1,'row_count',inserted_count));
  exception when others then
    get stacked diagnostics error_message = message_text, error_state = returned_sqlstate;
    update public.stock_import_batches
    set rejected_row_count=rejected_row_count + jsonb_array_length(p_rows),
        validation_errors=validation_errors || jsonb_build_array(jsonb_build_object('dataset','reordering','row_start',row_offset+1,'row_end',row_offset+jsonb_array_length(p_rows),'sqlstate',error_state,'message',error_message))
    where id=p_batch_id;
    insert into public.stock_audit(entity_type,entity_id,actor_user_id,action,changes)
    values ('import_batch',p_batch_id::text,auth.uid(),'reordering_chunk_rejected',jsonb_build_object('row_start',row_offset+1,'row_count',jsonb_array_length(p_rows),'sqlstate',error_state,'message',error_message));
    return 0;
  end;
  return inserted_count;
end;
$$;

create or replace function public.validate_stock_import(p_batch_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare batch_row public.stock_import_batches%rowtype; booking_count integer; reordering_count integer;
begin
  if not public.can_administer_stock_control() then
    raise exception using errcode = '42501', message = 'Administrator access is required to validate stock imports';
  end if;
  select * into batch_row from public.stock_import_batches where id=p_batch_id for update;
  if not found then raise exception 'Stock import batch not found'; end if;
  if batch_row.status <> 'staged' then raise exception 'Only staged stock imports can be validated'; end if;
  select count(*) into booking_count from public.stock_booking_items where import_batch_id=p_batch_id;
  select count(*) into reordering_count from public.stock_reordering_items where import_batch_id=p_batch_id;

  if booking_count = 0 then
    batch_row.validation_errors := batch_row.validation_errors || jsonb_build_array(jsonb_build_object('dataset','booking','message','The import contains no Stock Booking rows'));
  end if;
  if reordering_count = 0 then
    batch_row.validation_errors := batch_row.validation_errors || jsonb_build_array(jsonb_build_object('dataset','reordering','message','The import contains no Stock Reordering rows'));
  end if;
  if jsonb_array_length(batch_row.validation_errors) > 0 then
    update public.stock_import_batches
    set booking_row_count=booking_count,reordering_row_count=reordering_count,
        rejected_row_count=greatest(rejected_row_count,booking_count+reordering_count),
        validation_errors=batch_row.validation_errors,status='rejected'
    where id=p_batch_id;
    insert into public.stock_audit(entity_type,entity_id,actor_user_id,action,changes)
    values ('import_batch',p_batch_id::text,auth.uid(),'validation_failed',jsonb_build_object('validator_version','stock-import-v1','booking_rows',booking_count,'reordering_rows',reordering_count,'errors',batch_row.validation_errors));
    return false;
  end if;
  update public.stock_import_batches
  set booking_row_count=booking_count,reordering_row_count=reordering_count,rejected_row_count=0,status='validated'
  where id=p_batch_id;
  insert into public.stock_audit(entity_type,entity_id,actor_user_id,action,changes)
  values ('import_batch',p_batch_id::text,auth.uid(),'validated',jsonb_build_object('validator_version','stock-import-v1','booking_rows',booking_count,'reordering_rows',reordering_count));
  return true;
end;
$$;

create or replace function public.activate_stock_import(p_batch_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare batch_status text; previous_active_id uuid;
begin
  if not public.can_administer_stock_control() then
    raise exception using errcode = '42501', message = 'Administrator access is required to activate stock imports';
  end if;
  perform pg_advisory_xact_lock(hashtext('impala_hub_stock_import_activation'));
  select status into batch_status from public.stock_import_batches where id=p_batch_id for update;
  if batch_status is null then raise exception 'Stock import batch not found'; end if;
  if batch_status <> 'validated' then raise exception 'Only validated stock imports can be activated'; end if;

  select id into previous_active_id from public.stock_import_batches where status='active' and id<>p_batch_id for update;
  update public.stock_import_batches set status='superseded' where id=previous_active_id;
  update public.stock_import_batches set status='active' where id=p_batch_id;
  if previous_active_id is not null then
    insert into public.stock_audit(entity_type,entity_id,actor_user_id,action,changes)
    values ('import_batch',previous_active_id::text,auth.uid(),'superseded',jsonb_build_object('replacement_batch_id',p_batch_id));
  end if;
  insert into public.stock_audit(entity_type,entity_id,actor_user_id,action,changes)
  values ('import_batch',p_batch_id::text,auth.uid(),'activated',jsonb_build_object('previous_active_batch_id',previous_active_id));
  return true;
end;
$$;

create or replace function public.reject_stock_import(p_batch_id uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare batch_status text;
begin
  if not public.can_administer_stock_control() then
    raise exception using errcode = '42501', message = 'Administrator access is required to reject stock imports';
  end if;
  if length(btrim(coalesce(p_reason,''))) < 3 then raise exception 'Enter a rejection reason'; end if;
  select status into batch_status from public.stock_import_batches where id=p_batch_id for update;
  if batch_status is null then raise exception 'Stock import batch not found'; end if;
  if batch_status not in ('staged','validated') then raise exception 'Only staged or validated stock imports can be rejected'; end if;
  update public.stock_import_batches
  set status='rejected',validation_errors=validation_errors || jsonb_build_array(jsonb_build_object('dataset','import','message',btrim(p_reason)))
  where id=p_batch_id;
  insert into public.stock_audit(entity_type,entity_id,actor_user_id,action,changes)
  values ('import_batch',p_batch_id::text,auth.uid(),'rejected',jsonb_build_object('reason',btrim(p_reason)));
  return true;
end;
$$;

revoke insert, update on public.stock_import_batches from authenticated;
revoke insert, update, delete on public.stock_booking_items, public.stock_reordering_items from authenticated;

revoke all on function public.create_stock_import_batch(text,text,text) from public, anon;
revoke all on function public.append_stock_booking_items(uuid,jsonb) from public, anon;
revoke all on function public.append_stock_reordering_items(uuid,jsonb) from public, anon;
revoke all on function public.validate_stock_import(uuid) from public, anon;
revoke all on function public.activate_stock_import(uuid) from public, anon;
revoke all on function public.reject_stock_import(uuid,text) from public, anon;
grant execute on function public.create_stock_import_batch(text,text,text) to authenticated;
grant execute on function public.append_stock_booking_items(uuid,jsonb) to authenticated;
grant execute on function public.append_stock_reordering_items(uuid,jsonb) to authenticated;
grant execute on function public.validate_stock_import(uuid) to authenticated;
grant execute on function public.activate_stock_import(uuid) to authenticated;
grant execute on function public.reject_stock_import(uuid,text) to authenticated;
