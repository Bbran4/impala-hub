-- Administrator-only Smart Stock configuration operations.

create or replace function public.save_stock_location(
  p_location_id uuid,
  p_name text,
  p_description text,
  p_vehicle_name text,
  p_supply_branch text,
  p_color text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare saved_id uuid;
begin
  if not public.can_administer_stock_control() then
    raise exception using errcode = '42501', message = 'Administrator access is required to change stock locations';
  end if;
  if p_location_id is null then
    insert into public.stock_locations
      (name,description,vehicle_name,supply_branch,color,created_by,updated_by)
    values
      (btrim(p_name),btrim(coalesce(p_description,'')),btrim(coalesce(p_vehicle_name,'')),
       lower(btrim(coalesce(p_supply_branch,''))),lower(btrim(p_color)),auth.uid(),auth.uid())
    returning id into saved_id;
  else
    update public.stock_locations
    set name=btrim(p_name), description=btrim(coalesce(p_description,'')),
        vehicle_name=btrim(coalesce(p_vehicle_name,'')),
        supply_branch=lower(btrim(coalesce(p_supply_branch,''))), color=lower(btrim(p_color))
    where id=p_location_id
    returning id into saved_id;
    if saved_id is null then raise exception 'Stock location not found'; end if;
  end if;
  return saved_id;
end;
$$;

create or replace function public.set_stock_location_active(p_location_id uuid, p_active boolean)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare saved_id uuid;
begin
  if not public.can_administer_stock_control() then
    raise exception using errcode = '42501', message = 'Administrator access is required to change stock locations';
  end if;
  update public.stock_locations set is_active=p_active where id=p_location_id returning id into saved_id;
  if saved_id is null then raise exception 'Stock location not found'; end if;
  return saved_id;
end;
$$;

create or replace function public.delete_stock_location(p_location_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare deleted_name text;
begin
  if not public.can_administer_stock_control() then
    raise exception using errcode = '42501', message = 'Administrator access is required to delete stock locations';
  end if;
  delete from public.stock_locations where id=p_location_id returning name into deleted_name;
  if deleted_name is null then raise exception 'Stock location not found'; end if;
  return deleted_name;
exception
  when foreign_key_violation then
    raise exception 'This stock location is used by existing records. Deactivate it instead.';
end;
$$;

create or replace function public.save_stock_thresholds(p_slow_max numeric, p_ab_min numeric)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_administer_stock_control() then
    raise exception using errcode = '42501', message = 'Administrator access is required to change stock thresholds';
  end if;
  update public.stock_settings
  set slow_max_avg_sales=p_slow_max, ab_min_avg_sales=p_ab_min
  where singleton;
  return true;
end;
$$;

create or replace function public.create_stock_development_status(p_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare saved_name text;
begin
  if not public.can_administer_stock_control() then
    raise exception using errcode = '42501', message = 'Administrator access is required to change Development Statuses';
  end if;
  insert into public.stock_development_statuses (name,sort_order,created_by,updated_by)
  values (btrim(p_name),999,auth.uid(),auth.uid())
  returning name into saved_name;
  return saved_name;
end;
$$;

create or replace function public.set_stock_development_status_active(p_name text, p_active boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare saved_name text;
begin
  if not public.can_administer_stock_control() then
    raise exception using errcode = '42501', message = 'Administrator access is required to change Development Statuses';
  end if;
  update public.stock_development_statuses set is_active=p_active where name=p_name returning name into saved_name;
  if saved_name is null then raise exception 'Development Status not found'; end if;
  return saved_name;
end;
$$;

create or replace function public.delete_stock_development_status(p_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare deleted_name text;
begin
  if not public.can_administer_stock_control() then
    raise exception using errcode = '42501', message = 'Administrator access is required to delete Development Statuses';
  end if;
  if exists (select 1 from public.stock_parts_queries where development_status=p_name) then
    raise exception 'This Development Status is used by an existing Parts Query. Deactivate it instead.';
  end if;
  delete from public.stock_development_statuses where name=p_name returning name into deleted_name;
  if deleted_name is null then raise exception 'Development Status not found'; end if;
  return deleted_name;
end;
$$;

revoke insert, update, delete on public.stock_locations, public.stock_development_statuses from authenticated;
revoke insert, update, delete on public.stock_settings from authenticated;

revoke all on function public.save_stock_location(uuid,text,text,text,text,text) from public, anon;
revoke all on function public.set_stock_location_active(uuid,boolean) from public, anon;
revoke all on function public.delete_stock_location(uuid) from public, anon;
revoke all on function public.save_stock_thresholds(numeric,numeric) from public, anon;
revoke all on function public.create_stock_development_status(text) from public, anon;
revoke all on function public.set_stock_development_status_active(text,boolean) from public, anon;
revoke all on function public.delete_stock_development_status(text) from public, anon;
grant execute on function public.save_stock_location(uuid,text,text,text,text,text) to authenticated;
grant execute on function public.set_stock_location_active(uuid,boolean) to authenticated;
grant execute on function public.delete_stock_location(uuid) to authenticated;
grant execute on function public.save_stock_thresholds(numeric,numeric) to authenticated;
grant execute on function public.create_stock_development_status(text) to authenticated;
grant execute on function public.set_stock_development_status_active(text,boolean) to authenticated;
grant execute on function public.delete_stock_development_status(text) to authenticated;
