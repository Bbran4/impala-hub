-- Google Sheets ingestion is intentionally retired. Preserve its schema and
-- history for auditability, but deactivate sources and remove every callable
-- execution grant until a reviewed Qlik/ERP integration replaces it.

do $$
declare running_job record;
begin
  for running_job in
    select r.id
    from public.stock_ingestion_runs r
    join public.stock_ingestion_sources s on s.id = r.source_id
    where r.status = 'running' and s.provider = 'google_sheets'
    for update of r
  loop
    perform public.finish_stock_ingestion_run(
      running_job.id, 'failed', null, null, 0, 0,
      'Automated stock ingestion was retired.'
    );
  end loop;
end;
$$;

update public.stock_ingestion_sources
set is_active = false, schedule_enabled = false, updated_at = now()
where provider = 'google_sheets' and (is_active or schedule_enabled);

revoke execute on function public.save_stock_ingestion_source(uuid,public.stock_ingestion_provider,text,jsonb,boolean,boolean) from authenticated, service_role;
revoke execute on function public.delete_stock_ingestion_source(uuid) from authenticated, service_role;
revoke execute on function public.claim_stock_ingestion_run(uuid,text,uuid) from authenticated, service_role;
revoke execute on function public.finish_stock_ingestion_run(uuid,text,uuid,text,integer,integer,text) from authenticated, service_role;
revoke execute on function public.service_create_stock_import_batch(uuid,uuid,text,text,text) from authenticated, service_role;
revoke execute on function public.service_validate_and_finish_stock_ingestion(uuid,uuid,uuid,text,integer,integer) from authenticated, service_role;
revoke execute on function public.service_append_stock_booking_items(uuid,uuid,jsonb) from authenticated, service_role;
revoke execute on function public.service_append_stock_reordering_items(uuid,uuid,jsonb) from authenticated, service_role;
revoke execute on function public.service_validate_stock_import(uuid,uuid) from authenticated, service_role;
revoke execute on function public.service_reject_stock_import(uuid,uuid,text) from authenticated, service_role;
