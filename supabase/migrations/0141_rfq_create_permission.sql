-- Creation follows effective permissions rather than a second role allowlist.
create or replace function public.create_sales_desk_rfq(p_values jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.sales_desk_rfqs; n record;
begin
  if not public.has_application_permission('sales_desk','sales_desk.view') or not public.has_application_permission('sales_desk','sales_desk.create') then
    raise exception 'Sales Desk view and create permissions required' using errcode='42501'; end if;
  if p_values is null or jsonb_typeof(p_values)<>'object' or exists(select 1 from jsonb_object_keys(p_values) k where k not in
    ('media_platform_id','customer_name','contact_number','email_address','query_information','remarks','document_number','received_at','status_id','sales_code_id','claimed_at')) then
    raise exception 'Unsupported RFQ fields' using errcode='22023'; end if;
  r := jsonb_populate_record(null::public.sales_desk_rfqs,p_values);
  if nullif(btrim(r.customer_name),'') is null then raise exception 'Customer name required' using errcode='22023'; end if;
  if not exists(select 1 from public.sales_desk_media_platforms where id=r.media_platform_id and is_active) then raise exception 'Choose an active media platform' using errcode='22023'; end if;
  if r.status_id is null then select id into r.status_id from public.sales_desk_statuses where lower(name)=case when r.sales_code_id is null then 'unclaimed' else 'new' end and is_active; end if;
  if not exists(select 1 from public.sales_desk_statuses where id=r.status_id and is_active) then raise exception 'Choose an active RFQ status' using errcode='22023'; end if;
  if r.sales_code_id is not null and (not public.has_application_permission('sales_desk','sales_desk.assign') or
    not exists(select 1 from public.sales_desk_sales_codes where id=r.sales_code_id and is_active)) then raise exception 'Active sales code and assignment permission required' using errcode='42501'; end if;
  select * into n from public.next_sales_desk_rfq_number();
  insert into public.sales_desk_rfqs(rfq_no,business_date,daily_number,media_platform_id,customer_name,contact_number,email_address,
    query_information,remarks,document_number,received_at,status_id,sales_code_id,claimed_at,created_by,updated_by)
  values(n.rfq_no,n.business_date,n.daily_number,r.media_platform_id,btrim(r.customer_name),coalesce(r.contact_number,''),coalesce(r.email_address,''),
    coalesce(r.query_information,''),coalesce(r.remarks,''),coalesce(r.document_number,''),coalesce(r.received_at,now()),r.status_id,
    r.sales_code_id,case when r.sales_code_id is not null then coalesce(r.claimed_at,now()) else null end,auth.uid(),auth.uid()) returning * into r;
  return public.sales_desk_rfq_result(r);
end $$;
create or replace function public.sales_desk_configuration()
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if not public.has_application_permission('sales_desk','sales_desk.view') then raise exception 'Sales Desk access required' using errcode='42501'; end if;
  with counts as materialized (select sales_code_id,status_id,media_platform_id,count(*) n from public.sales_desk_rfqs group by sales_code_id,status_id,media_platform_id),
  owners as (select upper(sales_code) code,max(display_name) display_name from public.sales_desk_code_owners() group by upper(sales_code))
  select jsonb_build_object('media_platforms',coalesce((select jsonb_agg(to_jsonb(m)||jsonb_build_object('rfq_count',coalesce((select sum(n) from counts where media_platform_id=m.id),0)) order by sort_order,name) from public.sales_desk_media_platforms m),'[]'::jsonb),
    'statuses',coalesce((select jsonb_agg(to_jsonb(s)||jsonb_build_object('rfq_count',coalesce((select sum(n) from counts where status_id=s.id),0)) order by sort_order,name) from public.sales_desk_statuses s),'[]'::jsonb),
    'sales_codes',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('consultant_name',o.display_name,'rfq_count',coalesce((select sum(n) from counts where sales_code_id=c.id),0)) order by c.code)
      from public.sales_desk_sales_codes c left join owners o on o.code=upper(c.code)),'[]'::jsonb),
    'can_create',public.has_application_permission('sales_desk','sales_desk.create'),
    'can_assign',public.has_application_permission('sales_desk','sales_desk.assign'),
    'can_configure',public.has_role('administrator') and public.has_application_permission('sales_desk','sales_desk.configuration')) into result;
  return result;
end $$;
notify pgrst,'reload schema';
