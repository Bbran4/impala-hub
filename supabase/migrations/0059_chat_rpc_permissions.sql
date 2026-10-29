-- Reassert direct-chat RPC access after replacing the state-sync functions.
-- The privilege check makes this migration fail instead of deploying silently
-- if Postgres does not apply the grant to the authenticated API role.

grant usage on schema public to authenticated;

grant execute on function public.chat_presence_heartbeat() to authenticated;
grant execute on function public.chat_search_users(text) to authenticated;
grant execute on function public.chat_open_direct(uuid) to authenticated;
grant execute on function public.chat_list_conversations() to authenticated;
grant execute on function public.chat_list_messages(uuid) to authenticated;
grant execute on function public.chat_send_message(uuid, uuid, text) to authenticated;
grant execute on function public.chat_mark_read(uuid) to authenticated;

do $$
begin
  if not has_function_privilege('authenticated', 'public.chat_list_messages(uuid)', 'execute') then
    raise exception 'authenticated role is missing chat_list_messages execute permission';
  end if;
end;
$$;

notify pgrst, 'reload schema';
