-- Avoid a PL/pgSQL output-column collision when recording chat read state.

create or replace function public.chat_list_messages(target_conversation_id uuid)
returns table (
  message_id uuid,
  conversation_id uuid,
  sender_id uuid,
  sender_name text,
  body text,
  created_at timestamptz,
  read_by_recipient boolean
)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_active_user() or not exists (
    select 1 from public.chat_conversations conversation
    where conversation.id = target_conversation_id
      and auth.uid() in (conversation.user_one, conversation.user_two)
  ) then
    raise exception 'Chat access denied' using errcode = '42501';
  end if;

  insert into public.chat_read_states (conversation_id, user_id, last_read_at)
  values (target_conversation_id, auth.uid(), now())
  on conflict on constraint chat_read_states_pkey do update
  set last_read_at = greatest(public.chat_read_states.last_read_at, excluded.last_read_at);

  return query
  select recent.id, recent.conversation_id, recent.sender_id,
    coalesce(nullif(btrim(sender.display_name), ''), sender.email, 'User'),
    recent.body, recent.created_at,
    coalesce(recipient_state.last_read_at >= recent.created_at, false)
  from (
    select message.* from public.chat_messages message
    where message.conversation_id = target_conversation_id
    order by message.created_at desc, message.id desc
    limit 100
  ) recent
  join public.profiles sender on sender.id = recent.sender_id
  join public.chat_conversations conversation on conversation.id = recent.conversation_id
  left join public.chat_read_states recipient_state
    on recipient_state.conversation_id = recent.conversation_id
    and recipient_state.user_id = case
      when recent.sender_id = conversation.user_one then conversation.user_two else conversation.user_one end
  order by recent.created_at, recent.id;
end;
$$;

revoke all on function public.chat_list_messages(uuid) from public, anon;
grant execute on function public.chat_list_messages(uuid) to authenticated;

notify pgrst, 'reload schema';
