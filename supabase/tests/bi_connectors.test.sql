begin;

create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

-- Users: administrator, reporting user
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','72000000-0000-0000-0000-000000000001','authenticated','authenticated','conn-admin@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','72000000-0000-0000-0000-000000000002','authenticated','authenticated','conn-reporting@test.invalid','',now(),'{}','{}',now(),now());
insert into public.profile_roles(profile_id,role_id) values
('72000000-0000-0000-0000-000000000001','administrator'),
('72000000-0000-0000-0000-000000000002','reporting');

-- An ERP table loaded by the agent, and an agent that allows some connectors
insert into bi.agents(name,sources,app_requests,last_seen_at,connector_options)
values ('erp-agent','{erp}','{}',now(),'{"hosts":["api.courier.test"],"folders":["budgets"],"secrets":{"COURIER_KEY":"api.courier.test"}}');
insert into bi.load_jobs(target_table,source_name,sql_query,definition_sha256,load_mode,managed_by)
values ('invoices','erp','SELECT 1 AS invoice_no',repeat('a',64),'full','erp-agent');
create table bi_data.invoices(invoice_no bigint);
create table bi_data.leftover(x int);

select has_table('bi','connectors','connectors table exists');
select ok(not has_table_privilege('authenticated','bi.connectors','select'),'browsers cannot read connectors directly');
select ok(not has_function_privilege('anon','public.bi_upload_rows(text,jsonb)','execute'),'signed-out users cannot upload');
select ok(has_table_privilege('bi_agent','bi.connectors','update'),'the agent can update connector status');
select ok(not has_table_privilege('bi_agent','bi.connectors','insert'),'but cannot create connectors');

-- reporting users cannot manage connectors
set local role authenticated;
set local request.jwt.claims='{"sub":"72000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok($$select public.bi_list_connectors()$$,'42501',null,'reporting users cannot list connectors');
select throws_ok($$select public.bi_upload_begin('budget','[{"name":"branch","type":"text"}]')$$,'42501',null,'or upload');
select throws_ok($$select public.bi_save_connector('{"name":"x","kind":"web","agent_name":"erp-agent","config":{"url":"https://api.courier.test/x"}}')$$,'42501',null,'or add web connectors');
reset role;

-- administrator: upload in chunks
set local role authenticated;
set local request.jwt.claims='{"sub":"72000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($$select public.bi_upload_begin('budget','[{"name":"branch","type":"text"},{"name":"month","type":"date"},{"name":"target","type":"numeric"},{"name":"units","type":"bigint"}]')$$,'an upload starts with typed columns');
select is(public.bi_upload_rows('budget','[{"branch":"Centurion","month":"2026-10-01","target":125000.5,"units":40},{"branch":"Pretoria","month":"2026-10-01","target":90000,"units":31}]'),2,'rows are sent in chunks');
select is(public.bi_upload_rows('budget','[{"branch":"Midrand","month":"2026-10-01","target":null,"units":null}]'),1,'empty values are allowed');
select throws_ok($$select public.bi_upload_rows('budget','[{"branch":"X","month":"not a date","target":1,"units":1}]')$$,'22023',null,'values must fit their column type');
select is(public.bi_upload_finish('budget','Budgets 2026','budget.xlsx'),3::bigint,'finishing moves the rows into the loaded data');
reset role;
select is((select count(*) from bi_data.budget),3::bigint,'the table is in bi_data');
select is((select sum(target) from bi_data.budget),215000.5::numeric,'with the right values');
select is((select description from bi.data_tables where table_name='budget'),'Budgets 2026','and is in the catalogue');
set local role authenticated;
set local request.jwt.claims='{"sub":"72000000-0000-0000-0000-000000000001","role":"authenticated"}';
select is((select source from public.bi_data_tables() where table_name='budget'),'upload','marked as an upload');
select is((select source from public.bi_data_tables() where table_name='invoices'),null,'(invoices has no catalogue row here)');
select is((public.bi_list_connectors()->'connectors'->0->>'last_row_count'),'3','the connector shows its row count');
reset role;
select ok(not has_table_privilege('authenticated','bi_data.budget','select'),'browsers cannot read the uploaded table directly');
set local role authenticated;
set local request.jwt.claims='{"sub":"72000000-0000-0000-0000-000000000001","role":"authenticated"}';

-- replacing an upload
select lives_ok($$select public.bi_upload_begin('budget','[{"name":"branch","type":"text"},{"name":"target","type":"numeric"}]')$$,'an upload can be replaced');
select lives_ok($$select public.bi_upload_rows('budget','[{"branch":"Centurion","target":1}]')$$,'with new rows');
select is(public.bi_upload_finish('budget','Budgets 2026','budget-v2.csv'),1::bigint,'replacing swaps the table');
select is(jsonb_array_length(public.bi_list_connectors()->'connectors'->0->'columns'),3,'with the new columns (plus _bi_loaded_at)');

-- names and columns are validated
select throws_ok($$select public.bi_upload_begin('invoices','[{"name":"a","type":"text"}]')$$,'23505',null,'an upload cannot replace an ERP table');
select throws_ok($$select public.bi_upload_begin('leftover','[{"name":"a","type":"text"}]')$$,'23505',null,'or another existing table');
select throws_ok($$select public.bi_upload_begin('Bad Name','[{"name":"a","type":"text"}]')$$,'22023',null,'table names are validated');
select throws_ok($$select public.bi_upload_begin('x2','[{"name":"a; drop table bi.apps","type":"text"}]')$$,'22023',null,'column names are validated');
select throws_ok($$select public.bi_upload_begin('x2','[{"name":"a","type":"text); drop table bi.apps; --"}]')$$,'22023',null,'column types come from a fixed list');
select throws_ok($$select public.bi_upload_rows('nothing_started','[]')$$,'P0002',null,'rows need a started upload');

-- web and folder connectors
select lives_ok($$select public.bi_save_connector('{"name":"deliveries","kind":"web","description":"Courier","agent_name":"erp-agent","interval_minutes":60,"config":{"url":"https://api.courier.test/v1/deliveries","format":"json","records_path":"data.items","headers":[{"name":"Authorization","value":"Bearer ${COURIER_KEY}"}]}}')$$,'a web connector is saved');
reset role;
select is((select reload_requested from bi.connectors where name='deliveries'),true,'and asked to load straight away');
select ok((select details from bi.audit_log where object_name='deliveries' order by id desc limit 1)::text not like '%COURIER_KEY%','header values are not written to the audit log');
set local role authenticated;
set local request.jwt.claims='{"sub":"72000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok($$select public.bi_save_connector('{"name":"d2","kind":"web","agent_name":"erp-agent","config":{"url":"file:///etc/passwd"}}')$$,'22023',null,'web addresses must be http(s)');
select throws_ok($$select public.bi_save_connector('{"name":"d3","kind":"web","agent_name":"erp-agent","config":{"url":"https://a.test","headers":[{"name":"X\r\nInjected","value":"1"}]}}')$$,'22023',null,'header names are validated');
select throws_ok($$select public.bi_save_connector('{"name":"d4","kind":"web","agent_name":"erp-agent","interval_minutes":1,"config":{"url":"https://a.test"}}')$$,'22023',null,'schedules are at least every 5 minutes');
select lives_ok($$select public.bi_save_connector('{"name":"targets","kind":"folder","agent_name":"erp-agent","config":{"folder":"budgets","pattern":"targets *.xlsx","sheet":"Sheet1","combine":"latest"}}')$$,'a folder connector is saved');
select throws_ok($$select public.bi_save_connector('{"name":"t2","kind":"folder","agent_name":"erp-agent","config":{"folder":"budgets","pattern":"../../secret.csv"}}')$$,'22023',null,'file patterns cannot leave the folder');
select throws_ok($$select public.bi_save_connector('{"name":"t3","kind":"folder","agent_name":"erp-agent","config":{"folder":"C:\\Windows","pattern":"*.csv"}}')$$,'22023',null,'folders are chosen by name, not path');
select throws_ok($$select public.bi_save_connector('{"name":"budget","kind":"web","agent_name":"erp-agent","config":{"url":"https://a.test"}}')$$,'23505',null,'a connector cannot take another kind''s name');
select throws_ok($$select public.bi_save_connector('{"name":"invoices","kind":"web","agent_name":"erp-agent","config":{"url":"https://a.test"}}')$$,'23505',null,'or an ERP table''s name');
select lives_ok($$select public.bi_reload_connector('targets')$$,'a reload can be requested');
select throws_ok($$select public.bi_reload_connector('budget')$$,'P0002',null,'but not for uploads');
select is(jsonb_array_length(public.bi_list_connectors()->'connectors'),3,'three connectors are listed');
select is((public.bi_list_connectors()->'agents'->0->'connector_options'->'folders'->>0),'budgets','with what each agent allows');

-- removing
select lives_ok($$select public.bi_delete_connector('budget', true)$$,'an upload connector is removed');
reset role;
select is((select count(*) from pg_catalog.pg_tables where schemaname='bi_data' and tablename='budget'),0::bigint,'with its table');
select is((select count(*) from bi.data_tables where table_name='budget'),0::bigint,'and catalogue entry');

select * from finish();
rollback;
