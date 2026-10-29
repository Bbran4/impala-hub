-- Reporting calculations (batch 1 of the Qlik feature list):
--   * set analysis:      Sum({<year={2025}, branch=>} sales), Sum({1} sales), Sum({A} sales) for alternate states
--   * Aggr():            Avg(Aggr(Sum(sales), customer))
--   * chart functions:   Above(), Below(), RowNo(), NoOfRows(), Top(), Bottom(), RangeSum(Above(Sum(x), 0, RowNo()))
--   * calculated fields: per-table fields defined by an expression in the app's data model
-- bi.compile_expr and public.bi_query are redefined (latest earlier versions: 0066 and 0080).

alter table bi.apps add column calc_fields jsonb not null default '[]' check (jsonb_typeof(calc_fields) = 'array');

-- merges what sub-expressions report besides their SQL: sets, Aggr() parts and window use
create function bi.cx_extra(p_acc jsonb, p_r jsonb)
returns jsonb language sql immutable set search_path = ''
as $$
  select jsonb_build_object(
    'sets', coalesce(p_acc->'sets', '{}') || coalesce(p_r->'sets', '{}'),
    'aggrs', coalesce(p_acc->'aggrs', '{}') || coalesce(p_r->'aggrs', '{}'),
    'w', coalesce((p_acc->>'w')::boolean, false) or coalesce((p_r->>'w')::boolean, false));
$$;

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
  extra jsonb := '{}';
  setid text;
  inner_r jsonb;
  dsql text[];
  aggr_id text;
  win text;
  frame text;
  off integer;
  cnt integer;
  unbounded boolean;
  arg0 jsonb;
  -- argument counts: {min, max}; max 100 means "any number"
  arities constant jsonb := '{
    "sum":[1,1],"avg":[1,1],"min":[1,1],"max":[1,1],"count":[1,1],"median":[1,1],"stdev":[1,1],"concat":[1,2],
    "minstring":[1,1],"maxstring":[1,1],"only":[1,1],
    "upper":[1,1],"lower":[1,1],"capitalize":[1,1],"trim":[1,1],"ltrim":[1,1],"rtrim":[1,1],"len":[1,1],
    "left":[2,2],"right":[2,2],"mid":[2,3],"index":[2,2],"replace":[3,3],"subfield":[3,3],"repeat":[2,2],"text":[1,1],
    "round":[1,2],"floor":[1,1],"ceil":[1,1],"abs":[1,1],"sign":[1,1],"mod":[2,2],"div":[2,2],"sqrt":[1,1],"pow":[2,2],
    "exp":[1,1],"log":[1,1],"log10":[1,1],"rangesum":[1,100],"rangemax":[1,100],"rangemin":[1,100],"rangeavg":[1,100],"rangecount":[1,100],"num":[1,1],
    "today":[0,0],"now":[0,0],"date":[1,1],"year":[1,1],"quarter":[1,1],"month":[1,1],"week":[1,1],"day":[1,1],
    "weekday":[1,1],"monthname":[1,1],"yearmonth":[1,1],"weekstart":[1,1],"monthstart":[1,1],"monthend":[1,1],
    "quarterstart":[1,1],"yearstart":[1,1],"yearend":[1,1],"adddays":[2,2],"addmonths":[2,2],"addyears":[2,2],
    "daysbetween":[2,2],
    "if":[2,3],"alt":[2,100],"coalesce":[2,100],"isnull":[1,1],"null":[0,0],"pick":[2,100],"match":[2,100],
    "mixmatch":[2,100],"wildmatch":[2,100],
    "rgb":[3,3],"colormix1":[3,3],
    "aggr":[2,10],"above":[1,3],"below":[1,3],"rowno":[0,0],"noofrows":[0,0],"top":[1,1],"bottom":[1,1]
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
    return jsonb_build_object('s', case when t = 'neg' then '(-' || (r->>'s') || ')' else '(not ' || (r->>'s') || ')' end, 'a', r->'a', 'g', r->'g')
      || bi.cx_extra('{}', r);
  elsif t = 'bin' then
    op := lower(p_node->>'op');
    l := bi.compile_expr(p_node->'l', p_model, p_agg_allowed, p_in_agg, p_depth + 1);
    r := bi.compile_expr(p_node->'r', p_model, p_agg_allowed, p_in_agg, p_depth + 1);
    aliases := (l->'a') || (r->'a');
    has_agg := (l->>'g')::boolean or (r->>'g')::boolean;
    extra := bi.cx_extra(bi.cx_extra('{}', l), r);
    if op = '/' then
      return jsonb_build_object('s', format('((%s)::numeric / nullif((%s)::numeric, 0))', l->>'s', r->>'s'), 'a', aliases, 'g', has_agg) || extra;
    elsif op = '&' then
      return jsonb_build_object('s', format('(coalesce((%s)::text, '''') || coalesce((%s)::text, ''''))', l->>'s', r->>'s'), 'a', aliases, 'g', has_agg) || extra;
    end if;
    sql_op := case op when '+' then '+' when '-' then '-' when '*' then '*' when '=' then '=' when '<>' then '<>'
      when '<' then '<' when '<=' then '<=' when '>' then '>' when '>=' then '>=' when 'and' then 'and' when 'or' then 'or' end;
    if sql_op is null then raise exception 'Operator "%" is not allowed', p_node->>'op' using errcode = '22023'; end if;
    return jsonb_build_object('s', format('(%s %s %s)', l->>'s', sql_op, r->>'s'), 'a', aliases, 'g', has_agg) || extra;
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

    if p_node ? 'set' and not is_agg then raise exception 'Only aggregations take a set, e.g. Sum({<year={2025}>} sales)' using errcode = '22023'; end if;
    if p_node ? 'total' and fname not in ('above', 'below', 'rowno', 'noofrows', 'top', 'bottom') then
      raise exception '%() does not take TOTAL', initcap(fname) using errcode = '22023';
    end if;
    if is_agg then
      if not p_agg_allowed then raise exception '%() can only be used in measures', initcap(fname) using errcode = '22023'; end if;
      if p_in_agg then raise exception 'Aggregations cannot be nested inside each other; use Aggr(), e.g. Avg(Aggr(Sum(sales), customer))' using errcode = '22023'; end if;
      -- set analysis: {<field={values}>}; bi_query turns each set into a row condition (#x:<id>)
      if p_node ? 'set' then
        if jsonb_typeof(p_node->'set') <> 'object' or length((p_node->'set')::text) > 20000 then
          raise exception 'Invalid set expression' using errcode = '22023';
        end if;
        setid := 'x' || left(md5((p_node->'set')::text), 12);
        extra := jsonb_build_object('sets', jsonb_build_object(setid, p_node->'set'));
      end if;
      -- Aggr(inner, dim, ...): the inner measure per dimension values, then this aggregation over those values
      if args->0->>'t' = 'fn' and lower(args->0->>'name') = 'aggr' then
        if fname not in ('sum', 'avg', 'min', 'max', 'count', 'median', 'stdev') then
          raise exception 'Use Aggr() inside Sum, Avg, Min, Max, Count, Median or StDev' using errcode = '22023';
        end if;
        if setid is not null then raise exception 'Put the set inside Aggr(), e.g. Avg(Aggr(Sum({<year={2025}>} sales), customer))' using errcode = '22023'; end if;
        arg0 := args->0;
        if jsonb_typeof(arg0->'args') <> 'array' or jsonb_array_length(arg0->'args') not between 2 and 10 then
          raise exception 'Aggr() takes a measure and 1 to 9 dimensions' using errcode = '22023';
        end if;
        inner_r := bi.compile_expr(arg0->'args'->0, p_model, true, false, p_depth + 2);
        if not (inner_r->>'g')::boolean then raise exception 'The first argument of Aggr() needs an aggregation such as Sum()' using errcode = '22023'; end if;
        if coalesce((inner_r->>'w')::boolean, false) or coalesce(inner_r->'aggrs', '{}') <> '{}' then
          raise exception 'Aggr() cannot contain Above(), RowNo() or another Aggr()' using errcode = '22023';
        end if;
        dsql := '{}';
        aliases := coalesce(inner_r->'a', '[]');
        for i in 1 .. jsonb_array_length(arg0->'args') - 1 loop
          r := bi.compile_expr(arg0->'args'->i, p_model, false, false, p_depth + 2);
          dsql := dsql || (r->>'s');
          aliases := aliases || (r->'a');
        end loop;
        aggr_id := 'a_' || left(md5(arg0::text || fname || is_distinct::text), 12);
        return jsonb_build_object('s', format('max(%I.v)', aggr_id), 'a', aliases, 'g', true, 'w', false,
          'sets', coalesce(inner_r->'sets', '{}'),
          'aggrs', jsonb_build_object(aggr_id, jsonb_build_object('fn', fname, 'distinct', is_distinct, 'inner', inner_r->>'s', 'dims', to_jsonb(dsql))));
      end if;
      if fname = 'count' and args->0->>'t' = 'star' then
        r := jsonb_build_object('s', '', 'a', '[]'::jsonb);
      else
        r := bi.compile_expr(args->0, p_model, p_agg_allowed, true, p_depth + 1);
      end if;
      if args->0->>'t' = 'fn' and lower(args->0->>'name') = 'aggr' then raise exception 'Invalid Aggr()' using errcode = '22023'; end if;
      aliases := r->'a';
      s := r->>'s';
      if fname = 'concat' and nargs = 2 then
        l := bi.compile_expr(args->1, p_model, p_agg_allowed, true, p_depth + 1);
        aliases := aliases || (l->'a');
      end if;
      -- count each record of the tables this aggregation uses once (Count(*) counts main-table records)
      kcol := case when p_model ? 'flat' then format('q.%I', '#k:' || coalesce(
        (select string_agg(x, ',' order by x) from (select distinct jsonb_array_elements_text(aliases) x) d),
        p_model->'order'->>0) || coalesce('@' || setid, '')) end;
      kfilter := coalesce(' filter (where ' || kcol || ')', '');
      if fname = 'count' and args->0->>'t' = 'star' then
        return jsonb_build_object('s', 'count(*)' || kfilter, 'a', '[]'::jsonb, 'g', true) || extra;
      end if;
      if fname = 'concat' then
        return jsonb_build_object('s', format('string_agg(%s(%s)::text, %s order by (%s)::text)%s',
          case when is_distinct then 'distinct ' else '' end, s, coalesce('(' || (l->>'s') || ')::text', ''''''), s, kfilter), 'a', aliases, 'g', true) || extra;
      end if;
      return jsonb_build_object('s', case fname
          when 'median' then format('percentile_cont(0.5) within group (order by (%s)::numeric)%s', s, kfilter)
          when 'stdev' then format('stddev_samp((%s)::numeric)%s', s, kfilter)
          when 'minstring' then format('min((%s)::text)%s', s, kfilter)
          when 'maxstring' then format('max((%s)::text)%s', s, kfilter)
          when 'only' then format('(case when count(distinct %s)%s = 1 then (array_agg(%s) filter (where %s is not null%s))[1] end)',
            s, kfilter, s, s, coalesce(' and ' || kcol, ''))
          else format('%s(%s%s)%s', fname, case when is_distinct then 'distinct ' else '' end, s, kfilter)
        end, 'a', aliases, 'g', true) || extra;
    end if;

    if fname = 'aggr' then
      raise exception 'Aggr() must be the whole argument of an aggregation, e.g. Avg(Aggr(Sum(sales), customer))' using errcode = '22023';
    end if;

    -- chart inter-record functions (window functions over the chart's rows, in its sort order):
    -- bi_query puts the chart's window into p_model (win: partition by all but the last dimension
    -- and order by the dimensions; wint: TOTAL, no partition)
    win := case when coalesce((p_node->>'total')::boolean, false) then coalesce(p_model->>'wint', '') else coalesce(p_model->>'win', '') end;
    if fname in ('above', 'below', 'rowno', 'noofrows', 'top', 'bottom')
       or (fname in ('rangesum', 'rangeavg', 'rangemin', 'rangemax', 'rangecount') and nargs = 1
           and args->0->>'t' = 'fn' and lower(args->0->>'name') in ('above', 'below')) then
      if not p_agg_allowed then raise exception '%() can only be used in measures', initcap(fname) using errcode = '22023'; end if;
      if p_in_agg then raise exception '%() cannot be used inside an aggregation', initcap(fname) using errcode = '22023'; end if;
      if fname = 'rowno' then
        return jsonb_build_object('s', format('row_number() over (%s)', win), 'a', '[]'::jsonb, 'g', true, 'w', true);
      elsif fname = 'noofrows' then
        return jsonb_build_object('s', format('count(*) over (%s)', case when coalesce((p_node->>'total')::boolean, false) then '' else coalesce(p_model->>'wpart', '') end),
          'a', '[]'::jsonb, 'g', true, 'w', true);
      end if;
      arg0 := case when fname in ('above', 'below', 'top', 'bottom') then p_node else args->0 end;
      win := case when coalesce((arg0->>'total')::boolean, false) then coalesce(p_model->>'wint', '') else coalesce(p_model->>'win', '') end;
      r := bi.compile_expr(arg0->'args'->0, p_model, true, false, p_depth + 2);
      if not (r->>'g')::boolean then
        raise exception '%() needs an aggregation, e.g. %(Sum(sales))', initcap(lower(arg0->>'name')), initcap(lower(arg0->>'name')) using errcode = '22023';
      end if;
      if coalesce((r->>'w')::boolean, false) then raise exception 'Above(), Below() and RowNo() cannot be nested' using errcode = '22023'; end if;
      off := 1; cnt := 1; unbounded := false;
      if jsonb_array_length(arg0->'args') >= 2 then
        if arg0->'args'->1->>'t' <> 'num' or (arg0->'args'->1->>'v')::numeric not between 0 and 10000 or (arg0->'args'->1->>'v')::numeric % 1 <> 0 then
          raise exception 'The offset of %() must be a whole number, e.g. Above(Sum(sales), 1)', initcap(lower(arg0->>'name')) using errcode = '22023';
        end if;
        off := (arg0->'args'->1->>'v')::int;
      end if;
      if jsonb_array_length(arg0->'args') = 3 then
        if arg0->'args'->2->>'t' = 'fn' and lower(arg0->'args'->2->>'name') in ('rowno', 'noofrows') then
          unbounded := true;
        elsif arg0->'args'->2->>'t' <> 'num' or (arg0->'args'->2->>'v')::numeric not between 1 and 10000 or (arg0->'args'->2->>'v')::numeric % 1 <> 0 then
          raise exception 'The count of %() must be a whole number or RowNo()', initcap(lower(arg0->>'name')) using errcode = '22023';
        else
          cnt := (arg0->'args'->2->>'v')::int;
        end if;
      end if;
      if fname in ('above', 'below') then
        if cnt <> 1 or unbounded then
          raise exception 'Use %() with a count inside RangeSum(), RangeAvg(), RangeMin(), RangeMax() or RangeCount()', initcap(fname) using errcode = '22023';
        end if;
        s := format('%s(%s, %s) over (%s)', case when fname = 'above' then 'lag' else 'lead' end, r->>'s', off, win);
      elsif fname in ('top', 'bottom') then
        s := format('%s(%s) over (%s rows between unbounded preceding and unbounded following)',
          case when fname = 'top' then 'first_value' else 'last_value' end, r->>'s', win);
      else
        frame := case when lower(arg0->>'name') = 'above'
          then format('rows between %s and %s', case when unbounded then 'unbounded preceding' else (off + cnt - 1) || ' preceding' end,
                      case when off = 0 then 'current row' else off || ' preceding' end)
          else format('rows between %s and %s', case when off = 0 then 'current row' else off || ' following' end,
                      case when unbounded then 'unbounded following' else (off + cnt - 1) || ' following' end) end;
        s := case fname
          when 'rangesum' then format('coalesce(sum((%s)::numeric) over (%s %s), 0)', r->>'s', win, frame)
          when 'rangeavg' then format('avg((%s)::numeric) over (%s %s)', r->>'s', win, frame)
          when 'rangemin' then format('min((%s)::numeric) over (%s %s)', r->>'s', win, frame)
          when 'rangemax' then format('max((%s)::numeric) over (%s %s)', r->>'s', win, frame)
          when 'rangecount' then format('count(%s) over (%s %s)', r->>'s', win, frame)
        end;
      end if;
      return jsonb_build_object('s', s, 'a', r->'a', 'g', true, 'w', true) || bi.cx_extra(jsonb_build_object('w', true), r - 'w');
    end if;

    -- scalar functions: compile every argument first
    for i in 0 .. nargs - 1 loop
      r := bi.compile_expr(args->i, p_model, p_agg_allowed, p_in_agg, p_depth + 1);
      parts := parts || (r->>'s');
      aliases := aliases || (r->'a');
      has_agg := has_agg or (r->>'g')::boolean;
      extra := bi.cx_extra(extra, r);
    end loop;

    if fname in ('if', 'alt', 'coalesce', 'pick', 'match', 'mixmatch', 'wildmatch', 'rangesum', 'rangemax', 'rangemin', 'rangeavg', 'rangecount') then
      s := case fname
        when 'if' then format('(case when %s then %s else %s end)', parts[1], parts[2], coalesce(parts[3], 'null'))
        when 'alt' then format('coalesce(%s)', array_to_string(parts, ', '))
        when 'coalesce' then format('coalesce(%s)', array_to_string(parts, ', '))
        when 'rangesum' then '(' || (select string_agg(format('coalesce((%s)::numeric, 0)', p), ' + ') from unnest(parts) p) || ')'
        when 'rangemax' then format('greatest(%s)', (select string_agg(format('(%s)::numeric', p), ', ') from unnest(parts) p))
        when 'rangemin' then format('least(%s)', (select string_agg(format('(%s)::numeric', p), ', ') from unnest(parts) p))
        when 'rangeavg' then format('((%s) / nullif(%s, 0))', (select string_agg(format('coalesce((%s)::numeric, 0)', p), ' + ') from unnest(parts) p),
          (select string_agg(format('(case when (%s) is null then 0 else 1 end)', p), ' + ') from unnest(parts) p))
        when 'rangecount' then format('(%s)', (select string_agg(format('(case when (%s) is null then 0 else 1 end)', p), ' + ') from unnest(parts) p))
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
      return jsonb_build_object('s', s, 'a', aliases, 'g', has_agg) || extra;
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
    return jsonb_build_object('s', s, 'a', aliases, 'g', has_agg) || extra;
  end if;
  raise exception 'Invalid expression' using errcode = '22023';
end;
$$;

-- The app's model for the query engine; calculated fields appear as columns of type 'calc', with
-- their expressions in "calc" ({"alias.name": node}).
create or replace function bi.app_model(p_app uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  with recursive tree as (
    select t.alias, t.table_name, t.parent_alias, t.join_type, t.join_pairs, t.position, 0 as depth
    from bi.app_tables t where t.app_id = p_app and t.parent_alias is null
    union all
    select c.alias, c.table_name, c.parent_alias, c.join_type, c.join_pairs, c.position, tree.depth + 1
    from bi.app_tables c join tree on c.parent_alias = tree.alias and c.app_id = p_app
    where tree.depth < 20
  ), calc as (
    select cf from bi.apps a, jsonb_array_elements(a.calc_fields) cf where a.id = p_app
  )
  select jsonb_build_object(
    'order', coalesce(jsonb_agg(to_jsonb(tree.alias) order by tree.depth, tree.position, tree.alias), '[]'),
    'cols', coalesce(jsonb_object_agg(tree.alias, coalesce(
        (select jsonb_object_agg(c->>'name', c->>'type') from jsonb_array_elements(d.columns) c where c->>'name' <> '_bi_loaded_at'),
        '{}'::jsonb) || coalesce((select jsonb_object_agg(cf->>'name', 'calc') from calc where cf->>'table' = tree.alias), '{}')), '{}'),
    'tables', coalesce(jsonb_object_agg(tree.alias, jsonb_build_object(
        'table', tree.table_name, 'parent', tree.parent_alias, 'join_type', tree.join_type, 'pairs', tree.join_pairs)), '{}'),
    'calc', coalesce((select jsonb_object_agg((cf->>'table') || '.' || (cf->>'name'), cf->'node') from calc), '{}')
  )
  from tree left join bi.data_tables d on d.table_name = tree.table_name;
$$;

-- Selections as one row condition: (expr = any(values) [or expr is null])
create function bi.selection_cond(p_sql text, p_values jsonb)
returns text language plpgsql immutable set search_path = ''
as $$
declare
  vals text[] := '{}';
  has_null boolean := false;
  v jsonb;
begin
  if jsonb_typeof(p_values) <> 'array' or jsonb_array_length(p_values) = 0 then return null; end if;
  if jsonb_array_length(p_values) > 5000 then raise exception 'Too many selected values' using errcode = '22023'; end if;
  for v in select * from jsonb_array_elements(p_values) loop
    if jsonb_typeof(v) = 'null' then has_null := true; else vals := vals || quote_literal(v::text); end if;
  end loop;
  return format('(%s%s)',
    case when array_length(vals, 1) > 0 then format('to_jsonb(%s) = any(array[%s]::jsonb[])', p_sql, array_to_string(vals, ', ')) else 'false' end,
    case when has_null then format(' or %s is null', p_sql) else '' end);
end;
$$;

-- One set expression {base<field op {values}, ...>} as a row condition, given the selections
-- (p_states: {"$": [{"key": sql, "cond": sql}], "A": [...], ...}). Returns 'true' for no condition.
create function bi.set_cond(p_set jsonb, p_model jsonb, p_states jsonb)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  base text := coalesce(p_set->>'base', '$');
  sel jsonb;          -- [{key, cond}] in force
  m jsonb;
  e jsonb;
  c jsonb;
  fsql text;
  op text;
  econd text[];
  ecs text;
  existing text;
  cmp jsonb;
  aliases jsonb := '[]';
  out text[] := '{}';
  pat text;
begin
  if base = '1' then sel := '[]';
  elsif base = '$' then sel := coalesce(p_states->'$', '[]');
  elsif base ~ '^[A-Za-z][A-Za-z0-9_]{0,20}$' then
    if not (p_states ? base) then raise exception 'Unknown state "%" in a set expression', base using errcode = '22023'; end if;
    sel := p_states->base;
  else
    raise exception 'Invalid set expression' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_set->'mods', '[]')) <> 'array' or jsonb_array_length(coalesce(p_set->'mods', '[]')) > 20 then
    raise exception 'Invalid set expression' using errcode = '22023';
  end if;
  for m in select * from jsonb_array_elements(coalesce(p_set->'mods', '[]')) loop
    op := coalesce(m->>'op', '=');
    if op not in ('=', '+=', '-=', '*=') then raise exception 'Invalid set operator "%"', op using errcode = '22023'; end if;
    c := bi.compile_expr(m->'field', p_model, false);
    fsql := c->>'s';
    aliases := aliases || (c->'a');
    -- the element list as one condition (null = no list: clear the field)
    ecs := null;
    if jsonb_typeof(m->'values') = 'array' then
      if jsonb_array_length(m->'values') > 1000 then raise exception 'Too many values in a set expression' using errcode = '22023'; end if;
      econd := '{}';
      for e in select * from jsonb_array_elements(m->'values') loop
        if e ? 'v' then
          if jsonb_typeof(e->'v') not in ('string', 'number', 'boolean') then raise exception 'Invalid set value' using errcode = '22023'; end if;
          econd := econd || format('to_jsonb(%s) = %L::jsonb', fsql, (e->'v')::text);
        elsif e ? 'search' then
          if jsonb_typeof(e->'search') <> 'string' or length(e->>'search') > 500 then raise exception 'Invalid set search' using errcode = '22023'; end if;
          pat := translate(replace(replace(replace(lower(e->>'search'), '\', '\\'), '%', '\%'), '_', '\_'), '*?', '%_');
          econd := econd || format('lower((%s)::text) like %L', fsql, pat);
        elsif e ? 'cmp' then
          if jsonb_typeof(e->'cmp') <> 'array' or jsonb_array_length(e->'cmp') not between 1 and 2 then raise exception 'Invalid set search' using errcode = '22023'; end if;
          ecs := '';
          for cmp in select * from jsonb_array_elements(e->'cmp') loop
            if cmp->>'op' not in ('>', '>=', '<', '<=', '=', '<>') then raise exception 'Invalid set comparison' using errcode = '22023'; end if;
            c := bi.compile_expr(cmp->'e', p_model, false);
            if jsonb_array_length(c->'a') > 0 then raise exception 'Set comparisons compare with values, not fields' using errcode = '22023'; end if;
            ecs := ecs || case when ecs = '' then '' else ' and ' end || format('(%s) %s (%s)', fsql, cmp->>'op', c->>'s');
          end loop;
          econd := econd || ('(' || ecs || ')');
          ecs := null;
        elsif e ? 'e' then
          c := bi.compile_expr(e->'e', p_model, false);
          if jsonb_array_length(c->'a') > 0 then raise exception 'Set values cannot refer to fields' using errcode = '22023'; end if;
          econd := econd || format('(%s) = (%s)', fsql, c->>'s');
        else
          raise exception 'Invalid set value' using errcode = '22023';
        end if;
      end loop;
      ecs := case when cardinality(econd) = 0 then 'false' else '(' || array_to_string(econd, ' or ') || ')' end;
    elsif op <> '=' then
      raise exception 'Set operator % needs a list of values', op using errcode = '22023';
    end if;
    existing := (select string_agg(x->>'cond', ' and ') from jsonb_array_elements(sel) x where x->>'key' = fsql);
    sel := coalesce((select jsonb_agg(x) from jsonb_array_elements(sel) x where x->>'key' <> fsql), '[]');
    if op = '=' then
      if ecs is not null then sel := sel || jsonb_build_object('key', fsql, 'cond', format('coalesce(%s, false)', ecs)); end if;
    elsif op = '+=' then
      if existing is not null then sel := sel || jsonb_build_object('key', fsql, 'cond', format('(coalesce(%s, false) or coalesce(%s, false))', existing, ecs)); end if;
    elsif op = '-=' then
      sel := sel || jsonb_build_object('key', fsql, 'cond', format('(%s not coalesce(%s, false))', coalesce('coalesce(' || existing || ', false) and', ''), ecs));
    else
      sel := sel || jsonb_build_object('key', fsql, 'cond', format('(%scoalesce(%s, false))', coalesce('coalesce(' || existing || ', false) and ', ''), ecs));
    end if;
  end loop;
  out := array(select x->>'cond' from jsonb_array_elements(sel) x);
  return jsonb_build_object('cond', case when cardinality(out) = 0 then 'true' else array_to_string(out, ' and ') end, 'a', aliases);
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
  states jsonb := coalesce(p_spec->'states', '{}');
  conds jsonb := coalesce(p_spec->'conditions', '[]');
  sorts jsonb := coalesce(p_spec->'sort', '[]');
  lim integer := least(greatest(coalesce((p_spec->>'limit')::int, 1000), 1), 10000);
  off integer := least(greatest(coalesce((p_spec->>'offset')::int, 0), 0), 1000000);
  select_list text[] := '{}';
  having_list text[] := '{}';
  dim_list text[] := '{}';
  group_list text[] := '{}';
  where_list text[] := '{}';
  order_list text[] := '{}';
  win_order text[] := '{}';
  flat_list text[] := '{}';
  flag_list text[] := '{}';
  used text[] := '{}';
  needed text[];
  c jsonb;
  item jsonb;
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
  -- set analysis
  sets jsonb := '{}';
  aggrs jsonb := '{}';
  state_sel jsonb := '{}';    -- {"$": [{key, cond}], "A": [...]}
  st text;
  stlist jsonb;
  base_cond text := 'true';
  set_conds jsonb := '{}';    -- {setid: cond}
  sc jsonb;
  setid text;
  flag_mode boolean;
  flag_cond text;
  aj text;
  aspec jsonb;
  joins text := '';
  calc_model jsonb;
begin
  if not bi.can_view_app(p_app) then
    raise exception 'You do not have access to this app' using errcode = '42501';
  end if;
  if jsonb_typeof(dims) <> 'array' or jsonb_typeof(meas) <> 'array' or jsonb_typeof(sels) <> 'array'
     or jsonb_typeof(conds) <> 'array' or jsonb_typeof(sorts) <> 'array' or jsonb_typeof(states) <> 'object' then
    raise exception 'Invalid query' using errcode = '22023';
  end if;
  if jsonb_array_length(dims) + jsonb_array_length(meas) = 0 then raise exception 'Add a dimension or a measure' using errcode = '22023'; end if;
  if jsonb_array_length(dims) > 10 or jsonb_array_length(meas) > 20 or jsonb_array_length(sels) > 50 or jsonb_array_length(conds) > 20
     or (select count(*) from jsonb_object_keys(states)) > 5 then
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

  -- sort order, and the window for Above()/RowNo(): partition by all but the last dimension,
  -- ordered by the dimensions as sorted in the chart
  for item in select * from jsonb_array_elements(sorts) loop
    if (item->>'index')::int < 0 or (item->>'index')::int >= jsonb_array_length(dims) + jsonb_array_length(meas) then
      raise exception 'Invalid sort' using errcode = '22023';
    end if;
    order_list := order_list || format('%s %s nulls last', (item->>'index')::int + 1, case when coalesce((item->>'desc')::boolean, false) then 'desc' else 'asc' end);
    if (item->>'index')::int < jsonb_array_length(dims) then
      win_order := win_order || format('%s %s nulls last', dim_list[(item->>'index')::int + 1], case when coalesce((item->>'desc')::boolean, false) then 'desc' else 'asc' end);
    end if;
  end loop;
  if cardinality(win_order) = 0 then win_order := array(select d || ' asc nulls last' from unnest(dim_list) d); end if;
  model := model || jsonb_build_object(
    'win', concat_ws(' ', case when cardinality(dim_list) > 1 then 'partition by ' || array_to_string(dim_list[1:cardinality(dim_list) - 1], ', ') end,
                     case when cardinality(win_order) > 0 then 'order by ' || array_to_string(win_order, ', ') end),
    'wint', case when cardinality(win_order) > 0 then 'order by ' || array_to_string(win_order, ', ') else '' end,
    'wpart', case when cardinality(dim_list) > 1 then 'partition by ' || array_to_string(dim_list[1:cardinality(dim_list) - 1], ', ') else '' end);

  for item in select * from jsonb_array_elements(meas) loop
    c := bi.compile_expr(item->'expr', model, true);
    if not (c->>'g')::boolean then
      raise exception 'Measures need an aggregation such as Sum(), Count() or Avg()' using errcode = '22023';
    end if;
    select_list := select_list || format('%s as c%s', c->>'s', n);
    if not coalesce((c->>'w')::boolean, false) then having_list := having_list || format('(%s) is null', c->>'s'); end if;
    used := used || array(select jsonb_array_elements_text(c->'a'));
    sets := sets || coalesce(c->'sets', '{}');
    aggrs := aggrs || coalesce(c->'aggrs', '{}');
    n := n + 1;
  end loop;
  ncols := n;
  if cardinality(order_list) = 0 then
    for n in 1 .. ncols loop order_list := order_list || format('%s asc nulls last', n); end loop;
  end if;
  flag_mode := sets <> '{}';

  -- selections (and those of alternate states, for sets like {A})
  stlist := '[]';
  for item in select * from jsonb_array_elements(sels) loop
    c := bi.compile_expr(item->'expr', model, false);
    flag_cond := bi.selection_cond(c->>'s', item->'values');
    if flag_cond is null then continue; end if;
    stlist := stlist || jsonb_build_object('key', c->>'s', 'cond', flag_cond);
    used := used || array(select jsonb_array_elements_text(c->'a'));
  end loop;
  state_sel := jsonb_build_object('$', stlist);
  for st, item in select key, value from jsonb_each(states) loop
    if st !~ '^[A-Za-z][A-Za-z0-9_]{0,20}$' or jsonb_typeof(item) <> 'array' or jsonb_array_length(item) > 50 then
      raise exception 'Invalid state' using errcode = '22023';
    end if;
    stlist := '[]';
    for pair in select * from jsonb_array_elements(item) loop
      c := bi.compile_expr(pair->'expr', model, false);
      flag_cond := bi.selection_cond(c->>'s', pair->'values');
      if flag_cond is null then continue; end if;
      stlist := stlist || jsonb_build_object('key', c->>'s', 'cond', flag_cond);
      if flag_mode then used := used || array(select jsonb_array_elements_text(c->'a')); end if;
    end loop;
    state_sel := state_sel || jsonb_build_object(st, stlist);
  end loop;
  if (select count(*) from jsonb_array_elements(state_sel->'$')) > 0 then
    base_cond := (select string_agg(x->>'cond', ' and ') from jsonb_array_elements(state_sel->'$') x);
  end if;
  if flag_mode then
    -- every set becomes a row condition; selections are applied per aggregation instead of to all rows
    for setid, item in select key, value from jsonb_each(sets) loop
      sc := bi.set_cond(item, model, state_sel);
      set_conds := set_conds || jsonb_build_object(setid, sc->>'cond');
      used := used || array(select jsonb_array_elements_text(sc->'a'));
    end loop;
  elsif base_cond <> 'true' then
    where_list := where_list || base_cond;
  end if;

  for item in select * from jsonb_array_elements(conds) loop
    c := bi.compile_expr(item, model, false);
    where_list := where_list || format('coalesce((%s)::boolean, false)', c->>'s');
    used := used || array(select jsonb_array_elements_text(c->'a'));
  end loop;

  -- record flags the measures need (the compiler only writes known aliases and set ids into them)
  for flag in select distinct m[1] from regexp_matches(array_to_string(select_list, ' ') || ' ' || coalesce((select string_agg(v->>'inner', ' ') from jsonb_each(aggrs) a(k, v)), ''),
      'q\."(#k:[a-z0-9_,]+(@x[0-9a-f]+)?)"', 'g') m loop
    flag_list := flag_list || flag;
  end loop;

  -- tables needed: those used by the chart and by its aggregations (Count(*) counts the first table)
  needed := array(select distinct x from unnest(used || array(
    select unnest(string_to_array(split_part(substr(f, 4), '@', 1), ',')) from unnest(flag_list) f)) x);
  if array_length(needed, 1) is null then needed := array[model->'order'->>0]; end if;
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

  -- layer 1: tables joined along their links with full joins, flattened columns (calculated fields
  -- computed from their table's columns) and row ids
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
      calc_model := jsonb_build_object('order', jsonb_build_array(alias), 'tables', jsonb_build_object(alias, tbl),
        'cols', jsonb_build_object(alias, coalesce((select jsonb_object_agg(k, v) from jsonb_each(model->'cols'->alias) e(k, v) where v #>> '{}' <> 'calc'), '{}')));
      for col in select jsonb_object_keys(model->'cols'->alias) loop
        if coalesce(model->'cols'->alias->>col, '') = 'calc' then
          flat_list := flat_list || format('(%s) as %I', bi.compile_expr(model->'calc'->(alias || '.' || col), calc_model, false)->>'s', alias || '.' || col);
        else
          flat_list := flat_list || format('%I.%I as %I', alias, col, alias || '.' || col);
        end if;
      end loop;
    end loop;
    exit when not progress;
  end loop;
  if array_length(joined, 1) is distinct from array_length(needed, 1) then
    raise exception 'The tables in this chart are not linked to each other' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(flag_list) f where not (string_to_array(split_part(substr(f, 4), '@', 1), ',') <@ needed)) then
    raise exception 'Invalid query' using errcode = '22023';
  end if;

  -- layer 2: filters, set conditions and record flags. A flag marks the first row of each record
  -- (per chart row) so measures count every record once; in set analysis the flag also requires
  -- the row to be in the measure's set.
  query := format('select q.*%s%s from (select %s from %s) q%s',
    case when flag_mode then format(', (%s) as "#s"', base_cond) || coalesce((select string_agg(format(', (%s) as %I', v #>> '{}', '#x:' || k), '') from jsonb_each(set_conds) s(k, v)), '') else '' end,
    coalesce((select string_agg(
      case
        when not flag_mode and needed <@ key_set then format(', true as %I', f)
        when not flag_mode then format(', row_number() over (partition by %s) = 1 as %I',
          array_to_string(dim_list || array(select format('q.%I', '#r:' || k) from unnest(key_set) k), ', '), f)
        when needed <@ key_set then format(', coalesce(%s, false) as %I', fcond, f)
        else format(', (row_number() over (partition by %s order by coalesce(%s, false) desc) = 1 and coalesce(%s, false)) as %I',
          array_to_string(dim_list || array(select format('q.%I', '#r:' || k) from unnest(key_set) k), ', '), fcond, fcond, f)
      end, '')
      from (select f, string_to_array(split_part(substr(f, 4), '@', 1), ',') as key_set,
                   case when f like '%@%' then '(' || (set_conds->>split_part(f, '@', 2)) || ')' else '(' || base_cond || ')' end as fcond
            from unnest(flag_list) f) flags), ''),
    array_to_string(flat_list, ', '), from_sql,
    case when array_length(where_list, 1) > 0 then ' where ' || array_to_string(where_list, ' and ') else '' end);

  -- Aggr(): each one is grouped separately from the same rows, then joined on the chart's dimensions
  for aj, aspec in select key, value from jsonb_each(aggrs) loop
    joins := joins || format(' left join (select %s from (select %s from base q group by %s%s) z%s) %I on %s',
      concat_ws(', ', nullif(array_to_string(array(select format('z.d%s', i - 1) from generate_series(1, cardinality(dim_list)) i), ', '), ''),
        case aspec->>'fn'
          when 'median' then 'percentile_cont(0.5) within group (order by (z.v)::numeric) as v'
          when 'stdev' then 'stddev_samp((z.v)::numeric) as v'
          else format('%s(%sz.v) as v', aspec->>'fn', case when (aspec->>'distinct')::boolean then 'distinct ' else '' end)
        end),
      concat_ws(', ', nullif(array_to_string(array(select format('%s as d%s', dim_list[i], i - 1) from generate_series(1, cardinality(dim_list)) i), ', '), ''),
        (aspec->>'inner') || ' as v'),
      array_to_string(dim_list || array(select jsonb_array_elements_text(aspec->'dims')), ', '),
      case when flag_mode then format(' having bool_or(coalesce(q."#s", false)%s)',
        coalesce((select string_agg(format(' or coalesce(q.%I, false)', '#x:' || k), '') from jsonb_object_keys(set_conds) k), '')) else '' end,
      case when cardinality(dim_list) > 0 then ' group by ' || array_to_string(array(select format('z.d%s', i - 1) from generate_series(1, cardinality(dim_list)) i), ', ') else '' end,
      aj,
      case when cardinality(dim_list) > 0 then array_to_string(array(select format('(%s) is not distinct from %I.d%s', dim_list[i], aj, i - 1) from generate_series(1, cardinality(dim_list)) i), ' and ') else 'true' end);
  end loop;

  -- layer 3: dimensions and measures. Like Qlik, rows where every measure is empty are left out;
  -- with set analysis, a row also needs a record in the selections or in one of the sets.
  query := format('with base as (%s) select %s%s from base q%s%s order by %s limit %s offset %s',
    query,
    case when jsonb_array_length(meas) = 0 then 'distinct ' else '' end,
    array_to_string(select_list, ', '), joins,
    case when jsonb_array_length(meas) > 0 and array_length(group_list, 1) > 0 then
      ' group by ' || array_to_string(group_list, ', ')
      || ' having ' || concat_ws(' and ',
        case when cardinality(having_list) > 0 then 'not (' || array_to_string(having_list, ' and ') || ')' end,
        case when flag_mode then format('bool_or(coalesce(q."#s", false)%s)',
          coalesce((select string_agg(format(' or coalesce(q.%I, false)', '#x:' || k), '') from jsonb_object_keys(set_conds) k), '')) end,
        'true')
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

create or replace function public.bi_get_app(p_app uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  result jsonb;
begin
  if not bi.can_view_app(p_app) then
    raise exception 'You do not have access to this app' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'id', a.id, 'name', a.name, 'description', a.description, 'measures', a.measures, 'variables', a.variables, 'calc_fields', a.calc_fields, 'updated_at', a.updated_at,
    'can_edit', bi.can_build(),
    'model', (select coalesce(jsonb_agg(jsonb_build_object(
        'alias', t.alias, 'table_name', t.table_name, 'parent_alias', t.parent_alias, 'join_type', t.join_type,
        'join_pairs', t.join_pairs, 'description', d.description, 'row_count', d.row_count, 'last_loaded_at', d.last_loaded_at,
        'columns', coalesce((select jsonb_agg(c) from jsonb_array_elements(d.columns) c where c->>'name' <> '_bi_loaded_at'), '[]')
          || coalesce((select jsonb_agg(jsonb_build_object('name', cf->>'name', 'type', 'calculated', 'expression', cf->>'expression'))
                       from jsonb_array_elements(a.calc_fields) cf where cf->>'table' = t.alias), '[]'))
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

create or replace function public.bi_save_app(p jsonb)
returns uuid language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_app uuid := nullif(p->>'id', '')::uuid;
  tdef jsonb;
  m jsonb;
  x jsonb;
  pos integer := 0;
  model jsonb;
  cmodel jsonb;
  c jsonb;
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
  -- variables: [{name, value, description}], names like vMinQty; values are text (used by $(name) in expressions)
  if jsonb_typeof(coalesce(p->'variables', '[]')) <> 'array' or jsonb_array_length(coalesce(p->'variables', '[]')) > 100 then
    raise exception 'Invalid variables' using errcode = '22023';
  end if;
  for m in select * from jsonb_array_elements(coalesce(p->'variables', '[]')) loop
    if coalesce(m->>'name', '') !~ '^[A-Za-z_][A-Za-z0-9_]{0,40}$' then
      raise exception 'Variable name "%" must start with a letter and use only letters, digits and _', m->>'name' using errcode = '22023';
    end if;
    if length(coalesce(m->>'value', '')) > 2000 or length(coalesce(m->>'description', '')) > 500 then
      raise exception 'Variable "%" is too long', m->>'name' using errcode = '22023';
    end if;
  end loop;
  if (select count(distinct lower(e->>'name')) from jsonb_array_elements(coalesce(p->'variables', '[]')) e) <> jsonb_array_length(coalesce(p->'variables', '[]')) then
    raise exception 'Two variables have the same name' using errcode = '22023';
  end if;

  if v_app is null then
    insert into bi.apps (name, description, measures, variables, created_by, updated_by)
    values (btrim(p->>'name'), coalesce(p->>'description', ''), coalesce(p->'measures', '[]'), coalesce(p->'variables', '[]'), auth.uid(), auth.uid())
    returning id into v_app;
    is_new := true;
  else
    update bi.apps set name = btrim(p->>'name'), description = coalesce(p->>'description', ''),
      measures = coalesce(p->'measures', '[]'),
      variables = case when p ? 'variables' then coalesce(p->'variables', '[]') else variables end,
      updated_by = auth.uid(), updated_at = now()
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

  -- calculated fields: [{table, name, expression (text, for editing), node (parsed in the browser)}]
  if p ? 'calc_fields' then
    if jsonb_typeof(p->'calc_fields') <> 'array' or jsonb_array_length(p->'calc_fields') > 200 then
      raise exception 'Invalid calculated fields' using errcode = '22023';
    end if;
    update bi.apps set calc_fields = '[]' where id = v_app;
    model := bi.app_model(v_app);
    for x in select * from jsonb_array_elements(p->'calc_fields') loop
      if not coalesce((model->'cols') ? (x->>'table'), false) then
        raise exception 'Calculated field "%": table "%" is not in the data model', x->>'name', x->>'table' using errcode = '22023';
      end if;
      if coalesce(x->>'name', '') !~ '^[a-z][a-z0-9_]{0,62}$' then
        raise exception 'Calculated field name "%" must start with a letter and use only a-z, 0-9 and _', x->>'name' using errcode = '22023';
      end if;
      if (model->'cols'->(x->>'table')) ? (x->>'name') then
        raise exception 'The table % already has a field named %', x->>'table', x->>'name' using errcode = '22023';
      end if;
      if (select count(*) from jsonb_array_elements(p->'calc_fields') y where y->>'table' = x->>'table' and y->>'name' = x->>'name') > 1 then
        raise exception 'Two calculated fields are named %.%', x->>'table', x->>'name' using errcode = '22023';
      end if;
      if length(coalesce(x->>'expression', '')) not between 1 and 2000 then
        raise exception 'Calculated field "%" needs an expression', x->>'name' using errcode = '22023';
      end if;
      -- the expression may only use its own table's loaded columns, without aggregations
      cmodel := jsonb_build_object('order', jsonb_build_array(x->>'table'), 'cols', jsonb_build_object(x->>'table', model->'cols'->(x->>'table')));
      begin
        c := bi.compile_expr(x->'node', cmodel, false);
      exception when others then
        raise exception 'Calculated field "%": %', x->>'name', sqlerrm using errcode = '22023';
      end;
    end loop;
    update bi.apps set calc_fields = (select coalesce(jsonb_agg(jsonb_build_object('table', y->>'table', 'name', y->>'name',
      'expression', y->>'expression', 'node', y->'node')), '[]') from jsonb_array_elements(p->'calc_fields') y) where id = v_app;
  else
    -- keep the calculated fields of tables that are still in the model
    update bi.apps a set calc_fields = coalesce((select jsonb_agg(cf) from jsonb_array_elements(a.calc_fields) cf
      where exists (select 1 from bi.app_tables t where t.app_id = v_app and t.alias = cf->>'table')), '[]') where a.id = v_app;
  end if;

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

revoke all on function bi.cx_extra(jsonb, jsonb), bi.selection_cond(text, jsonb), bi.set_cond(jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.bi_query(uuid, jsonb), public.bi_get_app(uuid), public.bi_save_app(jsonb) from public, anon;
grant execute on function public.bi_query(uuid, jsonb), public.bi_get_app(uuid), public.bi_save_app(jsonb) to authenticated;
