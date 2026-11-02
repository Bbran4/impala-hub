begin;

create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

-- report functions get their own 60 s limit (PostgREST applies it instead of the role's 8 s)
select ok((select proconfig @> array['statement_timeout=60s'] from pg_proc where oid = 'public.bi_query(uuid,jsonb)'::regprocedure), 'bi_query has a 60 s limit');
select ok((select proconfig @> array['statement_timeout=60s'] from pg_proc where oid = 'public.bi_render_query(text,jsonb)'::regprocedure), 'report emails too');
select ok((select proconfig @> array['statement_timeout=60s'] from pg_proc where oid = 'public.bi_search_values(uuid,text,jsonb)'::regprocedure), 'and search');

-- link columns for the agent
insert into bi.load_jobs(target_table,source_name,sql_query,definition_sha256,load_mode,managed_by)
values ('inv_head','erp','SELECT 1 AS invoice_seq',repeat('a',64),'full','erp-agent'),
       ('inv_lines','erp','SELECT 1 AS invoice_seq',repeat('a',64),'full','erp-agent'),
       ('items','erp','SELECT 1 AS item_code',repeat('a',64),'full','other-agent');
insert into bi.apps(id,name) values ('9a000000-0000-0000-0000-000000000001','Sales big');
insert into bi.app_tables(app_id,alias,table_name,parent_alias,join_pairs,position) values
 ('9a000000-0000-0000-0000-000000000001','lines','inv_lines',null,'[]',0),
 ('9a000000-0000-0000-0000-000000000001','head','inv_head','lines','[["invoice_seq","invoice_seq"]]',1),
 ('9a000000-0000-0000-0000-000000000001','it','items','lines','[["item_code","part_number"]]',2);

select results_eq($$select table_name, column_name from public.bi_agent_link_columns('erp-agent')$$,
  $$values ('inv_head'::text,'invoice_seq'::text),('inv_lines','invoice_seq'),('inv_lines','part_number')$$,
  'both sides of every link, only for the tables this agent loads');
select results_eq($$select table_name, column_name from public.bi_agent_link_columns('other-agent')$$,
  $$values ('items'::text,'item_code'::text)$$, 'another agent gets its own tables');
select ok(has_function_privilege('bi_agent','public.bi_agent_link_columns(text)','execute'), 'the agent can call it');
select ok(not has_function_privilege('authenticated','public.bi_agent_link_columns(text)','execute'), 'signed-in users cannot');

select * from finish();
rollback;
