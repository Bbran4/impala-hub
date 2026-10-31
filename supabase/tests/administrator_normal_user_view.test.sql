begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(id,email,raw_user_meta_data) values
('10300000-0000-0000-0000-000000000001','normal-view-admin@test.invalid','{}'),
('10300000-0000-0000-0000-000000000002','normal-view-employee@test.invalid','{}'),
('10300000-0000-0000-0000-000000000003','normal-view-inactive@test.invalid','{}');
insert into public.profile_roles(profile_id,role_id) values
('10300000-0000-0000-0000-000000000001','administrator'),
('10300000-0000-0000-0000-000000000002','stock'),
('10300000-0000-0000-0000-000000000003','administrator');
update public.profiles set active=false where id='10300000-0000-0000-0000-000000000003';

-- A representative role-based data policy verifies that the switch affects
-- returned rows, rather than merely hiding administrator controls in the UI.
create table public.normal_view_test_rows(owner_id uuid);
insert into public.normal_view_test_rows values
('10300000-0000-0000-0000-000000000001'),('10300000-0000-0000-0000-000000000002');
alter table public.normal_view_test_rows enable row level security;
grant select on public.normal_view_test_rows to authenticated;
create policy normal_view_rows on public.normal_view_test_rows for select to authenticated
using(public.has_role('administrator') or owner_id=auth.uid());

select ok(not has_function_privilege('anon','public.set_my_normal_user_view(boolean)','execute'),'anonymous users cannot change viewing mode');
select ok(not has_function_privilege('anon','public.my_account_access()','execute'),'anonymous users cannot read account access');
select ok(not has_column_privilege('authenticated','public.profiles','normal_user_view','update'),'mode cannot be forged by direct profile updates');

set local role authenticated;
set local request.jwt.claims='{"sub":"10300000-0000-0000-0000-000000000001","role":"authenticated"}';
select ok(public.has_role('administrator'),'administrator bypass is on by default');
select ok(public.has_application_permission('marketing','posts.delete'),'administrator has implicit permissions before switching');
select is((select count(*) from public.normal_view_test_rows),2::bigint,'administrator sees all rows');
select ok(public.set_my_normal_user_view(true),'administrator can enable normal view');
select ok(not public.has_role('administrator'),'normal view suppresses the administrator role');
select ok((public.my_account_access()->>'is_administrator_account')::boolean,'stored administrator identity is preserved');
select ok((public.my_account_access()->>'normal_user_view')::boolean,'normal view preference is reported');
select is(public.my_account_access()->'roles','[]'::jsonb,'administrator-only account has no implicit employee roles');
select ok(not public.can_access_workspace('marketing'),'normal view needs an assigned workspace role');
select ok(not public.has_application_permission('marketing','posts.delete'),'normal view removes implicit application permissions');
select is((select count(*) from public.normal_view_test_rows),1::bigint,'normal view obeys data row policies');
select lives_ok($sql$select * from public.admin_list_app_access('marketing')$sql$,'normal view retains administrator settings access');
select ok(not public.set_my_normal_user_view(false),'administrator can restore access without admin permission');
select ok(public.has_role('administrator'),'administrator access is restored');
select is((select count(*) from public.normal_view_test_rows),2::bigint,'restoring administrator access restores row visibility');
select throws_ok($sql$select public.set_my_normal_user_view(null)$sql$,'22023',null,'null mode is rejected');

reset role;
insert into public.profile_roles(profile_id,role_id) values
('10300000-0000-0000-0000-000000000001','marketing'),
('10300000-0000-0000-0000-000000000001','stock');
insert into public.application_user_permission_overrides(profile_id,app_id,permission_key,enabled) values
('10300000-0000-0000-0000-000000000001','marketing','posts.view',false),
('10300000-0000-0000-0000-000000000001','marketing','posts.delete',true);
-- Even an administrator role default must not leak into normal view.
insert into public.application_role_permissions(role_id,app_id,permission_key) values
('administrator','stock_control','stock_control.delete') on conflict do nothing;
set local role authenticated;
select ok(public.set_my_normal_user_view(true),'administrator can re-enter normal view');
select ok(public.has_role('stock'),'assigned non-admin roles remain active');
select ok(public.can_access_workspace('stock_control'),'assigned workspace remains accessible');
select ok(not public.can_access_workspace('sales_desk'),'unassigned workspace remains inaccessible');
select ok(public.has_marketing_permission('feed.view'),'role-default permissions still apply');
select ok(not public.has_marketing_permission('posts.view'),'explicit per-user permission denial applies');
select ok(public.has_marketing_permission('posts.delete'),'explicit per-user permission grant applies');
select ok(not public.has_application_permission('stock_control','stock_control.delete'),'administrator role defaults are excluded in normal view');
select ok(not ('administrator'=any(array(select jsonb_array_elements_text(public.my_account_access()->'roles')))),'effective role list excludes administrator');
select ok(exists(select 1 from public.profile_roles where profile_id=auth.uid() and role_id='administrator'),'switching never removes the stored administrator role');
select ok(not public.set_my_normal_user_view(false),'administrator can leave normal view repeatedly');

set local request.jwt.claims='{"sub":"10300000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok($sql$select public.set_my_normal_user_view(true)$sql$,'42501',null,'employee cannot enable administrator viewing preferences');
select throws_ok($sql$select public.set_my_normal_user_view(false)$sql$,'42501',null,'employee cannot use restoration to become administrator');
select ok(not (public.my_account_access()->>'is_administrator_account')::boolean,'employee is not marked as an administrator account');
select ok(public.has_role('stock'),'employee roles remain unchanged');
set local request.jwt.claims='{"sub":"10300000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok($sql$select public.set_my_normal_user_view(false)$sql$,'42501',null,'inactive administrator cannot change viewing mode');
select ok(not public.has_role('administrator'),'inactive administrator has no bypass');
select is(public.my_account_access()->'roles','[]'::jsonb,'inactive account has no effective roles');
select * from finish();
rollback;
