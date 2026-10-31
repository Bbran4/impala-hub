-- Linked RFQ chat updates and completion timestamps.
alter table public.sales_desk_rfqs add column completed_at timestamptz;
create function public.set_rfq_completion_time() returns trigger language plpgsql security definer set search_path='' as $$
declare completed boolean;
begin
 select metric_category='completed' into completed from public.sales_desk_statuses where id=new.status_id;
 if coalesce(completed,false) then
   if tg_op='INSERT' then new.completed_at:=now();
   elsif new.status_id is distinct from old.status_id and not exists(select 1 from public.sales_desk_statuses where id=old.status_id and metric_category='completed') then new.completed_at:=now();
   end if;
 else new.completed_at:=null;
 end if;
 return new;
end$$;
-- Runs before approval invalidation so corrections invalidate a previous approval too.
create trigger a_set_rfq_completion_time before insert or update on public.sales_desk_rfqs for each row execute function public.set_rfq_completion_time();
revoke all on function public.set_rfq_completion_time() from public,anon,authenticated;
create or replace function public.update_sales_desk_rfq(p_id uuid,p_values jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare before_row public.sales_desk_rfqs; r public.sales_desk_rfqs; staff boolean := public.has_role('administrator') or public.has_role('sales_manager');
begin
  select * into before_row from public.sales_desk_rfqs where id=p_id and deleted_at is null for update;
  if not found or not public.has_application_permission('sales_desk','sales_desk.edit') or not public.sales_desk_manages_row(before_row) then
    raise exception 'RFQ edit permission required' using errcode='42501'; end if;
  if p_values is null or jsonb_typeof(p_values)<>'object' or exists(select 1 from jsonb_object_keys(p_values) k where k not in
    ('media_platform_id','customer_name','contact_number','email_address','query_information','remarks','document_number','received_at','status_id','sales_code_id','claimed_at','completed_at')) then
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
    status_id=r.status_id,sales_code_id=r.sales_code_id,claimed_at=r.claimed_at,completed_at=r.completed_at,updated_by=auth.uid(),updated_at=now() where id=p_id returning * into r;
  return public.sales_desk_rfq_result(r);
end $$;

create or replace function public.invalidate_sales_desk_approval()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.approval_state<>'not_requested' and (
   (new.media_platform_id,new.customer_name,new.contact_number,new.email_address,new.query_information,new.remarks,
    new.document_number,new.received_at,new.claimed_at,new.completed_at,new.status_id,new.sales_code_id,new.deleted_at)
   is distinct from
   (old.media_platform_id,old.customer_name,old.contact_number,old.email_address,old.query_information,old.remarks,
    old.document_number,old.received_at,old.claimed_at,old.completed_at,old.status_id,old.sales_code_id,old.deleted_at)) then
   new.approval_state:='not_requested';new.approval_revision:=old.approval_revision+1;
   new.approval_requested_by:=null;new.approval_requested_at:=null;
   new.approval_reviewed_by:=null;new.approval_reviewed_at:=null;new.approval_note:='';
 end if;
 return new;
end$$;

insert into public.application_permission_catalog(app_id,permission_key,group_label,label,position) values
('sales_desk','sales_desk.send_rfq_update','Workspace','Send RFQ chat updates',90),
('sales_desk','sales_desk.receive_rfq_notifications','Workspace','Receive RFQ notifications',91),
('sales_desk','sales_desk.receive_invoice_notifications','Workspace','Receive RFQ converted to invoice notifications',92);
insert into public.application_role_permissions(role_id,app_id,permission_key) values
('sales','sales_desk','sales_desk.send_rfq_update'),('sales_manager','sales_desk','sales_desk.send_rfq_update'),
('sales_manager','sales_desk','sales_desk.receive_rfq_notifications'),('sales_manager','sales_desk','sales_desk.receive_invoice_notifications');

-- Private evaluator: checks another user's effective permissions, including normal-user view.
create function public.rfq_user_permission(p_user uuid,p_key text) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select p.active and (
 exists(select 1 from public.profile_roles r where r.profile_id=p.id and r.role_id='administrator' and not p.normal_user_view)
 or coalesce((select o.enabled from public.application_user_permission_overrides o where o.profile_id=p.id and o.app_id='sales_desk' and o.permission_key=p_key),
 exists(select 1 from public.application_role_permissions rp join public.profile_roles r on r.role_id=rp.role_id where r.profile_id=p.id and rp.app_id='sales_desk' and rp.permission_key=p_key and (r.role_id<>'administrator' or not p.normal_user_view)))) from public.profiles p where p.id=p_user),false);
$$;
revoke all on function public.rfq_user_permission(uuid,text) from public,anon,authenticated;
create function public.rfq_notification_managers(p_key text) returns setof uuid language sql stable security definer set search_path='' as $$
 select p.id from public.profiles p where p.active and exists(select 1 from public.profile_roles r where r.profile_id=p.id and r.role_id='sales_manager')
 and public.rfq_user_permission(p.id,'sales_desk.view') and public.rfq_user_permission(p.id,p_key);
$$;
revoke all on function public.rfq_notification_managers(text) from public,anon,authenticated;
alter table public.chat_messages add column rfq_id uuid references public.sales_desk_rfqs(id) on delete set null, add column rfq_no text;
create table public.rfq_chat_dispatches(sender_id uuid not null references auth.users(id) on delete cascade, client_id uuid not null, rfq_no text not null, body text not null, result jsonb not null, primary key(sender_id,client_id));
alter table public.rfq_chat_dispatches enable row level security;
revoke all on public.rfq_chat_dispatches from public,anon,authenticated;
-- A newly opened conversation has never been read by its recipient.
create or replace function public.chat_open_direct(other_user_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  first_user uuid;
  second_user uuid;
  result_id uuid;
begin
  if not public.is_active_user() then
    raise exception 'An active account is required' using errcode = '42501';
  end if;
  if other_user_id is null or other_user_id = auth.uid() then
    raise exception 'Choose another active user' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles profile where profile.id = other_user_id and profile.active = true) then
    raise exception 'Active user not found' using errcode = 'P0002';
  end if;

  first_user := least(auth.uid(), other_user_id);
  second_user := greatest(auth.uid(), other_user_id);
  insert into public.chat_conversations (user_one, user_two)
  values (first_user, second_user)
  on conflict (user_one, user_two) do update
    set last_message_at = public.chat_conversations.last_message_at
  returning id into result_id;

  insert into public.chat_read_states (conversation_id, user_id, last_read_at)
  values (result_id, auth.uid(), '-infinity'), (result_id, other_user_id, '-infinity')
  on conflict (conversation_id, user_id) do nothing;
  return result_id;
end;
$$;


create function public.send_rfq_chat_update(p_rfq_no text,p_body text,p_client_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.sales_desk_rfqs; recipient uuid; recipients uuid[]; conv uuid; msg uuid; result jsonb:='[]'; previous public.rfq_chat_dispatches; sender_name text;
begin
 if not public.is_active_user() or not public.has_application_permission('sales_desk','sales_desk.view') or not public.has_application_permission('sales_desk','sales_desk.send_rfq_update') then raise exception 'RFQ chat update permission required' using errcode='42501'; end if;
 if p_client_id is null or char_length(btrim(coalesce(p_body,''))) not between 1 and 4000 then raise exception 'Enter an RFQ number and a message of up to 4000 characters' using errcode='22023'; end if;
 p_rfq_no:=upper(btrim(p_rfq_no)); p_body:=btrim(p_body);
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_client_id::text,0));
 select * into previous from public.rfq_chat_dispatches where sender_id=auth.uid() and client_id=p_client_id;
 if found then
   if previous.rfq_no<>p_rfq_no or previous.body<>p_body then raise exception 'Retry does not match the original RFQ update' using errcode='22023'; end if;
   return previous.result;
 end if;
 select * into r from public.sales_desk_rfqs where rfq_no=p_rfq_no and deleted_at is null for share;
 if not found or not public.sales_desk_manages_row(r) then raise exception 'RFQ not found or access denied' using errcode='42501'; end if;
 if public.has_role('sales_manager') or public.has_role('administrator') then
   select array_agg(p.id) into recipients from public.profiles p join public.sales_desk_sales_codes c on lower(btrim(c.code))=lower(btrim(p.sales_code))
   where c.id=r.sales_code_id and c.is_active and p.active and p.id<>auth.uid()
   and exists(select 1 from public.profile_roles role where role.profile_id=p.id and role.role_id='sales') and public.rfq_user_permission(p.id,'sales_desk.view');
 elsif public.has_role('sales') and exists(select 1 from public.sales_desk_sales_codes c join public.profiles p on lower(btrim(p.sales_code))=lower(btrim(c.code)) where p.id=auth.uid() and c.id=r.sales_code_id and c.is_active) then
   select array_agg(id) into recipients from public.rfq_notification_managers('sales_desk.receive_rfq_notifications') id where id<>auth.uid();
 else raise exception 'Only the assigned consultant or a Sales Manager can send this update' using errcode='42501'; end if;
 if coalesce(cardinality(recipients),0)=0 then raise exception 'No eligible consultant or enabled Sales Manager is available for this RFQ' using errcode='22023'; end if;
 select coalesce(nullif(btrim(display_name),''),email) into sender_name from public.profiles where id=auth.uid();
 foreach recipient in array recipients loop
   conv:=public.chat_open_direct(recipient);
   msg:=public.chat_send_message(conv,gen_random_uuid(),p_body);
   update public.chat_messages set rfq_id=r.id,rfq_no=r.rfq_no where id=msg;
   insert into public.user_notifications(user_id,channel,kind,title,description,target_page,target_record_id,actor_user_id,metadata,dedupe_key)
   values(recipient,'sales_desk','rfq_chat_update',r.rfq_no||' Update',p_body||E'\n'||sender_name,'RFQs',r.id,auth.uid(),jsonb_build_object('conversation_id',conv,'message_id',msg),'rfq_chat:'||msg);
   result:=result||jsonb_build_array(jsonb_build_object('conversation_id',conv,'message_id',msg));
 end loop;
 insert into public.rfq_chat_dispatches values(auth.uid(),p_client_id,p_rfq_no,p_body,result);
 return result;
end$$;
revoke all on function public.send_rfq_chat_update(text,text,uuid) from public,anon;
grant execute on function public.send_rfq_chat_update(text,text,uuid) to authenticated;
drop function if exists public.chat_list_messages(uuid);
create function public.chat_list_messages(target_conversation_id uuid)
returns table(message_id uuid, conversation_id uuid, sender_id uuid, sender_name text, body text, created_at timestamptz, read_by_recipient boolean, attachments jsonb, rfq_id uuid, rfq_no text)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_active_user() or not exists (select 1 from public.chat_conversations conversation where conversation.id = target_conversation_id and auth.uid() in (conversation.user_one, conversation.user_two)) then raise exception 'Chat access denied' using errcode = '42501'; end if;
  insert into public.chat_read_states(conversation_id, user_id, last_read_at) values(target_conversation_id, auth.uid(), now()) on conflict on constraint chat_read_states_pkey do update set last_read_at = greatest(public.chat_read_states.last_read_at, excluded.last_read_at);
  return query select recent.id, recent.conversation_id, recent.sender_id, coalesce(nullif(btrim(sender.display_name), ''), sender.email, 'User'), recent.body, recent.created_at, coalesce(recipient_state.last_read_at >= recent.created_at, false), coalesce((select jsonb_agg(jsonb_build_object('id', attachment.id, 'file_name', attachment.file_name, 'content_type', attachment.content_type, 'size_bytes', attachment.size_bytes, 'storage_path', attachment.storage_path, 'created_at', attachment.created_at) order by attachment.created_at) from public.chat_message_attachments attachment where attachment.direct_message_id = recent.id), '[]'::jsonb), recent.rfq_id, recent.rfq_no
  from (select message.* from public.chat_messages message where message.conversation_id = target_conversation_id order by message.created_at desc, message.id desc limit 200) recent
  join public.profiles sender on sender.id = recent.sender_id join public.chat_conversations conversation on conversation.id = recent.conversation_id left join public.chat_read_states recipient_state on recipient_state.conversation_id = recent.conversation_id and recipient_state.user_id = case when recent.sender_id = conversation.user_one then conversation.user_two else conversation.user_one end
  order by recent.created_at, recent.id;
end;
$$;


revoke all on function public.chat_list_messages(uuid) from public,anon;
grant execute on function public.chat_list_messages(uuid) to authenticated;
notify pgrst,'reload schema';
