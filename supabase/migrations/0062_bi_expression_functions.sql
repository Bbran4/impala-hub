-- Impala Hub Reporting: more expression functions.
--
-- Replaces bi.compile_expr (from 0048_bi_apps.sql) with a larger whitelist matching the
-- function catalogue in frontend/src/biFunctions.ts (documented in docs/REPORTING_FUNCTIONS.md).
-- The security model is unchanged: the browser sends a JSON syntax tree, and only the
-- functions and operators listed here are turned into SQL; field names are resolved
-- against the app's data model and quoted; literals are quoted.
--
-- New: StDev, Concat (string_agg), MinString, MaxString, Only, Capitalize, LTrim, RTrim, Mid,
-- Index, Replace, SubField, Repeat, Floor, Ceil, Sign, Mod, Div, Sqrt, Pow, Exp, Log, Log10,
-- RangeSum, RangeMax, RangeMin, MonthName, MonthEnd, QuarterStart, YearEnd, AddDays,
-- AddMonths, AddYears, DaysBetween, IsNull, Null, Pick, Match, MixMatch, WildMatch.
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
    "mixmatch":[2,100],"wildmatch":[2,100]
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
        return jsonb_build_object('s', 'count(*)', 'a', '[]'::jsonb, 'g', true);
      end if;
      r := bi.compile_expr(args->0, p_model, p_agg_allowed, true, p_depth + 1);
      aliases := r->'a';
      s := r->>'s';
      if fname = 'concat' then
        if nargs = 2 then
          l := bi.compile_expr(args->1, p_model, p_agg_allowed, true, p_depth + 1);
          aliases := aliases || (l->'a');
        end if;
        return jsonb_build_object('s', format('string_agg(%s(%s)::text, %s order by (%s)::text)',
          case when is_distinct then 'distinct ' else '' end, s, coalesce('(' || (l->>'s') || ')::text', ''''''), s), 'a', aliases, 'g', true);
      end if;
      return jsonb_build_object('s', case fname
          when 'median' then format('percentile_cont(0.5) within group (order by (%s)::numeric)', s)
          when 'stdev' then format('stddev_samp((%s)::numeric)', s)
          when 'minstring' then format('min((%s)::text)', s)
          when 'maxstring' then format('max((%s)::text)', s)
          when 'only' then format('(case when count(distinct %s) = 1 then (array_agg(%s) filter (where %s is not null))[1] end)', s, s, s)
          else format('%s(%s%s)', fname, case when is_distinct then 'distinct ' else '' end, s)
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
      when 'null' then 'null'
    end;
    if s is null then raise exception 'Function "%" is not available', p_node->>'name' using errcode = '22023'; end if;
    return jsonb_build_object('s', s, 'a', aliases, 'g', has_agg);
  end if;
  raise exception 'Invalid expression' using errcode = '22023';
end;
$$;

revoke all on function bi.compile_expr(jsonb, jsonb, boolean, boolean, integer) from public, anon, authenticated;
