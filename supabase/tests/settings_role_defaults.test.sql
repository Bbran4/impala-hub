begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,raw_user_meta_data) values
('10900000-0000-0000-0000-000000000001','settings-normal-admin@test.invalid','{}'),
('10900000-0000-0000-0000-000000000002','role-default-marketing@test.invalid','{}'),
('10900000-0000-0000-0000-000000000003','settings-normal-stock@test.invalid','{}'),
('10900000-0000-0000-0000-000000000004','settings-normal-inactive@test.invalid','{}');
insert into public.profile_roles(profile_id,role_id) values
('10900000-0000-0000-0000-000000000001','administrator'),
('10900000-0000-0000-0000-000000000002','marketing'),
('10900000-0000-0000-0000-000000000003','stock'),
('10900000-0000-0000-0000-000000000004','administrator');
update public.profiles set active=false where id='10900000-0000-0000-0000-000000000004';
-- Old automatically seeded rows must no longer counteract a denied role default.
insert into public.marketing_user_permissions(profile_id,permission_key) values
('10900000-0000-0000-0000-000000000002','feed.edit') on conflict do nothing;
select ok(not has_function_privilege('anon','public.can_manage_app_settings()','execute'),'anonymous callers cannot inspect settings authority');
select ok(not has_function_privilege('anon','public.admin_set_role_app_permission(text,text,text,boolean)','execute'),'anonymous callers cannot change role defaults');
select ok(not has_table_privilege('authenticated','public.application_role_permissions','update'),'role defaults remain protected from direct browser writes');
select ok(not has_table_privilege('authenticated','public.application_role_permission_audit','insert'),'permission audit cannot be forged');
set local role authenticated;
set local request.jwt.claims='{"sub":"10900000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.set_my_normal_user_view(true);
select ok(public.can_manage_app_settings(),'normal-view administrator retains settings authority');
select ok(not public.has_role('administrator'),'normal view still suppresses workspace administrator bypass');
select ok(not public.can_access_workspace('marketing'),'normal view does not grant unassigned Marketing access');
select ok(not public.can_administer_stock_control(),'normal view does not grant stock import authority');
select ok(not public.chat_has_permission('delete_channels'),'normal view does not grant chat management');
select ok(public.can_manage_marketing_accounts(),'connection settings remain available to real administrators');
select ok(public.can_view_marketing_connections(),'shared connection status remains available in settings');
select is((select inherited_access from public.admin_list_app_access('marketing') where profile_id=auth.uid()),false,'normal-view administrator is not marked as inherited app access');
select ok(public.admin_set_app_access(auth.uid(),'marketing',true),'normal-view administrator can enable an app for themselves');
select ok(public.can_access_workspace('marketing'),'self-granted app access takes effect');
select ok(public.admin_set_app_access(auth.uid(),'marketing',false),'normal-view administrator can disable their own app');
select ok(not public.can_access_workspace('marketing'),'disabled self app is inaccessible in normal view');
select ok(public.can_manage_app_settings(),'removing own app access cannot lock out settings');
select is((select count(*) from public.admin_app_access_audit where actor_user_id=auth.uid() and profile_id=auth.uid()),2::bigint,'self-service app changes are audited');
select lives_ok($sql$select public.admin_settings_identity()$sql$,'Sales Desk settings can load identity without workspace access');
select lives_ok($sql$select public.admin_sales_desk_configuration()$sql$,'Sales Desk settings can load configuration without workspace access');
select lives_ok($sql$select public.admin_stock_configuration()$sql$,'stock settings can load configuration without workspace access');
select lives_ok($sql$select public.save_stock_thresholds(3,11)$sql$,'stock configuration can be saved in normal view');
select lives_ok($sql$insert into public.sales_desk_media_platforms(name) values('Normal settings test')$sql$,'Sales Desk configuration can be saved in normal view');
select lives_ok($sql$select public.admin_chat_settings()$sql$,'chat settings remain available');
select lives_ok($sql$select public.save_sales_desk_milestones('[]','[]',0)$sql$,'milestones remain editable in settings');
select throws_ok($sql$select public.sales_desk_session_context()$sql$,'42501',null,'Sales Desk workspace access remains denied');
select throws_ok($sql$select public.admin_set_role_app_permission('unknown','marketing','feed.edit',true)$sql$,'P0002',null,'unknown roles are rejected');
select throws_ok($sql$select public.admin_set_role_app_permission('marketing','stock_control','feed.edit',true)$sql$,'22023',null,'permissions must belong to their app');
select throws_ok($sql$select public.admin_set_role_app_permission('marketing','marketing','feed.edit',null)$sql$,'22023',null,'role defaults cannot use user-only Inherit');
select ok(not public.admin_set_role_app_permission('marketing','marketing','feed.edit',false),'role default can be denied in normal view');
select is((select granted from public.admin_get_role_app_permissions('marketing','marketing') where permission_key='feed.edit'),false,'role editor reads the saved default');
select is((select count(*) from public.application_role_permission_audit where actor_user_id=auth.uid()),1::bigint,'role default change is audited');
set local request.jwt.claims='{"sub":"10900000-0000-0000-0000-000000000002","role":"authenticated"}';
select ok(not public.has_marketing_permission('feed.edit'),'role denial applies despite an old automatically seeded grant');
select throws_ok($sql$select public.admin_set_role_app_permission('marketing','marketing','feed.edit',true)$sql$,'42501',null,'employee cannot grant their role extra permissions');
select throws_ok($sql$select public.admin_stock_configuration()$sql$,'42501',null,'employee cannot use settings-only readers');
select throws_ok($sql$select public.admin_settings_identity()$sql$,'42501',null,'employee cannot impersonate a settings administrator');
set local request.jwt.claims='{"sub":"10900000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.admin_set_user_app_permission('10900000-0000-0000-0000-000000000002','marketing','feed.edit',true);
set local request.jwt.claims='{"sub":"10900000-0000-0000-0000-000000000002","role":"authenticated"}';
select ok(public.has_marketing_permission('feed.edit'),'explicit user Allow takes precedence over a denied role default');
set local request.jwt.claims='{"sub":"10900000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.admin_set_user_app_permission('10900000-0000-0000-0000-000000000002','marketing','feed.edit',false);
select ok(public.admin_set_role_app_permission('marketing','marketing','feed.edit',true),'role default can be restored');
set local request.jwt.claims='{"sub":"10900000-0000-0000-0000-000000000002","role":"authenticated"}';
select ok(not public.has_marketing_permission('feed.edit'),'explicit user Deny takes precedence over an allowed role default');
set local request.jwt.claims='{"sub":"10900000-0000-0000-0000-000000000004","role":"authenticated"}';
select ok(not public.can_manage_app_settings(),'inactive administrator has no settings authority');
select throws_ok($sql$select public.admin_list_permission_roles()$sql$,'42501',null,'inactive administrator cannot edit roles');
select * from finish();
rollback;
