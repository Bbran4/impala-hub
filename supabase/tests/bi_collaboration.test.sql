begin;

create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','88000000-0000-0000-0000-000000000001','authenticated','authenticated','co-builder@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','88000000-0000-0000-0000-000000000002','authenticated','authenticated','co-viewer@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','88000000-0000-0000-0000-000000000003','authenticated','authenticated','co-viewer2@test.invalid','',now(),'{}','{}',now(),now());
insert into public.profile_roles(profile_id,role_id) values
('88000000-0000-0000-0000-000000000001','report_builder'),('88000000-0000-0000-0000-000000000002','management'),('88000000-0000-0000-0000-000000000003','management');

create table bi_data.c_sales(branch text, qty bigint, note text);
insert into bi_data.c_sales select case when i % 2 = 0 then 'Centurion' else 'Pretoria' end, i, null from generate_series(1, 50) i;
analyze bi_data.c_sales;
insert into bi.data_tables(table_name,columns,row_count,last_loaded_at) values
('c_sales','[{"name":"branch","type":"text"},{"name":"qty","type":"bigint"},{"name":"note","type":"text"}]',50,now() - interval '3 days');
insert into bi.load_jobs(target_table,source_name,sql_query,definition_sha256,load_mode,managed_by,interval_minutes)
values ('c_sales','erp','SELECT 1',repeat('a',64),'full','agent',60);
insert into bi.sync_runs(batch_id,job_id,target_table,trigger,status,started_at,finished_at,row_count) values
(gen_random_uuid(),(select id from bi.load_jobs where target_table='c_sales'),'c_sales','schedule','success',now()-interval '4 days',now()-interval '4 days',100),
(gen_random_uuid(),(select id from bi.load_jobs where target_table='c_sales'),'c_sales','schedule','success',now()-interval '3 days',now()-interval '3 days',50);

create temporary table ids(name text primary key, id uuid);
grant all on ids to authenticated;

set local role authenticated;
set local request.jwt.claims='{"sub":"88000000-0000-0000-0000-000000000001","role":"authenticated"}';
insert into ids select 'app', public.bi_save_app('{"name":"Collab","model":[{"alias":"sales","table_name":"c_sales"}],"measures":[{"name":"Units","expression":"Sum(qty)"}],"access":[{"type":"role","principal":"management"}]}'::jsonb);
insert into ids select 'sheet', public.bi_save_sheet(jsonb_build_object('app_id',(select id from ids where name='app'),'title','Overview','objects','[{"id":"o1","kind":"bar","title":"Units by branch"}]'::jsonb));

-- comments
set local request.jwt.claims='{"sub":"88000000-0000-0000-0000-000000000002","role":"authenticated"}';
select lives_ok($$insert into ids select 'c1', public.bi_add_comment((select id from ids where name='app'),(select id from ids where name='sheet'),'o1','Why is Pretoria higher?')$$, 'a viewer comments on a chart');
set local request.jwt.claims='{"sub":"88000000-0000-0000-0000-000000000003","role":"authenticated"}';
select lives_ok($$select public.bi_add_comment((select id from ids where name='app'),(select id from ids where name='sheet'),'o1','Big order on the 12th.')$$, 'someone replies');
select is(jsonb_array_length(public.bi_list_comments((select id from ids where name='app'),(select id from ids where name='sheet'))), 2, 'both comments are listed');
select throws_ok($$select public.bi_update_comment((select id from ids where name='c1'),'changed',null)$$, '42501', null, 'only the author edits a comment');
select lives_ok($$select public.bi_update_comment((select id from ids where name='c1'),null,true)$$, 'anyone can mark it resolved');
select throws_ok($$select public.bi_add_comment((select id from ids where name='app'),(select id from ids where name='sheet'),'o1','   ')$$, '22023', null, 'empty comments are refused');
reset role;
select is((select count(*) from public.user_notifications where kind='bi_comment' and user_id='88000000-0000-0000-0000-000000000002'), 1::bigint, 'the first commenter is notified of the reply');
select is((select metadata->>'object_id' from public.user_notifications where kind='bi_comment' limit 1), 'o1', 'with where to find it');
select is((select count(*) from public.user_notifications where kind='bi_comment' and user_id='88000000-0000-0000-0000-000000000003'), 0::bigint, 'nobody is notified of their own comment');

-- version history
set local role authenticated;
set local request.jwt.claims='{"sub":"88000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($$select public.bi_save_sheet(jsonb_build_object('id',(select id from ids where name='sheet'),'app_id',(select id from ids where name='app'),'title','Overview v2','objects','[]'::jsonb))$$, 'a sheet is changed');
select is((select count(*) from jsonb_array_elements(public.bi_list_versions((select id from ids where name='app'))) v where v->>'kind'='sheet'), 1::bigint, 'the previous version is kept');
select lives_ok($$select public.bi_restore_version(((select v->>'id' from jsonb_array_elements(public.bi_list_versions((select id from ids where name='app'))) v where v->>'kind'='sheet' limit 1))::bigint)$$, 'and restored');
reset role;
select is((select title from bi.sheets where id=(select id from ids where name='sheet')), 'Overview', 'the sheet is back');
set local role authenticated;
set local request.jwt.claims='{"sub":"88000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($$select public.bi_delete_sheet((select id from ids where name='sheet'))$$, 'a sheet is deleted');
select lives_ok($$select public.bi_restore_version(((select v->>'id' from jsonb_array_elements(public.bi_list_versions((select id from ids where name='app'))) v where v->>'kind'='sheet' and (v->>'deleted')::boolean limit 1))::bigint)$$, 'and brought back');
select is((select jsonb_array_length(public.bi_get_app((select id from ids where name='app'))->'sheets')), 1, 'deleted sheets can be restored');
select lives_ok($$select public.bi_save_app(jsonb_build_object('id',(select id from ids where name='app'),'name','Collab','model','[{"alias":"sales","table_name":"c_sales"}]'::jsonb,
  'measures','[{"name":"Units","expression":"Sum(qty) * 2"}]'::jsonb))$$, 'the app is changed');
select lives_ok($$select public.bi_restore_version(((select v->>'id' from jsonb_array_elements(public.bi_list_versions((select id from ids where name='app'))) v where v->>'kind'='app' limit 1))::bigint)$$, 'and its previous version restored');
select is((public.bi_get_app((select id from ids where name='app'))->'measures'->0->>'expression'), 'Sum(qty)', 'with the old master measures');
set local request.jwt.claims='{"sub":"88000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok($$select public.bi_list_versions((select id from ids where name='app'))$$, '42501', null, 'viewers cannot see versions');

-- copy an app
set local request.jwt.claims='{"sub":"88000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($$insert into ids select 'copy', public.bi_copy_app((select id from ids where name='app'),'Collab (copy)', false)$$, 'an app is copied');
select is(jsonb_array_length(public.bi_get_app((select id from ids where name='copy'))->'sheets'), 1, 'with its sheets');
select is(public.bi_get_app((select id from ids where name='copy'))->'access', '[]'::jsonb, 'but not who can open it unless asked');
select throws_ok($$select public.bi_copy_app((select id from ids where name='app'),'collab', false)$$, '23505', null, 'names stay unique');

-- library
select lives_ok($$insert into ids select 'lib', public.bi_save_library_item('{"kind":"measure","name":"Units","expression":"Sum(qty)","format":"integer"}')$$, 'a master measure goes into the library');
select is((public.bi_list_library()->0->>'used_in')::int, 2, 'which shows how many apps have one by that name');
select throws_ok($$select public.bi_save_library_item(jsonb_build_object('id',gen_random_uuid(),'kind','measure','name','X','expression','Sum(qty)'))$$, 'P0002', null, 'unknown items cannot be updated');
set local request.jwt.claims='{"sub":"88000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok($$select public.bi_list_library()$$, '42501', null, 'the library is for builders');

-- usage
select lives_ok($$select public.bi_log_view((select id from ids where name='app'),(select id from ids where name='sheet'))$$, 'a viewer opens a sheet');
set local request.jwt.claims='{"sub":"88000000-0000-0000-0000-000000000001","role":"authenticated"}';
select is((select (a->>'views')::int from jsonb_array_elements(public.bi_usage(30)->'apps') a where a->>'name'='Collab'), 1, 'usage counts views');
select is((select (a->'sheets'->0->>'people')::int from jsonb_array_elements(public.bi_usage(30)->'apps') a where a->>'name'='Collab'), 1, 'per sheet, with people');
select is(jsonb_array_length(public.bi_usage(30)->'people'), 1, 'and lists who');

-- data quality
select is((select t->'empty_fields' from jsonb_array_elements(public.bi_data_quality()) t where t->>'table_name'='c_sales'), '["note"]'::jsonb, 'empty fields are found');
select is((select (t->>'issues')::int from jsonb_array_elements(public.bi_data_quality()) t where t->>'table_name'='c_sales'), 3, 'and late loads and halved row counts are issues');
reset role;

select * from finish();
rollback;
