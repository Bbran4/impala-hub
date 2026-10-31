begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,raw_user_meta_data) values
('12900000-0000-0000-0000-000000000001','claim-admin@test.invalid','{}'),
('12900000-0000-0000-0000-000000000002','claim-sales@test.invalid','{}');
insert into public.profile_roles(profile_id,role_id) values
('12900000-0000-0000-0000-000000000001','administrator'),('12900000-0000-0000-0000-000000000002','sales');
insert into public.sales_desk_sales_codes(code) values('CLAIM-STATUS');
update public.profiles set sales_code='CLAIM-STATUS' where id='12900000-0000-0000-0000-000000000002';
set local request.jwt.claims='{"sub":"12900000-0000-0000-0000-000000000001","role":"authenticated"}';
create temp table claim_cases(id uuid);
insert into claim_cases select (public.create_sales_desk_rfq(jsonb_build_object('customer_name','Claim status',
 'media_platform_id',(select id from public.sales_desk_media_platforms limit 1)))->>'id')::uuid from generate_series(1,2);
grant select on claim_cases to authenticated;
set local role authenticated;
set local request.jwt.claims='{"sub":"12900000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.claim_sales_desk_rfq((select id from claim_cases order by id limit 1));
select is((select s.semantic_key from public.sales_desk_rfqs r join public.sales_desk_statuses s on s.id=r.status_id
 where r.id=(select id from claim_cases order by id limit 1)),'in_progress','claim moves the RFQ to In Progress');
select ok((select claimed_at is not null and sales_code_id is not null from public.sales_desk_rfqs
 where id=(select id from claim_cases order by id limit 1)),'claim time and assignment are persisted together');
select throws_ok($$select public.claim_sales_desk_rfq((select id from claim_cases order by id limit 1))$$,'40001',null,'a claimed RFQ cannot be claimed a second time');
reset role;
update public.sales_desk_statuses set is_active=false where semantic_key='in_progress' or metric_category='in_progress' or lower(btrim(name)) in ('in progress','in_progress');
set local role authenticated;
select throws_ok($$select public.claim_sales_desk_rfq((select id from claim_cases order by id desc limit 1))$$,'22023',null,'missing active In Progress status reports a settings error');
select ok((select sales_code_id is null and claimed_at is null from public.sales_desk_rfqs
 where id=(select id from claim_cases order by id desc limit 1)),'failed status selection leaves the RFQ unclaimed');
select * from finish();
rollback;
