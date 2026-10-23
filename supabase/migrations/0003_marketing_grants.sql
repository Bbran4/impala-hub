-- RLS controls which rows are visible; Postgres privileges control whether
-- the authenticated role may access the tables at all.
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.campaign_types to authenticated;
grant select, insert, update, delete on public.campaigns to authenticated;
grant select, insert, update, delete on public.posts to authenticated;
grant select, insert on public.audit_log to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- The profile lookup used by the RLS helper must also be reachable by the
-- authenticated role. Row-level policies still limit it to the current user.
grant select on public.profiles to authenticated;
grant select on public.roles to authenticated;
grant select on public.profile_roles to authenticated;
