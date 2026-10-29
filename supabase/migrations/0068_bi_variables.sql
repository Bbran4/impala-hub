-- Impala Hub Reporting: app variables (like Qlik variables).
--
-- An app can define variables (name, default value, description). Expressions use them with
-- $(name), which the browser replaces by the variable's current text before parsing (Qlik dollar
-- expansion), so variables never reach the database as SQL. Variable input and slider objects
-- change the current value for the person viewing the app; the saved value is the default.
-- bi_get_app returns the variables; bi_save_app validates and stores them (and leaves them
-- unchanged when the caller does not send "variables").
-- Migration numbering: Reporting uses even numbers (see supabase/README.md).

alter table bi.apps add column if not exists variables jsonb not null default '[]'
  check (jsonb_typeof(variables) = 'array');

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
    'id', a.id, 'name', a.name, 'description', a.description, 'measures', a.measures, 'variables', a.variables, 'updated_at', a.updated_at,
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


create or replace function public.bi_save_app(p jsonb)
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


revoke all on function public.bi_get_app(uuid), public.bi_save_app(jsonb) from public, anon;
grant execute on function public.bi_get_app(uuid), public.bi_save_app(jsonb) to authenticated;
