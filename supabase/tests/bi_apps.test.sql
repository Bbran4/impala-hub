begin;

create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

-- Users: administrator, report builder, management, stock (granted one app personally), sales, inactive builder
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','47000000-0000-0000-0000-000000000001','authenticated','authenticated','apps-admin@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','47000000-0000-0000-0000-000000000002','authenticated','authenticated','apps-builder@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','47000000-0000-0000-0000-000000000003','authenticated','authenticated','apps-manager@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','47000000-0000-0000-0000-000000000004','authenticated','authenticated','apps-stock@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','47000000-0000-0000-0000-000000000005','authenticated','authenticated','apps-sales@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','47000000-0000-0000-0000-000000000006','authenticated','authenticated','apps-inactive@test.invalid','',now(),'{}','{}',now(),now());
insert into public.profile_roles(profile_id,role_id) values
('47000000-0000-0000-0000-000000000001','administrator'),
('47000000-0000-0000-0000-000000000002','report_builder'),
('47000000-0000-0000-0000-000000000003','management'),
('47000000-0000-0000-0000-000000000004','stock'),
('47000000-0000-0000-0000-000000000005','sales'),
('47000000-0000-0000-0000-000000000006','report_builder');
update public.profiles set active=false where id='47000000-0000-0000-0000-000000000006';

-- Loaded data (as the sync agent would create it)
create table bi_data.t_invoices(invoice_no bigint, invoice_date date, branch text, customer text);
create table bi_data.t_lines(invoice_no bigint, line_no bigint, item_code text, qty bigint, unit_price numeric);
create table bi_data.t_items(item_code text, description text, cost_price numeric);
create table bi_data.t_payroll(employee text, salary numeric);
insert into bi_data.t_invoices values (1,current_date-1,'Centurion','A'),(2,current_date-1,'Pretoria','B'),(3,current_date-2,'Centurion','A');
insert into bi_data.t_lines values (1,1,'BRK',2,100),(1,2,'FLT',1,50),(2,1,'BRK',1,100),(3,1,'BAT',1,1000),(3,2,'FLT',4,50);
insert into bi_data.t_items values ('BRK','Brake pads',60),('FLT','Oil filter',20),('BAT','Battery',700);
insert into bi_data.t_payroll values ('someone',99999);
insert into bi.data_tables(table_name,columns,row_count,last_loaded_at) values
('t_invoices','[{"name":"invoice_no","type":"bigint"},{"name":"invoice_date","type":"date"},{"name":"branch","type":"text"},{"name":"customer","type":"text"},{"name":"_bi_loaded_at","type":"timestamptz"}]',3,now()),
('t_lines','[{"name":"invoice_no","type":"bigint"},{"name":"line_no","type":"bigint"},{"name":"item_code","type":"text"},{"name":"qty","type":"bigint"},{"name":"unit_price","type":"numeric"}]',5,now()),
('t_items','[{"name":"item_code","type":"text"},{"name":"description","type":"text"},{"name":"cost_price","type":"numeric"}]',3,now()),
('t_payroll','[{"name":"employee","type":"text"},{"name":"salary","type":"numeric"}]',1,now());

create temporary table ids(name text primary key, id uuid);
grant all on ids to authenticated;

select ok(exists(select 1 from public.roles where id='report_builder'),'report builder role exists');
select ok(not has_function_privilege('anon','public.bi_query(uuid,jsonb)','execute'),'signed-out users cannot query');
select ok(not has_function_privilege('anon','public.bi_write_set(uuid,text,text,text,text)','execute'),'signed-out users cannot write');
select ok(not has_function_privilege('authenticated','bi.compile_expr(jsonb,jsonb,boolean,boolean,integer)','execute'),'the expression compiler is not callable from the app');

-- ---------------------------------------------------------------------------
-- Builder creates an app
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims='{"sub":"47000000-0000-0000-0000-000000000002","role":"authenticated"}';
select ok((public.bi_my_access()->>'builder')::boolean,'report builder is a builder');
select ok(public.can_access_workspace('reporting'),'report builders open Reporting');
select lives_ok($sql$insert into ids select 'sales', public.bi_save_app('{
  "name":"Sales","description":"Daily sales",
  "model":[
    {"alias":"lines","table_name":"t_lines"},
    {"alias":"invoices","table_name":"t_invoices","parent_alias":"lines","join_pairs":[["invoice_no","invoice_no"]]},
    {"alias":"items","table_name":"t_items","parent_alias":"lines","join_pairs":[["item_code","item_code"]]}],
  "measures":[{"name":"Sales","expression":"Sum(qty*unit_price)"}],
  "access":[{"type":"role","principal":"management"},{"type":"user","principal":"47000000-0000-0000-0000-000000000004"}]}'::jsonb)$sql$,'builder creates an app with a three-table data model');
select throws_ok($sql$select public.bi_save_app('{"name":"sales","model":[{"alias":"lines","table_name":"t_lines"}]}'::jsonb)$sql$,'23505',null,'app names are unique');
select throws_ok($sql$select public.bi_save_app('{"name":"X","model":[{"alias":"a","table_name":"t_lines"},{"alias":"b","table_name":"t_items"}]}'::jsonb)$sql$,'22023','Link every table to another table, except the first one','every table but one must link to another');
select throws_ok($sql$select public.bi_save_app('{"name":"X","model":[{"alias":"a","table_name":"t_lines"},{"alias":"b","table_name":"t_items","parent_alias":"a","join_pairs":[["nope","item_code"]]}]}'::jsonb)$sql$,'42703',null,'link fields must exist');
select throws_ok($sql$select public.bi_save_app('{"name":"X","model":[{"alias":"a","table_name":"no_such_table"}]}'::jsonb)$sql$,'42P01',null,'model tables must be loaded tables');
select throws_ok($sql$select public.bi_save_app('{"name":"X","model":[{"alias":"a; drop table x","table_name":"t_lines"}]}'::jsonb)$sql$,'22023',null,'table names in the model are validated');
select lives_ok($sql$select public.bi_save_app(jsonb_build_object('id',(select id from ids where name='sales'),'name','Sales','model',(select jsonb_agg(jsonb_build_object('alias',m->>'alias','table_name',m->>'table_name','parent_alias',m->>'parent_alias','join_pairs',m->'join_pairs')) from jsonb_array_elements(public.bi_get_app((select id from ids where name='sales'))->'model') m),'measures','[{"name":"Sales","expression":"Sum(qty*unit_price)"}]'::jsonb,'variables','[{"name":"vMinQty","value":"2","description":"Smallest quantity"}]'::jsonb))$sql$,'apps can store variables');
select is(public.bi_get_app((select id from ids where name='sales'))->'variables','[{"name":"vMinQty","value":"2","description":"Smallest quantity"}]'::jsonb,'variables come back with the app');
select throws_ok($sql$select public.bi_save_app(jsonb_build_object('name','Bad vars','model','[{"alias":"lines","table_name":"t_lines"}]'::jsonb,'variables','[{"name":"1 bad; drop","value":"x"}]'::jsonb))$sql$,'22023',null,'variable names are validated');
select throws_ok($sql$select public.bi_save_app(jsonb_build_object('name','Dup vars','model','[{"alias":"lines","table_name":"t_lines"}]'::jsonb,'variables','[{"name":"vA","value":"1"},{"name":"va","value":"2"}]'::jsonb))$sql$,'22023','Two variables have the same name','variable names are unique');
select lives_ok($sql$select public.bi_save_app(jsonb_build_object('id',(select id from ids where name='sales'),'name','Sales','model',(select jsonb_agg(jsonb_build_object('alias',m->>'alias','table_name',m->>'table_name','parent_alias',m->>'parent_alias','join_pairs',m->'join_pairs')) from jsonb_array_elements(public.bi_get_app((select id from ids where name='sales'))->'model') m),'measures','[{"name":"Sales","expression":"Sum(qty*unit_price)"}]'::jsonb))$sql$,'saving without variables');
select is(jsonb_array_length(public.bi_get_app((select id from ids where name='sales'))->'variables'),1,'keeps the variables');
select lives_ok($sql$insert into ids select 'sheet', public.bi_save_sheet(jsonb_build_object('app_id',(select id from ids where name='sales'),'title','Overview','objects','[{"id":"o1","kind":"bar"}]'::jsonb))$sql$,'builder saves a sheet');
-- write tables
select lives_ok($sql$select public.bi_save_sheet(jsonb_build_object('app_id',(select id from ids where name='sales'),'title','Orders','objects','[{"id":"w1","kind":"writetable","options":{"writeColumns":[{"name":"Order qty","type":"number"},{"name":"Status","type":"choice","choices":"Open, Ordered"}]}},{"id":"w2","kind":"writetable","options":{"writeEditors":"builders","writeColumns":[{"name":"Note","type":"text"}]}}]'::jsonb))$sql$,'builder saves a sheet with write tables');
select lives_ok($sql$select public.bi_write_set((select id from ids where name='sales'),'w1','["BRK"]','Order qty','12')$sql$,'a value is saved');
select is(public.bi_write_get((select id from ids where name='sales'),'w1')->0->>'value','12','and read back');
select is(public.bi_write_get((select id from ids where name='sales'),'w1')->0->>'updated_by','apps-builder','with who changed it');
select lives_ok($sql$select public.bi_write_set((select id from ids where name='sales'),'w1','["BRK"]','Order qty','15,5')$sql$,'a decimal comma is accepted');
select is(public.bi_write_get((select id from ids where name='sales'),'w1')->0->>'value','15.5','and stored with a point');
select throws_ok($sql$select public.bi_write_set((select id from ids where name='sales'),'w1','["BRK"]','Order qty','lots')$sql$,'22023',null,'number columns only take numbers');
select throws_ok($sql$select public.bi_write_set((select id from ids where name='sales'),'w1','["BRK"]','Status','Lost')$sql$,'22023',null,'choice columns only take their choices');
select lives_ok($sql$select public.bi_write_set((select id from ids where name='sales'),'w1','["BRK"]','Status','Ordered')$sql$,'a choice is saved');
select throws_ok($sql$select public.bi_write_set((select id from ids where name='sales'),'w1','["BRK"]','qty','1')$sql$,'22023',null,'only the editable columns can be written');
select throws_ok($sql$select public.bi_write_set((select id from ids where name='sales'),'o1','["BRK"]','Order qty','1')$sql$,'P0002',null,'only write tables can be written');
select lives_ok($sql$select public.bi_write_set((select id from ids where name='sales'),'w1','["BRK"]','Status','')$sql$,'an empty value clears the cell');
select is(jsonb_array_length(public.bi_write_get((select id from ids where name='sales'),'w1')),1,'leaving the other column');
select is(jsonb_array_length(public.bi_get_app((select id from ids where name='sales'))->'sheets'),2,'the app has its sheets');
select is(jsonb_array_length(public.bi_get_app((select id from ids where name='sales'))->'access'),2,'builders see the access list');
reset role;

-- ---------------------------------------------------------------------------
-- Query engine
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims='{"sub":"47000000-0000-0000-0000-000000000003","role":"authenticated"}';
select is(public.bi_query((select id from ids where name='sales'),'{"measures":[{"expr":{"t":"fn","name":"sum","args":[{"t":"bin","op":"*","l":{"t":"field","name":"qty"},"r":{"t":"field","name":"unit_price"}}]}}]}')->'rows',
  '[[1550]]'::jsonb,'KPI: Sum(qty*unit_price) over all lines');
select is(public.bi_query((select id from ids where name='sales'),'{"dimensions":[{"expr":{"t":"field","name":"branch"}}],"measures":[{"expr":{"t":"fn","name":"sum","args":[{"t":"bin","op":"*","l":{"t":"field","name":"qty"},"r":{"t":"field","name":"unit_price"}}]}}],"sort":[{"index":1,"desc":true}]}')->'rows',
  '[["Centurion",1450],["Pretoria",100]]'::jsonb,'bar: sales per branch through the invoice link, sorted by value');
select is(public.bi_query((select id from ids where name='sales'),'{"dimensions":[{"expr":{"t":"field","name":"description"}}],"measures":[{"expr":{"t":"fn","name":"sum","args":[{"t":"bin","op":"*","l":{"t":"field","name":"qty"},"r":{"t":"bin","op":"-","l":{"t":"field","name":"unit_price"},"r":{"t":"field","name":"cost_price"}}}]}}]}')->'rows',
  '[["Battery",300],["Brake pads",120],["Oil filter",150]]'::jsonb,'gross profit per item through the item link');
select is(public.bi_query((select id from ids where name='sales'),'{"dimensions":[{"expr":{"t":"field","name":"branch"}}],"measures":[{"expr":{"t":"fn","name":"count","distinct":true,"args":[{"t":"field","table":"invoices","name":"invoice_no"}]}}],"selections":[{"expr":{"t":"field","name":"item_code"},"values":["FLT"]}]}')->'rows',
  '[["Centurion",2]]'::jsonb,'selections filter other fields (Qlik-style associations)');
select is(public.bi_query((select id from ids where name='sales'),'{"measures":[{"expr":{"t":"fn","name":"sum","args":[{"t":"field","name":"qty"}]}}],"conditions":[{"t":"bin","op":"=","l":{"t":"field","name":"invoice_date"},"r":{"t":"bin","op":"-","l":{"t":"fn","name":"today","args":[]},"r":{"t":"num","v":1}}}]}')->'rows',
  '[[4]]'::jsonb,'condition: quantity sold yesterday');
select is(public.bi_query((select id from ids where name='sales'),'{"dimensions":[{"expr":{"t":"field","name":"invoice_no"}}],"selections":[{"expr":{"t":"field","name":"unit_price"},"values":[50.00]}]}')->'rows',
  '[[1],[3]]'::jsonb,'numeric selections match regardless of formatting; no measures gives distinct values');
select is(public.bi_query((select id from ids where name='sales'),'{"dimensions":[{"expr":{"t":"field","name":"item_code"}}],"limit":2}')->'has_more','true'::jsonb,'paging reports more rows');
select is(public.bi_query((select id from ids where name='sales'),'{"measures":[{"expr":{"t":"bin","op":"/","l":{"t":"fn","name":"sum","args":[{"t":"field","name":"qty"}]},"r":{"t":"num","v":0}}}]}')->'rows','[[null]]'::jsonb,'division by zero gives empty, not an error');
select is(public.bi_query((select id from ids where name='sales'),'{"dimensions":[{"expr":{"t":"fn","name":"if","args":[{"t":"bin","op":">","l":{"t":"field","name":"qty"},"r":{"t":"num","v":1}},{"t":"str","v":"Multi"},{"t":"str","v":"Single"}]}}],"measures":[{"expr":{"t":"fn","name":"count","args":[{"t":"star"}]}}]}')->'rows',
  '[["Multi",2],["Single",3]]'::jsonb,'If() and Count(*)');
-- records are counted once per aggregation (items appear on several invoice lines)
select is(public.bi_query((select id from ids where name='sales'),'{"measures":[{"expr":{"t":"fn","name":"sum","args":[{"t":"field","name":"cost_price"}]}}]}')->'rows','[[780]]'::jsonb,'Sum of an item field counts each item once, not once per invoice line');
select is(public.bi_query((select id from ids where name='sales'),'{"dimensions":[{"expr":{"t":"field","name":"branch"}}],"measures":[{"expr":{"t":"fn","name":"sum","args":[{"t":"field","name":"cost_price"}]}}],"sort":[{"index":0}]}')->'rows','[["Centurion", 780], ["Pretoria", 60]]'::jsonb,'per dimension value, each item is counted once');
select is(public.bi_query((select id from ids where name='sales'),'{"measures":[{"expr":{"t":"fn","name":"avg","args":[{"t":"field","name":"cost_price"}]}},{"expr":{"t":"fn","name":"count","args":[{"t":"star"}]}},{"expr":{"t":"fn","name":"sum","args":[{"t":"field","name":"qty"}]}}]}')->'rows','[[260.0000000000000000, 5, 9]]'::jsonb,'Avg of an item field uses each item once; Count(*) and line sums are unchanged');
select is(public.bi_query((select id from ids where name='sales'),'{"measures":[{"expr":{"t":"fn","name":"sum","args":[{"t":"bin","op":"*","l":{"t":"field","name":"qty"},"r":{"t":"field","name":"cost_price"}}]}}]}')->'rows','[[980]]'::jsonb,'mixing line and item fields works per invoice line');
select is(public.bi_query((select id from ids where name='sales'),'{"dimensions":[{"expr":{"t":"field","name":"item_code"}}],"measures":[{"expr":{"t":"fn","name":"sum","args":[{"t":"field","name":"cost_price"}]}},{"expr":{"t":"fn","name":"sum","args":[{"t":"field","name":"qty"}]}}],"sort":[{"index":0}]}')->'rows','[["BAT", 700, 1], ["BRK", 60, 3], ["FLT", 20, 5]]'::jsonb,'per item, item fields and line totals are both right');
select is(public.bi_query((select id from ids where name='sales'),'{"measures":[{"expr":{"t":"fn","name":"sum","args":[{"t":"field","name":"cost_price"}]}}],"selections":[{"expr":{"t":"field","name":"branch"},"values":["Pretoria"]}]}')->'rows','[[60]]'::jsonb,'selections apply before counting records');
-- no main table: links work both ways and records without a match are kept
reset role;
insert into bi_data.t_items values ('OIL','Engine oil',90);
set local role authenticated;
select is(public.bi_query((select id from ids where name='sales'),'{"dimensions":[{"expr":{"t":"field","name":"description"}}],"measures":[{"expr":{"t":"fn","name":"sum","args":[{"t":"field","name":"cost_price"}]}}],"sort":[{"index":0}]}')->'rows','[["Battery", 700], ["Brake pads", 60], ["Engine oil", 90], ["Oil filter", 20]]'::jsonb,'a chart on the items table alone lists items that never sold');
select is(public.bi_query((select id from ids where name='sales'),'{"dimensions":[{"expr":{"t":"field","name":"description"}}],"measures":[{"expr":{"t":"fn","name":"sum","args":[{"t":"field","name":"qty"}]}},{"expr":{"t":"fn","name":"sum","args":[{"t":"field","name":"cost_price"}]}}],"sort":[{"index":0}]}')->'rows','[["Battery", 1, 700], ["Brake pads", 3, 60], ["Engine oil", null, 90], ["Oil filter", 5, 20]]'::jsonb,'joining items and lines keeps the unsold item');
select is(public.bi_query((select id from ids where name='sales'),'{"dimensions":[{"expr":{"t":"field","name":"description"}}],"measures":[{"expr":{"t":"fn","name":"sum","args":[{"t":"field","name":"qty"}]}}],"sort":[{"index":0}]}')->'rows','[["Battery", 1], ["Brake pads", 3], ["Oil filter", 5]]'::jsonb,'rows where every measure is empty are left out, like Qlik');
select is(public.bi_query((select id from ids where name='sales'),'{"dimensions":[{"expr":{"t":"field","name":"branch"}}],"measures":[{"expr":{"t":"fn","name":"sum","args":[{"t":"field","name":"cost_price"}]}}],"sort":[{"index":0}]}')->'rows','[["Centurion", 780], ["Pretoria", 60], [null, 90]]'::jsonb,'items with no invoices show under an empty branch');
select is(public.bi_query((select id from ids where name='sales'),'{"measures":[{"expr":{"t":"fn","name":"sum","args":[{"t":"field","name":"cost_price"}]}}],"selections":[{"expr":{"t":"field","name":"branch"},"values":["Centurion"]}]}')->'rows','[[780]]'::jsonb,'selections narrow the unsold items away');
select is(public.bi_query((select id from ids where name='sales'),'{"dimensions":[{"expr":{"t":"field","name":"customer"}}],"measures":[{"expr":{"t":"fn","name":"count","args":[{"t":"star"}]}}],"sort":[{"index":0}]}')->'rows','[["A", 4], ["B", 1]]'::jsonb,'Count(*) counts the first table in the model');
reset role;
delete from bi_data.t_items where item_code = 'OIL';
set local role authenticated;
select throws_ok($sql$select public.bi_query((select id from ids where name='sales'),'{"measures":[{"expr":{"t":"field","name":"qty"}}]}')$sql$,'22023',null,'measures must aggregate');
select throws_ok($sql$select public.bi_query((select id from ids where name='sales'),'{"dimensions":[{"expr":{"t":"fn","name":"sum","args":[{"t":"field","name":"qty"}]}}]}')$sql$,'22023',null,'dimensions cannot aggregate');
select throws_ok($sql$select public.bi_query((select id from ids where name='sales'),'{"measures":[{"expr":{"t":"fn","name":"sum","args":[{"t":"fn","name":"sum","args":[{"t":"field","name":"qty"}]}]}}]}')$sql$,'22023',null,'aggregations cannot be nested');

-- injection and reach attempts
select throws_ok($sql$select public.bi_query((select id from ids where name='sales'),'{"dimensions":[{"expr":{"t":"field","name":"salary"}}]}')$sql$,'42703',null,'fields outside the data model are unknown');
select throws_ok($sql$select public.bi_query((select id from ids where name='sales'),'{"dimensions":[{"expr":{"t":"field","table":"t_payroll","name":"salary"}}]}')$sql$,'42P01',null,'tables outside the data model are unknown');
select throws_ok($sql$select public.bi_query((select id from ids where name='sales'),'{"dimensions":[{"expr":{"t":"field","name":"qty\" from bi_data.t_payroll --"}}]}')$sql$,'42703',null,'field names cannot carry SQL');
select throws_ok($sql$select public.bi_query((select id from ids where name='sales'),'{"dimensions":[{"expr":{"t":"fn","name":"pg_sleep","args":[{"t":"num","v":5}]}}]}')$sql$,'22023',null,'only whitelisted functions run');
select throws_ok($sql$select public.bi_query((select id from ids where name='sales'),'{"dimensions":[{"expr":{"t":"bin","op":"; drop table bi.apps; --","l":{"t":"num","v":1},"r":{"t":"num","v":1}}}]}')$sql$,'22023',null,'only whitelisted operators run');
select throws_ok($sql$select public.bi_query((select id from ids where name='sales'),'{"dimensions":[{"expr":{"t":"num","v":"1); drop table bi.apps; --"}}]}')$sql$,'22023',null,'numbers must be numbers');
select is(public.bi_query((select id from ids where name='sales'),$q${"dimensions":[{"expr":{"t":"str","v":"x'); drop table bi.apps; --"}}]}$q$)->'rows',$r$[["x'); drop table bi.apps; --"]]$r$::jsonb,'text is always a quoted literal');
select is(public.bi_query((select id from ids where name='sales'),$q${"dimensions":[{"expr":{"t":"field","name":"branch"}}],"selections":[{"expr":{"t":"field","name":"branch"},"values":["x'); drop table bi.apps; --"]}]}$q$)->'rows','[]'::jsonb,'selected values are always quoted literals');
select throws_ok($sql$select public.bi_save_app('{"name":"Hack","model":[{"alias":"p","table_name":"t_payroll"}]}'::jsonb)$sql$,'42501',null,'management cannot create apps');
select throws_ok($sql$select public.bi_save_sheet(jsonb_build_object('app_id',(select id from ids where name='sales'),'title','x'))$sql$,'42501',null,'management cannot edit sheets');
select is(public.bi_get_app((select id from ids where name='sales'))->'access','null'::jsonb,'viewers do not see the access list');
reset role;
select ok(to_regclass('bi.apps') is not null and (select count(*) from bi.apps)=1,'nothing was dropped or changed by the injection attempts');

-- ---------------------------------------------------------------------------
-- Access: role grant, personal grant, no grant, inactive
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims='{"sub":"47000000-0000-0000-0000-000000000004","role":"authenticated"}';
select is(jsonb_array_length(public.bi_list_apps()),1,'a user granted personally sees the app');
select ok(not public.can_access_workspace('reporting'),'personal app access does not open the data catalogue');
select is((public.bi_my_access()->>'apps')::int,1,'access summary counts the shared app');
select is(public.bi_query((select id from ids where name='sales'),'{"measures":[{"expr":{"t":"fn","name":"count","args":[{"t":"star"}]}}]}')->'rows','[[5]]'::jsonb,'and can query it');
select lives_ok($sql$select public.bi_write_set((select id from ids where name='sales'),'w1','["FLT"]','Order qty','3')$sql$,'people with access can write in a write table');
select throws_ok($sql$select public.bi_write_set((select id from ids where name='sales'),'w2','["FLT"]','Note','x')$sql$,'42501',null,'but not in one for builders only');
reset role;

set local role authenticated;
set local request.jwt.claims='{"sub":"47000000-0000-0000-0000-000000000005","role":"authenticated"}';
select is(jsonb_array_length(public.bi_list_apps()),0,'users without a grant see no apps');
select throws_ok($sql$select public.bi_get_app((select id from ids where name='sales'))$sql$,'42501',null,'and cannot open one');
select throws_ok($sql$select public.bi_query((select id from ids where name='sales'),'{"measures":[{"expr":{"t":"fn","name":"count","args":[{"t":"star"}]}}]}')$sql$,'42501',null,'and cannot query one');
select throws_ok($sql$select public.bi_write_get((select id from ids where name='sales'),'w1')$sql$,'42501',null,'and cannot read write tables');
select throws_ok($sql$select public.bi_write_set((select id from ids where name='sales'),'w1','["X"]','Order qty','1')$sql$,'42501',null,'or write in them');
select throws_ok($sql$select * from bi.apps$sql$,'42501',null,'app tables are not readable directly');
reset role;

set local role authenticated;
set local request.jwt.claims='{"sub":"47000000-0000-0000-0000-000000000006","role":"authenticated"}';
select ok(not (public.bi_my_access()->>'builder')::boolean,'inactive builders lose builder rights');
select throws_ok($sql$select public.bi_delete_app((select id from ids where name='sales'))$sql$,'42501',null,'inactive builders cannot delete apps');
reset role;

-- Administrator removes access and deletes
set local role authenticated;
set local request.jwt.claims='{"sub":"47000000-0000-0000-0000-000000000001","role":"authenticated"}';
select is(jsonb_array_length(public.bi_list_principals()->'roles') > 5,true,'builders can list roles for sharing');
select lives_ok($sql$select public.bi_save_app(jsonb_build_object('id',(select id from ids where name='sales'),'name','Sales','model',(public.bi_get_app((select id from ids where name='sales'))->'model'),'access','[]'::jsonb))$sql$,'administrator removes all access');
reset role;
set local role authenticated;
set local request.jwt.claims='{"sub":"47000000-0000-0000-0000-000000000004","role":"authenticated"}';
select is(jsonb_array_length(public.bi_list_apps()),0,'access removal takes effect immediately');
reset role;
set local role authenticated;
set local request.jwt.claims='{"sub":"47000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($sql$select public.bi_delete_app((select id from ids where name='sales'))$sql$,'administrator deletes the app');
select is((select count(*) from public.bi_audit_log() where object_type='app'),5::bigint,'app create, changes (incl. variables) and delete are audited');
reset role;
select is((select count(*) from bi.sheets),0::bigint,'deleting an app deletes its sheets');

select * from finish();
rollback;
