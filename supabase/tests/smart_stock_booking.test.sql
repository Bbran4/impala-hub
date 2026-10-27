begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','15000000-0000-0000-0000-000000000001','authenticated','authenticated','booking-admin@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','15000000-0000-0000-0000-000000000002','authenticated','authenticated','booking-stock@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','15000000-0000-0000-0000-000000000003','authenticated','authenticated','booking-manager@test.invalid','',now(),'{}','{}',now(),now());
insert into public.profile_roles(profile_id,role_id) values
('15000000-0000-0000-0000-000000000001','administrator'),
('15000000-0000-0000-0000-000000000002','stock'),
('15000000-0000-0000-0000-000000000003','management');

select ok(not has_table_privilege('anon','public.stock_transfer_batches','select'),'signed-out users cannot read booking transfers');
select ok(not has_function_privilege('anon','public.create_stock_booking_transfer(uuid,uuid,uuid,text,jsonb)','execute'),'signed-out users cannot create booking transfers');

set local role authenticated;
set local request.jwt.claims='{"sub":"15000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($sql$select public.create_stock_import_batch('manual_csv','booking-test.csv',repeat('8',64))$sql$,'administrator creates the booking test snapshot');
select lives_ok($sql$select public.append_stock_booking_items((select id from public.stock_import_batches where source_checksum=repeat('8',64)),
  '[{"franchise":"generic","part_number":"BOOK-1","description":"Booking test","qoh_er":2,"max_er":5,"qoh_pta":3,"max_pta":5,"qoh_wh":10,"max_wh":20,"bin_er":"ER-1","bin_pta":"PT-1","bin_wh":"WH-1"}]'::jsonb)$sql$,'administrator stages booking rows');
select lives_ok($sql$select public.append_stock_reordering_items((select id from public.stock_import_batches where source_checksum=repeat('8',64)),
  '[{"franchise":"generic","part_number":"BOOK-1","description":"Booking test","qoh_er":2,"qoh_pta":3,"qoh_wh":10,"global_safety":20}]'::jsonb)$sql$,'administrator stages matching reordering rows');
select ok(public.validate_stock_import((select id from public.stock_import_batches where source_checksum=repeat('8',64))),'test snapshot validates');
select ok(public.activate_stock_import((select id from public.stock_import_batches where source_checksum=repeat('8',64))),'test snapshot activates');
reset role;

set local role authenticated;
set local request.jwt.claims='{"sub":"15000000-0000-0000-0000-000000000002","role":"authenticated"}';
select lives_ok(format($sql$select public.create_stock_booking_transfer(%L,%L,%L,'Move to East Rand',%L::jsonb)$sql$,
  (select id from public.stock_import_batches where status='active'),
  (select id from public.stock_locations where name='10'),
  (select id from public.stock_locations where name='ER'),
  jsonb_build_array(jsonb_build_object('stock_booking_item_id',(select id from public.stock_booking_items where part_number='BOOK-1'),'transfer_qty',4))::text
),'stock operators can persist a validated booking transfer');
select is((select item_count from public.stock_transfer_batches),1,'transfer stores its item count');
select is((select transfer_qty from public.stock_transfer_items),4,'transfer stores the requested quantity');
select is((select from_bin_location from public.stock_transfer_items),'WH-1','transfer snapshots the warehouse bin');
select is((select to_bin_location from public.stock_transfer_items),'ER-1','transfer snapshots the destination bin');
select throws_ok($sql$insert into public.stock_transfer_batches(import_batch_id,from_location_id,to_location_id,from_location,to_location,supply_branch,remarks,item_count,created_by) select id,(select id from public.stock_locations where name='10'),(select id from public.stock_locations where name='ER'),'10','ERBAKKIE','er','Bypass',1,auth.uid() from public.stock_import_batches where status='active'$sql$,'42501',null,'stock operators cannot bypass the RPC');
select throws_ok(format($sql$select public.create_stock_booking_transfer(%L,%L,%L,'Too much',%L::jsonb)$sql$,
  (select id from public.stock_import_batches where status='active'),(select id from public.stock_locations where name='10'),(select id from public.stock_locations where name='ER'),
  jsonb_build_array(jsonb_build_object('stock_booking_item_id',(select id from public.stock_booking_items where part_number='BOOK-1'),'transfer_qty',7))::text
),'P0001','One or more transfer rows are invalid, stale, or exceed remaining warehouse stock','earlier transfers reduce the remaining warehouse quantity');
reset role;

set local role authenticated;
set local request.jwt.claims='{"sub":"15000000-0000-0000-0000-000000000003","role":"authenticated"}';
select is((select count(*) from public.stock_transfer_batches),1::bigint,'management can read booking history');
select throws_ok(format($sql$select public.create_stock_booking_transfer(%L,%L,%L,'Blocked','[]'::jsonb)$sql$,
  (select id from public.stock_import_batches where status='active'),(select id from public.stock_locations where name='10'),(select id from public.stock_locations where name='ER')
),'42501','Stock operator access is required to create a booking transfer','management cannot create transfers');
reset role;

select is((select count(*) from public.stock_audit where entity_type='transfer_batch' and action='exported'),1::bigint,'booking transfer is audited once');
select * from finish();
rollback;

