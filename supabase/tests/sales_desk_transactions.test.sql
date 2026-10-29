begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,raw_user_meta_data) values
('99000000-0000-0000-0000-000000000001','tx-admin@test.invalid','{"display_name":"Transaction Admin"}'),
('99000000-0000-0000-0000-000000000002','tx-sales@test.invalid','{}'),
('99000000-0000-0000-0000-000000000003','tx-other@test.invalid','{}');
insert into public.profile_roles(profile_id,role_id) values
('99000000-0000-0000-0000-000000000001','administrator'),('99000000-0000-0000-0000-000000000002','sales'),
('99000000-0000-0000-0000-000000000003','sales') on conflict do nothing;
update public.profiles set sales_code='TX-A' where id='99000000-0000-0000-0000-000000000002';
update public.profiles set sales_code='TX-B' where id='99000000-0000-0000-0000-000000000003';
insert into public.sales_desk_number_counters values((now() at time zone 'Africa/Johannesburg')::date,98)
on conflict(business_date) do update set last_value=greatest(sales_desk_number_counters.last_value,excluded.last_value);
select ok(not has_function_privilege('authenticated','public.next_sales_desk_rfq_number()','execute'),'browser cannot reserve numbers outside creation');
select ok(not has_table_privilege('authenticated','public.sales_desk_rfqs','insert'),'browser cannot bypass create command');
select ok(not has_table_privilege('authenticated','public.sales_desk_rfqs','update'),'browser cannot bypass edit/claim/archive commands');
select ok(not has_table_privilege('authenticated','public.sales_desk_rfq_audit','insert'),'browser cannot forge audit entries');
select ok(not has_table_privilege('authenticated','public.sales_desk_number_counters','update'),'browser cannot forge number counters');

-- Reject selected audit inserts to prove business changes and counter allocation roll back together.
create function pg_temp.reject_sales_audit() returns trigger language plpgsql as $$
begin
  if new.changes->'after'->>'customer_name'='Rollback' or
    (new.action='created_from_quotation' and new.changes->'after'->>'customer_name'='Fail conversion') then
    raise exception 'Simulated audit write failure'; end if;
  return new;
end $$;
create trigger test_reject_sales_audit before insert on public.sales_desk_rfq_audit for each row execute function pg_temp.reject_sales_audit();

set local role authenticated;
set local request.jwt.claims='{"sub":"99000000-0000-0000-0000-000000000001","role":"authenticated"}';
create temp table tx_rows(label text primary key,r jsonb);
insert into tx_rows values('first',public.create_sales_desk_rfq(jsonb_build_object('customer_name','First',
  'media_platform_id',(select id from public.sales_desk_media_platforms where is_active limit 1))));
select ok((select (r->>'daily_number')::integer>=99 from tx_rows where label='first'),'counter advances safely beyond two-digit references');
select is((select r->>'rfq_no' from tx_rows where label='first'),(select 'IMP'||to_char((r->>'business_date')::date,'YYMMDD')||(r->>'daily_number') from tx_rows where label='first'),'reference never truncates a three-digit daily number');
select is((select count(*) from public.sales_desk_rfq_audit where rfq_id=(select (r->>'id')::uuid from tx_rows where label='first') and action='created'),1::bigint,'create and its audit are committed together exactly once');
select throws_ok($$select public.create_sales_desk_rfq(jsonb_build_object('customer_name','Rollback','media_platform_id',(select id from public.sales_desk_media_platforms where is_active limit 1)))$$,'P0001',null,'audit failure aborts creation');
select is((select count(*) from public.sales_desk_rfqs where customer_name='Rollback'),0::bigint,'failed creation leaves no RFQ');
insert into tx_rows values('second',public.create_sales_desk_rfq(jsonb_build_object('customer_name','Second','media_platform_id',(select id from public.sales_desk_media_platforms where is_active limit 1))));
select is((select (r->>'daily_number')::integer from tx_rows where label='second'),(select (r->>'daily_number')::integer+1 from tx_rows where label='first'),'failed transaction consumes no number');
select throws_ok($$select public.update_sales_desk_rfq((select (r->>'id')::uuid from tx_rows where label='first'),'{"rfq_no":"forged"}'::jsonb)$$,'22023',null,'immutable identity fields cannot be edited');

set local request.jwt.claims='{"sub":"99000000-0000-0000-0000-000000000002","role":"authenticated"}';
select public.claim_sales_desk_rfq((select (r->>'id')::uuid from tx_rows where label='first'));
select is((select sales_code_id from public.sales_desk_rfqs where id=(select (r->>'id')::uuid from tx_rows where label='first')),
  (select id from public.sales_desk_sales_codes where code='TX-A'),'claim uses the authenticated salesperson code');
select is((select count(*) from public.sales_desk_rfq_audit where rfq_id=(select (r->>'id')::uuid from tx_rows where label='first') and action='claimed'),1::bigint,'claim has exactly one atomic audit');
select throws_ok($$select public.create_sales_desk_rfq(jsonb_build_object('customer_name','Not manager','media_platform_id',(select id from public.sales_desk_media_platforms where is_active limit 1)))$$,'42501',null,'salespeople cannot invoke manager creation');
select public.update_sales_desk_rfq((select (r->>'id')::uuid from tx_rows where label='first'),'{"document_number":"DOC-1"}'::jsonb);
select throws_ok($$select public.update_sales_desk_rfq((select (r->>'id')::uuid from tx_rows where label='first'),jsonb_build_object('sales_code_id',(select id from public.sales_desk_sales_codes where code='TX-B')))$$,'42501',null,'salespeople cannot reassign themselves to another code');
set local request.jwt.claims='{"sub":"99000000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok($$select public.claim_sales_desk_rfq((select (r->>'id')::uuid from tx_rows where label='first'))$$,'40001',null,'second claim has no winner and no audit');
select throws_ok($$select public.update_sales_desk_rfq((select (r->>'id')::uuid from tx_rows where label='first'),'{"remarks":"forged"}'::jsonb)$$,'42501',null,'another salesperson cannot edit a claimed RFQ');
select is((select count(*) from public.sales_desk_rfq_audit where rfq_id=(select (r->>'id')::uuid from tx_rows where label='first')),0::bigint,'audit visibility follows RFQ row permissions');

set local request.jwt.claims='{"sub":"99000000-0000-0000-0000-000000000001","role":"authenticated"}';
select public.update_sales_desk_rfq((select (r->>'id')::uuid from tx_rows where label='first'),jsonb_build_object('status_id',(select id from public.sales_desk_statuses where is_closed limit 1)));
insert into tx_rows values('invoice',to_jsonb(public.convert_sales_desk_rfq_to_invoice((select (r->>'id')::uuid from tx_rows where label='first'))));
select is((select r->>'rfq_no' from tx_rows where label='invoice'),(select r->>'rfq_no'||'INV' from tx_rows where label='first'),'conversion retains quotation reference with INV suffix');
select is((public.convert_sales_desk_rfq_to_invoice((select (r->>'id')::uuid from tx_rows where label='first'))).id,(select (r->>'id')::uuid from tx_rows where label='invoice'),'conversion retries return the existing invoice');
select is((select count(*) from public.sales_desk_rfq_audit where rfq_id=(select (r->>'id')::uuid from tx_rows where label='first') and action='invoice_copy_created'),1::bigint,'conversion source audit is not duplicated');
select is((select count(*) from public.sales_desk_rfq_audit where rfq_id=(select (r->>'id')::uuid from tx_rows where label='invoice') and action='created_from_quotation'),1::bigint,'invoice creation is audited atomically');
insert into tx_rows values('bad-convert',public.create_sales_desk_rfq(jsonb_build_object('customer_name','Fail conversion',
  'media_platform_id',(select id from public.sales_desk_media_platforms where is_active limit 1),'status_id',(select id from public.sales_desk_statuses where is_closed limit 1))));
select throws_ok($$select public.convert_sales_desk_rfq_to_invoice((select (r->>'id')::uuid from tx_rows where label='bad-convert'))$$,'P0001',null,'invoice audit failure aborts conversion');
select is((select converted_at from public.sales_desk_rfqs where id=(select (r->>'id')::uuid from tx_rows where label='bad-convert')),null::timestamptz,'failed conversion leaves source unchanged');
select is((select count(*) from public.sales_desk_rfqs where original_rfq_no=(select r->>'rfq_no' from tx_rows where label='bad-convert')),0::bigint,'failed conversion leaves no invoice');

create temp table reorder_ids as select array_agg(id order by sort_order desc,id) ids from public.sales_desk_media_platforms;
select public.reorder_sales_desk_config('media-platforms',(select ids from reorder_ids));
select is((select sort_order from public.sales_desk_media_platforms where id=(select ids[1] from reorder_ids)),0,'whole configuration list is reordered in one command');
select throws_ok($$select public.reorder_sales_desk_config('media-platforms',(select array_fill(ids[1],array[cardinality(ids)]) from reorder_ids))$$,'22023',null,'duplicate reorder IDs rejected');
select throws_ok($$select public.reorder_sales_desk_config('not-a-table',(select ids from reorder_ids))$$,'22023',null,'reorder cannot target arbitrary tables');
select is(public.archive_sales_desk_rfq((select (r->>'id')::uuid from tx_rows where label='first')),true,'archive uses an atomic command');
select is(public.archive_sales_desk_rfq((select (r->>'id')::uuid from tx_rows where label='first')),false,'archive retry is a no-op');
select is((select count(*) from public.sales_desk_rfq_audit where rfq_id=(select (r->>'id')::uuid from tx_rows where label='first') and action='deleted'),1::bigint,'archive has one audit');
reset role;
insert into public.sales_desk_rfqs(rfq_no,business_date,daily_number,media_platform_id,customer_name,sales_code_id,status_id,created_by,updated_by)
select 'TX-BIG-'||i,'2088-01-01',i,(select id from public.sales_desk_media_platforms limit 1),'Grouped count',
  (select id from public.sales_desk_sales_codes where code='TX-A'),(select id from public.sales_desk_statuses limit 1),
  '99000000-0000-0000-0000-000000000001','99000000-0000-0000-0000-000000000001' from generate_series(1,1205) i;
set local role authenticated;
select is((select (c->>'rfq_count')::bigint from jsonb_array_elements(public.sales_desk_configuration()->'sales_codes') c where c->>'code'='TX-A'),
  (select count(*) from public.sales_desk_rfqs where sales_code_id=(select id from public.sales_desk_sales_codes where code='TX-A')),'grouped configuration count includes all rows beyond 1000');
select is((public.sales_desk_session_context()->>'role'),'administrator','session context is fetched in one RPC');
select * from finish();
rollback;
