begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,raw_user_meta_data) values
('10700000-0000-0000-0000-000000000001','milestone-admin@test.invalid','{}'),
('10700000-0000-0000-0000-000000000002','milestone-sales@test.invalid','{}'),
('10700000-0000-0000-0000-000000000003','milestone-outsider@test.invalid','{}');
insert into public.profile_roles(profile_id,role_id) values
('10700000-0000-0000-0000-000000000001','administrator'),
('10700000-0000-0000-0000-000000000002','sales');
select ok(not has_table_privilege('authenticated','public.sales_desk_milestone_settings','update'),'shared settings cannot be overwritten directly');
select ok(not has_function_privilege('anon','public.get_sales_desk_milestones()','execute'),'anonymous users cannot read milestone settings');
set local role authenticated;
set local request.jwt.claims='{"sub":"10700000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($sql$select public.save_sales_desk_milestones('[{"value":300000,"color":"#AB1234"},{"value":100000,"color":"#123456"}]','[{"value":0,"color":"#654321"},{"value":12.5,"color":"#aabbcc"}]',0)$sql$,'administrator can atomically save sales and GP% targets');
select is((public.get_sales_desk_milestones()->>'version')::int,1,'save advances the version');
select is(public.get_sales_desk_milestones()->'sales','[{"value":100000,"color":"#123456"},{"value":300000,"color":"#ab1234"}]'::jsonb,'sales values and colours persist in numeric order');
select is(public.get_sales_desk_milestones()->'gp'->0->>'value','0','zero GP threshold persists');
select ok((public.get_sales_desk_milestones()->>'configured')::boolean,'saved configuration is marked configured');
select throws_ok($sql$select public.save_sales_desk_milestones('[]','[]',0)$sql$,'40001',null,'a stale administrator cannot overwrite newer settings');
select throws_ok($sql$select public.save_sales_desk_milestones('[{"value":1,"color":"#123456"},{"value":1,"color":"#abcdef"}]','[]',1)$sql$,'22023',null,'duplicate thresholds are rejected');
select throws_ok($sql$select public.save_sales_desk_milestones('[]','[{"value":101,"color":"#123456"}]',1)$sql$,'22023',null,'GP percentages above 100 are rejected');
select throws_ok($sql$select public.save_sales_desk_milestones('[{"value":0,"color":"#123456"}]','[]',1)$sql$,'22023',null,'zero sales targets are rejected');
select throws_ok($sql$select public.save_sales_desk_milestones('[{"value":1.001,"color":"#123456"}]','[]',1)$sql$,'22023',null,'excess decimal precision is rejected');
select throws_ok($sql$select public.save_sales_desk_milestones('[{"value":1000,"color":"red"}]','[]',1)$sql$,'22023',null,'invalid colours are rejected');
select throws_ok($sql$select public.save_sales_desk_milestones('[{"value":"1000","color":"#123456"}]','[]',1)$sql$,'22023',null,'non-numeric threshold payloads are rejected');
select is((public.get_sales_desk_milestones()->>'version')::int,1,'failed saves do not change persisted settings');
set local request.jwt.claims='{"sub":"10700000-0000-0000-0000-000000000002","role":"authenticated"}';
select is(public.get_sales_desk_milestones()->'sales'->1->>'value','300000','another employee session reads the saved values instead of browser defaults');
select is(public.get_sales_desk_milestones()->'sales'->1->>'color','#ab1234','another employee session reads saved colours');
select throws_ok($sql$select public.save_sales_desk_milestones('[]','[]',1)$sql$,'42501',null,'sales employees cannot change shared targets');
set local request.jwt.claims='{"sub":"10700000-0000-0000-0000-000000000003","role":"authenticated"}';
select throws_ok($sql$select public.get_sales_desk_milestones()$sql$,'42501',null,'unrelated employees cannot read Sales Desk settings');
set local request.jwt.claims='{"sub":"10700000-0000-0000-0000-000000000001","role":"authenticated"}';
select lives_ok($sql$select public.save_sales_desk_milestones('[]','[]',1)$sql$,'an administrator can explicitly remove all milestones');
select is(public.get_sales_desk_milestones()->'sales','[]'::jsonb,'empty saved milestones do not fall back to hardcoded defaults');
select is((public.get_sales_desk_milestones()->>'version')::int,2,'later saves advance the persisted revision');
select * from finish();
rollback;
