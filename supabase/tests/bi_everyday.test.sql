begin;

create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','84000000-0000-0000-0000-000000000001','authenticated','authenticated','ev-builder@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','84000000-0000-0000-0000-000000000002','authenticated','authenticated','ev-viewer@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','84000000-0000-0000-0000-000000000003','authenticated','authenticated','ev-other@test.invalid','',now(),'{}','{}',now(),now());
insert into public.profile_roles(profile_id,role_id) values
('84000000-0000-0000-0000-000000000001','report_builder'),('84000000-0000-0000-0000-000000000002','management'),('84000000-0000-0000-0000-000000000003','sales');

create table bi_data.e_sales(branch text, item text, qty bigint);
insert into bi_data.e_sales values ('Centurion','Brake pads',2),('Pretoria','Brake discs',5),('Pretoria','Oil filter',1);
insert into bi.data_tables(table_name,columns,row_count,last_loaded_at) values
('e_sales','[{"name":"branch","type":"text"},{"name":"item","type":"text"},{"name":"qty","type":"bigint"}]',3,now());

create temporary table ids(name text primary key, id uuid);
grant all on ids to authenticated;

set local role authenticated;
set local request.jwt.claims='{"sub":"84000000-0000-0000-0000-000000000001","role":"authenticated"}';
insert into ids select 'app', public.bi_save_app('{"name":"Everyday","model":[{"alias":"sales","table_name":"e_sales"}],"access":[{"type":"role","principal":"management"}]}'::jsonb);
insert into ids select 'sheet', public.bi_save_sheet(jsonb_build_object('app_id',(select id from ids where name='app'),'title','Overview','objects','[]'::jsonb));

-- bookmarks
select lives_ok($$insert into ids select 'shared', public.bi_save_bookmark(jsonb_build_object('app_id',(select id from ids where name='app'),'name','Pretoria only','shared',true,
  'sheet_id',(select id from ids where name='sheet'),'selections','[{"key":"sales.branch","label":"Branch","node":{"t":"field","name":"branch"},"values":["Pretoria"]}]'::jsonb,
  'variables','{"vMin":"2"}'::jsonb))$$, 'a builder shares a bookmark');
select throws_ok($$select public.bi_save_bookmark(jsonb_build_object('app_id',(select id from ids where name='app'),'name','Bad','selections','[{"key":"x"}]'::jsonb))$$, '22023', null, 'selections are checked');
select throws_ok($$select public.bi_save_bookmark(jsonb_build_object('app_id',(select id from ids where name='app'),'name','Bad','sheet_id',gen_random_uuid()))$$, '22023', null, 'the sheet must be in the app');

set local request.jwt.claims='{"sub":"84000000-0000-0000-0000-000000000002","role":"authenticated"}';
select lives_ok($$insert into ids select 'mine', public.bi_save_bookmark(jsonb_build_object('app_id',(select id from ids where name='app'),'name','My brakes',
  'selections','[{"key":"sales.item","label":"Item","node":{"t":"field","name":"item"},"values":["Brake pads"]}]'::jsonb))$$, 'a viewer saves a personal bookmark');
select throws_ok($$select public.bi_save_bookmark(jsonb_build_object('app_id',(select id from ids where name='app'),'name','Everyone','shared',true))$$, '42501', null, 'but cannot share one');
select is(jsonb_array_length(public.bi_list_bookmarks((select id from ids where name='app'))), 2, 'viewers see shared bookmarks and their own');
select is((public.bi_list_bookmarks((select id from ids where name='app'))->0->>'name'), 'Pretoria only', 'shared first');
select throws_ok($$select public.bi_delete_bookmark((select id from ids where name='shared'))$$, 'P0002', null, 'viewers cannot delete shared bookmarks');
set local request.jwt.claims='{"sub":"84000000-0000-0000-0000-000000000001","role":"authenticated"}';
select is(jsonb_array_length(public.bi_list_bookmarks((select id from ids where name='app'))), 1, 'personal bookmarks stay personal');
set local request.jwt.claims='{"sub":"84000000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok($$select public.bi_list_bookmarks((select id from ids where name='app'))$$, '42501', null, 'people without the app see none');

-- favourites and recently opened
set local request.jwt.claims='{"sub":"84000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is(public.bi_toggle_favourite((select id from ids where name='app'),(select id from ids where name='sheet')), true, 'a sheet is added to favourites');
select is(public.bi_my_home()->'favourites'->0->>'sheet_title', 'Overview', 'and shows on the home page');
select is(public.bi_toggle_favourite((select id from ids where name='app'),(select id from ids where name='sheet')), false, 'and removed again');
select lives_ok($$select public.bi_log_view((select id from ids where name='app'),(select id from ids where name='sheet'))$$, 'opening a sheet is logged');
select lives_ok($$select public.bi_log_view((select id from ids where name='app'),(select id from ids where name='sheet'))$$, 'twice');
reset role;
select is((select count(*) from bi.view_log where user_id='84000000-0000-0000-0000-000000000002'), 1::bigint, 'but only once a minute');
set local role authenticated;
set local request.jwt.claims='{"sub":"84000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is(public.bi_my_home()->'recent'->0->>'app_name', 'Everyday', 'recently opened sheets are listed');
set local request.jwt.claims='{"sub":"84000000-0000-0000-0000-000000000003","role":"authenticated"}';
select lives_ok($$select public.bi_log_view((select id from ids where name='app'),(select id from ids where name='sheet'))$$, 'people without access are ignored');
select throws_ok($$select public.bi_toggle_favourite((select id from ids where name='app'),(select id from ids where name='sheet'))$$, '42501', null, 'and cannot favourite');

-- smart search
set local request.jwt.claims='{"sub":"84000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is(public.bi_search_values((select id from ids where name='app'), 'brake'),
  '[{"table": "sales", "field": "item", "values": ["Brake discs", "Brake pads"], "more": false}]'::jsonb, 'search finds values in any text field');
select is(public.bi_search_values((select id from ids where name='app'), 'pre')->0->'values', '["Pretoria"]'::jsonb, 'not case-sensitive');
select is(public.bi_search_values((select id from ids where name='app'), 'brake', '[{"expr":{"t":"field","name":"branch"},"values":["Centurion"]}]'),
  '[{"table": "sales", "field": "item", "values": ["Brake pads"], "more": false}]'::jsonb, 'within the current selections');
select is(public.bi_search_values((select id from ids where name='app'), 'x'), '[]'::jsonb, 'at least two characters');
select is(public.bi_search_values((select id from ids where name='app'), '100%'), '[]'::jsonb, 'wildcards in the text are literal');
reset role;
update bi.apps set row_access = true where id = (select id from ids where name='app');
insert into bi.row_rules(app_id, principal_type, principal, field, vals) values ((select id from ids where name='app'), 'role', 'management', 'sales.branch', '{Centurion}');
set local role authenticated;
set local request.jwt.claims='{"sub":"84000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is(public.bi_search_values((select id from ids where name='app'), 'pre'), '[]'::jsonb, 'search follows row access');
reset role;

select * from finish();
rollback;
