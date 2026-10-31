begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,raw_user_meta_data) select
 ('12500000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,'approval-'||i||'@test.invalid','{}'
from generate_series(1,8)i;
insert into public.profile_roles(profile_id,role_id) select
 ('12500000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,
 case when i=1 then 'administrator' when i in (2,3) then 'sales' else 'sales_manager' end from generate_series(1,8)i;
insert into public.profile_roles values('12500000-0000-0000-0000-000000000005','management');
update public.profiles set active=false where id='12500000-0000-0000-0000-000000000006';
insert into public.application_user_permission_overrides(profile_id,app_id,permission_key,enabled) values
('12500000-0000-0000-0000-000000000007','sales_desk','sales_desk.approve',false),
('12500000-0000-0000-0000-000000000008','sales_desk','sales_desk.view',false);
insert into public.sales_desk_sales_codes(id,code) values
('12500000-0000-0000-0001-000000000001','AP-A'),('12500000-0000-0000-0001-000000000002','AP-B');
update public.profiles set sales_code='AP-A' where id='12500000-0000-0000-0000-000000000002';
update public.profiles set sales_code='AP-B' where id='12500000-0000-0000-0000-000000000003';
insert into public.sales_desk_statuses(id,name,is_closed,metric_category) values
('12500000-0000-0000-0001-000000000003','Approval Complete',true,'completed');
set local request.jwt.claims='{"sub":"12500000-0000-0000-0000-000000000001","role":"authenticated"}';
create temp table approval_cases(label text,id uuid);
grant select on approval_cases to authenticated;
insert into approval_cases select label,(public.create_sales_desk_rfq(jsonb_build_object(
 'customer_name',label,'media_platform_id',(select id from public.sales_desk_media_platforms limit 1),
 'sales_code_id','12500000-0000-0000-0001-000000000001',
 'status_id','12500000-0000-0000-0001-000000000003','document_number','DOC-1'))->>'id')::uuid
from unnest(array['Approval main','Approval no-file']) label;
insert into public.sales_desk_rfq_attachments(rfq_id,original_name,storage_path,content_type,size,uploaded_by)
select id,'quote.pdf','12500000-0000-0000-0000-000000000002/'||id||'/quote.pdf','application/pdf',100,
'12500000-0000-0000-0000-000000000002' from approval_cases where label='Approval main';
insert into storage.objects(bucket_id,name) select 'sales-desk-attachments',storage_path
from public.sales_desk_rfq_attachments where rfq_id in(select id from approval_cases);

update public.sales_desk_rfqs set status_id=(select id from public.sales_desk_statuses where semantic_key='in_progress'),document_number='' where id in(select id from approval_cases);
set local role authenticated;
set local request.jwt.claims='{"sub":"12500000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok($$select public.submit_sales_desk_rfq_for_approval((select id from approval_cases where label='Approval main'),'{"status_id":"12500000-0000-0000-0001-000000000003","remarks":"Incomplete"}')$$,'22023',null,'missing document number prevents submission');
select is((select approval_state from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'not_requested','failed submission leaves approval unchanged');
select is((select remarks from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'','failed submission rolls back unsaved remarks');
select is((select completed_at from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),null::timestamptz,'failed submission rolls back the completed status and timestamp');
select public.submit_sales_desk_rfq_for_approval((select id from approval_cases where label='Approval main'),'{"status_id":"12500000-0000-0000-0001-000000000003","document_number":"DOC-NEW","remarks":"Ready"}');
select is((select status_id from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'12500000-0000-0000-0001-000000000003'::uuid,'consultant status edit persists in the submission');
select ok((select completed_at is not null from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'consultant completing an RFQ records completion automatically');
select is((select document_number from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'DOC-NEW','submission saves document number');
select is((select remarks from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'Ready','submission saves remarks');
select is((select approval_state from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'pending','same action sends request to managers');
select public.submit_sales_desk_rfq_for_approval((select id from approval_cases where label='Approval main'),'{"status_id":"12500000-0000-0000-0001-000000000003","document_number":"DOC-NEW","remarks":"Ready"}');
select is((select count(*) from public.sales_desk_rfq_audit where rfq_id=(select id from approval_cases where label='Approval main') and action='approval_requested'),1::bigint,'retry does not duplicate approval audit');
select throws_ok(format('select public.submit_sales_desk_rfq_for_approval(%L,%L::jsonb)',
 (select id from approval_cases where label='Approval main'),jsonb_build_object('status_id',(select id from public.sales_desk_statuses where semantic_key='in_progress'))),
 '22023',null,'changing away from Completed cannot be submitted for approval');
select is((select approval_state from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'pending','invalid submission cannot change the existing request');
select is((select count(*) from public.sales_desk_rfq_audit where rfq_id=(select id from approval_cases where label='Approval main') and action='approval_requested'),1::bigint,'invalid status sends no new approval event');
select throws_ok($$select public.submit_sales_desk_rfq_for_approval((select id from approval_cases where label='Approval no-file'),'{"status_id":"12500000-0000-0000-0001-000000000003","document_number":"MISSING-FILE"}')$$,'22023',null,'submission still requires uploaded evidence');
select is((select document_number from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval no-file')),'','missing attachment rolls back all submitted edits');
select throws_ok($$select public.submit_sales_desk_rfq_for_approval((select id from approval_cases where label='Approval main'),'{"received_at":"2020-01-01"}')$$,'42501',null,'submission does not broaden consultant field permissions');
set local request.jwt.claims='{"sub":"12500000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok($$select public.submit_sales_desk_rfq_for_approval((select id from approval_cases where label='Approval main'),'{"remarks":"Not mine"}')$$,'42501',null,'another consultant cannot submit or edit this RFQ');
reset role;
select is((select count(*) from public.user_notifications where kind='rfq_approval_requested' and target_record_id=(select id from approval_cases where label='Approval main')),2::bigint,'one submission alerts all eligible managers once');
insert into public.application_user_permission_overrides(profile_id,app_id,permission_key,enabled) values('12500000-0000-0000-0000-000000000002','sales_desk','sales_desk.request_approval',false);
set local role authenticated;
set local request.jwt.claims='{"sub":"12500000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok($$select public.submit_sales_desk_rfq_for_approval((select id from approval_cases where label='Approval main'),'{"remarks":"Denied edit"}')$$,'42501',null,'request permission remains enforced');
select is((select remarks from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'Ready','denied approval also rolls back business edits');
reset role;
select ok(not has_function_privilege('anon','public.submit_sales_desk_rfq_for_approval(uuid,jsonb)','execute'),'signed out users cannot submit');
select * from finish();
rollback;
