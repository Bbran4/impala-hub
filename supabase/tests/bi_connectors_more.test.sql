begin;

create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-000000000001','authenticated','authenticated','more-admin@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-000000000002','authenticated','authenticated','more-builder@test.invalid','',now(),'{}','{}',now(),now());
insert into public.profile_roles(profile_id,role_id) values
('90000000-0000-0000-0000-000000000001','administrator'),
('90000000-0000-0000-0000-000000000002','report_builder');
insert into bi.agents(name,sources,app_requests,last_seen_at,connector_options)
values ('cloud-agent','{erp}','{}',now(),'{"hosts":[],"folders":[],"secrets":{},"sharepoint":{"finance":"/sites/Finance"},"microsoft":true,"google":"reports@x.iam.gserviceaccount.com"}');

-- builders cannot add connectors
set local role authenticated;
set local request.jwt.claims='{"sub":"90000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok($$select public.bi_save_connector('{"name":"budget","kind":"sharepoint","agent_name":"cloud-agent","config":{"location":"finance","path":"Budget 2026.xlsx"}}')$$,'42501',null,'only administrators add SharePoint connectors');
reset role;

set local role authenticated;
set local request.jwt.claims='{"sub":"90000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($$select public.bi_save_connector('{"name":"budget","kind":"sharepoint","agent_name":"cloud-agent","interval_minutes":60,"config":{"location":"finance","path":"2026/Budget 2026.xlsx","sheet":"Budget"}}')$$,'a SharePoint file is saved');
select lives_ok($$select public.bi_save_connector('{"name":"monthly_sales","kind":"sharepoint","agent_name":"cloud-agent","config":{"location":"finance","path":"Sales/sales *.csv","combine":"all"}}')$$,'a wildcard in the file name is allowed');
select throws_ok($$select public.bi_save_connector('{"name":"x1","kind":"sharepoint","agent_name":"cloud-agent","config":{"location":"finance","path":"../HR/pay.xlsx"}}')$$,'22023',null,'.. is refused');
select throws_ok($$select public.bi_save_connector('{"name":"x2","kind":"sharepoint","agent_name":"cloud-agent","config":{"location":"finance","path":"*/pay.xlsx"}}')$$,'22023',null,'wildcards only in the file name');
select throws_ok($$select public.bi_save_connector('{"name":"x3","kind":"sharepoint","agent_name":"cloud-agent","config":{"location":"finance","path":"report.docx"}}')$$,'22023',null,'only Excel and CSV files');
select throws_ok($$select public.bi_save_connector('{"name":"x4","kind":"sharepoint","agent_name":"cloud-agent","config":{"location":"Finance Site","path":"a.xlsx"}}')$$,'22023',null,'locations are names from config.toml');
select throws_ok($$select public.bi_save_connector('{"name":"x5","kind":"sharepoint","agent_name":"cloud-agent","config":{"location":"finance","path":"a\\b.xlsx"}}')$$,'22023',null,'backslashes are refused');

select lives_ok($$select public.bi_save_connector('{"name":"targets","kind":"gsheet","agent_name":"cloud-agent","config":{"spreadsheet_id":"1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789","sheet":"Targets","range":"A1:F500"}}')$$,'a Google Sheet tab is saved');
select lives_ok($$select public.bi_save_connector('{"name":"targets2","kind":"gsheet","agent_name":"cloud-agent","config":{"spreadsheet_id":"1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789","range":"A:F"}}')$$,'the first tab and a column range');
select throws_ok($$select public.bi_save_connector('{"name":"x6","kind":"gsheet","agent_name":"cloud-agent","config":{"spreadsheet_id":"https://evil/x"}}')$$,'22023',null,'the spreadsheet ID is checked');
select throws_ok($$select public.bi_save_connector('{"name":"x7","kind":"gsheet","agent_name":"cloud-agent","config":{"spreadsheet_id":"1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789","sheet":"A''!B"}}')$$,'22023',null,'tab names cannot break the range');
select throws_ok($$select public.bi_save_connector('{"name":"x8","kind":"gsheet","agent_name":"cloud-agent","config":{"spreadsheet_id":"1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789","range":"A1;DROP"}}')$$,'22023',null,'ranges are checked');
select throws_ok($$select public.bi_save_connector('{"name":"x9","kind":"ftp","agent_name":"cloud-agent","config":{}}')$$,'22023',null,'unknown kinds are refused');
select throws_ok($$select public.bi_save_connector('{"name":"targets","kind":"sharepoint","agent_name":"cloud-agent","config":{"location":"finance","path":"a.xlsx"}}')$$,null,null,'a connector cannot change kind');

select lives_ok($$select public.bi_reload_connector('targets')$$,'Reload works for Google Sheets');
reset role;
select is((select count(*)::int from bi.connectors where kind in ('sharepoint','gsheet') and reload_requested and agent_name='cloud-agent'),4,'new connectors wait for the agent');
select is((select count(*)::int from bi.audit_log where object_type='connector' and object_name in ('budget','targets')),3,'changes are audited');
select is((select (connector_options->>'google') from bi.agents where name='cloud-agent'),'reports@x.iam.gserviceaccount.com','the agent options carry the Google account');

select * from finish();
rollback;
