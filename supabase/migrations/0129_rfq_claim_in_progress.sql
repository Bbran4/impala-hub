-- Claiming starts work immediately; assignment, start time and status are atomic.
create or replace function public.claim_sales_desk_rfq(p_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.sales_desk_rfqs; own_code uuid; new_status uuid;
begin
  if not public.has_application_permission('sales_desk','sales_desk.assign') or not public.has_role('sales') then raise exception 'Salesperson claim permission required' using errcode='42501'; end if;
  select c.id into own_code from public.sales_desk_sales_codes c join public.profiles p on upper(c.code)=upper(p.sales_code)
    where p.id=auth.uid() and p.active and c.is_active;
  if own_code is null then raise exception 'Your account needs an active sales code' using errcode='42501'; end if;
  select * into r from public.sales_desk_rfqs where id=p_id and deleted_at is null for update;
  if not found or r.sales_code_id is not null then raise exception 'RFQ already claimed or unavailable. Refresh the list.' using errcode='40001'; end if;
  select id into new_status from public.sales_desk_statuses where is_active and not is_closed
    and (semantic_key='in_progress' or metric_category='in_progress' or lower(btrim(name)) in ('in progress','in_progress'))
    order by (semantic_key='in_progress') desc nulls last,(metric_category='in_progress') desc,name,id limit 1;
  if new_status is null then raise exception 'Enable an In Progress status in Sales Desk settings before claiming RFQs' using errcode='22023';end if;
  update public.sales_desk_rfqs set sales_code_id=own_code,claimed_at=now(),status_id=new_status,
    updated_by=auth.uid(),updated_at=now() where id=p_id returning * into r;
  return public.sales_desk_rfq_result(r);
end $$;

