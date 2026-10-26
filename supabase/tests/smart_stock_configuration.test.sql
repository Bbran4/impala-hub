begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ('00000000-0000-0000-0000-000000000000','13000000-0000-0000-0000-000000000001','authenticated','authenticated','stock-config-admin@test.invalid','',now(),'{}','{"display_name":"Config Admin"}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','13000000-0000-0000-0000-000000000002','authenticated','authenticated','stock-config-user@test.invalid','',now(),'{}','{"display_name":"Stock User"}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','13000000-0000-0000-0000-000000000003','authenticated','authenticated','stock-config-manager@test.invalid','',now(),'{}','{"display_name":"Manager"}',now(),now());
insert into public.profile_roles (profile_id,role_id) values
  ('13000000-0000-0000-0000-000000000001','administrator'),
  ('13000000-0000-0000-0000-000000000002','stock'),
  ('13000000-0000-0000-0000-000000000003','management');

select ok(not has_function_privilege('anon','public.save_stock_location(uuid,text,text,text,text,text)','execute'), 'signed-out users cannot save locations');
select ok(not has_function_privilege('anon','public.save_stock_thresholds(numeric,numeric)','execute'), 'signed-out users cannot save thresholds');
select ok(not has_function_privilege('anon','public.create_stock_development_status(text)','execute'), 'signed-out users cannot create statuses');

set local role authenticated;
set local request.jwt.claims = '{"sub":"13000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($sql$
  select public.save_stock_location(null,'TESTWH','Test warehouse','TESTVAN','er','#AABBCC')
$sql$, 'administrator can create a stock location');
select is((select supply_branch from public.stock_locations where name='TESTWH'), 'er', 'location mapping is persisted');
select lives_ok($sql$
  select public.save_stock_location((select id from public.stock_locations where name='TESTWH'),'TESTWH','Updated warehouse','TESTVAN','pta','#112233')
$sql$, 'administrator can update a stock location');
select is((select description from public.stock_locations where name='TESTWH'), 'Updated warehouse', 'location update is persisted');
select lives_ok($sql$
  select public.set_stock_location_active((select id from public.stock_locations where name='TESTWH'),false)
$sql$, 'administrator can deactivate an extra location');
select lives_ok($sql$
  select public.set_stock_location_active((select id from public.stock_locations where name='ERBAKKIE'),false)
$sql$, 'administrator can reduce the active set to two locations');
select throws_ok($sql$
  select public.set_stock_location_active((select id from public.stock_locations where name='PTABAKKIE'),false)
$sql$, 'P0001', 'At least two active stock locations are required', 'database preserves at least two active locations');
select lives_ok($sql$
  select public.set_stock_location_active((select id from public.stock_locations where name='ERBAKKIE'),true)
$sql$, 'administrator can reactivate a location');
select lives_ok($sql$
  select public.delete_stock_location((select id from public.stock_locations where name='TESTWH'))
$sql$, 'administrator can delete an unused inactive location');
select is((select count(*) from public.stock_locations where name='TESTWH'), 0::bigint, 'deleted location is removed');

select lives_ok('select public.save_stock_thresholds(3.5,12)', 'administrator can save shared thresholds');
select is((select slow_max_avg_sales from public.stock_settings where singleton), 3.5000::numeric, 'slow threshold is shared in the database');
select throws_ok('select public.save_stock_thresholds(12,3.5)', '23514', null, 'database rejects overlapping threshold ranges');
select is((select ab_min_avg_sales from public.stock_settings where singleton), 12.0000::numeric, 'failed threshold save leaves the previous value intact');

select lives_ok($sql$select public.create_stock_development_status('Unused Test Status')$sql$, 'administrator can create a Development Status');
select lives_ok($sql$select public.delete_stock_development_status('Unused Test Status')$sql$, 'unused Development Status can be deleted');
select lives_ok($sql$select public.create_stock_development_status('Used Test Status')$sql$, 'administrator can create another Development Status');
select lives_ok($sql$
  select public.create_stock_parts_query('CFG-100','Configuration reference',1,null,'Used Test Status','In Progress','[]'::jsonb)
$sql$, 'administrator can create a query using the new status');
select throws_ok($sql$select public.delete_stock_development_status('Used Test Status')$sql$, 'P0001', 'This Development Status is used by an existing Parts Query. Deactivate it instead.', 'used Development Status cannot be deleted');
select lives_ok($sql$select public.set_stock_development_status_active('Used Test Status',false)$sql$, 'used Development Status can be deactivated');
select ok((select count(*) >= 9 from public.stock_audit where actor_user_id='13000000-0000-0000-0000-000000000001' and entity_type in ('location','settings','development_status')), 'configuration changes are audited');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"13000000-0000-0000-0000-000000000002","role":"authenticated"}';
select ok((select count(*) > 0 from public.stock_locations), 'stock users can read configuration');
select throws_ok($sql$select public.save_stock_thresholds(2,10)$sql$, '42501', 'Administrator access is required to change stock thresholds', 'stock users cannot change thresholds');
select throws_ok($sql$select public.create_stock_development_status('Blocked Stock Status')$sql$, '42501', 'Administrator access is required to change Development Statuses', 'stock users cannot create statuses');
select throws_ok($sql$update public.stock_locations set description='Bypass' where name='10 — Warehouse'$sql$, '42501', null, 'stock users cannot bypass configuration RPCs with direct writes');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"13000000-0000-0000-0000-000000000003","role":"authenticated"}';
select ok((select count(*) > 0 from public.stock_development_statuses), 'management can read configuration');
select throws_ok($sql$select public.save_stock_location(null,'BLOCKED','','','','#ffffff')$sql$, '42501', 'Administrator access is required to change stock locations', 'management cannot create locations');
select throws_ok($sql$select public.delete_stock_development_status('New')$sql$, '42501', 'Administrator access is required to delete Development Statuses', 'management cannot delete statuses');
reset role;

select * from finish();
rollback;
