begin;

create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','16000000-0000-0000-0000-000000000001','authenticated','authenticated','reorder-admin@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','16000000-0000-0000-0000-000000000002','authenticated','authenticated','reorder-stock@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','16000000-0000-0000-0000-000000000003','authenticated','authenticated','reorder-manager@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','16000000-0000-0000-0000-000000000004','authenticated','authenticated','reorder-sales@test.invalid','',now(),'{}','{}',now(),now());
insert into public.profile_roles(profile_id,role_id) values
('16000000-0000-0000-0000-000000000001','administrator'),
('16000000-0000-0000-0000-000000000002','stock'),
('16000000-0000-0000-0000-000000000003','management'),
('16000000-0000-0000-0000-000000000004','salesperson');

select has_view('public','stock_reordering_workspace','shared Stock Reordering view exists');
select ok(not has_table_privilege('anon','public.stock_reordering_workspace','select'),'signed-out users cannot read Stock Reordering');

set local role authenticated;
set local request.jwt.claims='{"sub":"16000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($sql$select public.create_stock_import_batch('manual_csv','reordering-test.csv',repeat('7',64))$sql$,'administrator creates a reordering test snapshot');
select lives_ok($sql$select public.append_stock_booking_items((select id from public.stock_import_batches where source_checksum=repeat('7',64)),
  '[{"franchise":"generic","part_number":"SLOW-1","qoh_wh":25},{"franchise":"generic","part_number":"AB-1","qoh_wh":5}]'::jsonb)$sql$,'administrator stages matching booking rows');
select lives_ok($sql$select public.append_stock_reordering_items((select id from public.stock_import_batches where source_checksum=repeat('7',64)),
  '[{"franchise":"generic","part_number":"SLOW-1","description":"Slow item","qoh_er":10,"qoh_pta":15,"qoh_wh":25,"global_safety":100,"avg_sales":2,"supplier_type":"local"},{"franchise":"generic","part_number":"AB-1","description":"AB item","qoh_er":5,"qoh_pta":5,"qoh_wh":5,"global_safety":0,"avg_sales":10,"supplier_type":"international"}]'::jsonb)$sql$,'administrator stages Reordering rows');
select ok(public.validate_stock_import((select id from public.stock_import_batches where source_checksum=repeat('7',64))),'reordering snapshot validates');
select ok(public.activate_stock_import((select id from public.stock_import_batches where source_checksum=repeat('7',64))),'reordering snapshot activates');
select is((select supply_percentage from public.stock_reordering_workspace where part_number='SLOW-1'),50.0000000000000000::numeric,'supply percentage uses total QOH divided by global safety');
select is((select supply_percentage from public.stock_reordering_workspace where part_number='AB-1'),0::numeric,'zero global safety produces zero supply percentage');
select ok((select is_slow_mover from public.stock_reordering_workspace where part_number='SLOW-1'),'slow threshold includes its boundary');
select ok((select is_ab_mover from public.stock_reordering_workspace where part_number='AB-1'),'A&B threshold includes its boundary');
reset role;

set local role authenticated;
set local request.jwt.claims='{"sub":"16000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((select count(*) from public.stock_reordering_workspace),2::bigint,'stock operators see the active Reordering snapshot');
reset role;

set local role authenticated;
set local request.jwt.claims='{"sub":"16000000-0000-0000-0000-000000000003","role":"authenticated"}';
select is((select count(*) from public.stock_reordering_workspace),2::bigint,'management has read-only Reordering access');
select throws_ok($sql$update public.stock_reordering_items set qty_to_order=999$sql$,'42501',null,'management cannot alter Reordering rows');
reset role;

set local role authenticated;
set local request.jwt.claims='{"sub":"16000000-0000-0000-0000-000000000004","role":"authenticated"}';
select is((select count(*) from public.stock_reordering_workspace),0::bigint,'salespeople cannot read Stock Reordering');
reset role;

select * from finish();
rollback;

