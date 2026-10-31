-- RFQ approval confirms a quotation; it never creates an invoice.
insert into public.application_permission_catalog(app_id,permission_key,group_label,label,position) values
('sales_desk','sales_desk.request_approval','Sales Desk','Request RFQ approval',75),
('sales_desk','sales_desk.approve','Sales Desk','Approve RFQs',80);
insert into public.application_role_permissions(role_id,app_id,permission_key) values
('sales','sales_desk','sales_desk.request_approval'),('sales_manager','sales_desk','sales_desk.approve');

alter table public.sales_desk_rfqs
 add column approval_state text not null default 'not_requested' check(approval_state in ('not_requested','pending','approved','changes_requested')),
 add column approval_revision bigint not null default 0,
 add column approval_requested_by uuid references auth.users(id) on delete set null,
 add column approval_requested_at timestamptz,
 add column approval_reviewed_by uuid references auth.users(id) on delete set null,
 add column approval_reviewed_at timestamptz,
 add column approval_note text not null default '';
create index sales_desk_rfqs_pending_approval_idx on public.sales_desk_rfqs(approval_requested_at,id)
where deleted_at is null and approval_state='pending';

create or replace function public.update_sales_desk_rfq(p_id uuid,p_values jsonb)
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
    ('status_id','document_number','remarks')) then
    raise exception 'Consultants can only change status, document number and remarks' using errcode='42501'; end if;
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

create or replace function public.sales_desk_session_context()
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if not public.has_application_permission('sales_desk','sales_desk.view') then raise exception 'Sales Desk access required' using errcode='42501'; end if;
  select jsonb_build_object('id',p.id,'username',p.email,'display_name',p.display_name,'sales_code',p.sales_code,'is_active',p.active,
    'can_request_approval',public.has_role('sales') and public.has_application_permission('sales_desk','sales_desk.edit') and public.has_application_permission('sales_desk','sales_desk.request_approval'),
    'can_approve', (public.has_role('administrator') or public.has_role('sales_manager')) and public.has_application_permission('sales_desk','sales_desk.approve'),
    'role',case when public.has_role('administrator') then 'administrator' when public.has_role('sales_manager') then 'manager'
      when public.has_role('sales') then 'salesperson' when public.has_role('management') then 'management' else 'salesperson' end) into result from public.profiles p where p.id=auth.uid() and p.active;
  return result;
end $$;
-- Internal recipient lookup honors active manager roles and permission overrides.
create function public.sales_desk_approval_recipients()
returns setof uuid language sql stable security definer set search_path='' as $$
 select p.id from public.profiles p where p.active and exists(
   select 1 from public.profile_roles r where r.profile_id=p.id and r.role_id='sales_manager')
 and (exists(select 1 from public.profile_roles r where r.profile_id=p.id and r.role_id='administrator' and not p.normal_user_view)
 or not exists(select 1 from unnest(array['sales_desk.view','sales_desk.approve']) permission_key
   where not coalesce((select o.enabled from public.application_user_permission_overrides o where o.profile_id=p.id and o.app_id='sales_desk' and o.permission_key=permission_key.permission_key),
     exists(select 1 from public.application_role_permissions rp join public.profile_roles r on r.role_id=rp.role_id
       where r.profile_id=p.id and rp.app_id='sales_desk' and rp.permission_key=permission_key.permission_key and (r.role_id<>'administrator' or not p.normal_user_view)))));
$$;
revoke all on function public.sales_desk_approval_recipients() from public,anon,authenticated;

create function public.invalidate_sales_desk_approval()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.approval_state<>'not_requested' and (
   (new.media_platform_id,new.customer_name,new.contact_number,new.email_address,new.query_information,new.remarks,
    new.document_number,new.received_at,new.claimed_at,new.status_id,new.sales_code_id,new.deleted_at)
   is distinct from
   (old.media_platform_id,old.customer_name,old.contact_number,old.email_address,old.query_information,old.remarks,
    old.document_number,old.received_at,old.claimed_at,old.status_id,old.sales_code_id,old.deleted_at)) then
   new.approval_state:='not_requested';new.approval_revision:=old.approval_revision+1;
   new.approval_requested_by:=null;new.approval_requested_at:=null;
   new.approval_reviewed_by:=null;new.approval_reviewed_at:=null;new.approval_note:='';
 end if;
 return new;
end$$;
create trigger invalidate_sales_desk_approval before update on public.sales_desk_rfqs
for each row execute function public.invalidate_sales_desk_approval();
revoke all on function public.invalidate_sales_desk_approval() from public,anon,authenticated;

create function public.invalidate_sales_desk_attachment_approval()
returns trigger language plpgsql security definer set search_path='' as $$
declare parent uuid:=case when tg_op='DELETE' then old.rfq_id else new.rfq_id end;
begin
 update public.sales_desk_rfqs set approval_state='not_requested',approval_revision=approval_revision+1,
   approval_requested_by=null,approval_requested_at=null,approval_reviewed_by=null,approval_reviewed_at=null,approval_note='',
   updated_at=now(),updated_by=coalesce(auth.uid(),updated_by)
 where id=parent and approval_state<>'not_requested';
 return coalesce(new,old);
end$$;
create trigger invalidate_sales_desk_attachment_approval after insert or delete on public.sales_desk_rfq_attachments
for each row execute function public.invalidate_sales_desk_attachment_approval();
revoke all on function public.invalidate_sales_desk_attachment_approval() from public,anon,authenticated;

create function public.request_sales_desk_approval(p_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.sales_desk_rfqs;
begin
 select * into r from public.sales_desk_rfqs where id=p_id and deleted_at is null for update;
 if not found or not public.has_role('sales') or not exists(
   select 1 from public.profiles p join public.sales_desk_sales_codes c on upper(c.code)=upper(p.sales_code)
   where p.id=auth.uid() and c.id=r.sales_code_id and c.is_active)
   or not public.has_application_permission('sales_desk','sales_desk.view')
   or not public.has_application_permission('sales_desk','sales_desk.edit')
   or not public.has_application_permission('sales_desk','sales_desk.request_approval') then
   raise exception 'Consultant approval-request permission required' using errcode='42501';end if;
 if r.rfq_type<>'quotation' or nullif(btrim(r.document_number),'') is null or not exists(
   select 1 from public.sales_desk_statuses s where s.id=r.status_id and s.is_closed and s.metric_category='completed') then
   raise exception 'Complete the quotation and save a document number before requesting approval' using errcode='22023';end if;
 if not exists(select 1 from public.sales_desk_rfq_attachments a join storage.objects o
   on o.bucket_id='sales-desk-attachments' and o.name=a.storage_path where a.rfq_id=r.id) then
   raise exception 'Attach an uploaded document before requesting approval' using errcode='22023';end if;
 if not exists(select 1 from public.sales_desk_approval_recipients() manager_id where manager_id<>auth.uid()) then
   raise exception 'Assign an active Sales Manager with approval permission in App Settings' using errcode='22023';end if;
 if r.approval_state='approved' then raise exception 'This RFQ is already approved' using errcode='55000';end if;
 if r.approval_state='pending' then return public.sales_desk_rfq_result(r);end if;
 update public.sales_desk_rfqs set approval_state='pending',approval_revision=approval_revision+1,
   approval_requested_by=auth.uid(),approval_requested_at=now(),approval_reviewed_by=null,approval_reviewed_at=null,approval_note='',
   updated_by=auth.uid(),updated_at=now() where id=p_id returning * into r;
 return public.sales_desk_rfq_result(r);
end$$;

create function public.review_sales_desk_approval(p_id uuid,p_expected_revision bigint,p_decision text,p_note text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.sales_desk_rfqs;
begin
 if not (public.has_role('administrator') or public.has_role('sales_manager'))
   or not public.has_application_permission('sales_desk','sales_desk.view')
   or not public.has_application_permission('sales_desk','sales_desk.approve') then
   raise exception 'Sales Manager approval permission required' using errcode='42501';end if;
 if p_decision is null or p_decision not in ('approved','changes_requested') or p_note is null or length(p_note)>1000
   or (p_decision='changes_requested' and length(btrim(p_note))<3) then
   raise exception 'Choose a review decision and explain any requested changes' using errcode='22023';end if;
 select * into r from public.sales_desk_rfqs where id=p_id and deleted_at is null for update;
 if not found or r.approval_state<>'pending' or p_expected_revision is distinct from r.approval_revision then
   raise exception 'The approval request changed. Refresh the RFQ before reviewing it' using errcode='40001';end if;
 if r.approval_requested_by=auth.uid() then raise exception 'You cannot approve your own RFQ request' using errcode='42501';end if;
 update public.sales_desk_rfqs set approval_state=p_decision,approval_reviewed_by=auth.uid(),approval_reviewed_at=now(),
   approval_note=btrim(p_note),updated_by=auth.uid(),updated_at=now() where id=p_id returning * into r;
 return public.sales_desk_rfq_result(r);
end$$;

create function public.notify_sales_desk_approval()
returns trigger language plpgsql security definer set search_path='' as $$
declare recipient uuid;
begin
 if old.approval_state='pending' and (new.approval_state<>'pending' or new.approval_revision<>old.approval_revision) then
   update public.user_notifications set read_at=coalesce(read_at,now()) where target_record_id=new.id
     and kind='rfq_approval_requested' and metadata->>'approval_revision'=old.approval_revision::text;
 end if;
 if new.approval_state='pending' and (old.approval_state<>'pending' or new.approval_revision<>old.approval_revision) then
   for recipient in select manager_id from public.sales_desk_approval_recipients() manager_id where manager_id<>new.approval_requested_by loop
     insert into public.user_notifications(user_id,channel,kind,title,description,target_page,target_record_id,actor_user_id,metadata,dedupe_key)
     values(recipient,'sales_desk','rfq_approval_requested','RFQ approval requested: '||new.rfq_no,
       new.customer_name||' · Document '||new.document_number,'RFQs',new.id,auth.uid(),
       jsonb_build_object('approval_revision',new.approval_revision),
       'rfq_approval:'||new.id||':'||new.approval_revision||':'||recipient) on conflict(dedupe_key) do nothing;
   end loop;
 elsif new.approval_state in ('approved','changes_requested') and old.approval_state='pending' and
   exists(select 1 from public.profiles where id=new.approval_requested_by and active) then
   insert into public.user_notifications(user_id,channel,kind,title,description,target_page,target_record_id,actor_user_id,metadata,dedupe_key)
   values(new.approval_requested_by,'sales_desk','rfq_approval_'||new.approval_state,
     case when new.approval_state='approved' then 'RFQ approved: ' else 'RFQ needs changes: ' end||new.rfq_no,
     new.approval_note,'RFQs',new.id,auth.uid(),jsonb_build_object('approval_revision',new.approval_revision),
     'rfq_review:'||new.id||':'||new.approval_revision||':'||new.approval_requested_by) on conflict(dedupe_key) do nothing;
 end if;
 return new;
end$$;
create trigger notify_sales_desk_approval after update on public.sales_desk_rfqs
for each row execute function public.notify_sales_desk_approval();
revoke all on function public.notify_sales_desk_approval() from public,anon,authenticated;
revoke all on function public.request_sales_desk_approval(uuid),public.review_sales_desk_approval(uuid,bigint,text,text) from public,anon;
grant execute on function public.request_sales_desk_approval(uuid),public.review_sales_desk_approval(uuid,bigint,text,text) to authenticated;

create or replace function public.sales_desk_rfq_page(p_filters jsonb default '{}',p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb; ordering text; needle text:=public.list_search_pattern(p_filters->>'search');
begin
  if p_limit is null or p_limit<1 or p_limit>200 or p_offset is null or p_offset<0 or jsonb_typeof(p_filters) is distinct from 'object' then
    raise exception 'Invalid page request' using errcode='22023'; end if;
  ordering:=case coalesce(p_filters->>'sort','received_asc')
    when 'received_asc' then '(r.sales_code_id is not null),r.received_at,r.id'
    when 'received_desc' then 'r.received_at desc,r.id'
    when 'customer' then 'r.customer_name,r.id'
    when 'rfq_no' then 'r.rfq_no desc,r.id' end;
  if ordering is null then raise exception 'Invalid RFQ sort' using errcode='22023'; end if;
  execute format($query$
    with filtered as not materialized (
      select r.* from public.sales_desk_rfqs r where r.deleted_at is null
      and (nullif($1->>'approval','') is null or r.approval_state=$1->>'approval')
      and (nullif($1->>'status','') is null or r.status_id=($1->>'status')::uuid)
      and (nullif($1->>'code','') is null or r.sales_code_id=($1->>'code')::uuid)
      and (nullif($1->>'type','') is null or r.rfq_type=$1->>'type')
      and (coalesce(r.rfq_no,'')||' '||coalesce(r.original_rfq_no,'')||' '||r.customer_name||' '||r.document_number) ilike $2
    ), page as (select r.* from filtered r order by %s limit $3 offset $4)
    select jsonb_build_object('total',(select count(*) from filtered),'limit',$3,'offset',$4,'items',
      coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object(
        'media_platform',jsonb_build_object('name',m.name),'status',jsonb_build_object('name',s.name,'is_closed',s.is_closed),
        'sales_code',jsonb_build_object('code',c.code),
        'attachment_count',(select count(*) from public.sales_desk_rfq_attachments a where a.rfq_id=r.id)) order by %s)
        from page r left join public.sales_desk_media_platforms m on m.id=r.media_platform_id
        left join public.sales_desk_statuses s on s.id=r.status_id left join public.sales_desk_sales_codes c on c.id=r.sales_code_id),'[]'::jsonb))
  $query$,ordering,ordering) into result using p_filters,needle,p_limit,p_offset;
  return result;
end $$;


create or replace function public.audit_sales_desk_rfq()
returns trigger language plpgsql security definer set search_path='' as $$
declare previous jsonb := case when tg_op='INSERT' then '{}'::jsonb else to_jsonb(old) end;
  current_row jsonb := to_jsonb(new); changed text[]; event text;
begin
  select array_agg(k order by k) into changed from (select jsonb_object_keys(previous||current_row) k) keys
  where k not in ('updated_at','updated_by') and previous->k is distinct from current_row->k;
  if tg_op='UPDATE' and coalesce(cardinality(changed),0)=0 then return new; end if;
  event := case when tg_op='INSERT' and new.original_rfq_no is not null then 'created_from_quotation'
    when tg_op='INSERT' then 'created'
    when old.approval_state is distinct from new.approval_state and changed <@ array['approval_state','approval_revision','approval_requested_by','approval_requested_at','approval_reviewed_by','approval_reviewed_at','approval_note']::text[] then
      case new.approval_state when 'pending' then 'approval_requested' when 'approved' then 'approval_approved' when 'changes_requested' then 'approval_changes_requested' else 'approval_invalidated' end
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
    'rfq_no',new.rfq_no,'note',new.approval_note,'approval_revision',new.approval_revision,'sales_code',(select code from public.sales_desk_sales_codes where id=new.sales_code_id),
    'from_sales_code',(select code from public.sales_desk_sales_codes where id=old.sales_code_id),
    'to_sales_code',(select code from public.sales_desk_sales_codes where id=new.sales_code_id),
    'from_rfq_no',new.original_rfq_no,'to_rfq_no',case when event='invoice_copy_created' then new.rfq_no||'INV' else new.rfq_no end,
    'actor_name',coalesce((select nullif(display_name,'') from public.profiles where id=coalesce(auth.uid(),new.updated_by)),'Former employee')));
  return new;
end $$;
