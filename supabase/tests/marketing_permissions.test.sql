begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,raw_user_meta_data) values
('11200000-0000-0000-0000-000000000001','permission-admin@test.invalid','{}'),
('11200000-0000-0000-0000-000000000002','permission-reader@test.invalid','{}'),
('11200000-0000-0000-0000-000000000003','permission-editor@test.invalid','{}'),
('11200000-0000-0000-0000-000000000004','permission-assigner@test.invalid','{}'),
('11200000-0000-0000-0000-000000000005','permission-outsider@test.invalid','{}'),
('11200000-0000-0000-0000-000000000006','permission-inactive@test.invalid','{}');
insert into public.profile_roles(profile_id,role_id) values
('11200000-0000-0000-0000-000000000001','administrator'),
('11200000-0000-0000-0000-000000000002','marketing'),
('11200000-0000-0000-0000-000000000003','marketing'),
('11200000-0000-0000-0000-000000000004','marketing'),
('11200000-0000-0000-0000-000000000005','sales'),
('11200000-0000-0000-0000-000000000006','marketing');
update public.profiles set active=false where id='11200000-0000-0000-0000-000000000006';
insert into public.application_user_permission_overrides(profile_id,app_id,permission_key,enabled)
select p.id,c.app_id,c.permission_key,false from public.profiles p cross join public.application_permission_catalog c
where p.id in('11200000-0000-0000-0000-000000000002','11200000-0000-0000-0000-000000000003','11200000-0000-0000-0000-000000000004') and c.app_id='marketing';
update public.application_user_permission_overrides set enabled=true where profile_id in
('11200000-0000-0000-0000-000000000002','11200000-0000-0000-0000-000000000003','11200000-0000-0000-0000-000000000004') and permission_key='posts.view';
update public.application_user_permission_overrides set enabled=true where profile_id='11200000-0000-0000-0000-000000000003' and permission_key='posts.edit';
update public.application_user_permission_overrides set enabled=true where profile_id='11200000-0000-0000-0000-000000000004' and permission_key='posts.assign_campaign';
insert into public.campaigns(id,name) values
('11200000-0000-0000-0001-000000000001','Restricted campaign A'),('11200000-0000-0000-0001-000000000002','Restricted campaign B');
insert into public.posts(id,title,created_by,status,campaign_id) values
('11200000-0000-0000-0002-000000000001','Permission draft','11200000-0000-0000-0000-000000000001','draft','11200000-0000-0000-0001-000000000001'),
('11200000-0000-0000-0002-000000000002','Permission published','11200000-0000-0000-0000-000000000001','published','11200000-0000-0000-0001-000000000001');
-- Deliberately grant SELECT during the transaction so anonymous RLS is tested
-- independently of table ACLs. Rollback restores the original grants.
grant select on public.posts,public.campaigns to anon;
select ok(not has_function_privilege('authenticated','public.sync_facebook_post(jsonb,uuid)','execute'),'browser cannot call trusted Facebook sync');
select ok(not has_function_privilege('anon','public.save_marketing_post(uuid,jsonb)','execute'),'anonymous users cannot save posts');
set local role authenticated;
set local request.jwt.claims='{"sub":"11200000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((select count(*) from public.posts where id::text like '11200000-%'),2::bigint,'post-view permission allows reading posts');
select is((select count(*) from public.campaigns where id::text like '11200000-%'),0::bigint,'post-view permission does not reveal campaign records');
select throws_ok($sql$select public.save_marketing_post('11200000-0000-0000-0002-000000000001','{"caption":"forged"}')$sql$,'42501',null,'read-only user cannot edit through the save RPC');
with changed as(update public.posts set caption='forged' where id='11200000-0000-0000-0002-000000000001' returning 1)
select is(count(*),0::bigint,'read-only user cannot bypass RPC with a direct edit') from changed;
with removed as(delete from public.posts where id='11200000-0000-0000-0002-000000000001' returning 1)
select is(count(*),0::bigint,'read-only user cannot delete posts') from removed;
select throws_ok($sql$insert into public.campaigns(name) values('Forged campaign')$sql$,'42501',null,'read-only user cannot create campaigns');
set local request.jwt.claims='{"sub":"11200000-0000-0000-0000-000000000003","role":"authenticated"}';
select lives_ok($sql$select public.save_marketing_post('11200000-0000-0000-0002-000000000001','{"caption":"Allowed draft edit"}')$sql$,'editor can update draft content');
select throws_ok($sql$update public.posts set status='published' where id='11200000-0000-0000-0002-000000000001'$sql$,'42501',null,'editor cannot forge publication status');
select throws_ok($sql$update public.posts set provider_ids='{"facebook":"forged"}' where id='11200000-0000-0000-0002-000000000001'$sql$,'42501',null,'editor cannot forge provider IDs');
select throws_ok($sql$update public.posts set likes=99999 where id='11200000-0000-0000-0002-000000000001'$sql$,'42501',null,'editor cannot forge metrics');
select throws_ok($sql$select public.save_marketing_post('11200000-0000-0000-0002-000000000002','{"caption":"Locked edit"}')$sql$,'42501',null,'published post content remains locked');
select throws_ok($sql$select public.save_marketing_post('11200000-0000-0000-0002-000000000001','{"campaign_id":"11200000-0000-0000-0001-000000000002"}')$sql$,'42501',null,'edit permission does not imply campaign assignment');
select throws_ok($sql$select public.sync_facebook_post('{}',auth.uid())$sql$,'42501',null,'editor cannot invoke the trusted sync function');
set local request.jwt.claims='{"sub":"11200000-0000-0000-0000-000000000004","role":"authenticated"}';
select lives_ok($sql$select public.save_marketing_post('11200000-0000-0000-0002-000000000002','{"campaign_id":"11200000-0000-0000-0001-000000000002"}')$sql$,'assignment-only user can assign a campaign on a locked post');
select throws_ok($sql$select public.save_marketing_post('11200000-0000-0000-0002-000000000001','{"caption":"Not an editor"}')$sql$,'42501',null,'assignment permission does not imply content editing');
set local request.jwt.claims='{"sub":"11200000-0000-0000-0000-000000000005","role":"authenticated"}';
select is((select count(*) from public.posts where id::text like '11200000-%'),0::bigint,'unrelated workspace user sees no posts');
select is((select count(*) from public.campaigns where id::text like '11200000-%'),0::bigint,'unrelated workspace user sees no campaigns');
select throws_ok($sql$select public.marketing_post_page()$sql$,'42501',null,'unrelated workspace user cannot bypass RLS with page RPC');
set local request.jwt.claims='{"sub":"11200000-0000-0000-0000-000000000006","role":"authenticated"}';
select is((select count(*) from public.posts where id::text like '11200000-%'),0::bigint,'inactive marketing user sees no posts');
select ok(not public.has_marketing_permission('posts.edit'),'inactive marketing role grants no edit permission');
set local role anon;
set local request.jwt.claims='{"role":"anon"}';
select is((select count(*) from public.posts where id::text like '11200000-%'),0::bigint,'anonymous RLS denies post reads');
select is((select count(*) from public.campaigns where id::text like '11200000-%'),0::bigint,'anonymous RLS denies campaign reads');
reset role;
select * from finish();
rollback;
