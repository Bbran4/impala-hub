-- Reporting: large data sets.
--   * Report queries get up to 60 seconds. Supabase stops API calls of signed-in users after 8 seconds (the
--     authenticated role's statement_timeout); PostgREST applies a function's own statement_timeout instead,
--     so only these Reporting functions get more time. (The set_config('statement_timeout', ...) inside the
--     functions could not raise it: a running statement keeps the limit it started with.)
--   * bi_agent_link_columns: the columns apps link tables on, for the agent to index (agent 0.6.0), so joining
--     large tables (invoices and their lines) stays fast.
-- Migration numbering: Reporting uses even numbers (see supabase/README.md).

alter function public.bi_query(uuid, jsonb) set statement_timeout = '60s';
alter function public.bi_search_values(uuid, text, jsonb) set statement_timeout = '60s';
alter function public.bi_write_get(uuid, text) set statement_timeout = '60s';
alter function public.bi_render_query(text, jsonb) set statement_timeout = '60s';
alter function public.bi_render_write_get(text, text) set statement_timeout = '60s';
alter function public.bi_render_alert(text) set statement_timeout = '60s';

-- Link columns of the tables this agent loads (ERP tables and its connectors), from every app's data model.
create function public.bi_agent_link_columns(p_agent text)
returns table (table_name text, column_name text)
language sql stable security definer set search_path = ''
as $$
  with pairs as (
    select c.table_name as tbl, p->>0 as col
    from bi.app_tables c, jsonb_array_elements(c.join_pairs) p
    where c.parent_alias is not null and jsonb_typeof(p) = 'array'
    union
    select par.table_name, p->>1
    from bi.app_tables c
    join bi.app_tables par on par.app_id = c.app_id and par.alias = c.parent_alias,
         jsonb_array_elements(c.join_pairs) p
    where jsonb_typeof(p) = 'array'
  )
  select distinct pairs.tbl, pairs.col
  from pairs
  where pairs.col ~ '^[a-z_][a-z0-9_]{0,62}$'
    and (exists (select 1 from bi.load_jobs j where j.target_table = pairs.tbl and j.managed_by = p_agent)
         or exists (select 1 from bi.connectors k where k.name = pairs.tbl and k.agent_name = p_agent))
  order by 1, 2
$$;
revoke all on function public.bi_agent_link_columns(text) from public, anon, authenticated;
grant execute on function public.bi_agent_link_columns(text) to bi_agent, service_role;
