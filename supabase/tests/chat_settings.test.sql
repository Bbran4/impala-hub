begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,raw_user_meta_data) values
('10500000-0000-0000-0000-000000000001','chat-settings-admin@test.invalid','{}'),
('10500000-0000-0000-0000-000000000002','chat-settings-member@test.invalid','{}'),
('10500000-0000-0000-0000-000000000003','chat-settings-outsider@test.invalid','{}');
insert into public.profile_roles(profile_id,role_id) values('10500000-0000-0000-0000-000000000001','administrator');
insert into public.chat_channels(id,name,created_by) values('10500000-0000-0000-0001-000000000001','Permission tests','10500000-0000-0000-0000-000000000001');
insert into public.chat_channel_members(channel_id,user_id) values
('10500000-0000-0000-0001-000000000001','10500000-0000-0000-0000-000000000001'),
('10500000-0000-0000-0001-000000000001','10500000-0000-0000-0000-000000000002');
select ok(not has_table_privilege('authenticated','public.chat_user_settings','update'),'settings cannot be forged through direct writes');
select ok(not has_function_privilege('anon','public.chat_client_settings()','execute'),'anonymous callers cannot retrieve chat settings');
set local role authenticated;
set local request.jwt.claims='{"sub":"10500000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($sql$select public.admin_save_chat_user_settings('10500000-0000-0000-0000-000000000002','#AB1234','{"create_channels":false,"invite_users":false,"remove_members":false,"delete_channels":false}')$sql$,'administrator can save permissions and name colour together');
select throws_ok($sql$select public.admin_save_chat_user_settings('10500000-0000-0000-0000-000000000002','red','{"create_channels":true,"invite_users":true,"remove_members":true,"delete_channels":true}')$sql$,'22023',null,'invalid colours are rejected');
select throws_ok($sql$select public.admin_save_chat_user_settings('10500000-0000-0000-0000-000000000002','#123456','{"create_channels":"true"}')$sql$,'22023',null,'malformed permission objects are rejected');
select is((select count(*) from jsonb_array_elements(public.admin_chat_settings()) u where u->>'profile_id' like '10500000-%'),3::bigint,'administrator list includes every test profile');
set local request.jwt.claims='{"sub":"10500000-0000-0000-0000-000000000002","role":"authenticated"}';
select is(public.chat_client_settings()->'colors'->>'10500000-0000-0000-0000-000000000002','#ab1234','assigned colour is shared with chat clients');
select throws_ok($sql$select public.admin_chat_settings()$sql$,'42501',null,'employee cannot read administrative settings');
select throws_ok($sql$select public.admin_save_chat_user_settings(auth.uid(),'#123456','{"create_channels":true,"invite_users":true,"remove_members":true,"delete_channels":true}')$sql$,'42501',null,'employee cannot grant themselves permissions');
select throws_ok($sql$select public.chat_create_channel('Denied','')$sql$,'42501',null,'channel creation denial is enforced by the server');
select throws_ok($sql$select public.chat_add_channel_member('10500000-0000-0000-0001-000000000001','10500000-0000-0000-0000-000000000003')$sql$,'42501',null,'invitation denial is enforced by the server');
select throws_ok($sql$select public.chat_remove_channel_member('10500000-0000-0000-0001-000000000001','10500000-0000-0000-0000-000000000001')$sql$,'42501',null,'member removal denial is enforced by the server');
select throws_ok($sql$select public.chat_delete_channel('10500000-0000-0000-0001-000000000001')$sql$,'42501',null,'channel deletion denial is enforced by the server');
set local request.jwt.claims='{"sub":"10500000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($sql$select public.admin_save_chat_user_settings('10500000-0000-0000-0000-000000000002',null,'{"create_channels":true,"invite_users":true,"remove_members":true,"delete_channels":true}')$sql$,'administrator can grant actions and restore automatic colours');
select lives_ok($sql$select public.admin_save_chat_user_settings('10500000-0000-0000-0000-000000000003',null,'{"create_channels":true,"invite_users":true,"remove_members":true,"delete_channels":true}')$sql$,'outsider can have action permissions without channel membership');
set local request.jwt.claims='{"sub":"10500000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok($sql$select public.chat_add_channel_member('10500000-0000-0000-0001-000000000001',auth.uid())$sql$,'42501',null,'invite permission cannot bypass membership');
select throws_ok($sql$select public.chat_remove_channel_member('10500000-0000-0000-0001-000000000001','10500000-0000-0000-0000-000000000001')$sql$,'42501',null,'remove permission cannot bypass membership');
select throws_ok($sql$select public.chat_delete_channel('10500000-0000-0000-0001-000000000001')$sql$,'42501',null,'delete permission cannot bypass membership');
set local request.jwt.claims='{"sub":"10500000-0000-0000-0000-000000000002","role":"authenticated"}';
select lives_ok($sql$select public.chat_create_channel('Allowed','')$sql$,'granted users can create channels');
select lives_ok($sql$select public.chat_add_channel_member('10500000-0000-0000-0001-000000000001','10500000-0000-0000-0000-000000000003')$sql$,'granted members can invite other employees');
select lives_ok($sql$select public.chat_remove_channel_member('10500000-0000-0000-0001-000000000001','10500000-0000-0000-0000-000000000003')$sql$,'granted members can remove other members');
select throws_ok($sql$select public.chat_remove_channel_member('10500000-0000-0000-0001-000000000001',auth.uid())$sql$,'22023',null,'self-removal uses the existing Leave action');
select lives_ok($sql$select public.chat_delete_channel('10500000-0000-0000-0001-000000000001')$sql$,'granted members can delete joined channels');
set local request.jwt.claims='{"sub":"10500000-0000-0000-0000-000000000001","role":"authenticated"}';
select ok(public.chat_has_permission('delete_channels'),'administrator view retains chat management');
select public.set_my_normal_user_view(true);
select ok(not public.chat_has_permission('delete_channels'),'normal view uses employee chat permissions');
select throws_ok($sql$select public.admin_chat_settings()$sql$,'42501',null,'normal view cannot edit chat permissions');
select public.set_my_normal_user_view(false);
select * from finish();
rollback;
