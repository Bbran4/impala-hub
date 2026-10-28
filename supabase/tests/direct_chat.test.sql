begin;

create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','53000000-0000-0000-0000-000000000001','authenticated','authenticated','alice.chat@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','53000000-0000-0000-0000-000000000002','authenticated','authenticated','brenda.chat@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','53000000-0000-0000-0000-000000000003','authenticated','authenticated','charles.chat@test.invalid','',now(),'{}','{}',now(),now());

update public.profiles set display_name='Alice Chat' where id='53000000-0000-0000-0000-000000000001';
update public.profiles set display_name='Brenda Chat' where id='53000000-0000-0000-0000-000000000002';
update public.profiles set display_name='Charles Chat' where id='53000000-0000-0000-0000-000000000003';

select ok(not has_table_privilege('authenticated','public.chat_messages','insert'),'browser users cannot forge chat messages');
select ok(not has_table_privilege('authenticated','public.chat_read_states','update'),'browser users cannot forge read state');
select ok(not has_function_privilege('anon','public.chat_search_users(text)','execute'),'signed-out users cannot search chat users');
select ok(not has_function_privilege('anon','public.chat_send_message(uuid,uuid,text)','execute'),'signed-out users cannot send messages');

set local role authenticated;
set local request.jwt.claims='{"sub":"53000000-0000-0000-0000-000000000001","role":"authenticated"}';

select ok(public.chat_presence_heartbeat() is not null,'active chat user records an online heartbeat');
select is((select count(*) from public.chat_search_users('@brenda')),1::bigint,'@name finds the active recipient');
select is((select email from public.chat_search_users('brenda.chat@test.invalid')),'brenda.chat@test.invalid','email lookup returns the requested user');
select throws_ok($sql$select public.chat_open_direct('53000000-0000-0000-0000-000000000001')$sql$,'22023',null,'self-chat is rejected');

create temporary table chat_test_ids(conversation_id uuid);
insert into chat_test_ids select public.chat_open_direct('53000000-0000-0000-0000-000000000002');
select is(
  public.chat_open_direct('53000000-0000-0000-0000-000000000002'),
  (select conversation_id from chat_test_ids),
  'opening the same person returns the existing direct chat'
);
create temporary table chat_test_messages(message_id uuid);
insert into chat_test_messages
select public.chat_send_message((select conversation_id from chat_test_ids),'53000000-0000-0000-0000-000000000099','Hello Brenda');
select is((select count(*) from chat_test_messages),1::bigint,'a participant can send a message');
select is(
  public.chat_send_message((select conversation_id from chat_test_ids),'53000000-0000-0000-0000-000000000099','Hello Brenda'),
  (select message_id from chat_test_messages),
  'repeating a client message id is idempotent'
);
reset role;

set local role authenticated;
set local request.jwt.claims='{"sub":"53000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((select unread_count from public.chat_list_conversations()),1::bigint,'offline recipient sees one unread message');
select is((select body from public.chat_list_messages((select conversation_id from chat_test_ids))),'Hello Brenda','recipient can read the message');
select lives_ok(format($sql$select public.chat_mark_read(%L)$sql$,(select conversation_id from chat_test_ids)),'recipient can mark the chat read');
select is((select unread_count from public.chat_list_conversations()),0::bigint,'marking read clears unread count');
select ok((select is_online from public.chat_search_users('alice.chat@test.invalid')),'recent heartbeat displays the other user as online');
reset role;

set local role authenticated;
set local request.jwt.claims='{"sub":"53000000-0000-0000-0000-000000000001","role":"authenticated"}';
select ok((select read_by_recipient from public.chat_list_messages((select conversation_id from chat_test_ids))),'sender sees that the recipient read the message');
reset role;

set local role authenticated;
set local request.jwt.claims='{"sub":"53000000-0000-0000-0000-000000000003","role":"authenticated"}';
select is((select count(*) from public.chat_list_conversations()),0::bigint,'unrelated user cannot discover the conversation');
select throws_ok(
  format($sql$select * from public.chat_list_messages(%L)$sql$,(select conversation_id from chat_test_ids)),
  '42501',null,'unrelated user cannot read messages'
);
reset role;

select is((select count(*) from public.chat_conversations),1::bigint,'one conversation exists for the pair');
select is((select count(*) from public.chat_messages),1::bigint,'idempotent retry did not duplicate the message');

select * from finish();
rollback;
