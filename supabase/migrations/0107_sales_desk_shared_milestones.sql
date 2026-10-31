-- Shared, versioned Sales Desk dashboard milestones. Seed only on initial
-- migration; later deployments must never overwrite administrator changes.
create table public.sales_desk_milestone_settings (
  singleton boolean primary key default true check(singleton),
  sales jsonb not null check(jsonb_typeof(sales)='array'),
  gp jsonb not null check(jsonb_typeof(gp)='array'),
  version bigint not null default 0,
  configured boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
-- Retain the previous application defaults until an administrator saves targets
-- or explicitly imports their old browser-only configuration.
insert into public.sales_desk_milestone_settings(singleton,sales,gp) values(true,
  '[{"value":4,"color":"#7b8790"},{"value":9.5,"color":"#6ba8d2"},{"value":15,"color":"#234e70"}]',
  '[{"value":4,"color":"#234e70"},{"value":9.5,"color":"#234e70"},{"value":15,"color":"#234e70"}]');
alter table public.sales_desk_milestone_settings enable row level security;
revoke all on public.sales_desk_milestone_settings from public,anon,authenticated;
grant all on public.sales_desk_milestone_settings to service_role;

create function public.get_sales_desk_milestones()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.has_application_permission('sales_desk','sales_desk.view') then raise exception 'Sales Desk access required' using errcode='42501'; end if;
  return (select jsonb_build_object('sales',s.sales,'gp',s.gp,'version',s.version,'configured',s.configured)
    from public.sales_desk_milestone_settings s where s.singleton);
end;
$$;
create function public.save_sales_desk_milestones(p_sales jsonb,p_gp jsonb,p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare items jsonb; kind text; actual_version bigint;
begin
  if not(public.has_role('administrator') and public.has_application_permission('sales_desk','sales_desk.configuration')) then
    raise exception 'Administrator configuration permission required' using errcode='42501'; end if;
  foreach kind in array array['sales','gp'] loop
    items:=case when kind='sales' then p_sales else p_gp end;
    if jsonb_typeof(items) is distinct from 'array' then raise exception 'Milestones must be arrays' using errcode='22023'; end if;
    if jsonb_array_length(items)>50 then raise exception 'Use no more than 50 milestones per group' using errcode='22023'; end if;
    if exists(select 1 from jsonb_array_elements(items) e where jsonb_typeof(e)<>'object' or jsonb_typeof(e->'value') is distinct from 'number' or
      jsonb_typeof(e->'color') is distinct from 'string' or (e->>'color') !~* '^#[0-9a-f]{6}$') then
      raise exception 'Each milestone needs a numeric value and six-digit hex colour' using errcode='22023'; end if;
    if exists(select 1 from jsonb_array_elements(items) e where (e->>'value')::numeric<0 or
      (e->>'value')::numeric>case when kind='gp' then 100 else 999999999999.99 end or
      (kind='sales' and (e->>'value')::numeric=0) or round((e->>'value')::numeric,2)<>(e->>'value')::numeric) then
      raise exception 'Milestone value is outside its allowed range or precision' using errcode='22023'; end if;
    if (select count(*)<>count(distinct (e->>'value')::numeric) from jsonb_array_elements(items) e) then
      raise exception 'Milestone values must be unique in each group' using errcode='22023'; end if;
  end loop;
  select s.version into actual_version from public.sales_desk_milestone_settings s where s.singleton for update;
  if p_expected_version is null or p_expected_version<>actual_version then
    raise exception 'Milestones changed elsewhere. Reload milestones before saving again.' using errcode='40001'; end if;
  update public.sales_desk_milestone_settings set
    sales=coalesce((select jsonb_agg(jsonb_build_object('value',(e->>'value')::numeric,'color',lower(e->>'color')) order by (e->>'value')::numeric) from jsonb_array_elements(p_sales) e),'[]'),
    gp=coalesce((select jsonb_agg(jsonb_build_object('value',(e->>'value')::numeric,'color',lower(e->>'color')) order by (e->>'value')::numeric) from jsonb_array_elements(p_gp) e),'[]'),
    version=actual_version+1,configured=true,updated_by=auth.uid(),updated_at=now() where singleton;
  return public.get_sales_desk_milestones();
end;
$$;
revoke all on function public.get_sales_desk_milestones(),public.save_sales_desk_milestones(jsonb,jsonb,bigint) from public,anon;
grant execute on function public.get_sales_desk_milestones(),public.save_sales_desk_milestones(jsonb,jsonb,bigint) to authenticated;
notify pgrst,'reload schema';
