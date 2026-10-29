-- Explicit reporting semantics survive status renames. Custom statuses start unclassified.
alter table public.sales_desk_statuses add column metric_category text not null default 'other'
  check (metric_category in ('other','in_progress','completed','dropped','scrapped','irrelevant'));
update public.sales_desk_statuses set metric_category = case name
  when 'In Progress' then 'in_progress'
  when 'Converted to Sale' then 'completed' when 'Closed' then 'completed'
  when 'Lost' then 'dropped' when 'Dropped' then 'dropped'
  when 'Scrapped' then 'scrapped' when 'Irrelevant' then 'irrelevant'
  else 'other' end;
create index sales_desk_live_received_idx on public.sales_desk_rfqs(received_at,id) where deleted_at is null;

create function public.sales_desk_period_bounds(p_period text,p_year integer,p_month integer default 1,p_week integer default 1)
returns table(start_date date,end_date date) language plpgsql immutable security invoker set search_path='' as $$
begin
  if p_year is null or p_year not between 2000 and 2100 then raise exception 'Choose a year from 2000 to 2100' using errcode='22023'; end if;
  if p_period='year' then
    start_date := make_date(p_year,1,1); end_date := make_date(p_year+1,1,1);
  elsif p_period='month' then
    if p_month is null or p_month not between 1 and 12 then raise exception 'Invalid month' using errcode='22023'; end if;
    start_date := make_date(p_year,p_month,1); end_date := (start_date+interval '1 month')::date;
  elsif p_period='week' then
    if p_week is null or p_week not between 1 and 53 then raise exception 'Invalid ISO week' using errcode='22023'; end if;
    start_date := date_trunc('week',make_date(p_year,1,4)::timestamp)::date+(p_week-1)*7;
    if extract(isoyear from start_date) <> p_year then raise exception 'This ISO year does not have week 53' using errcode='22023'; end if;
    end_date := start_date+7;
  else raise exception 'Invalid analytics period' using errcode='22023'; end if;
  return next;
end $$;
revoke all on function public.sales_desk_period_bounds(text,integer,integer,integer) from public,anon;
grant execute on function public.sales_desk_period_bounds(text,integer,integer,integer) to authenticated;

create function public.sales_desk_dashboard()
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb; today date := (now() at time zone 'Africa/Johannesburg')::date;
begin
  if not public.has_application_permission('sales_desk','sales_desk.view') then raise exception 'Sales Desk view permission required' using errcode='42501'; end if;
  -- Invoker security preserves the caller's RFQ row-level permissions.
  with rfqs as materialized (
    select r.sales_code_id,r.received_at,s.is_closed,s.metric_category
    from public.sales_desk_rfqs r join public.sales_desk_statuses s on s.id=r.status_id
    where r.deleted_at is null
  ), owners as (
    select distinct upper(btrim(sales_code)) code from public.sales_desk_code_owners()
    where nullif(btrim(sales_code),'') is not null
  ), performance as (
    select c.id,c.code as sales_person,
      count(r.sales_code_id) filter(where r.metric_category='in_progress') as in_progress,
      count(r.sales_code_id) filter(where r.metric_category='completed') as complete,
      count(r.sales_code_id) filter(where r.metric_category='dropped') as dropped,
      count(r.sales_code_id) filter(where r.metric_category='scrapped') as scrapped,
      count(r.sales_code_id) filter(where r.metric_category='irrelevant') as irrelevant,
      count(r.sales_code_id) as total
    from public.sales_desk_sales_codes c join owners o on o.code=upper(btrim(c.code))
    left join rfqs r on r.sales_code_id=c.id where c.is_active group by c.id,c.code
  )
  select jsonb_build_object(
    'business_date',today,
    'unclaimed',(select count(*) from rfqs where sales_code_id is null),
    'claimed',(select count(*) from rfqs where sales_code_id is not null),
    'received_today',(select count(*) from rfqs where received_at >= today::timestamp at time zone 'Africa/Johannesburg'
      and received_at < (today+1)::timestamp at time zone 'Africa/Johannesburg'),
    'open',(select count(*) from rfqs where not is_closed),
    'monthly_sales',(select jsonb_build_object('has_data',count(*)>0,'gross_sales',coalesce(sum(d.gross_sales),0),
      'gp_percent',coalesce(sum(d.gross_sales*d.gp_percent)/nullif(sum(d.gross_sales),0),0))
      from public.sales_desk_daily_sales d join owners o on o.code=upper(btrim(d.sales_person))
      where d.business_date >= date_trunc('month',today::timestamp)::date and d.business_date <= today and not d.is_temporary),
    'daily_sales',coalesce((select jsonb_agg(to_jsonb(d) order by d.gross_sales desc,d.id)
      from public.sales_desk_daily_sales d join owners o on o.code=upper(btrim(d.sales_person))
      where d.business_date=today and not d.is_temporary),'[]'::jsonb),
    'rfq_performance',coalesce((select jsonb_agg(to_jsonb(p) order by p.sales_person) from performance p),'[]'::jsonb)
  ) into result;
  return result;
end $$;
revoke all on function public.sales_desk_dashboard() from public,anon;
grant execute on function public.sales_desk_dashboard() to authenticated;

create function public.sales_desk_analytics(p_period text default 'year',p_year integer default null,p_month integer default 1,p_week integer default 1)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb; selected_year integer := coalesce(p_year,extract(year from now() at time zone 'Africa/Johannesburg')::integer);
  first_day date; after_last_day date;
begin
  if not public.has_application_permission('sales_desk','sales_desk.view') then raise exception 'Sales Desk view permission required' using errcode='42501'; end if;
  select start_date,end_date into first_day,after_last_day from public.sales_desk_period_bounds(p_period,selected_year,p_month,p_week);
  with rows as (
    select date_trunc(case when p_period='year' then 'month' else 'day' end,r.received_at at time zone 'Africa/Johannesburg')::date bucket,
      r.sales_code_id,s.metric_category,r.rfq_type
    from public.sales_desk_rfqs r join public.sales_desk_statuses s on s.id=r.status_id
    where r.deleted_at is null and r.received_at >= first_day::timestamp at time zone 'Africa/Johannesburg'
      and r.received_at < after_last_day::timestamp at time zone 'Africa/Johannesburg'
  ), counts as (
    select bucket,count(*) filter(where sales_code_id is not null) claimed,
      count(*) filter(where metric_category='scrapped') scrapped,
      count(*) filter(where metric_category='dropped') dropped,
      count(*) filter(where metric_category='completed' and rfq_type='quotation') completed,
      count(*) filter(where rfq_type='invoice') invoiced from rows group by bucket
  ), points as (
    select d::date as date,to_char(d,case when p_period='year' then 'Mon' else 'YYYY-MM-DD' end) label,
      coalesce(c.claimed,0) claimed,coalesce(c.scrapped,0) scrapped,coalesce(c.dropped,0) dropped,
      coalesce(c.completed,0) completed,coalesce(c.invoiced,0) invoiced
    from generate_series(first_day::timestamp,(after_last_day-1)::timestamp,
      case when p_period='year' then interval '1 month' else interval '1 day' end) d
    left join counts c on c.bucket=d::date
  )
  select jsonb_build_object('period',p_period,'year',selected_year,'start_date',first_day,'end_date',after_last_day,
    'totals',jsonb_build_object('claimed',sum(claimed),'scrapped',sum(scrapped),'dropped',sum(dropped),'completed',sum(completed),'invoiced',sum(invoiced)),
    'series',jsonb_agg(to_jsonb(points) order by date)) into result from points;
  return result;
end $$;
revoke all on function public.sales_desk_analytics(text,integer,integer,integer) from public,anon;
grant execute on function public.sales_desk_analytics(text,integer,integer,integer) to authenticated;
