-- Stored files are removed through the Storage API before their metadata is deleted.
-- A failed Storage request leaves the metadata intact so the user can retry.
create function public.can_delete_record_attachment(record_kind text, parent_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select public.is_active_user() and case record_kind
    when 'return' then public.can_access_workspace('returns_claims')
      and exists (select 1 from public.returns_claims c where c.id = parent_id and c.deleted_at is null)
    when 'rfq' then exists (
      select 1 from public.sales_desk_rfqs r where r.id = parent_id and r.deleted_at is null and (
        public.has_role('administrator') or (public.has_role('sales') and exists (
          select 1 from public.profiles p where p.id = auth.uid() and (
            nullif(btrim(p.sales_code),'') is null or exists (
              select 1 from public.sales_desk_sales_codes sc where sc.id = r.sales_code_id and upper(sc.code) = upper(p.sales_code)
            )
          )
        ))
      )
    )
    else false end;
$$;
revoke all on function public.can_delete_record_attachment(text,uuid) from public, anon;
grant execute on function public.can_delete_record_attachment(text,uuid) to authenticated;

create policy "returns users delete registered files" on storage.objects for delete to authenticated
using (bucket_id = 'returns-claim-attachments' and exists (
  select 1 from public.returns_claim_attachments a where a.storage_path = name
  and public.can_delete_record_attachment('return',a.claim_id)
));
create policy "sales users delete registered files" on storage.objects for delete to authenticated
using (bucket_id = 'sales-desk-attachments' and exists (
  select 1 from public.sales_desk_rfq_attachments a where a.storage_path = name
  and public.can_delete_record_attachment('rfq',a.rfq_id)
));

revoke delete on public.returns_claim_attachments, public.sales_desk_rfq_attachments from anon, authenticated;
create function public.finish_attachment_deletion(record_kind text, parent_id uuid, attachment_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare a record; bucket text;
begin
  if not coalesce(public.can_delete_record_attachment(record_kind,parent_id),false) then
    raise exception 'You do not have permission to delete this attachment' using errcode = '42501';
  end if;
  if record_kind = 'return' then
    select id,storage_path,original_name into a from public.returns_claim_attachments
      where id = attachment_id and claim_id = parent_id for update;
    bucket := 'returns-claim-attachments';
  elsif record_kind = 'rfq' then
    select id,storage_path,original_name into a from public.sales_desk_rfq_attachments
      where id = attachment_id and rfq_id = parent_id for update;
    bucket := 'sales-desk-attachments';
  else raise exception 'Unknown attachment type'; end if;
  if a.id is null then return; end if;
  if exists (select 1 from storage.objects o where o.bucket_id = bucket and o.name = a.storage_path) then
    raise exception 'The stored file must be removed before deleting the attachment entry';
  end if;
  if record_kind = 'return' then
    insert into public.returns_claims_audit (claim_id,actor_user_id,action,changes)
    values (parent_id,auth.uid(),'attachment_deleted',jsonb_build_object('file',a.original_name));
    delete from public.returns_claim_attachments where id = a.id;
  else
    insert into public.sales_desk_rfq_audit (rfq_id,actor_user_id,action,changes)
    values (parent_id,auth.uid(),'attachment_deleted',jsonb_build_object('file',a.original_name));
    delete from public.sales_desk_rfq_attachments where id = a.id;
  end if;
end;
$$;
revoke all on function public.finish_attachment_deletion(text,uuid,uuid) from public, anon;
grant execute on function public.finish_attachment_deletion(text,uuid,uuid) to authenticated;
