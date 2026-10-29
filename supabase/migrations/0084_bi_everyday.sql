-- Reporting batch 2: bookmarks, favourites and recently opened sheets, and smart search.

-- ---------------------------------------------------------------------------
-- Bookmarks: saved selections (and compare states, variable values and the sheet) per app.
-- Personal, or shared with everyone who can open the app (report builders only).
-- ---------------------------------------------------------------------------
create table bi.bookmarks (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references bi.apps (id) on delete cascade,
  owner uuid not null,
  name text not null check (length(btrim(name)) between 1 and 80),
  description text not null default '' check (length(description) <= 500),
  shared boolean not null default false,
  sheet_id uuid,
  selections jsonb not null default '[]' check (jsonb_typeof(selections) = 'array'),
  states jsonb not null default '{}' check (jsonb_typeof(states) = 'object'),
  variables jsonb not null default '{}' check (jsonb_typeof(variables) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index bookmarks_app_idx on bi.bookmarks (app_id);
alter table bi.bookmarks enable row level security;
grant all on bi.bookmarks to service_role;

-- A bookmark readable by the signed-in user (own, or shared in an app they can open)
create function bi.can_use_bookmark(p_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from bi.bookmarks b where b.id = p_id and bi.can_view_app(b.app_id) and (b.shared or b.owner = auth.uid()));
$$;

create function bi.check_selection_list(p jsonb)
returns void language plpgsql immutable set search_path = ''
as $$
declare
  x jsonb;
begin
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 50 or length(p::text) > 200000 then
    raise exception 'Too many selections' using errcode = '22023';
  end if;
  for x in select * from jsonb_array_elements(p) loop
    if coalesce(jsonb_typeof(x->'node'), '') <> 'object' or coalesce(jsonb_typeof(x->'values'), '') <> 'array' or coalesce(x->>'key', '') = '' then
      raise exception 'Invalid selection' using errcode = '22023';
    end if;
  end loop;
end;
$$;

create function public.bi_list_bookmarks(p_app uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not bi.can_view_app(p_app) then raise exception 'You do not have access to this app' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'description', b.description, 'shared', b.shared,
      'mine', b.owner = auth.uid(), 'owner_name', coalesce(nullif(p.display_name, ''), p.email), 'sheet_id', b.sheet_id,
      'selections', b.selections, 'states', b.states, 'variables', b.variables, 'updated_at', b.updated_at)
      order by b.shared desc, lower(b.name))
    from bi.bookmarks b left join public.profiles p on p.id = b.owner
    where b.app_id = p_app and (b.shared or b.owner = auth.uid())), '[]');
end;
$$;

-- p = {id?, app_id, name, description, shared, sheet_id, selections, states, variables}
create function public.bi_save_bookmark(p jsonb)
returns uuid language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_app uuid := (p->>'app_id')::uuid;
  k text;
  v jsonb;
begin
  if not bi.can_view_app(v_app) then raise exception 'You do not have access to this app' using errcode = '42501'; end if;
  if coalesce((p->>'shared')::boolean, false) and not bi.can_build() then
    raise exception 'Only administrators and report builders can share bookmarks' using errcode = '42501';
  end if;
  perform bi.check_selection_list(coalesce(p->'selections', '[]'));
  if jsonb_typeof(coalesce(p->'states', '{}')) <> 'object' or jsonb_typeof(coalesce(p->'variables', '{}')) <> 'object' then
    raise exception 'Invalid bookmark' using errcode = '22023';
  end if;
  for k, v in select key, value from jsonb_each(coalesce(p->'states', '{}')) loop
    if k !~ '^[A-Za-z][A-Za-z0-9_]{0,20}$' then raise exception 'Invalid state' using errcode = '22023'; end if;
    perform bi.check_selection_list(v);
  end loop;
  if (select count(*) from jsonb_object_keys(coalesce(p->'variables', '{}'))) > 100 or length(coalesce(p->'variables', '{}')::text) > 50000 then
    raise exception 'Too many variables' using errcode = '22023';
  end if;
  if nullif(p->>'sheet_id', '') is not null and not exists (select 1 from bi.sheets s where s.id = (p->>'sheet_id')::uuid and s.app_id = v_app) then
    raise exception 'The sheet is not in this app' using errcode = '22023';
  end if;
  if v_id is null then
    insert into bi.bookmarks (app_id, owner, name, description, shared, sheet_id, selections, states, variables)
    values (v_app, auth.uid(), btrim(p->>'name'), coalesce(p->>'description', ''), coalesce((p->>'shared')::boolean, false),
            nullif(p->>'sheet_id', '')::uuid, coalesce(p->'selections', '[]'), coalesce(p->'states', '{}'), coalesce(p->'variables', '{}'))
    returning id into v_id;
  else
    update bi.bookmarks b set name = btrim(p->>'name'), description = coalesce(p->>'description', ''), shared = coalesce((p->>'shared')::boolean, false),
      sheet_id = nullif(p->>'sheet_id', '')::uuid, selections = coalesce(p->'selections', '[]'), states = coalesce(p->'states', '{}'),
      variables = coalesce(p->'variables', '{}'), updated_at = now()
    where b.id = v_id and b.app_id = v_app and (b.owner = auth.uid() or (b.shared and bi.can_build()));
    if not found then raise exception 'Bookmark not found' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end;
$$;

create function public.bi_delete_bookmark(p_id uuid)
returns void language plpgsql volatile security definer set search_path = ''
as $$
begin
  delete from bi.bookmarks b where b.id = p_id and (b.owner = auth.uid() or (b.shared and bi.can_build()));
  if not found then raise exception 'Bookmark not found' using errcode = 'P0002'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Favourite sheets and what people open (for the home page and, later, usage statistics)
-- ---------------------------------------------------------------------------
create table bi.favourites (
  user_id uuid not null,
  app_id uuid not null references bi.apps (id) on delete cascade,
  sheet_id uuid not null references bi.sheets (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, sheet_id)
);
create table bi.view_log (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  app_id uuid not null references bi.apps (id) on delete cascade,
  sheet_id uuid references bi.sheets (id) on delete set null,
  at timestamptz not null default now()
);
create index view_log_user_idx on bi.view_log (user_id, at desc);
create index view_log_app_idx on bi.view_log (app_id, at desc);
alter table bi.favourites enable row level security;
alter table bi.view_log enable row level security;
grant all on bi.favourites, bi.view_log to service_role;

create function public.bi_toggle_favourite(p_app uuid, p_sheet uuid)
returns boolean language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not bi.can_view_app(p_app) then raise exception 'You do not have access to this app' using errcode = '42501'; end if;
  if not exists (select 1 from bi.sheets s where s.id = p_sheet and s.app_id = p_app) then raise exception 'Sheet not found' using errcode = 'P0002'; end if;
  delete from bi.favourites f where f.user_id = auth.uid() and f.sheet_id = p_sheet;
  if found then return false; end if;
  insert into bi.favourites (user_id, app_id, sheet_id) values (auth.uid(), p_app, p_sheet);
  return true;
end;
$$;

-- Called when someone opens a sheet (at most once a minute per sheet; older than 400 days is removed)
create function public.bi_log_view(p_app uuid, p_sheet uuid)
returns void language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not bi.can_view_app(p_app) then return; end if;
  if p_sheet is not null and not exists (select 1 from bi.sheets s where s.id = p_sheet and s.app_id = p_app) then return; end if;
  if exists (select 1 from bi.view_log v where v.user_id = auth.uid() and v.sheet_id is not distinct from p_sheet and v.at > now() - interval '1 minute') then return; end if;
  insert into bi.view_log (user_id, app_id, sheet_id) values (auth.uid(), p_app, p_sheet);
  if random() < 0.01 then delete from bi.view_log v where v.at < now() - interval '400 days'; end if;
end;
$$;

create function public.bi_my_home()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  return jsonb_build_object(
    'favourites', (select coalesce(jsonb_agg(jsonb_build_object('app_id', a.id, 'app_name', a.name, 'sheet_id', s.id, 'sheet_title', s.title) order by f.created_at), '[]')
      from bi.favourites f join bi.apps a on a.id = f.app_id join bi.sheets s on s.id = f.sheet_id
      where f.user_id = auth.uid() and bi.can_view_app(a.id)),
    'recent', (select coalesce(jsonb_agg(jsonb_build_object('app_id', r.app_id, 'app_name', a.name, 'sheet_id', r.sheet_id, 'sheet_title', s.title, 'at', r.at) order by r.at desc), '[]')
      from (select distinct on (v.sheet_id) v.app_id, v.sheet_id, v.at from bi.view_log v
            where v.user_id = auth.uid() and v.sheet_id is not null and v.at > now() - interval '60 days' order by v.sheet_id, v.at desc) r
      join bi.apps a on a.id = r.app_id join bi.sheets s on s.id = r.sheet_id
      where bi.can_view_app(a.id) limit 8));
end;
$$;

-- ---------------------------------------------------------------------------
-- Smart search: values containing the text in any text field of the app (within the current
-- selections and the user's row access), at most 5 per field.
-- ---------------------------------------------------------------------------
create function public.bi_search_values(p_app uuid, p_text text, p_selections jsonb default '[]')
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  model jsonb;
  alias text;
  col text;
  typ text;
  result jsonb := '[]';
  r jsonb;
  fields integer := 0;
  pat text;
begin
  if not bi.can_view_app(p_app) then raise exception 'You do not have access to this app' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_text, ''))) < 2 or length(p_text) > 100 then return '[]'; end if;
  model := bi.app_model(p_app);
  pat := '*' || btrim(p_text) || '*';
  for alias, col, typ in
    select a.value #>> '{}', c.key, c.value #>> '{}'
    from jsonb_array_elements(model->'order') with ordinality a(value, n), jsonb_each(model->'cols'->(a.value #>> '{}')) c
    where c.value #>> '{}' in ('text', 'character varying', 'varchar', 'calc') order by a.n, c.key
  loop
    exit when fields >= 25;
    fields := fields + 1;
    begin
      r := public.bi_query(p_app, jsonb_build_object(
        'dimensions', jsonb_build_array(jsonb_build_object('expr', jsonb_build_object('t', 'field', 'table', alias, 'name', col))),
        'conditions', jsonb_build_array(jsonb_build_object('t', 'bin', 'op', '>',
          'l', jsonb_build_object('t', 'fn', 'name', 'wildmatch', 'args', jsonb_build_array(
            jsonb_build_object('t', 'fn', 'name', 'text', 'args', jsonb_build_array(jsonb_build_object('t', 'field', 'table', alias, 'name', col))),
            jsonb_build_object('t', 'str', 'v', pat))),
          'r', jsonb_build_object('t', 'num', 'v', 0))),
        'selections', coalesce(p_selections, '[]'),
        'sort', '[{"index": 0}]'::jsonb, 'limit', 5));
    exception when others then
      continue;
    end;
    if jsonb_array_length(r->'rows') > 0 then
      result := result || jsonb_build_object('table', alias, 'field', col,
        'values', (select jsonb_agg(x->0) from jsonb_array_elements(r->'rows') x), 'more', r->'has_more');
    end if;
  end loop;
  return result;
end;
$$;

revoke all on function bi.can_use_bookmark(uuid), bi.check_selection_list(jsonb) from public, anon, authenticated;
revoke all on function public.bi_list_bookmarks(uuid), public.bi_save_bookmark(jsonb), public.bi_delete_bookmark(uuid),
  public.bi_toggle_favourite(uuid, uuid), public.bi_log_view(uuid, uuid), public.bi_my_home(), public.bi_search_values(uuid, text, jsonb)
  from public, anon;
grant execute on function public.bi_list_bookmarks(uuid), public.bi_save_bookmark(jsonb), public.bi_delete_bookmark(uuid),
  public.bi_toggle_favourite(uuid, uuid), public.bi_log_view(uuid, uuid), public.bi_my_home(), public.bi_search_values(uuid, text, jsonb)
  to authenticated;
