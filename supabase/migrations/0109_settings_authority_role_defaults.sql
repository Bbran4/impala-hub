-- Settings authority belongs to the active administrator account, independently
-- of the normal-view preference. Workspace authorization still uses has_role().
create function public.can_manage_app_settings()
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.profiles p join public.profile_roles r on r.profile_id=p.id
    where p.id=auth.uid() and p.active and r.role_id='administrator');
$$;
revoke all on function public.can_manage_app_settings() from public,anon;
grant execute on function public.can_manage_app_settings() to authenticated;

-- Explicit legacy employee grants remain explicit overrides. Automatically
-- seeded Marketing rows must not override an editable role default.
insert into public.application_user_permission_overrides(profile_id,app_id,permission_key,enabled,updated_by,updated_at)
select legacy.profile_id,'marketing',legacy.permission_key,true,legacy.granted_by,legacy.updated_at
from public.marketing_user_permissions legacy where legacy.granted_by is not null
on conflict(profile_id,app_id,permission_key) do nothing;
drop trigger if exists profile_roles_seed_marketing_permissions on public.profile_roles;

create or replace function public.has_application_permission(p_app_id text, p_permission_key text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_active_user() and (
    public.has_role('administrator') or (
      public.can_access_workspace(p_app_id) and (
        coalesce((select override.enabled
          from public.application_user_permission_overrides override
          where override.profile_id = auth.uid()
            and override.app_id = p_app_id
            and override.permission_key = p_permission_key),
          (select exists (
            select 1 from public.application_role_permissions role_permission
            join public.profile_roles profile_role on profile_role.role_id = role_permission.role_id
            where profile_role.profile_id = auth.uid()
              and public.has_role(profile_role.role_id)
              and role_permission.app_id = p_app_id
              and role_permission.permission_key = p_permission_key
          )), false)
      )
    )
  );
$$;

create or replace function public.admin_list_app_access(p_app_id text)
returns table (
  profile_id uuid,
  display_name text,
  email text,
  sales_code text,
  direct_access boolean,
  inherited_access boolean,
  can_open boolean,
  access_reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  app_role text;
begin
  if not (public.can_manage_app_settings()) then
    raise exception 'Only active administrators can list application access'
      using errcode = '42501';
  end if;

  app_role := case p_app_id
    when 'marketing' then 'marketing'
    when 'sales_desk' then 'sales'
    when 'returns_claims' then 'returns'
    when 'stock_control' then 'stock'
    when 'fleet_management' then 'fleet'
    when 'ecommerce' then 'ecommerce'
    when 'reporting' then 'reporting'
    else null
  end;

  if app_role is null then
    raise exception 'Unknown application identifier: %', p_app_id
      using errcode = '22023';
  end if;

  return query
  with access_rows as (
    select
      p.id,
      p.display_name,
      p.email,
      p.sales_code,
      exists (
        select 1 from public.profile_roles direct_role
        where direct_role.profile_id = p.id and direct_role.role_id = app_role
      ) as is_direct,
      (exists (
        select 1 from public.profile_roles inherited_role
        where inherited_role.profile_id = p.id
          and (
            (inherited_role.role_id = 'administrator' and not p.normal_user_view)
            or (inherited_role.role_id = 'management' and p_app_id in (
              'marketing', 'sales_desk', 'returns_claims', 'stock_control', 'reporting'
            ))
            or (inherited_role.role_id = 'sales_manager' and p_app_id = 'sales_desk')
            or (inherited_role.role_id = 'report_builder' and p_app_id = 'reporting')
          )
      ) or (p_app_id = 'reporting' and exists (
        select 1 from bi.app_access app_access
        where (app_access.principal_type = 'user' and app_access.principal = p.id::text)
          or (app_access.principal_type = 'role' and exists (
            select 1 from public.profile_roles shared_role
            where shared_role.profile_id = p.id and shared_role.role_id = app_access.principal and (shared_role.role_id <> 'administrator' or not p.normal_user_view)
          ))
      ))) as is_inherited,
      case
        when exists (
          select 1 from public.profile_roles reason_role
          where reason_role.profile_id = p.id and reason_role.role_id = 'administrator' and not p.normal_user_view
        ) then 'administrator'
        when p_app_id = 'sales_desk' and exists (
          select 1 from public.profile_roles reason_role
          where reason_role.profile_id = p.id and reason_role.role_id = 'sales_manager'
        ) then 'sales_manager'
        when p_app_id in ('marketing', 'sales_desk', 'returns_claims', 'stock_control', 'reporting')
          and exists (
            select 1 from public.profile_roles reason_role
            where reason_role.profile_id = p.id and reason_role.role_id = 'management'
          ) then 'management'
        when p_app_id = 'reporting' and exists (
          select 1 from public.profile_roles reason_role
          where reason_role.profile_id = p.id and reason_role.role_id = 'report_builder'
        ) then 'report_builder'
        when p_app_id = 'reporting' and exists (
          select 1 from bi.app_access app_access
          where (app_access.principal_type = 'user' and app_access.principal = p.id::text)
            or (app_access.principal_type = 'role' and exists (
              select 1 from public.profile_roles shared_role
              where shared_role.profile_id = p.id and shared_role.role_id = app_access.principal and (shared_role.role_id <> 'administrator' or not p.normal_user_view)
            ))
        ) then 'shared_reporting_app'
        when exists (
          select 1 from public.profile_roles reason_role
          where reason_role.profile_id = p.id and reason_role.role_id = app_role
        ) then 'direct'
        else 'none'
      end as reason
    from public.profiles p
    where p.active = true
  )
  select
    a.id,
    a.display_name,
    a.email,
    a.sales_code,
    a.is_direct,
    a.is_inherited,
    a.is_direct or a.is_inherited,
    a.reason
  from access_rows a
  order by lower(coalesce(nullif(btrim(a.display_name), ''), a.email, '')), a.id;
end;
$$;

create or replace function public.admin_set_app_access(
  p_profile_id uuid,
  p_app_id text,
  p_can_open boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  app_role text;
  target_profile public.profiles%rowtype;
  has_inherited_access boolean;
  changed boolean := false;
begin
  if not (public.can_manage_app_settings()) then
    raise exception 'Only active administrators can change application access'
      using errcode = '42501';
  end if;

  if p_can_open is null then
    raise exception 'p_can_open must not be null' using errcode = '22004';
  end if;

  app_role := case p_app_id
    when 'marketing' then 'marketing'
    when 'sales_desk' then 'sales'
    when 'returns_claims' then 'returns'
    when 'stock_control' then 'stock'
    when 'fleet_management' then 'fleet'
    when 'ecommerce' then 'ecommerce'
    when 'reporting' then 'reporting'
    else null
  end;

  if app_role is null then
    raise exception 'Unknown application identifier: %', p_app_id
      using errcode = '22023';
  end if;

  select p.* into target_profile
  from public.profiles p
  where p.id = p_profile_id and p.active = true
  for update;

  if not found then
    raise exception 'Active profile not found: %', p_profile_id
      using errcode = 'P0002';
  end if;

  select exists (
    select 1 from public.profile_roles inherited_role
    where inherited_role.profile_id = p_profile_id
      and (
        (inherited_role.role_id = 'administrator' and not target_profile.normal_user_view)
        or (inherited_role.role_id = 'management' and p_app_id in (
          'marketing', 'sales_desk', 'returns_claims', 'stock_control', 'reporting'
        ))
        or (inherited_role.role_id = 'sales_manager' and p_app_id = 'sales_desk')
        or (inherited_role.role_id = 'report_builder' and p_app_id = 'reporting')
      )
  ) or (p_app_id = 'reporting' and exists (
    select 1 from bi.app_access app_access
    where (app_access.principal_type = 'user' and app_access.principal = p_profile_id::text)
      or (app_access.principal_type = 'role' and exists (
        select 1 from public.profile_roles shared_role
        where shared_role.profile_id = p_profile_id and shared_role.role_id = app_access.principal and (shared_role.role_id <> 'administrator' or not target_profile.normal_user_view)
      ))
  )) into has_inherited_access;

  -- Inherited access is managed through its platform role, never per app.
  if has_inherited_access then
    return false;
  end if;

  if p_can_open then
    insert into public.profile_roles (profile_id, role_id)
    values (p_profile_id, app_role)
    on conflict (profile_id, role_id) do nothing;
    changed := found;
  else
    delete from public.profile_roles
    where profile_id = p_profile_id and role_id = app_role;
    changed := found;
  end if;

  if changed then
    insert into public.admin_app_access_audit (
      actor_user_id, profile_id, app_id, role_id, action
    ) values (
      auth.uid(), p_profile_id, p_app_id, app_role,
      case when p_can_open then 'grant' else 'revoke' end
    );
  end if;

  return changed;
end;
$$;

create or replace function public.admin_reorder_campaign_types(p_names text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected_count integer;
  supplied_count integer;
begin
  if not (public.can_manage_app_settings()) then
    raise exception 'Only active administrators can reorder campaign types'
      using errcode = '42501';
  end if;

  if p_names is null or array_length(p_names, 1) is null then
    raise exception 'Campaign type order must not be empty' using errcode = '22023';
  end if;

  select count(*) into expected_count from public.campaign_types;
  select count(distinct name) into supplied_count from unnest(p_names) as names(name);
  if array_length(p_names, 1) <> expected_count or supplied_count <> expected_count
    or exists (select 1 from unnest(p_names) as names(name) where not exists (
      select 1 from public.campaign_types campaign_type where campaign_type.name = names.name
    )) then
    raise exception 'Campaign type order must contain every type exactly once'
      using errcode = '22023';
  end if;

  update public.campaign_types campaign_type
  set position = ordered.position
  from unnest(p_names) with ordinality as ordered(name, position)
  where campaign_type.name = ordered.name;
end;
$$;

create or replace function public.can_profile_access_workspace(target_profile_id uuid, workspace_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles profile
    where profile.id = target_profile_id and profile.active = true
  ) and exists (
    select 1 from public.profile_roles role_assignment
    where role_assignment.profile_id = target_profile_id
      and (
        (role_assignment.role_id = 'administrator' and not coalesce((select p.normal_user_view from public.profiles p where p.id=target_profile_id),false))
        or (workspace_name = 'marketing' and role_assignment.role_id in ('marketing', 'management'))
        or (workspace_name = 'sales_desk' and role_assignment.role_id in ('sales', 'sales_manager', 'management'))
        or (workspace_name = 'returns_claims' and role_assignment.role_id in ('returns', 'management'))
        or (workspace_name = 'stock_control' and role_assignment.role_id in ('stock', 'management'))
        or (workspace_name = 'fleet_management' and role_assignment.role_id = 'fleet')
        or (workspace_name = 'ecommerce' and role_assignment.role_id = 'ecommerce')
        or (workspace_name = 'reporting' and role_assignment.role_id in ('reporting', 'management', 'report_builder'))
      )
  );
$$;

create or replace function public.admin_list_permission_users()
returns table(profile_id uuid, display_name text, email text, roles text[], accessible_apps text[])
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.can_manage_app_settings()) then
    raise exception 'Only active administrators can list permission users' using errcode = '42501';
  end if;
  return query
  select profile.id, profile.display_name, profile.email,
    coalesce(array_agg(distinct role.label order by role.label) filter (where role.id is not null), '{}'::text[]),
    coalesce(array_agg(distinct app.app_id order by app.app_id) filter (where public.can_profile_access_workspace(profile.id, app.app_id)), '{}'::text[])
  from public.profiles profile
  left join public.profile_roles profile_role on profile_role.profile_id = profile.id
  left join public.roles role on role.id = profile_role.role_id
  cross join unnest(array[
    'marketing','sales_desk','returns_claims','stock_control','fleet_management','ecommerce','reporting'
  ]::text[]) app(app_id)
  where profile.active = true
  group by profile.id, profile.display_name, profile.email
  order by lower(coalesce(nullif(btrim(profile.display_name), ''), profile.email, '')), profile.id;
end;
$$;

create or replace function public.admin_list_permission_roles()
returns table(role_id text, label text, description text, accessible_apps text[])
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.can_manage_app_settings()) then
    raise exception 'Only active administrators can list permission roles' using errcode = '42501';
  end if;
  return query
  select role.id, role.label, role.description,
    coalesce(array_agg(distinct app.app_id order by app.app_id) filter (where exists (
      select 1 from public.application_role_permissions role_permission
      where role_permission.role_id = role.id and role_permission.app_id = app.app_id
    )), '{}'::text[])
  from public.roles role
  cross join unnest(array[
    'marketing','sales_desk','returns_claims','stock_control','fleet_management','ecommerce','reporting'
  ]::text[]) app(app_id)
  group by role.id, role.label, role.description
  order by lower(role.label), role.id;
end;
$$;

create or replace function public.admin_get_role_app_permissions(p_role_id text, p_app_id text)
returns table(permission_key text, group_label text, label text, granted boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.can_manage_app_settings()) then
    raise exception 'Only active administrators can view role permissions' using errcode = '42501';
  end if;
  return query
  select catalog.permission_key, catalog.group_label, catalog.label,
    exists (
      select 1 from public.application_role_permissions role_permission
      where role_permission.role_id = p_role_id
        and role_permission.app_id = catalog.app_id
        and role_permission.permission_key = catalog.permission_key
    )
  from public.application_permission_catalog catalog
  where catalog.app_id = p_app_id
  order by catalog.position, catalog.permission_key;
end;
$$;

create or replace function public.admin_get_user_app_permissions(p_profile_id uuid, p_app_id text)
returns table(permission_key text, group_label text, label text, effective_enabled boolean, override_enabled boolean, role_granted boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.can_manage_app_settings()) then
    raise exception 'Only active administrators can view permissions' using errcode = '42501';
  end if;
  return query
  select catalog.permission_key, catalog.group_label, catalog.label,
    coalesce(permission_override.enabled, role_grant.granted, false),
    permission_override.enabled, coalesce(role_grant.granted, false)
  from public.application_permission_catalog catalog
  left join public.application_user_permission_overrides permission_override
    on permission_override.profile_id = p_profile_id
    and permission_override.app_id = catalog.app_id
    and permission_override.permission_key = catalog.permission_key
  left join lateral (
    select true as granted
    from public.application_role_permissions role_permission
    join public.profile_roles profile_role on profile_role.role_id = role_permission.role_id
    where profile_role.profile_id = p_profile_id
      and (profile_role.role_id <> 'administrator' or not coalesce((select p.normal_user_view from public.profiles p where p.id=p_profile_id),false))
      and role_permission.app_id = catalog.app_id
      and role_permission.permission_key = catalog.permission_key
    limit 1
  ) role_grant on true
  where catalog.app_id = p_app_id
  order by catalog.position, catalog.permission_key;
end;
$$;

create or replace function public.admin_set_user_app_permission(
  p_profile_id uuid, p_app_id text, p_permission_key text, p_enabled boolean
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not (public.can_manage_app_settings()) then
    raise exception 'Only active administrators can change permissions' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_profile_id and active = true) then
    raise exception 'Active profile not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.application_permission_catalog where app_id = p_app_id and permission_key = p_permission_key) then
    raise exception 'Unknown application permission' using errcode = '22023';
  end if;
  if p_enabled is null then
    delete from public.application_user_permission_overrides
    where profile_id = p_profile_id and app_id = p_app_id and permission_key = p_permission_key;
  else
    insert into public.application_user_permission_overrides(profile_id, app_id, permission_key, enabled, updated_by)
    values (p_profile_id, p_app_id, p_permission_key, p_enabled, auth.uid())
    on conflict (profile_id, app_id, permission_key) do update
      set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now();
  end if;
  return true;
end;
$$;

create or replace function public.admin_chat_settings()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.can_manage_app_settings() then raise exception 'Administrator access required' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('profile_id',p.id,'display_name',p.display_name,'email',p.email,'name_color',s.name_color,
    'is_administrator',exists(select 1 from public.profile_roles r where r.profile_id=p.id and r.role_id='administrator'),
    'permissions',jsonb_build_object('create_channels',coalesce(s.create_channels,true),'invite_users',coalesce(s.invite_users,true),
      'remove_members',coalesce(s.remove_members,false),'delete_channels',coalesce(s.delete_channels,false)))
    order by lower(coalesce(nullif(p.display_name,''),p.email,'')),p.id)
    from public.profiles p left join public.chat_user_settings s on s.profile_id=p.id where p.active),'[]'::jsonb);
end;
$$;

create or replace function public.admin_save_chat_user_settings(p_profile_id uuid,p_name_color text,p_permissions jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not public.can_manage_app_settings() then raise exception 'Administrator access required' using errcode='42501'; end if;
  if not exists(select 1 from public.profiles where id=p_profile_id and active) then raise exception 'Active profile not found' using errcode='P0002'; end if;
  if p_name_color is not null and p_name_color !~* '^#[0-9a-f]{6}$' then raise exception 'Use a six-digit hex colour' using errcode='22023'; end if;
  if jsonb_typeof(p_permissions) is distinct from 'object' then raise exception 'Invalid chat permissions' using errcode='22023'; end if;
  if not(p_permissions ?& array['create_channels','invite_users','remove_members','delete_channels']) or
    exists(select 1 from jsonb_each(p_permissions) e where e.key not in ('create_channels','invite_users','remove_members','delete_channels') or jsonb_typeof(e.value)<>'boolean') then
    raise exception 'Invalid chat permissions' using errcode='22023'; end if;
  insert into public.chat_user_settings(profile_id,name_color,create_channels,invite_users,remove_members,delete_channels,updated_by)
    values(p_profile_id,lower(p_name_color),(p_permissions->>'create_channels')::boolean,(p_permissions->>'invite_users')::boolean,
      (p_permissions->>'remove_members')::boolean,(p_permissions->>'delete_channels')::boolean,auth.uid())
  on conflict(profile_id) do update set name_color=excluded.name_color,create_channels=excluded.create_channels,invite_users=excluded.invite_users,
    remove_members=excluded.remove_members,delete_channels=excluded.delete_channels,updated_by=auth.uid(),updated_at=now();
end;
$$;

create or replace function public.save_stock_location(
  p_location_id uuid,
  p_name text,
  p_description text,
  p_vehicle_name text,
  p_supply_branch text,
  p_color text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare saved_id uuid;
begin
  if not public.can_manage_app_settings() then
    raise exception using errcode = '42501', message = 'Administrator access is required to change stock locations';
  end if;
  if p_location_id is null then
    insert into public.stock_locations
      (name,description,vehicle_name,supply_branch,color,created_by,updated_by)
    values
      (btrim(p_name),btrim(coalesce(p_description,'')),btrim(coalesce(p_vehicle_name,'')),
       lower(btrim(coalesce(p_supply_branch,''))),lower(btrim(p_color)),auth.uid(),auth.uid())
    returning id into saved_id;
  else
    update public.stock_locations
    set name=btrim(p_name), description=btrim(coalesce(p_description,'')),
        vehicle_name=btrim(coalesce(p_vehicle_name,'')),
        supply_branch=lower(btrim(coalesce(p_supply_branch,''))), color=lower(btrim(p_color))
    where id=p_location_id
    returning id into saved_id;
    if saved_id is null then raise exception 'Stock location not found'; end if;
  end if;
  return saved_id;
end;
$$;

create or replace function public.set_stock_location_active(p_location_id uuid, p_active boolean)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare saved_id uuid;
begin
  if not public.can_manage_app_settings() then
    raise exception using errcode = '42501', message = 'Administrator access is required to change stock locations';
  end if;
  update public.stock_locations set is_active=p_active where id=p_location_id returning id into saved_id;
  if saved_id is null then raise exception 'Stock location not found'; end if;
  return saved_id;
end;
$$;

create or replace function public.delete_stock_location(p_location_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare deleted_name text;
begin
  if not public.can_manage_app_settings() then
    raise exception using errcode = '42501', message = 'Administrator access is required to delete stock locations';
  end if;
  delete from public.stock_locations where id=p_location_id returning name into deleted_name;
  if deleted_name is null then raise exception 'Stock location not found'; end if;
  return deleted_name;
exception
  when foreign_key_violation then
    raise exception 'This stock location is used by existing records. Deactivate it instead.';
end;
$$;

create or replace function public.save_stock_thresholds(p_slow_max numeric, p_ab_min numeric)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_manage_app_settings() then
    raise exception using errcode = '42501', message = 'Administrator access is required to change stock thresholds';
  end if;
  update public.stock_settings
  set slow_max_avg_sales=p_slow_max, ab_min_avg_sales=p_ab_min
  where singleton;
  return true;
end;
$$;

create or replace function public.create_stock_development_status(p_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare saved_name text;
begin
  if not public.can_manage_app_settings() then
    raise exception using errcode = '42501', message = 'Administrator access is required to change Development Statuses';
  end if;
  insert into public.stock_development_statuses (name,sort_order,created_by,updated_by)
  values (btrim(p_name),999,auth.uid(),auth.uid())
  returning name into saved_name;
  return saved_name;
end;
$$;

create or replace function public.set_stock_development_status_active(p_name text, p_active boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare saved_name text;
begin
  if not public.can_manage_app_settings() then
    raise exception using errcode = '42501', message = 'Administrator access is required to change Development Statuses';
  end if;
  update public.stock_development_statuses set is_active=p_active where name=p_name returning name into saved_name;
  if saved_name is null then raise exception 'Development Status not found'; end if;
  return saved_name;
end;
$$;

create or replace function public.delete_stock_development_status(p_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare deleted_name text;
begin
  if not public.can_manage_app_settings() then
    raise exception using errcode = '42501', message = 'Administrator access is required to delete Development Statuses';
  end if;
  if exists (select 1 from public.stock_parts_queries where development_status=p_name) then
    raise exception 'This Development Status is used by an existing Parts Query. Deactivate it instead.';
  end if;
  delete from public.stock_development_statuses where name=p_name returning name into deleted_name;
  if deleted_name is null then raise exception 'Development Status not found'; end if;
  return deleted_name;
end;
$$;

create or replace function public.reorder_sales_desk_config(p_kind text,p_ids uuid[])
returns uuid[] language plpgsql security definer set search_path='' as $$
declare target text; total integer;
begin
  if not(public.can_manage_app_settings()) then raise exception 'Administrator configuration permission required' using errcode='42501'; end if;
  target := case p_kind when 'media-platforms' then 'sales_desk_media_platforms' when 'statuses' then 'sales_desk_statuses' else null end;
  if target is null then raise exception 'Invalid configuration kind' using errcode='22023'; end if;
  execute format('lock table public.%I in share row exclusive mode',target);
  execute format('select count(*) from public.%I',target) into total;
  if p_ids is null or cardinality(p_ids)<>total or exists(select 1 from unnest(p_ids) id group by id having count(*)>1)
    or array_position(p_ids,null) is not null then raise exception 'Supply every configuration ID exactly once' using errcode='22023'; end if;
  execute format('select count(*) from public.%I where id=any($1)',target) into total using p_ids;
  if total<>cardinality(p_ids) then raise exception 'Configuration changed. Refresh before reordering.' using errcode='22023'; end if;
  execute format('update public.%I t set sort_order=o.position-1 from unnest($1) with ordinality o(id,position) where t.id=o.id',target) using p_ids;
  return p_ids;
end $$;

create or replace function public.get_sales_desk_milestones()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not (public.can_manage_app_settings() or public.has_application_permission('sales_desk','sales_desk.view')) then raise exception 'Sales Desk access required' using errcode='42501'; end if;
  return (select jsonb_build_object('sales',s.sales,'gp',s.gp,'version',s.version,'configured',s.configured)
    from public.sales_desk_milestone_settings s where s.singleton);
end;
$$;

create or replace function public.save_sales_desk_milestones(p_sales jsonb,p_gp jsonb,p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare items jsonb; kind text; actual_version bigint;
begin
  if not(public.can_manage_app_settings()) then
    raise exception 'Administrator configuration permission required' using errcode='42501'; end if;
  foreach kind in array array['sales','gp'] loop
    items:=case when kind='sales' then p_sales else p_gp end;
    if jsonb_typeof(items) is distinct from 'array' then raise exception 'Milestones must be arrays' using errcode='22023'; end if;
    if jsonb_array_length(items)>50 then raise exception 'Use no more than 50 milestones per group' using errcode='22023'; end if;
    if exists(select 1 from jsonb_array_elements(items) e where jsonb_typeof(e)<>'object' or jsonb_typeof(e->'value') is distinct from 'number' or
      jsonb_typeof(e->'color') is distinct from 'string' or (e->>'color') !~* '^#[0-9a-f]{6}$') then
      raise exception 'Each milestone needs a numeric value and six-digit hex colour' using errcode='22023'; end if;
    if exists(select 1 from jsonb_array_elements(items) e where (e->>'value')::numeric<0 or
      (e->>'value')::numeric>case when kind='gp' then 100 else 999999999999.99 end or
      (kind='sales' and (e->>'value')::numeric=0) or round((e->>'value')::numeric,2)<>(e->>'value')::numeric) then
      raise exception 'Milestone value is outside its allowed range or precision' using errcode='22023'; end if;
    if (select count(*)<>count(distinct (e->>'value')::numeric) from jsonb_array_elements(items) e) then
      raise exception 'Milestone values must be unique in each group' using errcode='22023'; end if;
  end loop;
  select s.version into actual_version from public.sales_desk_milestone_settings s where s.singleton for update;
  if p_expected_version is null or p_expected_version<>actual_version then
    raise exception 'Milestones changed elsewhere. Reload milestones before saving again.' using errcode='40001'; end if;
  update public.sales_desk_milestone_settings set
    sales=coalesce((select jsonb_agg(jsonb_build_object('value',(e->>'value')::numeric,'color',lower(e->>'color')) order by (e->>'value')::numeric) from jsonb_array_elements(p_sales) e),'[]'),
    gp=coalesce((select jsonb_agg(jsonb_build_object('value',(e->>'value')::numeric,'color',lower(e->>'color')) order by (e->>'value')::numeric) from jsonb_array_elements(p_gp) e),'[]'),
    version=actual_version+1,configured=true,updated_by=auth.uid(),updated_at=now() where singleton;
  return public.get_sales_desk_milestones();
end;
$$;

create or replace function public.admin_sales_desk_configuration()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  if not public.can_manage_app_settings() then raise exception 'Sales Desk access required' using errcode='42501'; end if;
  with counts as materialized (select sales_code_id,status_id,media_platform_id,count(*) n from public.sales_desk_rfqs group by sales_code_id,status_id,media_platform_id),
  owners as (select upper(sales_code) code,max(display_name) display_name from public.sales_desk_code_owners() group by upper(sales_code))
  select jsonb_build_object('media_platforms',coalesce((select jsonb_agg(to_jsonb(m)||jsonb_build_object('rfq_count',coalesce((select sum(n) from counts where media_platform_id=m.id),0)) order by sort_order,name) from public.sales_desk_media_platforms m),'[]'::jsonb),
    'statuses',coalesce((select jsonb_agg(to_jsonb(s)||jsonb_build_object('rfq_count',coalesce((select sum(n) from counts where status_id=s.id),0)) order by sort_order,name) from public.sales_desk_statuses s),'[]'::jsonb),
    'sales_codes',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('consultant_name',o.display_name,'rfq_count',coalesce((select sum(n) from counts where sales_code_id=c.id),0)) order by c.code)
      from public.sales_desk_sales_codes c left join owners o on o.code=upper(c.code)),'[]'::jsonb),
    'can_configure',public.can_manage_app_settings()) into result;
  return result;
end $$;

create function public.admin_settings_identity()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.can_manage_app_settings() then raise exception 'Administrator settings access required' using errcode='42501'; end if;
  return(select jsonb_build_object('id',p.id,'display_name',p.display_name,'sales_code',p.sales_code,'role','administrator') from public.profiles p where p.id=auth.uid());
end;
$$;
create function public.admin_stock_configuration()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.can_manage_app_settings() then raise exception 'Administrator settings access required' using errcode='42501'; end if;
  return jsonb_build_object('locations',coalesce((select jsonb_agg(to_jsonb(l) order by l.name) from public.stock_locations l),'[]'::jsonb),
    'settings',(select jsonb_build_object('slow_max_avg_sales',s.slow_max_avg_sales,'ab_min_avg_sales',s.ab_min_avg_sales) from public.stock_settings s where s.singleton),
    'statuses',coalesce((select jsonb_agg(to_jsonb(d) order by d.sort_order,d.name) from public.stock_development_statuses d),'[]'::jsonb),
    'access',jsonb_build_object('isAdmin',true,'canEdit',true));
end;
$$;

create policy "administrator account settings access" on public.sales_desk_media_platforms for all to authenticated using(public.can_manage_app_settings()) with check(public.can_manage_app_settings());

create policy "administrator account settings access" on public.sales_desk_statuses for all to authenticated using(public.can_manage_app_settings()) with check(public.can_manage_app_settings());

create policy "administrator account settings access" on public.sales_desk_sales_codes for all to authenticated using(public.can_manage_app_settings()) with check(public.can_manage_app_settings());

create policy "administrator account settings access" on public.campaign_types for all to authenticated using(public.can_manage_app_settings()) with check(public.can_manage_app_settings());

create table public.application_role_permission_audit (
  id bigint generated always as identity primary key,
  actor_user_id uuid not null references auth.users(id),
  role_id text not null references public.roles(id),
  app_id text not null, permission_key text not null,
  previous_enabled boolean not null, enabled boolean not null,
  created_at timestamptz not null default now()
);
alter table public.application_role_permission_audit enable row level security;
revoke all on public.application_role_permission_audit from public,anon,authenticated;
grant select on public.application_role_permission_audit to authenticated;
create policy "settings administrators read role permission audit" on public.application_role_permission_audit for select to authenticated using(public.can_manage_app_settings());
create function public.admin_set_role_app_permission(p_role_id text,p_app_id text,p_permission_key text,p_enabled boolean)
returns boolean language plpgsql security definer set search_path='' as $$
declare was_enabled boolean;
begin
  if not public.can_manage_app_settings() then raise exception 'Administrator settings access required' using errcode='42501'; end if;
  if p_enabled is null then raise exception 'Choose Allow or Deny for the role default' using errcode='22023'; end if;
  perform 1 from public.roles where id=p_role_id for update;
  if not found then raise exception 'Role not found' using errcode='P0002'; end if;
  if not exists(select 1 from public.application_permission_catalog where app_id=p_app_id and permission_key=p_permission_key) then raise exception 'Unknown application permission' using errcode='22023'; end if;
  select exists(select 1 from public.application_role_permissions where role_id=p_role_id and app_id=p_app_id and permission_key=p_permission_key) into was_enabled;
  if p_enabled then
    insert into public.application_role_permissions(role_id,app_id,permission_key) values(p_role_id,p_app_id,p_permission_key) on conflict do nothing;
  else
    delete from public.application_role_permissions where role_id=p_role_id and app_id=p_app_id and permission_key=p_permission_key;
  end if;
  if was_enabled is distinct from p_enabled then
    insert into public.application_role_permission_audit(actor_user_id,role_id,app_id,permission_key,previous_enabled,enabled)
      values(auth.uid(),p_role_id,p_app_id,p_permission_key,was_enabled,p_enabled);
  end if;
  return p_enabled;
end;
$$;
-- Keep the old Marketing setter compatible with explicit per-user overrides.
create or replace function public.admin_set_marketing_permission(p_profile_id uuid,p_permission_key text,p_enabled boolean)
returns boolean language sql security definer set search_path='' as $$
  select public.admin_set_user_app_permission(p_profile_id,'marketing',p_permission_key,p_enabled);
$$;
create function public.can_manage_marketing_accounts()
returns boolean language sql stable security definer set search_path='' as $$
  select public.can_manage_app_settings() or public.has_marketing_permission('feed.manage_accounts');
$$;
create function public.can_view_marketing_connections()
returns boolean language sql stable security definer set search_path='' as $$
  select public.can_manage_app_settings() or public.can_access_workspace('marketing');
$$;
revoke all on function public.admin_sales_desk_configuration(),public.admin_settings_identity(),public.admin_stock_configuration(),
 public.admin_set_role_app_permission(text,text,text,boolean),public.can_manage_marketing_accounts(),public.can_view_marketing_connections() from public,anon;
grant execute on function public.admin_sales_desk_configuration(),public.admin_settings_identity(),public.admin_stock_configuration(),
 public.admin_set_role_app_permission(text,text,text,boolean),public.can_manage_marketing_accounts(),public.can_view_marketing_connections() to authenticated;
drop policy if exists "administrators read app access audit" on public.admin_app_access_audit;
create policy "administrators read app access audit" on public.admin_app_access_audit for select to authenticated using(public.can_manage_app_settings());
notify pgrst,'reload schema';
