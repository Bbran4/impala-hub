begin;

create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','91000000-0000-0000-0000-000000000001','authenticated','authenticated','hub-admin@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','91000000-0000-0000-0000-000000000002','authenticated','authenticated','hub-builder@test.invalid','',now(),'{}','{}',now(),now());
insert into public.profile_roles(profile_id,role_id) values
('91000000-0000-0000-0000-000000000001','administrator'),
('91000000-0000-0000-0000-000000000002','report_builder');
insert into public.sales_desk_sales_codes(code, display_name) values ('HUBT1','Hub Test One'),('HUBT2','Hub Test Two')
on conflict (code) do nothing;
insert into bi.load_jobs(target_table,source_name,sql_query,definition_sha256,load_mode,managed_by)
values ('erp_invoices','erp','SELECT 1',repeat('a',64),'full','erp-agent');
create temp table ids(name text primary key, id uuid);
grant all on ids to authenticated;

select ok(bi.hub_table_allowed('public','sales_desk_rfqs'), 'Sales Desk tables can be offered');
select ok(bi.hub_table_allowed('xref','parts'), 'Cross Reference too');
select ok(not bi.hub_table_allowed('public','provider_connections'), 'connections with tokens never');
select ok(not bi.hub_table_allowed('public','chat_messages'), 'chat never');
select ok(not bi.hub_table_allowed('public','application_role_permissions'), 'permissions never');
select ok(not bi.hub_table_allowed('public','sales_desk_rfq_audit'), 'audit tables never');
select ok(not bi.hub_table_allowed('auth','users'), 'other schemas never');
select ok(not bi.hub_column_allowed('token_ciphertext') and not bi.hub_column_allowed('password_hash') and bi.hub_column_allowed('customer_name'),
  'secret-looking columns are blocked');

-- builders cannot create Hub views
set local role authenticated;
set local request.jwt.claims='{"sub":"91000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok($$select public.bi_hub_sources()$$,'42501',null,'builders cannot list Hub tables');
select throws_ok($$select public.bi_save_hub_view('{"name":"hub_codes","schema":"public","table":"sales_desk_sales_codes","columns":["code"]}')$$,'42501',null,'or create Hub views');
reset role;

set local role authenticated;
set local request.jwt.claims='{"sub":"91000000-0000-0000-0000-000000000001","role":"authenticated"}';
select ok(exists(select 1 from jsonb_array_elements(public.bi_hub_sources()) s where s->>'name' = 'sales_desk_rfqs'
                 and exists (select 1 from jsonb_array_elements(s->'columns') c where c->>'name' = 'customer_name')), 'administrators see Hub tables with their columns');
select ok(not exists(select 1 from jsonb_array_elements(public.bi_hub_sources()) s where s->>'name' in ('provider_connections','chat_messages','oauth_states')),
  'blocked tables are not offered');
select lives_ok($$select public.bi_save_hub_view('{"name":"hub_codes","description":"Sales codes","schema":"public","table":"sales_desk_sales_codes","columns":["code","display_name","is_active"]}')$$,
  'an administrator makes a Hub view');
select throws_ok($$select public.bi_save_hub_view('{"name":"hub_x","schema":"public","table":"provider_connections","columns":["provider"]}')$$,'42501',null,'blocked tables are refused');
select throws_ok($$select public.bi_save_hub_view('{"name":"hub_x","schema":"auth","table":"users","columns":["email"]}')$$,'42501',null,'other schemas are refused');
select throws_ok($$select public.bi_save_hub_view('{"name":"hub_x","schema":"public","table":"sales_desk_sales_codes","columns":["nope"]}')$$,'22023',null,'unknown columns are refused');
select throws_ok($$select public.bi_save_hub_view('{"name":"hub_x","schema":"public","table":"sales_desk_sales_codes","columns":[]}')$$,'22023',null,'at least one column');
select throws_ok($$select public.bi_save_hub_view('{"name":"hub_x","schema":"public","table":"sales_desk_sales_codes; drop table x","columns":["code"]}')$$,'42501',null,'table names cannot inject SQL');
select throws_ok($$select public.bi_save_hub_view('{"name":"erp_invoices","schema":"public","table":"sales_desk_sales_codes","columns":["code"]}')$$,'23505',null,'names of ERP tables are refused');
reset role;

select is((select c.relkind::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='bi_data' and c.relname='hub_codes'),'v','it is a view in bi_data');
select is((select count(*)::int from bi_data.hub_codes where code like 'HUBT%'),2,'with the live rows');
select ok(not has_table_privilege('authenticated','bi_data.hub_codes','select'),'not readable from the browser directly');
select is((select jsonb_agg(c->>'name' order by c->>'name') from bi.data_tables d, jsonb_array_elements(d.columns) c where d.table_name='hub_codes'),
  '["code","display_name","is_active"]'::jsonb,'registered with only the chosen columns');
select is((select kind from bi.connectors where name='hub_codes'),'hub','listed as a Hub connection');

-- it works in an app like any table, and stays live
set local role authenticated;
set local request.jwt.claims='{"sub":"91000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((select source from public.bi_data_tables() where table_name='hub_codes'),'hub','the catalogue shows it as Hub data');
select lives_ok($$insert into ids select 'app', public.bi_save_app('{"name":"Hub test","model":[{"alias":"codes","table_name":"hub_codes"}]}'::jsonb)$$,'a builder adds it to an app');
create temp table expected as select count(*)::int as n from public.sales_desk_sales_codes;
grant select on expected to authenticated;
select is((public.bi_query((select id from ids where name='app'),
  '{"measures":[{"expr":{"t":"fn","name":"count","args":[{"t":"star"}]}}]}'::jsonb)->'rows'->0->>0)::int,
  (select n from expected),'reports read it');
reset role;
insert into public.sales_desk_sales_codes(code, display_name) values ('HUBT3','Hub Test Three');
select is((select count(*)::int from bi_data.hub_codes where code like 'HUBT%'),3,'new rows in the Hub show up straight away (no load)');

-- edit, reload, remove
set local role authenticated;
set local request.jwt.claims='{"sub":"91000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($$select public.bi_save_hub_view('{"name":"hub_codes","schema":"public","table":"sales_desk_sales_codes","columns":["code","display_name"]}')$$,'columns can be changed');
select lives_ok($$select public.bi_reload_connector('hub_codes')$$,'Reload rebuilds it');
reset role;
select is((select count(*)::int from information_schema.columns where table_schema='bi_data' and table_name='hub_codes' and column_name <> 'ctid'),2,'the view has the new columns');
select is((select last_status from bi.connectors where name='hub_codes'),'success','and is fine');
select ok(exists(select 1 from bi.audit_log where object_name='hub_codes' and action='add'),'changes are audited');
set local role authenticated;
set local request.jwt.claims='{"sub":"91000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($$select public.bi_save_hub_view('{"name":"hub_codes2","schema":"public","table":"sales_desk_sales_codes","columns":["code"]}')$$,'another view');
select lives_ok($$select public.bi_delete_connector('hub_codes2')$$,'is removed');
reset role;
select ok(to_regclass('bi_data.hub_codes2') is null and not exists(select 1 from bi.data_tables where table_name='hub_codes2'),'view and catalogue entry are gone');
select ok(exists(select 1 from public.sales_desk_sales_codes where code='HUBT1'),'the Hub data itself is untouched');

select * from finish();
rollback;
