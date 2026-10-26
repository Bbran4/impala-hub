begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ('00000000-0000-0000-0000-000000000000','12000000-0000-0000-0000-000000000001','authenticated','authenticated','stock-rpc@test.invalid','',now(),'{}','{"display_name":"Stock RPC"}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','12000000-0000-0000-0000-000000000002','authenticated','authenticated','manager-rpc@test.invalid','',now(),'{}','{"display_name":"Management RPC"}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','12000000-0000-0000-0000-000000000003','authenticated','authenticated','sales-rpc@test.invalid','',now(),'{}','{"display_name":"Sales RPC"}',now(),now());
insert into public.profile_roles (profile_id,role_id) values
  ('12000000-0000-0000-0000-000000000001','stock'),
  ('12000000-0000-0000-0000-000000000002','management'),
  ('12000000-0000-0000-0000-000000000003','sales');

select ok(not has_function_privilege('anon','public.create_stock_parts_query(text,text,integer,uuid,text,text,jsonb)','execute'), 'signed-out users cannot call query creation');
select ok(not has_function_privilege('anon','public.update_stock_parts_query(uuid,text,text,integer,uuid,text,text,jsonb)','execute'), 'signed-out users cannot call query updates');
select ok(not has_function_privilege('anon','public.archive_stock_parts_query(uuid)','execute'), 'signed-out users cannot archive queries');
select ok(not has_function_privilege('anon','public.stock_parts_query_history(uuid)','execute'), 'signed-out users cannot read query history');

set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($sql$
  select public.create_stock_parts_query(
    'RPC-100', 'Atomic query', 4, null, 'New', 'In Progress',
    '[{"supplier":"Supplier A","qty":3,"cost":300,"msrp":450,"notes":"First"},{"supplier":"Supplier B","qty":1,"cost":120,"msrp":170,"notes":"Second"}]'::jsonb
  )
$sql$, 'stock role can atomically create a Parts Query and suppliers');
select is((select count(*) from public.stock_parts_queries where part_number = 'RPC-100'), 1::bigint, 'RPC created one parent');
select is((select count(*) from public.stock_parts_query_suppliers s join public.stock_parts_queries q on q.id=s.query_id where q.part_number='RPC-100'), 2::bigint, 'RPC created both supplier children');
select is((select count(*) from public.stock_audit a join public.stock_parts_queries q on q.id=a.parts_query_id where q.part_number='RPC-100' and a.action='created'), 1::bigint, 'RPC query creation is audited');

select throws_ok($sql$
  select public.update_stock_parts_query(
    (select id from public.stock_parts_queries where part_number='RPC-100'),
    'RPC-100', 'This edit must roll back', 4, null, 'Under Review', 'Submitted',
    '[{"supplier":"Supplier C","qty":0,"cost":10,"msrp":20,"notes":"Invalid"}]'::jsonb
  )
$sql$, '23514', null, 'an invalid supplier rejects the complete update');
select is((select description from public.stock_parts_queries where part_number='RPC-100'), 'Atomic query', 'failed supplier replacement rolls back the parent update');
select is((select count(*) from public.stock_parts_query_suppliers s join public.stock_parts_queries q on q.id=s.query_id where q.part_number='RPC-100'), 2::bigint, 'failed replacement retains both original suppliers');

select lives_ok($sql$
  select public.update_stock_parts_query(
    (select id from public.stock_parts_queries where part_number='RPC-100'),
    'RPC-100', 'Updated atomically', 5, null, 'Under Review', 'Submitted',
    '[{"supplier":"Supplier A","qty":5,"cost":450,"msrp":600,"notes":"Requoted"}]'::jsonb
  )
$sql$, 'stock role can atomically update the query and replace suppliers');
select is((select description from public.stock_parts_queries where part_number='RPC-100'), 'Updated atomically', 'successful update changes the parent');
select is((select count(*) from public.stock_parts_query_suppliers s join public.stock_parts_queries q on q.id=s.query_id where q.part_number='RPC-100'), 1::bigint, 'successful update replaces the supplier set');
select is((select count(*) from public.stock_parts_query_history((select id from public.stock_parts_queries where part_number='RPC-100')) where actor_name='Stock RPC'), 7::bigint, 'named history contains all query and supplier events');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((select count(*) from public.stock_parts_queries where part_number='RPC-100'), 1::bigint, 'management can read Parts Queries');
select throws_ok($sql$
  select public.create_stock_parts_query('BLOCKED','Blocked',1,null,'New','In Progress','[]'::jsonb)
$sql$, '42501', 'You do not have permission to create Parts Queries', 'management cannot create Parts Queries');
select throws_ok($sql$
  select public.update_stock_parts_query((select id from public.stock_parts_queries where part_number='RPC-100'),'RPC-100','Blocked',1,null,'New','In Progress','[]'::jsonb)
$sql$, '42501', 'You do not have permission to update Parts Queries', 'management cannot update Parts Queries');
select is((select count(*) from public.stock_parts_query_history((select id from public.stock_parts_queries where part_number='RPC-100'))), 7::bigint, 'management can read named Parts Query history');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-0000-0000-000000000003","role":"authenticated"}';
select is((select count(*) from public.stock_parts_queries), 0::bigint, 'sales role cannot read Parts Queries');
select throws_ok($sql$
  select public.create_stock_parts_query('BLOCKED-SALES','Blocked',1,null,'New','In Progress','[]'::jsonb)
$sql$, '42501', 'You do not have permission to create Parts Queries', 'sales role cannot create Parts Queries');
select is((select count(*) from public.stock_parts_query_history((select id from public.stock_parts_queries limit 1))), 0::bigint, 'sales role cannot read Parts Query history');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"12000000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($sql$
  select public.archive_stock_parts_query((select id from public.stock_parts_queries where part_number='RPC-100'))
$sql$, 'stock role can archive a Parts Query');
select is((select count(*) from public.stock_parts_queries where part_number='RPC-100' and deleted_at is null), 0::bigint, 'archived query is excluded from active results');
select throws_ok($sql$
  select public.update_stock_parts_query((select id from public.stock_parts_queries where part_number='RPC-100'),'RPC-100','After archive',1,null,'New','In Progress','[]'::jsonb)
$sql$, 'P0001', 'Parts Query not found', 'archived Parts Queries cannot be updated through the RPC');
select is((select count(*) from public.stock_parts_query_history((select id from public.stock_parts_queries where part_number='RPC-100')) where action='archived'), 1::bigint, 'archive is retained in history');
reset role;

select * from finish();
rollback;
