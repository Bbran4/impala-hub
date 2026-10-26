-- Human-readable references preserve UUID keys used by attachments and audit records.
create table public.returns_claim_daily_sequences (
  business_date date primary key, last_number bigint not null check (last_number > 0)
);
alter table public.returns_claim_daily_sequences enable row level security;
revoke all on public.returns_claim_daily_sequences from public, anon, authenticated;
alter table public.returns_claims add column claim_no text;

with numbered as (
  select id, to_char(created_at at time zone 'Africa/Johannesburg','YYYYMMDD') as day,
    row_number() over (partition by (created_at at time zone 'Africa/Johannesburg')::date order by created_at,id) as n
  from public.returns_claims
)
update public.returns_claims c set claim_no = 'RC' || numbered.day ||
  case when numbered.n < 10 then '0' else '' end || numbered.n::text
from numbered where c.id = numbered.id;
insert into public.returns_claim_daily_sequences (business_date,last_number)
select (created_at at time zone 'Africa/Johannesburg')::date, count(*) from public.returns_claims group by 1;
alter table public.returns_claims alter column claim_no set not null;
alter table public.returns_claims add constraint returns_claim_no_unique unique (claim_no);

create function public.set_returns_claim_reference()
returns trigger language plpgsql security definer set search_path = public
as $$
declare business_day date := (now() at time zone 'Africa/Johannesburg')::date; n bigint;
begin
  if tg_op = 'UPDATE' then
    if new.claim_no is distinct from old.claim_no then raise exception 'The return/claim reference cannot be changed'; end if;
    return new;
  end if;
  insert into public.returns_claim_daily_sequences as seq (business_date,last_number) values (business_day,1)
  on conflict (business_date) do update set last_number = seq.last_number + 1
  returning last_number into n;
  new.claim_no := 'RC' || to_char(business_day,'YYYYMMDD') || case when n < 10 then '0' else '' end || n::text;
  return new;
end;
$$;
create trigger returns_claim_reference before insert or update of claim_no on public.returns_claims
for each row execute function public.set_returns_claim_reference();

alter table public.returns_claims
  add column supplier_name text not null default '',
  add column supplier_response text not null default '',
  add column supplier_response_on date,
  add column credit_received_on date,
  add column credit_reference text not null default '',
  add column credit_amount numeric(14,2),
  add column replacement_received_on date,
  add column replacement_reference text not null default '',
  add column replacement_qty integer,
  add column handover_method text not null default 'Not required',
  add column handover_status text not null default 'Not required',
  add column handover_scheduled_on date,
  add column handover_completed_on date,
  add column handover_contact text not null default '',
  add column handover_notes text not null default '',
  add constraint returns_credit_amount_nonnegative check (credit_amount is null or credit_amount >= 0),
  add constraint returns_replacement_qty_positive check (replacement_qty is null or replacement_qty > 0),
  add constraint returns_handover_method check (handover_method in ('Not required','Pickup','Drop-off')),
  add constraint returns_handover_status check (handover_status in ('Not required','Pending','Scheduled','Completed')),
  add constraint returns_handover_consistent check (
    (handover_method = 'Not required' and handover_status = 'Not required') or
    (handover_method in ('Pickup','Drop-off') and handover_status in ('Pending','Scheduled','Completed'))),
  add constraint returns_handover_schedule_required check (handover_status <> 'Scheduled' or handover_scheduled_on is not null),
  add constraint returns_handover_completion_required check (handover_status <> 'Completed' or handover_completed_on is not null),
  add constraint returns_credit_details check (credit_received_on is null or (btrim(credit_reference) <> '' and credit_amount is not null)),
  add constraint returns_replacement_details check (replacement_received_on is null or (btrim(replacement_reference) <> '' and replacement_qty is not null));

-- Record supplier changes in the same transaction as the record update.
create function public.audit_returns_supplier_workflow()
returns trigger language plpgsql security definer set search_path = public
as $$
declare changes jsonb := '{}'::jsonb; field text; before_row jsonb; after_row jsonb;
begin
  before_row := to_jsonb(old); after_row := to_jsonb(new);
  foreach field in array array['supplier_name','supplier_response','supplier_response_on','credit_received_on','credit_reference','credit_amount',
    'replacement_received_on','replacement_reference','replacement_qty','handover_method','handover_status',
    'handover_scheduled_on','handover_completed_on','handover_contact','handover_notes'] loop
    if before_row -> field is distinct from after_row -> field then
      changes := changes || jsonb_build_object(field,jsonb_build_object('from',before_row -> field,'to',after_row -> field));
    end if;
  end loop;
  if changes <> '{}'::jsonb then
    insert into public.returns_claims_audit (claim_id,actor_user_id,action,changes)
    values (new.id,auth.uid(),'supplier_workflow_updated',changes);
  end if;
  return new;
end;
$$;
create trigger returns_supplier_audit after update on public.returns_claims
for each row when (auth.uid() is not null) execute function public.audit_returns_supplier_workflow();

create function public.sync_returns_supplier_receipt()
returns trigger language plpgsql set search_path = public
as $$
begin
  if new.credit_received_on is not null or new.replacement_received_on is not null then
    new.supplier_received := 'Yes';
  elsif tg_op = 'UPDATE' then
    if old.credit_received_on is not null or old.replacement_received_on is not null then new.supplier_received := 'No'; end if;
  end if;
  return new;
end;
$$;
create trigger returns_supplier_receipt before insert or update on public.returns_claims
for each row execute function public.sync_returns_supplier_receipt();
