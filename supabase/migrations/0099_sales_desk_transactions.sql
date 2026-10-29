-- Daily counters include legacy invoices because (business_date,daily_number) is unique.
create table public.sales_desk_number_counters(business_date date primary key,last_value integer not null check(last_value>=0));
insert into public.sales_desk_number_counters select business_date,max(daily_number) from public.sales_desk_rfqs group by business_date;
alter table public.sales_desk_number_counters enable row level security;
revoke all on public.sales_desk_number_counters from public,anon,authenticated;

create or replace function public.next_sales_desk_rfq_number()
returns table(rfq_no text,business_date date,daily_number integer)
language plpgsql security definer set search_path='' as $$
declare d date := (now() at time zone 'Africa/Johannesburg')::date; n integer;
begin
  insert into public.sales_desk_number_counters as counters values(d,1)
  on conflict on constraint sales_desk_number_counters_pkey do update set last_value=counters.last_value+1 returning last_value into n;
  return query select 'IMP'||to_char(d,'YYMMDD')||lpad(n::text,greatest(2,length(n::text)),'0'),d,n;
end $$;
revoke all on function public.next_sales_desk_rfq_number() from public,anon,authenticated;

-- Trusted imports can advance the high-water mark, but browser clients cannot bypass commands.
create function public.track_sales_desk_number()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.sales_desk_number_counters as counters values(new.business_date,new.daily_number)
  on conflict on constraint sales_desk_number_counters_pkey do update set last_value=greatest(counters.last_value,excluded.last_value);
  return new;
end $$;
revoke all on function public.track_sales_desk_number() from public,anon,authenticated;
create trigger sales_desk_track_number before insert on public.sales_desk_rfqs for each row execute function public.track_sales_desk_number();

revoke insert,update,delete on public.sales_desk_rfqs from public,anon,authenticated;
revoke insert,update,delete on public.sales_desk_rfq_audit from public,anon,authenticated;
drop policy if exists "sales desk users read permitted rfqs" on public.sales_desk_rfqs;
create policy "sales desk users read permitted rfqs" on public.sales_desk_rfqs for select to authenticated
using (public.has_application_permission('sales_desk','sales_desk.view') and (
  public.has_role('administrator') or public.has_role('management') or public.has_role('sales_manager') or
  (public.has_role('sales') and (sales_code_id is null or exists(select 1 from public.profiles p where p.id=auth.uid()
    and (nullif(btrim(p.sales_code),'') is null or exists(select 1 from public.sales_desk_sales_codes c where c.id=sales_code_id and upper(c.code)=upper(p.sales_code))))))));
drop policy if exists "active users write sales desk audit" on public.sales_desk_rfq_audit;
drop policy if exists "active users read sales desk audit" on public.sales_desk_rfq_audit;
create policy "read audit for permitted rfqs" on public.sales_desk_rfq_audit for select to authenticated
using (public.has_application_permission('sales_desk','sales_desk.view') and exists(select 1 from public.sales_desk_rfqs r where r.id=rfq_id));

create function public.audit_sales_desk_rfq()
returns trigger language plpgsql security definer set search_path='' as $$
declare previous jsonb := case when tg_op='INSERT' then '{}'::jsonb else to_jsonb(old) end;
  current_row jsonb := to_jsonb(new); changed text[]; event text;
begin
  select array_agg(k order by k) into changed from (select jsonb_object_keys(previous||current_row) k) keys
  where k not in ('updated_at','updated_by') and previous->k is distinct from current_row->k;
  if tg_op='UPDATE' and coalesce(cardinality(changed),0)=0 then return new; end if;
  event := case when tg_op='INSERT' and new.original_rfq_no is not null then 'created_from_quotation'
    when tg_op='INSERT' then 'created'
    when old.deleted_at is null and new.deleted_at is not null then 'deleted'
    when new.converted_at is distinct from old.converted_at and new.converted_at is not null then 'invoice_copy_created'
    when new.sales_code_id is distinct from old.sales_code_id then
      case when new.sales_code_id is null then 'unassigned' when old.sales_code_id is not null then 'reassigned'
        when not(public.has_role('administrator') or public.has_role('sales_manager')) then 'claimed' else 'assigned' end
    else 'updated' end;
  insert into public.sales_desk_rfq_audit(rfq_id,actor_user_id,action,changes)
  values(new.id,coalesce(auth.uid(),new.updated_by),event,jsonb_build_object('changed',changed,
    'before',(previous-'updated_at')||jsonb_build_object('status',(select name from public.sales_desk_statuses where id=old.status_id),
      'media_platform',(select name from public.sales_desk_media_platforms where id=old.media_platform_id)),
    'after',(current_row-'updated_at')||jsonb_build_object('status',(select name from public.sales_desk_statuses where id=new.status_id),
      'media_platform',(select name from public.sales_desk_media_platforms where id=new.media_platform_id)),
    'rfq_no',new.rfq_no,'sales_code',(select code from public.sales_desk_sales_codes where id=new.sales_code_id),
    'from_sales_code',(select code from public.sales_desk_sales_codes where id=old.sales_code_id),
    'to_sales_code',(select code from public.sales_desk_sales_codes where id=new.sales_code_id),
    'from_rfq_no',new.original_rfq_no,'to_rfq_no',case when event='invoice_copy_created' then new.rfq_no||'INV' else new.rfq_no end,
    'actor_name',coalesce((select nullif(display_name,'') from public.profiles where id=coalesce(auth.uid(),new.updated_by)),'Former employee')));
  return new;
end $$;
revoke all on function public.audit_sales_desk_rfq() from public,anon,authenticated;
create trigger sales_desk_rfq_audit_write after insert or update on public.sales_desk_rfqs for each row execute function public.audit_sales_desk_rfq();

-- Private helpers never grant privileged row access directly to API callers.
create function public.sales_desk_manages_row(p_row public.sales_desk_rfqs)
returns boolean language sql stable security definer set search_path='' as $$
  select public.is_active_user() and (public.has_role('administrator') or public.has_role('sales_manager') or
    (public.has_role('sales') and exists(select 1 from public.profiles p join public.sales_desk_sales_codes c
      on upper(c.code)=upper(p.sales_code) where p.id=auth.uid() and c.id=(p_row).sales_code_id)));
$$;
revoke all on function public.sales_desk_manages_row(public.sales_desk_rfqs) from public,anon,authenticated;
create function public.sales_desk_rfq_result(p_row public.sales_desk_rfqs)
returns jsonb language sql stable security definer set search_path='' as $$
  select to_jsonb(p_row)||jsonb_build_object('media_platform',m.name,'status',s.name,'status_name',s.name,
    'status_is_closed',s.is_closed,'sales_code',c.code)
  from public.sales_desk_media_platforms m,public.sales_desk_statuses s
  left join public.sales_desk_sales_codes c on c.id=(p_row).sales_code_id
  where m.id=(p_row).media_platform_id and s.id=(p_row).status_id;
$$;
revoke all on function public.sales_desk_rfq_result(public.sales_desk_rfqs) from public,anon,authenticated;

create function public.create_sales_desk_rfq(p_values jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.sales_desk_rfqs; n record;
begin
  if not public.has_application_permission('sales_desk','sales_desk.create') or not (public.has_role('administrator') or public.has_role('sales_manager')) then
    raise exception 'Sales Desk administrator or manager create permission required' using errcode='42501'; end if;
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

create function public.update_sales_desk_rfq(p_id uuid,p_values jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare before_row public.sales_desk_rfqs; r public.sales_desk_rfqs; staff boolean := public.has_role('administrator') or public.has_role('sales_manager');
begin
  select * into before_row from public.sales_desk_rfqs where id=p_id and deleted_at is null for update;
  if not found or not public.has_application_permission('sales_desk','sales_desk.edit') or not public.sales_desk_manages_row(before_row) then
    raise exception 'RFQ edit permission required' using errcode='42501'; end if;
  if p_values is null or jsonb_typeof(p_values)<>'object' or exists(select 1 from jsonb_object_keys(p_values) k where k not in
    ('media_platform_id','customer_name','contact_number','email_address','query_information','remarks','document_number','received_at','status_id','sales_code_id','claimed_at')) then
    raise exception 'Unsupported RFQ fields' using errcode='22023'; end if;
  if not staff and exists(select 1 from jsonb_object_keys(p_values) k where k not in
    ('customer_name','contact_number','email_address','query_information','received_at','claimed_at','remarks','document_number')) then
    raise exception 'Only managers can change RFQ assignment, documents or workflow' using errcode='42501'; end if;
  r := jsonb_populate_record(before_row,p_values);
  if nullif(btrim(r.customer_name),'') is null or r.received_at is null then raise exception 'Customer name and received date required' using errcode='22023'; end if;
  if r.status_id is distinct from before_row.status_id and not exists(select 1 from public.sales_desk_statuses where id=r.status_id and is_active) then raise exception 'Choose an active RFQ status' using errcode='22023'; end if;
  if r.media_platform_id is distinct from before_row.media_platform_id and not exists(select 1 from public.sales_desk_media_platforms where id=r.media_platform_id and is_active) then raise exception 'Choose an active media platform' using errcode='22023'; end if;
  if r.sales_code_id is distinct from before_row.sales_code_id then
    if not public.has_application_permission('sales_desk','sales_desk.assign') then raise exception 'Assignment permission required' using errcode='42501'; end if;
    if r.sales_code_id is not null and not exists(select 1 from public.sales_desk_sales_codes where id=r.sales_code_id and is_active) then raise exception 'Choose an active sales code' using errcode='22023'; end if;
    r.claimed_at := case when r.sales_code_id is null then null when p_values ? 'claimed_at' then coalesce(r.claimed_at,now()) else now() end;
  end if;
  update public.sales_desk_rfqs set media_platform_id=r.media_platform_id,customer_name=btrim(r.customer_name),contact_number=r.contact_number,
    email_address=r.email_address,query_information=r.query_information,remarks=r.remarks,document_number=r.document_number,received_at=r.received_at,
    status_id=r.status_id,sales_code_id=r.sales_code_id,claimed_at=r.claimed_at,updated_by=auth.uid(),updated_at=now() where id=p_id returning * into r;
  return public.sales_desk_rfq_result(r);
end $$;

create function public.claim_sales_desk_rfq(p_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.sales_desk_rfqs; own_code uuid; new_status uuid;
begin
  if not public.has_application_permission('sales_desk','sales_desk.assign') or not public.has_role('sales') then raise exception 'Salesperson claim permission required' using errcode='42501'; end if;
  select c.id into own_code from public.sales_desk_sales_codes c join public.profiles p on upper(c.code)=upper(p.sales_code)
    where p.id=auth.uid() and p.active and c.is_active;
  if own_code is null then raise exception 'Your account needs an active sales code' using errcode='42501'; end if;
  select * into r from public.sales_desk_rfqs where id=p_id and deleted_at is null for update;
  if not found or r.sales_code_id is not null then raise exception 'RFQ already claimed or unavailable. Refresh the list.' using errcode='40001'; end if;
  select id into new_status from public.sales_desk_statuses where lower(name)='new' and is_active;
  update public.sales_desk_rfqs set sales_code_id=own_code,claimed_at=now(),status_id=coalesce(new_status,r.status_id),
    updated_by=auth.uid(),updated_at=now() where id=p_id returning * into r;
  return public.sales_desk_rfq_result(r);
end $$;

create function public.archive_sales_desk_rfq(p_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare r public.sales_desk_rfqs;
begin
  select * into r from public.sales_desk_rfqs where id=p_id and deleted_at is null for update;
  if not found then return false; end if;
  if not public.has_application_permission('sales_desk','sales_desk.delete') or not public.sales_desk_manages_row(r) then raise exception 'RFQ delete permission required' using errcode='42501'; end if;
  update public.sales_desk_rfqs set deleted_at=now(),deleted_by=auth.uid(),updated_by=auth.uid(),updated_at=now() where id=p_id;
  return true;
end $$;

create or replace function public.convert_sales_desk_rfq_to_invoice(source_id uuid)
returns public.sales_desk_rfqs language plpgsql security definer set search_path='' as $$
declare r public.sales_desk_rfqs; invoice public.sales_desk_rfqs; n integer;
begin
  select * into r from public.sales_desk_rfqs where id=source_id and deleted_at is null for update;
  if not found or not public.has_application_permission('sales_desk','sales_desk.edit') or not public.sales_desk_manages_row(r) then raise exception 'RFQ conversion permission required' using errcode='42501'; end if;
  if r.rfq_type='invoice' then raise exception 'An invoice cannot be converted again' using errcode='22023'; end if;
  if not exists(select 1 from public.sales_desk_statuses where id=r.status_id and is_closed) then raise exception 'Only a closed RFQ can be converted' using errcode='22023'; end if;
  select * into invoice from public.sales_desk_rfqs where rfq_no=r.rfq_no||'INV';
  if found then
    if invoice.deleted_at is not null then raise exception 'Invoice copy is archived' using errcode='22023'; end if;
    return invoice;
  end if;
  insert into public.sales_desk_number_counters as counters values(r.business_date,1)
  on conflict on constraint sales_desk_number_counters_pkey do update set last_value=counters.last_value+1 returning last_value into n;
  insert into public.sales_desk_rfqs(rfq_no,business_date,daily_number,rfq_type,original_rfq_no,converted_at,media_platform_id,
    customer_name,contact_number,email_address,query_information,sales_code_id,claimed_at,received_at,remarks,status_id,document_number,created_by,updated_by)
  values(r.rfq_no||'INV',r.business_date,n,'invoice',r.rfq_no,now(),r.media_platform_id,r.customer_name,r.contact_number,r.email_address,
    r.query_information,r.sales_code_id,r.claimed_at,r.received_at,r.remarks,r.status_id,r.document_number,auth.uid(),auth.uid()) returning * into invoice;
  update public.sales_desk_rfqs set converted_at=now(),updated_by=auth.uid(),updated_at=now() where id=source_id;
  return invoice;
end $$;

revoke all on function public.create_sales_desk_rfq(jsonb),public.update_sales_desk_rfq(uuid,jsonb),public.claim_sales_desk_rfq(uuid),
  public.archive_sales_desk_rfq(uuid),public.convert_sales_desk_rfq_to_invoice(uuid) from public,anon;
grant execute on function public.create_sales_desk_rfq(jsonb),public.update_sales_desk_rfq(uuid,jsonb),public.claim_sales_desk_rfq(uuid),
  public.archive_sales_desk_rfq(uuid),public.convert_sales_desk_rfq_to_invoice(uuid) to authenticated;

create function public.sales_desk_session_context()
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if not public.has_application_permission('sales_desk','sales_desk.view') then raise exception 'Sales Desk access required' using errcode='42501'; end if;
  select jsonb_build_object('id',p.id,'username',p.email,'display_name',p.display_name,'sales_code',p.sales_code,'is_active',p.active,
    'role',case when public.has_role('administrator') then 'administrator' when public.has_role('management') then 'management'
      when public.has_role('sales_manager') then 'manager' else 'salesperson' end) into result from public.profiles p where p.id=auth.uid() and p.active;
  return result;
end $$;
revoke all on function public.sales_desk_session_context() from public,anon;
grant execute on function public.sales_desk_session_context() to authenticated;

create function public.sales_desk_configuration()
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
    'can_configure',public.has_role('administrator') and public.has_application_permission('sales_desk','sales_desk.configuration')) into result;
  return result;
end $$;
revoke all on function public.sales_desk_configuration() from public,anon;
grant execute on function public.sales_desk_configuration() to authenticated;

create function public.reorder_sales_desk_config(p_kind text,p_ids uuid[])
returns uuid[] language plpgsql security definer set search_path='' as $$
declare target text; total integer;
begin
  if not(public.has_role('administrator') and public.has_application_permission('sales_desk','sales_desk.configuration')) then raise exception 'Administrator configuration permission required' using errcode='42501'; end if;
  target := case p_kind when 'media-platforms' then 'sales_desk_media_platforms' when 'statuses' then 'sales_desk_statuses' else null end;
  if target is null then raise exception 'Invalid configuration kind' using errcode='22023'; end if;
  execute format('lock table public.%I in share row exclusive mode',target);
  execute format('select count(*) from public.%I',target) into total;
  if p_ids is null or cardinality(p_ids)<>total or exists(select 1 from unnest(p_ids) id group by id having count(*)>1)
    or array_position(p_ids,null) is not null then raise exception 'Supply every configuration ID exactly once' using errcode='22023'; end if;
  execute format('select count(*) from public.%I where id=any($1)',target) into total using p_ids;
  if total<>cardinality(p_ids) then raise exception 'Configuration changed. Refresh before reordering.' using errcode='22023'; end if;
  execute format('update public.%I t set sort_order=o.position-1 from unnest($1) with ordinality o(id,position) where t.id=o.id',target) using p_ids;
  return p_ids;
end $$;
revoke all on function public.reorder_sales_desk_config(text,uuid[]) from public,anon;
grant execute on function public.reorder_sales_desk_config(text,uuid[]) to authenticated;
