-- Channels and file attachments for direct and channel chat.

create table if not exists public.chat_channels (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text not null default '',
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists public.chat_channel_members (
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);

create table if not exists public.chat_channel_messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete restrict,
  client_message_id uuid not null,
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  constraint chat_channel_messages_sender_client_unique unique (sender_id, client_message_id)
);

create table if not exists public.chat_channel_read_states (
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);

create table if not exists public.chat_message_attachments (
  id uuid primary key default gen_random_uuid(),
  direct_message_id uuid references public.chat_messages(id) on delete cascade,
  channel_message_id uuid references public.chat_channel_messages(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null check (char_length(btrim(file_name)) between 1 and 255),
  content_type text not null default 'application/octet-stream',
  size_bytes bigint not null check (size_bytes between 1 and 26214400),
  uploaded_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint chat_attachment_one_parent check ((direct_message_id is not null) <> (channel_message_id is not null))
);

create index if not exists chat_channel_messages_channel_created_idx
  on public.chat_channel_messages(channel_id, created_at desc, id desc);
create index if not exists chat_message_attachments_direct_idx
  on public.chat_message_attachments(direct_message_id) where direct_message_id is not null;
create index if not exists chat_message_attachments_channel_idx
  on public.chat_message_attachments(channel_message_id) where channel_message_id is not null;

alter table public.chat_channels enable row level security;
alter table public.chat_channel_members enable row level security;
alter table public.chat_channel_messages enable row level security;
alter table public.chat_channel_read_states enable row level security;
alter table public.chat_message_attachments enable row level security;
revoke all on public.chat_channels, public.chat_channel_members, public.chat_channel_messages, public.chat_channel_read_states, public.chat_message_attachments from public, anon, authenticated;

create or replace function public.chat_create_channel(channel_name text, channel_description text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare result_id uuid;
begin
  if not public.is_active_user() then raise exception 'An active account is required' using errcode = '42501'; end if;
  insert into public.chat_channels(name, description, created_by)
  values (btrim(channel_name), btrim(coalesce(channel_description, '')), auth.uid()) returning id into result_id;
  insert into public.chat_channel_members(channel_id, user_id) values (result_id, auth.uid());
  return result_id;
end;
$$;

create or replace function public.chat_list_channels()
returns table(channel_id uuid, name text, description text, member_count bigint, last_message text, last_message_at timestamptz, unread_count bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_active_user() then raise exception 'An active account is required' using errcode = '42501'; end if;
  return query select channel.id, channel.name, channel.description,
    (select count(*) from public.chat_channel_members member where member.channel_id = channel.id),
    latest.body, coalesce(latest.created_at, channel.created_at),
    (select count(*) from public.chat_channel_messages unread where unread.channel_id = channel.id and unread.sender_id <> auth.uid() and unread.created_at > coalesce(read_state.last_read_at, '-infinity'::timestamptz))
  from public.chat_channels channel
  join public.chat_channel_members mine on mine.channel_id = channel.id and mine.user_id = auth.uid()
  left join public.chat_channel_read_states read_state on read_state.channel_id = channel.id and read_state.user_id = auth.uid()
  left join lateral (select message.body, message.created_at from public.chat_channel_messages message where message.channel_id = channel.id order by message.created_at desc, message.id desc limit 1) latest on true
  where channel.archived_at is null order by coalesce(latest.created_at, channel.created_at) desc, channel.id;
end;
$$;

create or replace function public.chat_list_channel_messages(target_channel_id uuid)
returns table(message_id uuid, channel_id uuid, sender_id uuid, sender_name text, body text, created_at timestamptz, attachments jsonb)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_active_user() or not exists (select 1 from public.chat_channel_members member where member.channel_id = target_channel_id and member.user_id = auth.uid()) then raise exception 'Channel access denied' using errcode = '42501'; end if;
  insert into public.chat_channel_read_states(channel_id, user_id, last_read_at) values(target_channel_id, auth.uid(), now())
  on conflict on constraint chat_channel_read_states_pkey do update set last_read_at = greatest(public.chat_channel_read_states.last_read_at, excluded.last_read_at);
  return query select recent.id, recent.channel_id, recent.sender_id, coalesce(nullif(btrim(sender.display_name), ''), sender.email, 'User'), recent.body, recent.created_at,
    coalesce((select jsonb_agg(jsonb_build_object('id', attachment.id, 'file_name', attachment.file_name, 'content_type', attachment.content_type, 'size_bytes', attachment.size_bytes, 'storage_path', attachment.storage_path, 'created_at', attachment.created_at) order by attachment.created_at) from public.chat_message_attachments attachment where attachment.channel_message_id = recent.id), '[]'::jsonb)
  from (select message.* from public.chat_channel_messages message where message.channel_id = target_channel_id order by message.created_at desc, message.id desc limit 200) recent
  join public.profiles sender on sender.id = recent.sender_id order by recent.created_at, recent.id;
end;
$$;

create or replace function public.chat_send_channel_message(target_channel_id uuid, p_client_message_id uuid, message_body text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare result_id uuid; existing_message public.chat_channel_messages%rowtype; clean_body text := btrim(coalesce(message_body, ''));
begin
  if not public.is_active_user() or not exists (select 1 from public.chat_channel_members member where member.channel_id = target_channel_id and member.user_id = auth.uid()) then raise exception 'Channel access denied' using errcode = '42501'; end if;
  if p_client_message_id is null or char_length(clean_body) not between 1 and 4000 then raise exception 'Messages must contain between 1 and 4000 characters' using errcode = '22023'; end if;
  insert into public.chat_channel_messages(channel_id, sender_id, client_message_id, body) values(target_channel_id, auth.uid(), p_client_message_id, clean_body) on conflict(sender_id, client_message_id) do nothing returning id into result_id;
  if result_id is null then select message.* into existing_message from public.chat_channel_messages message where message.sender_id = auth.uid() and message.client_message_id = p_client_message_id; if existing_message.channel_id <> target_channel_id or existing_message.body <> clean_body then raise exception 'That message retry does not match the original message' using errcode = '22023'; end if; return existing_message.id; end if;
  return result_id;
end;
$$;

create or replace function public.chat_add_attachment(p_direct_message_id uuid, p_channel_message_id uuid, p_storage_path text, p_file_name text, p_content_type text, p_size_bytes bigint)
returns uuid language plpgsql security definer set search_path = '' as $$
declare result_id uuid;
begin
  if not public.is_active_user() or (p_direct_message_id is null and p_channel_message_id is null) or (p_direct_message_id is not null and p_channel_message_id is not null) then raise exception 'Attachment parent is invalid' using errcode = '22023'; end if;
  if p_direct_message_id is not null and not exists (select 1 from public.chat_messages message join public.chat_conversations conversation on conversation.id = message.conversation_id where message.id = p_direct_message_id and message.sender_id = auth.uid() and auth.uid() in (conversation.user_one, conversation.user_two)) then raise exception 'Chat access denied' using errcode = '42501'; end if;
  if p_channel_message_id is not null and not exists (select 1 from public.chat_channel_messages message join public.chat_channel_members member on member.channel_id = message.channel_id and member.user_id = auth.uid() where message.id = p_channel_message_id and message.sender_id = auth.uid()) then raise exception 'Channel access denied' using errcode = '42501'; end if;
  insert into public.chat_message_attachments(direct_message_id, channel_message_id, storage_path, file_name, content_type, size_bytes, uploaded_by)
  values(p_direct_message_id, p_channel_message_id, p_storage_path, btrim(p_file_name), coalesce(nullif(p_content_type, ''), 'application/octet-stream'), p_size_bytes, auth.uid()) returning id into result_id;
  return result_id;
end;
$$;

drop function if exists public.chat_list_messages(uuid);
create function public.chat_list_messages(target_conversation_id uuid)
returns table(message_id uuid, conversation_id uuid, sender_id uuid, sender_name text, body text, created_at timestamptz, read_by_recipient boolean, attachments jsonb)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_active_user() or not exists (select 1 from public.chat_conversations conversation where conversation.id = target_conversation_id and auth.uid() in (conversation.user_one, conversation.user_two)) then raise exception 'Chat access denied' using errcode = '42501'; end if;
  insert into public.chat_read_states(conversation_id, user_id, last_read_at) values(target_conversation_id, auth.uid(), now()) on conflict on constraint chat_read_states_pkey do update set last_read_at = greatest(public.chat_read_states.last_read_at, excluded.last_read_at);
  return query select recent.id, recent.conversation_id, recent.sender_id, coalesce(nullif(btrim(sender.display_name), ''), sender.email, 'User'), recent.body, recent.created_at, coalesce(recipient_state.last_read_at >= recent.created_at, false), coalesce((select jsonb_agg(jsonb_build_object('id', attachment.id, 'file_name', attachment.file_name, 'content_type', attachment.content_type, 'size_bytes', attachment.size_bytes, 'storage_path', attachment.storage_path, 'created_at', attachment.created_at) order by attachment.created_at) from public.chat_message_attachments attachment where attachment.direct_message_id = recent.id), '[]'::jsonb)
  from (select message.* from public.chat_messages message where message.conversation_id = target_conversation_id order by message.created_at desc, message.id desc limit 200) recent
  join public.profiles sender on sender.id = recent.sender_id join public.chat_conversations conversation on conversation.id = recent.conversation_id left join public.chat_read_states recipient_state on recipient_state.conversation_id = recent.conversation_id and recipient_state.user_id = case when recent.sender_id = conversation.user_one then conversation.user_two else conversation.user_one end
  order by recent.created_at, recent.id;
end;
$$;

insert into storage.buckets(id, name, public) values('chat-attachments', 'chat-attachments', false) on conflict(id) do nothing;
create policy "chat members read attachments" on storage.objects for select to authenticated using (bucket_id = 'chat-attachments' and exists (select 1 from public.chat_message_attachments attachment where attachment.storage_path = name and (exists (select 1 from public.chat_messages message join public.chat_conversations conversation on conversation.id = message.conversation_id where message.id = attachment.direct_message_id and auth.uid() in (conversation.user_one, conversation.user_two)) or exists (select 1 from public.chat_channel_messages message join public.chat_channel_members member on member.channel_id = message.channel_id and member.user_id = auth.uid() where message.id = attachment.channel_message_id))));
create policy "chat senders upload attachments" on storage.objects for insert to authenticated with check (bucket_id = 'chat-attachments' and (storage.foldername(name))[1] = auth.uid()::text);

revoke all on function public.chat_create_channel(text, text) from public, anon;
revoke all on function public.chat_list_channels() from public, anon;
revoke all on function public.chat_list_channel_messages(uuid) from public, anon;
revoke all on function public.chat_send_channel_message(uuid, uuid, text) from public, anon;
revoke all on function public.chat_add_attachment(uuid, uuid, text, text, text, bigint) from public, anon;
revoke all on function public.chat_list_messages(uuid) from public, anon;
grant execute on function public.chat_create_channel(text, text) to authenticated;
grant execute on function public.chat_list_channels() to authenticated;
grant execute on function public.chat_list_channel_messages(uuid) to authenticated;
grant execute on function public.chat_send_channel_message(uuid, uuid, text) to authenticated;
grant execute on function public.chat_add_attachment(uuid, uuid, text, text, text, bigint) to authenticated;
grant execute on function public.chat_list_messages(uuid) to authenticated;

notify pgrst, 'reload schema';
