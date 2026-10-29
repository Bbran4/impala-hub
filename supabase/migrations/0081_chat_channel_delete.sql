-- Channel deletion is restricted to the creator or an administrator.
create or replace function public.chat_delete_channel(target_channel_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_active_user() then raise exception 'An active account is required' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.chat_channels channel
    where channel.id = target_channel_id
      and (channel.created_by = auth.uid() or public.has_role('administrator'))
  ) then raise exception 'Only the channel creator or an administrator can delete this channel' using errcode = '42501'; end if;
  delete from public.chat_channels where id = target_channel_id;
end;
$$;

revoke all on function public.chat_delete_channel(uuid) from public, anon;
grant execute on function public.chat_delete_channel(uuid) to authenticated;
notify pgrst, 'reload schema';
