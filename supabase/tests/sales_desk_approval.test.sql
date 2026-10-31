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
create temp table original_dates as select id,received_at,claimed_at from public.sales_desk_rfqs where id in(select id from approval_cases);
grant select on original_dates to authenticated;
create function pg_temp.fail_approval_notification() returns trigger language plpgsql as $$
begin if new.kind='rfq_approval_requested' and current_setting('test.fail_notification',true)='on' then raise exception 'test notification failure';end if;return new;end$$;
create trigger test_fail_approval_notification before insert on public.user_notifications for each row execute function pg_temp.fail_approval_notification();
create function pg_temp.fail_approval_audit() returns trigger language plpgsql as $$
begin if new.action='approval_requested' and current_setting('test.fail_audit',true)='on' then raise exception 'test audit failure';end if;return new;end$$;
create trigger test_fail_approval_audit before insert on public.sales_desk_rfq_audit for each row execute function pg_temp.fail_approval_audit();

set local role authenticated;
set local request.jwt.claims='{"sub":"12500000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok(format('select public.update_sales_desk_rfq(%L,%L::jsonb)',(select id from approval_cases where label='Approval main'),jsonb_build_object(field,value)),
 '42501',null,'consultants cannot change '||field)
from (values('customer_name','Forged'),('contact_number','999'),('email_address','fake@test.invalid'),('query_information','Forged'),
 ('received_at','2020-01-01'),('claimed_at','2020-01-01'),('sales_code_id','12500000-0000-0000-0001-000000000002'),
 ('media_platform_id','12500000-0000-0000-0001-000000000003')) fields(field,value);
select lives_ok($$select public.update_sales_desk_rfq((select id from approval_cases where label='Approval main'),
 '{"status_id":"12500000-0000-0000-0001-000000000003","document_number":"DOC-2","remarks":"Ready for review"}')$$,'consultants can save status, document number and remarks');
select ok(not exists(select 1 from public.sales_desk_rfqs r join original_dates d using(id)
 where (r.received_at,r.claimed_at) is distinct from (d.received_at,d.claimed_at)),'consultant edits preserve metric timestamps');
select throws_ok($$select public.update_sales_desk_rfq((select id from approval_cases where label='Approval main'),'{"approval_state":"approved"}')$$,'22023',null,'browser commands cannot forge approval fields');
select throws_ok($$select public.request_sales_desk_approval((select id from approval_cases where label='Approval no-file'))$$,'22023',null,'approval requires a real uploaded attachment');
select public.update_sales_desk_rfq((select id from approval_cases where label='Approval main'),'{"document_number":""}');
select throws_ok($$select public.request_sales_desk_approval((select id from approval_cases where label='Approval main'))$$,'22023',null,'approval requires a document number');
select public.update_sales_desk_rfq((select id from approval_cases where label='Approval main'),'{"document_number":"DOC-2"}');
set local request.jwt.claims='{"sub":"12500000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok($$select public.request_sales_desk_approval((select id from approval_cases where label='Approval main'))$$,'42501',null,'another consultant cannot submit the RFQ');
set local request.jwt.claims='{"sub":"12500000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.request_sales_desk_approval((select id from approval_cases where label='Approval main'));
select is((select approval_state from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'pending','approval submission persists pending state');
select is((public.sales_desk_rfq_page('{"approval":"pending","search":"Approval main"}')->>'total')::integer,1,'pending approvals are searchable across the full list');
select is((public.sales_desk_session_context()->>'can_request_approval')::boolean,true,'consultant session exposes request capability');
select is((public.sales_desk_session_context()->>'can_approve')::boolean,false,'consultant session does not expose manager review capability');
select is((select count(*) from public.user_notifications where kind='rfq_approval_requested'),0::bigint,'consultants cannot read manager notifications');
select is((select count(*) from public.sales_desk_rfq_audit where rfq_id=(select id from approval_cases where label='Approval main') and action='approval_requested'),1::bigint,'submission is audited once');
select public.request_sales_desk_approval((select id from approval_cases where label='Approval main'));
select is((select count(*) from public.sales_desk_rfq_audit where rfq_id=(select id from approval_cases where label='Approval main') and action='approval_requested'),1::bigint,'duplicate submission is idempotent');
select throws_ok($$select public.review_sales_desk_approval((select id from approval_cases where label='Approval main'),1,'approved','')$$,'42501',null,'consultants cannot approve requests');
reset role;
select is((select count(*) from public.user_notifications where kind='rfq_approval_requested' and target_record_id=(select id from approval_cases where label='Approval main')),2::bigint,'all eligible active Sales Managers receive one notification');
select ok(not exists(select 1 from public.user_notifications where kind='rfq_approval_requested' and user_id in
 ('12500000-0000-0000-0000-000000000006','12500000-0000-0000-0000-000000000007','12500000-0000-0000-0000-000000000008')),'inactive or permission-denied managers receive no notification');
insert into public.profile_roles values('12500000-0000-0000-0000-000000000002','sales_manager');
set local role authenticated;
select throws_ok($$select public.review_sales_desk_approval((select id from approval_cases where label='Approval main'),1,'approved','')$$,'42501',null,'a manager cannot approve their own submitted request');
reset role;
delete from public.profile_roles where profile_id='12500000-0000-0000-0000-000000000002' and role_id='sales_manager';
set local role authenticated;
set local request.jwt.claims='{"sub":"12500000-0000-0000-0000-000000000005","role":"authenticated"}';
select is(public.sales_desk_session_context()->>'role','manager','an assigned Sales Manager role overrides inherited Management read-only display');
select throws_ok($$select public.review_sales_desk_approval((select id from approval_cases where label='Approval main'),999,'approved','')$$,'40001',null,'stale review revisions are rejected');
select throws_ok($$select public.review_sales_desk_approval((select id from approval_cases where label='Approval main'),1,'changes_requested','')$$,'22023',null,'returned requests require a review note');
select public.review_sales_desk_approval((select id from approval_cases where label='Approval main'),1,'changes_requested','Please attach the correct quotation');
select is((select approval_state from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'changes_requested','manager can return an RFQ for changes');
select throws_ok($$select public.review_sales_desk_approval((select id from approval_cases where label='Approval main'),1,'approved','')$$,'40001',null,'a second manager decision cannot overwrite the first');
reset role;
select is((select count(*) from public.user_notifications where kind='rfq_approval_requested' and read_at is null),0::bigint,'decision clears the other manager alerts');
select is((select count(*) from public.user_notifications where kind='rfq_approval_changes_requested' and user_id='12500000-0000-0000-0000-000000000002'),1::bigint,'consultant receives the requested-changes notification');
set local role authenticated;
set local request.jwt.claims='{"sub":"12500000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.update_sales_desk_rfq((select id from approval_cases where label='Approval main'),'{"remarks":"Corrected quotation"}');
select is((select approval_state from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'not_requested','editing returns an old decision to resubmission');
select public.request_sales_desk_approval((select id from approval_cases where label='Approval main'));
set local request.jwt.claims='{"sub":"12500000-0000-0000-0000-000000000004","role":"authenticated"}';
select public.review_sales_desk_approval((select id from approval_cases where label='Approval main'),
 (select approval_revision from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'approved','Checked quotation');
select is((select approval_state from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'approved','Sales Manager approval persists');
select is((public.sales_desk_rfq_page('{"approval":"approved","search":"Approval main"}')->>'total')::integer,1,'approved filter uses persisted approval state');
select is((select count(*) from public.sales_desk_rfqs where original_rfq_no=(select rfq_no from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main'))),0::bigint,'approval does not create an invoice');
select is((select count(*) from public.sales_desk_rfq_audit where rfq_id=(select id from approval_cases where label='Approval main') and action='approval_approved'),1::bigint,'approval is audited exactly once');
reset role;
select is((select count(*) from public.user_notifications where kind='rfq_approval_approved' and user_id='12500000-0000-0000-0000-000000000002'),1::bigint,'consultant receives confirmation of approval');
delete from public.sales_desk_rfq_attachments where rfq_id=(select id from approval_cases where label='Approval main');
select is((select approval_state from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'not_requested','attachment deletion invalidates approval');
insert into public.sales_desk_rfq_attachments(rfq_id,original_name,storage_path,content_type,size,uploaded_by)
select id,'quote.pdf','12500000-0000-0000-0000-000000000002/'||id||'/quote.pdf','application/pdf',100,
'12500000-0000-0000-0000-000000000002' from approval_cases where label='Approval main';
set local role authenticated;
set local request.jwt.claims='{"sub":"12500000-0000-0000-0000-000000000002","role":"authenticated"}';
set local test.fail_notification='on';
select throws_ok($$select public.request_sales_desk_approval((select id from approval_cases where label='Approval main'))$$,'P0001',null,'notification failure rolls back the entire submission');
set local test.fail_notification='off';
select is((select approval_state from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'not_requested','failed notification leaves no pending request');
set local test.fail_audit='on';
select throws_ok($$select public.request_sales_desk_approval((select id from approval_cases where label='Approval main'))$$,'P0001',null,'audit failure rolls back the entire submission');
set local test.fail_audit='off';
select is((select approval_state from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'not_requested','failed audit leaves no pending request');
select ok(not has_function_privilege('anon','public.request_sales_desk_approval(uuid)','execute'),'anonymous submission is denied');
select ok(not has_function_privilege('authenticated','public.sales_desk_approval_recipients()','execute'),'recipient lookup is server-only');
select public.request_sales_desk_approval((select id from approval_cases where label='Approval main'));
create temp table stale_approval as select approval_revision from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main');
grant select on stale_approval to authenticated;
select public.update_sales_desk_rfq((select id from approval_cases where label='Approval main'),'{"remarks":"Changed after submission"}');
select is((select approval_state from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'not_requested','edits invalidate a pending request');
set local request.jwt.claims='{"sub":"12500000-0000-0000-0000-000000000004","role":"authenticated"}';
select throws_ok($$select public.review_sales_desk_approval((select id from approval_cases where label='Approval main'),(select approval_revision from stale_approval),'approved','')$$,'40001',null,'manager cannot approve an RFQ changed after submission');
reset role;
insert into public.application_user_permission_overrides(profile_id,app_id,permission_key,enabled) values
('12500000-0000-0000-0000-000000000004','sales_desk','sales_desk.approve',false),
('12500000-0000-0000-0000-000000000005','sales_desk','sales_desk.approve',false);
set local role authenticated;
set local request.jwt.claims='{"sub":"12500000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok($$select public.request_sales_desk_approval((select id from approval_cases where label='Approval main'))$$,'22023',null,'a request cannot silently disappear when no eligible manager exists');
select is((select approval_state from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'not_requested','no-manager rejection leaves the RFQ unchanged');
reset role;
delete from public.application_user_permission_overrides where profile_id in
 ('12500000-0000-0000-0000-000000000004','12500000-0000-0000-0000-000000000005') and permission_key='sales_desk.approve';
set local role authenticated;
select public.request_sales_desk_approval((select id from approval_cases where label='Approval main'));
set local request.jwt.claims='{"sub":"12500000-0000-0000-0000-000000000007","role":"authenticated"}';
select throws_ok($$select public.review_sales_desk_approval((select id from approval_cases where label='Approval main'),(select approval_revision from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'approved','')$$,'42501',null,'an explicit approval permission denial is enforced at review time');
set local request.jwt.claims='{"sub":"12500000-0000-0000-0000-000000000004","role":"authenticated"}';
select public.review_sales_desk_approval((select id from approval_cases where label='Approval main'),(select approval_revision from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'approved','');
set local request.jwt.claims='{"sub":"12500000-0000-0000-0000-000000000002","role":"authenticated"}';
insert into public.sales_desk_rfq_attachments(rfq_id,original_name,storage_path,content_type,size,uploaded_by)
select id,'extra.pdf',auth.uid()||'/'||id||'/extra.pdf','application/pdf',10,auth.uid() from approval_cases where label='Approval main';
select is((select approval_state from public.sales_desk_rfqs where id=(select id from approval_cases where label='Approval main')),'not_requested','a new attachment invalidates an already-approved snapshot');
select * from finish();
rollback;
