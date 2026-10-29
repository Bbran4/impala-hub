-- Keep direct-chat presence, unread state, and read receipts synchronized by the
-- same RPCs that the client already polls. This avoids browser timing races.

create or replace function public.chat_list_conversations()
returns table (
  conversation_id uuid,
  other_user_id uuid,
  other_display_name text,
  other_email text,
  other_avatar_url text,
  other_is_online boolean,
  last_message text,
  last_message_at timestamptz,
  unread_count bigint
)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_active_user() then
    raise exception 'An active account is required' using errcode = '42501';
  end if;

  insert into public.chat_presence (user_id, last_seen_at)
  values (auth.uid(), now())
  on conflict (user_id) do update set last_seen_at = excluded.last_seen_at;

  return query
  select
    conversation.id,
    other_profile.id,
    other_profile.display_name,
    other_profile.email,
    other_profile.avatar_url,
    coalesce(other_presence.last_seen_at > now() - interval '90 seconds', false),
    latest.body,
    coalesce(latest.created_at, conversation.created_at),
    (
      select count(*) from public.chat_messages unread
      where unread.conversation_id = conversation.id
        and unread.sender_id <> auth.uid()
        and unread.created_at > coalesce(read_state.last_read_at, '-infinity'::timestamptz)
    )
  from public.chat_conversations conversation
  join public.profiles other_profile on other_profile.id = case
    when conversation.user_one = auth.uid() then conversation.user_two else conversation.user_one end
  left join public.chat_presence other_presence on other_presence.user_id = other_profile.id
  left join public.chat_read_states read_state
    on read_state.conversation_id = conversation.id and read_state.user_id = auth.uid()
  left join lateral (
    select message.body, message.created_at
    from public.chat_messages message
    where message.conversation_id = conversation.id
    order by message.created_at desc, message.id desc
    limit 1
  ) latest on true
  where auth.uid() in (conversation.user_one, conversation.user_two)
  order by conversation.last_message_at desc, conversation.id;
end;
$$;

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
  on conflict (conversation_id, user_id) do update
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

revoke all on function public.chat_list_conversations() from public, anon;
revoke all on function public.chat_list_messages(uuid) from public, anon;
grant execute on function public.chat_list_conversations() to authenticated;
grant execute on function public.chat_list_messages(uuid) to authenticated;
