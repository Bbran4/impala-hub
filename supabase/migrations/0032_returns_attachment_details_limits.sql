-- Only reveal names of people already referenced by this claim's history/files.
create or replace function public.returns_claim_people(target_claim_id uuid)
returns table(id uuid, display_name text)
language sql stable security definer set search_path = public
as $$
  select p.id, coalesce(nullif(btrim(p.display_name), ''), 'Employee')
  from public.profiles p
  where public.can_access_workspace('returns_claims')
    and exists (select 1 from public.returns_claims c where c.id = target_claim_id)
    and (exists (select 1 from public.returns_claims_audit a where a.claim_id = target_claim_id and a.actor_user_id = p.id)
      or exists (select 1 from public.returns_claim_attachments a where a.claim_id = target_claim_id and a.uploaded_by = p.id));
$$;
revoke all on function public.returns_claim_people(uuid) from public, anon;
grant execute on function public.returns_claim_people(uuid) to authenticated;

update storage.buckets set file_size_limit = 15728640,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif','application/pdf',
    'application/msword','application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
where id = 'returns-claim-attachments';

create or replace function public.validate_returns_attachment()
returns trigger language plpgsql security definer set search_path = public
as $$
declare existing_count integer;
begin
  -- Serialize attachment registration per claim, including concurrent browser uploads.
  perform 1 from public.returns_claims where id = new.claim_id and deleted_at is null for update;
  if not found then raise exception 'Claim is missing or deleted'; end if;
  select count(*) into existing_count from public.returns_claim_attachments where claim_id = new.claim_id;
  if existing_count >= 10 then raise exception 'A claim can have at most 10 attachments'; end if;
  if new.size <= 0 or new.size > 15728640 then raise exception 'Attachments must be between 1 byte and 15 MB'; end if;
  if not (
    (lower(new.original_name) ~ '\.(jpg|jpeg)$' and new.content_type = 'image/jpeg') or
    (lower(new.original_name) ~ '\.png$' and new.content_type = 'image/png') or
    (lower(new.original_name) ~ '\.webp$' and new.content_type = 'image/webp') or
    (lower(new.original_name) ~ '\.gif$' and new.content_type = 'image/gif') or
    (lower(new.original_name) ~ '\.pdf$' and new.content_type = 'application/pdf') or
    (lower(new.original_name) ~ '\.doc$' and new.content_type = 'application/msword') or
    (lower(new.original_name) ~ '\.xls$' and new.content_type = 'application/vnd.ms-excel') or
    (lower(new.original_name) ~ '\.docx$' and new.content_type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') or
    (lower(new.original_name) ~ '\.xlsx$' and new.content_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  ) then raise exception 'Unsupported attachment file type'; end if;
  if split_part(new.storage_path, '/', 1) <> new.uploaded_by::text
     or split_part(new.storage_path, '/', 2) <> new.claim_id::text then
    raise exception 'Invalid attachment storage path';
  end if;
  return new;
end;
$$;
create trigger returns_attachment_validate before insert on public.returns_claim_attachments
for each row execute function public.validate_returns_attachment();

-- Storage cleanup is permitted only for the caller's own unregistered uploads.
create policy "returns users clean failed uploads" on storage.objects for delete to authenticated
using (bucket_id = 'returns-claim-attachments' and public.can_access_workspace('returns_claims')
  and (storage.foldername(name))[1] = auth.uid()::text
  and not exists (select 1 from public.returns_claim_attachments a where a.storage_path = name));

create or replace function public.audit_returns_attachment()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.returns_claims_audit (claim_id, actor_user_id, action, changes)
  values (new.claim_id, new.uploaded_by, 'attachment_added', jsonb_build_object('file', new.original_name));
  return new;
end;
$$;
create trigger returns_attachment_audit after insert on public.returns_claim_attachments
for each row execute function public.audit_returns_attachment();
