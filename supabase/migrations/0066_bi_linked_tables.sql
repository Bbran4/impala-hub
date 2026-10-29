-- Impala Hub Reporting: data models without a main table (like Qlik).
--
-- Tables in an app link to each other on key fields; none of them is "the main table".
-- The links are still stored as a tree (bi.app_tables.parent_alias + join_pairs: every table
-- except the first links to one other table), but bi_query now treats a link as two-way:
--   * it joins only the tables a chart uses, plus the tables that connect them, starting from
--     the first of them in the model;
--   * every link is a full join, so records without a match in a linked table are kept
--     (stock items that never sold still show in a stock chart; selections then narrow them);
--   * join_type is ignored.
-- Aggregations still count each record of the tables they use once (0064). Count(*) counts the
-- first table in the model; use Count(field) or Count(DISTINCT key) to count another table.
-- Also adds colour functions for table cell colours: RGB(r, g, b) and ColorMix1(value, '#c0', '#c1')
-- (bi.compile_expr is redefined from 0064 with these two added; nothing else changes).
-- Migration numbering: Reporting uses even numbers (see supabase/README.md).

create or replace function bi.compile_expr(p_node jsonb, p_model jsonb, p_agg_allowed boolean, p_in_agg boolean default false, p_depth integer default 0)
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
  alias text;
  col text;
  op text;
  sql_op text;
  is_agg boolean;
  is_distinct boolean;
  arity integer[];
  i integer;
  s text;
  kfilter text;
  kcol text;
  -- argument counts: {min, max}; max 100 means "any number"
  arities constant jsonb := '{
    "sum":[1,1],"avg":[1,1],"min":[1,1],"max":[1,1],"count":[1,1],"median":[1,1],"stdev":[1,1],"concat":[1,2],
    "minstring":[1,1],"maxstring":[1,1],"only":[1,1],
    "upper":[1,1],"lower":[1,1],"capitalize":[1,1],"trim":[1,1],"ltrim":[1,1],"rtrim":[1,1],"len":[1,1],
    "left":[2,2],"right":[2,2],"mid":[2,3],"index":[2,2],"replace":[3,3],"subfield":[3,3],"repeat":[2,2],"text":[1,1],
    "round":[1,2],"floor":[1,1],"ceil":[1,1],"abs":[1,1],"sign":[1,1],"mod":[2,2],"div":[2,2],"sqrt":[1,1],"pow":[2,2],
    "exp":[1,1],"log":[1,1],"log10":[1,1],"rangesum":[2,100],"rangemax":[2,100],"rangemin":[2,100],"num":[1,1],
    "today":[0,0],"now":[0,0],"date":[1,1],"year":[1,1],"quarter":[1,1],"month":[1,1],"week":[1,1],"day":[1,1],
    "weekday":[1,1],"monthname":[1,1],"yearmonth":[1,1],"weekstart":[1,1],"monthstart":[1,1],"monthend":[1,1],
    "quarterstart":[1,1],"yearstart":[1,1],"yearend":[1,1],"adddays":[2,2],"addmonths":[2,2],"addyears":[2,2],
    "daysbetween":[2,2],
    "if":[2,3],"alt":[2,100],"coalesce":[2,100],"isnull":[1,1],"null":[0,0],"pick":[2,100],"match":[2,100],
    "mixmatch":[2,100],"wildmatch":[2,100],
    "rgb":[3,3],"colormix1":[3,3]
  }';
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
    -- bi_query flattens the joined tables into q."alias.column" (p_model has "flat")
    return jsonb_build_object('s', case when p_model ? 'flat' then format('q.%I', alias || '.' || col) else format('%I.%I', alias, col) end,
      'a', jsonb_build_array(alias), 'g', false);
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
    if not (arities ? fname) then raise exception 'Function "%" is not available', p_node->>'name' using errcode = '22023'; end if;
    arity := array[(arities->fname->>0)::int, (arities->fname->>1)::int];
    if nargs < arity[1] or nargs > arity[2] then
      raise exception '%() takes % argument(s), not %', initcap(fname),
        case when arity[1] = arity[2] then arity[1]::text when arity[2] = 100 then 'at least ' || arity[1] else arity[1] || ' to ' || arity[2] end, nargs
        using errcode = '22023';
    end if;
    is_agg := fname in ('sum', 'avg', 'min', 'max', 'count', 'median', 'stdev', 'concat', 'minstring', 'maxstring', 'only');
    is_distinct := coalesce((p_node->>'distinct')::boolean, false);
    if is_distinct and fname not in ('sum', 'avg', 'count', 'concat') then
      raise exception '%() does not take DISTINCT', initcap(fname) using errcode = '22023';
    end if;

    if is_agg then
      if not p_agg_allowed then raise exception '%() can only be used in measures', initcap(fname) using errcode = '22023'; end if;
      if p_in_agg then raise exception 'Aggregations cannot be nested inside each other' using errcode = '22023'; end if;
      if fname = 'count' and args->0->>'t' = 'star' then
        r := jsonb_build_object('s', '', 'a', '[]'::jsonb);
      else
        r := bi.compile_expr(args->0, p_model, p_agg_allowed, true, p_depth + 1);
      end if;
      aliases := r->'a';
      s := r->>'s';
      if fname = 'concat' and nargs = 2 then
        l := bi.compile_expr(args->1, p_model, p_agg_allowed, true, p_depth + 1);
        aliases := aliases || (l->'a');
      end if;
      -- count each record of the tables this aggregation uses once (Count(*) counts main-table records)
      kcol := case when p_model ? 'flat' then format('q.%I', '#k:' || coalesce(
        (select string_agg(x, ',' order by x) from (select distinct jsonb_array_elements_text(aliases) x) d),
        p_model->'order'->>0)) end;
      kfilter := coalesce(' filter (where ' || kcol || ')', '');
      if fname = 'count' and args->0->>'t' = 'star' then
        return jsonb_build_object('s', 'count(*)' || kfilter, 'a', '[]'::jsonb, 'g', true);
      end if;
      if fname = 'concat' then
        return jsonb_build_object('s', format('string_agg(%s(%s)::text, %s order by (%s)::text)%s',
          case when is_distinct then 'distinct ' else '' end, s, coalesce('(' || (l->>'s') || ')::text', ''''''), s, kfilter), 'a', aliases, 'g', true);
      end if;
      return jsonb_build_object('s', case fname
          when 'median' then format('percentile_cont(0.5) within group (order by (%s)::numeric)%s', s, kfilter)
          when 'stdev' then format('stddev_samp((%s)::numeric)%s', s, kfilter)
          when 'minstring' then format('min((%s)::text)%s', s, kfilter)
          when 'maxstring' then format('max((%s)::text)%s', s, kfilter)
          when 'only' then format('(case when count(distinct %s)%s = 1 then (array_agg(%s) filter (where %s is not null%s))[1] end)',
            s, kfilter, s, s, coalesce(' and ' || kcol, ''))
          else format('%s(%s%s)%s', fname, case when is_distinct then 'distinct ' else '' end, s, kfilter)
        end, 'a', aliases, 'g', true);
    end if;

    -- scalar functions: compile every argument first
    for i in 0 .. nargs - 1 loop
      r := bi.compile_expr(args->i, p_model, p_agg_allowed, p_in_agg, p_depth + 1);
      parts := parts || (r->>'s');
      aliases := aliases || (r->'a');
      has_agg := has_agg or (r->>'g')::boolean;
    end loop;

    if fname in ('if', 'alt', 'coalesce', 'pick', 'match', 'mixmatch', 'wildmatch', 'rangesum', 'rangemax', 'rangemin') then
      s := case fname
        when 'if' then format('(case when %s then %s else %s end)', parts[1], parts[2], coalesce(parts[3], 'null'))
        when 'alt' then format('coalesce(%s)', array_to_string(parts, ', '))
        when 'coalesce' then format('coalesce(%s)', array_to_string(parts, ', '))
        when 'rangesum' then '(' || (select string_agg(format('coalesce((%s)::numeric, 0)', p), ' + ') from unnest(parts) p) || ')'
        when 'rangemax' then format('greatest(%s)', (select string_agg(format('(%s)::numeric', p), ', ') from unnest(parts) p))
        when 'rangemin' then format('least(%s)', (select string_agg(format('(%s)::numeric', p), ', ') from unnest(parts) p))
        when 'pick' then format('(case (%s)::int %s end)', parts[1],
          (select string_agg(format('when %s then %s', k - 1, parts[k]), ' ') from generate_series(2, nargs) k))
        when 'match' then format('(case %s else 0 end)',
          (select string_agg(format('when (%s)::text = (%s)::text then %s', parts[1], parts[k], k - 1), ' ') from generate_series(2, nargs) k))
        when 'mixmatch' then format('(case %s else 0 end)',
          (select string_agg(format('when lower((%s)::text) = lower((%s)::text) then %s', parts[1], parts[k], k - 1), ' ') from generate_series(2, nargs) k))
        when 'wildmatch' then format('(case %s else 0 end)',
          (select string_agg(format(
            'when lower((%s)::text) like translate(replace(replace(replace(lower((%s)::text), ''\'', ''\\''), ''%%'', ''\%%''), ''_'', ''\_''), ''*?'', ''%%_'') then %s',
            parts[1], parts[k], k - 1), ' ') from generate_series(2, nargs) k))
      end;
      return jsonb_build_object('s', s, 'a', aliases, 'g', has_agg);
    end if;

    s := case fname
      -- text
      when 'upper' then format('upper((%s)::text)', parts[1])
      when 'lower' then format('lower((%s)::text)', parts[1])
      when 'capitalize' then format('initcap((%s)::text)', parts[1])
      when 'trim' then format('btrim((%s)::text)', parts[1])
      when 'ltrim' then format('ltrim((%s)::text)', parts[1])
      when 'rtrim' then format('rtrim((%s)::text)', parts[1])
      when 'len' then format('length((%s)::text)', parts[1])
      when 'left' then format('left((%s)::text, (%s)::int)', parts[1], parts[2])
      when 'right' then format('right((%s)::text, (%s)::int)', parts[1], parts[2])
      when 'mid' then case when nargs = 3 then format('substr((%s)::text, (%s)::int, greatest((%s)::int, 0))', parts[1], parts[2], parts[3])
                           else format('substr((%s)::text, (%s)::int)', parts[1], parts[2]) end
      when 'index' then format('strpos((%s)::text, (%s)::text)', parts[1], parts[2])
      when 'replace' then format('replace((%s)::text, (%s)::text, (%s)::text)', parts[1], parts[2], parts[3])
      when 'subfield' then format('nullif(split_part((%s)::text, (%s)::text, greatest((%s)::int, 1)), '''')', parts[1], parts[2], parts[3])
      when 'repeat' then format('repeat((%s)::text, least(greatest((%s)::int, 0), 1000))', parts[1], parts[2])
      when 'text' then format('((%s)::text)', parts[1])
      -- number
      when 'round' then format('round((%s)::numeric, %s)', parts[1], coalesce('(' || parts[2] || ')::int', '0'))
      when 'floor' then format('floor((%s)::numeric)', parts[1])
      when 'ceil' then format('ceil((%s)::numeric)', parts[1])
      when 'abs' then format('abs((%s)::numeric)', parts[1])
      when 'sign' then format('sign((%s)::numeric)', parts[1])
      when 'mod' then format('mod((%s)::numeric, nullif((%s)::numeric, 0))', parts[1], parts[2])
      when 'div' then format('div((%s)::numeric, nullif((%s)::numeric, 0))', parts[1], parts[2])
      when 'sqrt' then format('(case when (%s)::numeric >= 0 then sqrt((%s)::numeric) end)', parts[1], parts[1])
      when 'pow' then format('power((%s)::numeric, (%s)::numeric)', parts[1], parts[2])
      when 'exp' then format('exp(least((%s)::numeric, 700))', parts[1])
      when 'log' then format('(case when (%s)::numeric > 0 then ln((%s)::numeric) end)', parts[1], parts[1])
      when 'log10' then format('(case when (%s)::numeric > 0 then log((%s)::numeric) end)', parts[1], parts[1])
      when 'num' then format('((%s)::numeric)', parts[1])
      -- date
      when 'today' then '(current_date)'
      when 'now' then '(now())'
      when 'date' then format('((%s)::date)', parts[1])
      when 'year' then format('(extract(year from %s)::int)', parts[1])
      when 'quarter' then format('(extract(quarter from %s)::int)', parts[1])
      when 'month' then format('(extract(month from %s)::int)', parts[1])
      when 'week' then format('(extract(week from %s)::int)', parts[1])
      when 'day' then format('(extract(day from %s)::int)', parts[1])
      when 'weekday' then format('(extract(isodow from %s)::int)', parts[1])
      when 'monthname' then format('to_char(%s, ''Mon YYYY'')', parts[1])
      when 'yearmonth' then format('to_char(%s, ''YYYY-MM'')', parts[1])
      when 'weekstart' then format('(date_trunc(''week'', %s)::date)', parts[1])
      when 'monthstart' then format('(date_trunc(''month'', %s)::date)', parts[1])
      when 'monthend' then format('((date_trunc(''month'', %s) + interval ''1 month'' - interval ''1 day'')::date)', parts[1])
      when 'quarterstart' then format('(date_trunc(''quarter'', %s)::date)', parts[1])
      when 'yearstart' then format('(date_trunc(''year'', %s)::date)', parts[1])
      when 'yearend' then format('((date_trunc(''year'', %s) + interval ''1 year'' - interval ''1 day'')::date)', parts[1])
      when 'adddays' then format('(((%s)::date) + (%s)::int)', parts[1], parts[2])
      when 'addmonths' then format('(((%s)::date + make_interval(months => (%s)::int))::date)', parts[1], parts[2])
      when 'addyears' then format('(((%s)::date + make_interval(years => (%s)::int))::date)', parts[1], parts[2])
      when 'daysbetween' then format('(((%s)::date) - ((%s)::date))', parts[2], parts[1])
      -- logic
      when 'isnull' then format('((%s) is null)', parts[1])
      -- colours (text such as 'rgb(1,2,3)'; the browser only applies values that look like colours)
      when 'rgb' then format('(''rgb('' || %s || '','' || %s || '','' || %s || '')'')',
        format('least(255, greatest(0, round((%s)::numeric)))::int', parts[1]),
        format('least(255, greatest(0, round((%s)::numeric)))::int', parts[2]),
        format('least(255, greatest(0, round((%s)::numeric)))::int', parts[3]))
      when 'colormix1' then format('(case when (%s) is not null and (%s)::text ~ ''^#[0-9a-fA-F]{6}$'' and (%s)::text ~ ''^#[0-9a-fA-F]{6}$'' then ''rgb('' || %s || '','' || %s || '','' || %s || '')'' end)',
        parts[1], parts[2], parts[3],
        format('round(%1$s + (%2$s - %1$s) * least(1, greatest(0, (%3$s)::numeric)))::int',
          format('(''x'' || substr((%s)::text, 2, 2))::bit(8)::int', parts[2]),
          format('(''x'' || substr((%s)::text, 2, 2))::bit(8)::int', parts[3]), parts[1]),
        format('round(%1$s + (%2$s - %1$s) * least(1, greatest(0, (%3$s)::numeric)))::int',
          format('(''x'' || substr((%s)::text, 4, 2))::bit(8)::int', parts[2]),
          format('(''x'' || substr((%s)::text, 4, 2))::bit(8)::int', parts[3]), parts[1]),
        format('round(%1$s + (%2$s - %1$s) * least(1, greatest(0, (%3$s)::numeric)))::int',
          format('(''x'' || substr((%s)::text, 6, 2))::bit(8)::int', parts[2]),
          format('(''x'' || substr((%s)::text, 6, 2))::bit(8)::int', parts[3]), parts[1]))
      when 'null' then 'null'
    end;
    if s is null then raise exception 'Function "%" is not available', p_node->>'name' using errcode = '22023'; end if;
    return jsonb_build_object('s', s, 'a', aliases, 'g', has_agg);
  end if;
  raise exception 'Invalid expression' using errcode = '22023';
end;
$$;

revoke all on function bi.compile_expr(jsonb, jsonb, boolean, boolean, integer) from public, anon, authenticated;


create or replace function bi.validate_model(p_tables jsonb)
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
  if roots <> 1 then raise exception 'Link every table to another table, except the first one' using errcode = '22023'; end if;

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
    raise exception 'Every table must be linked to the others, and the links cannot form a loop' using errcode = '22023';
  end if;
end;
$$;


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

revoke all on function public.bi_query(uuid, jsonb) from public, anon;
grant execute on function public.bi_query(uuid, jsonb) to authenticated;
