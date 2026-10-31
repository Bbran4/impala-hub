begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,raw_user_meta_data) select ('13300000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,'manager-notify-'||i||'@test.invalid','{}' from generate_series(1,7)i;
insert into public.profile_roles(profile_id,role_id) select ('13300000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,case when i=1 then 'administrator' when i=2 then 'sales' else 'sales_manager' end from generate_series(1,7)i;
update public.profiles set active=false where id='13300000-0000-0000-0000-000000000007';
insert into public.application_user_permission_overrides(profile_id,app_id,permission_key,enabled) values
('13300000-0000-0000-0000-000000000004','sales_desk','sales_desk.receive_rfq_notifications',false),
('13300000-0000-0000-0000-000000000005','sales_desk','sales_desk.receive_invoice_notifications',false),
('13300000-0000-0000-0000-000000000006','sales_desk','sales_desk.view',false);
insert into public.sales_desk_sales_codes(id,code) values('13300000-0000-0000-0001-000000000001','NOTIFY-A');
update public.profiles set sales_code='NOTIFY-A' where id='13300000-0000-0000-0000-000000000002';
insert into public.sales_desk_statuses(id,name,is_closed,metric_category) values('13300000-0000-0000-0001-000000000002','Notification Complete',true,'completed');
set local request.jwt.claims='{"sub":"13300000-0000-0000-0000-000000000001","role":"authenticated"}';
create temp table notify_rfq as select (public.create_sales_desk_rfq(jsonb_build_object('customer_name','Manager notify','media_platform_id',(select id from public.sales_desk_media_platforms limit 1),'sales_code_id','13300000-0000-0000-0001-000000000001'))->>'id')::uuid id;
grant select on notify_rfq to authenticated;
select is((select count(*) from public.user_notifications where kind='rfq_created'),2::bigint,'only enabled active managers with view access receive new RFQ alerts');
select is((select count(*) from public.user_notifications where kind='rfq_created' and user_id='13300000-0000-0000-0000-000000000004'),0::bigint,'RFQ receive flag is enforced');
select is((select group_label from public.application_permission_catalog where permission_key='sales_desk.receive_rfq_notifications'),'Workspace','RFQ flag appears in Workspace permissions');
select is((select group_label from public.application_permission_catalog where permission_key='sales_desk.receive_invoice_notifications'),'Workspace','invoice flag appears in Workspace permissions');
select public.update_sales_desk_rfq((select id from notify_rfq),'{"remarks":"Please check"}');
select is((select count(*) from public.user_notifications where kind='rfq_updated'),2::bigint,'business changes alert enabled managers');
select public.update_sales_desk_rfq((select id from notify_rfq),'{"remarks":"Please check"}');
select is((select count(*) from public.user_notifications where kind='rfq_updated'),2::bigint,'unchanged save sends no duplicate general alerts');
-- A manager should not receive their own update.
set local request.jwt.claims='{"sub":"13300000-0000-0000-0000-000000000003","role":"authenticated"}';
select public.update_sales_desk_rfq((select id from notify_rfq),'{"remarks":"I checked"}');
select is((select count(*) from public.user_notifications where kind='rfq_updated' and user_id='13300000-0000-0000-0000-000000000003'),1::bigint,'actor does not receive their own business update');
set local request.jwt.claims='{"sub":"13300000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.update_sales_desk_rfq((select id from notify_rfq),'{"status_id":"13300000-0000-0000-0001-000000000002","document_number":"DOC-1"}');
insert into public.sales_desk_rfq_attachments(rfq_id,original_name,storage_path,content_type,size,uploaded_by) select id,'quote.pdf','13300000-0000-0000-0000-000000000002/'||id||'/quote.pdf','application/pdf',100,'13300000-0000-0000-0000-000000000002' from notify_rfq;
insert into storage.objects(bucket_id,name) select 'sales-desk-attachments',storage_path from public.sales_desk_rfq_attachments where rfq_id=(select id from notify_rfq);
create temp table general_count as select count(*) n from public.user_notifications where kind='rfq_updated';
set local role authenticated;
set local request.jwt.claims='{"sub":"13300000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.request_sales_desk_approval((select id from notify_rfq));
reset role;
select is((select count(*) from public.user_notifications where kind='rfq_updated'),(select n from general_count),'approval-only changes do not produce general alerts');
select is((select count(*) from public.user_notifications where kind='rfq_approval_requested' and user_id='13300000-0000-0000-0000-000000000004'),1::bigint,'RFQ opt-out does not suppress approval requests');
set local request.jwt.claims='{"sub":"13300000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.convert_sales_desk_rfq_to_invoice((select id from notify_rfq));
select public.convert_sales_desk_rfq_to_invoice((select id from notify_rfq));
select is((select count(*) from public.user_notifications where kind='rfq_converted_to_invoice'),2::bigint,'conversion alerts enabled managers once despite retry');
select is((select count(*) from public.user_notifications where kind='rfq_converted_to_invoice' and user_id='13300000-0000-0000-0000-000000000004'),1::bigint,'invoice alerts remain enabled when general RFQ alerts are disabled');
select is((select count(*) from public.user_notifications where kind='rfq_converted_to_invoice' and user_id='13300000-0000-0000-0000-000000000005'),0::bigint,'invoice-specific opt-out is respected');
select ok(not exists(select 1 from public.user_notifications n join public.sales_desk_rfqs r on r.id=n.target_record_id where n.kind='rfq_converted_to_invoice' and r.rfq_type<>'invoice'),'conversion alerts link to invoice copy');
select is((select count(*) from public.user_notifications where kind='rfq_updated'),(select n from general_count),'conversion does not also send a general update alert');
select is((select count(*) from public.user_notifications where kind='rfq_created'),2::bigint,'invoice copy does not generate new RFQ alert');
-- Role defaults remain editable and user overrides take precedence.
delete from public.application_role_permissions where role_id='sales_manager' and permission_key='sales_desk.receive_rfq_notifications';
insert into public.application_user_permission_overrides(profile_id,app_id,permission_key,enabled) values('13300000-0000-0000-0000-000000000003','sales_desk','sales_desk.receive_rfq_notifications',true);
select is((select count(*) from public.rfq_notification_managers('sales_desk.receive_rfq_notifications')),1::bigint,'user allow overrides a disabled role default');
select public.update_sales_desk_rfq((select id from notify_rfq),'{"remarks":"Explicit recipient"}');
select is((select count(*) from public.user_notifications where kind='rfq_updated'),(select n+1 from general_count),'changed role default controls subsequent events');
select ok(not has_function_privilege('authenticated','public.notify_sales_desk_managers()','execute'),'browser cannot call notification trigger directly');
-- Conversion, its invoice copy, audit and notification are one transaction.
create temp table notification_failure_rfq as select (public.create_sales_desk_rfq(jsonb_build_object('customer_name','Notification rollback','media_platform_id',(select id from public.sales_desk_media_platforms limit 1),'status_id','13300000-0000-0000-0001-000000000002'))->>'id')::uuid id;
create function pg_temp.fail_invoice_notification() returns trigger language plpgsql as $$begin if new.kind='rfq_converted_to_invoice' then raise exception 'test invoice notification failure';end if;return new;end$$;
create trigger fail_invoice_notification before insert on public.user_notifications for each row execute function pg_temp.fail_invoice_notification();
select throws_ok($$select public.convert_sales_desk_rfq_to_invoice((select id from notification_failure_rfq))$$,'P0001','test invoice notification failure','notification failure aborts the conversion');
select is((select converted_at from public.sales_desk_rfqs where id=(select id from notification_failure_rfq)),null::timestamptz,'failed notification leaves quotation unconverted');
select is((select count(*) from public.sales_desk_rfqs where original_rfq_no=(select rfq_no from public.sales_desk_rfqs where id=(select id from notification_failure_rfq))),0::bigint,'failed notification leaves no invoice copy');
select is((select count(*) from public.sales_desk_rfq_audit where rfq_id=(select id from notification_failure_rfq) and action='invoice_copy_created'),0::bigint,'failed conversion leaves no misleading conversion audit');
select * from finish();
rollback;
