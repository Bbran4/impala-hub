do $$
declare unknown_statuses text;
begin
  select string_agg(display_status, ', ' order by display_status) into unknown_statuses
  from (
    select distinct coalesce(status, '<NULL>') as display_status
    from public.returns_claims
    where status is null or status not in ('Waiting for Info from Customer','Waiting for Reply from Supplier','In Progress',
      'Completed','Awaiting Pickup/dropoff at supplier','Rejected')
  ) unexpected;
  if unknown_statuses is not null then
    raise exception 'Cannot add Returns & Claims status validation. Resolve unexpected statuses first: %', unknown_statuses
      using hint = 'Update these records to one of the six supported statuses, then run the migration again.';
  end if;
end;
$$;

alter table public.returns_claims
  add column sla_days smallint not null default 7 check (sla_days between 1 and 365),
  add column status_change_reason text not null default '',
  add column status_changed_at timestamptz not null default now(),
  add column closed_at timestamptz;

update public.returns_claims set status_changed_at = updated_at,
  closed_at = case when status in ('Completed','Rejected') then updated_at else null end;

create function public.validate_returns_status_transition()
returns trigger language plpgsql security definer set search_path = public
as $$
declare changed boolean; receipt_changed boolean;
begin
  if new.status not in ('Waiting for Info from Customer','Waiting for Reply from Supplier','In Progress',
    'Completed','Awaiting Pickup/dropoff at supplier','Rejected') then raise exception 'Unknown return/claim status'; end if;
  if tg_op = 'INSERT' then
    if new.status in ('Completed','Rejected') then raise exception 'Create the claim in an open status first'; end if;
    changed := true; receipt_changed := false;
    new.status_changed_at := now(); new.closed_at := null;
  else
    changed := new.status is distinct from old.status;
    receipt_changed := row(new.outcome_request,new.credit_received_on,new.replacement_received_on,new.handover_method,new.handover_status)
      is distinct from row(old.outcome_request,old.credit_received_on,old.replacement_received_on,old.handover_method,old.handover_status);
    new.status_changed_at := old.status_changed_at; new.closed_at := old.closed_at;
    if changed then
      if old.status in ('Completed','Rejected') then
        if new.status <> 'In Progress' then raise exception 'Reopen a closed claim to In Progress before moving to another status'; end if;
        if btrim(new.status_change_reason) = '' or lower(regexp_replace(btrim(new.status_change_reason), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(old.status_change_reason), '\s+', ' ', 'g')) then
          raise exception 'Enter a new reason for reopening this claim';
        end if;
      end if;
      new.status_changed_at := now();
      new.closed_at := case when new.status in ('Completed','Rejected') then now() else null end;
    end if;
  end if;
  if changed then
    if new.status = 'Rejected' and (btrim(new.status_change_reason) = '' or (tg_op = 'UPDATE' and lower(regexp_replace(btrim(new.status_change_reason), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(old.status_change_reason), '\s+', ' ', 'g')))) then
      raise exception 'Enter a new reason for rejecting this claim';
    end if;
    if new.status = 'Waiting for Reply from Supplier' and btrim(new.supplier_name) = '' then raise exception 'Enter the supplier before waiting for a supplier reply'; end if;
    if new.status = 'Awaiting Pickup/dropoff at supplier' and (new.handover_method = 'Not required' or new.handover_status not in ('Pending','Scheduled')) then
      raise exception 'Choose Pickup or Drop-off with a Pending or Scheduled handover';
    end if;
  end if;
  if tg_op = 'UPDATE' and not changed and new.status_change_reason is distinct from old.status_change_reason then
    raise exception 'A status reason can only be changed as part of a status change';
  end if;
  -- Legacy closed records remain editable; new completions and receipt changes must satisfy these rules.
  if new.status = 'Completed' and (changed or receipt_changed) then
    if new.outcome_request is null or new.outcome_request not in ('Credit','Replacement Part') then raise exception 'Choose the outcome before completing this claim'; end if;
    if new.outcome_request = 'Credit' and new.credit_received_on is null then raise exception 'Record credit receipt before completing this claim'; end if;
    if new.outcome_request = 'Replacement Part' and new.replacement_received_on is null then raise exception 'Record replacement receipt before completing this claim'; end if;
    if new.handover_method <> 'Not required' and new.handover_status <> 'Completed' then raise exception 'Complete the required pickup/drop-off before completing this claim'; end if;
  end if;
  return new;
end;
$$;
create trigger returns_status_validation before insert or update on public.returns_claims
for each row execute function public.validate_returns_status_transition();

create function public.audit_returns_status_sla()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then return new; end if;
  if new.status is distinct from old.status then
    insert into public.returns_claims_audit (claim_id,actor_user_id,action,changes)
    values (new.id,auth.uid(),'status_changed',jsonb_build_object('from',old.status,'to',new.status,'reason',new.status_change_reason));
  end if;
  if new.sla_days is distinct from old.sla_days then
    insert into public.returns_claims_audit (claim_id,actor_user_id,action,changes)
    values (new.id,auth.uid(),'sla_changed',jsonb_build_object('from',old.sla_days,'to',new.sla_days));
  end if;
  return new;
end;
$$;
create trigger returns_status_sla_audit after update on public.returns_claims
for each row execute function public.audit_returns_status_sla();
