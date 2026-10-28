-- Impala Hub Reporting: Qlik-style apps, sheets and the query engine.
-- (Runs after 0047_user_notifications.sql; can_access_workspace below keeps its sales_manager rule.)
--
-- An app chooses loaded tables (bi.data_tables) and how they link (its data model),
-- holds dashboard sheets, master measures, and an access list of roles and users.
--
-- The browser never sends SQL. Charts send a query spec whose expressions are a JSON
-- syntax tree (parsed in the frontend from Qlik-style text such as Sum(qty*unit_price)).
-- bi.compile_expr turns the tree into SQL using only whitelisted functions and operators,
-- quoted identifiers resolved against the app's data model, and quoted literals.
-- public.bi_query checks the caller may view the app, builds the joins it needs from the
-- data model, applies selections and conditions, and returns aggregated rows.
--
-- Builders (administrator, report_builder) create and edit apps; viewers see the apps
-- shared with one of their roles or with them personally.

-- ---------------------------------------------------------------------------
-- Role and workspace access
-- ---------------------------------------------------------------------------
insert into public.roles (id, label, description) values
  ('report_builder', 'Report builder', 'Creates and edits Reporting apps and dashboards')
on conflict (id) do nothing;

create or replace function public.can_access_workspace(workspace_name text)
returns boolean language sql stable security definer set search_path = public
as $$
  select public.is_active_user() and (
    public.has_role('administrator') or
    (workspace_name = 'sales_desk' and (public.has_role('sales') or public.has_role('sales_manager') or public.has_role('management'))) or
    (workspace_name = 'returns_claims' and (public.has_role('returns') or public.has_role('management'))) or
    (workspace_name = 'marketing' and (public.has_role('marketing') or public.has_role('management'))) or
    (workspace_name = 'stock_control' and (public.has_role('stock') or public.has_role('management'))) or
    (workspace_name = 'reporting' and (public.has_role('reporting') or public.has_role('management') or public.has_role('report_builder')))
  );
$$;
revoke all on function public.can_access_workspace(text) from public, anon;
grant execute on function public.can_access_workspace(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table bi.apps (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  description text not null default '' check (length(description) <= 2000),
  measures jsonb not null default '[]' check (jsonb_typeof(measures) = 'array'),
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index apps_name_idx on bi.apps (lower(btrim(name)));

-- Data model: a tree of loaded tables. The root has no parent; every other table is
-- joined to its parent on one or more column pairs.
create table bi.app_tables (
  app_id uuid not null references bi.apps (id) on delete cascade,
  alias text not null check (alias ~ '^[a-z][a-z0-9_]{0,62}$'),
  table_name text not null check (table_name ~ '^[a-z][a-z0-9_]{0,62}$'),
  parent_alias text,
  join_type text not null default 'left' check (join_type in ('left', 'inner')),
  join_pairs jsonb not null default '[]',   -- [["child_column","parent_column"], ...]
  position integer not null default 0,
  primary key (app_id, alias)
);

create table bi.app_access (
  app_id uuid not null references bi.apps (id) on delete cascade,
  principal_type text not null check (principal_type in ('role', 'user')),
  principal text not null,
  primary key (app_id, principal_type, principal)
);

create table bi.sheets (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references bi.apps (id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 120),
  position integer not null default 0,
  objects jsonb not null default '[]' check (jsonb_typeof(objects) = 'array'),
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sheets_app_idx on bi.sheets (app_id, position);

alter table bi.apps enable row level security;
alter table bi.app_tables enable row level security;
alter table bi.app_access enable row level security;
alter table bi.sheets enable row level security;
grant all on bi.apps, bi.app_tables, bi.app_access, bi.sheets to service_role;

-- ---------------------------------------------------------------------------
-- Access helpers
-- ---------------------------------------------------------------------------
create function bi.can_build()
returns boolean language sql stable security definer set search_path = ''
as $$ select public.is_active_user() and (public.has_role('administrator') or public.has_role('report_builder')); $$;

create function bi.can_view_app(p_app uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select bi.can_build() or (
    public.is_active_user() and exists (
      select 1 from bi.app_access a
      where a.app_id = p_app
        and ((a.principal_type = 'role' and public.has_role(a.principal))
          or (a.principal_type = 'user' and a.principal = auth.uid()::text))
    )
  );
$$;

create function bi.require_builder()
returns void language plpgsql stable security definer set search_path = ''
as $$
begin
  if not bi.can_build() then
    raise exception 'Only administrators and report builders can edit apps' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Data model for queries: {"order": [aliases, root first], "cols": {alias: {column: type}},
-- "tables": {alias: {table, parent, join_type, pairs}}}
-- ---------------------------------------------------------------------------
create function bi.app_model(p_app uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  with recursive tree as (
    select t.alias, t.table_name, t.parent_alias, t.join_type, t.join_pairs, t.position, 0 as depth
    from bi.app_tables t where t.app_id = p_app and t.parent_alias is null
    union all
    select c.alias, c.table_name, c.parent_alias, c.join_type, c.join_pairs, c.position, tree.depth + 1
    from bi.app_tables c join tree on c.parent_alias = tree.alias and c.app_id = p_app
    where tree.depth < 20
  )
  select jsonb_build_object(
    'order', coalesce(jsonb_agg(to_jsonb(tree.alias) order by tree.depth, tree.position, tree.alias), '[]'),
    'cols', coalesce(jsonb_object_agg(tree.alias, coalesce(
        (select jsonb_object_agg(c->>'name', c->>'type') from jsonb_array_elements(d.columns) c where c->>'name' <> '_bi_loaded_at'),
        '{}'::jsonb)), '{}'),
    'tables', coalesce(jsonb_object_agg(tree.alias, jsonb_build_object(
        'table', tree.table_name, 'parent', tree.parent_alias, 'join_type', tree.join_type, 'pairs', tree.join_pairs)), '{}')
  )
  from tree left join bi.data_tables d on d.table_name = tree.table_name;
$$;

-- ---------------------------------------------------------------------------
-- Expression compiler. Node types:
--   {"t":"num","v":12.5}  {"t":"str","v":"text"}  {"t":"null"}  {"t":"star"}
--   {"t":"field","name":"qty"} / {"t":"field","table":"lines","name":"qty"}
--   {"t":"bin","op":"+","l":node,"r":node}   ops: + - * / & = <> < <= > >= and or
--   {"t":"neg","e":node}  {"t":"not","e":node}
--   {"t":"fn","name":"sum","args":[node],"distinct":false}
-- Returns {"s": sql, "a": [aliases used], "g": contains aggregate}.
-- ---------------------------------------------------------------------------
create function bi.compile_expr(p_node jsonb, p_model jsonb, p_agg_allowed boolean, p_in_agg boolean default false, p_depth integer default 0)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  t text := p_node->>'t';
  fname text;
  args jsonb;
  nargs integer;
  parts text[] := '{}';
  aliases jsonb := '[]';
  has_agg boolean := false;
  r jsonb;
  l jsonb;
  arg jsonb;
  alias text;
  col text;
  op text;
  sql_op text;
  is_agg boolean;
  i integer;
begin
  if p_depth > 40 then raise exception 'Expression is too deeply nested' using errcode = '22023'; end if;
  if p_node is null or jsonb_typeof(p_node) <> 'object' then raise exception 'Invalid expression' using errcode = '22023'; end if;

  if t = 'num' then
    if jsonb_typeof(p_node->'v') <> 'number' then raise exception 'Invalid number' using errcode = '22023'; end if;
    return jsonb_build_object('s', '(' || ((p_node->>'v')::numeric)::text || ')', 'a', '[]'::jsonb, 'g', false);
  elsif t = 'str' then
    if jsonb_typeof(p_node->'v') <> 'string' then raise exception 'Invalid text' using errcode = '22023'; end if;
    return jsonb_build_object('s', quote_literal(p_node->>'v'), 'a', '[]'::jsonb, 'g', false);
  elsif t = 'null' then
    return jsonb_build_object('s', 'null', 'a', '[]'::jsonb, 'g', false);
  elsif t = 'star' then
    raise exception '* is only allowed in Count(*)' using errcode = '22023';
  elsif t = 'field' then
    col := lower(p_node->>'name');
    alias := lower(p_node->>'table');
    if col is null then raise exception 'Invalid field' using errcode = '22023'; end if;
    if alias is not null then
      if not (p_model->'cols' ? alias) then raise exception 'Unknown table "%" in this app', alias using errcode = '42P01'; end if;
      if not ((p_model->'cols'->alias) ? col) then raise exception 'Unknown field "%.%"', alias, col using errcode = '42703'; end if;
    else
      select a.value #>> '{}' into alias
      from jsonb_array_elements(p_model->'order') with ordinality a(value, n)
      where (p_model->'cols'->(a.value #>> '{}')) ? col
      order by a.n limit 1;
      if alias is null then raise exception 'Unknown field "%"', p_node->>'name' using errcode = '42703'; end if;
    end if;
    return jsonb_build_object('s', format('%I.%I', alias, col), 'a', jsonb_build_array(alias), 'g', false);
  elsif t = 'neg' or t = 'not' then
    r := bi.compile_expr(p_node->'e', p_model, p_agg_allowed, p_in_agg, p_depth + 1);
    return jsonb_build_object('s', case when t = 'neg' then '(-' || (r->>'s') || ')' else '(not ' || (r->>'s') || ')' end, 'a', r->'a', 'g', r->'g');
  elsif t = 'bin' then
    op := lower(p_node->>'op');
    l := bi.compile_expr(p_node->'l', p_model, p_agg_allowed, p_in_agg, p_depth + 1);
    r := bi.compile_expr(p_node->'r', p_model, p_agg_allowed, p_in_agg, p_depth + 1);
    aliases := (l->'a') || (r->'a');
    has_agg := (l->>'g')::boolean or (r->>'g')::boolean;
    if op = '/' then
      return jsonb_build_object('s', format('((%s)::numeric / nullif((%s)::numeric, 0))', l->>'s', r->>'s'), 'a', aliases, 'g', has_agg);
    elsif op = '&' then
      return jsonb_build_object('s', format('(coalesce((%s)::text, '''') || coalesce((%s)::text, ''''))', l->>'s', r->>'s'), 'a', aliases, 'g', has_agg);
    end if;
    sql_op := case op when '+' then '+' when '-' then '-' when '*' then '*' when '=' then '=' when '<>' then '<>'
      when '<' then '<' when '<=' then '<=' when '>' then '>' when '>=' then '>=' when 'and' then 'and' when 'or' then 'or' end;
    if sql_op is null then raise exception 'Operator "%" is not allowed', p_node->>'op' using errcode = '22023'; end if;
    return jsonb_build_object('s', format('(%s %s %s)', l->>'s', sql_op, r->>'s'), 'a', aliases, 'g', has_agg);
  elsif t = 'fn' then
    fname := lower(p_node->>'name');
    args := coalesce(p_node->'args', '[]');
    if jsonb_typeof(args) <> 'array' then raise exception 'Invalid function arguments' using errcode = '22023'; end if;
    nargs := jsonb_array_length(args);
    is_agg := fname in ('sum', 'avg', 'min', 'max', 'count', 'median');

    if is_agg then
      if not p_agg_allowed then raise exception '%() can only be used in measures', initcap(fname) using errcode = '22023'; end if;
      if p_in_agg then raise exception 'Aggregations cannot be nested inside each other' using errcode = '22023'; end if;
      if nargs <> 1 then raise exception '%() takes one argument', initcap(fname) using errcode = '22023'; end if;
      if fname = 'count' and args->0->>'t' = 'star' then
        return jsonb_build_object('s', 'count(*)', 'a', '[]'::jsonb, 'g', true);
      end if;
      r := bi.compile_expr(args->0, p_model, p_agg_allowed, true, p_depth + 1);
      if fname = 'median' then
        return jsonb_build_object('s', format('percentile_cont(0.5) within group (order by (%s)::numeric)', r->>'s'), 'a', r->'a', 'g', true);
      end if;
      return jsonb_build_object('s', format('%s(%s%s)', fname, case when coalesce((p_node->>'distinct')::boolean, false) then 'distinct ' else '' end, r->>'s'), 'a', r->'a', 'g', true);
    end if;

    -- scalar functions
    for i in 0 .. nargs - 1 loop
      r := bi.compile_expr(args->i, p_model, p_agg_allowed, p_in_agg, p_depth + 1);
      parts := parts || (r->>'s');
      aliases := aliases || (r->'a');
      has_agg := has_agg or (r->>'g')::boolean;
    end loop;

    if fname in ('today', 'now') then
      if nargs <> 0 then raise exception '%() takes no arguments', initcap(fname) using errcode = '22023'; end if;
      return jsonb_build_object('s', case fname when 'today' then '(current_date)' else '(now())' end, 'a', '[]'::jsonb, 'g', false);
    elsif fname = 'if' then
      if nargs not in (2, 3) then raise exception 'If() takes 2 or 3 arguments' using errcode = '22023'; end if;
      return jsonb_build_object('s', format('(case when %s then %s else %s end)', parts[1], parts[2], coalesce(parts[3], 'null')), 'a', aliases, 'g', has_agg);
    elsif fname in ('alt', 'coalesce') then
      if nargs < 2 then raise exception 'Alt() takes at least 2 arguments' using errcode = '22023'; end if;
      return jsonb_build_object('s', format('coalesce(%s)', array_to_string(parts, ', ')), 'a', aliases, 'g', has_agg);
    elsif fname = 'round' then
      if nargs not in (1, 2) then raise exception 'Round() takes 1 or 2 arguments' using errcode = '22023'; end if;
      return jsonb_build_object('s', format('round((%s)::numeric, %s)', parts[1], coalesce('(' || parts[2] || ')::int', '0')), 'a', aliases, 'g', has_agg);
    elsif fname in ('left', 'right') then
      if nargs <> 2 then raise exception '%() takes 2 arguments', initcap(fname) using errcode = '22023'; end if;
      return jsonb_build_object('s', format('%s((%s)::text, (%s)::int)', fname, parts[1], parts[2]), 'a', aliases, 'g', has_agg);
    end if;

    if nargs <> 1 then raise exception 'Function "%" is not available or takes one argument', p_node->>'name' using errcode = '22023'; end if;
    r := jsonb_build_object('s', case fname
        when 'abs' then format('abs((%s)::numeric)', parts[1])
        when 'upper' then format('upper((%s)::text)', parts[1])
        when 'lower' then format('lower((%s)::text)', parts[1])
        when 'trim' then format('btrim((%s)::text)', parts[1])
        when 'len' then format('length((%s)::text)', parts[1])
        when 'text' then format('((%s)::text)', parts[1])
        when 'num' then format('((%s)::numeric)', parts[1])
        when 'date' then format('((%s)::date)', parts[1])
        when 'year' then format('(extract(year from %s)::int)', parts[1])
        when 'quarter' then format('(extract(quarter from %s)::int)', parts[1])
        when 'month' then format('(extract(month from %s)::int)', parts[1])
        when 'week' then format('(extract(week from %s)::int)', parts[1])
        when 'day' then format('(extract(day from %s)::int)', parts[1])
        when 'weekday' then format('(extract(isodow from %s)::int)', parts[1])
        when 'monthstart' then format('(date_trunc(''month'', %s)::date)', parts[1])
        when 'weekstart' then format('(date_trunc(''week'', %s)::date)', parts[1])
        when 'yearstart' then format('(date_trunc(''year'', %s)::date)', parts[1])
        when 'yearmonth' then format('to_char(%s, ''YYYY-MM'')', parts[1])
      end, 'a', aliases, 'g', has_agg);
    if r->>'s' is null then raise exception 'Function "%" is not available', p_node->>'name' using errcode = '22023'; end if;
    return r;
  end if;
  raise exception 'Invalid expression' using errcode = '22023';
end;
$$;

-- ---------------------------------------------------------------------------
-- Model validation (used when saving an app)
-- ---------------------------------------------------------------------------
create function bi.validate_model(p_tables jsonb)
returns void language plpgsql stable security definer set search_path = ''
as $$
declare
  tdef jsonb;
  pair jsonb;
  roots integer := 0;
  aliases text[] := '{}';
  cols jsonb;
  parent_cols jsonb;
  visited text[];
  frontier text[];
begin
  if jsonb_typeof(p_tables) <> 'array' or jsonb_array_length(p_tables) = 0 then
    raise exception 'Choose at least one table for the data model' using errcode = '22023';
  end if;
  if jsonb_array_length(p_tables) > 20 then raise exception 'An app can use at most 20 tables' using errcode = '22023'; end if;
  for tdef in select * from jsonb_array_elements(p_tables) loop
    if coalesce(tdef->>'alias', '') !~ '^[a-z][a-z0-9_]{0,62}$' then
      raise exception 'Table name "%" must use lower case letters, digits and _', tdef->>'alias' using errcode = '22023';
    end if;
    if tdef->>'alias' = any(aliases) then raise exception 'Table "%" is used twice; give it another name', tdef->>'alias' using errcode = '22023'; end if;
    aliases := aliases || (tdef->>'alias');
    if not exists (select 1 from bi.data_tables d where d.table_name = tdef->>'table_name') then
      raise exception 'Loaded table "%" does not exist', tdef->>'table_name' using errcode = '42P01';
    end if;
    if tdef->>'parent_alias' is null then roots := roots + 1; end if;
  end loop;
  if roots <> 1 then raise exception 'The data model needs exactly one main table' using errcode = '22023'; end if;

  for tdef in select * from jsonb_array_elements(p_tables) loop
    if tdef->>'parent_alias' is null then continue; end if;
    if not (tdef->>'parent_alias' = any(aliases)) then
      raise exception 'Table "%" links to "%", which is not in the model', tdef->>'alias', tdef->>'parent_alias' using errcode = '22023';
    end if;
    if jsonb_typeof(tdef->'join_pairs') <> 'array' or jsonb_array_length(tdef->'join_pairs') = 0 then
      raise exception 'Choose the fields that link "%" to "%"', tdef->>'alias', tdef->>'parent_alias' using errcode = '22023';
    end if;
    select d.columns into cols from bi.data_tables d where d.table_name = tdef->>'table_name';
    select d.columns into parent_cols from bi.data_tables d
      join lateral jsonb_array_elements(p_tables) p on p->>'alias' = tdef->>'parent_alias' and d.table_name = p->>'table_name';
    for pair in select * from jsonb_array_elements(tdef->'join_pairs') loop
      if jsonb_typeof(pair) <> 'array' or jsonb_array_length(pair) <> 2 then raise exception 'Invalid link' using errcode = '22023'; end if;
      if not exists (select 1 from jsonb_array_elements(cols) c where c->>'name' = pair->>0) then
        raise exception 'Field "%" is not in table "%"', pair->>0, tdef->>'alias' using errcode = '42703';
      end if;
      if not exists (select 1 from jsonb_array_elements(parent_cols) c where c->>'name' = pair->>1) then
        raise exception 'Field "%" is not in table "%"', pair->>1, tdef->>'parent_alias' using errcode = '42703';
      end if;
    end loop;
  end loop;

  -- every table must be reachable from the root (no cycles)
  select array_agg(e->>'alias') into frontier from jsonb_array_elements(p_tables) e where e->>'parent_alias' is null;
  visited := frontier;
  while array_length(frontier, 1) > 0 loop
    select coalesce(array_agg(e->>'alias'), '{}') into frontier
    from jsonb_array_elements(p_tables) e
    where e->>'parent_alias' = any(frontier) and not (e->>'alias' = any(visited));
    visited := visited || frontier;
  end loop;
  if coalesce(array_length(visited, 1), 0) <> array_length(aliases, 1) then
    raise exception 'Every table must link back to the main table (the links form a loop)' using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- App API
-- ---------------------------------------------------------------------------
create function public.bi_my_access()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'admin', public.is_active_user() and public.has_role('administrator'),
    'builder', bi.can_build(),
    'catalogue', public.can_access_workspace('reporting'),
    'apps', (select count(*) from bi.apps a where bi.can_view_app(a.id))
  );
$$;

create function public.bi_list_apps()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'name', a.name, 'description', a.description, 'updated_at', a.updated_at,
      'can_edit', bi.can_build(),
      'tables', (select coalesce(jsonb_agg(t.table_name order by t.position), '[]') from bi.app_tables t where t.app_id = a.id),
      'sheets', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title) order by s.position, s.created_at), '[]') from bi.sheets s where s.app_id = a.id),
      'last_loaded_at', (select max(d.last_loaded_at) from bi.app_tables t join bi.data_tables d on d.table_name = t.table_name where t.app_id = a.id)
    ) order by lower(a.name)), '[]')
  from bi.apps a
  where bi.can_view_app(a.id);
$$;

create function public.bi_get_app(p_app uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  result jsonb;
begin
  if not bi.can_view_app(p_app) then
    raise exception 'You do not have access to this app' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'id', a.id, 'name', a.name, 'description', a.description, 'measures', a.measures, 'updated_at', a.updated_at,
    'can_edit', bi.can_build(),
    'model', (select coalesce(jsonb_agg(jsonb_build_object(
        'alias', t.alias, 'table_name', t.table_name, 'parent_alias', t.parent_alias, 'join_type', t.join_type,
        'join_pairs', t.join_pairs, 'description', d.description, 'row_count', d.row_count, 'last_loaded_at', d.last_loaded_at,
        'columns', coalesce((select jsonb_agg(c) from jsonb_array_elements(d.columns) c where c->>'name' <> '_bi_loaded_at'), '[]'))
        order by t.position, t.alias), '[]')
      from bi.app_tables t left join bi.data_tables d on d.table_name = t.table_name where t.app_id = a.id),
    'sheets', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'position', s.position, 'objects', s.objects, 'updated_at', s.updated_at)
        order by s.position, s.created_at), '[]') from bi.sheets s where s.app_id = a.id),
    'access', case when bi.can_build() then (select coalesce(jsonb_agg(jsonb_build_object('type', x.principal_type, 'principal', x.principal)), '[]') from bi.app_access x where x.app_id = a.id) else null end
  ) into result
  from bi.apps a where a.id = p_app;
  if result is null then raise exception 'App not found' using errcode = 'P0002'; end if;
  return result;
end;
$$;

-- Create or update an app. p = {id?, name, description, model: [...], measures: [...], access: [...]}
create function public.bi_save_app(p jsonb)
returns uuid language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_app uuid := nullif(p->>'id', '')::uuid;
  tdef jsonb;
  m jsonb;
  x jsonb;
  pos integer := 0;
  is_new boolean := false;
begin
  perform bi.require_builder();
  if coalesce(btrim(p->>'name'), '') = '' then raise exception 'Give the app a name' using errcode = '22023'; end if;
  perform bi.validate_model(p->'model');
  if jsonb_typeof(coalesce(p->'measures', '[]')) <> 'array' or jsonb_array_length(coalesce(p->'measures', '[]')) > 200 then
    raise exception 'Invalid master measures' using errcode = '22023';
  end if;
  for m in select * from jsonb_array_elements(coalesce(p->'measures', '[]')) loop
    if coalesce(btrim(m->>'name'), '') = '' or coalesce(m->>'expression', '') = '' then
      raise exception 'Every master measure needs a name and an expression' using errcode = '22023';
    end if;
  end loop;

  if v_app is null then
    insert into bi.apps (name, description, measures, created_by, updated_by)
    values (btrim(p->>'name'), coalesce(p->>'description', ''), coalesce(p->'measures', '[]'), auth.uid(), auth.uid())
    returning id into v_app;
    is_new := true;
  else
    update bi.apps set name = btrim(p->>'name'), description = coalesce(p->>'description', ''),
      measures = coalesce(p->'measures', '[]'), updated_by = auth.uid(), updated_at = now()
    where id = v_app;
    if not found then raise exception 'App not found' using errcode = 'P0002'; end if;
  end if;

  delete from bi.app_tables where bi.app_tables.app_id = v_app;
  for tdef in select * from jsonb_array_elements(p->'model') loop
    insert into bi.app_tables (app_id, alias, table_name, parent_alias, join_type, join_pairs, position)
    values (v_app, tdef->>'alias', tdef->>'table_name', tdef->>'parent_alias', coalesce(tdef->>'join_type', 'left'),
            case when tdef->>'parent_alias' is null then '[]'::jsonb else tdef->'join_pairs' end, pos);
    pos := pos + 1;
  end loop;

  if p ? 'access' then
    if jsonb_typeof(p->'access') <> 'array' then raise exception 'Invalid access list' using errcode = '22023'; end if;
    delete from bi.app_access where bi.app_access.app_id = v_app;
    for x in select * from jsonb_array_elements(p->'access') loop
      if x->>'type' = 'role' and not exists (select 1 from public.roles r where r.id = x->>'principal') then
        raise exception 'Unknown role "%"', x->>'principal' using errcode = '22023';
      elsif x->>'type' = 'user' and not exists (select 1 from public.profiles pr where pr.id::text = x->>'principal') then
        raise exception 'Unknown user' using errcode = '22023';
      elsif coalesce(x->>'type', '') not in ('role', 'user') then
        raise exception 'Invalid access entry' using errcode = '22023';
      end if;
      insert into bi.app_access (app_id, principal_type, principal) values (v_app, x->>'type', x->>'principal') on conflict do nothing;
    end loop;
  end if;

  insert into bi.audit_log (actor, actor_id, action, object_type, object_name, details)
  values (bi.app_actor(), auth.uid(), case when is_new then 'add' else 'change' end, 'app', btrim(p->>'name'),
          jsonb_build_object('app_id', v_app, 'tables', (select jsonb_agg(v->>'table_name') from jsonb_array_elements(p->'model') v),
                             'access', p->'access'));
  return v_app;
exception when unique_violation then
  raise exception 'An app named "%" already exists', btrim(p->>'name') using errcode = '23505';
end;
$$;

create function public.bi_delete_app(p_app uuid)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  app_name text;
begin
  perform bi.require_builder();
  delete from bi.apps where id = p_app returning name into app_name;
  if app_name is null then raise exception 'App not found' using errcode = 'P0002'; end if;
  insert into bi.audit_log (actor, actor_id, action, object_type, object_name, details)
  values (bi.app_actor(), auth.uid(), 'remove', 'app', app_name, jsonb_build_object('app_id', p_app));
end;
$$;

-- Create or update a sheet. p = {id?, app_id, title, position, objects: [...]}
create function public.bi_save_sheet(p jsonb)
returns uuid language plpgsql volatile security definer set search_path = ''
as $$
declare
  sheet_id uuid := nullif(p->>'id', '')::uuid;
  target_app uuid := (p->>'app_id')::uuid;
begin
  perform bi.require_builder();
  if not exists (select 1 from bi.apps where id = target_app) then raise exception 'App not found' using errcode = 'P0002'; end if;
  if coalesce(btrim(p->>'title'), '') = '' then raise exception 'Give the sheet a title' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p->'objects', '[]')) <> 'array' or jsonb_array_length(coalesce(p->'objects', '[]')) > 60 then
    raise exception 'A sheet can hold at most 60 objects' using errcode = '22023';
  end if;
  if pg_column_size(coalesce(p->'objects', '[]')) > 500000 then raise exception 'The sheet is too large' using errcode = '22023'; end if;
  if sheet_id is null then
    insert into bi.sheets (app_id, title, position, objects, created_by, updated_by)
    values (target_app, btrim(p->>'title'), coalesce((p->>'position')::int,
            (select coalesce(max(position) + 1, 0) from bi.sheets where app_id = target_app)),
            coalesce(p->'objects', '[]'), auth.uid(), auth.uid())
    returning id into sheet_id;
  else
    update bi.sheets set title = btrim(p->>'title'), position = coalesce((p->>'position')::int, position),
      objects = coalesce(p->'objects', '[]'), updated_by = auth.uid(), updated_at = now()
    where id = sheet_id and app_id = target_app;
    if not found then raise exception 'Sheet not found' using errcode = 'P0002'; end if;
  end if;
  update bi.apps set updated_at = now() where id = target_app;
  return sheet_id;
end;
$$;

create function public.bi_delete_sheet(p_sheet uuid)
returns void language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform bi.require_builder();
  delete from bi.sheets where id = p_sheet;
  if not found then raise exception 'Sheet not found' using errcode = 'P0002'; end if;
end;
$$;

-- Roles and active users, for the app access editor
create function public.bi_list_principals()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  perform bi.require_builder();
  return jsonb_build_object(
    'roles', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'label', r.label) order by r.label), '[]') from public.roles r),
    'users', (select coalesce(jsonb_agg(jsonb_build_object('id', pr.id, 'name', coalesce(nullif(pr.display_name, ''), pr.email), 'email', pr.email)
        order by lower(coalesce(nullif(pr.display_name, ''), pr.email))), '[]') from public.profiles pr where pr.active)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Query engine
-- spec = {
--   "dimensions": [{"expr": node}],            -- group by
--   "measures":   [{"expr": node}],            -- aggregated values
--   "selections": [{"expr": node, "values": [json values]}],   -- app-wide selections (IN)
--   "conditions": [node],                      -- extra boolean filters, e.g. invoice_date = Today()-1
--   "sort": [{"index": 0, "desc": true}],      -- 0-based output column
--   "limit": 1000, "offset": 0
-- }
-- Returns {"rows": [[...], ...], "has_more": bool}
-- ---------------------------------------------------------------------------
create function public.bi_query(p_app uuid, p_spec jsonb)
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
  group_list text[] := '{}';
  where_list text[] := '{}';
  order_list text[] := '{}';
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
  tbl jsonb;
  from_sql text;
  query text;
  result jsonb;
  rows_out jsonb;
  pair jsonb;
  join_conds text[];
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

  for item in select * from jsonb_array_elements(dims) loop
    c := bi.compile_expr(item->'expr', model, false);
    select_list := select_list || format('%s as c%s', c->>'s', n);
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

  -- tables needed: those used plus their ancestors up to the main table
  needed := array(select distinct x from unnest(used) x);
  if array_length(needed, 1) is null then needed := array[model->'order'->>0]; end if;
  loop
    select coalesce(array_agg(distinct p), '{}') into used
    from unnest(needed) a, lateral (select model->'tables'->a->>'parent' as p) q
    where p is not null and not (p = any(needed));
    exit when array_length(used, 1) is null;
    needed := needed || used;
  end loop;

  from_sql := '';
  for alias in select a.value #>> '{}' from jsonb_array_elements(model->'order') with ordinality a(value, k) order by a.k loop
    if not (alias = any(needed)) then continue; end if;
    tbl := model->'tables'->alias;
    if tbl->>'parent' is null then
      from_sql := format('%I.%I as %I', 'bi_data', tbl->>'table', alias);
    else
      join_conds := '{}';
      for pair in select * from jsonb_array_elements(tbl->'pairs') loop
        join_conds := join_conds || format('%I.%I = %I.%I', alias, pair->>0, tbl->>'parent', pair->>1);
      end loop;
      from_sql := from_sql || format(' %s join %I.%I as %I on %s',
        case when tbl->>'join_type' = 'inner' then 'inner' else 'left' end, 'bi_data', tbl->>'table', alias, array_to_string(join_conds, ' and '));
    end if;
  end loop;

  query := format('select %s%s from %s%s%s order by %s limit %s offset %s',
    case when jsonb_array_length(meas) = 0 then 'distinct ' else '' end,
    array_to_string(select_list, ', '), from_sql,
    case when array_length(where_list, 1) > 0 then ' where ' || array_to_string(where_list, ' and ') else '' end,
    case when jsonb_array_length(meas) > 0 and array_length(group_list, 1) > 0 then ' group by ' || array_to_string(group_list, ', ') else '' end,
    array_to_string(order_list, ', '), lim + 1, off);

  perform set_config('statement_timeout', '20000', true);
  execute format('select coalesce(jsonb_agg(jsonb_build_array(%s)), ''[]'') from (%s) q',
    (select string_agg(format('q.c%s', i), ', ') from generate_series(0, ncols - 1) i), query) into rows_out;

  return jsonb_build_object(
    'rows', case when jsonb_array_length(rows_out) > lim then rows_out - lim else rows_out end,
    'has_more', jsonb_array_length(rows_out) > lim);
end;
$$;

revoke all on function bi.can_build(), bi.can_view_app(uuid), bi.require_builder(), bi.app_model(uuid),
  bi.compile_expr(jsonb, jsonb, boolean, boolean, integer), bi.validate_model(jsonb) from public, anon, authenticated;
revoke all on function public.bi_my_access(), public.bi_list_apps(), public.bi_get_app(uuid), public.bi_save_app(jsonb),
  public.bi_delete_app(uuid), public.bi_save_sheet(jsonb), public.bi_delete_sheet(uuid), public.bi_list_principals(),
  public.bi_query(uuid, jsonb) from public, anon;
grant execute on function public.bi_my_access(), public.bi_list_apps(), public.bi_get_app(uuid), public.bi_save_app(jsonb),
  public.bi_delete_app(uuid), public.bi_save_sheet(jsonb), public.bi_delete_sheet(uuid), public.bi_list_principals(),
  public.bi_query(uuid, jsonb) to authenticated;
