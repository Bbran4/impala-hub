begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,raw_user_meta_data) values
('11100000-0000-0000-0000-000000000001','rls-admin@test.invalid','{}'),
('11100000-0000-0000-0000-000000000002','rls-sales-a@test.invalid','{}'),
('11100000-0000-0000-0000-000000000003','rls-sales-b@test.invalid','{}'),
('11100000-0000-0000-0000-000000000004','rls-no-code@test.invalid','{}'),
('11100000-0000-0000-0000-000000000005','rls-outsider@test.invalid','{}'),
('11100000-0000-0000-0000-000000000006','rls-inactive@test.invalid','{}'),
('11100000-0000-0000-0000-000000000007','rls-manager@test.invalid','{}');
insert into public.profile_roles(profile_id,role_id) values
('11100000-0000-0000-0000-000000000001','administrator'),
('11100000-0000-0000-0000-000000000002','sales'),
('11100000-0000-0000-0000-000000000003','sales'),
('11100000-0000-0000-0000-000000000004','sales'),
('11100000-0000-0000-0000-000000000005','stock'),
('11100000-0000-0000-0000-000000000006','sales'),
('11100000-0000-0000-0000-000000000007','sales_manager');
insert into public.sales_desk_sales_codes(id,code) values
('11100000-0000-0000-0001-000000000001','RLS-A'),('11100000-0000-0000-0001-000000000002','RLS-B');
update public.profiles set sales_code='RLS-A' where id='11100000-0000-0000-0000-000000000002';
update public.profiles set sales_code='rls-b' where id='11100000-0000-0000-0000-000000000003';
update public.profiles set active=false where id='11100000-0000-0000-0000-000000000006';
create temp table rls_rfqs(label text primary key,id uuid);
grant select on rls_rfqs to authenticated,anon;
select set_config('request.jwt.claims','{"sub":"11100000-0000-0000-0000-000000000001","role":"authenticated"}',true);
insert into rls_rfqs select label,(public.create_sales_desk_rfq(jsonb_build_object('customer_name',label,
  'media_platform_id',(select id from public.sales_desk_media_platforms where is_active limit 1)))->>'id')::uuid
from unnest(array['a','b','unclaimed']) label;
select public.update_sales_desk_rfq((select id from rls_rfqs where label='a'),'{"sales_code_id":"11100000-0000-0000-0001-000000000001"}');
select public.update_sales_desk_rfq((select id from rls_rfqs where label='b'),'{"sales_code_id":"11100000-0000-0000-0001-000000000002"}');
insert into public.sales_desk_rfq_attachments(rfq_id,original_name,storage_path,content_type,size,uploaded_by)
select id,label||'.pdf',case label when 'a' then '11100000-0000-0000-0000-000000000002' else '11100000-0000-0000-0000-000000000003' end||'/'||id||'/'||label||'.pdf','application/pdf',10,
case label when 'a' then '11100000-0000-0000-0000-000000000002'::uuid else '11100000-0000-0000-0000-000000000003'::uuid end
from rls_rfqs where label in ('a','b');
insert into storage.objects(bucket_id,name) select 'sales-desk-attachments',storage_path from public.sales_desk_rfq_attachments where rfq_id in(select id from rls_rfqs);
-- Exercise anonymous RLS even if a future deployment grants table SELECT.
grant select on public.sales_desk_rfqs,public.sales_desk_rfq_attachments to anon;
set local role authenticated;
set local request.jwt.claims='{"sub":"11100000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((select count(*) from public.sales_desk_rfqs where id in(select id from rls_rfqs)),2::bigint,'salesperson sees own and unclaimed RFQs');
select is((select count(*) from public.sales_desk_rfqs where id=(select id from rls_rfqs where label='b')),0::bigint,'salesperson cannot select another sales code RFQ');
select is((select count(*) from public.sales_desk_rfq_audit where rfq_id=(select id from rls_rfqs where label='b')),0::bigint,'audit history follows parent RFQ visibility');
select is((select count(*) from public.sales_desk_rfq_attachments where rfq_id in(select id from rls_rfqs)),1::bigint,'attachment metadata follows parent RFQ visibility');
select is((select count(*) from storage.objects where bucket_id='sales-desk-attachments' and name like '11100000-%'),1::bigint,'stored files follow parent RFQ visibility');
select throws_ok($sql$select public.update_sales_desk_rfq((select id from rls_rfqs where label='b'),'{"remarks":"forged"}')$sql$,'42501',null,'cross-owner RFQ mutation is denied');
select throws_ok($sql$insert into public.sales_desk_rfq_attachments(rfq_id,original_name,storage_path,content_type,size,uploaded_by) select id,'fake.pdf','11100000-0000-0000-0000-000000000002/'||id||'/fake.pdf','application/pdf',10,auth.uid() from rls_rfqs where label='b'$sql$,'42501',null,'cross-owner attachment insertion is denied');
select throws_ok($sql$insert into storage.objects(bucket_id,name) select 'sales-desk-attachments','11100000-0000-0000-0000-000000000002/'||id||'/fake.pdf' from rls_rfqs where label='b'$sql$,'42501',null,'cross-owner file upload is denied');
select ok(not public.can_delete_record_attachment('rfq',(select id from rls_rfqs where label='b')),'cross-owner file deletion is denied');
select throws_ok($sql$insert into public.sales_desk_rfq_attachments(rfq_id,original_name,storage_path,content_type,size,uploaded_by) select id,'fake.pdf','11100000-0000-0000-0000-000000000002/'||id||'/fake.pdf','application/pdf',10,'11100000-0000-0000-0000-000000000003' from rls_rfqs where label='a'$sql$,'42501',null,'attachment uploader cannot be forged');
select lives_ok($sql$insert into storage.objects(bucket_id,name) select 'sales-desk-attachments','11100000-0000-0000-0000-000000000002/'||id||'/pending.pdf' from rls_rfqs where label='a'$sql$,'owner can upload a pending attachment');
with removed as(delete from storage.objects where bucket_id='sales-desk-attachments' and name like '%/pending.pdf' returning 1)
select is(count(*),1::bigint,'failed metadata saves can clean up their pending uploaded files') from removed;
set local request.jwt.claims='{"sub":"11100000-0000-0000-0000-000000000003","role":"authenticated"}';
select is((select count(*) from public.sales_desk_rfqs where id in(select id from rls_rfqs)),2::bigint,'sales-code matching is case-insensitive');
set local request.jwt.claims='{"sub":"11100000-0000-0000-0000-000000000004","role":"authenticated"}';
select is((select count(*) from public.sales_desk_rfqs where id in(select id from rls_rfqs)),1::bigint,'missing sales code does not grant access to assigned RFQs');
set local request.jwt.claims='{"sub":"11100000-0000-0000-0000-000000000005","role":"authenticated"}';
select is((select count(*) from public.sales_desk_rfqs where id in(select id from rls_rfqs)),0::bigint,'unrelated workspace user sees no RFQs');
select is((select count(*) from public.sales_desk_rfq_attachments where rfq_id in(select id from rls_rfqs)),0::bigint,'unrelated workspace user sees no attachment metadata');
select is((select count(*) from storage.objects where bucket_id='sales-desk-attachments' and name like '11100000-%'),0::bigint,'unrelated workspace user sees no files');
set local request.jwt.claims='{"sub":"11100000-0000-0000-0000-000000000006","role":"authenticated"}';
select is((select count(*) from public.sales_desk_rfqs where id in(select id from rls_rfqs)),0::bigint,'inactive salesperson sees no RFQs');
select is((select count(*) from public.sales_desk_rfq_attachments where rfq_id in(select id from rls_rfqs)),0::bigint,'inactive salesperson sees no metadata');
set local request.jwt.claims='{"sub":"11100000-0000-0000-0000-000000000007","role":"authenticated"}';
select is((select count(*) from public.sales_desk_rfqs where id in(select id from rls_rfqs)),3::bigint,'sales manager retains access to every RFQ');
select is((select count(*) from public.sales_desk_rfq_attachments where rfq_id in(select id from rls_rfqs)),2::bigint,'sales manager sees permitted attachments');
reset role;
insert into public.application_user_permission_overrides(profile_id,app_id,permission_key,enabled) values
('11100000-0000-0000-0000-000000000002','sales_desk','sales_desk.edit',false);
set local role authenticated;
set local request.jwt.claims='{"sub":"11100000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((select count(*) from public.sales_desk_rfq_attachments where rfq_id in(select id from rls_rfqs)),1::bigint,'edit denial retains authorized read access');
select ok(not public.can_delete_record_attachment('rfq',(select id from rls_rfqs where label='a')),'edit denial blocks attachment deletion');
select throws_ok($sql$insert into storage.objects(bucket_id,name) select 'sales-desk-attachments','11100000-0000-0000-0000-000000000002/'||id||'/denied.pdf' from rls_rfqs where label='a'$sql$,'42501',null,'edit denial blocks attachment upload');
select throws_ok($sql$insert into storage.objects(bucket_id,name) values('sales-desk-attachments','11100000-0000-0000-0000-000000000002/not-a-uuid/file.pdf')$sql$,'42501',null,'malformed storage paths are denied without an unsafe cast');
reset role;
insert into public.application_user_permission_overrides(profile_id,app_id,permission_key,enabled) values
('11100000-0000-0000-0000-000000000002','sales_desk','sales_desk.view',false);
set local role authenticated;
set local request.jwt.claims='{"sub":"11100000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((select count(*) from public.sales_desk_rfqs where id in(select id from rls_rfqs)),0::bigint,'view denial removes RFQ access despite sales role');
select is((select count(*) from public.sales_desk_rfq_attachments where rfq_id in(select id from rls_rfqs)),0::bigint,'view denial removes attachment access');
set local role anon;
set local request.jwt.claims='{"role":"anon"}';
select is((select count(*) from public.sales_desk_rfqs where id in(select id from rls_rfqs)),0::bigint,'anonymous RLS denies RFQ reads');
select is((select count(*) from public.sales_desk_rfq_attachments where rfq_id in(select id from rls_rfqs)),0::bigint,'anonymous RLS denies attachment reads');
reset role;
select * from finish();
rollback;
