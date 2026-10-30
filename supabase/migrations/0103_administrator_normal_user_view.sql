-- Administrators can temporarily use their assigned non-admin roles and permissions.
-- Keep the stored administrator role so the account can always leave this mode.
alter table public.profiles add column normal_user_view boolean not null default false;

create or replace function public.has_role(required_role text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profile_roles pr
    join public.profiles p on p.id = pr.profile_id
    where pr.profile_id = auth.uid() and pr.role_id = required_role and p.active
      and (required_role <> 'administrator' or not p.normal_user_view)
  );
$$;

-- This is the only route for changing the preference. Check the stored role,
-- rather than has_role(), so an administrator in normal view can restore access.
create function public.set_my_normal_user_view(p_enabled boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_enabled is null then
    raise exception 'Choose whether to use normal user view' using errcode='22023';
  end if;
  if not exists (
    select 1 from public.profiles p
    join public.profile_roles pr on pr.profile_id=p.id and pr.role_id='administrator'
    where p.id=auth.uid() and p.active
  ) then
    raise exception 'Only active administrators can change their viewing mode' using errcode='42501';
  end if;
  update public.profiles set normal_user_view=p_enabled, updated_at=now() where id=auth.uid();
  return p_enabled;
end;
$$;

create function public.my_account_access()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'is_administrator_account', exists (
      select 1 from public.profile_roles r where r.profile_id=auth.uid()
        and r.role_id='administrator' and public.is_active_user()
    ),
    'normal_user_view', coalesce((select p.normal_user_view from public.profiles p
      where p.id=auth.uid() and p.active), false),
    'roles', coalesce((select jsonb_agg(r.role_id order by r.role_id)
      from public.profile_roles r where r.profile_id=auth.uid() and public.has_role(r.role_id)), '[]'::jsonb)
  );
$$;

revoke all on function public.set_my_normal_user_view(boolean),public.my_account_access() from public,anon;
grant execute on function public.set_my_normal_user_view(boolean),public.my_account_access() to authenticated;

-- Existing profile column grants deliberately omit normal_user_view. Do not
-- allow direct browser updates, including updates from ordinary employees.
revoke update(normal_user_view) on public.profiles from authenticated,anon;

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
          )) or (p_app_id = 'marketing' and exists (
            select 1 from public.marketing_user_permissions legacy
            where legacy.profile_id = auth.uid() and legacy.permission_key = p_permission_key
          )), false)
      )
    )
  );
$$;

notify pgrst, 'reload schema';
