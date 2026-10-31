begin;

create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','49000000-0000-0000-0000-000000000001','authenticated','authenticated','settings-admin@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','49000000-0000-0000-0000-000000000002','authenticated','authenticated','settings-manager@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','49000000-0000-0000-0000-000000000003','authenticated','authenticated','settings-sales-manager@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','49000000-0000-0000-0000-000000000004','authenticated','authenticated','settings-employee@test.invalid','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','49000000-0000-0000-0000-000000000005','authenticated','authenticated','settings-inactive@test.invalid','',now(),'{}','{}',now(),now());

update public.profiles set display_name='Settings Admin' where id='49000000-0000-0000-0000-000000000001';
update public.profiles set display_name='Manager' where id='49000000-0000-0000-0000-000000000002';
update public.profiles set display_name='Sales Manager' where id='49000000-0000-0000-0000-000000000003';
update public.profiles set display_name='Employee', sales_code='SET01' where id='49000000-0000-0000-0000-000000000004';
update public.profiles set display_name='Inactive Employee', active=false where id='49000000-0000-0000-0000-000000000005';

insert into public.profile_roles(profile_id,role_id) values
('49000000-0000-0000-0000-000000000001','administrator'),
('49000000-0000-0000-0000-000000000002','management'),
('49000000-0000-0000-0000-000000000003','sales_manager'),
('49000000-0000-0000-0000-000000000003','report_builder'),
('49000000-0000-0000-0000-000000000004','marketing'),
('49000000-0000-0000-0000-000000000005','fleet');

select is((select label from public.roles where id='fleet'),'Fleet Management','fleet role exists');
select is((select label from public.roles where id='ecommerce'),'E-commerce','ecommerce role exists');
select ok(not has_function_privilege('anon','public.admin_list_app_access(text)','execute'),'signed-out users cannot list app access');
select ok(not has_function_privilege('anon','public.admin_set_app_access(uuid,text,boolean)','execute'),'signed-out users cannot change app access');
select ok(not has_table_privilege('authenticated','public.admin_app_access_audit','insert'),'browser users cannot forge access audit rows');
select ok(not has_table_privilege('authenticated','public.admin_app_access_audit','update'),'browser users cannot alter access audit rows');
select ok(not has_table_privilege('authenticated','public.admin_app_access_audit','delete'),'browser users cannot delete access audit rows');
select ok(not has_table_privilege('authenticated','public.provider_connections','select'),'browser users cannot read encrypted provider connections directly');
select ok(not has_table_privilege('authenticated','public.provider_connections','insert'),'browser users cannot create provider connections directly');
select ok(not has_table_privilege('authenticated','public.provider_connections','update'),'browser users cannot alter provider connections directly');
select ok(not has_table_privilege('authenticated','public.provider_connections','delete'),'browser users cannot delete provider connections directly');
select ok(not has_function_privilege('anon','public.admin_reorder_campaign_types(text[])','execute'),'signed-out users cannot reorder campaign types');
select ok(not has_column_privilege('authenticated','public.profiles','active','update'),'browser users cannot reactivate profiles');
select ok(has_column_privilege('authenticated','public.profiles','display_name','update'),'users retain profile display-name updates');
select ok(has_column_privilege('authenticated','public.profiles','sales_code','update'),'users retain sales-code updates');

set local role authenticated;
set local request.jwt.claims='{"sub":"49000000-0000-0000-0000-000000000004","role":"authenticated"}';
select throws_ok($sql$select * from public.admin_list_app_access('marketing')$sql$,'42501',null,'non-administrators cannot list app access');
select throws_ok(
  $sql$select public.admin_set_app_access('49000000-0000-0000-0000-000000000004','reporting',true)$sql$,
  '42501',null,'non-administrators cannot change app access'
);
select ok(public.can_access_workspace('marketing'),'existing marketing access is preserved');
select ok(not public.can_access_workspace('reporting'),'marketing does not imply Reporting access');
select is((select count(*) from public.campaign_types),3::bigint,'active users can read campaign types');
select throws_ok(
  $sql$insert into public.campaign_types(name,position) values ('Employee type',98)$sql$,
  '42501',null,'non-administrators cannot insert campaign types'
);
select throws_ok(
  $sql$select public.admin_reorder_campaign_types(array(select name from public.campaign_types order by position desc))$sql$,
  '42501',null,'non-administrators cannot reorder campaign types'
);
with changed as (
    update public.campaign_types set position=99 where name='Tips' returning 1
  )
select is((select count(*) from changed),
  0::bigint,'non-administrators cannot update campaign types'
);
with changed as (
    delete from public.campaign_types where name='Tips' returning 1
  )
select is((select count(*) from changed),
  0::bigint,'non-administrators cannot delete campaign types'
);
select is((select count(*) from public.admin_app_access_audit),0::bigint,'non-administrators cannot read audit rows');
reset role;

set local role authenticated;
set local request.jwt.claims='{"sub":"49000000-0000-0000-0000-000000000001","role":"authenticated"}';

select is(
  (select count(*) from public.admin_list_app_access('fleet_management')),
  4::bigint,'access list contains active profiles only'
);
select ok(
  (select inherited_access and can_open and access_reason='administrator'
   from public.admin_list_app_access('fleet_management')
   where profile_id='49000000-0000-0000-0000-000000000001'),
  'administrator access is represented as inherited for every app'
);
select ok(
  (select inherited_access and can_open and access_reason='management'
   from public.admin_list_app_access('marketing')
   where profile_id='49000000-0000-0000-0000-000000000002'),
  'management access is represented as inherited for an existing app'
);
select ok(
  (select not inherited_access and not can_open
   from public.admin_list_app_access('fleet_management')
   where profile_id='49000000-0000-0000-0000-000000000002'),
  'management does not inherit access to planned Fleet Management'
);
select ok(
  (select inherited_access and can_open and access_reason='sales_manager'
   from public.admin_list_app_access('sales_desk')
   where profile_id='49000000-0000-0000-0000-000000000003'),
  'sales managers retain inherited Sales Desk access'
);
select ok(
  (select inherited_access and can_open and access_reason='report_builder'
   from public.admin_list_app_access('reporting')
   where profile_id='49000000-0000-0000-0000-000000000003'),
  'report builders retain inherited Reporting access'
);
select is(
  public.admin_set_app_access('49000000-0000-0000-0000-000000000003','sales_desk',false),
  false,'inherited Sales Desk access is not individually removable'
);
select is(
  public.admin_set_app_access('49000000-0000-0000-0000-000000000002','marketing',false),
  false,'inherited management access is not individually removable'
);
select is(
  public.admin_set_app_access('49000000-0000-0000-0000-000000000004','fleet_management',true),
  true,'administrator grants Fleet Management access'
);
select is(
  public.admin_set_app_access('49000000-0000-0000-0000-000000000004','fleet_management',true),
  false,'granting existing direct access is an unaudited no-op'
);
select ok(
  (select direct_access and not inherited_access and can_open and access_reason='direct'
   from public.admin_list_app_access('fleet_management')
   where profile_id='49000000-0000-0000-0000-000000000004'),
  'the list reports newly granted direct access'
);
select is(
  public.admin_set_app_access('49000000-0000-0000-0000-000000000004','fleet_management',false),
  true,'administrator revokes Fleet Management access'
);
select is(
  public.admin_set_app_access('49000000-0000-0000-0000-000000000004','ecommerce',true),
  true,'administrator grants E-commerce access'
);
select throws_ok(
  $sql$select public.admin_set_app_access('49000000-0000-0000-0000-000000000005','fleet_management',true)$sql$,
  'P0002',null,'inactive profiles cannot receive app access'
);
select throws_ok(
  $sql$select * from public.admin_list_app_access('unknown_app')$sql$,
  '22023',null,'unknown app identifiers are rejected'
);
select is((select count(*) from public.admin_app_access_audit),3::bigint,'each effective grant or revoke writes one audit row');
select is(
  (select count(*) from public.admin_app_access_audit
   where actor_user_id='49000000-0000-0000-0000-000000000001'
     and profile_id='49000000-0000-0000-0000-000000000004'
     and app_id='fleet_management' and role_id='fleet'),
  2::bigint,'audit rows attribute the target, app role, and administrator'
);

select lives_ok($sql$insert into public.campaign_types(name,position) values ('Administrator type',98)$sql$,'administrator inserts campaign types');
select lives_ok($sql$update public.campaign_types set position=99 where name='Administrator type'$sql$,'administrator updates campaign types');
select lives_ok($sql$delete from public.campaign_types where name='Administrator type'$sql$,'administrator deletes campaign types');
select lives_ok(
  $sql$select public.admin_reorder_campaign_types(array(select name from public.campaign_types order by position desc, name))$sql$,
  'administrator reorders the complete campaign-type set atomically'
);
select is(
  (select count(distinct position) from public.campaign_types),
  (select count(*) from public.campaign_types),
  'atomic reorder assigns each campaign type a unique position'
);
select throws_ok(
  $sql$select public.admin_reorder_campaign_types(array['Tips'])$sql$,
  '22023',null,'partial campaign-type orders are rejected'
);
reset role;

set local role authenticated;
set local request.jwt.claims='{"sub":"49000000-0000-0000-0000-000000000004","role":"authenticated"}';
select ok(not public.can_access_workspace('fleet_management'),'revoked Fleet Management access closes the workspace');
select ok(public.can_access_workspace('ecommerce'),'direct E-commerce role opens the workspace');
select ok(not public.can_access_workspace('sales_desk'),'employee has no Sales Desk access');
select ok(not public.can_access_workspace('returns_claims'),'employee has no Returns & Claims access');
select ok(not public.can_access_workspace('stock_control'),'employee has no Stock Control access');
select ok(not public.can_access_workspace('reporting'),'employee has no Reporting access');
select ok(not public.can_access_workspace('unknown_app'),'unknown workspace identifiers remain closed');
reset role;

set local role authenticated;
set local request.jwt.claims='{"sub":"49000000-0000-0000-0000-000000000002","role":"authenticated"}';
select ok(public.can_access_workspace('marketing'),'management retains Marketing access');
select ok(public.can_access_workspace('sales_desk'),'management retains Sales Desk access');
select ok(public.can_access_workspace('returns_claims'),'management retains Returns & Claims access');
select ok(public.can_access_workspace('stock_control'),'management retains Stock Control access');
select ok(public.can_access_workspace('reporting'),'management retains Reporting access');
select ok(not public.can_access_workspace('fleet_management'),'management does not inherit Fleet Management access');
select ok(not public.can_access_workspace('ecommerce'),'management does not inherit E-commerce access');
reset role;

set local role authenticated;
set local request.jwt.claims='{"sub":"49000000-0000-0000-0000-000000000001","role":"authenticated"}';
select ok(public.can_access_workspace('marketing'),'administrator opens Marketing');
select ok(public.can_access_workspace('sales_desk'),'administrator opens Sales Desk');
select ok(public.can_access_workspace('returns_claims'),'administrator opens Returns & Claims');
select ok(public.can_access_workspace('stock_control'),'administrator opens Stock Control');
select ok(public.can_access_workspace('fleet_management'),'administrator opens Fleet Management');
select ok(public.can_access_workspace('ecommerce'),'administrator opens E-commerce');
select ok(public.can_access_workspace('reporting'),'administrator opens Reporting');
reset role;

select * from finish();
rollback;
