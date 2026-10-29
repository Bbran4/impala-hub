begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,raw_user_meta_data) values
('97000000-0000-0000-0000-000000000001','post-audit-admin@test.invalid','{"display_name":"Post Administrator"}'),
('97000000-0000-0000-0000-000000000002','post-outsider@test.invalid','{}');
insert into public.profile_roles(profile_id,role_id) values
('97000000-0000-0000-0000-000000000001','administrator'),('97000000-0000-0000-0000-000000000002','sales') on conflict do nothing;
insert into public.campaigns(id,name) values
('97000000-0000-0000-0000-000000000011','Launch campaign'),('97000000-0000-0000-0000-000000000012','Other campaign');
insert into public.posts(id,title,caption,campaign_id,created_at,status,created_by,media)
select ('97000000-0000-0000-0001-'||lpad(i::text,12,'0'))::uuid,'Post '||i,
  case when i=1 then 'Literal 100%_match' else 'Common caption' end,
  case when i<=1200 then '97000000-0000-0000-0000-000000000011'::uuid else '97000000-0000-0000-0000-000000000012'::uuid end,
  '2021-01-15', 'draft','97000000-0000-0000-0000-000000000001',
  '[{"id":"a","url":"https://example.supabase.co/storage/v1/object/public/marketing-media/a.jpg"},{"id":"b","url":"https://example.supabase.co/storage/v1/object/public/marketing-media/b.jpg"}]'::jsonb
from generate_series(1,1205) i;
update public.posts set published_at='2020-12-31 22:30+00',status='published' where id='97000000-0000-0000-0001-000000000001';
update public.posts set published_at='2020-12-31 21:59+00',status='published' where id='97000000-0000-0000-0001-000000000002';
set local role authenticated;
set local request.jwt.claims='{"sub":"97000000-0000-0000-0000-000000000001","role":"authenticated"}';
select is((public.marketing_post_page()->>'total')::integer,1205,'count spans more than 1000 matching posts');
select is(jsonb_array_length(public.marketing_post_page()->'items'),50,'default page is bounded');
select is(jsonb_array_length(public.marketing_post_page(p_offset=>1200)->'items'),5,'last page remains available');
select is((public.marketing_post_page(p_month=>'2021-01-01')->>'total')::integer,1204,'month uses Johannesburg publication time and falls back to creation for drafts');
select is((public.marketing_post_page(p_month=>'2020-12-01')->>'total')::integer,1,'upper month boundary is exclusive');
select is((public.marketing_post_page(p_search=>'launch')->>'total')::integer,1200,'campaign names participate in the same search');
select is((public.marketing_post_page(p_search=>'100%_match')->>'total')::integer,1,'ILIKE wildcards in user input are literal');
select is((public.marketing_post_page(p_campaign=>'97000000-0000-0000-0000-000000000012')->>'total')::integer,5,'campaign filtering happens before paging');
select is((public.marketing_post_page(p_status=>'published')->>'total')::integer,2,'status filtering happens before paging');
select is((public.marketing_post_page(p_unassigned=>true)->>'total')::integer,0,'unassigned filter does not include campaign posts');
select is(jsonb_array_length(public.marketing_post_page()->'items'->0->'media'),0,'list does not retrieve full media JSON');
select is(jsonb_array_length(public.marketing_post_page(p_preview=>true)->'items'->0->'media'),1,'previews contain at most one image');
select is((select sum((r->>'posts')::integer)::integer from jsonb_array_elements(public.marketing_post_page(p_summary=>true)->'summary') r),1205,'pivot totals span the entire matching set');
select is(jsonb_array_length((select media from public.posts where id='97000000-0000-0000-0001-000000000003')),2,'detail retains complete media');
select throws_ok($$select public.marketing_post_page(p_limit=>101)$$,'22023',null,'oversized pages rejected');
select throws_ok($$select public.marketing_post_page(p_offset=>-1)$$,'22023',null,'negative offset rejected');
select throws_ok($$insert into public.audit_log(action,entity_type,entity_id) values ('created','post','fake')$$,'42501',null,'browser cannot forge history');
select ok(exists(select 1 from public.audit_log where entity_type='post' and entity_id='97000000-0000-0000-0001-000000000003' and action='created'),'creation is audited');
create temp table post_audit_before as select count(*) n from public.audit_log where entity_type='post' and entity_id='97000000-0000-0000-0001-000000000003';
select public.save_marketing_post('97000000-0000-0000-0001-000000000003','{"title":"Post 3"}');
select is((select count(*) from public.audit_log where entity_type='post' and entity_id='97000000-0000-0000-0001-000000000003'),(select n from post_audit_before),'no-op writes do not create history noise');
select public.save_marketing_post('97000000-0000-0000-0001-000000000003','{"title":"Edited","campaign_id":null}');
select ok(exists(select 1 from public.audit_log where entity_type='post' and entity_id='97000000-0000-0000-0001-000000000003'
  and actor_id=auth.uid() and details->>'actor_name'='Post Administrator' and details->'changed' ? 'campaign_id'),'edit history includes trusted actor and changed fields');
delete from public.posts where id='97000000-0000-0000-0001-000000000003';
select ok(exists(select 1 from public.audit_log where entity_type='post' and entity_id='97000000-0000-0000-0001-000000000003' and action='deleted'),'history survives post deletion');
set local request.jwt.claims='{"sub":"97000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok($$select public.marketing_post_page()$$,'42501',null,'unrelated workspace roles cannot query Marketing posts');
select is((select count(*) from public.audit_log where entity_type='post'),0::bigint,'unrelated roles cannot read post history');
select ok(not has_function_privilege('anon','public.marketing_post_page(date,uuid,boolean,text,text,text,integer,integer,boolean,boolean)','execute'),'signed-out post access denied');
select * from finish();
rollback;
