begin;

create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','82000000-0000-0000-0000-000000000001','authenticated','authenticated','calc-builder@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','82000000-0000-0000-0000-000000000002','authenticated','authenticated','calc-viewer@test.invalid','',now(),'{}','{}',now(),now());
insert into public.profile_roles(profile_id,role_id) values
('82000000-0000-0000-0000-000000000001','report_builder'),('82000000-0000-0000-0000-000000000002','management');

create table bi_data.c_invoices(invoice_no bigint, branch text, amount numeric, invoice_date date);
create table bi_data.c_lines(invoice_no bigint, item text, qty bigint, price numeric);
insert into bi_data.c_invoices values (1,'Centurion',100,'2026-09-30'),(2,'Pretoria',50,'2026-10-02');
insert into bi_data.c_lines values (1,'a',2,10),(1,'b',1,30),(2,'c',5,10);
insert into bi.data_tables(table_name,columns,row_count,last_loaded_at) values
('c_invoices','[{"name":"invoice_no","type":"bigint"},{"name":"branch","type":"text"},{"name":"amount","type":"numeric"},{"name":"invoice_date","type":"date"}]',2,now()),
('c_lines','[{"name":"invoice_no","type":"bigint"},{"name":"item","type":"text"},{"name":"qty","type":"bigint"},{"name":"price","type":"numeric"}]',3,now());

create temporary table ids(name text primary key, id uuid);
grant all on ids to authenticated;
create function pg_temp.q(p jsonb) returns jsonb language sql as $$ select public.bi_query((select id from ids where name='app'), p)->'rows' $$;
grant execute on function pg_temp.q(jsonb) to authenticated;

set local role authenticated;
set local request.jwt.claims='{"sub":"82000000-0000-0000-0000-000000000001","role":"authenticated"}';
insert into ids select 'app', public.bi_save_app('{"name":"Calc","model":[
  {"alias":"lines","table_name":"c_lines"},
  {"alias":"invoices","table_name":"c_invoices","parent_alias":"lines","join_pairs":[["invoice_no","invoice_no"]]}],
  "access":[{"type":"role","principal":"management"}],
  "calc_fields":[
    {"table":"lines","name":"line_value","expression":"qty * price","node":{"t":"bin","op":"*","l":{"t":"field","name":"qty"},"r":{"t":"field","name":"price"}}},
    {"table":"invoices","name":"month","expression":"YearMonth(invoice_date)","node":{"t":"fn","name":"yearmonth","args":[{"t":"field","name":"invoice_date"}]}}]}'::jsonb);

-- calculated fields
select is((select jsonb_agg(c->>'name') from jsonb_array_elements(public.bi_get_app((select id from ids where name='app'))->'model') t,
  jsonb_array_elements(t->'columns') c where c->>'type' = 'calculated'), '["line_value", "month"]'::jsonb, 'calculated fields are listed with their tables'' fields');
select is(jsonb_array_length(public.bi_get_app((select id from ids where name='app'))->'calc_fields'), 2, 'and returned for editing');
select is(pg_temp.q('{"measures":[{"expr":{"t":"fn","name":"sum","args":[{"t":"field","name":"line_value"}]}}]}'), '[[100]]'::jsonb, 'a calculated field is used in a measure');
select is(pg_temp.q('{"dimensions":[{"expr":{"t":"field","table":"invoices","name":"month"}}],"measures":[{"expr":{"t":"fn","name":"sum","args":[{"t":"field","name":"amount"}]}}]}'),
  '[["2026-09", 100], ["2026-10", 50]]'::jsonb, 'and as a dimension');
select is(pg_temp.q('{"dimensions":[{"expr":{"t":"field","name":"month"}}],"selections":[{"expr":{"t":"field","name":"month"},"values":["2026-10"]}]}'),
  '[["2026-10"]]'::jsonb, 'and can be selected');
select throws_ok($$select public.bi_save_app(jsonb_build_object('id',(select id from ids where name='app'),'name','Calc','model',(select jsonb_agg(m - 'columns') from jsonb_array_elements(public.bi_get_app((select id from ids where name='app'))->'model') m),
  'calc_fields','[{"table":"lines","name":"total","expression":"Sum(qty)","node":{"t":"fn","name":"sum","args":[{"t":"field","name":"qty"}]}}]'::jsonb))$$,
  '22023', null, 'calculated fields cannot aggregate');
select throws_ok($$select public.bi_save_app(jsonb_build_object('id',(select id from ids where name='app'),'name','Calc','model',(select jsonb_agg(m - 'columns') from jsonb_array_elements(public.bi_get_app((select id from ids where name='app'))->'model') m),
  'calc_fields','[{"table":"lines","name":"br","expression":"branch","node":{"t":"field","name":"branch"}}]'::jsonb))$$,
  '22023', null, 'they only use their own table''s fields');
select throws_ok($$select public.bi_save_app(jsonb_build_object('id',(select id from ids where name='app'),'name','Calc','model',(select jsonb_agg(m - 'columns') from jsonb_array_elements(public.bi_get_app((select id from ids where name='app'))->'model') m),
  'calc_fields','[{"table":"lines","name":"qty","expression":"qty","node":{"t":"field","name":"qty"}}]'::jsonb))$$,
  '22023', null, 'and cannot take a loaded field''s name');
select throws_ok($$select public.bi_save_app(jsonb_build_object('id',(select id from ids where name='app'),'name','Calc','model',(select jsonb_agg(m - 'columns') from jsonb_array_elements(public.bi_get_app((select id from ids where name='app'))->'model') m),
  'calc_fields','[{"table":"lines","name":"Bad Name","expression":"qty","node":{"t":"field","name":"qty"}}]'::jsonb))$$,
  '22023', null, 'names are checked');
select lives_ok($$select public.bi_save_app(jsonb_build_object('id',(select id from ids where name='app'),'name','Calc','model',(select jsonb_agg(m - 'columns') from jsonb_array_elements(public.bi_get_app((select id from ids where name='app'))->'model') m),
  'access','[{"type":"role","principal":"management"}]'::jsonb))$$, 'saving without calc_fields');
select is(jsonb_array_length(public.bi_get_app((select id from ids where name='app'))->'calc_fields'), 2, 'keeps them');

-- set analysis over linked tables still counts every invoice once
select is(pg_temp.q('{"measures":[{"expr":{"t":"fn","name":"sum","args":[{"t":"field","name":"amount"}]}}]}'), '[[150]]'::jsonb, 'invoice amounts are counted once');
select is(pg_temp.q('{"measures":[{"expr":{"t":"fn","name":"sum","set":{"base":"$","mods":[{"field":{"t":"field","name":"item"},"op":"=","values":[{"v":"b"}]}]},"args":[{"t":"field","name":"amount"}]}}]}'),
  '[[100]]'::jsonb, 'also inside a set that selects the second line of an invoice');
select is(pg_temp.q('{"measures":[{"expr":{"t":"fn","name":"sum","set":{"base":"1"},"args":[{"t":"field","name":"amount"}]}},{"expr":{"t":"fn","name":"sum","args":[{"t":"field","name":"amount"}]}}],
  "selections":[{"expr":{"t":"field","name":"item"},"values":["c"]}]}'), '[[150, 50]]'::jsonb, '{1} ignores the selections');
select is(pg_temp.q('{"dimensions":[{"expr":{"t":"field","name":"branch"}}],"measures":[{"expr":{"t":"fn","name":"count","set":{"base":"1"},"args":[{"t":"field","name":"item"}]}}],
  "selections":[{"expr":{"t":"field","name":"item"},"values":["c"]}],"sort":[{"index":0}]}'), '[["Centurion", 2], ["Pretoria", 1]]'::jsonb, 'and shows rows outside the selection');
select is(pg_temp.q('{"measures":[{"expr":{"t":"fn","name":"avg","args":[{"t":"fn","name":"aggr","args":[{"t":"fn","name":"sum","args":[{"t":"field","name":"amount"}]},{"t":"field","name":"branch"}]}]}}]}'),
  '[[75]]'::jsonb, 'Aggr over a linked table counts records once');
reset role;

-- row access still applies with {1}
update bi.apps set row_access = true where id = (select id from ids where name='app');
insert into bi.row_rules(app_id, principal_type, principal, field, vals) values ((select id from ids where name='app'), 'role', 'management', 'invoices.branch', '{Centurion}');
set local role authenticated;
set local request.jwt.claims='{"sub":"82000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is(pg_temp.q('{"measures":[{"expr":{"t":"fn","name":"sum","set":{"base":"1"},"args":[{"t":"field","name":"amount"}]}}]}'), '[[100]]'::jsonb, 'sets cannot see past row access');
select is(pg_temp.q('{"measures":[{"expr":{"t":"fn","name":"sum","set":{"base":"$","mods":[{"field":{"t":"field","name":"branch"},"op":"=","values":[{"v":"Pretoria"}]}]},"args":[{"t":"field","name":"amount"}]}}]}'), '[[null]]'::jsonb, 'even when they name another branch');
reset role;

select * from finish();
rollback;
