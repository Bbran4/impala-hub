-- Chat presence and recipient read receipts.

create table public.chat_presence (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  last_seen_at timestamptz not null default now()
);

create index chat_presence_last_seen_idx on public.chat_presence (last_seen_at desc);
alter table public.chat_presence enable row level security;
revoke all on public.chat_presence from public, anon, authenticated;

create or replace function public.chat_presence_heartbeat()
returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  heartbeat_at timestamptz := now();
begin
  if not public.is_active_user() then
    raise exception 'An active account is required' using errcode = '42501';
  end if;
  insert into public.chat_presence (user_id, last_seen_at)
  values (auth.uid(), heartbeat_at)
  on conflict (user_id) do update set last_seen_at = excluded.last_seen_at;
  return heartbeat_at;
end;
$$;

drop function public.chat_search_users(text);
create function public.chat_search_users(search_text text)
returns table (
  user_id uuid,
  display_name text,
  email text,
  avatar_url text,
  is_online boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare
  query_text text := lower(ltrim(btrim(coalesce(search_text, '')), '@'));
begin
  if not public.is_active_user() then
    raise exception 'An active account is required' using errcode = '42501';
  end if;
  if char_length(query_text) < 1 then return; end if;

  return query
  select profile.id, profile.display_name, profile.email, profile.avatar_url,
    coalesce(presence.last_seen_at > now() - interval '75 seconds', false)
  from public.profiles profile
  left join public.chat_presence presence on presence.user_id = profile.id
  where profile.active = true
    and profile.id <> auth.uid()
    and (
      position(query_text in lower(coalesce(profile.display_name, ''))) > 0
      or position(query_text in lower(coalesce(profile.first_name, '') || ' ' || coalesce(profile.surname, ''))) > 0
      or position(query_text in lower(coalesce(profile.email, ''))) > 0
    )
  order by
    case when position(query_text in lower(coalesce(profile.display_name, ''))) = 1 then 0
         when position(query_text in lower(coalesce(profile.email, ''))) = 1 then 1 else 2 end,
    lower(coalesce(nullif(btrim(profile.display_name), ''), profile.email, ''))
  limit 20;
end;
$$;

drop function public.chat_list_conversations();
create function public.chat_list_conversations()
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
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_active_user() then
    raise exception 'An active account is required' using errcode = '42501';
  end if;

  return query
  select
    conversation.id,
    other_profile.id,
    other_profile.display_name,
    other_profile.email,
    other_profile.avatar_url,
    coalesce(other_presence.last_seen_at > now() - interval '75 seconds', false),
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

drop function public.chat_list_messages(uuid);
create function public.chat_list_messages(target_conversation_id uuid)
returns table (
  message_id uuid,
  conversation_id uuid,
  sender_id uuid,
  sender_name text,
  body text,
  created_at timestamptz,
  read_by_recipient boolean
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_active_user() or not exists (
    select 1 from public.chat_conversations conversation
    where conversation.id = target_conversation_id
      and auth.uid() in (conversation.user_one, conversation.user_two)
  ) then
    raise exception 'Chat access denied' using errcode = '42501';
  end if;

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

revoke all on function public.chat_presence_heartbeat() from public, anon;
revoke all on function public.chat_search_users(text) from public, anon;
revoke all on function public.chat_list_conversations() from public, anon;
revoke all on function public.chat_list_messages(uuid) from public, anon;
grant execute on function public.chat_presence_heartbeat() to authenticated;
grant execute on function public.chat_search_users(text) to authenticated;
grant execute on function public.chat_list_conversations() to authenticated;
grant execute on function public.chat_list_messages(uuid) to authenticated;
