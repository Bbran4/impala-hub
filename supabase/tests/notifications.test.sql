begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ('00000000-0000-0000-0000-000000000000','91000000-0000-0000-0000-000000000001','authenticated','authenticated','notifications-admin@test.invalid','',now(),'{}','{"display_name":"Notification Admin"}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','91000000-0000-0000-0000-000000000002','authenticated','authenticated','notifications-sales-one@test.invalid','',now(),'{}','{"display_name":"Sales One"}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','91000000-0000-0000-0000-000000000003','authenticated','authenticated','notifications-sales-two@test.invalid','',now(),'{}','{"display_name":"Sales Two"}',now(),now());

insert into public.profile_roles (profile_id, role_id) values
  ('91000000-0000-0000-0000-000000000001','administrator'),
  ('91000000-0000-0000-0000-000000000002','sales'),
  ('91000000-0000-0000-0000-000000000003','sales');

update public.profiles set display_name = 'Sales One', sales_code = 'NT01' where id = '91000000-0000-0000-0000-000000000002';
update public.profiles set display_name = 'Sales Two', sales_code = 'NT02' where id = '91000000-0000-0000-0000-000000000003';

select ok(not has_table_privilege('anon','public.user_notifications','select'), 'signed-out users cannot read notifications');
select ok(not has_table_privilege('authenticated','public.user_notifications','insert'), 'browser users cannot create notifications');
select ok(not has_table_privilege('authenticated','public.user_notifications','update'), 'browser users cannot rewrite notification content');
select ok(has_function_privilege('authenticated','public.mark_user_notification_read(uuid)','execute'), 'signed-in users can call the narrow mark-read RPC');
select ok(has_function_privilege('authenticated','public.user_notification_unread_counts()','execute'), 'signed-in users can read their own unread counts');
select ok(not has_function_privilege('anon','public.mark_user_notification_read(uuid)','execute'), 'signed-out users cannot mark notifications read');

set local role authenticated;
set local request.jwt.claims = '{"sub":"91000000-0000-0000-0000-000000000001","role":"authenticated"}';
-- Seed a known RFQ as the database owner; browser writes now use RPCs.
reset role;
insert into public.sales_desk_rfqs (
  id, rfq_no, business_date, daily_number, media_platform_id, customer_name,
  query_information, sales_code_id, status_id, created_by, updated_by
)
select
  '92000000-0000-0000-0000-000000000001', 'IMP99123199', '2099-12-31', 99,
  (select id from public.sales_desk_media_platforms order by sort_order limit 1),
  'Notification Customer', 'Needs a quotation for test parts',
  (select id from public.sales_desk_sales_codes where code = 'NT01'),
  (select id from public.sales_desk_statuses where lower(name) = 'new'),
  auth.uid(), auth.uid();

set local role authenticated;
select public.update_sales_desk_rfq('92000000-0000-0000-0000-000000000001',jsonb_build_object(
  'status_id',(select id from public.sales_desk_statuses where semantic_key='in_progress')));
reset role;

select is((select count(*) from public.user_notifications where user_id = '91000000-0000-0000-0000-000000000002'), 1::bigint, 'entering In Progress creates one notification for the assigned salesperson');
select is((select title from public.user_notifications where user_id = '91000000-0000-0000-0000-000000000002'), 'RFQ in progress: IMP99123199', 'notification contains the RFQ reference');
select is((select target_record_id from public.user_notifications where user_id = '91000000-0000-0000-0000-000000000002'), '92000000-0000-0000-0000-000000000001'::uuid, 'notification stores the exact RFQ destination');

set local role authenticated;
set local request.jwt.claims = '{"sub":"91000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((select count(*) from public.user_notifications), 1::bigint, 'recipient can read their notification');
select ok(public.mark_user_notification_read((select id from public.user_notifications limit 1)), 'recipient can mark their notification read');
select ok((select read_at is not null from public.user_notifications limit 1), 'read state is persisted');
select throws_ok($sql$
  update public.sales_desk_rfqs
  set sales_code_id = (select id from public.sales_desk_sales_codes where code = 'NT02'), updated_by = auth.uid()
  where id = '92000000-0000-0000-0000-000000000001'
$sql$, '42501', null, 'an assigned salesperson cannot reassign an RFQ through the data API');
update public.profiles set sales_code = null where id = auth.uid();
select throws_ok($sql$
  update public.sales_desk_rfqs
  set sales_code_id = (select id from public.sales_desk_sales_codes where code = 'NT02'), updated_by = auth.uid()
  where id = '92000000-0000-0000-0000-000000000001'
$sql$, '42501', null, 'clearing a profile sales code does not grant manager reassignment authority');
update public.profiles set sales_code = 'NT01' where id = auth.uid();
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"91000000-0000-0000-0000-000000000003","role":"authenticated"}';
select is((select count(*) from public.user_notifications), 0::bigint, 'another salesperson cannot read the notification');
select ok(not public.mark_user_notification_read((select id from public.user_notifications where user_id = '91000000-0000-0000-0000-000000000002' limit 1)), 'another salesperson cannot mark it read');
reset role;

-- A no-op status write must not duplicate the event.
set local role authenticated;
set local request.jwt.claims = '{"sub":"91000000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.update_sales_desk_rfq('92000000-0000-0000-0000-000000000001',jsonb_build_object(
  'status_id',(select status_id from public.sales_desk_rfqs where id='92000000-0000-0000-0000-000000000001')));
reset role;
select is((select count(*) from public.user_notifications where target_record_id = '92000000-0000-0000-0000-000000000001'), 1::bigint, 'a no-op status write does not duplicate the notification');

create temporary table hidden_notification_id (id uuid primary key) on commit drop;
insert into hidden_notification_id
select id from public.user_notifications where user_id = '91000000-0000-0000-0000-000000000002';

grant select on pg_temp.hidden_notification_id to authenticated;

-- Reassignment creates a notification for the new owner and hides stale RFQ details from the former owner.
set local role authenticated;
set local request.jwt.claims = '{"sub":"91000000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.update_sales_desk_rfq('92000000-0000-0000-0000-000000000001',jsonb_build_object(
  'sales_code_id',(select id from public.sales_desk_sales_codes where code='NT02')));
reset role;

select is((select count(*) from public.user_notifications where target_record_id = '92000000-0000-0000-0000-000000000001'), 2::bigint, 'reassignment creates one notification for the new owner');
set local role authenticated;
set local request.jwt.claims = '{"sub":"91000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((select count(*) from public.user_notifications), 0::bigint, 'former owner can no longer read stale RFQ notification details');
select ok(not public.mark_user_notification_read((select id from pg_temp.hidden_notification_id)), 'former owner cannot mutate a notification hidden after reassignment');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"91000000-0000-0000-0000-000000000003","role":"authenticated"}';
select is((select count(*) from public.user_notifications), 1::bigint, 'new owner can read the reassignment notification');
select is(public.mark_all_user_notifications_read('sales_desk'), 1, 'new owner can mark the channel read');
reset role;

select * from finish();
rollback;
