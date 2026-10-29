-- Impala Hub Reporting: write tables (like Qlik's write table).
--
-- A write table shows dimensions and measures from the data plus extra columns people can type
-- into (for example "Order qty" or "Comment"). What they type is stored here per app, sheet
-- object, row (the row's dimension values as JSON text) and column. The loaded ERP data is never
-- changed.
--
-- Security: only bi_write_get / bi_write_set (SECURITY DEFINER) touch the table. Both require
-- that the caller may open the app. bi_write_set also checks that the object is a write table
-- on one of the app's sheets, that the column is one of its editable columns, that a number
-- column gets a number and a choice column one of its choices, and, when the object is set to
-- "builders only", that the caller is an administrator or report builder.
-- Migration numbering: Reporting uses even numbers (see supabase/README.md).

create table bi.write_cells (
  app_id uuid not null references bi.apps (id) on delete cascade,
  object_id text not null check (length(object_id) between 1 and 64),
  row_key text not null check (length(row_key) between 1 and 1000),
  column_name text not null check (length(column_name) between 1 and 100),
  value text not null check (length(value) <= 2000),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (app_id, object_id, row_key, column_name)
);
alter table bi.write_cells enable row level security;
grant all on bi.write_cells to service_role;

-- The write table object definition (from the sheets of the app), or null.
create function bi.write_object(p_app uuid, p_object text)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select o
  from bi.sheets s, jsonb_array_elements(s.objects) o
  where s.app_id = p_app and o->>'id' = p_object and o->>'kind' = 'writetable'
  limit 1;
$$;

create function public.bi_write_get(p_app uuid, p_object text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not bi.can_view_app(p_app) then
    raise exception 'You do not have access to this app' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('row_key', c.row_key, 'column', c.column_name, 'value', c.value,
      'updated_at', c.updated_at, 'updated_by', coalesce(nullif(pr.display_name, ''), pr.email, '')))
    from (select * from bi.write_cells w where w.app_id = p_app and w.object_id = p_object order by w.updated_at desc limit 20000) c
    left join public.profiles pr on pr.id = c.updated_by), '[]'::jsonb);
end;
$$;

create function public.bi_write_set(p_app uuid, p_object text, p_row_key text, p_column text, p_value text)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  obj jsonb;
  col jsonb;
  v text := btrim(coalesce(p_value, ''));
begin
  if not bi.can_view_app(p_app) then
    raise exception 'You do not have access to this app' using errcode = '42501';
  end if;
  obj := bi.write_object(p_app, p_object);
  if obj is null then raise exception 'This write table no longer exists; reload the sheet' using errcode = 'P0002'; end if;
  if coalesce(obj->'options'->>'writeEditors', 'everyone') = 'builders' and not bi.can_build() then
    raise exception 'Only administrators and report builders can edit this table' using errcode = '42501';
  end if;
  select c into col from jsonb_array_elements(coalesce(obj->'options'->'writeColumns', '[]')) c where c->>'name' = p_column limit 1;
  if col is null then raise exception 'Column "%" cannot be edited', p_column using errcode = '22023'; end if;
  if p_row_key is null or length(p_row_key) not between 1 and 1000 or length(v) > 2000 then
    raise exception 'The value is too long' using errcode = '22023';
  end if;
  if v <> '' and col->>'type' = 'number' and v !~ '^-?[0-9]+([.,][0-9]+)?$' then
    raise exception '"%" is not a number', v using errcode = '22023';
  end if;
  if v <> '' and col->>'type' = 'choice' and not exists (
    select 1 from unnest(string_to_array(coalesce(col->>'choices', ''), ',')) x where btrim(x) = v) then
    raise exception '"%" is not one of the choices', v using errcode = '22023';
  end if;
  if v = '' then
    delete from bi.write_cells w where w.app_id = p_app and w.object_id = p_object and w.row_key = p_row_key and w.column_name = p_column;
  else
    insert into bi.write_cells (app_id, object_id, row_key, column_name, value, updated_by, updated_at)
    values (p_app, p_object, p_row_key, p_column, case when col->>'type' = 'number' then replace(v, ',', '.') else v end, auth.uid(), now())
    on conflict (app_id, object_id, row_key, column_name)
    do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  end if;
end;
$$;

revoke all on function bi.write_object(uuid, text) from public, anon, authenticated;
revoke all on function public.bi_write_get(uuid, text), public.bi_write_set(uuid, text, text, text, text) from public, anon;
grant execute on function public.bi_write_get(uuid, text), public.bi_write_set(uuid, text, text, text, text) to authenticated;
