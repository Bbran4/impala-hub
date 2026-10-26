begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ('00000000-0000-0000-0000-000000000000','11000000-0000-0000-0000-000000000001','authenticated','authenticated','stock@test.invalid','',now(),'{}','{"display_name":"Stock Tester"}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','11000000-0000-0000-0000-000000000002','authenticated','authenticated','admin-stock@test.invalid','',now(),'{}','{"display_name":"Stock Admin"}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','11000000-0000-0000-0000-000000000003','authenticated','authenticated','manager-stock@test.invalid','',now(),'{}','{"display_name":"Stock Manager"}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','11000000-0000-0000-0000-000000000004','authenticated','authenticated','sales-stock@test.invalid','',now(),'{}','{"display_name":"Sales Tester"}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','11000000-0000-0000-0000-000000000005','authenticated','authenticated','inactive-stock@test.invalid','',now(),'{}','{"display_name":"Inactive Stock"}',now(),now());

insert into public.profile_roles (profile_id, role_id) values
  ('11000000-0000-0000-0000-000000000001','stock'),
  ('11000000-0000-0000-0000-000000000002','administrator'),
  ('11000000-0000-0000-0000-000000000003','management'),
  ('11000000-0000-0000-0000-000000000004','sales'),
  ('11000000-0000-0000-0000-000000000005','stock');
update public.profiles set active = false where id = '11000000-0000-0000-0000-000000000005';

select ok(has_table('public','stock_parts_queries'), 'Parts Query table exists');
select ok(has_table('public','stock_parts_query_suppliers'), 'supplier table exists');
select ok(has_table('public','stock_locations'), 'location table exists');
select ok(has_table('public','stock_settings'), 'shared settings table exists');
select ok(has_table('public','stock_import_batches'), 'import batch table exists');
select ok(has_table('public','stock_booking_items'), 'booking snapshot table exists');
select ok(has_table('public','stock_reordering_items'), 'reordering snapshot table exists');
select ok(has_table('public','stock_audit'), 'stock audit table exists');

select ok(not has_table_privilege('anon','public.stock_parts_queries','select'), 'signed-out users cannot read Parts Queries');
select ok(not has_table_privilege('anon','public.stock_locations','select'), 'signed-out users cannot read stock configuration');
select ok(not has_table_privilege('anon','public.stock_booking_items','select'), 'signed-out users cannot read stock snapshots');
select ok(not has_table_privilege('anon','public.stock_audit','select'), 'signed-out users cannot read audit history');
select ok(not has_function_privilege('anon','public.can_operate_stock_control()','execute'), 'signed-out users cannot call the stock operator helper');
select ok(not has_function_privilege('anon','public.can_administer_stock_control()','execute'), 'signed-out users cannot call the stock admin helper');

set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-0000-0000-000000000001","role":"authenticated"}';
select ok(public.can_access_workspace('stock_control'), 'stock role can access Smart Stock');
select ok(public.can_operate_stock_control(), 'stock role can perform operational work');
select ok(not public.can_administer_stock_control(), 'stock role cannot administer Smart Stock');
select is((select count(*) from public.stock_locations), 3::bigint, 'stock role can read seeded locations');
select is((select slow_max_avg_sales from public.stock_settings where singleton), 2::numeric, 'stock role reads shared thresholds');
select lives_ok($sql$
  insert into public.stock_parts_queries
    (id,part_number,description,qty,development_status,status,created_by,updated_by)
  values
    ('21000000-0000-0000-0000-000000000001','PART-100','Stock test part',3,'New','In Progress',
     '11000000-0000-0000-0000-000000000002','11000000-0000-0000-0000-000000000002')
$sql$, 'stock role can create a Parts Query');
select lives_ok($sql$
  insert into public.stock_parts_query_suppliers
    (id,query_id,supplier,qty,cost,msrp,notes,created_by,updated_by)
  values
    ('22000000-0000-0000-0000-000000000001','21000000-0000-0000-0000-000000000001',
     'Supplier A',3,300,450,'Test quote',
     '11000000-0000-0000-0000-000000000002','11000000-0000-0000-0000-000000000002')
$sql$, 'stock role can add a supplier quote');
select throws_ok($sql$
  insert into public.stock_import_batches (source_type,source_name,imported_by)
  values ('manual_csv','blocked.csv','11000000-0000-0000-0000-000000000001')
$sql$, '42501', null, 'stock role cannot create import batches');
select is((with changed as (
  update public.stock_settings set slow_max_avg_sales = 3 where singleton returning singleton
) select count(*) from changed), 0::bigint, 'stock role cannot change configuration');
select throws_ok($sql$
  insert into public.stock_audit (entity_type,entity_id,actor_user_id,action)
  values ('parts_query','spoofed','11000000-0000-0000-0000-000000000002','spoofed')
$sql$, '42501', null, 'stock users cannot forge audit events');
reset role;

select is((select created_by from public.stock_parts_queries where id = '21000000-0000-0000-0000-000000000001'),
  '11000000-0000-0000-0000-000000000001'::uuid, 'database attributes query creation to the caller');
select matches((select reference from public.stock_parts_queries where id = '21000000-0000-0000-0000-000000000001'),
  '^PQ-[0-9]{8}-[0-9]{6,}$', 'Parts Query receives a readable unique reference');
select is((select created_by from public.stock_parts_query_suppliers where id = '22000000-0000-0000-0000-000000000001'),
  '11000000-0000-0000-0000-000000000001'::uuid, 'database attributes supplier creation to the caller');
select is((select count(*) from public.stock_audit where parts_query_id = '21000000-0000-0000-0000-000000000001' and action = 'created'),
  1::bigint, 'query creation is audited automatically');
select is((select count(*) from public.stock_audit where parts_query_id = '21000000-0000-0000-0000-000000000001' and action = 'supplier_added'),
  1::bigint, 'supplier creation is audited automatically');

set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-0000-0000-000000000003","role":"authenticated"}';
select ok(public.can_access_workspace('stock_control'), 'management can access Smart Stock');
select ok(not public.can_operate_stock_control(), 'management is read-only');
select is((select count(*) from public.stock_parts_queries where deleted_at is null), 1::bigint, 'management can read Parts Queries');
select is((with changed as (
  update public.stock_parts_queries set description = 'Blocked manager edit'
  where id = '21000000-0000-0000-0000-000000000001' returning id
) select count(*) from changed), 0::bigint, 'management cannot edit Parts Queries');
select throws_ok($sql$
  insert into public.stock_parts_queries
    (part_number,description,qty,development_status,status,created_by,updated_by)
  values ('BLOCKED','Blocked',1,'New','In Progress',auth.uid(),auth.uid())
$sql$, '42501', null, 'management cannot create Parts Queries');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-0000-0000-000000000004","role":"authenticated"}';
select ok(not public.can_access_workspace('stock_control'), 'sales role cannot access Smart Stock');
select is((select count(*) from public.stock_parts_queries), 0::bigint, 'sales role cannot read Parts Queries');
select is((select count(*) from public.stock_locations), 0::bigint, 'sales role cannot read stock configuration');
select is((select count(*) from public.stock_audit), 0::bigint, 'sales role cannot read stock audit history');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-0000-0000-000000000005","role":"authenticated"}';
select ok(not public.can_access_workspace('stock_control'), 'inactive stock user cannot access Smart Stock');
select is((select count(*) from public.stock_parts_queries), 0::bigint, 'inactive stock user cannot read Parts Queries');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-0000-0000-000000000002","role":"authenticated"}';
select ok(public.can_administer_stock_control(), 'administrator can administer Smart Stock');
select lives_ok($sql$
  update public.stock_settings set slow_max_avg_sales = 3, ab_min_avg_sales = 12 where singleton
$sql$, 'administrator can update shared thresholds');
select lives_ok($sql$
  update public.stock_locations set description = 'Main warehouse' where name = '10'
$sql$, 'administrator can update locations');
select lives_ok($sql$
  update public.stock_locations set is_active = false where name = 'ER'
$sql$, 'administrator can deactivate a location while two remain active');
select throws_ok($sql$
  update public.stock_locations set is_active = false where name = 'PTA'
$sql$, 'P0001', 'At least two active stock locations are required', 'database preserves two active stock locations');
select lives_ok($sql$
  update public.stock_locations set is_active = true where name = 'ER'
$sql$, 'administrator can reactivate a location');
select lives_ok($sql$
  update public.stock_development_statuses set is_active = false where name = 'Rejected'
$sql$, 'administrator can deactivate an unused development status');
select lives_ok($sql$
  insert into public.stock_import_batches
    (id,source_type,source_name,source_checksum,status,imported_by)
  values
    ('23000000-0000-0000-0000-000000000001','manual_csv','stock-test.csv','test-checksum','staged',auth.uid())
$sql$, 'administrator can create a staged import');
select lives_ok($sql$
  insert into public.stock_booking_items
    (id,import_batch_id,franchise,part_number,description,qoh_er,max_er,qoh_pta,max_pta,qoh_wh,max_wh,bin_er,bin_pta,bin_wh)
  values
    ('24000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000001','generic','33215','Test part',4,10,2,10,25,30,'er14','pt14','s3-04-25')
$sql$, 'administrator can stage booking rows');
select lives_ok($sql$
  insert into public.stock_reordering_items
    (id,import_batch_id,franchise,part_number,description,qoh_er,qoh_pta,qoh_wh,global_safety,supplier_type)
  values
    ('25000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000001','generic','33215','Test part',10,15,25,100,'local')
$sql$, 'administrator can stage reordering rows');
select throws_ok($sql$
  update public.stock_import_batches set status = 'active'
  where id = '23000000-0000-0000-0000-000000000001'
$sql$, 'P0001', 'Invalid stock import status transition from staged to active', 'an import cannot bypass validation');
select lives_ok($sql$
  update public.stock_import_batches set status = 'validated'
  where id = '23000000-0000-0000-0000-000000000001'
$sql$, 'administrator can validate a staged import');
select lives_ok($sql$
  update public.stock_import_batches set status = 'active'
  where id = '23000000-0000-0000-0000-000000000001'
$sql$, 'administrator can activate a validated import');
select is((with changed as (
  update public.stock_booking_items set description = 'Blocked active edit'
  where id = '24000000-0000-0000-0000-000000000001' returning id
) select count(*) from changed), 0::bigint, 'active snapshot rows are immutable through browser access');
select throws_ok($sql$
  update public.stock_settings set slow_max_avg_sales = 20, ab_min_avg_sales = 10 where singleton
$sql$, '23514', null, 'threshold constraints reject overlapping classifications');
reset role;

select is((select imported_by from public.stock_import_batches where id = '23000000-0000-0000-0000-000000000001'),
  '11000000-0000-0000-0000-000000000002'::uuid, 'database attributes an import to the administrator');
select is((select activated_by from public.stock_import_batches where id = '23000000-0000-0000-0000-000000000001'),
  '11000000-0000-0000-0000-000000000002'::uuid, 'database attributes import activation to the administrator');
select is((select bin_wh from public.stock_booking_items where id = '24000000-0000-0000-0000-000000000001'),
  's3-04-25', 'booking snapshot preserves warehouse bins');
select is((select (qoh_er + qoh_pta + qoh_wh) / nullif(global_safety,0) * 100 from public.stock_reordering_items where id = '25000000-0000-0000-0000-000000000001'),
  50.0000000000000000::numeric, 'reordering snapshot reproduces the supply percentage example');
select is((select count(*) from public.stock_audit where entity_type = 'settings' and action = 'updated'),
  1::bigint, 'configuration changes are audited');
select is((select count(*) from public.stock_audit where entity_type = 'location' and action = 'updated'),
  3::bigint, 'location changes are audited');
select is((select count(*) from public.stock_audit where entity_type = 'import_batch' and action = 'created'),
  1::bigint, 'import creation is audited');

set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-0000-0000-000000000001","role":"authenticated"}';
select is((select count(*) from public.stock_booking_items), 1::bigint, 'stock role can read only the active booking snapshot');
select is((select count(*) from public.stock_reordering_items), 1::bigint, 'stock role can read only the active reordering snapshot');
select throws_ok($sql$
  insert into public.stock_parts_queries
    (part_number,description,qty,development_status,status,created_by,updated_by)
  values ('BLOCKED-STATUS','Blocked inactive status',1,'Rejected','In Progress',auth.uid(),auth.uid())
$sql$, 'P0001', 'Choose an active Development Status', 'stock role cannot assign an inactive development status');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($sql$
  update public.stock_parts_queries set deleted_at = now()
  where id = '21000000-0000-0000-0000-000000000001'
$sql$, 'stock role can archive a Parts Query');
select throws_ok($sql$
  update public.stock_parts_queries set description = 'Edit after archive'
  where id = '21000000-0000-0000-0000-000000000001'
$sql$, 'P0001', 'Archived Parts Queries cannot be edited', 'archived Parts Queries are immutable');
select throws_ok($sql$
  delete from public.stock_parts_queries where id = '21000000-0000-0000-0000-000000000001'
$sql$, '42501', null, 'browser users cannot physically delete Parts Queries');
reset role;

select is((select deleted_by from public.stock_parts_queries where id = '21000000-0000-0000-0000-000000000001'),
  '11000000-0000-0000-0000-000000000001'::uuid, 'archive stores the acting user');
select is((select count(*) from public.stock_audit where parts_query_id = '21000000-0000-0000-0000-000000000001' and action = 'archived'),
  1::bigint, 'Parts Query archival is audited');

select * from finish();
rollback;
