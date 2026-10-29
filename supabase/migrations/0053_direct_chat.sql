-- Persistent one-to-one team chat. All access is participant-scoped.

create table public.chat_conversations (
  id uuid primary key default gen_random_uuid(),
  user_one uuid not null references public.profiles(id) on delete cascade,
  user_two uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  constraint chat_conversations_distinct_users check (user_one <> user_two),
  constraint chat_conversations_canonical_order check (user_one < user_two),
  constraint chat_conversations_direct_pair unique (user_one, user_two)
);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete restrict,
  client_message_id uuid not null,
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  constraint chat_messages_sender_client_unique unique (sender_id, client_message_id)
);

create table public.chat_read_states (
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index chat_messages_conversation_created_idx
  on public.chat_messages (conversation_id, created_at desc, id desc);
create index chat_conversations_user_one_last_idx
  on public.chat_conversations (user_one, last_message_at desc);
create index chat_conversations_user_two_last_idx
  on public.chat_conversations (user_two, last_message_at desc);

alter table public.chat_conversations enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_read_states enable row level security;

revoke all on public.chat_conversations from public, anon, authenticated;
revoke all on public.chat_messages from public, anon, authenticated;
revoke all on public.chat_read_states from public, anon, authenticated;

create policy "participants read direct conversations"
on public.chat_conversations for select to authenticated
using (public.is_active_user() and auth.uid() in (user_one, user_two));

create policy "participants read direct messages"
on public.chat_messages for select to authenticated
using (
  public.is_active_user() and exists (
    select 1 from public.chat_conversations conversation
    where conversation.id = chat_messages.conversation_id
      and auth.uid() in (conversation.user_one, conversation.user_two)
  )
);

create or replace function public.chat_search_users(search_text text)
returns table (
  user_id uuid,
  display_name text,
  email text,
  avatar_url text
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
  select profile.id, profile.display_name, profile.email, profile.avatar_url
  from public.profiles profile
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

create or replace function public.chat_open_direct(other_user_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  first_user uuid;
  second_user uuid;
  result_id uuid;
begin
  if not public.is_active_user() then
    raise exception 'An active account is required' using errcode = '42501';
  end if;
  if other_user_id is null or other_user_id = auth.uid() then
    raise exception 'Choose another active user' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles profile where profile.id = other_user_id and profile.active = true) then
    raise exception 'Active user not found' using errcode = 'P0002';
  end if;

  first_user := least(auth.uid(), other_user_id);
  second_user := greatest(auth.uid(), other_user_id);
  insert into public.chat_conversations (user_one, user_two)
  values (first_user, second_user)
  on conflict (user_one, user_two) do update
    set last_message_at = public.chat_conversations.last_message_at
  returning id into result_id;

  insert into public.chat_read_states (conversation_id, user_id)
  values (result_id, auth.uid()), (result_id, other_user_id)
  on conflict (conversation_id, user_id) do nothing;
  return result_id;
end;
$$;

create or replace function public.chat_list_conversations()
returns table (
  conversation_id uuid,
  other_user_id uuid,
  other_display_name text,
  other_email text,
  other_avatar_url text,
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
  created_at timestamptz
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
    recent.body, recent.created_at
  from (
    select message.* from public.chat_messages message
    where message.conversation_id = target_conversation_id
    order by message.created_at desc, message.id desc
    limit 100
  ) recent
  join public.profiles sender on sender.id = recent.sender_id
  order by recent.created_at, recent.id;
end;
$$;

create or replace function public.chat_send_message(target_conversation_id uuid, p_client_message_id uuid, message_body text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  clean_body text := btrim(coalesce(message_body, ''));
  result_id uuid;
  existing_message public.chat_messages%rowtype;
begin
  if not public.is_active_user() or not exists (
    select 1 from public.chat_conversations conversation
    where conversation.id = target_conversation_id
      and auth.uid() in (conversation.user_one, conversation.user_two)
  ) then
    raise exception 'Chat access denied' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.chat_conversations conversation
    join public.profiles recipient on recipient.id = case
      when conversation.user_one = auth.uid() then conversation.user_two else conversation.user_one end
    where conversation.id = target_conversation_id and recipient.active = true
  ) then
    raise exception 'Recipient is unavailable' using errcode = 'P0002';
  end if;
  if char_length(clean_body) not between 1 and 4000 then
    raise exception 'Messages must contain between 1 and 4000 characters' using errcode = '22023';
  end if;

  if p_client_message_id is null then
    raise exception 'A client message identifier is required' using errcode = '22023';
  end if;

  insert into public.chat_messages (conversation_id, sender_id, client_message_id, body)
  values (target_conversation_id, auth.uid(), p_client_message_id, clean_body)
  on conflict (sender_id, client_message_id) do nothing
  returning id into result_id;
  if result_id is null then
    select message.* into existing_message
    from public.chat_messages message
    where message.sender_id = auth.uid() and message.client_message_id = p_client_message_id;
    if existing_message.conversation_id <> target_conversation_id or existing_message.body <> clean_body then
      raise exception 'That message retry does not match the original message' using errcode = '22023';
    end if;
    return existing_message.id;
  end if;
  update public.chat_conversations set last_message_at = now() where id = target_conversation_id;
  insert into public.chat_read_states (conversation_id, user_id, last_read_at)
  values (target_conversation_id, auth.uid(), now())
  on conflict (conversation_id, user_id) do update set last_read_at = excluded.last_read_at;
  return result_id;
end;
$$;

create or replace function public.chat_mark_read(target_conversation_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
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
  on conflict (conversation_id, user_id) do update set last_read_at = excluded.last_read_at;
end;
$$;

revoke all on function public.chat_search_users(text) from public, anon;
revoke all on function public.chat_open_direct(uuid) from public, anon;
revoke all on function public.chat_list_conversations() from public, anon;
revoke all on function public.chat_list_messages(uuid) from public, anon;
revoke all on function public.chat_send_message(uuid, uuid, text) from public, anon;
revoke all on function public.chat_mark_read(uuid) from public, anon;
grant execute on function public.chat_search_users(text) to authenticated;
grant execute on function public.chat_open_direct(uuid) to authenticated;
grant execute on function public.chat_list_conversations() to authenticated;
grant execute on function public.chat_list_messages(uuid) to authenticated;
grant execute on function public.chat_send_message(uuid, uuid, text) to authenticated;
grant execute on function public.chat_mark_read(uuid) to authenticated;
