begin;

create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','86000000-0000-0000-0000-000000000001','authenticated','authenticated','rx-builder@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','86000000-0000-0000-0000-000000000002','authenticated','authenticated','rx-viewer@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','86000000-0000-0000-0000-000000000003','authenticated','authenticated','rx-viewer2@test.invalid','',now(),'{}','{}',now(),now());
insert into public.profile_roles(profile_id,role_id) values
('86000000-0000-0000-0000-000000000001','report_builder'),('86000000-0000-0000-0000-000000000002','management'),('86000000-0000-0000-0000-000000000003','management');

create table bi_data.x_stock(item text, branch text, on_hand bigint, reorder bigint);
insert into bi_data.x_stock values ('BRK','Centurion',2,5),('BRK','Pretoria',9,5),('FLT','Centurion',20,5),('BAT','Pretoria',1,2);
insert into bi.data_tables(table_name,columns,row_count,last_loaded_at) values
('x_stock','[{"name":"item","type":"text"},{"name":"branch","type":"text"},{"name":"on_hand","type":"bigint"},{"name":"reorder","type":"bigint"}]',4,now());

create temporary table ids(name text primary key, id uuid);
create temporary table claimed(j jsonb);
grant all on ids, claimed to authenticated, anon, service_role;

set local role authenticated;
set local request.jwt.claims='{"sub":"86000000-0000-0000-0000-000000000001","role":"authenticated"}';
insert into ids select 'app', public.bi_save_app('{"name":"Stock","model":[{"alias":"stock","table_name":"x_stock"}],"access":[{"type":"role","principal":"management"}]}'::jsonb);
insert into ids select 'sheet', public.bi_save_sheet(jsonb_build_object('app_id',(select id from ids where name='app'),'title','Stock','objects','[]'::jsonb));
insert into ids select 'bm', public.bi_save_bookmark(jsonb_build_object('app_id',(select id from ids where name='app'),'name','Centurion','shared',true,
  'selections','[{"key":"stock.branch","label":"Branch","node":{"t":"field","name":"branch"},"values":["Centurion"]}]'::jsonb));

-- a report with a filter and an Excel attachment
select lives_ok($$insert into ids select 'report', public.bi_save_report(jsonb_build_object('app_id',(select id from ids where name='app'),'name','Centurion stock',
  'sheet_ids',jsonb_build_array((select id from ids where name='sheet')),'recipients','[{"type":"role","principal":"management"}]'::jsonb,
  'frequency','daily','send_time','07:00','bookmark_id',(select id from ids where name='bm'),'attach_excel',true,
  'conditions','[{"text":"on_hand > 0","node":{"t":"bin","op":">","l":{"t":"field","name":"on_hand"},"r":{"t":"num","v":0}}}]'::jsonb))$$,
  'a report email with a bookmark, a condition and Excel');
select throws_ok($$select public.bi_save_report(jsonb_build_object('app_id',(select id from ids where name='app'),'name','X','sheet_ids','[]'::jsonb,
  'recipients','[{"type":"role","principal":"management"}]'::jsonb,'frequency','daily','send_time','07:00'))$$, '22023', 'Choose at least one sheet', 'reports still need a sheet');
select throws_ok($$select public.bi_save_report(jsonb_build_object('app_id',(select id from ids where name='app'),'name','X','kind','alert','sheet_ids','[]'::jsonb,
  'recipients','[{"type":"role","principal":"management"}]'::jsonb,'frequency','daily','send_time','07:00','alert','{"op":">","value":1}'::jsonb))$$, '22023', null, 'alerts need a measure');
select throws_ok($$select public.bi_save_report(jsonb_build_object('app_id',(select id from ids where name='app'),'name','X','sheet_ids',jsonb_build_array((select id from ids where name='sheet')),
  'recipients','[{"type":"role","principal":"management"}]'::jsonb,'frequency','daily','send_time','07:00','bookmark_id',gen_random_uuid()))$$, '22023', null, 'bookmarks must be of this app');

-- an alert: items per branch below their reorder level
select lives_ok($$insert into ids select 'alert', public.bi_save_report(jsonb_build_object('app_id',(select id from ids where name='app'),'name','Reorder',
  'kind','alert','sheet_ids','[]'::jsonb,'recipients','[{"type":"role","principal":"management"}]'::jsonb,'frequency','weekdays','send_time','06:00',
  'alert',jsonb_build_object('label','Short by','dimension',jsonb_build_object('text','item','node','{"t":"field","name":"item"}'::jsonb),
    'measure',jsonb_build_object('text','Sum(reorder - on_hand)','node','{"t":"fn","name":"sum","args":[{"t":"bin","op":"-","l":{"t":"field","name":"reorder"},"r":{"t":"field","name":"on_hand"}}]}'::jsonb),
    'op','>','value',0)))$$, 'an alert is saved');
select is((public.bi_list_reports((select id from ids where name='app'))->'schedules'->1->>'kind'), 'alert', 'and listed as an alert');

-- viewers subscribe themselves and opt out of builders' emails
set local request.jwt.claims='{"sub":"86000000-0000-0000-0000-000000000002","role":"authenticated"}';
select lives_ok($$insert into ids select 'sub', public.bi_subscribe(jsonb_build_object('app_id',(select id from ids where name='app'),'name','My stock',
  'sheet_ids',jsonb_build_array((select id from ids where name='sheet')),'frequency','weekly','weekdays','[1]'::jsonb,'send_time','08:00'))$$, 'a viewer subscribes to a sheet');
reset role;
select is((select recipients from bi.report_schedules where id=(select id from ids where name='sub')), '[{"type": "user", "principal": "86000000-0000-0000-0000-000000000002"}]'::jsonb, 'only to themselves');
set local role authenticated;
set local request.jwt.claims='{"sub":"86000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok($$select public.bi_save_report(jsonb_build_object('app_id',(select id from ids where name='app'),'name','X','sheet_ids',jsonb_build_array((select id from ids where name='sheet')),
  'recipients','[{"type":"role","principal":"management"}]'::jsonb,'frequency','daily','send_time','07:00'))$$, '42501', null, 'viewers cannot email others');
select is(jsonb_array_length(public.bi_my_report_emails((select id from ids where name='app'))), 3, 'viewers see their subscription and the emails sent to them');
select lives_ok($$select public.bi_set_report_optout((select id from ids where name='report'), true)$$, 'a viewer stops a builder''s email');
select is((select (e->>'opted_out')::boolean from jsonb_array_elements(public.bi_my_report_emails((select id from ids where name='app'))) e where e->>'id'=(select id::text from ids where name='report')), true, 'and sees that');
select is(public.bi_send_report_now((select id from ids where name='sub'), true), 1, 'a test of their own subscription');
select throws_ok($$select public.bi_send_report_now((select id from ids where name='report'), true)$$, '42501', null, 'but not of builders'' emails');
set local request.jwt.claims='{"sub":"86000000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok($$select public.bi_unsubscribe((select id from ids where name='sub'))$$, 'P0002', null, 'nobody else can remove a subscription');
reset role;

-- sending
update bi.report_schedules set next_run_at = now() - interval '1 minute' where id in ((select id from ids where name='report'),(select id from ids where name='alert'));
set local role service_role;
insert into claimed select public.bi_report_claim(20);
reset role;
select is((select count(*) from bi.report_deliveries where schedule_id=(select id from ids where name='report')), 1::bigint, 'the opted-out viewer gets no delivery');
select is((select count(*) from claimed, jsonb_array_elements(j) d where d->>'kind'='alert'), 2::bigint, 'each recipient gets the alert checked');
select ok((select bool_and(d->>'alert_ticket' is not null and jsonb_array_length(d->'sheets') = 0) from claimed, jsonb_array_elements(j) d where d->>'kind'='alert'), 'with an alert ticket and no sheets');
select is((select (d->>'attach_excel')::boolean from claimed, jsonb_array_elements(j) d where d->>'kind'='report' and not (d->>'is_test')::boolean), true, 'reports say whether to attach Excel');

set local role anon;
select is((select public.bi_render_app(d->'sheets'->0->>'ticket')->'filter'->'selections'->0->'values' from claimed, jsonb_array_elements(j) d where d->>'kind'='report' and not (d->>'is_test')::boolean),
  '["Centurion"]'::jsonb, 'the renderer gets the bookmark''s selections');
select is((select jsonb_array_length(public.bi_render_app(d->'sheets'->0->>'ticket')->'filter'->'conditions') from claimed, jsonb_array_elements(j) d where d->>'kind'='report' and not (d->>'is_test')::boolean),
  1, 'and the conditions');
select is((select public.bi_render_alert(d->>'alert_ticket')->'rows' from claimed, jsonb_array_elements(j) d where d->>'kind'='alert' limit 1),
  '[["BAT", 1]]'::jsonb, 'the alert lists the items short of their reorder level (all branches together)');
reset role;

-- not met: everything in stock
update bi_data.x_stock set on_hand = 50;
set local role anon;
select is((select public.bi_render_alert(d->>'alert_ticket')->'matched' from claimed, jsonb_array_elements(j) d where d->>'kind'='alert' limit 1), 'false'::jsonb, 'no rows when the condition is not met');
reset role;
set local role service_role;
select lives_ok($$select public.bi_report_finish((select (d->>'delivery_id')::uuid from claimed, jsonb_array_elements(j) d where d->>'kind'='alert' limit 1), 'not_needed')$$, 'the sender records that nothing was needed');
reset role;
select is((select status from bi.report_deliveries where schedule_id=(select id from ids where name='alert') and status='not_needed'), 'not_needed', 'shown as not needed');

set local role authenticated;
set local request.jwt.claims='{"sub":"86000000-0000-0000-0000-000000000002","role":"authenticated"}';
select lives_ok($$select public.bi_unsubscribe((select id from ids where name='sub'))$$, 'a viewer removes their subscription');
reset role;

select * from finish();
rollback;
