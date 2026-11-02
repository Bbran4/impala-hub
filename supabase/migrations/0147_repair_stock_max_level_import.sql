-- Repair the import RPC in case 0145 was recorded before its function body
-- was corrected. This replaces the live function without using row_data as a
-- PL/pgSQL loop variable or implicit SQL column.
create or replace function public.import_stock_max_levels(p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare item jsonb; inserted_count integer := 0; part text;
begin
  if not public.has_application_permission('stock_control','stock_control.import') then raise exception 'Stock Max Level import permission required' using errcode='42501'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 10000 then raise exception 'Provide between 1 and 10,000 Stock Max Level rows' using errcode='22023'; end if;
  if exists (select 1 from jsonb_array_elements(p_rows) as elements(value) group by lower(btrim(elements.value->>'part_no')) having count(*) > 1) then raise exception 'The import contains duplicate part numbers' using errcode='23505'; end if;
  for item in select elements.value from jsonb_array_elements(p_rows) as elements(value) loop
    part := btrim(item->>'part_no');
    if part = '' or item->>'wh_max_level' !~ '^\d+$' or item->>'pta_max_level' !~ '^\d+$' or item->>'er_max_level' !~ '^\d+$' then raise exception 'Each row requires a part number and non-negative integer max levels' using errcode='22023'; end if;
    if exists (select 1 from public.stock_max_levels existing where lower(btrim(existing.part_no)) = lower(part)) then raise exception 'Part number already exists: %', part using errcode='23505'; end if;
    insert into public.stock_max_levels(part_no,wh_max_level,pta_max_level,er_max_level,unit_size,created_by,updated_by)
    values(part,(item->>'wh_max_level')::integer,(item->>'pta_max_level')::integer,(item->>'er_max_level')::integer,coalesce(item->>'unit_size',''),auth.uid(),auth.uid());
    inserted_count := inserted_count + 1;
  end loop;
  return inserted_count;
end; $$;
revoke all on function public.import_stock_max_levels(jsonb) from public, anon;
grant execute on function public.import_stock_max_levels(jsonb) to authenticated;
notify pgrst, 'reload schema';
