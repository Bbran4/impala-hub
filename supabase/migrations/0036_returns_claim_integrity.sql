-- Make claim lifecycle history atomic with its mutation and harden browser-facing grants.
revoke all on function public.can_access_workspace(text) from public, anon;
grant execute on function public.can_access_workspace(text) to authenticated;

revoke delete on public.returns_claims from authenticated;
revoke insert on public.returns_claims_audit from authenticated;
revoke all on public.returns_claims, public.returns_claims_audit, public.returns_claim_attachments from anon;
drop policy if exists "returns users write audit" on public.returns_claims_audit;

create function public.set_returns_claim_actor_fields()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.updated_by := auth.uid();
    new.created_at := now();
    new.updated_at := now();
    new.deleted_at := null;
    new.deleted_by := null;
  else
    if old.deleted_at is not null then
      raise exception 'Archived claims cannot be edited';
    end if;
    new.created_by := old.created_by;
    new.updated_by := auth.uid();
    new.created_at := old.created_at;
    new.updated_at := now();
    if new.deleted_at is not null then
      if (to_jsonb(new) - array['deleted_at','deleted_by','updated_at','updated_by'])
          is distinct from (to_jsonb(old) - array['deleted_at','deleted_by','updated_at','updated_by']) then
        raise exception 'Delete the claim without changing its other fields';
      end if;
      new.deleted_at := now();
      new.deleted_by := auth.uid();
    else
      new.deleted_by := old.deleted_by;
    end if;
  end if;
  return new;
end;
$$;
create trigger returns_claim_actor_fields before insert or update on public.returns_claims
for each row execute function public.set_returns_claim_actor_fields();

create function public.audit_returns_claim_lifecycle()
returns trigger language plpgsql security definer set search_path = public
as $$
declare changed_fields text[] := array[]::text[]; field text; before_row jsonb; after_row jsonb;
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    insert into public.returns_claims_audit (claim_id,actor_user_id,action,changes)
    values (new.id,auth.uid(),'created',jsonb_build_object('status',new.status));
    return new;
  end if;
  if old.deleted_at is null and new.deleted_at is not null then
    insert into public.returns_claims_audit (claim_id,actor_user_id,action,changes)
    values (new.id,auth.uid(),'deleted','{}'::jsonb);
    return new;
  end if;
  before_row := to_jsonb(old); after_row := to_jsonb(new);
  foreach field in array array['date','company','rfc_book_number','customer','contact_person','contact_number',
    'invoice_number','invoice_date','reason','part_number','description','qty','outcome_request',
    'returned_by','received_by','comments'] loop
    if before_row -> field is distinct from after_row -> field then changed_fields := array_append(changed_fields,field); end if;
  end loop;
  if cardinality(changed_fields) > 0 then
    insert into public.returns_claims_audit (claim_id,actor_user_id,action,changes)
    values (new.id,auth.uid(),'updated',jsonb_build_object('changed',to_jsonb(changed_fields)));
  end if;
  return new;
end;
$$;
create trigger returns_claim_lifecycle_audit after insert or update on public.returns_claims
for each row execute function public.audit_returns_claim_lifecycle();

drop policy if exists "returns users upload files" on storage.objects;
create policy "returns users upload files" on storage.objects for insert to authenticated
with check (
  bucket_id = 'returns-claim-attachments'
  and public.can_access_workspace('returns_claims')
  and (storage.foldername(name))[1] = auth.uid()::text
  and exists (
    select 1 from public.returns_claims c
    where c.id::text = (storage.foldername(name))[2] and c.deleted_at is null
  )
);
