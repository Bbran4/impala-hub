-- Manager subscriptions are separate from approval routing and consultant alerts.
create function public.notify_sales_desk_managers()
returns trigger language plpgsql security definer set search_path='' as $$
declare recipient uuid; permission_key text; event_kind text; event_title text; event_description text;
 target_id uuid:=new.id; invoice_id uuid; invoice_no text; changed text[]; event_key text;
begin
 if new.deleted_at is not null or new.rfq_type<>'quotation' then return new; end if;
 if tg_op='UPDATE' and new.converted_at is distinct from old.converted_at and new.converted_at is not null then
   permission_key:='sales_desk.receive_invoice_notifications'; event_kind:='rfq_converted_to_invoice';
   select id,rfq_no into invoice_id,invoice_no from public.sales_desk_rfqs where original_rfq_no=new.rfq_no and rfq_type='invoice' and deleted_at is null;
   target_id:=coalesce(invoice_id,new.id);
   event_title:=new.rfq_no||' converted to invoice';
   event_description:=new.customer_name||case when invoice_no is not null then E'\n'||invoice_no else '' end;
   event_key:='rfq_invoice:'||new.id;
 else
   permission_key:='sales_desk.receive_rfq_notifications';
   if tg_op='INSERT' then
     event_kind:='rfq_created'; event_title:=new.rfq_no||' received'; event_description:=new.customer_name;
     event_key:='rfq_created:'||new.id;
   else
     -- Approval-only edits and no-op saves do not generate general alerts.
     select array_agg(k order by k) into changed from unnest(array[
       'media_platform_id','customer_name','contact_number','email_address','query_information',
       'sales_code_id','claimed_at','received_at','completed_at','status_id','document_number','remarks']) k
       where to_jsonb(new)->k is distinct from to_jsonb(old)->k;
     if coalesce(cardinality(changed),0)=0 then return new; end if;
     event_kind:='rfq_updated'; event_title:=new.rfq_no||' Update';
     event_description:=concat_ws(E'\n',new.customer_name,
       case when 'status_id'=any(changed) then 'Status: '||(select name from public.sales_desk_statuses where id=new.status_id) end,
       case when 'sales_code_id'=any(changed) then 'Sales code: '||coalesce((select code from public.sales_desk_sales_codes where id=new.sales_code_id),'Unassigned') end,
       case when 'document_number'=any(changed) then 'Document: '||coalesce(nullif(new.document_number,''),'Cleared') end,
       case when 'remarks'=any(changed) then left(nullif(new.remarks,''),500) end);
     event_key:='rfq_update:'||gen_random_uuid();
   end if;
 end if;
 for recipient in select id from public.rfq_notification_managers(permission_key) id where id is distinct from auth.uid() loop
   insert into public.user_notifications(user_id,channel,kind,title,description,target_page,target_record_id,actor_user_id,metadata,dedupe_key)
   values(recipient,'sales_desk',event_kind,event_title,event_description,'RFQs',target_id,auth.uid(),
     jsonb_build_object('rfq_id',new.id,'rfq_no',new.rfq_no,'invoice_id',invoice_id,'changed',changed),event_key||':'||recipient)
   on conflict(dedupe_key) do nothing;
 end loop;
 return new;
end$$;
create trigger notify_sales_desk_managers after insert or update on public.sales_desk_rfqs for each row execute function public.notify_sales_desk_managers();
revoke all on function public.notify_sales_desk_managers() from public,anon,authenticated;
notify pgrst,'reload schema';
