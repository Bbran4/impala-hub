begin;

create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

-- Users: builder, two branch managers (management role), a stock user, someone with no access
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','80000000-0000-0000-0000-000000000001','authenticated','authenticated','ra-builder@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','80000000-0000-0000-0000-000000000002','authenticated','authenticated','ra-centurion@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','80000000-0000-0000-0000-000000000003','authenticated','authenticated','ra-pretoria@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','80000000-0000-0000-0000-000000000004','authenticated','authenticated','ra-stock@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','80000000-0000-0000-0000-000000000005','authenticated','authenticated','ra-nobody@test.invalid','',now(),'{}','{}',now(),now());
insert into public.profile_roles(profile_id,role_id) values
('80000000-0000-0000-0000-000000000001','report_builder'),
('80000000-0000-0000-0000-000000000002','management'),
('80000000-0000-0000-0000-000000000003','management'),
('80000000-0000-0000-0000-000000000004','stock');

create table bi_data.r_invoices(invoice_no bigint, invoice_date date, branch text);
create table bi_data.r_lines(invoice_no bigint, item_code text, qty bigint, unit_price numeric);
insert into bi_data.r_invoices values (1,'2026-10-01','Centurion'),(2,'2026-10-01','Pretoria'),(3,'2026-10-02','Centurion'),(4,'2026-10-02','Midrand');
insert into bi_data.r_lines values (1,'BRK',2,100),(2,'BRK',1,100),(3,'BAT',1,1000),(4,'FLT',3,50);
insert into bi.data_tables(table_name,columns,row_count,last_loaded_at) values
('r_invoices','[{"name":"invoice_no","type":"bigint"},{"name":"invoice_date","type":"date"},{"name":"branch","type":"text"}]',4,now()),
('r_lines','[{"name":"invoice_no","type":"bigint"},{"name":"item_code","type":"text"},{"name":"qty","type":"bigint"},{"name":"unit_price","type":"numeric"}]',4,now());

create temporary table ids(name text primary key, id uuid);
create temporary table tickets(name text primary key, ticket text, delivery uuid);
grant all on ids, tickets to authenticated, anon, service_role;

-- the query helpers used below
create function pg_temp.sales_by_branch(p_app uuid) returns jsonb language sql as $$
  select public.bi_query(p_app, '{"dimensions":[{"expr":{"t":"field","table":"invoices","name":"branch"}}],
    "measures":[{"expr":{"t":"fn","name":"sum","args":[{"t":"bin","op":"*","l":{"t":"field","name":"qty"},"r":{"t":"field","name":"unit_price"}}]}}]}')->'rows' $$;
create function pg_temp.items(p_app uuid) returns jsonb language sql as $$
  select public.bi_query(p_app, '{"dimensions":[{"expr":{"t":"field","table":"lines","name":"item_code"}}]}')->'rows' $$;
grant execute on function pg_temp.sales_by_branch(uuid), pg_temp.items(uuid) to authenticated;

select ok(not has_function_privilege('authenticated','public.bi_report_claim(integer)','execute'),'the app cannot claim report deliveries');
select ok(not has_function_privilege('anon','public.bi_report_finish(uuid,text,text)','execute'),'or finish them');
select ok(has_function_privilege('service_role','public.bi_report_claim(integer)','execute'),'the sender (service role) can');
select ok(has_function_privilege('anon','public.bi_render_query(text,jsonb)','execute'),'rendering works signed out, with a ticket');
select ok(not has_function_privilege('anon','public.bi_get_row_access(uuid)','execute'),'row access rules are not public');

-- ---------------------------------------------------------------------------
-- Builder: app, sheets, row access
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims='{"sub":"80000000-0000-0000-0000-000000000001","role":"authenticated"}';
insert into ids select 'app', public.bi_save_app('{"name":"Branch sales","model":[
  {"alias":"lines","table_name":"r_lines"},
  {"alias":"invoices","table_name":"r_invoices","parent_alias":"lines","join_pairs":[["invoice_no","invoice_no"]]}],
  "access":[{"type":"role","principal":"management"},{"type":"user","principal":"80000000-0000-0000-0000-000000000004"}]}'::jsonb);
insert into ids select 'sheet1', public.bi_save_sheet(jsonb_build_object('app_id',(select id from ids where name='app'),'title','Overview','objects','[]'::jsonb));
insert into ids select 'sheet2', public.bi_save_sheet(jsonb_build_object('app_id',(select id from ids where name='app'),'title','Orders','objects',
  '[{"id":"w1","kind":"writetable","options":{"writeColumns":[{"name":"Note","type":"text"}],"keyDims":[{"t":"field","table":"lines","name":"item_code"}]}}]'::jsonb));
select is(public.bi_get_row_access((select id from ids where name='app'))->'enabled','false'::jsonb,'row access starts off');
select lives_ok($$select public.bi_write_set((select id from ids where name='app'),'w1','["FLT"]','Note','Midrand only')$$,'builder writes a note on a Midrand item');
select lives_ok($$select public.bi_write_set((select id from ids where name='app'),'w1','["BRK"]','Note','Everyone')$$,'and one on an item sold everywhere');

select throws_ok($$select public.bi_save_row_access((select id from ids where name='app'),'{"enabled":true,"rules":[{"type":"role","principal":"management","field":"invoices.nope","values":["x"]}]}')$$,
  '22023',null,'rule fields must be in the data model');
select throws_ok($$select public.bi_save_row_access((select id from ids where name='app'),'{"enabled":true,"rules":[{"type":"role","principal":"management","field":"invoices.branch","values":[]}]}')$$,
  '22023',null,'a rule needs values or "all values"');
select throws_ok($$select public.bi_save_row_access((select id from ids where name='app'),'{"enabled":true,"rules":[{"type":"role","principal":"no_such_role","field":"invoices.branch","all":true}]}')$$,
  '22023',null,'roles must exist');
select lives_ok($$select public.bi_save_row_access((select id from ids where name='app'),'{"enabled":true,"rules":[
  {"type":"user","principal":"80000000-0000-0000-0000-000000000002","field":"invoices.branch","values":["Centurion"]},
  {"type":"user","principal":"80000000-0000-0000-0000-000000000003","field":"invoices.branch","values":["Pretoria","Midrand"]},
  {"type":"role","principal":"stock","field":"invoices.branch","all":true}]}')$$,'row access rules are saved');
select is(jsonb_array_length(public.bi_get_row_access((select id from ids where name='app'))->'rules'),3,'and read back');
select is(jsonb_array_length(pg_temp.sales_by_branch((select id from ids where name='app'))),3,'builders still see every branch');
reset role;
select is((select action from bi.audit_log where object_type='row access' order by id desc limit 1),'change','row access changes are audited');

-- ---------------------------------------------------------------------------
-- Viewers only see their rows
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims='{"sub":"80000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is(pg_temp.sales_by_branch((select id from ids where name='app')),'[["Centurion", 1200]]'::jsonb,'Centurion''s manager only sees Centurion');
select is(pg_temp.items((select id from ids where name='app')),'[["BAT"], ["BRK"]]'::jsonb,'also in charts that do not show the branch');
select is(public.bi_query((select id from ids where name='app'),'{"measures":[{"expr":{"t":"fn","name":"count","args":[{"t":"star"}]}}]}')->'rows','[[2]]'::jsonb,'and in totals');
select is(public.bi_query((select id from ids where name='app'),'{"dimensions":[{"expr":{"t":"field","table":"invoices","name":"branch"}}],"selections":[{"expr":{"t":"field","table":"invoices","name":"branch"},"values":["Pretoria"]}]}')->'rows','[]'::jsonb,'selecting another branch shows nothing');
select is(public.bi_my_row_access((select id from ids where name='app')),'{"invoices.branch":["Centurion"]}'::jsonb,'viewers can see what they are limited to');
select is(jsonb_array_length(public.bi_write_get((select id from ids where name='app'),'w1')),1,'write table notes on rows they cannot see are hidden');
select is(public.bi_write_get((select id from ids where name='app'),'w1')->0->>'value','Everyone','but their rows'' notes show');
select throws_ok($$select public.bi_write_set((select id from ids where name='app'),'w1','["FLT"]','Note','overwrite')$$,'42501',null,'and they cannot edit other rows');
select lives_ok($$select public.bi_write_set((select id from ids where name='app'),'w1','["BAT"]','Note','Reorder')$$,'but can edit their own');
select throws_ok($$select public.bi_get_row_access((select id from ids where name='app'))$$,'42501',null,'viewers cannot read the rules');

set local request.jwt.claims='{"sub":"80000000-0000-0000-0000-000000000003","role":"authenticated"}';
select is(pg_temp.sales_by_branch((select id from ids where name='app')),'[["Midrand", 150], ["Pretoria", 100]]'::jsonb,'a rule can allow several values');
set local request.jwt.claims='{"sub":"80000000-0000-0000-0000-000000000004","role":"authenticated"}';
select is(jsonb_array_length(pg_temp.sales_by_branch((select id from ids where name='app'))),3,'"all values" for a role sees everything');
reset role;
insert into public.profile_roles(profile_id,role_id) values ('80000000-0000-0000-0000-000000000005','management');
set local role authenticated;
set local request.jwt.claims='{"sub":"80000000-0000-0000-0000-000000000005","role":"authenticated"}';
select is(pg_temp.sales_by_branch((select id from ids where name='app')),'[]'::jsonb,'viewers without a rule see no data');
select is(public.bi_my_row_access((select id from ids where name='app')),'{"#deny": true}'::jsonb,'and are told so');
reset role;
-- a rule on a field that later leaves the model hides everything
update bi.row_rules set field='invoices.gone' where principal='80000000-0000-0000-0000-000000000002';
set local role authenticated;
set local request.jwt.claims='{"sub":"80000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is(pg_temp.sales_by_branch((select id from ids where name='app')),'[]'::jsonb,'a rule on a missing field fails closed');
reset role;
update bi.row_rules set field='invoices.branch' where principal='80000000-0000-0000-0000-000000000002';
delete from public.profile_roles where profile_id='80000000-0000-0000-0000-000000000005';

-- ---------------------------------------------------------------------------
-- Report schedules
-- ---------------------------------------------------------------------------
select is(bi.report_next_run('daily','07:00',null,null,'Africa/Johannesburg','2026-10-29 06:00+02'),'2026-10-29 07:00+02'::timestamptz,'daily: later today');
select is(bi.report_next_run('daily','07:00',null,null,'Africa/Johannesburg','2026-10-29 07:00+02'),'2026-10-30 07:00+02'::timestamptz,'daily: tomorrow once sent');
select is(bi.report_next_run('weekdays','07:00',null,null,'Africa/Johannesburg','2026-10-30 08:00+02'),'2026-11-02 07:00+02'::timestamptz,'weekdays skip the weekend');
select is(bi.report_next_run('weekly','16:30','{3}',null,'Africa/Johannesburg','2026-10-29 08:00+02'),'2026-11-04 16:30+02'::timestamptz,'weekly on Wednesdays');
select is(bi.report_next_run('monthly','06:00',null,31,'Africa/Johannesburg','2026-11-01 08:00+02'),'2026-11-30 06:00+02'::timestamptz,'monthly on the 31st uses the last day of shorter months');
select is(bi.report_next_run('daily','07:00',null,null,'Europe/London','2026-10-29 06:00+00'),'2026-10-29 07:00+00'::timestamptz,'in the schedule''s time zone');

set local role authenticated;
set local request.jwt.claims='{"sub":"80000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok($$select public.bi_list_reports((select id from ids where name='app'))$$,'42501',null,'viewers cannot manage report emails');
set local request.jwt.claims='{"sub":"80000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok($$select public.bi_save_report(jsonb_build_object('app_id',(select id from ids where name='app'),'name','X','sheet_ids','[]'::jsonb,'recipients','[{"type":"role","principal":"management"}]'::jsonb,'frequency','daily','send_time','07:00'))$$,
  '22023','Choose at least one sheet','a report needs sheets');
select throws_ok($$select public.bi_save_report(jsonb_build_object('app_id',(select id from ids where name='app'),'name','X','sheet_ids',jsonb_build_array(gen_random_uuid()),'recipients','[{"type":"role","principal":"management"}]'::jsonb,'frequency','daily','send_time','07:00'))$$,
  '22023',null,'from this app');
select throws_ok($$select public.bi_save_report(jsonb_build_object('app_id',(select id from ids where name='app'),'name','X','sheet_ids',jsonb_build_array((select id from ids where name='sheet1')),'recipients','[{"type":"role","principal":"management"}]'::jsonb,'frequency','daily','send_time','7am'))$$,
  '22023',null,'times are checked');
select throws_ok($$select public.bi_save_report(jsonb_build_object('app_id',(select id from ids where name='app'),'name','X','sheet_ids',jsonb_build_array((select id from ids where name='sheet1')),'recipients','[{"type":"role","principal":"management"}]'::jsonb,'frequency','weekly','send_time','07:00','weekdays','[]'::jsonb))$$,
  '22023',null,'weekly needs days');
select throws_ok($$select public.bi_save_report(jsonb_build_object('app_id',(select id from ids where name='app'),'name','X','sheet_ids',jsonb_build_array((select id from ids where name='sheet1')),'recipients','[{"type":"role","principal":"management"}]'::jsonb,'frequency','daily','send_time','07:00','timezone','Mars/Base'))$$,
  '22023',null,'time zones are checked');
select lives_ok($$insert into ids select 'report', public.bi_save_report(jsonb_build_object('app_id',(select id from ids where name='app'),'name','Daily branch sales',
  'sheet_ids',jsonb_build_array((select id from ids where name='sheet1'),(select id from ids where name='sheet2')),
  'recipients','[{"type":"role","principal":"management"},{"type":"user","principal":"80000000-0000-0000-0000-000000000005"}]'::jsonb,
  'frequency','weekdays','send_time','07:00','subject','Sales yesterday'))$$,'a report email is saved');
select ok((public.bi_list_reports((select id from ids where name='app'))->'schedules'->0->>'next_run_at')::timestamptz > now(),'with its next send time');
select is((public.bi_list_reports((select id from ids where name='app'))->'schedules'->0->>'recipient_count')::int,3,'two managers plus one named user');
select is(public.bi_send_report_now((select id from ids where name='report'), true),1,'a test goes to yourself only');
reset role;

-- make it due, then the sender claims it
update bi.report_schedules set next_run_at = now() - interval '1 minute' where id=(select id from ids where name='report');
set local role service_role;
create temporary table claimed as select public.bi_report_claim(10) as j;

reset role;
select is((select jsonb_array_length(j) from claimed),3,'the test plus one delivery per recipient who can open the app');
select is((select status from bi.report_deliveries where email='ra-nobody@test.invalid'),'skipped','someone without access to the app is skipped');
select ok((select next_run_at from bi.report_schedules where id=(select id from ids where name='report')) > now(),'the schedule moves to its next send time');
select is((select (j->0->>'is_test')::boolean from claimed),true,'tests go first');
select is((select jsonb_array_length(j->0->'sheets') from claimed),2,'each delivery has a ticket per sheet');
select is((select j->0->'sheets'->0->>'title' from claimed),'Overview','in the chosen order');
select is((select count(*) from bi.render_tickets),6::bigint,'tickets are stored');
select ok(not exists(select 1 from bi.render_tickets t, claimed c, jsonb_array_elements(c.j) d, jsonb_array_elements(d->'sheets') s where t.token_hash = s->>'ticket'),'only as hashes');
insert into tickets select case when d->>'email' like 'ra-centurion%' then 'centurion' when d->>'email' like 'ra-pretoria%' then 'pretoria' else 'test' end,
  d->'sheets'->0->>'ticket', (d->>'delivery_id')::uuid from claimed, jsonb_array_elements(j) d;
set local role service_role;
select is(public.bi_report_claim(10),'[]'::jsonb,'claimed deliveries are not handed out twice');
reset role;

-- rendering as the recipient
set local role anon;
set local request.jwt.claims='{"role":"anon"}';
select is(public.bi_render_query((select ticket from tickets where name='centurion'),'{"dimensions":[{"expr":{"t":"field","table":"invoices","name":"branch"}}]}')->'rows','[["Centurion"]]'::jsonb,
  'a ticket queries as its recipient, with their row access');
select is(public.bi_render_query((select ticket from tickets where name='pretoria'),'{"dimensions":[{"expr":{"t":"field","table":"invoices","name":"branch"}}]}')->'rows','[["Midrand"], ["Pretoria"]]'::jsonb,
  'each recipient gets their own data');
select is(public.bi_render_query((select ticket from tickets where name='test'),'{"dimensions":[{"expr":{"t":"field","table":"invoices","name":"branch"}}]}')->'rows','[["Centurion"], ["Midrand"], ["Pretoria"]]'::jsonb,
  'the builder''s test shows everything');
select is(public.bi_render_app((select ticket from tickets where name='centurion'))->'app'->>'name','Branch sales','the renderer loads the app');
select is(public.bi_render_app((select ticket from tickets where name='centurion'))->>'recipient','ra-centurion','and who it is for');
select is(jsonb_array_length(public.bi_render_write_get((select ticket from tickets where name='centurion'),'w1')),2,'write tables follow row access too');
select throws_ok($$select public.bi_render_query('not-a-ticket','{"dimensions":[{"expr":{"t":"field","table":"invoices","name":"branch"}}]}')$$,'42501',null,'made-up tickets are refused');
select throws_ok($$select public.bi_query((select id from ids where name='app'),'{"dimensions":[{"expr":{"t":"field","table":"invoices","name":"branch"}}]}')$$,'42501',null,'signed-out users still cannot query directly');
reset role;

update bi.render_tickets set expires_at = now() - interval '1 second' where delivery_id=(select delivery from tickets where name='pretoria');
set local role anon;
select throws_ok($$select public.bi_render_query((select ticket from tickets where name='pretoria'),'{"dimensions":[{"expr":{"t":"field","table":"invoices","name":"branch"}}]}')$$,'42501','This report link has expired','tickets expire');
reset role;

set local role service_role;
select lives_ok($$select public.bi_report_finish((select delivery from tickets where name='centurion'),'sent')$$,'the sender marks a delivery sent');
select lives_ok($$select public.bi_report_finish((select delivery from tickets where name='pretoria'),'retry','SMTP timeout')$$,'or to be retried');
reset role;
select is((select status from bi.report_deliveries where id=(select delivery from tickets where name='centurion')),'sent','sent');
select ok((select sent_at from bi.report_deliveries where id=(select delivery from tickets where name='centurion')) is not null,'with the time');
select is((select count(*) from bi.render_tickets where delivery_id=(select delivery from tickets where name='centurion')),0::bigint,'its tickets are removed');
select is((select status||':'||error from bi.report_deliveries where id=(select delivery from tickets where name='pretoria')),'pending:SMTP timeout','a retry goes back in the queue');
select ok((select lease_until from bi.report_deliveries where id=(select delivery from tickets where name='pretoria')) > now() + interval '4 minutes','after a pause');
set local role service_role;
select is(public.bi_report_claim(10),'[]'::jsonb,'so it is not retried straight away');
reset role;
update bi.report_deliveries set attempts=3, lease_until=null where id=(select delivery from tickets where name='pretoria');
set local role service_role;
select is(jsonb_array_length(public.bi_report_claim(10)),1,'and is claimed again');
select lives_ok($$select public.bi_report_finish((select delivery from tickets where name='pretoria'),'retry','SMTP timeout')$$,'after 3 attempts');
reset role;
select is((select status from bi.report_deliveries where id=(select delivery from tickets where name='pretoria')),'failed','it is given up');
-- a sender that dies half-way: the lease runs out and the delivery is retried
update bi.report_deliveries set lease_until = now() - interval '1 second' where id=(select delivery from tickets where name='test');
set local role service_role;
select is(public.bi_report_claim(10)->0->>'delivery_id',(select delivery::text from tickets where name='test'),'stalled deliveries are picked up again');
reset role;

-- (rendering set the recipient for the rest of its transaction; each web request is its own transaction)
set local request.jwt.claim.sub='';
set local role authenticated;
set local request.jwt.claims='{"sub":"80000000-0000-0000-0000-000000000001","role":"authenticated"}';
select ok(jsonb_array_length(public.bi_list_reports((select id from ids where name='app'))->'deliveries') >= 4,'the history shows deliveries');
select lives_ok($$select public.bi_delete_report((select id from ids where name='report'))$$,'a report email is deleted');
reset role;
select is((select count(*) from bi.report_deliveries where schedule_id=(select id from ids where name='report')),0::bigint,'with its history');

select * from finish();
rollback;
