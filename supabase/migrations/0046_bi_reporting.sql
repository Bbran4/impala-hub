-- Impala Hub Reporting (BI) foundation: the data loader.
--
-- Data from external SQL sources (the ERP, over ODBC) is loaded by the on-premises
-- Impala BI sync agent (bi-agent/) into the bi_data schema. What is loaded is defined
-- in tables.toml on the agent machine and published here by the agent (`--apply`).
--
-- Security model
--   * bi and bi_data are NOT exposed to browsers: authenticated users have no table
--     privileges in either schema. The app reads and acts only through the
--     public.bi_* functions below, which check roles and audit every action.
--   * Only the agent (role bi_agent) defines what is loaded. Administrators can
--     trigger reloads and pause/resume schedules from the app, nothing else.
--   * The agent re-checks every job against its local tables.toml (SHA-256) before
--     running it, so changing a definition here cannot change what is read from the ERP.
--   * bi_agent can touch only bi/bi_data; it has no access to any other app data.
--
-- Access
--   * Reporting workspace: administrator, management and the new reporting role
--     (public.can_access_workspace('reporting')).
--   * Data loader controls, run history and audit log: administrator only.

-- ---------------------------------------------------------------------------
-- Reporting role and workspace
-- ---------------------------------------------------------------------------
insert into public.roles (id, label, description) values
  ('reporting', 'Reporting', 'Reporting dashboards and data')
on conflict (id) do nothing;

create or replace function public.can_access_workspace(workspace_name text)
returns boolean language sql stable security definer set search_path = public
as $$
  select public.is_active_user() and (
    public.has_role('administrator') or
    (workspace_name = 'sales_desk' and (public.has_role('sales') or public.has_role('management'))) or
    (workspace_name = 'returns_claims' and (public.has_role('returns') or public.has_role('management'))) or
    (workspace_name = 'marketing' and (public.has_role('marketing') or public.has_role('management'))) or
    (workspace_name = 'stock_control' and (public.has_role('stock') or public.has_role('management'))) or
    (workspace_name = 'reporting' and (public.has_role('reporting') or public.has_role('management')))
  );
$$;
revoke all on function public.can_access_workspace(text) from public, anon;
grant execute on function public.can_access_workspace(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Schemas
-- ---------------------------------------------------------------------------
create schema if not exists bi;
create schema if not exists bi_data;
comment on schema bi is 'Impala Hub Reporting: data loader metadata (agents, load groups and jobs, runs, audit).';
comment on schema bi_data is 'Impala Hub Reporting: tables loaded from external SQL sources by the sync agent.';
revoke all on schema bi, bi_data from public;

-- ---------------------------------------------------------------------------
-- Agents (heartbeat)
-- ---------------------------------------------------------------------------
create table bi.agents (
  name text primary key,
  sources text[] not null default '{}',
  app_requests jsonb not null default '{}',
  version text,
  hostname text,
  started_at timestamptz,
  last_seen_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Load groups: tables loaded together in one transaction on one schedule
-- ---------------------------------------------------------------------------
create table bi.load_groups (
  name text primary key check (name ~ '^[a-z][a-z0-9_]{0,62}$'),
  description text,
  interval_minutes integer check (interval_minutes is null or interval_minutes >= 1),
  managed_by text not null,
  enabled boolean not null default true,
  reload_requested boolean not null default false,
  full_reload_requested boolean not null default false,
  last_run_at timestamptz,
  last_status text check (last_status in ('running', 'success', 'error')),
  last_error text,
  applied_at timestamptz,
  applied_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Load jobs: one per loaded table
-- ---------------------------------------------------------------------------
create table bi.load_jobs (
  id bigint generated always as identity primary key,
  target_table text not null unique check (target_table ~ '^[a-z][a-z0-9_]{0,62}$'),
  description text,
  source_name text not null,
  group_name text references bi.load_groups (name) on update cascade,
  sql_query text not null,
  definition_sha256 text not null,
  load_mode text not null default 'full' check (load_mode in ('full', 'append', 'upsert')),
  key_columns text[] not null default '{}',
  incremental_column text,
  watermark_type text check (watermark_type in ('timestamp', 'date', 'integer', 'numeric', 'text')),
  initial_watermark text,
  watermark text,
  interval_minutes integer check (interval_minutes is null or interval_minutes >= 1),
  managed_by text not null,
  enabled boolean not null default true,
  reload_requested boolean not null default false,
  full_reload_requested boolean not null default false,
  last_run_at timestamptz,
  last_status text check (last_status in ('running', 'success', 'error')),
  last_error text,
  last_row_count bigint,
  applied_at timestamptz,
  applied_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint upsert_needs_keys check (load_mode <> 'upsert' or cardinality(key_columns) > 0),
  constraint incremental_needs_append_or_upsert check (incremental_column is null or load_mode in ('append', 'upsert')),
  constraint incremental_needs_type check (incremental_column is null or watermark_type is not null),
  constraint group_or_own_schedule check (group_name is null or interval_minutes is null)
);
create index load_jobs_group_idx on bi.load_jobs (group_name);

create function bi.touch_updated_at()
returns trigger language plpgsql set search_path = ''
as $$ begin new.updated_at := now(); return new; end; $$;
create trigger load_jobs_touch before update on bi.load_jobs for each row execute function bi.touch_updated_at();
create trigger load_groups_touch before update on bi.load_groups for each row execute function bi.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Sync runs, data catalogue, agent requests, audit log
-- ---------------------------------------------------------------------------
create table bi.sync_runs (
  id bigint generated always as identity primary key,
  batch_id uuid not null,
  job_id bigint references bi.load_jobs (id) on delete cascade,
  target_table text not null,
  group_name text,
  agent_name text,
  trigger text not null check (trigger in ('schedule', 'manual', 'full_reload')),
  status text not null default 'running' check (status in ('running', 'success', 'error')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  row_count bigint,
  watermark_before text,
  watermark_after text,
  error text
);
create index sync_runs_job_started_idx on bi.sync_runs (job_id, started_at desc);
create index sync_runs_started_idx on bi.sync_runs (started_at desc);
create index sync_runs_batch_idx on bi.sync_runs (batch_id);

create table bi.data_tables (
  table_name text primary key,
  job_id bigint references bi.load_jobs (id) on delete set null,
  group_name text,
  description text,
  columns jsonb not null default '[]',
  row_count bigint,
  last_loaded_at timestamptz,
  last_run_id bigint
);

create table bi.agent_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('test_connection', 'list_tables', 'list_columns', 'preview')),
  source_name text not null,
  payload jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'error')),
  result jsonb,
  error text,
  agent_name text,
  created_by uuid,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);
create index agent_requests_pending_idx on bi.agent_requests (created_at) where status = 'pending';

create table bi.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text not null,
  actor_id uuid,
  action text not null,
  object_type text not null,
  object_name text not null,
  details jsonb not null default '{}'
);
create index audit_log_at_idx on bi.audit_log (at desc);

alter table bi.agents enable row level security;
alter table bi.load_groups enable row level security;
alter table bi.load_jobs enable row level security;
alter table bi.sync_runs enable row level security;
alter table bi.data_tables enable row level security;
alter table bi.agent_requests enable row level security;
alter table bi.audit_log enable row level security;

-- ---------------------------------------------------------------------------
-- The sync agent role. Created without login; enable login and set the password
-- by hand in the SQL editor (see bi-agent/README.md) so it never lives in git.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'bi_agent') then
    create role bi_agent nologin noinherit nocreatedb nocreaterole noreplication;
  end if;
end
$$;
alter role bi_agent connection limit 10;
alter role bi_agent set statement_timeout = 0;
alter role bi_agent set idle_in_transaction_session_timeout = 0;
alter role bi_agent set search_path = '';

grant usage on schema bi to bi_agent;
grant usage, create on schema bi_data to bi_agent;
grant select, insert, update, delete on bi.load_groups, bi.load_jobs, bi.sync_runs, bi.data_tables to bi_agent;
grant select, insert, update on bi.agents to bi_agent;
grant select, update, delete on bi.agent_requests to bi_agent;
grant select, insert on bi.audit_log to bi_agent;

create policy "agent manages agents" on bi.agents for all to bi_agent using (true) with check (true);
create policy "agent manages groups" on bi.load_groups for all to bi_agent using (true) with check (true);
create policy "agent manages jobs" on bi.load_jobs for all to bi_agent using (true) with check (true);
create policy "agent manages runs" on bi.sync_runs for all to bi_agent using (true) with check (true);
create policy "agent manages catalogue" on bi.data_tables for all to bi_agent using (true) with check (true);
create policy "agent answers requests" on bi.agent_requests for all to bi_agent using (true) with check (true);
create policy "agent reads audit" on bi.audit_log for select to bi_agent using (true);
create policy "agent writes audit" on bi.audit_log for insert to bi_agent with check (true);

-- Server-side code (Vercel functions with the service-role key) may read everything.
grant usage on schema bi, bi_data to service_role;
grant all on all tables in schema bi to service_role;

-- ---------------------------------------------------------------------------
-- App API. Browsers use only these functions.
-- ---------------------------------------------------------------------------
create function bi.require_admin()
returns void language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (public.is_active_user() and public.has_role('administrator')) then
    raise exception 'Only administrators can manage the data loader' using errcode = '42501';
  end if;
end;
$$;

create function bi.app_actor()
returns text language sql stable security definer set search_path = ''
as $$
  select coalesce(nullif(p.display_name, ''), p.email, auth.uid()::text)
  from public.profiles p where p.id = auth.uid();
$$;

-- Loaded tables with freshness: everyone with Reporting access.
create function public.bi_data_tables()
returns table (
  table_name text, description text, group_name text, columns jsonb, row_count bigint,
  last_loaded_at timestamptz, last_status text, interval_minutes integer
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.can_access_workspace('reporting') then
    raise exception 'Reporting access is required' using errcode = '42501';
  end if;
  return query
    select d.table_name, d.description, d.group_name, d.columns, d.row_count, d.last_loaded_at,
           j.last_status, coalesce(g.interval_minutes, j.interval_minutes)
    from bi.data_tables d
    left join bi.load_jobs j on j.target_table = d.table_name
    left join bi.load_groups g on g.name = j.group_name
    order by d.table_name;
end;
$$;

-- Data loader status: administrators.
create function public.bi_load_status()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  perform bi.require_admin();
  return jsonb_build_object(
    'server_time', now(),
    'agents', coalesce((select jsonb_agg(to_jsonb(a) order by a.name) from bi.agents a), '[]'),
    'groups', coalesce((select jsonb_agg(to_jsonb(g) order by g.name) from bi.load_groups g), '[]'),
    'jobs', coalesce((select jsonb_agg(to_jsonb(j) || jsonb_build_object(
                        'row_count', d.row_count,
                        'last_loaded_at', d.last_loaded_at,
                        'columns', d.columns) order by j.target_table)
                      from bi.load_jobs j left join bi.data_tables d on d.table_name = j.target_table), '[]')
  );
end;
$$;

create function public.bi_sync_runs(p_limit integer default 200, p_table text default null)
returns setof bi.sync_runs language plpgsql stable security definer set search_path = ''
as $$
begin
  perform bi.require_admin();
  return query
    select * from bi.sync_runs r
    where p_table is null or r.target_table = p_table
    order by r.started_at desc, r.id desc
    limit least(greatest(coalesce(p_limit, 200), 1), 1000);
end;
$$;

create function public.bi_audit_log(p_limit integer default 200)
returns setof bi.audit_log language plpgsql stable security definer set search_path = ''
as $$
begin
  perform bi.require_admin();
  return query select * from bi.audit_log order by at desc, id desc limit least(greatest(coalesce(p_limit, 200), 1), 1000);
end;
$$;

-- "Reload now" (p_full = false) or "Reload everything" (p_full = true) for a table or group.
create function public.bi_request_reload(p_kind text, p_name text, p_full boolean default false)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  found_rows integer;
begin
  perform bi.require_admin();
  if p_kind = 'group' then
    update bi.load_groups
      set reload_requested = reload_requested or not coalesce(p_full, false),
          full_reload_requested = full_reload_requested or coalesce(p_full, false)
      where name = p_name;
  elsif p_kind = 'table' then
    update bi.load_jobs
      set reload_requested = reload_requested or not coalesce(p_full, false),
          full_reload_requested = full_reload_requested or coalesce(p_full, false)
      where target_table = p_name;
  else
    raise exception 'Kind must be table or group' using errcode = '22023';
  end if;
  get diagnostics found_rows = row_count;
  if found_rows = 0 then
    raise exception 'No % named %', p_kind, p_name using errcode = 'P0002';
  end if;
  insert into bi.audit_log (actor, actor_id, action, object_type, object_name)
  values (bi.app_actor(), auth.uid(), case when p_full then 'full_reload_requested' else 'reload_requested' end, p_kind, p_name);
end;
$$;

-- Pause / resume a table's or group's schedule.
create function public.bi_set_enabled(p_kind text, p_name text, p_enabled boolean)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  found_rows integer;
begin
  perform bi.require_admin();
  if p_enabled is null then
    raise exception 'Enabled must be true or false' using errcode = '22023';
  end if;
  if p_kind = 'group' then
    update bi.load_groups set enabled = p_enabled where name = p_name;
  elsif p_kind = 'table' then
    update bi.load_jobs set enabled = p_enabled where target_table = p_name;
  else
    raise exception 'Kind must be table or group' using errcode = '22023';
  end if;
  get diagnostics found_rows = row_count;
  if found_rows = 0 then
    raise exception 'No % named %', p_kind, p_name using errcode = 'P0002';
  end if;
  insert into bi.audit_log (actor, actor_id, action, object_type, object_name)
  values (bi.app_actor(), auth.uid(), case when p_enabled then 'resumed' else 'paused' end, p_kind, p_name);
end;
$$;

-- Ask the agent to test its connection to a source; poll bi_agent_request for the answer.
create function public.bi_test_connection(p_source text)
returns uuid language plpgsql volatile security definer set search_path = ''
as $$
declare
  request_id uuid;
begin
  perform bi.require_admin();
  if (select count(*) from bi.agent_requests where created_by = auth.uid() and created_at > now() - interval '1 minute') >= 10 then
    raise exception 'Too many requests; wait a minute' using errcode = '54000';
  end if;
  insert into bi.agent_requests (kind, source_name, created_by)
  values ('test_connection', p_source, auth.uid())
  returning id into request_id;
  return request_id;
end;
$$;

create function public.bi_agent_request(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  perform bi.require_admin();
  return (select to_jsonb(r) - 'payload' from bi.agent_requests r where r.id = p_id);
end;
$$;

revoke all on function bi.require_admin(), bi.app_actor(), bi.touch_updated_at() from public, anon, authenticated;
revoke all on function
  public.bi_data_tables(), public.bi_load_status(), public.bi_sync_runs(integer, text), public.bi_audit_log(integer),
  public.bi_request_reload(text, text, boolean), public.bi_set_enabled(text, text, boolean),
  public.bi_test_connection(text), public.bi_agent_request(uuid)
  from public, anon;
grant execute on function
  public.bi_data_tables(), public.bi_load_status(), public.bi_sync_runs(integer, text), public.bi_audit_log(integer),
  public.bi_request_reload(text, text, boolean), public.bi_set_enabled(text, text, boolean),
  public.bi_test_connection(text), public.bi_agent_request(uuid)
  to authenticated;
