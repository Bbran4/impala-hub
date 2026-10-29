-- Permission settings support app filtering for users and role inspection.

drop function if exists public.admin_list_permission_users();
create function public.admin_list_permission_users()
returns table(profile_id uuid, display_name text, email text, roles text[], accessible_apps text[])
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.is_active_user() and public.has_role('administrator')) then
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
  if not (public.is_active_user() and public.has_role('administrator')) then
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
  if not (public.is_active_user() and public.has_role('administrator')) then
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

revoke all on function public.admin_list_permission_users() from public, anon;
revoke all on function public.admin_list_permission_roles() from public, anon;
revoke all on function public.admin_get_role_app_permissions(text, text) from public, anon;
grant execute on function public.admin_list_permission_users() to authenticated;
grant execute on function public.admin_list_permission_roles() to authenticated;
grant execute on function public.admin_get_role_app_permissions(text, text) to authenticated;

notify pgrst, 'reload schema';
