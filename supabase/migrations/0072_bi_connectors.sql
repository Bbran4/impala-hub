-- Impala Hub Reporting: data connectors for data that does not come from the ERP.
--
-- The ERP is still loaded only from tables.toml on the agent machine (unchanged). Connectors add:
--   * upload  - an Excel/CSV file uploaded by an administrator in the browser (chunked RPCs below)
--   * web     - a web API (JSON or CSV) fetched by the agent
--   * folder  - Excel/CSV files from a folder fetched by the agent
-- Every connector loads one table into bi_data with the connector's name, so apps use it like any
-- other loaded table.
--
-- Security
--   * Only administrators manage connectors (bi.require_admin).
--   * Web and folder connectors only say WHAT to fetch. The agent decides whether it MAY: its
--     config.toml lists the allowed web hosts, the allowed folders (by alias) and which secret may be
--     sent to which host. A connector can reference a secret as ${NAME} in a header but never sees
--     its value; the database never stores secrets.
--   * Uploads go through a staging table and typed columns from a fixed list; values are inserted
--     with jsonb_to_recordset, never as SQL text. A connector name can never replace a table loaded
--     by the agent from tables.toml.
-- Migration numbering: Reporting uses even numbers (see supabase/README.md).

create table bi.connectors (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (name ~ '^[a-z][a-z0-9_]{0,62}$'),
  kind text not null check (kind in ('upload', 'web', 'folder')),
  description text not null default '' check (length(description) <= 500),
  agent_name text,
  config jsonb not null default '{}' check (jsonb_typeof(config) = 'object'),
  interval_minutes integer check (interval_minutes is null or interval_minutes >= 5),
  enabled boolean not null default true,
  reload_requested boolean not null default false,
  last_run_at timestamptz,
  last_status text check (last_status in ('running', 'success', 'error')),
  last_error text,
  last_row_count bigint,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_runs_web_and_folder check (kind = 'upload' or agent_name is not null)
);
alter table bi.connectors enable row level security;
grant all on bi.connectors to service_role;
grant select, update on bi.connectors to bi_agent;
create policy "agent reads connectors" on bi.connectors for select to bi_agent using (true);
create policy "agent updates connectors" on bi.connectors for update to bi_agent using (true) with check (true);
create trigger connectors_touch before update on bi.connectors for each row execute function bi.touch_updated_at();

-- what each agent allows: {"hosts": [...], "folders": [...], "secrets": {"NAME": "host"}} (names only)
alter table bi.agents add column if not exists connector_options jsonb not null default '{}';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function bi.check_connector_name(p_name text, p_kind text)
returns void language plpgsql stable security definer set search_path = ''
as $$
declare
  existing text;
begin
  if coalesce(p_name, '') !~ '^[a-z][a-z0-9_]{0,62}$' then
    raise exception 'The table name must start with a letter and use only lower case letters, digits and _' using errcode = '22023';
  end if;
  if exists (select 1 from bi.load_jobs j where j.target_table = p_name) then
    raise exception 'A table named "%" is already loaded from the ERP; choose another name', p_name using errcode = '23505';
  end if;
  select c.kind into existing from bi.connectors c where c.name = p_name;
  if existing is not null and existing <> p_kind then
    raise exception 'A % connector named "%" already exists', existing, p_name using errcode = '23505';
  end if;
  if existing is null and exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                                  where n.nspname = 'bi_data' and c.relname = p_name) then
    raise exception 'A table named "%" already exists in the loaded data; choose another name', p_name using errcode = '23505';
  end if;
end;
$$;

create function bi.upload_stage(p_name text)
returns text language sql immutable as $$ select 'upload_stage_' || p_name $$;

-- ---------------------------------------------------------------------------
-- Listing and managing connectors (administrators)
-- ---------------------------------------------------------------------------
create function public.bi_list_connectors()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  perform bi.require_admin();
  return jsonb_build_object(
    'connectors', coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object('row_count', d.row_count, 'last_loaded_at', d.last_loaded_at, 'columns', d.columns)
        order by c.name) from bi.connectors c left join bi.data_tables d on d.table_name = c.name), '[]'),
    'agents', coalesce((select jsonb_agg(jsonb_build_object('name', a.name, 'last_seen_at', a.last_seen_at, 'version', a.version, 'connector_options', a.connector_options)
        order by a.name) from bi.agents a), '[]'));
end;
$$;

-- Create or change a web or folder connector. p = {name, kind, description, agent_name, config, interval_minutes, enabled}
create function public.bi_save_connector(p jsonb)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  k text := p->>'kind';
  cfg jsonb := coalesce(p->'config', '{}');
  h jsonb;
  is_new boolean;
begin
  perform bi.require_admin();
  if k not in ('web', 'folder') then raise exception 'Only web and folder connectors are saved here; upload a file for an upload' using errcode = '22023'; end if;
  perform bi.check_connector_name(p->>'name', k);
  if coalesce(p->>'agent_name', '') = '' then raise exception 'Choose the agent that runs this connector' using errcode = '22023'; end if;
  if jsonb_typeof(cfg) <> 'object' or pg_column_size(cfg) > 20000 then raise exception 'Invalid connector settings' using errcode = '22023'; end if;
  if (p->>'interval_minutes') is not null and (p->>'interval_minutes')::int < 5 then
    raise exception 'The schedule must be at least every 5 minutes' using errcode = '22023';
  end if;
  if k = 'web' then
    if coalesce(cfg->>'url', '') !~ '^https?://[^\s/$.?#][^\s]*$' or length(cfg->>'url') > 2000 then
      raise exception 'Enter a web address starting with https://' using errcode = '22023';
    end if;
    if coalesce(cfg->>'format', 'json') not in ('json', 'csv') then raise exception 'Format must be json or csv' using errcode = '22023'; end if;
    if jsonb_typeof(coalesce(cfg->'headers', '[]')) <> 'array' or jsonb_array_length(coalesce(cfg->'headers', '[]')) > 10 then
      raise exception 'At most 10 headers' using errcode = '22023';
    end if;
    for h in select * from jsonb_array_elements(coalesce(cfg->'headers', '[]')) loop
      if coalesce(h->>'name', '') !~ '^[A-Za-z0-9-]{1,64}$' or length(coalesce(h->>'value', '')) > 1000 then
        raise exception 'Invalid header "%"', h->>'name' using errcode = '22023';
      end if;
    end loop;
    if length(coalesce(cfg->>'records_path', '')) > 200 then raise exception 'The records path is too long' using errcode = '22023'; end if;
  else
    if coalesce(cfg->>'folder', '') !~ '^[a-z][a-z0-9_]{0,62}$' then raise exception 'Choose one of the agent''s folders' using errcode = '22023'; end if;
    if coalesce(cfg->>'pattern', '') !~ '^[A-Za-z0-9 _.*?()-]{1,100}$' then
      raise exception 'The file pattern may use letters, digits, spaces, . _ - ( ) and the wildcards * and ?' using errcode = '22023';
    end if;
    if coalesce(cfg->>'combine', 'latest') not in ('latest', 'all') then raise exception 'Combine must be latest or all' using errcode = '22023'; end if;
    if length(coalesce(cfg->>'sheet', '')) > 100 then raise exception 'The sheet name is too long' using errcode = '22023'; end if;
  end if;

  is_new := not exists (select 1 from bi.connectors c where c.name = p->>'name');
  insert into bi.connectors (name, kind, description, agent_name, config, interval_minutes, enabled, reload_requested, created_by, updated_by)
  values (p->>'name', k, coalesce(p->>'description', ''), p->>'agent_name', cfg, (p->>'interval_minutes')::int,
          coalesce((p->>'enabled')::boolean, true), true, auth.uid(), auth.uid())
  on conflict (name) do update set description = excluded.description, agent_name = excluded.agent_name, config = excluded.config,
    interval_minutes = excluded.interval_minutes, enabled = excluded.enabled, reload_requested = true, updated_by = auth.uid();
  insert into bi.audit_log (actor, actor_id, action, object_type, object_name, details)
  values (bi.app_actor(), auth.uid(), case when is_new then 'add' else 'change' end, 'connector', p->>'name',
          jsonb_build_object('kind', k, 'agent', p->>'agent_name', 'config', cfg - 'headers',
                             'headers', (select jsonb_agg(x->>'name') from jsonb_array_elements(coalesce(cfg->'headers', '[]')) x)));
end;
$$;

create function public.bi_reload_connector(p_name text)
returns void language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform bi.require_admin();
  update bi.connectors set reload_requested = true where name = p_name and kind <> 'upload';
  if not found then raise exception 'No web or folder connector named %', p_name using errcode = 'P0002'; end if;
  insert into bi.audit_log (actor, actor_id, action, object_type, object_name)
  values (bi.app_actor(), auth.uid(), 'reload_requested', 'connector', p_name);
end;
$$;

-- Remove a connector; p_drop_table also removes its loaded table (apps using it will show an error).
create function public.bi_delete_connector(p_name text, p_drop_table boolean default true)
returns void language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform bi.require_admin();
  delete from bi.connectors where name = p_name;
  if not found then raise exception 'No connector named %', p_name using errcode = 'P0002'; end if;
  if coalesce(p_drop_table, true) and not exists (select 1 from bi.load_jobs j where j.target_table = p_name) then
    execute format('drop table if exists %I.%I', 'bi_data', p_name);
    delete from bi.data_tables where table_name = p_name;
  end if;
  execute format('drop table if exists %I.%I', 'bi', bi.upload_stage(p_name));
  insert into bi.audit_log (actor, actor_id, action, object_type, object_name, details)
  values (bi.app_actor(), auth.uid(), 'remove', 'connector', p_name, jsonb_build_object('table_removed', coalesce(p_drop_table, true)));
end;
$$;

-- ---------------------------------------------------------------------------
-- Upload: begin (columns) -> rows (chunks of up to 5,000) -> finish (swap into bi_data)
-- ---------------------------------------------------------------------------
create function public.bi_upload_begin(p_name text, p_columns jsonb)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  c jsonb;
  defs text[] := '{}';
  seen text[] := '{}';
begin
  perform bi.require_admin();
  perform bi.check_connector_name(p_name, 'upload');
  if jsonb_typeof(p_columns) <> 'array' or jsonb_array_length(p_columns) = 0 or jsonb_array_length(p_columns) > 300 then
    raise exception 'An upload needs 1 to 300 columns' using errcode = '22023';
  end if;
  for c in select * from jsonb_array_elements(p_columns) loop
    if coalesce(c->>'name', '') !~ '^[a-z][a-z0-9_]{0,62}$' or c->>'name' = '_bi_loaded_at' then
      raise exception 'Column name "%" must start with a letter and use only lower case letters, digits and _', c->>'name' using errcode = '22023';
    end if;
    if c->>'name' = any(seen) then raise exception 'Column "%" appears twice', c->>'name' using errcode = '22023'; end if;
    if coalesce(c->>'type', '') not in ('text', 'bigint', 'numeric', 'date', 'timestamp', 'boolean') then
      raise exception 'Column "%" has an unknown type', c->>'name' using errcode = '22023';
    end if;
    seen := seen || (c->>'name');
    defs := defs || format('%I %s', c->>'name', case c->>'type' when 'timestamp' then 'timestamp without time zone' else c->>'type' end);
  end loop;
  execute format('drop table if exists %I.%I', 'bi', bi.upload_stage(p_name));
  execute format('create table %I.%I (%s)', 'bi', bi.upload_stage(p_name), array_to_string(defs, ', '));
  execute format('revoke all on %I.%I from public, anon, authenticated', 'bi', bi.upload_stage(p_name));
end;
$$;

create function public.bi_upload_rows(p_name text, p_rows jsonb)
returns integer language plpgsql volatile security definer set search_path = ''
as $$
declare
  cols text;
  total bigint;
begin
  perform bi.require_admin();
  if coalesce(p_name, '') !~ '^[a-z][a-z0-9_]{0,62}$' then raise exception 'Invalid name' using errcode = '22023'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'Send at most 5,000 rows at a time' using errcode = '22023';
  end if;
  select string_agg(format('%I %s', a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod)), ', ' order by a.attnum) into cols
  from pg_catalog.pg_attribute a join pg_catalog.pg_class t on t.oid = a.attrelid join pg_catalog.pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'bi' and t.relname = bi.upload_stage(p_name) and a.attnum > 0 and not a.attisdropped;
  if cols is null then raise exception 'Start the upload first' using errcode = 'P0002'; end if;
  begin
    execute format('insert into %I.%I select * from jsonb_to_recordset($1) as x(%s)', 'bi', bi.upload_stage(p_name), cols) using p_rows;
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
    raise exception 'A value does not fit its column type: %', sqlerrm using errcode = '22023';
  end;
  execute format('select count(*) from %I.%I', 'bi', bi.upload_stage(p_name)) into total;
  if total > 1000000 then raise exception 'An upload can have at most 1,000,000 rows' using errcode = '22023'; end if;
  return jsonb_array_length(p_rows);
end;
$$;

create function public.bi_upload_finish(p_name text, p_description text default '', p_file text default '')
returns bigint language plpgsql volatile security definer set search_path = ''
as $$
declare
  total bigint;
  cols jsonb;
  is_new boolean;
begin
  perform bi.require_admin();
  perform bi.check_connector_name(p_name, 'upload');
  if not exists (select 1 from pg_catalog.pg_class t join pg_catalog.pg_namespace n on n.oid = t.relnamespace
                 where n.nspname = 'bi' and t.relname = bi.upload_stage(p_name)) then
    raise exception 'Start the upload first' using errcode = 'P0002';
  end if;
  execute format('select count(*) from %I.%I', 'bi', bi.upload_stage(p_name)) into total;
  execute format('alter table %I.%I add column _bi_loaded_at timestamptz not null default now()', 'bi', bi.upload_stage(p_name));
  execute format('drop table if exists %I.%I', 'bi_data', p_name);
  execute format('alter table %I.%I set schema %I', 'bi', bi.upload_stage(p_name), 'bi_data');
  execute format('alter table %I.%I rename to %I', 'bi_data', bi.upload_stage(p_name), p_name);
  execute format('revoke all on %I.%I from public, anon, authenticated', 'bi_data', p_name);
  execute format('grant select on %I.%I to service_role', 'bi_data', p_name);
  select jsonb_agg(jsonb_build_object('name', a.attname, 'type', pg_catalog.format_type(a.atttypid, a.atttypmod)) order by a.attnum) into cols
  from pg_catalog.pg_attribute a join pg_catalog.pg_class t on t.oid = a.attrelid join pg_catalog.pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'bi_data' and t.relname = p_name and a.attnum > 0 and not a.attisdropped;
  insert into bi.data_tables (table_name, job_id, group_name, description, columns, row_count, last_loaded_at)
  values (p_name, null, null, coalesce(nullif(p_description, ''), 'Uploaded from ' || coalesce(nullif(p_file, ''), 'a file')), cols, total, now())
  on conflict (table_name) do update set job_id = null, group_name = null, description = excluded.description,
    columns = excluded.columns, row_count = excluded.row_count, last_loaded_at = excluded.last_loaded_at;
  is_new := not exists (select 1 from bi.connectors c where c.name = p_name);
  insert into bi.connectors (name, kind, description, config, last_run_at, last_status, last_row_count, created_by, updated_by)
  values (p_name, 'upload', coalesce(p_description, ''), jsonb_build_object('file', coalesce(p_file, '')), now(), 'success', total, auth.uid(), auth.uid())
  on conflict (name) do update set description = excluded.description, config = excluded.config, last_run_at = now(),
    last_status = 'success', last_error = null, last_row_count = excluded.last_row_count, updated_by = auth.uid();
  insert into bi.audit_log (actor, actor_id, action, object_type, object_name, details)
  values (bi.app_actor(), auth.uid(), case when is_new then 'add' else 'change' end, 'upload', p_name,
          jsonb_build_object('file', p_file, 'rows', total));
  return total;
end;
$$;

-- The data catalogue shows where each table comes from: erp, upload, web or folder.
drop function public.bi_data_tables();
create function public.bi_data_tables()
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
    select d.table_name, d.description, d.group_name, d.columns, d.row_count, d.last_loaded_at,
           coalesce(j.last_status, c.last_status), coalesce(g.interval_minutes, j.interval_minutes, c.interval_minutes),
           coalesce(c.kind, case when j.id is not null then 'erp' end, 'other')
    from bi.data_tables d
    left join bi.load_jobs j on j.target_table = d.table_name
    left join bi.load_groups g on g.name = j.group_name
    left join bi.connectors c on c.name = d.table_name
    order by d.table_name;
end;
$$;

revoke all on function bi.check_connector_name(text, text), bi.upload_stage(text) from public, anon, authenticated;
revoke all on function public.bi_list_connectors(), public.bi_save_connector(jsonb), public.bi_reload_connector(text),
  public.bi_delete_connector(text, boolean), public.bi_upload_begin(text, jsonb), public.bi_upload_rows(text, jsonb),
  public.bi_upload_finish(text, text, text), public.bi_data_tables() from public, anon;
grant execute on function public.bi_list_connectors(), public.bi_save_connector(jsonb), public.bi_reload_connector(text),
  public.bi_delete_connector(text, boolean), public.bi_upload_begin(text, jsonb), public.bi_upload_rows(text, jsonb),
  public.bi_upload_finish(text, text, text), public.bi_data_tables() to authenticated;
