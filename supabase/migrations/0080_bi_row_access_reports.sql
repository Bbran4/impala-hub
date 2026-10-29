-- Reporting: row-level access (like Qlik section access) and scheduled report emails.
--
-- Row access: per app, rules "field is one of these values" for a user or a role. When an app has
-- row access on, viewers only get records that match their rules (every query goes through
-- bi_query, which adds the filter); viewers without any rule get no data. Administrators and report
-- builders see everything.
--
-- Report emails: schedules per app (sheets, recipients, when). A Vercel function (api/reporting/
-- send-due) is called every few minutes, claims due deliveries, opens each sheet in headless
-- Chrome with a short-lived render ticket that runs as the recipient (so their row access applies),
-- and emails a PDF and a picture. Only the service role can claim deliveries.

-- ---------------------------------------------------------------------------
-- Row access
-- ---------------------------------------------------------------------------
alter table bi.apps add column row_access boolean not null default false;

create table bi.row_rules (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references bi.apps (id) on delete cascade,
  principal_type text not null check (principal_type in ('role', 'user')),
  principal text not null check (length(principal) between 1 and 100),
  field text not null check (field ~ '^[a-z][a-z0-9_]{0,62}\.[^.]{1,63}$'),
  all_values boolean not null default false,
  vals text[] not null default '{}' check (cardinality(vals) <= 1000),
  created_by uuid,
  created_at timestamptz not null default now()
);
create index row_rules_app_idx on bi.row_rules (app_id);
alter table bi.row_rules enable row level security;
grant all on bi.row_rules to service_role;

-- Whether a given user may open an app (same rules as bi.can_view_app, for someone other than the
-- signed-in user: used when sending report emails).
create function bi.user_can_view_app(p_app uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.profiles p where p.id = p_user and p.active)
    and (
      exists (select 1 from public.profile_roles r where r.profile_id = p_user and r.role_id in ('administrator', 'report_builder'))
      or exists (
        select 1 from bi.app_access a
        where a.app_id = p_app
          and ((a.principal_type = 'role' and exists (select 1 from public.profile_roles r where r.profile_id = p_user and r.role_id = a.principal))
            or (a.principal_type = 'user' and a.principal = p_user::text))));
$$;

-- The row filter for the signed-in user: null = no restriction, {"#deny": true} = no data,
-- otherwise {"alias.column": ["value", ...] | null (all values)}.
create function bi.row_filter(p_app uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  result jsonb := '{}';
  r record;
  matched boolean := false;
begin
  if not coalesce((select a.row_access from bi.apps a where a.id = p_app), false) or bi.can_build() then
    return null;
  end if;
  for r in
    select x.field, bool_or(x.all_values) as all_values,
           coalesce((select jsonb_agg(distinct v order by v) from bi.row_rules y, unnest(y.vals) v
                     where y.app_id = p_app and y.field = x.field
                       and ((y.principal_type = 'user' and y.principal = auth.uid()::text)
                         or (y.principal_type = 'role' and public.has_role(y.principal)))), '[]') as vals
    from bi.row_rules x
    where x.app_id = p_app
      and ((x.principal_type = 'user' and x.principal = auth.uid()::text)
        or (x.principal_type = 'role' and public.has_role(x.principal)))
    group by x.field
  loop
    matched := true;
    result := result || jsonb_build_object(r.field, case when r.all_values then 'null'::jsonb else r.vals end);
  end loop;
  if not matched then return '{"#deny": true}'; end if;
  return result;
end;
$$;

create function public.bi_get_row_access(p_app uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  perform bi.require_builder();
  if not exists (select 1 from bi.apps a where a.id = p_app) then raise exception 'App not found' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'enabled', (select a.row_access from bi.apps a where a.id = p_app),
    'rules', (select coalesce(jsonb_agg(jsonb_build_object('type', r.principal_type, 'principal', r.principal, 'field', r.field,
                'all', r.all_values, 'values', to_jsonb(r.vals)) order by r.field, r.principal_type, r.principal), '[]')
              from bi.row_rules r where r.app_id = p_app));
end;
$$;

-- p = {"enabled": bool, "rules": [{"type": "role"|"user", "principal": "...", "field": "alias.column",
--      "all": bool, "values": ["..."]}]}. Replaces all rules of the app.
create function public.bi_save_row_access(p_app uuid, p jsonb)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  model jsonb;
  r jsonb;
  vals text[];
begin
  perform bi.require_builder();
  if not exists (select 1 from bi.apps a where a.id = p_app) then raise exception 'App not found' using errcode = 'P0002'; end if;
  if jsonb_typeof(p->'rules') <> 'array' or jsonb_array_length(p->'rules') > 500 then
    raise exception 'Invalid rules' using errcode = '22023';
  end if;
  model := bi.app_model(p_app);
  delete from bi.row_rules x where x.app_id = p_app;
  for r in select * from jsonb_array_elements(p->'rules') loop
    if r->>'type' not in ('role', 'user') or coalesce(r->>'principal', '') = '' then
      raise exception 'Each rule needs a user or a role' using errcode = '22023';
    end if;
    if r->>'type' = 'role' and not exists (select 1 from public.roles x where x.id = r->>'principal') then
      raise exception 'Unknown role %', r->>'principal' using errcode = '22023';
    end if;
    if r->>'type' = 'user' and not exists (select 1 from public.profiles x where x.id::text = r->>'principal') then
      raise exception 'Unknown user' using errcode = '22023';
    end if;
    if coalesce(r->>'field', '') !~ '^[a-z][a-z0-9_]{0,62}\.[^.]{1,63}$'
       or not coalesce((model->'cols'->split_part(r->>'field', '.', 1)) ? split_part(r->>'field', '.', 2), false) then
      raise exception 'Field "%" is not in this app''s data model', r->>'field' using errcode = '22023';
    end if;
    vals := array(select btrim(v) from jsonb_array_elements_text(coalesce(r->'values', '[]')) v where btrim(v) <> '');
    if not coalesce((r->>'all')::boolean, false) and cardinality(vals) = 0 then
      raise exception 'Choose at least one value for % (or "all values")', r->>'field' using errcode = '22023';
    end if;
    if cardinality(vals) > 1000 or exists (select 1 from unnest(vals) v where length(v) > 500) then
      raise exception 'Too many or too long values' using errcode = '22023';
    end if;
    insert into bi.row_rules (app_id, principal_type, principal, field, all_values, vals, created_by)
    values (p_app, r->>'type', r->>'principal', r->>'field', coalesce((r->>'all')::boolean, false),
            case when coalesce((r->>'all')::boolean, false) then '{}' else vals end, auth.uid());
  end loop;
  update bi.apps a set row_access = coalesce((p->>'enabled')::boolean, false), updated_by = auth.uid(), updated_at = now()
  where a.id = p_app;
  insert into bi.audit_log (actor, actor_id, action, object_type, object_name, details)
  select bi.app_actor(), auth.uid(), 'change', 'row access', a.name,
         jsonb_build_object('enabled', a.row_access, 'rules', jsonb_array_length(p->'rules'))
  from bi.apps a where a.id = p_app;
end;
$$;

-- What the signed-in user's access is limited to in an app (shown to viewers).
create function public.bi_my_row_access(p_app uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not bi.can_view_app(p_app) then
    raise exception 'You do not have access to this app' using errcode = '42501';
  end if;
  return bi.row_filter(p_app);
end;
$$;


-- bi_query: unchanged from 0066 except for the row access filter
create or replace function public.bi_query(p_app uuid, p_spec jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  model jsonb;
  dims jsonb := coalesce(p_spec->'dimensions', '[]');
  meas jsonb := coalesce(p_spec->'measures', '[]');
  sels jsonb := coalesce(p_spec->'selections', '[]');
  conds jsonb := coalesce(p_spec->'conditions', '[]');
  sorts jsonb := coalesce(p_spec->'sort', '[]');
  lim integer := least(greatest(coalesce((p_spec->>'limit')::int, 1000), 1), 10000);
  off integer := least(greatest(coalesce((p_spec->>'offset')::int, 0), 0), 1000000);
  select_list text[] := '{}';
  dim_list text[] := '{}';
  group_list text[] := '{}';
  where_list text[] := '{}';
  order_list text[] := '{}';
  flat_list text[] := '{}';
  flag_list text[] := '{}';
  used text[] := '{}';
  needed text[];
  c jsonb;
  item jsonb;
  v jsonb;
  vals text[];
  has_null boolean;
  n integer := 0;
  ncols integer;
  alias text;
  col text;
  flag text;
  tbl jsonb;
  from_sql text;
  query text;
  rows_out jsonb;
  pair jsonb;
  join_conds text[];
  keep text[];
  leaves text[];
  joined text[];
  other text;
  progress boolean;
  ra jsonb;
  rfield text;
  rvals jsonb;
begin
  if not bi.can_view_app(p_app) then
    raise exception 'You do not have access to this app' using errcode = '42501';
  end if;
  if jsonb_typeof(dims) <> 'array' or jsonb_typeof(meas) <> 'array' or jsonb_typeof(sels) <> 'array'
     or jsonb_typeof(conds) <> 'array' or jsonb_typeof(sorts) <> 'array' then
    raise exception 'Invalid query' using errcode = '22023';
  end if;
  if jsonb_array_length(dims) + jsonb_array_length(meas) = 0 then raise exception 'Add a dimension or a measure' using errcode = '22023'; end if;
  if jsonb_array_length(dims) > 10 or jsonb_array_length(meas) > 20 or jsonb_array_length(sels) > 50 or jsonb_array_length(conds) > 20 then
    raise exception 'The query is too large' using errcode = '22023';
  end if;

  model := bi.app_model(p_app);
  if jsonb_array_length(model->'order') = 0 then raise exception 'This app has no data model yet' using errcode = '22023'; end if;
  model := model || '{"flat": true}';

  -- row-level access (like Qlik section access): only the records this user may see
  ra := bi.row_filter(p_app);
  if ra is not null then
    if ra ? '#deny' then return jsonb_build_object('rows', '[]'::jsonb, 'has_more', false); end if;
    for rfield, rvals in select key, value from jsonb_each(ra) loop
      if jsonb_typeof(rvals) <> 'array' then continue; end if;
      alias := split_part(rfield, '.', 1);
      col := split_part(rfield, '.', 2);
      -- a rule on a field that is no longer in the model hides everything (fail closed)
      if not coalesce((model->'cols'->alias) ? col, false) then
        return jsonb_build_object('rows', '[]'::jsonb, 'has_more', false);
      end if;
      where_list := where_list || format('(to_jsonb(q.%I) #>> ''{}'') = any(%L::text[])', alias || '.' || col,
        array(select jsonb_array_elements_text(rvals)));
      used := used || alias;
    end loop;
  end if;

  for item in select * from jsonb_array_elements(dims) loop
    c := bi.compile_expr(item->'expr', model, false);
    select_list := select_list || format('%s as c%s', c->>'s', n);
    dim_list := dim_list || (c->>'s');
    group_list := group_list || (n + 1)::text;
    used := used || array(select jsonb_array_elements_text(c->'a'));
    n := n + 1;
  end loop;
  for item in select * from jsonb_array_elements(meas) loop
    c := bi.compile_expr(item->'expr', model, true);
    if not (c->>'g')::boolean then
      raise exception 'Measures need an aggregation such as Sum(), Count() or Avg()' using errcode = '22023';
    end if;
    select_list := select_list || format('%s as c%s', c->>'s', n);
    used := used || array(select jsonb_array_elements_text(c->'a'));
    -- record flags this measure needs (the compiler only writes known aliases into them)
    for flag in select distinct m[1] from regexp_matches(c->>'s', 'q\."(#k:[a-z0-9_,]+)"', 'g') m loop
      if not (flag = any(flag_list)) then flag_list := flag_list || flag; end if;
    end loop;
    n := n + 1;
  end loop;
  ncols := n;

  for item in select * from jsonb_array_elements(sels) loop
    c := bi.compile_expr(item->'expr', model, false);
    if jsonb_typeof(item->'values') <> 'array' or jsonb_array_length(item->'values') = 0 then continue; end if;
    if jsonb_array_length(item->'values') > 5000 then raise exception 'Too many selected values' using errcode = '22023'; end if;
    vals := '{}'; has_null := false;
    for v in select * from jsonb_array_elements(item->'values') loop
      if jsonb_typeof(v) = 'null' then has_null := true; else vals := vals || quote_literal(v::text); end if;
    end loop;
    where_list := where_list || format('(%s%s)',
      case when array_length(vals, 1) > 0 then format('to_jsonb(%s) = any(array[%s]::jsonb[])', c->>'s', array_to_string(vals, ', ')) else 'false' end,
      case when has_null then format(' or %s is null', c->>'s') else '' end);
    used := used || array(select jsonb_array_elements_text(c->'a'));
  end loop;
  for item in select * from jsonb_array_elements(conds) loop
    c := bi.compile_expr(item, model, false);
    where_list := where_list || format('coalesce((%s)::boolean, false)', c->>'s');
    used := used || array(select jsonb_array_elements_text(c->'a'));
  end loop;

  for item in select * from jsonb_array_elements(sorts) loop
    if (item->>'index')::int < 0 or (item->>'index')::int >= ncols then raise exception 'Invalid sort' using errcode = '22023'; end if;
    order_list := order_list || format('%s %s nulls last', (item->>'index')::int + 1, case when coalesce((item->>'desc')::boolean, false) then 'desc' else 'asc' end);
  end loop;
  if array_length(order_list, 1) is null then
    for n in 1 .. ncols loop order_list := order_list || format('%s asc nulls last', n); end loop;
  end if;

  -- tables needed: those used by the chart and by its aggregations (Count(*) counts the first table)
  needed := array(select distinct x from unnest(used || array(
    select unnest(string_to_array(substr(f, 4), ',')) from unnest(flag_list) f)) x);
  if array_length(needed, 1) is null then needed := array[model->'order'->>0]; end if;
  -- plus the tables in between: the links form a tree, so drop unneeded leaf tables until none are left
  keep := array(select a.value #>> '{}' from jsonb_array_elements(model->'order') a);
  loop
    select coalesce(array_agg(a), '{}') into leaves from unnest(keep) a
    where not (a = any(needed))
      and (case when (model->'tables'->a->>'parent') = any(keep) then 1 else 0 end)
        + (select count(*) from unnest(keep) b where model->'tables'->b->>'parent' = a) <= 1;
    exit when array_length(leaves, 1) is null;
    keep := array(select k from unnest(keep) k where not (k = any(leaves)));
  end loop;
  needed := keep;

  -- layer 1: tables joined along their links with full joins (no main table: records that have no
  -- match in a linked table are kept, like Qlik), flattened columns and row ids
  joined := '{}';
  loop
    progress := false;
    for alias in select a.value #>> '{}' from jsonb_array_elements(model->'order') with ordinality a(value, k) order by a.k loop
      if not (alias = any(needed)) or alias = any(joined) then continue; end if;
      tbl := model->'tables'->alias;
      join_conds := '{}';
      if array_length(joined, 1) is null then
        from_sql := format('%I.%I as %I', 'bi_data', tbl->>'table', alias);
      else
        if (tbl->>'parent') = any(joined) then
          for pair in select * from jsonb_array_elements(tbl->'pairs') loop
            join_conds := join_conds || format('%I.%I = %I.%I', alias, pair->>0, tbl->>'parent', pair->>1);
          end loop;
        else
          select j into other from unnest(joined) j where model->'tables'->j->>'parent' = alias limit 1;
          if other is null then continue; end if;
          for pair in select * from jsonb_array_elements(model->'tables'->other->'pairs') loop
            join_conds := join_conds || format('%I.%I = %I.%I', other, pair->>0, alias, pair->>1);
          end loop;
        end if;
        from_sql := from_sql || format(' full join %I.%I as %I on %s', 'bi_data', tbl->>'table', alias, array_to_string(join_conds, ' and '));
      end if;
      joined := joined || alias;
      progress := true;
      flat_list := flat_list || format('%I.ctid as %I', alias, '#r:' || alias);
      for col in select jsonb_object_keys(model->'cols'->alias) loop
        flat_list := flat_list || format('%I.%I as %I', alias, col, alias || '.' || col);
      end loop;
    end loop;
    exit when not progress;
  end loop;
  if array_length(joined, 1) is distinct from array_length(needed, 1) then
    raise exception 'The tables in this chart are not linked to each other' using errcode = '22023';
  end if;

  -- layer 2: filters and record flags
  query := format('select q.*%s from (select %s from %s) q%s',
    coalesce((select string_agg(
      case
        when needed <@ key_set then format(', true as %I', f)
        else format(', row_number() over (partition by %s) = 1 as %I',
          array_to_string(dim_list || array(select format('q.%I', '#r:' || k) from unnest(key_set) k), ', '), f)
      end, '')
      from (select f, string_to_array(substr(f, 4), ',') as key_set from unnest(flag_list) f) flags
      where string_to_array(substr(f, 4), ',') <@ needed), ''),
    array_to_string(flat_list, ', '), from_sql,
    case when array_length(where_list, 1) > 0 then ' where ' || array_to_string(where_list, ' and ') else '' end);
  if exists (select 1 from unnest(flag_list) f where not (string_to_array(substr(f, 4), ',') <@ needed)) then
    raise exception 'Invalid query' using errcode = '22023';
  end if;

  -- layer 3: dimensions and measures. Like Qlik, rows where every measure is empty are left out
  -- (e.g. a branch value that only exists because a stock item never sold).
  query := format('select %s%s from (%s) q%s order by %s limit %s offset %s',
    case when jsonb_array_length(meas) = 0 then 'distinct ' else '' end,
    array_to_string(select_list, ', '), query,
    case when jsonb_array_length(meas) > 0 and array_length(group_list, 1) > 0 then
      ' group by ' || array_to_string(group_list, ', ')
      || ' having not (' || array_to_string(array(select format('(%s) is null', regexp_replace(m, ' as c[0-9]+$', '')) from unnest(select_list[coalesce(array_length(dim_list, 1), 0) + 1 :]) m), ' and ') || ')'
    else '' end,
    array_to_string(order_list, ', '), lim + 1, off);

  perform set_config('statement_timeout', '20000', true);
  execute format('select coalesce(jsonb_agg(jsonb_build_array(%s)), ''[]'') from (%s) q',
    (select string_agg(format('q.c%s', i), ', ') from generate_series(0, ncols - 1) i), query) into rows_out;

  return jsonb_build_object(
    'rows', case when jsonb_array_length(rows_out) > lim then rows_out - lim else rows_out end,
    'has_more', jsonb_array_length(rows_out) > lim);
end;
$$;


-- ---------------------------------------------------------------------------
-- Write tables under row access: viewers only see and edit the rows they can see. The rows come
-- from the write table's own dimensions (options.keyDims, saved by report builders with the sheet).
-- ---------------------------------------------------------------------------
create function bi.try_jsonb(p text)
returns jsonb language plpgsql immutable set search_path = ''
as $$
begin
  return p::jsonb;
exception when others then
  return null;
end;
$$;

-- The row keys (arrays of dimension values) of a write table that the signed-in user can see.
create function bi.visible_write_keys(p_app uuid, p_object text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  dims jsonb := bi.write_object(p_app, p_object)->'options'->'keyDims';
begin
  if jsonb_typeof(dims) <> 'array' or jsonb_array_length(dims) = 0 then return '[]'; end if;
  return public.bi_query(p_app, jsonb_build_object(
    'dimensions', (select jsonb_agg(jsonb_build_object('expr', d)) from jsonb_array_elements(dims) d),
    'limit', 10000))->'rows';
end;
$$;

create or replace function public.bi_write_get(p_app uuid, p_object text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  keys jsonb;
begin
  if not bi.can_view_app(p_app) then
    raise exception 'You do not have access to this app' using errcode = '42501';
  end if;
  if bi.row_filter(p_app) is not null then keys := bi.visible_write_keys(p_app, p_object); end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('row_key', c.row_key, 'column', c.column_name, 'value', c.value,
      'updated_at', c.updated_at, 'updated_by', coalesce(nullif(pr.display_name, ''), pr.email, '')))
    from (select * from bi.write_cells w
          where w.app_id = p_app and w.object_id = p_object
            and (keys is null or bi.try_jsonb(w.row_key) in (select k from jsonb_array_elements(keys) k))
          order by w.updated_at desc limit 20000) c
    left join public.profiles pr on pr.id = c.updated_by), '[]'::jsonb);
end;
$$;

create or replace function public.bi_write_set(p_app uuid, p_object text, p_row_key text, p_column text, p_value text)
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
  if bi.row_filter(p_app) is not null and not coalesce(bi.try_jsonb(p_row_key) in (
       select k from jsonb_array_elements(bi.visible_write_keys(p_app, p_object)) k), false) then
    raise exception 'You cannot edit this row' using errcode = '42501';
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

-- ---------------------------------------------------------------------------
-- Report emails
-- ---------------------------------------------------------------------------
create table bi.report_schedules (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references bi.apps (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  sheet_ids uuid[] not null check (cardinality(sheet_ids) between 1 and 20),
  recipients jsonb not null default '[]' check (jsonb_typeof(recipients) = 'array'),
  frequency text not null check (frequency in ('daily', 'weekdays', 'weekly', 'monthly')),
  send_time time not null,
  weekdays integer[] not null default '{}' check (weekdays <@ array[1, 2, 3, 4, 5, 6, 7]),
  month_day integer check (month_day between 1 and 31),
  timezone text not null default 'Africa/Johannesburg' check (length(timezone) <= 64),
  subject text not null default '' check (length(subject) <= 200),
  message text not null default '' check (length(message) <= 2000),
  enabled boolean not null default true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index report_schedules_due_idx on bi.report_schedules (next_run_at) where enabled;

create table bi.report_deliveries (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references bi.report_schedules (id) on delete cascade,
  recipient uuid not null,
  email text not null,
  is_test boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0,
  lease_until timestamptz,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index report_deliveries_pending_idx on bi.report_deliveries (created_at) where status in ('pending', 'sending');
create index report_deliveries_schedule_idx on bi.report_deliveries (schedule_id, created_at desc);

-- One ticket per sheet per delivery; only the sha-256 of the ticket is stored.
create table bi.render_tickets (
  token_hash text primary key,
  delivery_id uuid not null references bi.report_deliveries (id) on delete cascade,
  user_id uuid not null,
  app_id uuid not null,
  sheet_id uuid not null,
  expires_at timestamptz not null
);

alter table bi.report_schedules enable row level security;
alter table bi.report_deliveries enable row level security;
alter table bi.render_tickets enable row level security;
grant all on bi.report_schedules, bi.report_deliveries, bi.render_tickets to service_role;

-- The next send time after p_after, in the schedule's time zone.
create function bi.report_next_run(p_frequency text, p_time time, p_weekdays integer[], p_month_day integer, p_tz text, p_after timestamptz)
returns timestamptz language plpgsql stable set search_path = ''
as $$
declare
  d date := (p_after at time zone p_tz)::date;
  candidate timestamptz;
  last_day integer;
begin
  for i in 0 .. 400 loop
    candidate := ((d + i) + p_time) at time zone p_tz;
    if candidate > p_after then
      last_day := extract(day from (date_trunc('month', d + i) + interval '1 month - 1 day'))::int;
      if p_frequency = 'daily'
         or (p_frequency = 'weekdays' and extract(isodow from d + i) <= 5)
         or (p_frequency = 'weekly' and extract(isodow from d + i)::int = any(p_weekdays))
         or (p_frequency = 'monthly' and extract(day from d + i)::int = least(coalesce(p_month_day, 1), last_day)) then
        return candidate;
      end if;
    end if;
  end loop;
  return null;
end;
$$;

-- Hub users a schedule goes to: named users plus active members of the named roles.
create function bi.report_recipients(p_recipients jsonb)
returns table (user_id uuid, email text, name text) language sql stable security definer set search_path = ''
as $$
  select distinct p.id, p.email, coalesce(nullif(p.display_name, ''), p.email)
  from public.profiles p
  where p.active and coalesce(p.email, '') <> '' and (
    p.id::text in (select r->>'principal' from jsonb_array_elements(p_recipients) r where r->>'type' = 'user')
    or exists (select 1 from public.profile_roles pr
               where pr.profile_id = p.id
                 and pr.role_id in (select r->>'principal' from jsonb_array_elements(p_recipients) r where r->>'type' = 'role')));
$$;

create function public.bi_list_reports(p_app uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  perform bi.require_builder();
  return jsonb_build_object(
    'schedules', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'sheet_ids', to_jsonb(s.sheet_ids), 'recipients', s.recipients, 'frequency', s.frequency,
        'send_time', to_char(s.send_time, 'HH24:MI'), 'weekdays', to_jsonb(s.weekdays), 'month_day', s.month_day,
        'timezone', s.timezone, 'subject', s.subject, 'message', s.message, 'enabled', s.enabled,
        'next_run_at', s.next_run_at, 'last_run_at', s.last_run_at,
        'recipient_count', (select count(*) from bi.report_recipients(s.recipients)))
        order by lower(s.name)), '[]') from bi.report_schedules s where s.app_id = p_app),
    'deliveries', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id, 'schedule_id', d.schedule_id, 'email', d.email, 'status', d.status, 'error', d.error, 'is_test', d.is_test,
        'attempts', d.attempts, 'created_at', d.created_at, 'sent_at', d.sent_at) order by d.created_at desc), '[]')
      from (select d.* from bi.report_deliveries d join bi.report_schedules s on s.id = d.schedule_id
            where s.app_id = p_app order by d.created_at desc limit 100) d));
end;
$$;

-- p = {id?, app_id, name, sheet_ids, recipients: [{type, principal}], frequency, send_time "HH:MM",
--      weekdays [1..7], month_day, timezone, subject, message, enabled}
create function public.bi_save_report(p jsonb)
returns uuid language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_app uuid := (p->>'app_id')::uuid;
  v_sheets uuid[];
  v_days integer[];
  v_tz text := coalesce(nullif(p->>'timezone', ''), 'Africa/Johannesburg');
  v_time time;
  r jsonb;
  is_new boolean := v_id is null;
begin
  perform bi.require_builder();
  if not exists (select 1 from bi.apps a where a.id = v_app) then raise exception 'App not found' using errcode = 'P0002'; end if;
  if v_id is not null and not exists (select 1 from bi.report_schedules s where s.id = v_id and s.app_id = v_app) then
    raise exception 'Report email not found' using errcode = 'P0002';
  end if;
  v_sheets := array(select (x #>> '{}')::uuid from jsonb_array_elements(coalesce(p->'sheet_ids', '[]')) x);
  if cardinality(v_sheets) = 0 then raise exception 'Choose at least one sheet' using errcode = '22023'; end if;
  if exists (select 1 from unnest(v_sheets) x where not exists (select 1 from bi.sheets s where s.id = x and s.app_id = v_app)) then
    raise exception 'A chosen sheet is not in this app' using errcode = '22023';
  end if;
  if jsonb_typeof(p->'recipients') <> 'array' or jsonb_array_length(p->'recipients') = 0 then
    raise exception 'Choose at least one recipient' using errcode = '22023';
  end if;
  if jsonb_array_length(p->'recipients') > 200 then raise exception 'Too many recipients' using errcode = '22023'; end if;
  for r in select * from jsonb_array_elements(p->'recipients') loop
    if (r->>'type' = 'role' and not exists (select 1 from public.roles x where x.id = r->>'principal'))
       or (r->>'type' = 'user' and not exists (select 1 from public.profiles x where x.id::text = r->>'principal'))
       or coalesce(r->>'type', '') not in ('role', 'user') then
      raise exception 'Unknown recipient' using errcode = '22023';
    end if;
  end loop;
  if coalesce(p->>'frequency', '') not in ('daily', 'weekdays', 'weekly', 'monthly') then
    raise exception 'Choose how often to send' using errcode = '22023';
  end if;
  if coalesce(p->>'send_time', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Enter a time like 07:00' using errcode = '22023'; end if;
  v_time := (p->>'send_time')::time;
  v_days := array(select (x #>> '{}')::int from jsonb_array_elements(coalesce(p->'weekdays', '[]')) x);
  if p->>'frequency' = 'weekly' and (cardinality(v_days) = 0 or not v_days <@ array[1, 2, 3, 4, 5, 6, 7]) then
    raise exception 'Choose the days of the week' using errcode = '22023';
  end if;
  if p->>'frequency' = 'monthly' and coalesce((p->>'month_day')::int, 0) not between 1 and 31 then
    raise exception 'Choose the day of the month' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_tz) then
    raise exception 'Unknown time zone %', v_tz using errcode = '22023';
  end if;

  if is_new then
    insert into bi.report_schedules (app_id, name, sheet_ids, recipients, frequency, send_time, weekdays, month_day, timezone,
      subject, message, enabled, next_run_at, created_by, updated_by)
    values (v_app, btrim(p->>'name'), v_sheets, p->'recipients', p->>'frequency', v_time, v_days, (p->>'month_day')::int, v_tz,
      coalesce(p->>'subject', ''), coalesce(p->>'message', ''), coalesce((p->>'enabled')::boolean, true),
      bi.report_next_run(p->>'frequency', v_time, v_days, (p->>'month_day')::int, v_tz, now()), auth.uid(), auth.uid())
    returning id into v_id;
  else
    update bi.report_schedules s set name = btrim(p->>'name'), sheet_ids = v_sheets, recipients = p->'recipients',
      frequency = p->>'frequency', send_time = v_time, weekdays = v_days, month_day = (p->>'month_day')::int, timezone = v_tz,
      subject = coalesce(p->>'subject', ''), message = coalesce(p->>'message', ''), enabled = coalesce((p->>'enabled')::boolean, true),
      next_run_at = bi.report_next_run(p->>'frequency', v_time, v_days, (p->>'month_day')::int, v_tz, now()),
      updated_by = auth.uid(), updated_at = now()
    where s.id = v_id;
  end if;
  insert into bi.audit_log (actor, actor_id, action, object_type, object_name, details)
  values (bi.app_actor(), auth.uid(), case when is_new then 'add' else 'change' end, 'report email', btrim(p->>'name'),
          jsonb_build_object('app_id', v_app, 'frequency', p->>'frequency', 'time', p->>'send_time', 'sheets', cardinality(v_sheets),
                             'recipients', p->'recipients'));
  return v_id;
end;
$$;

create function public.bi_delete_report(p_id uuid)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_name text;
begin
  perform bi.require_builder();
  delete from bi.report_schedules s where s.id = p_id returning s.name into v_name;
  if v_name is null then raise exception 'Report email not found' using errcode = 'P0002'; end if;
  insert into bi.audit_log (actor, actor_id, action, object_type, object_name)
  values (bi.app_actor(), auth.uid(), 'delete', 'report email', v_name);
end;
$$;

-- Send a report straight away: to yourself only (a test) or to all its recipients.
create function public.bi_send_report_now(p_id uuid, p_test boolean default true)
returns integer language plpgsql volatile security definer set search_path = ''
as $$
declare
  s bi.report_schedules;
  n integer;
begin
  perform bi.require_builder();
  select * into s from bi.report_schedules x where x.id = p_id;
  if s.id is null then raise exception 'Report email not found' using errcode = 'P0002'; end if;
  if p_test then
    insert into bi.report_deliveries (schedule_id, recipient, email, is_test)
    select s.id, p.id, p.email, true from public.profiles p where p.id = auth.uid() and coalesce(p.email, '') <> '';
  else
    insert into bi.report_deliveries (schedule_id, recipient, email)
    select s.id, r.user_id, r.email from bi.report_recipients(s.recipients) r;
  end if;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Sender (service role only): the Vercel function calls these
-- ---------------------------------------------------------------------------
-- Queues due schedules, then claims up to p_limit deliveries with a render ticket per sheet.
create function public.bi_report_claim(p_limit integer default 5)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  sched record;
  d record;
  sh record;
  token text;
  sheets jsonb;
  result jsonb := '[]';
begin
  -- 1. due schedules become one delivery per recipient
  for sched in select * from bi.report_schedules x where x.enabled and x.next_run_at <= now() for update skip locked loop
    insert into bi.report_deliveries (schedule_id, recipient, email, status, error)
    select sched.id, r.user_id, r.email,
           case when bi.user_can_view_app(sched.app_id, r.user_id) then 'pending' else 'skipped' end,
           case when bi.user_can_view_app(sched.app_id, r.user_id) then null else 'This person cannot open the app' end
    from bi.report_recipients(sched.recipients) r;
    update bi.report_schedules x set last_run_at = now(),
      next_run_at = bi.report_next_run(x.frequency, x.send_time, x.weekdays, x.month_day, x.timezone, now())
    where x.id = sched.id;
  end loop;

  -- 2. deliveries whose sender stopped half-way are retried (3 attempts)
  update bi.report_deliveries x set status = case when x.attempts >= 3 then 'failed' else 'pending' end,
    error = case when x.attempts >= 3 then coalesce(x.error, 'Gave up after 3 attempts') else x.error end, lease_until = null
  where x.status = 'sending' and x.lease_until < now();
  delete from bi.render_tickets t where t.expires_at < now();

  -- 3. claim
  for d in
    select x.id from bi.report_deliveries x where x.status = 'pending' and (x.lease_until is null or x.lease_until < now())
    order by x.is_test desc, x.created_at limit greatest(1, least(coalesce(p_limit, 5), 50)) for update skip locked
  loop
    update bi.report_deliveries x set status = 'sending', attempts = x.attempts + 1, lease_until = now() + interval '10 minutes'
    where x.id = d.id;
    select x.*, rs.app_id, rs.name as schedule_name, rs.subject, rs.message, rs.sheet_ids, a.name as app_name,
           coalesce(nullif(p.display_name, ''), p.email) as recipient_name
      into d from bi.report_deliveries x join bi.report_schedules rs on rs.id = x.schedule_id join bi.apps a on a.id = rs.app_id
      left join public.profiles p on p.id = x.recipient where x.id = d.id;
    if not bi.user_can_view_app(d.app_id, d.recipient) then
      update bi.report_deliveries x set status = 'skipped', error = 'This person cannot open the app', lease_until = null where x.id = d.id;
      continue;
    end if;
    sheets := '[]';
    for sh in select bs.id, bs.title from unnest(d.sheet_ids) with ordinality u(id, k) join bi.sheets bs on bs.id = u.id order by u.k loop
      token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
      insert into bi.render_tickets (token_hash, delivery_id, user_id, app_id, sheet_id, expires_at)
      values (encode(sha256(convert_to(token, 'UTF8')), 'hex'), d.id, d.recipient, d.app_id, sh.id, now() + interval '15 minutes');
      sheets := sheets || jsonb_build_object('sheet_id', sh.id, 'title', sh.title, 'ticket', token);
    end loop;
    if jsonb_array_length(sheets) = 0 then
      update bi.report_deliveries x set status = 'failed', error = 'The chosen sheets no longer exist', lease_until = null where x.id = d.id;
      continue;
    end if;
    result := result || jsonb_build_object('delivery_id', d.id, 'email', d.email, 'recipient_name', d.recipient_name,
      'app_id', d.app_id, 'app_name', d.app_name, 'schedule_name', d.schedule_name, 'subject', d.subject, 'message', d.message,
      'is_test', d.is_test, 'attempt', d.attempts, 'sheets', sheets);
  end loop;
  return result;
end;
$$;

-- p_status: 'sent', 'failed' (final) or 'retry' (back in the queue after a pause, unless it was the 3rd attempt)
create function public.bi_report_finish(p_delivery uuid, p_status text, p_error text default null)
returns void language plpgsql volatile security definer set search_path = ''
as $$
begin
  if p_status not in ('sent', 'failed', 'retry') then raise exception 'Invalid status' using errcode = '22023'; end if;
  update bi.report_deliveries x set
    status = case when p_status = 'sent' then 'sent' when p_status = 'retry' and x.attempts < 3 then 'pending' else 'failed' end,
    error = case when p_status = 'sent' then null else left(coalesce(p_error, 'Sending failed'), 1000) end,
    sent_at = case when p_status = 'sent' then now() else null end,
    -- a retry waits a little longer each time (5, then 10 minutes)
    lease_until = case when p_status = 'retry' and x.attempts < 3 then now() + x.attempts * interval '5 minutes' end
  where x.id = p_delivery;
  delete from bi.render_tickets t where t.delivery_id = p_delivery;
end;
$$;

-- ---------------------------------------------------------------------------
-- Rendering (headless Chrome, signed out): a ticket stands in for the recipient for 15 minutes,
-- for one app. Queries run as that person, so their access and row access apply.
-- ---------------------------------------------------------------------------
create function bi.use_ticket(p_ticket text)
returns bi.render_tickets language plpgsql volatile security definer set search_path = ''
as $$
declare
  t bi.render_tickets;
begin
  select * into t from bi.render_tickets x
  where x.token_hash = encode(sha256(convert_to(coalesce(p_ticket, ''), 'UTF8')), 'hex') and x.expires_at > now();
  if t.token_hash is null then raise exception 'This report link has expired' using errcode = '42501'; end if;
  perform set_config('request.jwt.claim.sub', t.user_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', t.user_id, 'role', 'authenticated')::text, true);
  return t;
end;
$$;

create function public.bi_render_app(p_ticket text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  t bi.render_tickets := bi.use_ticket(p_ticket);
begin
  return jsonb_build_object('app', public.bi_get_app(t.app_id), 'sheet_id', t.sheet_id,
    'recipient', (select coalesce(nullif(p.display_name, ''), p.email) from public.profiles p where p.id = t.user_id),
    'row_access', bi.row_filter(t.app_id));
end;
$$;

create function public.bi_render_query(p_ticket text, p_spec jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  t bi.render_tickets := bi.use_ticket(p_ticket);
begin
  return public.bi_query(t.app_id, p_spec);
end;
$$;

create function public.bi_render_write_get(p_ticket text, p_object text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  t bi.render_tickets := bi.use_ticket(p_ticket);
begin
  return public.bi_write_get(t.app_id, p_object);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function bi.user_can_view_app(uuid, uuid), bi.row_filter(uuid), bi.try_jsonb(text), bi.visible_write_keys(uuid, text),
  bi.report_next_run(text, time, integer[], integer, text, timestamptz), bi.report_recipients(jsonb), bi.use_ticket(text)
  from public, anon, authenticated;
revoke all on function public.bi_get_row_access(uuid), public.bi_save_row_access(uuid, jsonb), public.bi_my_row_access(uuid),
  public.bi_list_reports(uuid), public.bi_save_report(jsonb), public.bi_delete_report(uuid), public.bi_send_report_now(uuid, boolean),
  public.bi_report_claim(integer), public.bi_report_finish(uuid, text, text),
  public.bi_render_app(text), public.bi_render_query(text, jsonb), public.bi_render_write_get(text, text),
  public.bi_write_get(uuid, text), public.bi_write_set(uuid, text, text, text, text), public.bi_query(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.bi_get_row_access(uuid), public.bi_save_row_access(uuid, jsonb), public.bi_my_row_access(uuid),
  public.bi_list_reports(uuid), public.bi_save_report(jsonb), public.bi_delete_report(uuid), public.bi_send_report_now(uuid, boolean),
  public.bi_write_get(uuid, text), public.bi_write_set(uuid, text, text, text, text), public.bi_query(uuid, jsonb)
  to authenticated;
grant execute on function public.bi_render_app(text), public.bi_render_query(text, jsonb), public.bi_render_write_get(text, text)
  to anon, authenticated;
grant execute on function public.bi_report_claim(integer), public.bi_report_finish(uuid, text, text) to service_role;
