create sequence if not exists public.sales_desk_invoice_number_seq;
create or replace function public.convert_sales_desk_rfq_to_invoice(source_id uuid)
returns public.sales_desk_rfqs
language plpgsql security definer set search_path = public
as $$
declare source_row public.sales_desk_rfqs; invoice_row public.sales_desk_rfqs; invoice_no text; next_number integer;
begin
  select * into source_row from public.sales_desk_rfqs where id = source_id and deleted_at is null for update;
  if not found then raise exception 'RFQ not found'; end if;
  if source_row.rfq_type = 'invoice' then raise exception 'An invoice cannot be converted to another invoice'; end if;
  if not exists (select 1 from public.sales_desk_statuses where id=source_row.status_id and is_closed=true) then raise exception 'Only a closed RFQ can be converted to an invoice'; end if;
  invoice_no := source_row.rfq_no || 'INV';
  if exists (select 1 from public.sales_desk_rfqs where rfq_no=invoice_no) then raise exception 'An invoice already exists for this RFQ'; end if;
  next_number := nextval('public.sales_desk_invoice_number_seq');
  insert into public.sales_desk_rfqs
    (rfq_no,business_date,daily_number,rfq_type,original_rfq_no,converted_at,media_platform_id,customer_name,contact_number,email_address,query_information,sales_code_id,claimed_at,received_at,remarks,status_id,document_number,created_by,updated_by)
  values
    (invoice_no,source_row.business_date,next_number,'invoice',source_row.rfq_no,now(),source_row.media_platform_id,source_row.customer_name,source_row.contact_number,source_row.email_address,source_row.query_information,source_row.sales_code_id,source_row.claimed_at,source_row.received_at,source_row.remarks,source_row.status_id,source_row.document_number,auth.uid(),auth.uid())
  returning * into invoice_row;
  return invoice_row;
end;
$$;
grant execute on function public.convert_sales_desk_rfq_to_invoice(uuid) to authenticated;
