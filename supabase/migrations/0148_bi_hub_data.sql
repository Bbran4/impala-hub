-- Reporting: "Hub data" connections. Data that already lives in this Supabase database (Sales Desk RFQs, returns
-- and claims, Smart Stock, Cross Reference, users and their sales codes, ...) is made available to Reporting
-- as a live view in bi_data: nothing is copied or loaded, reports always show the current rows.
--   * Only administrators create them, choosing a table and its columns.
--   * Only business tables can be chosen (allow list below); chat, sign-in/OAuth, permission, audit and
--     notification tables never can, nor columns that look like secrets (token, password, hash, ...).
--   * Like every Reporting table, the view is read through the role-checked Reporting functions only; app access
--     and row access decide who sees which rows. The Hub's own rules for the source table do not apply here, so
--     choose the columns with care.
-- Migration numbering: Reporting uses even numbers (see supabase/README.md).

alter table bi.connectors drop constraint connectors_kind_check;
alter table bi.connectors add constraint connectors_kind_check
  check (kind in ('upload', 'web', 'folder', 'sharepoint', 'gsheet', 'hub'));
alter table bi.connectors drop constraint agent_runs_web_and_folder;
alter table bi.connectors add constraint agent_runs_web_and_folder check (kind in ('upload', 'hub') or agent_name is not null);

-- Which Hub tables may be offered
create function bi.hub_table_allowed(p_schema text, p_table text)
returns boolean language sql immutable set search_path = ''
as $$
  select case
    when p_schema = 'xref' then p_table in ('brands', 'parts', 'part_numbers', 'imports')
    when p_schema = 'public' then
      (p_table ~ '^(sales_desk_|returns_claims|stock_)' or p_table in ('profiles', 'roles', 'profile_roles', 'posts', 'campaigns', 'campaign_types'))
      and p_table !~ '(chat|oauth|token|secret|permission|audit|notification|dispatch|counter|sequence|ingestion_source|provider)'
    else false end
$$;

create function bi.hub_column_allowed(p_column text)
returns boolean language sql immutable set search_path = ''
as $$
  select p_column !~* '(token|secret|password|passwd|cipher|hash|otp|nonce|salt|credential|api_?key|private)'
$$;

-- Tables and views that can be offered, with their columns
create function public.bi_hub_sources()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  perform bi.require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'schema', n.nspname, 'name', c.relname, 'type', case when c.relkind in ('v', 'm') then 'view' else 'table' end,
             'rows', case when c.reltuples >= 0 then c.reltuples::bigint end,
             'columns', (select coalesce(jsonb_agg(jsonb_build_object('name', a.attname, 'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
                                                                    'allowed', bi.hub_column_allowed(a.attname)) order by a.attnum), '[]')
                         from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
             'used_by', (select coalesce(jsonb_agg(k.name order by k.name), '[]') from bi.connectors k
                         where k.kind = 'hub' and k.config->>'schema' = n.nspname and k.config->>'table' = c.relname))
           order by n.nspname, c.relname)
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'xref') and c.relkind in ('r', 'p', 'v', 'm') and bi.hub_table_allowed(n.nspname, c.relname)), '[]');
end;
$$;

-- Rows in a Hub table: the planner's estimate (instant, also for very large tables), or a count when there is none yet
create function bi.hub_row_count(p_table oid)
returns bigint language plpgsql stable security definer set search_path = ''
as $$
declare
  n bigint;
begin
  select case when c.reltuples >= 0 then c.reltuples::bigint end into n from pg_catalog.pg_class c where c.oid = p_table;
  if n is null then execute format('select count(*) from %s', p_table::regclass) into n; end if;
  return n;
end;
$$;

-- (Re)creates the view bi_data.<name> and its catalogue entry
create function bi.hub_build(p_name text, p_schema text, p_table text, p_columns jsonb, p_description text)
returns integer language plpgsql volatile security definer set search_path = ''
as $$
declare
  src oid := pg_catalog.to_regclass(format('%I.%I', p_schema, p_table));
  existing char;
  col text;
  cols text[] := '{}';
begin
  if src is null or not bi.hub_table_allowed(p_schema, p_table) then
    raise exception 'The Hub table %.% cannot be used in Reporting', p_schema, p_table using errcode = '42501';
  end if;
  if jsonb_typeof(p_columns) <> 'array' or jsonb_array_length(p_columns) = 0 then
    raise exception 'Choose at least one column' using errcode = '22023';
  end if;
  for col in select jsonb_array_elements_text(p_columns) loop
    if not exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = src and a.attname = col and a.attnum > 0 and not a.attisdropped) then
      raise exception 'The column "%" is not in %.%', col, p_schema, p_table using errcode = '22023';
    end if;
    if not bi.hub_column_allowed(col) then
      raise exception 'The column "%" cannot be used in Reporting', col using errcode = '42501';
    end if;
    if col = 'ctid' then raise exception 'The column "ctid" cannot be used' using errcode = '22023'; end if;
    if col = any(cols) then raise exception 'The column "%" is chosen twice', col using errcode = '22023'; end if;
    cols := cols || col;
  end loop;

  select c.relkind into existing from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'bi_data' and c.relname = p_name;
  if existing is not null and existing <> 'v' then
    raise exception 'A loaded table named "%" already exists; choose another name', p_name using errcode = '23505';
  end if;
  execute format('drop view if exists %I.%I', 'bi_data', p_name);
  -- Reporting counts each record once by its row id (ctid), which a view does not have: pass the source's on
  -- (a view as source gets a running number instead)
  execute format('create view %I.%I as select %s, %s as ctid from %I.%I', 'bi_data', p_name,
                 (select string_agg(format('%I', x), ', ') from unnest(cols) x),
                 case when (select c.relkind from pg_catalog.pg_class c where c.oid = src) in ('r', 'p', 'm') then 'ctid'
                      else 'pg_catalog.format(''(0,%s)'', pg_catalog.row_number() over ())::tid' end,
                 p_schema, p_table);
  execute format('revoke all on %I.%I from public, anon, authenticated', 'bi_data', p_name);
  execute format('grant select on %I.%I to service_role', 'bi_data', p_name);

  insert into bi.data_tables (table_name, job_id, group_name, description, columns, row_count, last_loaded_at, last_run_id)
  values (p_name, null, null, coalesce(nullif(btrim(p_description), ''), format('Hub: %s.%s (live)', p_schema, p_table)),
          (select jsonb_agg(jsonb_build_object('name', a.attname, 'type', pg_catalog.format_type(a.atttypid, a.atttypmod)) order by a.attnum)
             from pg_catalog.pg_attribute a where a.attrelid = pg_catalog.to_regclass(format('%I.%I', 'bi_data', p_name)) and a.attnum > 0
               and a.attname <> 'ctid'),
          bi.hub_row_count(src), now(), null)
  on conflict (table_name) do update set job_id = null, group_name = null, description = excluded.description,
    columns = excluded.columns, row_count = excluded.row_count, last_loaded_at = excluded.last_loaded_at, last_run_id = null;
  return array_length(cols, 1);
end;
$$;

-- p = {name, description, schema, table, columns: ["col", ...]}
create function public.bi_save_hub_view(p jsonb)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  is_new boolean;
begin
  perform bi.require_admin();
  perform bi.check_connector_name(p->>'name', 'hub');
  if length(coalesce(p->>'description', '')) > 500 then raise exception 'The description is too long' using errcode = '22023'; end if;
  is_new := not exists (select 1 from bi.connectors c where c.name = p->>'name');
  perform bi.hub_build(p->>'name', p->>'schema', p->>'table', coalesce(p->'columns', '[]'), p->>'description');
  insert into bi.connectors (name, kind, description, agent_name, config, interval_minutes, enabled, reload_requested,
                             last_run_at, last_status, last_error, last_row_count, created_by, updated_by)
  values (p->>'name', 'hub', coalesce(p->>'description', ''), null,
          jsonb_build_object('schema', p->>'schema', 'table', p->>'table', 'columns', p->'columns'), null, true, false,
          now(), 'success', null, (select row_count from bi.data_tables where table_name = p->>'name'), auth.uid(), auth.uid())
  on conflict (name) do update set description = excluded.description, config = excluded.config, last_run_at = now(),
    last_status = 'success', last_error = null, last_row_count = excluded.last_row_count, updated_by = auth.uid();
  insert into bi.audit_log (actor, actor_id, action, object_type, object_name, details)
  values (bi.app_actor(), auth.uid(), case when is_new then 'add' else 'change' end, 'connector', p->>'name',
          jsonb_build_object('kind', 'hub', 'source', (p->>'schema') || '.' || (p->>'table'), 'columns', p->'columns'));
end;
$$;

-- Reload: web/folder/... ask the agent; a Hub view is rebuilt straight away (new column types, row count)
create or replace function public.bi_reload_connector(p_name text)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  c bi.connectors;
begin
  perform bi.require_admin();
  select * into c from bi.connectors k where k.name = p_name and k.kind <> 'upload';
  if c.id is null then raise exception 'No web, folder or Hub connection named %', p_name using errcode = 'P0002'; end if;
  if c.kind = 'hub' then
    begin
      perform bi.hub_build(c.name, c.config->>'schema', c.config->>'table', c.config->'columns', c.description);
      update bi.connectors set last_run_at = now(), last_status = 'success', last_error = null,
        last_row_count = (select row_count from bi.data_tables where table_name = c.name) where id = c.id;
    exception when others then
      update bi.connectors set last_run_at = now(), last_status = 'error', last_error = left(sqlerrm, 500) where id = c.id;
    end;
  else
    update bi.connectors set reload_requested = true where id = c.id;
  end if;
  insert into bi.audit_log (actor, actor_id, action, object_type, object_name)
  values (bi.app_actor(), auth.uid(), 'reload_requested', 'connector', p_name);
end;
$$;

create or replace function public.bi_delete_connector(p_name text, p_drop_table boolean default true)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  k text;
begin
  perform bi.require_admin();
  delete from bi.connectors where name = p_name returning kind into k;
  if k is null then raise exception 'No connector named %', p_name using errcode = 'P0002'; end if;
  if k = 'hub' then
    execute format('drop view if exists %I.%I', 'bi_data', p_name);
    delete from bi.data_tables where table_name = p_name;
  elsif coalesce(p_drop_table, true) and not exists (select 1 from bi.load_jobs j where j.target_table = p_name) then
    execute format('drop table if exists %I.%I', 'bi_data', p_name);
    delete from bi.data_tables where table_name = p_name;
  end if;
  execute format('drop table if exists %I.%I', 'bi', bi.upload_stage(p_name));
  insert into bi.audit_log (actor, actor_id, action, object_type, object_name, details)
  values (bi.app_actor(), auth.uid(), 'remove', 'connector', p_name, jsonb_build_object('kind', k, 'table_removed', k = 'hub' or coalesce(p_drop_table, true)));
end;
$$;

-- The catalogue: Hub views are live, so their row count is the source table's current estimate and they are "loaded now"
create or replace function public.bi_data_tables()
returns table (
  table_name text, description text, group_name text, columns jsonb, row_count bigint,
  last_loaded_at timestamptz, last_status text, interval_minutes integer, source text
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.can_access_workspace('reporting') then
    raise exception 'Reporting access is required' using errcode = '42501';
  end if;
  return query
    select d.table_name, d.description, d.group_name, d.columns,
           case when c.kind = 'hub' then coalesce((select case when r.reltuples >= 0 then r.reltuples::bigint end from pg_catalog.pg_class r
                                                   where r.oid = pg_catalog.to_regclass(format('%I.%I', c.config->>'schema', c.config->>'table'))), d.row_count)
                else d.row_count end,
           case when c.kind = 'hub' then now() else d.last_loaded_at end,
           coalesce(j.last_status, c.last_status), coalesce(g.interval_minutes, j.interval_minutes, c.interval_minutes),
           coalesce(c.kind, case when j.id is not null then 'erp' end, 'other')
    from bi.data_tables d
    left join bi.load_jobs j on j.target_table = d.table_name
    left join bi.load_groups g on g.name = j.group_name
    left join bi.connectors c on c.name = d.table_name
    order by d.table_name;
end;
$$;

revoke all on function bi.hub_table_allowed(text, text), bi.hub_column_allowed(text), bi.hub_build(text, text, text, jsonb, text),
  bi.hub_row_count(oid)
  from public, anon, authenticated;
revoke all on function public.bi_hub_sources(), public.bi_save_hub_view(jsonb) from public, anon;
grant execute on function public.bi_hub_sources(), public.bi_save_hub_view(jsonb) to authenticated;
