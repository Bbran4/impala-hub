-- Shared chat permissions and assigned name colours.
create table public.chat_user_settings (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  name_color text check(name_color ~ '^#[0-9a-f]{6}$'),
  create_channels boolean not null default true,
  invite_users boolean not null default true,
  remove_members boolean not null default false,
  delete_channels boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.chat_user_settings enable row level security;
revoke all on public.chat_user_settings from public,anon,authenticated;
grant all on public.chat_user_settings to service_role;

create function public.chat_has_permission(p_permission text)
returns boolean language sql stable security definer set search_path='' as $$
  select public.is_active_user() and p_permission in ('create_channels','invite_users','remove_members','delete_channels') and (
    public.has_role('administrator') or coalesce((select case p_permission
      when 'create_channels' then s.create_channels when 'invite_users' then s.invite_users
      when 'remove_members' then s.remove_members when 'delete_channels' then s.delete_channels end
      from public.chat_user_settings s where s.profile_id=auth.uid()), p_permission in ('create_channels','invite_users'))
  );
$$;
create function public.chat_client_settings()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.is_active_user() then raise exception 'An active account is required' using errcode='42501'; end if;
  return jsonb_build_object('permissions',jsonb_build_object(
    'create_channels',public.chat_has_permission('create_channels'), 'invite_users',public.chat_has_permission('invite_users'),
    'remove_members',public.chat_has_permission('remove_members'), 'delete_channels',public.chat_has_permission('delete_channels')),
    'colors',coalesce((select jsonb_object_agg(s.profile_id::text,s.name_color) from public.chat_user_settings s
      join public.profiles p on p.id=s.profile_id where p.active and s.name_color is not null),'{}'::jsonb));
end;
$$;
create function public.admin_chat_settings()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.has_role('administrator') then raise exception 'Administrator access required' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('profile_id',p.id,'display_name',p.display_name,'email',p.email,'name_color',s.name_color,
    'is_administrator',exists(select 1 from public.profile_roles r where r.profile_id=p.id and r.role_id='administrator'),
    'permissions',jsonb_build_object('create_channels',coalesce(s.create_channels,true),'invite_users',coalesce(s.invite_users,true),
      'remove_members',coalesce(s.remove_members,false),'delete_channels',coalesce(s.delete_channels,false)))
    order by lower(coalesce(nullif(p.display_name,''),p.email,'')),p.id)
    from public.profiles p left join public.chat_user_settings s on s.profile_id=p.id where p.active),'[]'::jsonb);
end;
$$;
create function public.admin_save_chat_user_settings(p_profile_id uuid,p_name_color text,p_permissions jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not public.has_role('administrator') then raise exception 'Administrator access required' using errcode='42501'; end if;
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

create or replace function public.chat_create_channel(channel_name text, channel_description text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare result_id uuid;
begin
  if not public.chat_has_permission('create_channels') then raise exception 'Chat permission required: create_channels' using errcode='42501'; end if;
  if not public.is_active_user() then raise exception 'An active account is required' using errcode = '42501'; end if;
  insert into public.chat_channels(name, description, created_by)
  values (btrim(channel_name), btrim(coalesce(channel_description, '')), auth.uid()) returning id into result_id;
  insert into public.chat_channel_members(channel_id, user_id) values (result_id, auth.uid());
  return result_id;
end;
$$;

create or replace function public.chat_add_channel_member(target_channel_id uuid, target_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.chat_has_permission('invite_users') then raise exception 'Chat permission required: invite_users' using errcode='42501'; end if;
  if not public.is_active_user() or not exists (select 1 from public.chat_channel_members member where member.channel_id = target_channel_id and member.user_id = auth.uid()) then raise exception 'Channel access denied' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles profile where profile.id = target_user_id and profile.active = true) then raise exception 'User is not active' using errcode = '22023'; end if;
  insert into public.chat_channel_members(channel_id, user_id) values (target_channel_id, target_user_id) on conflict do nothing;
end;
$$;

create or replace function public.chat_delete_channel(target_channel_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not public.chat_has_permission('delete_channels') or not exists(
    select 1 from public.chat_channels c where c.id=target_channel_id and (public.has_role('administrator') or exists(
      select 1 from public.chat_channel_members m where m.channel_id=c.id and m.user_id=auth.uid()))
  ) then raise exception 'Channel delete permission required' using errcode='42501'; end if;
  delete from public.chat_channels where id=target_channel_id;
end;
$$;
create function public.chat_remove_channel_member(target_channel_id uuid,target_user_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if target_user_id=auth.uid() then raise exception 'Use Leave to leave a channel' using errcode='22023'; end if;
  if not public.chat_has_permission('remove_members') or not exists(
    select 1 from public.chat_channels c where c.id=target_channel_id and (public.has_role('administrator') or exists(
      select 1 from public.chat_channel_members m where m.channel_id=c.id and m.user_id=auth.uid()))
  ) then raise exception 'Channel membership permission required' using errcode='42501'; end if;
  delete from public.chat_channel_members where channel_id=target_channel_id and user_id=target_user_id;
end;
$$;
revoke all on function public.chat_has_permission(text), public.chat_client_settings(), public.admin_chat_settings(),
  public.admin_save_chat_user_settings(uuid,text,jsonb), public.chat_remove_channel_member(uuid,uuid) from public,anon;
grant execute on function public.chat_has_permission(text), public.chat_client_settings(), public.admin_chat_settings(),
  public.admin_save_chat_user_settings(uuid,text,jsonb), public.chat_remove_channel_member(uuid,uuid) to authenticated;
notify pgrst,'reload schema';
