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
  ('11000000-0000-0000-0000-000000000005','stock'),
  ('11000000-0000-0000-0000-000000000005','administrator');
update public.profiles set active = false where id = '11000000-0000-0000-0000-000000000005';

select has_table('public','stock_parts_queries', 'Parts Query table exists');
select has_table('public','stock_parts_query_suppliers', 'supplier table exists');
select has_table('public','stock_locations', 'location table exists');
select has_table('public','stock_settings', 'shared settings table exists');
select has_table('public','stock_import_batches', 'import batch table exists');
select has_table('public','stock_booking_items', 'booking snapshot table exists');
select has_table('public','stock_reordering_items', 'reordering snapshot table exists');
select has_table('public','stock_audit', 'stock audit table exists');
select has_table('public','stock_ingestion_sources', 'private ingestion source table exists');
select has_table('public','stock_ingestion_runs', 'ingestion run history table exists');

select ok(not has_table_privilege('anon','public.stock_parts_queries','select'), 'signed-out users cannot read Parts Queries');
select ok(not has_table_privilege('anon','public.stock_locations','select'), 'signed-out users cannot read stock configuration');
select ok(not has_table_privilege('anon','public.stock_booking_items','select'), 'signed-out users cannot read stock snapshots');
select ok(not has_table_privilege('anon','public.stock_audit','select'), 'signed-out users cannot read audit history');
select ok(not has_function_privilege('anon','public.can_operate_stock_control()','execute'), 'signed-out users cannot call the stock operator helper');
select ok(not has_function_privilege('anon','public.can_administer_stock_control()','execute'), 'signed-out users cannot call the stock admin helper');
select ok(not has_table_privilege('anon','public.stock_ingestion_sources','select'), 'signed-out users cannot read ingestion sources');
select ok(not has_function_privilege('authenticated','public.claim_stock_ingestion_run(uuid,text,uuid)','execute'), 'browser users cannot claim ingestion runs');
select ok(has_function_privilege('service_role','public.claim_stock_ingestion_run(uuid,text,uuid)','execute'), 'service role can claim ingestion runs');
select ok(not has_function_privilege('authenticated','public.service_validate_and_finish_stock_ingestion(uuid,uuid,uuid,text,integer,integer)','execute'),
  'browser users cannot finalize automated stock ingestion');

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
select throws_ok($sql$
  update public.stock_settings set slow_max_avg_sales = 3 where singleton
$sql$, '42501', null, 'stock role cannot change configuration');
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
  select public.save_stock_thresholds(3,12)
$sql$, 'administrator can update shared thresholds');
select lives_ok($sql$
  select public.save_stock_location((select id from public.stock_locations where name='10'),'10','Main warehouse','','','#dff7ff')
$sql$, 'administrator can update locations');
select lives_ok($sql$
  select public.set_stock_location_active((select id from public.stock_locations where name='ER'),false)
$sql$, 'administrator can deactivate a location while two remain active');
select throws_ok($sql$
  select public.set_stock_location_active((select id from public.stock_locations where name='PTA'),false)
$sql$, 'P0001', 'At least two active stock locations are required', 'database preserves two active stock locations');
select lives_ok($sql$
  select public.set_stock_location_active((select id from public.stock_locations where name='ER'),true)
$sql$, 'administrator can reactivate a location');
select lives_ok($sql$
  select public.set_stock_development_status_active('Rejected',false)
$sql$, 'administrator can deactivate an unused development status');
select lives_ok($sql$
  select public.create_stock_import_batch('manual_csv','stock-test.csv',repeat('e',64))
$sql$, 'administrator can create a staged import');
select lives_ok($sql$
  select public.append_stock_booking_items(
    (select id from public.stock_import_batches where source_checksum=repeat('e',64)),
    '[{"id":"legacy-booking","franchise":"generic","part_number":"33215","description":"Test part","qoh_er":4,"max_er":10,"qoh_pta":2,"max_pta":10,"qoh_wh":25,"max_wh":30,"bin_er":"er14","bin_pta":"pt14","bin_wh":"s3-04-25"}]'::jsonb)
$sql$, 'administrator can stage booking rows');
select lives_ok($sql$
  select public.append_stock_reordering_items(
    (select id from public.stock_import_batches where source_checksum=repeat('e',64)),
    '[{"id":"legacy-reordering","franchise":"generic","part_number":"33215","description":"Test part","qoh_er":10,"qoh_pta":15,"qoh_wh":25,"global_safety":100,"supplier_type":"local"}]'::jsonb)
$sql$, 'administrator can stage reordering rows');
select throws_ok($sql$
  update public.stock_import_batches set status = 'active'
  where source_checksum=repeat('e',64)
$sql$, '42501', null, 'an administrator cannot bypass the import RPCs');
select lives_ok($sql$
  select public.validate_stock_import((select id from public.stock_import_batches where source_checksum=repeat('e',64)))
$sql$, 'administrator can validate a staged import');
select lives_ok($sql$
  select public.activate_stock_import((select id from public.stock_import_batches where source_checksum=repeat('e',64)))
$sql$, 'administrator can activate a validated import');
select throws_ok($sql$
  update public.stock_booking_items set description = 'Blocked active edit'
  where part_number='33215'
$sql$, '42501', null, 'active snapshot rows are immutable through browser access');
select throws_ok($sql$
  select public.save_stock_thresholds(20,10)
$sql$, '23514', null, 'threshold constraints reject overlapping classifications');
reset role;

select is((select imported_by from public.stock_import_batches where source_checksum=repeat('e',64)),
  '11000000-0000-0000-0000-000000000002'::uuid, 'database attributes an import to the administrator');
select is((select activated_by from public.stock_import_batches where source_checksum=repeat('e',64)),
  '11000000-0000-0000-0000-000000000002'::uuid, 'database attributes import activation to the administrator');
select is((select bin_wh from public.stock_booking_items where part_number='33215'),
  's3-04-25', 'booking snapshot preserves warehouse bins');
select is((select (qoh_er + qoh_pta + qoh_wh) / nullif(global_safety,0) * 100 from public.stock_reordering_items where part_number='33215'),
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

set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-0000-0000-000000000002","role":"authenticated"}';
select lives_ok($sql$
  select public.save_stock_ingestion_source(
    null, 'google_sheets', 'Primary stock sheet',
    '{"spreadsheet_id":"1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789","booking_tab":"Stock Booking","reordering_tab":"Stock Reordering"}'::jsonb,
    true, true
  )
$sql$, 'administrator can save a non-secret Google Sheets source');
select is((select count(*) from public.stock_ingestion_sources), 1::bigint, 'administrator can read ingestion sources');
select is((select count(*) from public.stock_audit where entity_type='ingestion_source' and action='created'),
  1::bigint, 'ingestion source creation is audited without storing credentials');
select throws_ok($sql$
  select public.save_stock_ingestion_source(
    null, 'google_sheets', 'Leaky source',
    '{"spreadsheet_id":"1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789","booking_tab":"Booking","reordering_tab":"Reordering","api_key":"do-not-store"}'::jsonb,
    true, false
  )
$sql$, 'P0001', 'Google Sheets configuration contains unsupported fields', 'source configuration rejects secret-shaped extra fields');
select throws_ok($sql$
  select public.save_stock_ingestion_source(null, 'qlik', 'Future Qlik', '{}'::jsonb, true, false)
$sql$, 'P0001', 'This ingestion provider is reserved for a future implementation', 'future providers cannot be activated prematurely');
select throws_ok($sql$
  insert into public.stock_ingestion_sources(name,provider,is_active,configuration,configured_by)
  values ('Bypass','google_sheets',false,'{}','11000000-0000-0000-0000-000000000002')
$sql$, '42501', null, 'browser administrators cannot bypass the narrow source RPC');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11000000-0000-0000-0000-000000000001","role":"authenticated"}';
select is((select count(*) from public.stock_ingestion_sources), 0::bigint, 'non-admin stock users cannot read ingestion sources');
select is((select count(*) from public.stock_ingestion_runs), 0::bigint, 'non-admin stock users cannot read ingestion runs');
select throws_ok($sql$
  select public.save_stock_ingestion_source(null, 'google_sheets', 'Blocked',
    '{"spreadsheet_id":"1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789","booking_tab":"Booking","reordering_tab":"Reordering"}'::jsonb,
    false, false)
$sql$, '42501', 'Administrator access is required to change ingestion sources', 'non-admin users cannot save ingestion sources');
reset role;

set local role service_role;
select isnt(public.claim_stock_ingestion_run(
  (select id from public.stock_ingestion_sources where name='Primary stock sheet'),'scheduled',null
), null::uuid, 'service role claims a scheduled ingestion run');
select is(public.claim_stock_ingestion_run(
  (select id from public.stock_ingestion_sources where name='Primary stock sheet'),'scheduled',null
), null::uuid, 'a source cannot have concurrent ingestion runs');
select throws_ok(format(
  $sql$select public.service_create_stock_import_batch(%L,%L,'google_sheets','blocked actor',%L)$sql$,
  '11000000-0000-0000-0000-000000000001',
  (select id from public.stock_ingestion_runs where status='running'), repeat('1',64)
), '42501', 'An active administrator actor is required', 'service wrappers reject non-administrator actors');
select throws_ok(format(
  $sql$select public.service_create_stock_import_batch(%L,%L,'google_sheets','inactive actor',%L)$sql$,
  '11000000-0000-0000-0000-000000000005',
  (select id from public.stock_ingestion_runs where status='running'), repeat('2',64)
), '42501', 'An active administrator actor is required', 'service wrappers reject inactive administrators');
select lives_ok(format(
  $sql$select public.service_create_stock_import_batch(%L,%L,'google_sheets','Primary stock sheet',%L)$sql$,
  '11000000-0000-0000-0000-000000000002',
  (select id from public.stock_ingestion_runs where status='running'), repeat('f',64)
), 'service role creates a batch attributed to the verified administrator');
select is(public.service_create_stock_import_batch(
  '11000000-0000-0000-0000-000000000002',
  (select id from public.stock_ingestion_runs where status='running'),
  'google_sheets','Primary stock sheet',repeat('f',64)
), (select id from public.stock_import_batches where source_checksum=repeat('f',64)),
  'batch creation is idempotent when a committed response is retried');
select is((select count(*) from public.stock_import_batches where source_checksum=repeat('f',64)),
  1::bigint, 'idempotent creation retains one batch');
select is(auth.uid(), '11000000-0000-0000-0000-000000000001'::uuid,
  'service wrapper restores the caller auth uid after impersonation');
select is(public.service_append_stock_booking_items(
  '11000000-0000-0000-0000-000000000002',
  (select id from public.stock_import_batches where source_checksum=repeat('f',64)),
  '[{"franchise":"generic","part_number":"SCHEDULED-1","description":"Scheduled booking","qoh_wh":10,"max_wh":20}]'::jsonb
), 1, 'service wrapper preserves booking-row staging behavior');
select is(public.service_append_stock_reordering_items(
  '11000000-0000-0000-0000-000000000002',
  (select id from public.stock_import_batches where source_checksum=repeat('f',64)),
  '[{"franchise":"generic","part_number":"SCHEDULED-1","description":"Scheduled reorder","qoh_wh":10,"global_safety":20,"supplier_type":"local"}]'::jsonb
), 1, 'service wrapper preserves reordering-row staging behavior');
select ok(public.service_validate_and_finish_stock_ingestion(
  '11000000-0000-0000-0000-000000000002',
  (select id from public.stock_ingestion_runs where status='running'),
  (select id from public.stock_import_batches where source_checksum=repeat('f',64)),
  repeat('f',64), 1, 1
), 'stock validation and ingestion completion commit atomically');
select is((select status from public.stock_import_batches where source_checksum=repeat('f',64)),
  'validated', 'scheduled ingestion never auto-activates its validated batch');
select is((select imported_by from public.stock_import_batches where source_checksum=repeat('f',64)),
  '11000000-0000-0000-0000-000000000002'::uuid, 'service import audit attribution uses the verified administrator');
select is((select count(*) from public.stock_audit
  where entity_type='import_batch' and entity_id=(select id::text from public.stock_import_batches where source_checksum=repeat('f',64))
    and actor_user_id='11000000-0000-0000-0000-000000000002' and action='validated'),
  1::bigint, 'service validation preserves the existing administrator audit event');
select isnt(public.claim_stock_ingestion_run(
  (select id from public.stock_ingestion_sources where name='Primary stock sheet'),'scheduled',null
), null::uuid, 'source can be claimed again after its previous run finishes');
select ok(public.finish_stock_ingestion_run(
  (select id from public.stock_ingestion_runs where status='running'),
  'no_change',
  (select id from public.stock_import_batches where source_checksum=repeat('f',64)),
  repeat('f',64), 1, 1, ''
), 'an unchanged extract reuses the prior completed batch');
select is((select count(*) from public.stock_import_batches where source_checksum=repeat('f',64)),
  1::bigint, 'an unchanged extract does not duplicate the import batch');
select isnt(public.claim_stock_ingestion_run(
  (select id from public.stock_ingestion_sources where name='Primary stock sheet'),'scheduled',null
), null::uuid, 'source can be claimed after a no-change run');
select lives_ok(format(
  $sql$select public.service_create_stock_import_batch(%L,%L,'google_sheets','Interrupted stock sheet',%L)$sql$,
  '11000000-0000-0000-0000-000000000002',
  (select id from public.stock_ingestion_runs where status='running'), repeat('e',64)
), 'an interrupted run has a run-owned staged batch');
select ok(public.finish_stock_ingestion_run(
  (select id from public.stock_ingestion_runs where status='running'),
  'failed', null, null, 0, 0, E'token=top-secret\nupstream failed'
), 'failed ingestion run is finalized');
select is((select error_message from public.stock_ingestion_runs where status='failed'),
  'token=[redacted] upstream failed', 'stored ingestion errors redact credential-like values and control characters');
select is((select status from public.stock_import_batches where source_checksum=repeat('e',64)),
  'rejected', 'failing a run atomically rejects its partial batch');
select is((select import_batch_id from public.stock_ingestion_runs where status='failed'),
  (select id from public.stock_import_batches where source_checksum=repeat('e',64)),
  'failed run history retains its partial batch reference');
reset role;

select * from finish();
rollback;
