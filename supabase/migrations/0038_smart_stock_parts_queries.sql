-- Atomic Smart Stock Parts Query operations and named audit history.

create or replace function public.create_stock_parts_query(
  p_part_number text,
  p_description text,
  p_qty integer,
  p_sales_code_id uuid,
  p_development_status text,
  p_status text,
  p_suppliers jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  new_query_id uuid;
begin
  if not public.can_operate_stock_control() then
    raise exception using errcode = '42501', message = 'You do not have permission to create Parts Queries';
  end if;
  if jsonb_typeof(coalesce(p_suppliers, '[]'::jsonb)) <> 'array' then
    raise exception 'Suppliers must be supplied as an array';
  end if;

  insert into public.stock_parts_queries
    (part_number, description, qty, sales_code_id, development_status, status, created_by, updated_by)
  values
    (btrim(p_part_number), btrim(p_description), p_qty, p_sales_code_id,
     btrim(p_development_status), p_status, auth.uid(), auth.uid())
  returning id into new_query_id;

  insert into public.stock_parts_query_suppliers
    (id, query_id, supplier, qty, cost, msrp, notes, created_by, updated_by)
  select
    coalesce(item.id, gen_random_uuid()), new_query_id, btrim(item.supplier), item.qty,
    item.cost, item.msrp, coalesce(item.notes, ''), auth.uid(), auth.uid()
  from jsonb_to_recordset(coalesce(p_suppliers, '[]'::jsonb)) as item(
    id uuid, supplier text, qty integer, cost numeric, msrp numeric, notes text
  );

  return new_query_id;
end;
$$;

create or replace function public.update_stock_parts_query(
  p_query_id uuid,
  p_part_number text,
  p_description text,
  p_qty integer,
  p_sales_code_id uuid,
  p_development_status text,
  p_status text,
  p_suppliers jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  existing_query_id uuid;
begin
  if not public.can_operate_stock_control() then
    raise exception using errcode = '42501', message = 'You do not have permission to update Parts Queries';
  end if;
  if jsonb_typeof(coalesce(p_suppliers, '[]'::jsonb)) <> 'array' then
    raise exception 'Suppliers must be supplied as an array';
  end if;

  select id into existing_query_id
  from public.stock_parts_queries
  where id = p_query_id and deleted_at is null
  for update;
  if existing_query_id is null then raise exception 'Parts Query not found'; end if;

  update public.stock_parts_queries
  set part_number = btrim(p_part_number), description = btrim(p_description), qty = p_qty,
      sales_code_id = p_sales_code_id, development_status = btrim(p_development_status),
      status = p_status
  where id = p_query_id;

  delete from public.stock_parts_query_suppliers where query_id = p_query_id;
  insert into public.stock_parts_query_suppliers
    (id, query_id, supplier, qty, cost, msrp, notes, created_by, updated_by)
  select
    coalesce(item.id, gen_random_uuid()), p_query_id, btrim(item.supplier), item.qty,
    item.cost, item.msrp, coalesce(item.notes, ''), auth.uid(), auth.uid()
  from jsonb_to_recordset(coalesce(p_suppliers, '[]'::jsonb)) as item(
    id uuid, supplier text, qty integer, cost numeric, msrp numeric, notes text
  );

  return p_query_id;
end;
$$;

create or replace function public.archive_stock_parts_query(p_query_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.can_operate_stock_control() then
    raise exception using errcode = '42501', message = 'You do not have permission to archive Parts Queries';
  end if;
  update public.stock_parts_queries
  set deleted_at = now()
  where id = p_query_id and deleted_at is null;
  if not found then raise exception 'Parts Query not found'; end if;
  return p_query_id;
end;
$$;

create or replace function public.stock_parts_query_history(target_query_id uuid)
returns table (
  id bigint,
  action text,
  changes jsonb,
  created_at timestamptz,
  actor_user_id uuid,
  actor_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.id,
    a.action,
    a.changes,
    a.created_at,
    a.actor_user_id,
    coalesce(
      nullif(btrim(concat_ws(' ', p.first_name, p.surname)), ''),
      nullif(p.display_name, ''),
      p.email,
      'Unknown user'
    ) as actor_name
  from public.stock_audit a
  left join public.profiles p on p.id = a.actor_user_id
  where public.can_access_workspace('stock_control')
    and a.parts_query_id = target_query_id
  order by a.id;
$$;

revoke all on function public.create_stock_parts_query(text,text,integer,uuid,text,text,jsonb) from public, anon;
revoke all on function public.update_stock_parts_query(uuid,text,text,integer,uuid,text,text,jsonb) from public, anon;
revoke all on function public.archive_stock_parts_query(uuid) from public, anon;
revoke all on function public.stock_parts_query_history(uuid) from public, anon;
grant execute on function public.create_stock_parts_query(text,text,integer,uuid,text,text,jsonb) to authenticated;
grant execute on function public.update_stock_parts_query(uuid,text,text,integer,uuid,text,text,jsonb) to authenticated;
grant execute on function public.archive_stock_parts_query(uuid) to authenticated;
grant execute on function public.stock_parts_query_history(uuid) to authenticated;
