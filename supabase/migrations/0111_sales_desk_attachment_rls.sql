-- Regression tests exposed cross-owner RFQ/attachment reads. Keep parent row,
-- metadata, Storage and deletion authorization on the same permission checks.
create function public.sales_desk_can_read_rfq(p_rfq_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.has_application_permission('sales_desk','sales_desk.view') and exists(
    select 1 from public.sales_desk_rfqs r where r.id=p_rfq_id and (
      public.has_role('administrator') or public.has_role('sales_manager') or public.has_role('management') or
      (public.has_role('sales') and (r.sales_code_id is null or exists(
        select 1 from public.profiles p join public.sales_desk_sales_codes c on upper(btrim(p.sales_code))=upper(c.code)
        where p.id=auth.uid() and c.id=r.sales_code_id
      )))
    )
  );
$$;
create function public.sales_desk_can_manage_attachment(p_rfq_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.sales_desk_can_read_rfq(p_rfq_id)
    and public.has_application_permission('sales_desk','sales_desk.edit')
    and exists(select 1 from public.sales_desk_rfqs r where r.id=p_rfq_id and r.deleted_at is null and public.sales_desk_manages_row(r));
$$;
create function public.sales_desk_attachment_parent(p_path text)
returns uuid language sql immutable set search_path='' as $$
  select case when split_part(p_path,'/',2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(p_path,'/',2)::uuid else null end;
$$;
create function public.sales_desk_can_read_file(p_path text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.sales_desk_rfq_attachments a where a.storage_path=p_path and public.sales_desk_can_read_rfq(a.rfq_id))
    or (split_part(p_path,'/',1)=auth.uid()::text
      and public.sales_desk_can_read_rfq(public.sales_desk_attachment_parent(p_path))
      and not exists(select 1 from public.sales_desk_rfq_attachments a where a.storage_path=p_path));
$$;
create function public.sales_desk_can_clean_pending_file(p_path text)
returns boolean language sql stable security definer set search_path='' as $$
  select split_part(p_path,'/',1)=auth.uid()::text
    and public.sales_desk_can_read_rfq(public.sales_desk_attachment_parent(p_path))
    and not exists(select 1 from public.sales_desk_rfq_attachments a where a.storage_path=p_path);
$$;
revoke all on function public.sales_desk_can_read_rfq(uuid),public.sales_desk_can_manage_attachment(uuid),
 public.sales_desk_attachment_parent(text),public.sales_desk_can_read_file(text),public.sales_desk_can_clean_pending_file(text) from public,anon;
grant execute on function public.sales_desk_can_read_rfq(uuid),public.sales_desk_can_manage_attachment(uuid),
 public.sales_desk_attachment_parent(text),public.sales_desk_can_read_file(text),public.sales_desk_can_clean_pending_file(text) to authenticated;

drop policy "sales desk users read permitted rfqs" on public.sales_desk_rfqs;
create policy "sales desk users read permitted rfqs" on public.sales_desk_rfqs for select to authenticated
using(public.sales_desk_can_read_rfq(id));

drop policy "active users manage sales desk attachments" on public.sales_desk_rfq_attachments;
revoke update,delete on public.sales_desk_rfq_attachments from authenticated,anon;
create policy "read attachments of permitted rfqs" on public.sales_desk_rfq_attachments for select to authenticated
using(public.sales_desk_can_read_rfq(rfq_id));
create policy "attach files to editable rfqs" on public.sales_desk_rfq_attachments for insert to authenticated
with check(public.sales_desk_can_manage_attachment(rfq_id) and uploaded_by=auth.uid()
  and split_part(storage_path,'/',1)=auth.uid()::text and public.sales_desk_attachment_parent(storage_path)=rfq_id);

drop policy "sales desk users upload attachments" on storage.objects;
drop policy "sales desk users read attachments" on storage.objects;
create policy "sales desk users upload attachments" on storage.objects for insert to authenticated
with check(bucket_id='sales-desk-attachments' and split_part(name,'/',1)=auth.uid()::text
  and public.sales_desk_can_manage_attachment(public.sales_desk_attachment_parent(name)));
create policy "sales desk users read attachments" on storage.objects for select to authenticated
using(bucket_id='sales-desk-attachments' and public.sales_desk_can_read_file(name));
-- Storage is uploaded before metadata. A failed insert must still be able to
-- remove its own unregistered file; this cannot delete registered attachments.
create policy "sales desk uploaders clean up pending files" on storage.objects for delete to authenticated
using(bucket_id='sales-desk-attachments' and public.sales_desk_can_clean_pending_file(name));

create or replace function public.can_delete_record_attachment(record_kind text, parent_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select public.is_active_user() and case record_kind
    when 'return' then public.can_access_workspace('returns_claims')
      and exists (select 1 from public.returns_claims c where c.id = parent_id and c.deleted_at is null)
    when 'rfq' then public.sales_desk_can_manage_attachment(parent_id)
    else false end;
$$;
notify pgrst,'reload schema';
