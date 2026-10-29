begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,raw_user_meta_data) values
('95000000-0000-0000-0000-000000000001','metrics-admin@test.invalid','{}'),
('95000000-0000-0000-0000-000000000002','metrics-sales@test.invalid','{}'),
('95000000-0000-0000-0000-000000000003','metrics-other@test.invalid','{}');
insert into public.profile_roles(profile_id,role_id) values
('95000000-0000-0000-0000-000000000001','administrator'),
('95000000-0000-0000-0000-000000000002','sales'),
('95000000-0000-0000-0000-000000000003','sales') on conflict do nothing;
update public.profiles set sales_code='MET-A' where id='95000000-0000-0000-0000-000000000002';
update public.profiles set sales_code='MET-B' where id='95000000-0000-0000-0000-000000000003';
insert into public.sales_desk_statuses(id,name,is_closed,metric_category) values
('95000000-0000-0000-0000-000000000011','Metrics renamed successful',true,'completed'),
('95000000-0000-0000-0000-000000000012','Metrics renamed lost',true,'dropped'),
('95000000-0000-0000-0000-000000000013','Metrics renamed unusable',true,'scrapped'),
('95000000-0000-0000-0000-000000000014','Metrics renamed working',false,'in_progress');
insert into public.sales_desk_rfqs(rfq_no,business_date,daily_number,rfq_type,media_platform_id,customer_name,
  sales_code_id,claimed_at,received_at,status_id,created_by,updated_by,deleted_at)
select 'MET-'||i,'2021-01-01',i,case when i=4 then 'invoice' else 'quotation' end,
  (select id from public.sales_desk_media_platforms limit 1),'Metrics fixture',
  case when i=1207 then (select id from public.sales_desk_sales_codes where code='MET-B')
    when i%2=0 then (select id from public.sales_desk_sales_codes where code='MET-A') else null end,
  case when i=1 then now() else null end,'2020-12-31 22:30:00+00',
  case i when 1 then '95000000-0000-0000-0000-000000000011'::uuid
    when 2 then '95000000-0000-0000-0000-000000000012'::uuid
    when 3 then '95000000-0000-0000-0000-000000000013'::uuid
    else '95000000-0000-0000-0000-000000000014'::uuid end,
  '95000000-0000-0000-0000-000000000001','95000000-0000-0000-0000-000000000001',
  case when i=1206 then now() else null end
from generate_series(1,1207) i;

select is((select start_date from public.sales_desk_period_bounds('week',2020,1,53)),'2020-12-28'::date,'ISO week 53 starts on Monday in its ISO year');
select is((select end_date from public.sales_desk_period_bounds('week',2020,1,53)),'2021-01-04'::date,'ISO week crosses the calendar year');
select throws_ok($$select * from public.sales_desk_period_bounds('week',2021,1,53)$$,'22023',null,'invalid week 53 rejected');
select is((select end_date-start_date from public.sales_desk_period_bounds('month',2020,2,1)),29,'leap-year February supported');
select throws_ok($$select * from public.sales_desk_period_bounds('month',2020,13,1)$$,'22023',null,'invalid month rejected');
select ok(not has_function_privilege('anon','public.sales_desk_dashboard()','execute'),'signed-out dashboard access denied');
set local role authenticated;
set local request.jwt.claims='{"sub":"95000000-0000-0000-0000-000000000001","role":"authenticated"}';
select is((public.sales_desk_analytics('year',2021)->'totals'->>'claimed')::integer,603,'all assigned RFQs counted beyond 1000; archived and unassigned rows excluded');
select is((public.sales_desk_analytics('year',2020)->'totals'->>'claimed')::integer,0,'Johannesburg dates rather than UTC or created_at determine cohort');
select is((public.sales_desk_analytics('week',2020,1,53)->'totals'->>'claimed')::integer,603,'ISO-year filtering includes early January');
select is((public.sales_desk_analytics('month',2021,1)->'totals'->>'completed')::integer,1,'completed is an explicit category');
select is((public.sales_desk_analytics('month',2021,1)->'totals'->>'dropped')::integer,1,'dropped does not depend on its display name');
select is((public.sales_desk_analytics('month',2021,1)->'totals'->>'scrapped')::integer,1,'scrapped does not depend on its display name');
select is((public.sales_desk_analytics('month',2021,1)->'totals'->>'invoiced')::integer,1,'invoice copies counted separately');
select is(jsonb_array_length(public.sales_desk_analytics('year',2021)->'series'),12,'year has ordered monthly buckets including zero months');
select is((select sum((p->>'claimed')::integer)::integer from jsonb_array_elements(public.sales_desk_analytics('month',2021,1)->'series') p),603,'filtered totals agree with chart series');
create temp table metrics_before as select public.sales_desk_dashboard() value;
reset role;
insert into public.sales_desk_rfqs(rfq_no,business_date,daily_number,media_platform_id,customer_name,received_at,status_id,created_by,updated_by,deleted_at)
select 'MET-TODAY-'||i,(now() at time zone 'Africa/Johannesburg')::date,9500+i,
  (select id from public.sales_desk_media_platforms limit 1),'Today fixture',
  ((now() at time zone 'Africa/Johannesburg')::date::timestamp+interval '30 minutes') at time zone 'Africa/Johannesburg',
  '95000000-0000-0000-0000-000000000014','95000000-0000-0000-0000-000000000001','95000000-0000-0000-0000-000000000001',
  case when i=2 then now() else null end from generate_series(1,2) i;
set local role authenticated;
select is((public.sales_desk_dashboard()->>'received_today')::integer-(select (value->>'received_today')::integer from metrics_before),1,'today includes Johannesburg midnight even on the preceding UTC day; excludes archives');
select is((public.sales_desk_dashboard()->>'unclaimed')::integer-(select (value->>'unclaimed')::integer from metrics_before),1,'dashboard excludes archived unclaimed RFQs');
update public.sales_desk_statuses set name='Another display name' where id='95000000-0000-0000-0000-000000000012';
select is((public.sales_desk_analytics('month',2021,1)->'totals'->>'dropped')::integer,1,'renaming a status never changes its outcome');
select is((select (p->>'total')::integer from jsonb_array_elements(public.sales_desk_dashboard()->'rfq_performance') p where p->>'sales_person'='MET-A'),602,'performance counts live assigned RFQs without seeded performance rows');
reset role;
insert into public.sales_desk_daily_sales(business_date,sales_person,gross_sales,gp_percent,is_temporary) values
((now() at time zone 'Africa/Johannesburg')::date,'MET-A',100,20,false),
((now() at time zone 'Africa/Johannesburg')::date,'MET-B',300,40,false);
set local role authenticated;
select is((public.sales_desk_dashboard()->'monthly_sales'->>'gross_sales')::numeric,400::numeric,'monthly sales uses verified records');
select is((public.sales_desk_dashboard()->'monthly_sales'->>'gp_percent')::numeric,35::numeric,'monthly GP percent is weighted by gross sales');
select ok(not exists(select 1 from jsonb_array_elements(public.sales_desk_dashboard()->'daily_sales') p where (p->>'is_temporary')::boolean),'temporary demonstration sales are excluded');
set local request.jwt.claims='{"sub":"95000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((public.sales_desk_analytics('year',2021)->'totals'->>'claimed')::integer,602,'aggregation preserves salesperson RLS and excludes another salesperson ownership');
reset role;
update public.profiles set active=false where id='95000000-0000-0000-0000-000000000002';
set local role authenticated;
select throws_ok($$select public.sales_desk_dashboard()$$,'42501',null,'inactive users cannot access metrics');
select * from finish();
rollback;
