-- Allow an administrator to retry the same source files after explicitly
-- rejecting a failed or interrupted attempt, while preserving both attempts.

drop index if exists public.stock_import_batches_checksum_unique;
create unique index stock_import_batches_checksum_unique
  on public.stock_import_batches (source_checksum)
  where source_checksum is not null and status <> 'rejected';

create or replace function public.create_stock_import_batch(
  p_source_type text,
  p_source_name text,
  p_source_checksum text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare batch_id uuid;
begin
  if not public.can_administer_stock_control() then
    raise exception using errcode = '42501', message = 'Administrator access is required to import stock data';
  end if;
  if p_source_type not in ('manual_csv','manual_xlsx','google_sheets','qlik','sqlite_migration') then
    raise exception 'Choose a valid stock import source type';
  end if;
  if length(btrim(coalesce(p_source_name,''))) not between 1 and 255 then
    raise exception 'Stock import source name must be between 1 and 255 characters';
  end if;
  if coalesce(btrim(p_source_checksum),'') !~ '^[0-9a-fA-F]{64}$' then
    raise exception 'Stock import checksum must be a SHA-256 value';
  end if;
  if exists (
    select 1 from public.stock_import_batches
    where source_checksum=lower(btrim(p_source_checksum)) and status<>'rejected'
  ) then
    raise exception 'This stock file has already been imported';
  end if;

  insert into public.stock_import_batches(source_type,source_name,source_checksum,imported_by)
  values(p_source_type,btrim(p_source_name),lower(btrim(p_source_checksum)),auth.uid())
  returning id into batch_id;
  insert into public.stock_audit(entity_type,entity_id,actor_user_id,action,changes)
  values('import_batch',batch_id::text,auth.uid(),'staging_started',jsonb_build_object('source_type',p_source_type,'source_name',btrim(p_source_name),'source_checksum',lower(btrim(p_source_checksum))));
  return batch_id;
end;
$$;

revoke all on function public.create_stock_import_batch(text,text,text) from public, anon;
grant execute on function public.create_stock_import_batch(text,text,text) to authenticated;
