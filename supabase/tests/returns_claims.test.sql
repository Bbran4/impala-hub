begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

-- These identities exist only inside this rolled-back local test transaction.
insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ('00000000-0000-0000-0000-000000000000','10000000-0000-0000-0000-000000000001','authenticated','authenticated','returns@test.invalid','',now(),'{}','{"display_name":"Returns Tester"}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','10000000-0000-0000-0000-000000000002','authenticated','authenticated','admin@test.invalid','',now(),'{}','{"display_name":"Admin Tester"}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','10000000-0000-0000-0000-000000000003','authenticated','authenticated','manager@test.invalid','',now(),'{}','{"display_name":"Manager Tester"}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','10000000-0000-0000-0000-000000000004','authenticated','authenticated','sales@test.invalid','',now(),'{}','{"display_name":"Sales Tester"}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','10000000-0000-0000-0000-000000000005','authenticated','authenticated','inactive@test.invalid','',now(),'{}','{"display_name":"Inactive Tester"}',now(),now());

insert into public.profile_roles (profile_id,role_id) values
  ('10000000-0000-0000-0000-000000000001','returns'),
  ('10000000-0000-0000-0000-000000000002','administrator'),
  ('10000000-0000-0000-0000-000000000003','management'),
  ('10000000-0000-0000-0000-000000000004','sales'),
  ('10000000-0000-0000-0000-000000000005','returns');
update public.profiles set active = false where id = '10000000-0000-0000-0000-000000000005';

select ok(not has_table_privilege('anon','public.returns_claims','select'), 'signed-out users have no claims table privilege');
select ok(not has_table_privilege('anon','public.returns_claims','insert'), 'signed-out users cannot create claims');
select ok(not has_table_privilege('anon','public.returns_claims','update'), 'signed-out users cannot edit claims');
select ok(not has_table_privilege('anon','public.returns_claims','delete'), 'signed-out users cannot delete claims');
select ok(not has_table_privilege('anon','public.returns_claim_attachments','select'), 'signed-out users have no attachment metadata privilege');
select ok(not has_table_privilege('anon','public.returns_claims_audit','select'), 'signed-out users have no audit privilege');
select ok(not has_function_privilege('anon','public.returns_claim_people(uuid)','execute'), 'signed-out users cannot resolve claim people');
select ok(not has_function_privilege('anon','public.finish_attachment_deletion(text,uuid,uuid)','execute'), 'signed-out users cannot finalize attachment deletion');
select ok(not has_function_privilege('anon','public.can_access_workspace(text)','execute'), 'signed-out users cannot call the workspace permission helper');

set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}';
select ok(public.can_access_workspace('returns_claims'), 'returns role can access the workspace');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-000000000002","role":"authenticated"}';
select ok(public.can_access_workspace('returns_claims'), 'administrator can access the workspace');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-000000000003","role":"authenticated"}';
select ok(public.can_access_workspace('returns_claims'), 'management can access the workspace');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-000000000004","role":"authenticated"}';
select ok(not public.can_access_workspace('returns_claims'), 'sales role cannot access the workspace');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-000000000005","role":"authenticated"}';
select ok(not public.can_access_workspace('returns_claims'), 'inactive returns user cannot access the workspace');
reset role;

-- Create and audit a claim as an active Returns & Claims employee.
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($sql$
  insert into public.returns_claims
    (id,date,company,rfc_book_number,customer,contact_person,contact_number,invoice_number,invoice_date,reason,part_number,description,qty,status,created_by,updated_by)
  values
    ('20000000-0000-0000-0000-000000000001','2026-10-26','Pretoria','RFC-TEST-1','Test Customer','Contact','0120000000','INV-1','2026-10-25','Claim','PART-1','Test part',1,'In Progress','10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002')
$sql$, 'returns role can create a claim');
select lives_ok($sql$
  update public.returns_claims set comments = 'Edited by returns', updated_by = auth.uid()
  where id = '20000000-0000-0000-0000-000000000001'
$sql$, 'returns role can edit a claim');
select throws_ok($sql$
  insert into public.returns_claims_audit (claim_id,actor_user_id,action)
  values ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','spoofed')
$sql$, '42501', null, 'an authenticated user cannot spoof the audit actor');
select lives_ok($sql$
  update public.returns_claims set status = 'Rejected', status_change_reason = 'Supplier rejected the claim', updated_by = auth.uid()
  where id = '20000000-0000-0000-0000-000000000001'
$sql$, 'a valid status change succeeds');
select lives_ok($sql$
  update public.returns_claims set sla_days = 10, updated_by = auth.uid()
  where id = '20000000-0000-0000-0000-000000000001'
$sql$, 'an SLA update succeeds');
select throws_ok($sql$
  insert into storage.objects (bucket_id,name,metadata)
  values ('returns-claim-attachments','someone-else/20000000-0000-0000-0000-000000000001/orphan.pdf','{"mimetype":"application/pdf","size":128}')
$sql$, '42501', null, 'attachment upload path must start with the authenticated user');
reset role;

select is((select count(*) from public.returns_claims where id = '20000000-0000-0000-0000-000000000001'), 1::bigint, 'created claim is stored');
select is((select comments from public.returns_claims where id = '20000000-0000-0000-0000-000000000001'), 'Edited by returns', 'claim edit is stored');
select is((select created_by from public.returns_claims where id = '20000000-0000-0000-0000-000000000001'), '10000000-0000-0000-0000-000000000001'::uuid, 'database attributes claim creation to the caller');
select matches((select claim_no from public.returns_claims where id = '20000000-0000-0000-0000-000000000001'), '^RC[0-9]{10,}$', 'claim creation generates a readable daily reference');
select throws_ok($sql$
  update public.returns_claims set claim_no = 'RC2000010101' where id = '20000000-0000-0000-0000-000000000001'
$sql$, 'P0001', 'The return/claim reference cannot be changed', 'claim reference is immutable');
select is((select count(*) from public.returns_claims_audit where claim_id = '20000000-0000-0000-0000-000000000001' and action = 'created'), 1::bigint, 'claim creation is audited atomically');
select is((select count(*) from public.returns_claims_audit where claim_id = '20000000-0000-0000-0000-000000000001' and action = 'updated'), 1::bigint, 'claim edit is audited atomically');
select is((select count(*) from public.returns_claims_audit where claim_id = '20000000-0000-0000-0000-000000000001' and action = 'status_changed'), 1::bigint, 'status trigger writes one audit event');
select is((select count(*) from public.returns_claims_audit where claim_id = '20000000-0000-0000-0000-000000000001' and action = 'sla_changed'), 1::bigint, 'SLA trigger writes one audit event');
select is((select changes ->> 'reason' from public.returns_claims_audit where claim_id = '20000000-0000-0000-0000-000000000001' and action = 'status_changed'), 'Supplier rejected the claim', 'status audit retains its reason');

-- Administrator and management share the current manage policy.
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-000000000003","role":"authenticated"}';
select is((select count(*) from public.returns_claims where id = '20000000-0000-0000-0000-000000000001'), 1::bigint, 'management can read claims');
select lives_ok($sql$
  update public.returns_claims set comments = 'Reviewed by management', updated_by = auth.uid()
  where id = '20000000-0000-0000-0000-000000000001'
$sql$, 'management can edit claims under the current policy');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((select count(*) from public.returns_claims where id = '20000000-0000-0000-0000-000000000001'), 1::bigint, 'administrator can read claims');
select lives_ok($sql$
  insert into public.returns_claims
    (id,date,company,rfc_book_number,customer,contact_person,contact_number,invoice_number,invoice_date,reason,part_number,description,qty,status)
  values ('20000000-0000-0000-0000-000000000002','2026-10-26','Pretoria','RFC-ADMIN','Admin claim','Contact','0','A-1','2026-10-26','Claim','P','Admin lifecycle',1,'In Progress')
$sql$, 'administrator can create a claim');
select lives_ok($sql$ update public.returns_claims set comments = 'Admin edit' where id = '20000000-0000-0000-0000-000000000002' $sql$, 'administrator can edit a claim');
select lives_ok($sql$ update public.returns_claims set deleted_at = now() where id = '20000000-0000-0000-0000-000000000002' $sql$, 'administrator can soft-delete a claim');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-000000000003","role":"authenticated"}';
select lives_ok($sql$
  insert into public.returns_claims
    (id,date,company,rfc_book_number,customer,contact_person,contact_number,invoice_number,invoice_date,reason,part_number,description,qty,status)
  values ('20000000-0000-0000-0000-000000000003','2026-10-26','Pretoria','RFC-MANAGER','Manager claim','Contact','0','M-1','2026-10-26','Claim','P','Manager lifecycle',1,'In Progress')
$sql$, 'management can create a claim under the current policy');
select lives_ok($sql$ update public.returns_claims set comments = 'Management edit' where id = '20000000-0000-0000-0000-000000000003' $sql$, 'management can edit its claim');
select lives_ok($sql$ update public.returns_claims set deleted_at = now() where id = '20000000-0000-0000-0000-000000000003' $sql$, 'management can soft-delete its claim');
reset role;
select is((select count(*) from public.returns_claims_audit where claim_id in ('20000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000003') and action in ('created','updated','deleted')), 6::bigint, 'administrator and management lifecycle actions are audited atomically');

-- Sales and inactive users receive an empty RLS result and cannot write.
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-000000000004","role":"authenticated"}';
select is((select count(*) from public.returns_claims), 0::bigint, 'sales role cannot read returns claims');
select throws_ok($sql$
  insert into public.returns_claims
    (id,date,company,rfc_book_number,customer,contact_person,contact_number,invoice_number,invoice_date,reason,part_number,description,qty,status)
  values ('20000000-0000-0000-0000-000000000004','2026-10-26','Pretoria','NOPE','Blocked','Contact','0','0','2026-10-26','Claim','P','Blocked',1,'In Progress')
$sql$, '42501', null, 'sales role cannot create a claim');
with changed as (update public.returns_claims set comments = 'Blocked' returning id)
select is((select count(*) from changed), 0::bigint, 'sales role cannot edit claims');
with changed as (update public.returns_claims set deleted_at = now() returning id)
select is((select count(*) from changed), 0::bigint, 'sales role cannot soft-delete claims');
select throws_ok($sql$ delete from public.returns_claims $sql$, '42501', null, 'sales role cannot physically delete claims');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-000000000005","role":"authenticated"}';
select is((select count(*) from public.returns_claims), 0::bigint, 'inactive user cannot read returns claims');
with changed as (update public.returns_claims set comments = 'Blocked' returning id)
select is((select count(*) from changed), 0::bigint, 'inactive user cannot update returns claims');
reset role;

-- Attachment policies, validation, limits and audit events.
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok($sql$
  update public.returns_claims set comments = 'Hidden edit', deleted_at = '2099-01-01'
  where id = '20000000-0000-0000-0000-000000000001'
$sql$, 'P0001', 'Delete the claim without changing its other fields', 'soft deletion cannot hide an ordinary field edit');
select lives_ok($sql$
  insert into storage.objects (bucket_id,name,metadata)
  values ('returns-claim-attachments','10000000-0000-0000-0000-000000000001/20000000-0000-0000-0000-000000000001/evidence.pdf','{"mimetype":"application/pdf","size":128}')
$sql$, 'returns role can upload to the private attachment bucket');
select lives_ok($sql$
  insert into public.returns_claim_attachments
    (id,claim_id,original_name,storage_path,content_type,size,uploaded_by)
  values
    ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','evidence.pdf','10000000-0000-0000-0000-000000000001/20000000-0000-0000-0000-000000000001/evidence.pdf','application/pdf',128,auth.uid())
$sql$, 'returns role can register valid attachment metadata');
select throws_ok($sql$
  insert into public.returns_claim_attachments (claim_id,original_name,storage_path,content_type,size,uploaded_by)
  values ('20000000-0000-0000-0000-000000000001','unsafe.svg','10000000-0000-0000-0000-000000000001/20000000-0000-0000-0000-000000000001/unsafe.svg','image/svg+xml',128,auth.uid())
$sql$, 'P0001', 'Unsupported attachment file type', 'database rejects unsupported attachment types');
select throws_ok($sql$
  insert into public.returns_claim_attachments (claim_id,original_name,storage_path,content_type,size,uploaded_by)
  values ('20000000-0000-0000-0000-000000000001','large.pdf','10000000-0000-0000-0000-000000000001/20000000-0000-0000-0000-000000000001/large.pdf','application/pdf',15728641,auth.uid())
$sql$, 'P0001', 'Attachments must be between 1 byte and 15 MB', 'database rejects attachments above 15 MB');
select throws_ok($sql$
  insert into public.returns_claim_attachments (claim_id,original_name,storage_path,content_type,size,uploaded_by)
  values ('20000000-0000-0000-0000-000000000001','wrong.pdf','someone-else/wrong-claim/wrong.pdf','application/pdf',128,auth.uid())
$sql$, 'P0001', 'Invalid attachment storage path', 'database enforces uploader and claim path segments');

insert into public.returns_claim_attachments (claim_id,original_name,storage_path,content_type,size,uploaded_by)
select '20000000-0000-0000-0000-000000000001', 'evidence-' || n || '.pdf',
  auth.uid()::text || '/20000000-0000-0000-0000-000000000001/evidence-' || n || '.pdf', 'application/pdf', 128, auth.uid()
from generate_series(2,10) n;
select throws_ok($sql$
  insert into public.returns_claim_attachments (claim_id,original_name,storage_path,content_type,size,uploaded_by)
  values ('20000000-0000-0000-0000-000000000001','eleventh.pdf','10000000-0000-0000-0000-000000000001/20000000-0000-0000-0000-000000000001/eleventh.pdf','application/pdf',128,auth.uid())
$sql$, 'P0001', 'A claim can have at most 10 attachments', 'database enforces ten attachments per claim');
select is((select count(*) from public.returns_claim_attachments where claim_id = '20000000-0000-0000-0000-000000000001'), 10::bigint, 'ten valid attachment records remain');
select is((select uploaded_by from public.returns_claim_attachments where id = '30000000-0000-0000-0000-000000000001'), '10000000-0000-0000-0000-000000000001'::uuid, 'attachment records retain the uploader');
select ok((select created_at is not null from public.returns_claim_attachments where id = '30000000-0000-0000-0000-000000000001'), 'attachment records retain their upload date');
select is((select count(*) from public.returns_claims_audit where claim_id = '20000000-0000-0000-0000-000000000001' and action = 'attachment_added'), 10::bigint, 'each attachment registration is audited');
select is((select count(*) from public.returns_claim_people('20000000-0000-0000-0000-000000000001')), 2::bigint, 'people lookup returns only actors and uploaders referenced by the claim');
select ok(public.can_delete_record_attachment('return','20000000-0000-0000-0000-000000000001'), 'returns role may delete a registered attachment');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((select count(*) from public.returns_claim_attachments where claim_id = '20000000-0000-0000-0000-000000000001'), 10::bigint, 'administrator can read attachment metadata');
select ok((select count(*) > 0 from public.returns_claims_audit where claim_id = '20000000-0000-0000-0000-000000000001'), 'administrator can read audit history');
select is((select count(*) from storage.objects where bucket_id = 'returns-claim-attachments'), 1::bigint, 'administrator can list private attachment objects');
reset role;
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select is((select count(*) from storage.objects where bucket_id = 'returns-claim-attachments'), 0::bigint, 'signed-out users cannot list private attachment objects');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($sql$
  delete from storage.objects
  where bucket_id = 'returns-claim-attachments'
    and name = '10000000-0000-0000-0000-000000000001/20000000-0000-0000-0000-000000000001/evidence.pdf'
$sql$, 'authorized user can remove the stored object');
select lives_ok($sql$
  select public.finish_attachment_deletion('return','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001')
$sql$, 'authorized user can finalize attachment deletion');
reset role;

select is((select count(*) from public.returns_claim_attachments where id = '30000000-0000-0000-0000-000000000001'), 0::bigint, 'attachment metadata is deleted');
select is((select count(*) from public.returns_claims_audit where claim_id = '20000000-0000-0000-0000-000000000001' and action = 'attachment_deleted'), 1::bigint, 'attachment deletion is audited');

set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-000000000004","role":"authenticated"}';
select is((select count(*) from public.returns_claim_attachments), 0::bigint, 'sales role cannot read attachment metadata');
select is((select count(*) from public.returns_claims_audit), 0::bigint, 'sales role cannot read claim audit history');
select is((select count(*) from storage.objects where bucket_id = 'returns-claim-attachments'), 0::bigint, 'sales role cannot list private attachment objects');
select throws_ok($sql$
  insert into storage.objects (bucket_id,name,metadata)
  values ('returns-claim-attachments','10000000-0000-0000-0000-000000000004/20000000-0000-0000-0000-000000000001/blocked.pdf','{"mimetype":"application/pdf","size":128}')
$sql$, '42501', null, 'sales role cannot upload return attachments');
select throws_ok($sql$
  select public.finish_attachment_deletion('return','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002')
$sql$, '42501', 'You do not have permission to delete this attachment', 'sales role cannot finalize attachment deletion');
reset role;

-- Application deletion is a soft delete plus a same-actor audit event.
set local role authenticated;
set local request.jwt.claims = '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($sql$
  update public.returns_claims set deleted_at = '2099-01-01', deleted_by = auth.uid(), updated_by = auth.uid()
  where id = '20000000-0000-0000-0000-000000000001'
$sql$, 'returns role can soft-delete a claim');
select throws_ok($sql$
  update public.returns_claims set comments = 'Edit after archive'
  where id = '20000000-0000-0000-0000-000000000001'
$sql$, 'P0001', 'Archived claims cannot be edited', 'archived claims are immutable');
select throws_ok($sql$
  delete from public.returns_claims where id = '20000000-0000-0000-0000-000000000001'
$sql$, '42501', null, 'browser roles cannot physically delete claims');
select throws_ok($sql$
  insert into storage.objects (bucket_id,name,metadata)
  values ('returns-claim-attachments','10000000-0000-0000-0000-000000000001/20000000-0000-0000-0000-000000000001/after-delete.pdf','{"mimetype":"application/pdf","size":128}')
$sql$, '42501', null, 'attachments cannot be uploaded to an archived claim');
reset role;
select ok((select deleted_at is not null and deleted_by = '10000000-0000-0000-0000-000000000001' from public.returns_claims where id = '20000000-0000-0000-0000-000000000001'), 'soft delete stores timestamp and actor');
select ok((select deleted_at between transaction_timestamp() - interval '1 minute' and transaction_timestamp() + interval '1 second' from public.returns_claims where id = '20000000-0000-0000-0000-000000000001'), 'database replaces the caller timestamp with the deletion time');
select is((select count(*) from public.returns_claims_audit where claim_id = '20000000-0000-0000-0000-000000000001' and action = 'deleted'), 1::bigint, 'claim deletion audit is retained');

select * from finish();
rollback;
