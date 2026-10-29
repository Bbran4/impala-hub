-- Evaluate chat attachment membership without nested table RLS blocking storage signed URLs.
create or replace function public.chat_can_read_attachment(target_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_active_user() and exists (
    select 1 from public.chat_message_attachments attachment
    where attachment.storage_path = target_path
      and (
        exists (select 1 from public.chat_messages message join public.chat_conversations conversation on conversation.id = message.conversation_id where message.id = attachment.direct_message_id and auth.uid() in (conversation.user_one, conversation.user_two))
        or exists (select 1 from public.chat_channel_messages message join public.chat_channel_members member on member.channel_id = message.channel_id and member.user_id = auth.uid() where message.id = attachment.channel_message_id)
      )
  );
$$;

drop policy if exists "chat members read attachments" on storage.objects;
create policy "chat members read attachments" on storage.objects for select to authenticated
using (bucket_id = 'chat-attachments' and public.chat_can_read_attachment(name));

revoke all on function public.chat_can_read_attachment(text) from public, anon;
grant execute on function public.chat_can_read_attachment(text) to authenticated;
notify pgrst, 'reload schema';
