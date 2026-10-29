-- Channel membership management and member discovery.
create or replace function public.chat_list_channel_members(target_channel_id uuid)
returns table(user_id uuid, display_name text, email text, avatar_url text, is_online boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_active_user() or not exists (select 1 from public.chat_channel_members member where member.channel_id = target_channel_id and member.user_id = auth.uid()) then raise exception 'Channel access denied' using errcode = '42501'; end if;
  return query select profile.id, coalesce(nullif(btrim(profile.display_name), ''), profile.email, 'User'), profile.email, profile.avatar_url, coalesce(presence.last_seen_at > now() - interval '75 seconds', false)
  from public.chat_channel_members member join public.profiles profile on profile.id = member.user_id left join public.chat_presence presence on presence.user_id = profile.id
  where member.channel_id = target_channel_id and profile.active = true order by lower(coalesce(nullif(btrim(profile.display_name), ''), profile.email, ''));
end;
$$;

create or replace function public.chat_add_channel_member(target_channel_id uuid, target_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_active_user() or not exists (select 1 from public.chat_channel_members member where member.channel_id = target_channel_id and member.user_id = auth.uid()) then raise exception 'Channel access denied' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles profile where profile.id = target_user_id and profile.active = true) then raise exception 'User is not active' using errcode = '22023'; end if;
  insert into public.chat_channel_members(channel_id, user_id) values (target_channel_id, target_user_id) on conflict do nothing;
end;
$$;

revoke all on function public.chat_list_channel_members(uuid) from public, anon;
revoke all on function public.chat_add_channel_member(uuid, uuid) from public, anon;
grant execute on function public.chat_list_channel_members(uuid) to authenticated;
grant execute on function public.chat_add_channel_member(uuid, uuid) to authenticated;
notify pgrst, 'reload schema';
