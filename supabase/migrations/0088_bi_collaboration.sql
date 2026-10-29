-- Reporting batch 4: comments on charts, copying apps, a shared library of master items, version
-- history of apps and sheets, usage statistics and a data quality overview.

-- ---------------------------------------------------------------------------
-- Comments on charts (one thread per object); replies notify the others in the thread
-- ---------------------------------------------------------------------------
create table bi.comments (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references bi.apps (id) on delete cascade,
  sheet_id uuid not null references bi.sheets (id) on delete cascade,
  object_id text not null check (length(object_id) between 1 and 64),
  author uuid not null,
  body text not null check (length(btrim(body)) between 1 and 2000),
  resolved boolean not null default false,
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index comments_sheet_idx on bi.comments (sheet_id, object_id, created_at);
alter table bi.comments enable row level security;
grant all on bi.comments to service_role;

create function public.bi_list_comments(p_app uuid, p_sheet uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not bi.can_view_app(p_app) then raise exception 'You do not have access to this app' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'object_id', c.object_id, 'body', c.body, 'resolved', c.resolved,
      'author', coalesce(nullif(p.display_name, ''), p.email), 'mine', c.author = auth.uid(), 'created_at', c.created_at, 'edited_at', c.edited_at)
      order by c.created_at)
    from bi.comments c left join public.profiles p on p.id = c.author
    where c.app_id = p_app and c.sheet_id = p_sheet), '[]');
end;
$$;

create function public.bi_add_comment(p_app uuid, p_sheet uuid, p_object text, p_body text)
returns uuid language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_title text;
  v_sheet text;
  v_app text;
  v_author text := bi.app_actor();
begin
  if not bi.can_view_app(p_app) then raise exception 'You do not have access to this app' using errcode = '42501'; end if;
  select s.title, (select o->>'title' from jsonb_array_elements(s.objects) o where o->>'id' = p_object limit 1) into v_sheet, v_title
  from bi.sheets s where s.id = p_sheet and s.app_id = p_app;
  if v_sheet is null then raise exception 'Sheet not found' using errcode = 'P0002'; end if;
  if length(btrim(coalesce(p_body, ''))) not between 1 and 2000 then raise exception 'Write a comment (up to 2,000 characters)' using errcode = '22023'; end if;
  insert into bi.comments (app_id, sheet_id, object_id, author, body) values (p_app, p_sheet, p_object, auth.uid(), btrim(p_body)) returning id into v_id;
  select a.name into v_app from bi.apps a where a.id = p_app;
  -- notify everyone else in the thread who can still open the app
  insert into public.user_notifications (user_id, channel, kind, title, description, target_page, actor_user_id, metadata)
  select distinct c.author, 'reporting', 'bi_comment',
         left(format('%s commented on %s', v_author, coalesce(nullif(v_title, ''), 'a chart')), 180),
         left(format('%s · %s: %s', v_app, v_sheet, btrim(p_body)), 500), 'Dashboards', auth.uid(),
         jsonb_build_object('app_id', p_app, 'sheet_id', p_sheet, 'object_id', p_object)
  from bi.comments c
  where c.sheet_id = p_sheet and c.object_id = p_object and c.author <> auth.uid() and bi.user_can_view_app(p_app, c.author);
  return v_id;
end;
$$;

create function public.bi_update_comment(p_id uuid, p_body text, p_resolved boolean)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  c bi.comments;
begin
  select * into c from bi.comments x where x.id = p_id;
  if c.id is null or not bi.can_view_app(c.app_id) then raise exception 'Comment not found' using errcode = 'P0002'; end if;
  if p_body is not null then
    if c.author <> auth.uid() then raise exception 'You can only edit your own comments' using errcode = '42501'; end if;
    if length(btrim(p_body)) not between 1 and 2000 then raise exception 'Write a comment (up to 2,000 characters)' using errcode = '22023'; end if;
    update bi.comments x set body = btrim(p_body), edited_at = now() where x.id = p_id;
  end if;
  if p_resolved is not null then update bi.comments x set resolved = p_resolved where x.id = p_id; end if;
end;
$$;

create function public.bi_delete_comment(p_id uuid)
returns void language plpgsql volatile security definer set search_path = ''
as $$
begin
  delete from bi.comments c where c.id = p_id and (c.author = auth.uid() or (bi.can_build() and bi.can_view_app(c.app_id)));
  if not found then raise exception 'Comment not found' using errcode = 'P0002'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Version history: the previous version of an app's definition or a sheet is kept on every change
-- (the last 50 of each), so it can be restored
-- ---------------------------------------------------------------------------
create table bi.versions (
  id bigint generated always as identity primary key,
  app_id uuid not null references bi.apps (id) on delete cascade,
  kind text not null check (kind in ('app', 'sheet')),
  object_id uuid not null,
  label text not null default '',
  data jsonb not null,
  saved_by uuid,
  saved_at timestamptz not null default now(),
  deleted boolean not null default false
);
create index versions_app_idx on bi.versions (app_id, saved_at desc);
alter table bi.versions enable row level security;
grant all on bi.versions to service_role;

create function bi.keep_sheet_version()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.objects = new.objects and old.title = new.title then return new; end if;
  -- the whole app is being deleted: nothing to keep
  if tg_op = 'DELETE' and not exists (select 1 from bi.apps a where a.id = old.app_id) then return old; end if;
  insert into bi.versions (app_id, kind, object_id, label, data, saved_by, deleted)
  values (old.app_id, 'sheet', old.id, old.title, jsonb_build_object('title', old.title, 'position', old.position, 'objects', old.objects),
          coalesce(old.updated_by, auth.uid()), tg_op = 'DELETE');
  delete from bi.versions v where v.kind = 'sheet' and v.object_id = old.id and v.id not in (
    select x.id from bi.versions x where x.kind = 'sheet' and x.object_id = old.id order by x.saved_at desc, x.id desc limit 50);
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger sheets_keep_version after update or delete on bi.sheets for each row execute function bi.keep_sheet_version();

create function bi.keep_app_version()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  -- every save of the app keeps the version before it (including the data model, which bi_save_app
  -- replaces right after updating the app row); follow-up updates that change nothing are skipped
  if old.measures = new.measures and old.variables = new.variables and old.calc_fields = new.calc_fields
     and old.name = new.name and old.description = new.description and old.updated_at = new.updated_at then
    return new;
  end if;
  insert into bi.versions (app_id, kind, object_id, label, data, saved_by)
  values (old.id, 'app', old.id, old.name, jsonb_build_object('name', old.name, 'description', old.description, 'measures', old.measures,
          'variables', old.variables, 'calc_fields', old.calc_fields,
          'model', (select coalesce(jsonb_agg(jsonb_build_object('alias', t.alias, 'table_name', t.table_name, 'parent_alias', t.parent_alias,
             'join_type', t.join_type, 'join_pairs', t.join_pairs) order by t.position), '[]') from bi.app_tables t where t.app_id = old.id)),
          coalesce(old.updated_by, auth.uid()));
  delete from bi.versions v where v.kind = 'app' and v.object_id = old.id and v.id not in (
    select x.id from bi.versions x where x.kind = 'app' and x.object_id = old.id order by x.saved_at desc, x.id desc limit 50);
  return new;
end;
$$;
-- when the app is saved (row access changes other columns and has its own audit log)
create trigger apps_keep_version after update of name, description, measures, variables, calc_fields on bi.apps
  for each row execute function bi.keep_app_version();

create function public.bi_list_versions(p_app uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  perform bi.require_builder();
  return coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'kind', v.kind, 'object_id', v.object_id, 'label', v.label,
      'saved_at', v.saved_at, 'saved_by', coalesce(nullif(p.display_name, ''), p.email), 'deleted', v.deleted,
      'exists', case when v.kind = 'sheet' then exists (select 1 from bi.sheets s where s.id = v.object_id) else true end,
      'summary', case when v.kind = 'sheet' then jsonb_build_object('objects', jsonb_array_length(v.data->'objects'))
                      else jsonb_build_object('tables', jsonb_array_length(v.data->'model'), 'measures', jsonb_array_length(v.data->'measures')) end)
      order by v.saved_at desc, v.id desc)
    from (select * from bi.versions x where x.app_id = p_app order by x.saved_at desc, x.id desc limit 200) v
    left join public.profiles p on p.id = v.saved_by), '[]');
end;
$$;

create function public.bi_restore_version(p_id bigint)
returns uuid language plpgsql volatile security definer set search_path = ''
as $$
declare
  v bi.versions;
  v_sheet uuid;
begin
  perform bi.require_builder();
  select * into v from bi.versions x where x.id = p_id;
  if v.id is null then raise exception 'Version not found' using errcode = 'P0002'; end if;
  if v.kind = 'sheet' then
    if exists (select 1 from bi.sheets s where s.id = v.object_id) then
      update bi.sheets s set title = v.data->>'title', objects = v.data->'objects', updated_by = auth.uid(), updated_at = now() where s.id = v.object_id;
      v_sheet := v.object_id;
    else
      insert into bi.sheets (id, app_id, title, position, objects, created_by, updated_by)
      values (v.object_id, v.app_id, v.data->>'title', coalesce((v.data->>'position')::int, 0), v.data->'objects', auth.uid(), auth.uid());
      v_sheet := v.object_id;
    end if;
  else
    -- the model and calculated fields come back only if their tables are still loaded
    if exists (select 1 from jsonb_array_elements(v.data->'model') t where not exists (select 1 from bi.data_tables d where d.table_name = t->>'table_name')) then
      raise exception 'A table in that version is no longer loaded, so it cannot be restored' using errcode = '22023';
    end if;
    update bi.apps a set name = v.data->>'name', description = v.data->>'description', measures = v.data->'measures',
      variables = v.data->'variables', calc_fields = coalesce(v.data->'calc_fields', '[]'), updated_by = auth.uid(), updated_at = now()
    where a.id = v.app_id;
    delete from bi.app_tables t where t.app_id = v.app_id;
    insert into bi.app_tables (app_id, alias, table_name, parent_alias, join_type, join_pairs, position)
    select v.app_id, t->>'alias', t->>'table_name', t->>'parent_alias', coalesce(t->>'join_type', 'left'), coalesce(t->'join_pairs', '[]'), (n - 1)::int
    from jsonb_array_elements(v.data->'model') with ordinality x(t, n);
  end if;
  insert into bi.audit_log (actor, actor_id, action, object_type, object_name, details)
  values (bi.app_actor(), auth.uid(), 'restore', case when v.kind = 'sheet' then 'sheet' else 'app' end, v.label,
          jsonb_build_object('app_id', v.app_id, 'version', v.id, 'saved_at', v.saved_at));
  return coalesce(v_sheet, v.app_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Copy an app (data model, measures, variables, calculated fields, sheets; optionally who can open it)
-- ---------------------------------------------------------------------------
create function public.bi_copy_app(p_app uuid, p_name text, p_with_access boolean default false)
returns uuid language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_new uuid;
  a bi.apps;
begin
  perform bi.require_builder();
  select * into a from bi.apps x where x.id = p_app;
  if a.id is null then raise exception 'App not found' using errcode = 'P0002'; end if;
  if length(btrim(coalesce(p_name, ''))) not between 1 and 120 then raise exception 'Give the copy a name' using errcode = '22023'; end if;
  insert into bi.apps (name, description, measures, variables, calc_fields, created_by, updated_by)
  values (btrim(p_name), a.description, a.measures, a.variables, a.calc_fields, auth.uid(), auth.uid()) returning id into v_new;
  insert into bi.app_tables (app_id, alias, table_name, parent_alias, join_type, join_pairs, position)
  select v_new, t.alias, t.table_name, t.parent_alias, t.join_type, t.join_pairs, t.position from bi.app_tables t where t.app_id = p_app;
  insert into bi.sheets (app_id, title, position, objects, created_by, updated_by)
  select v_new, s.title, s.position, s.objects, auth.uid(), auth.uid() from bi.sheets s where s.app_id = p_app;
  if p_with_access then
    insert into bi.app_access (app_id, principal_type, principal) select v_new, x.principal_type, x.principal from bi.app_access x where x.app_id = p_app;
  end if;
  insert into bi.audit_log (actor, actor_id, action, object_type, object_name, details)
  values (bi.app_actor(), auth.uid(), 'add', 'app', btrim(p_name), jsonb_build_object('app_id', v_new, 'copied_from', a.name));
  return v_new;
exception when unique_violation then
  raise exception 'An app named "%" already exists', btrim(p_name) using errcode = '23505';
end;
$$;

-- ---------------------------------------------------------------------------
-- Library: master measures and dimensions shared between apps (copied into an app when used)
-- ---------------------------------------------------------------------------
create table bi.library_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('measure', 'dimension')),
  name text not null check (length(btrim(name)) between 1 and 80),
  expression text not null check (length(expression) between 1 and 4000),
  format text check (format is null or format in ('auto', 'number', 'integer', 'money', 'percent')),
  description text not null default '' check (length(description) <= 500),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
create unique index library_items_name_idx on bi.library_items (kind, lower(btrim(name)));
alter table bi.library_items enable row level security;
grant all on bi.library_items to service_role;

create function public.bi_list_library()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  perform bi.require_builder();
  return coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'kind', l.kind, 'name', l.name, 'expression', l.expression, 'format', l.format,
      'description', l.description, 'updated_at', l.updated_at, 'updated_by', coalesce(nullif(p.display_name, ''), p.email),
      'used_in', (select count(*) from bi.apps a, jsonb_array_elements(a.measures) m where lower(btrim(m->>'name')) = lower(btrim(l.name)) and l.kind = 'measure'))
      order by l.kind, lower(l.name)) from bi.library_items l left join public.profiles p on p.id = l.updated_by), '[]');
end;
$$;

-- p = {id?, kind, name, expression, format, description}
create function public.bi_save_library_item(p jsonb)
returns uuid language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid;
begin
  perform bi.require_builder();
  if v_id is null then
    insert into bi.library_items (kind, name, expression, format, description, updated_by)
    values (p->>'kind', btrim(p->>'name'), p->>'expression', nullif(p->>'format', ''), coalesce(p->>'description', ''), auth.uid())
    on conflict (kind, lower(btrim(name))) do update set expression = excluded.expression, format = excluded.format,
      description = excluded.description, updated_by = excluded.updated_by, updated_at = now()
    returning id into v_id;
  else
    update bi.library_items l set kind = p->>'kind', name = btrim(p->>'name'), expression = p->>'expression', format = nullif(p->>'format', ''),
      description = coalesce(p->>'description', ''), updated_by = auth.uid(), updated_at = now() where l.id = v_id;
    if not found then raise exception 'Library item not found' using errcode = 'P0002'; end if;
  end if;
  insert into bi.audit_log (actor, actor_id, action, object_type, object_name)
  values (bi.app_actor(), auth.uid(), 'change', 'library ' || (p->>'kind'), btrim(p->>'name'));
  return v_id;
exception when unique_violation then
  raise exception 'The library already has a % named "%"', p->>'kind', btrim(p->>'name') using errcode = '23505';
end;
$$;

create function public.bi_delete_library_item(p_id uuid)
returns void language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform bi.require_builder();
  delete from bi.library_items l where l.id = p_id;
  if not found then raise exception 'Library item not found' using errcode = 'P0002'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Usage statistics (from bi.view_log): which apps and sheets are opened, by how many people
-- ---------------------------------------------------------------------------
create function public.bi_usage(p_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 400));
begin
  perform bi.require_builder();
  return jsonb_build_object(
    'days', least(greatest(coalesce(p_days, 30), 1), 400),
    'apps', (select coalesce(jsonb_agg(x order by (x->>'views')::int desc, x->>'name'), '[]') from (
      select jsonb_build_object('app_id', a.id, 'name', a.name,
        'views', (select count(*) from bi.view_log v where v.app_id = a.id and v.at >= since),
        'people', (select count(distinct v.user_id) from bi.view_log v where v.app_id = a.id and v.at >= since),
        'last_opened', (select max(v.at) from bi.view_log v where v.app_id = a.id),
        'sheets', (select coalesce(jsonb_agg(jsonb_build_object('sheet_id', s.id, 'title', s.title,
            'views', (select count(*) from bi.view_log v where v.sheet_id = s.id and v.at >= since),
            'people', (select count(distinct v.user_id) from bi.view_log v where v.sheet_id = s.id and v.at >= since),
            'last_opened', (select max(v.at) from bi.view_log v where v.sheet_id = s.id)) order by s.position), '[]') from bi.sheets s where s.app_id = a.id),
        'report_emails', (select count(*) from bi.report_deliveries d join bi.report_schedules rs on rs.id = d.schedule_id
                          where rs.app_id = a.id and d.status = 'sent' and d.sent_at >= since)) as x
      from bi.apps a) apps),
    'people', (select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(nullif(p.display_name, ''), p.email), 'views', u.views, 'apps', u.apps, 'last_opened', u.last_opened)
        order by u.views desc), '[]')
      from (select v.user_id, count(*) as views, count(distinct v.app_id) as apps, max(v.at) as last_opened from bi.view_log v where v.at >= since group by v.user_id) u
      join public.profiles p on p.id = u.user_id),
    'by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'views', d.views, 'people', d.people) order by d.day), '[]')
      from (select (v.at at time zone 'Africa/Johannesburg')::date as day, count(*) as views, count(distinct v.user_id) as people
            from bi.view_log v where v.at >= since group by 1) d));
end;
$$;

-- ---------------------------------------------------------------------------
-- Data quality: freshness, failed loads, row count drops and empty fields per loaded table
-- ---------------------------------------------------------------------------
create function public.bi_data_quality()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  d record;
  t jsonb;
  runs jsonb;
  empty jsonb;
  mostly jsonb;
  every integer;
  issues integer;
  result jsonb := '[]';
begin
  if not (public.has_role('administrator') or bi.can_build() or public.has_role('reporting')) then
    raise exception 'You do not have access to the data catalogue' using errcode = '42501';
  end if;
  for d in select * from bi.data_tables order by table_name loop
    runs := coalesce((select jsonb_agg(jsonb_build_object('at', r.started_at, 'status', r.status, 'rows', r.row_count, 'error', left(r.error, 300)) order by r.started_at desc)
             from (select * from bi.sync_runs r where r.target_table = d.table_name order by r.started_at desc limit 10) r), '[]');
    empty := coalesce((select jsonb_agg(s.attname order by s.attname) from pg_catalog.pg_stats s
             where s.schemaname = 'bi_data' and s.tablename = d.table_name and s.null_frac >= 0.999 and s.attname <> '_bi_loaded_at'), '[]');
    mostly := coalesce((select jsonb_agg(jsonb_build_object('field', s.attname, 'empty', round(s.null_frac::numeric, 2)) order by s.null_frac desc) from pg_catalog.pg_stats s
             where s.schemaname = 'bi_data' and s.tablename = d.table_name and s.null_frac >= 0.5 and s.null_frac < 0.999 and s.attname <> '_bi_loaded_at'), '[]');
    every := coalesce((select coalesce(g.interval_minutes, j.interval_minutes) from bi.load_jobs j left join bi.load_groups g on g.name = j.group_name where j.target_table = d.table_name limit 1),
                      (select c.interval_minutes from bi.connectors c where c.name = d.table_name));
    issues := (case when d.last_loaded_at is null then 1 else 0 end)
      + (case when runs->0->>'status' = 'error' then 1 else 0 end)
      + (case when every is not null and d.last_loaded_at < now() - make_interval(mins => 3 * every + 60) then 1 else 0 end)
      + (case when (runs->1->>'rows')::numeric > 0 and (runs->0->>'rows')::numeric < 0.8 * (runs->1->>'rows')::numeric then 1 else 0 end)
      + jsonb_array_length(empty);
    t := jsonb_build_object('table_name', d.table_name, 'description', d.description, 'row_count', d.row_count, 'last_loaded_at', d.last_loaded_at,
      'source', case when exists (select 1 from bi.load_jobs j where j.target_table = d.table_name) then 'erp'
                     else coalesce((select c.kind from bi.connectors c where c.name = d.table_name), 'other') end,
      'interval_minutes', every, 'runs', runs, 'empty_fields', empty, 'mostly_empty', mostly, 'issues', issues);
    result := result || t;
  end loop;
  return coalesce((select jsonb_agg(x order by (x->>'issues')::int desc, x->>'table_name') from jsonb_array_elements(result) x), '[]');
end;
$$;

revoke all on function bi.keep_sheet_version(), bi.keep_app_version() from public, anon, authenticated;
revoke all on function public.bi_list_comments(uuid, uuid), public.bi_add_comment(uuid, uuid, text, text), public.bi_update_comment(uuid, text, boolean),
  public.bi_delete_comment(uuid), public.bi_list_versions(uuid), public.bi_restore_version(bigint), public.bi_copy_app(uuid, text, boolean),
  public.bi_list_library(), public.bi_save_library_item(jsonb), public.bi_delete_library_item(uuid), public.bi_usage(integer), public.bi_data_quality()
  from public, anon;
grant execute on function public.bi_list_comments(uuid, uuid), public.bi_add_comment(uuid, uuid, text, text), public.bi_update_comment(uuid, text, boolean),
  public.bi_delete_comment(uuid), public.bi_list_versions(uuid), public.bi_restore_version(bigint), public.bi_copy_app(uuid, text, boolean),
  public.bi_list_library(), public.bi_save_library_item(jsonb), public.bi_delete_library_item(uuid), public.bi_usage(integer), public.bi_data_quality()
  to authenticated;
