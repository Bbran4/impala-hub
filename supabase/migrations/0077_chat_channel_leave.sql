-- Allow an active member to leave a channel.
create or replace function public.chat_leave_channel(target_channel_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_active_user() then raise exception 'An active account is required' using errcode = '42501'; end if;
  delete from public.chat_channel_members where channel_id = target_channel_id and user_id = auth.uid();
  if not found then raise exception 'You are not a member of this channel' using errcode = '42501'; end if;
end;
$$;

revoke all on function public.chat_leave_channel(uuid) from public, anon;
grant execute on function public.chat_leave_channel(uuid) to authenticated;
notify pgrst, 'reload schema';
