-- Smart Stock Control: Stock Max Level master data.
create table if not exists public.stock_max_levels (
  id uuid primary key default gen_random_uuid(),
  part_no text not null check (char_length(btrim(part_no)) between 1 and 120),
  wh_max_level integer not null check (wh_max_level >= 0),
  pta_max_level integer not null check (pta_max_level >= 0),
  er_max_level integer not null check (er_max_level >= 0),
  unit_size text not null default '' check (char_length(unit_size) <= 120),
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists stock_max_levels_part_no_unique on public.stock_max_levels (lower(btrim(part_no)));
alter table public.stock_max_levels enable row level security;
revoke all on public.stock_max_levels from public, anon, authenticated;
grant select, insert, update, delete on public.stock_max_levels to authenticated;
drop policy if exists "stock max levels readable by stock workspace" on public.stock_max_levels;
create policy "stock max levels readable by stock workspace" on public.stock_max_levels for select to authenticated using (public.has_application_permission('stock_control','stock_control.view'));
drop policy if exists "stock max levels writable by permission" on public.stock_max_levels;
create policy "stock max levels writable by permission" on public.stock_max_levels for all to authenticated
using (public.has_application_permission('stock_control','stock_control.edit') or public.has_application_permission('stock_control','stock_control.delete'))
with check (public.has_application_permission('stock_control','stock_control.edit'));

create or replace function public.import_stock_max_levels(p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare row_data jsonb; inserted_count integer := 0; part text;
begin
  if not public.has_application_permission('stock_control','stock_control.import') then raise exception 'Stock Max Level import permission required' using errcode='42501'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 10000 then raise exception 'Provide between 1 and 10,000 Stock Max Level rows' using errcode='22023'; end if;
  if exists (select 1 from jsonb_array_elements(p_rows) as elements(value) group by lower(btrim(elements.value->>'part_no')) having count(*) > 1) then raise exception 'The import contains duplicate part numbers' using errcode='23505'; end if;
  for row_data in select value from jsonb_array_elements(p_rows) loop
    part := btrim(row_data->>'part_no');
    if part = '' or row_data->>'wh_max_level' !~ '^\d+$' or row_data->>'pta_max_level' !~ '^\d+$' or row_data->>'er_max_level' !~ '^\d+$' then raise exception 'Each row requires a part number and non-negative integer max levels' using errcode='22023'; end if;
    if exists (select 1 from public.stock_max_levels where lower(btrim(part_no)) = lower(part)) then raise exception 'Part number already exists: %', part using errcode='23505'; end if;
    insert into public.stock_max_levels(part_no,wh_max_level,pta_max_level,er_max_level,unit_size,created_by,updated_by)
    values(part,(row_data->>'wh_max_level')::integer,(row_data->>'pta_max_level')::integer,(row_data->>'er_max_level')::integer,coalesce(row_data->>'unit_size',''),auth.uid(),auth.uid());
    inserted_count := inserted_count + 1;
  end loop;
  return inserted_count;
end; $$;
revoke all on function public.import_stock_max_levels(jsonb) from public, anon;
grant execute on function public.import_stock_max_levels(jsonb) to authenticated;
notify pgrst, 'reload schema';
