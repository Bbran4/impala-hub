begin;

create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

-- Users: administrator, management, reporting, sales, inactive reporting user
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','46000000-0000-0000-0000-000000000001','authenticated','authenticated','bi-admin@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','46000000-0000-0000-0000-000000000002','authenticated','authenticated','bi-manager@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','46000000-0000-0000-0000-000000000003','authenticated','authenticated','bi-reporting@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','46000000-0000-0000-0000-000000000004','authenticated','authenticated','bi-sales@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','46000000-0000-0000-0000-000000000005','authenticated','authenticated','bi-inactive@test.invalid','',now(),'{}','{}',now(),now());
insert into public.profile_roles(profile_id,role_id) values
('46000000-0000-0000-0000-000000000001','administrator'),
('46000000-0000-0000-0000-000000000002','management'),
('46000000-0000-0000-0000-000000000003','reporting'),
('46000000-0000-0000-0000-000000000004','sales'),
('46000000-0000-0000-0000-000000000005','reporting');
update public.profiles set display_name='BI Admin' where id='46000000-0000-0000-0000-000000000001';
update public.profiles set active=false where id='46000000-0000-0000-0000-000000000005';

-- What the sync agent would have published and loaded
insert into bi.agents(name,sources,app_requests,last_seen_at) values ('erp-agent','{erp}','{"erp":["test_connection"]}',now());
insert into bi.load_groups(name,interval_minutes,managed_by) values ('sales',15,'erp-agent');
insert into bi.load_jobs(target_table,source_name,group_name,sql_query,definition_sha256,load_mode,key_columns,managed_by)
values ('invoices','erp','sales','SELECT 1 AS invoice_no',repeat('a',64),'upsert','{invoice_no}','erp-agent'),
       ('stock_items','erp',null,'SELECT 1 AS item_code',repeat('b',64),'full','{}','erp-agent');
update bi.load_jobs set interval_minutes=60 where target_table='stock_items';
insert into bi.data_tables(table_name,group_name,columns,row_count,last_loaded_at)
values ('invoices','sales','[{"name":"invoice_no","type":"bigint"}]',4000,now()),
       ('stock_items',null,'[{"name":"item_code","type":"text"}]',3,now());
create table bi_data.stock_items(item_code text);
insert into bi_data.stock_items values ('BRK-001');
insert into bi.sync_runs(batch_id,job_id,target_table,agent_name,trigger,status,row_count)
select gen_random_uuid(),id,target_table,'erp-agent','schedule','success',3 from bi.load_jobs where target_table='stock_items';

-- Structure and role
select has_schema('bi','bi schema exists');
select has_schema('bi_data','bi_data schema exists');
select is((select label from public.roles where id='reporting'),'Reporting','reporting role exists');
select has_role('bi_agent','sync agent role exists');
select ok(not (select rolsuper or rolcreaterole or rolcreatedb or rolbypassrls from pg_roles where rolname='bi_agent'),'sync agent has no elevated privileges');

-- Browsers have no direct access to bi or bi_data
select ok(not has_schema_privilege('authenticated','bi','usage'),'signed-in users have no access to the bi schema');
select ok(not has_schema_privilege('authenticated','bi_data','usage'),'signed-in users have no access to loaded data');
select ok(not has_schema_privilege('anon','bi','usage'),'signed-out users have no access to the bi schema');
select ok(not has_function_privilege('anon','public.bi_data_tables()','execute'),'signed-out users cannot list reporting data');
select ok(not has_function_privilege('anon','public.bi_request_reload(text,text,boolean)','execute'),'signed-out users cannot request reloads');
select ok(not has_function_privilege('authenticated','bi.require_admin()','execute'),'internal helpers are not callable from the app');

-- The sync agent can only touch bi / bi_data
select ok(not has_table_privilege('bi_agent','public.profiles','select'),'sync agent cannot read user profiles');
select ok(not has_schema_privilege('bi_agent','public','create'),'sync agent cannot create objects in public');
select ok(not has_table_privilege('bi_agent','bi.audit_log','update'),'sync agent cannot alter the audit log');

-- Workspace access
set local role authenticated;
set local request.jwt.claims='{"sub":"46000000-0000-0000-0000-000000000003","role":"authenticated"}';
select ok(public.can_access_workspace('reporting'),'reporting role opens the Reporting workspace');
select ok(not public.can_access_workspace('stock_control'),'reporting role does not open other workspaces');
select is((select count(*) from public.bi_data_tables()),2::bigint,'reporting users see the loaded table catalogue');
select is((select row_count from public.bi_data_tables() where table_name='invoices'),4000::bigint,'catalogue shows row counts');
select is((select interval_minutes from public.bi_data_tables() where table_name='invoices'),15,'grouped tables show the group schedule');
select throws_ok($sql$select public.bi_load_status()$sql$,'42501',null,'reporting users cannot open data loader status');
select throws_ok($sql$select public.bi_request_reload('table','invoices',false)$sql$,'42501',null,'reporting users cannot request reloads');
select throws_ok($sql$select * from public.bi_sync_runs()$sql$,'42501',null,'reporting users cannot read run history');
select throws_ok($sql$select * from public.bi_audit_log()$sql$,'42501',null,'reporting users cannot read the audit log');
select throws_ok($sql$select * from bi.load_jobs$sql$,'42501',null,'reporting users cannot read load jobs directly');
select throws_ok($sql$select * from bi_data.stock_items$sql$,'42501',null,'reporting users cannot read loaded data directly');
reset role;

set local role authenticated;
set local request.jwt.claims='{"sub":"46000000-0000-0000-0000-000000000002","role":"authenticated"}';
select ok(public.can_access_workspace('reporting'),'management opens the Reporting workspace');
select is((select count(*) from public.bi_data_tables()),2::bigint,'management sees the loaded table catalogue');
select throws_ok($sql$select public.bi_set_enabled('group','sales',false)$sql$,'42501',null,'management cannot pause loads');
reset role;

set local role authenticated;
set local request.jwt.claims='{"sub":"46000000-0000-0000-0000-000000000004","role":"authenticated"}';
select ok(not public.can_access_workspace('reporting'),'sales users do not open Reporting');
select throws_ok($sql$select * from public.bi_data_tables()$sql$,'42501',null,'sales users cannot list reporting data');
reset role;

set local role authenticated;
set local request.jwt.claims='{"sub":"46000000-0000-0000-0000-000000000005","role":"authenticated"}';
select ok(not public.can_access_workspace('reporting'),'inactive users lose Reporting access');
select throws_ok($sql$select * from public.bi_data_tables()$sql$,'42501',null,'inactive users cannot list reporting data');
reset role;

-- Administrators: status, controls, history, audit
set local role authenticated;
set local request.jwt.claims='{"sub":"46000000-0000-0000-0000-000000000001","role":"authenticated"}';
select is(jsonb_array_length(public.bi_load_status()->'jobs'),2,'administrator sees every load job');
select is(jsonb_array_length(public.bi_load_status()->'agents'),1,'administrator sees agent heartbeats');
select is((select (j->>'row_count')::bigint from jsonb_array_elements(public.bi_load_status()->'jobs') j where j->>'target_table'='invoices'),4000::bigint,'status includes loaded row counts');
select lives_ok($sql$select public.bi_request_reload('table','stock_items',false)$sql$,'administrator requests Reload now');
select lives_ok($sql$select public.bi_request_reload('group','sales',true)$sql$,'administrator requests Reload everything for a group');
select lives_ok($sql$select public.bi_set_enabled('group','sales',false)$sql$,'administrator pauses a group');
select lives_ok($sql$select public.bi_set_enabled('table','stock_items',false)$sql$,'administrator pauses a table');
select throws_ok($sql$select public.bi_request_reload('table','missing',false)$sql$,'P0002',null,'unknown tables are reported');
select throws_ok($sql$select public.bi_request_reload('schema','x',false)$sql$,'22023',null,'unknown kinds are rejected');
select is((select count(*) from public.bi_sync_runs(10,'stock_items')),1::bigint,'administrator reads run history for a table');
select is((select count(*) from public.bi_audit_log()),4::bigint,'every control action is audited');
select is((select actor from public.bi_audit_log() limit 1),'BI Admin','audit names the administrator');
select ok(set_config('bi_test.request_id',public.bi_test_connection('erp')::text,true) is not null,'administrator asks the agent to test a source');
select is(public.bi_agent_request(current_setting('bi_test.request_id')::uuid)->>'status','pending','administrator reads the request status');
select throws_ok($sql$update bi.load_jobs set sql_query='SELECT * FROM payroll'$sql$,'42501',null,'administrators cannot change load queries from the app');
select throws_ok($sql$insert into bi.agent_requests(kind,source_name,payload) values ('preview','erp','{"sql":"SELECT * FROM payroll"}')$sql$,'42501',null,'administrators cannot send arbitrary queries to the agent');
reset role;

select ok((select reload_requested from bi.load_jobs where target_table='stock_items'),'Reload now flag is set');
select ok((select full_reload_requested and not enabled from bi.load_groups where name='sales'),'group full reload requested and paused');
select is((select sql_query from bi.load_jobs where target_table='invoices'),'SELECT 1 AS invoice_no','load definitions are unchanged by app actions');

select * from finish();
rollback;
