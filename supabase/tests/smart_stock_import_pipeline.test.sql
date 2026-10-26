begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ('00000000-0000-0000-0000-000000000000','14000000-0000-0000-0000-000000000001','authenticated','authenticated','import-admin@test.invalid','',now(),'{}','{"display_name":"Import Admin"}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','14000000-0000-0000-0000-000000000002','authenticated','authenticated','import-stock@test.invalid','',now(),'{}','{"display_name":"Import Stock"}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','14000000-0000-0000-0000-000000000003','authenticated','authenticated','import-manager@test.invalid','',now(),'{}','{"display_name":"Import Manager"}',now(),now());
insert into public.profile_roles (profile_id,role_id) values
  ('14000000-0000-0000-0000-000000000001','administrator'),
  ('14000000-0000-0000-0000-000000000002','stock'),
  ('14000000-0000-0000-0000-000000000003','management');

select ok(not has_function_privilege('anon','public.create_stock_import_batch(text,text,text)','execute'), 'signed-out users cannot create import batches');
select ok(not has_function_privilege('anon','public.append_stock_booking_items(uuid,jsonb)','execute'), 'signed-out users cannot upload stock rows');
select ok(not has_function_privilege('anon','public.activate_stock_import(uuid)','execute'), 'signed-out users cannot activate imports');

set local role authenticated;
set local request.jwt.claims = '{"sub":"14000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($sql$select public.create_stock_import_batch('manual_csv','first.csv',repeat('a',64))$sql$, 'administrator can create a staged batch');
select is(public.append_stock_booking_items(
  (select id from public.stock_import_batches where source_checksum=repeat('a',64)),
  '[{"id":"old-book","franchise":"generic","part_number":"PART-A","description":"First booking","qoh_er":2,"max_er":6,"qoh_pta":1,"max_pta":5,"qoh_wh":20,"max_wh":25,"bin_wh":"A-1"}]'::jsonb
), 1, 'booking rows are appended through the bounded RPC');
select is(public.append_stock_reordering_items(
  (select id from public.stock_import_batches where source_checksum=repeat('a',64)),
  '[{"id":"old-reorder","franchise":"generic","part_number":"PART-A","description":"First reorder","qoh_er":2,"qoh_pta":1,"qoh_wh":20,"global_safety":50,"supplier_type":"local"}]'::jsonb
), 1, 'reordering rows are appended through the bounded RPC');
select ok(public.validate_stock_import((select id from public.stock_import_batches where source_checksum=repeat('a',64))), 'valid staged rows pass validation');
select ok(public.activate_stock_import((select id from public.stock_import_batches where source_checksum=repeat('a',64))), 'validated batch becomes active');
select is((select status from public.stock_import_batches where source_checksum=repeat('a',64)), 'active', 'first snapshot is active');

select lives_ok($sql$select public.create_stock_import_batch('manual_xlsx','second.xlsx',repeat('b',64))$sql$, 'a second version can be staged while the first remains active');
select is(public.append_stock_booking_items(
  (select id from public.stock_import_batches where source_checksum=repeat('b',64)),
  '[{"franchise":"generic","part_number":"PART-B","description":"Second booking","qoh_er":3,"max_er":7,"qoh_pta":2,"max_pta":6,"qoh_wh":30,"max_wh":35,"bin_wh":"B-1"}]'::jsonb
), 1, 'second booking version is staged');
select is(public.append_stock_reordering_items(
  (select id from public.stock_import_batches where source_checksum=repeat('b',64)),
  '[{"franchise":"generic","part_number":"PART-B","description":"Second reorder","qoh_er":3,"qoh_pta":2,"qoh_wh":30,"global_safety":70,"supplier_type":"international"}]'::jsonb
), 1, 'second reordering version is staged');
select ok(public.validate_stock_import((select id from public.stock_import_batches where source_checksum=repeat('b',64))), 'second version validates');
select ok(public.activate_stock_import((select id from public.stock_import_batches where source_checksum=repeat('b',64))), 'second version activates atomically');
select is((select status from public.stock_import_batches where source_checksum=repeat('a',64)), 'superseded', 'previous snapshot is superseded');
select is((select status from public.stock_import_batches where source_checksum=repeat('b',64)), 'active', 'new snapshot is the sole active version');
select is((select count(*) from public.stock_import_batches where status='active'), 1::bigint, 'only one active snapshot exists');

select lives_ok($sql$select public.create_stock_import_batch('manual_csv','invalid.csv',repeat('c',64))$sql$, 'invalid source is retained as a batch');
select is(public.append_stock_booking_items(
  (select id from public.stock_import_batches where source_checksum=repeat('c',64)),
  '[{"part_number":"BROKEN","max_er":-1}]'::jsonb
), 0, 'invalid upload chunk is rolled back without partial rows');
select is((select count(*) from public.stock_booking_items i join public.stock_import_batches b on b.id=i.import_batch_id where b.source_checksum=repeat('c',64)), 0::bigint, 'failed chunk leaves no partial child rows');
select ok(not public.validate_stock_import((select id from public.stock_import_batches where source_checksum=repeat('c',64))), 'validation rejects a batch with upload errors');
select is((select status from public.stock_import_batches where source_checksum=repeat('c',64)), 'rejected', 'invalid batch retains terminal rejected state');
select ok((select jsonb_array_length(validation_errors)>0 from public.stock_import_batches where source_checksum=repeat('c',64)), 'validation messages are retained');
select throws_ok($sql$select public.activate_stock_import((select id from public.stock_import_batches where source_checksum=repeat('c',64)))$sql$, 'P0001', 'Only validated stock imports can be activated', 'rejected imports cannot activate');
select is((select status from public.stock_import_batches where source_checksum=repeat('b',64)), 'active', 'failed activation leaves the previous snapshot active');

select throws_ok($sql$select public.create_stock_import_batch('manual_csv','duplicate.csv',repeat('b',64))$sql$, 'P0001', 'This stock file has already been imported', 'duplicate checksums are rejected');
select lives_ok($sql$select public.create_stock_import_batch('qlik','cancelled job',repeat('d',64))$sql$, 'administrator can create a batch for manual rejection');
select ok(public.reject_stock_import((select id from public.stock_import_batches where source_checksum=repeat('d',64)),'Source extract was incomplete'), 'staged batch can be rejected with a reason');
select is((select status from public.stock_import_batches where source_checksum=repeat('d',64)), 'rejected', 'manual rejection is terminal');
select throws_ok($sql$insert into public.stock_import_batches(source_type,source_name,source_checksum,imported_by) values ('manual_csv','bypass.csv',repeat('f',64),auth.uid())$sql$, '42501', null, 'even administrators cannot bypass import RPCs');
select ok((select count(*) >= 9 from public.stock_audit where entity_type='import_batch' and actor_user_id='14000000-0000-0000-0000-000000000001'), 'batch creation and state changes are audited');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"14000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((select count(*) from public.stock_booking_items), 1::bigint, 'stock users see only the active booking snapshot');
select is((select part_number from public.stock_booking_items), 'PART-B', 'stock users receive the newly activated booking version');
select is((select count(*) from public.stock_reordering_items), 1::bigint, 'stock users see only the active reordering snapshot');
select throws_ok($sql$select public.create_stock_import_batch('manual_csv','blocked.csv',repeat('9',64))$sql$, '42501', 'Administrator access is required to import stock data', 'stock users cannot create imports');
select throws_ok($sql$select public.activate_stock_import((select id from public.stock_import_batches where status='active'))$sql$, '42501', 'Administrator access is required to activate stock imports', 'stock users cannot activate imports');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"14000000-0000-0000-0000-000000000003","role":"authenticated"}';
select is((select count(*) from public.stock_booking_items), 1::bigint, 'management sees only the active booking snapshot');
select throws_ok($sql$select public.reject_stock_import((select id from public.stock_import_batches where status='active'),'Blocked')$sql$, '42501', 'Administrator access is required to reject stock imports', 'management cannot control imports');
reset role;

select * from finish();
rollback;
