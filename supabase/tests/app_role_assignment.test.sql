begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,raw_user_meta_data) values
('12700000-0000-0000-0000-000000000001','app-role-admin@test.invalid','{}'),
('12700000-0000-0000-0000-000000000002','app-role-user@test.invalid','{}'),
('12700000-0000-0000-0000-000000000003','app-role-management@test.invalid','{}'),
('12700000-0000-0000-0000-000000000004','app-role-inactive@test.invalid','{}');
insert into public.profile_roles(profile_id,role_id) values
('12700000-0000-0000-0000-000000000001','administrator'),
('12700000-0000-0000-0000-000000000002','stock'),
('12700000-0000-0000-0000-000000000003','management');
update public.profiles set active=false where id='12700000-0000-0000-0000-000000000004';
create function pg_temp.fail_role_audit() returns trigger language plpgsql as $$
begin if current_setting('test.fail_role_audit',true)='on' then raise exception 'test role audit failure';end if;return new;end$$;
create trigger test_fail_role_audit before insert on public.admin_app_access_audit for each row execute function pg_temp.fail_role_audit();
set local role authenticated;
set local request.jwt.claims='{"sub":"12700000-0000-0000-0000-000000000001","role":"authenticated"}';
select is(jsonb_array_length(public.admin_app_role_settings('sales_desk')->'roles'),2,'Sales Desk exposes exactly Sales and Sales Manager roles');
select ok((public.admin_app_role_settings('sales_desk')->'roles') @> '[{"id":"sales"},{"id":"sales_manager"}]'::jsonb,'both sales roles are selectable');
select is(jsonb_array_length(public.admin_app_role_settings('stock_control')->'roles'),1,'Stock exposes its own app role');
select ok(not exists(select 1 from jsonb_array_elements(public.admin_app_role_settings('sales_desk')->'users') u where u->>'profile_id'='12700000-0000-0000-0000-000000000004'),'inactive users are excluded');
select is(public.admin_set_app_role('12700000-0000-0000-0000-000000000002','sales_desk','sales'),true,'administrator grants consultant access');
select is((select u->>'assigned_role' from jsonb_array_elements(public.admin_app_role_settings('sales_desk')->'users')u where u->>'profile_id'='12700000-0000-0000-0000-000000000002'),'sales','list reflects the assigned app role');
select is(public.admin_set_app_role('12700000-0000-0000-0000-000000000002','sales_desk','sales_manager'),true,'administrator promotes a consultant to Sales Manager');
reset role;
select is((select count(*) from public.profile_roles where profile_id='12700000-0000-0000-0000-000000000002' and role_id='sales'),0::bigint,'promotion replaces the old app role');
select is((select count(*) from public.profile_roles where profile_id='12700000-0000-0000-0000-000000000002' and role_id='stock'),1::bigint,'changing a sales role retains other app roles');
set local role authenticated;
select is(public.admin_set_app_role('12700000-0000-0000-0000-000000000002','sales_desk','sales_manager'),false,'saving the same role is idempotent');
select throws_ok($$select public.admin_set_app_role('12700000-0000-0000-0000-000000000002','sales_desk','administrator')$$,'22023',null,'app settings cannot grant platform Administrator');
select throws_ok($$select public.admin_set_app_role('12700000-0000-0000-0000-000000000002','stock_control','sales_manager')$$,'22023',null,'roles cannot be assigned to a different app');
select throws_ok($$select public.admin_set_app_role('12700000-0000-0000-0000-000000000004','sales_desk','sales')$$,'P0002',null,'inactive employees cannot receive app roles');
select throws_ok($$select public.admin_app_role_settings('unknown')$$,'22023',null,'unknown apps are rejected');
select public.admin_set_app_role('12700000-0000-0000-0000-000000000003','sales_desk','sales_manager');
set local request.jwt.claims='{"sub":"12700000-0000-0000-0000-000000000003","role":"authenticated"}';
select is(public.sales_desk_session_context()->>'role','manager','Management accounts use the explicitly selected Sales Manager role');
select throws_ok($$select public.admin_set_app_role('12700000-0000-0000-0000-000000000002','sales_desk','sales')$$,'42501',null,'Sales Managers cannot change app-role assignments');
set local request.jwt.claims='{"sub":"12700000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.admin_set_app_role('12700000-0000-0000-0000-000000000003','sales_desk','sales');
set local request.jwt.claims='{"sub":"12700000-0000-0000-0000-000000000003","role":"authenticated"}';
select is(public.sales_desk_session_context()->>'role','salesperson','Management accounts can choose a consultant role for Sales Desk');
set local request.jwt.claims='{"sub":"12700000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.admin_set_app_role('12700000-0000-0000-0000-000000000003','sales_desk',null);
reset role;
select ok(exists(select 1 from public.profile_roles where profile_id='12700000-0000-0000-0000-000000000003' and role_id='management'),'removing a direct app role retains inherited Management access');
set local role authenticated;
select public.set_my_normal_user_view(true);
select lives_ok($$select public.admin_set_app_role('12700000-0000-0000-0000-000000000001','sales_desk','sales')$$,'normal-view administrators can set their own app role');
select ok(exists(select 1 from public.profile_roles where profile_id=auth.uid() and role_id='administrator'),'self-service app roles never remove Administrator recovery access');
set local test.fail_role_audit='on';
select throws_ok($$select public.admin_set_app_role('12700000-0000-0000-0000-000000000002','sales_desk','sales')$$,'P0001',null,'role audit failure rolls back the grant and revoke');
set local test.fail_role_audit='off';
reset role;
select ok(exists(select 1 from public.profile_roles where profile_id='12700000-0000-0000-0000-000000000002' and role_id='sales_manager'),'failed audited change preserves the original role');
set local role authenticated;
select public.admin_set_app_role('12700000-0000-0000-0000-000000000002','sales_desk',null);
select is((select u->>'assigned_role' from jsonb_array_elements(public.admin_app_role_settings('sales_desk')->'users')u where u->>'profile_id'='12700000-0000-0000-0000-000000000002'),null::text,'no app role is reported after removal');
select is((select (u->>'can_open')::boolean from jsonb_array_elements(public.admin_app_role_settings('sales_desk')->'users')u where u->>'profile_id'='12700000-0000-0000-0000-000000000002'),false,'removing the only Sales Desk role removes access');
reset role;
select is((select count(*) from public.admin_app_access_audit where profile_id='12700000-0000-0000-0000-000000000002'),4::bigint,'role transitions are audited without duplicate no-op events');
set local role authenticated;
set local request.jwt.claims='{"sub":"12700000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok($$select public.admin_app_role_settings('sales_desk')$$,'42501',null,'ordinary users cannot list protected app-role settings');
select ok(not has_function_privilege('anon','public.admin_set_app_role(uuid,text,text)','execute'),'anonymous role assignment is denied');
select * from finish();
rollback;
