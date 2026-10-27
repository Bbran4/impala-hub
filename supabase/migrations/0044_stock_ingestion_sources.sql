-- Private stock-ingestion configuration and scheduler run history.
-- Provider credentials remain in the server environment; this schema stores
-- only non-secret identifiers, ranges, scheduling metadata, and safe results.

do $$
begin
  create type public.stock_ingestion_provider as enum ('google_sheets', 'qlik', 'odbc');
exception
  when duplicate_object then null;
end;
$$;

create table public.stock_ingestion_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120 and name !~ '[[:cntrl:]]'),
  provider public.stock_ingestion_provider not null,
  is_active boolean not null default false,
  schedule_enabled boolean not null default false,
  configuration jsonb not null default '{}'::jsonb check (jsonb_typeof(configuration) = 'object' and pg_column_size(configuration) <= 16384),
  configured_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index stock_ingestion_sources_name_ci_unique
  on public.stock_ingestion_sources (lower(name));

create table public.stock_ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.stock_ingestion_sources(id) on delete restrict,
  trigger_type text not null check (trigger_type in ('scheduled', 'manual')),
  status text not null default 'running' check (status in ('running', 'validated', 'no_change', 'failed')),
  import_batch_id uuid references public.stock_import_batches(id) on delete restrict,
  requested_by uuid references auth.users(id),
  actor_user_id uuid not null references auth.users(id),
  source_checksum text check (source_checksum is null or source_checksum ~ '^[0-9a-f]{64}$'),
  booking_row_count integer not null default 0 check (booking_row_count >= 0),
  reordering_row_count integer not null default 0 check (reordering_row_count >= 0),
  error_message text not null default '' check (length(error_message) <= 1000),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  check (
    (status = 'running' and finished_at is null and error_message = '') or
    (status = 'validated' and finished_at is not null and import_batch_id is not null and source_checksum is not null and error_message = '') or
    (status = 'no_change' and finished_at is not null and import_batch_id is not null and source_checksum is not null and error_message = '') or
    (status = 'failed' and finished_at is not null and error_message <> '')
  )
);
create unique index stock_ingestion_runs_one_running_per_source
  on public.stock_ingestion_runs (source_id) where status = 'running';
create index stock_ingestion_runs_source_started_idx
  on public.stock_ingestion_runs (source_id, started_at desc);

alter table public.stock_import_batches
  add column ingestion_run_id uuid unique references public.stock_ingestion_runs(id) on delete restrict;

alter table public.stock_audit drop constraint stock_audit_entity_type_check;
alter table public.stock_audit add constraint stock_audit_entity_type_check
  check (entity_type in ('parts_query', 'parts_query_supplier', 'development_status', 'location', 'settings', 'import_batch', 'ingestion_source'));

alter table public.stock_ingestion_sources enable row level security;
alter table public.stock_ingestion_runs enable row level security;

create policy "stock admins read ingestion sources" on public.stock_ingestion_sources
for select to authenticated using (public.can_administer_stock_control());
create policy "stock admins read ingestion runs" on public.stock_ingestion_runs
for select to authenticated using (public.can_administer_stock_control());

revoke all on public.stock_ingestion_sources, public.stock_ingestion_runs from public, anon, authenticated;
grant select on public.stock_ingestion_sources, public.stock_ingestion_runs to authenticated;
grant select, insert, update, delete on public.stock_ingestion_sources, public.stock_ingestion_runs to service_role;
revoke usage on type public.stock_ingestion_provider from public, anon;
grant usage on type public.stock_ingestion_provider to authenticated, service_role;

create or replace function public.save_stock_ingestion_source(
  p_source_id uuid,
  p_provider public.stock_ingestion_provider,
  p_name text,
  p_configuration jsonb,
  p_is_active boolean,
  p_schedule_enabled boolean
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  saved_id uuid;
  clean_configuration jsonb := coalesce(p_configuration, '{}'::jsonb);
  audit_action text;
begin
  if not public.can_administer_stock_control() then
    raise exception using errcode = '42501', message = 'Administrator access is required to change ingestion sources';
  end if;
  if length(btrim(coalesce(p_name, ''))) not between 1 and 120 then
    raise exception 'Ingestion source name must be between 1 and 120 characters';
  end if;
  if p_provider is null then raise exception 'Choose a valid ingestion provider'; end if;
  if p_name ~ '[[:cntrl:]]' then raise exception 'Ingestion source name must be a single line'; end if;
  if jsonb_typeof(clean_configuration) <> 'object' or pg_column_size(clean_configuration) > 16384 then
    raise exception 'Ingestion source configuration must be a small JSON object';
  end if;

  if p_provider = 'google_sheets' then
    if clean_configuration - array['spreadsheet_id','booking_tab','reordering_tab'] <> '{}'::jsonb then
      raise exception 'Google Sheets configuration contains unsupported fields';
    end if;
    if coalesce(clean_configuration->>'spreadsheet_id', '') !~ '^[A-Za-z0-9_-]{20,200}$' then
      raise exception 'Google Sheets configuration requires a valid spreadsheet_id';
    end if;
    if length(btrim(coalesce(clean_configuration->>'booking_tab', ''))) not between 1 and 120
       or length(btrim(coalesce(clean_configuration->>'reordering_tab', ''))) not between 1 and 120
       or (clean_configuration->>'booking_tab') ~ '[[:cntrl:]]'
       or (clean_configuration->>'reordering_tab') ~ '[[:cntrl:]]' then
      raise exception 'Google Sheets configuration requires booking_tab and reordering_tab';
    end if;
    clean_configuration := jsonb_build_object(
      'spreadsheet_id', btrim(clean_configuration->>'spreadsheet_id'),
      'booking_tab', btrim(clean_configuration->>'booking_tab'),
      'reordering_tab', btrim(clean_configuration->>'reordering_tab')
    );
  elsif coalesce(p_is_active, false) or coalesce(p_schedule_enabled, false) or clean_configuration <> '{}'::jsonb then
    raise exception 'This ingestion provider is reserved for a future implementation';
  end if;

  if coalesce(p_schedule_enabled, false) and not coalesce(p_is_active, false) then
    raise exception 'Scheduled ingestion requires an active source';
  end if;

  if p_source_id is null then
    insert into public.stock_ingestion_sources
      (name, provider, configuration, is_active, schedule_enabled, configured_by)
    values
      (btrim(p_name), p_provider, clean_configuration, coalesce(p_is_active, false),
       coalesce(p_schedule_enabled, false), auth.uid())
    returning id into saved_id;
    audit_action := 'created';
  else
    update public.stock_ingestion_sources
    set name = btrim(p_name), provider = p_provider, configuration = clean_configuration,
        is_active = coalesce(p_is_active, false), schedule_enabled = coalesce(p_schedule_enabled, false),
        configured_by = auth.uid(), updated_at = now()
    where id = p_source_id
    returning id into saved_id;
    if saved_id is null then raise exception 'Ingestion source not found'; end if;
    audit_action := 'updated';
  end if;
  insert into public.stock_audit(entity_type,entity_id,actor_user_id,action,changes)
  values(
    'ingestion_source', saved_id::text, auth.uid(), audit_action,
    jsonb_build_object('provider',p_provider,'name',btrim(p_name),'is_active',coalesce(p_is_active,false),'schedule_enabled',coalesce(p_schedule_enabled,false))
  );
  return saved_id;
end;
$$;

create or replace function public.delete_stock_ingestion_source(p_source_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare source_name text;
begin
  if not public.can_administer_stock_control() then
    raise exception using errcode = '42501', message = 'Administrator access is required to delete ingestion sources';
  end if;
  delete from public.stock_ingestion_sources where id = p_source_id returning name into source_name;
  if not found then raise exception 'Ingestion source not found'; end if;
  insert into public.stock_audit(entity_type,entity_id,actor_user_id,action,changes)
  values('ingestion_source',p_source_id::text,auth.uid(),'deleted',jsonb_build_object('name',source_name));
  return true;
exception
  when foreign_key_violation then
    raise exception 'This ingestion source has run history and must be deactivated instead';
end;
$$;

create or replace function public.assert_active_stock_administrator(p_actor_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_actor_user_id is null or not exists (
    select 1
    from public.profiles p
    join public.profile_roles pr on pr.profile_id = p.id
    where p.id = p_actor_user_id and p.active and pr.role_id = 'administrator'
  ) then
    raise exception using errcode = '42501', message = 'An active administrator actor is required';
  end if;
end;
$$;

create or replace function public.claim_stock_ingestion_run(
  p_source_id uuid,
  p_trigger_type text,
  p_requested_by uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  source_row public.stock_ingestion_sources%rowtype;
  run_id uuid;
  actor_id uuid;
  stale_run record;
  old_sub text := current_setting('request.jwt.claim.sub', true);
begin
  if p_trigger_type is null or p_trigger_type not in ('scheduled', 'manual') then
    raise exception 'Choose a valid ingestion trigger type';
  end if;

  select * into source_row
  from public.stock_ingestion_sources
  where id = p_source_id
  for update;
  if not found then raise exception 'Ingestion source not found'; end if;
  if not source_row.is_active then raise exception 'Ingestion source is inactive'; end if;
  if source_row.provider <> 'google_sheets' then raise exception 'Ingestion provider is not implemented'; end if;
  if p_trigger_type = 'scheduled' and not source_row.schedule_enabled then
    raise exception 'Scheduled ingestion is disabled for this source';
  end if;
  actor_id := coalesce(p_requested_by, source_row.configured_by);
  perform public.assert_active_stock_administrator(actor_id);

  for stale_run in
    select id, actor_user_id from public.stock_ingestion_runs
    where source_id=p_source_id and status='running' and started_at < now() - interval '30 minutes'
    for update
  loop
    perform set_config('request.jwt.claim.sub', stale_run.actor_user_id::text, true);
    update public.stock_import_batches
    set status='rejected', validation_errors=validation_errors || jsonb_build_array(
      jsonb_build_object('dataset','import','message','Automated ingestion exceeded the 30-minute execution window.')
    )
    where ingestion_run_id=stale_run.id and status in ('staged','validated');
    update public.stock_ingestion_runs
    set status='failed', finished_at=now(), error_message='Previous ingestion run exceeded the 30-minute execution window.',
        import_batch_id=coalesce(import_batch_id,(select id from public.stock_import_batches where ingestion_run_id=stale_run.id))
    where id=stale_run.id;
  end loop;
  perform set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true);
  if exists (select 1 from public.stock_ingestion_runs where source_id=p_source_id and status='running') then return null; end if;

  insert into public.stock_ingestion_runs (source_id, trigger_type, requested_by, actor_user_id)
  values (p_source_id, p_trigger_type, p_requested_by, actor_id)
  returning id into run_id;
  return run_id;
end;
$$;

create or replace function public.finish_stock_ingestion_run(
  p_run_id uuid,
  p_status text,
  p_import_batch_id uuid default null,
  p_source_checksum text default null,
  p_booking_row_count integer default 0,
  p_reordering_row_count integer default 0,
  p_error_message text default ''
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  run_row public.stock_ingestion_runs%rowtype;
  batch_row public.stock_import_batches%rowtype;
  source_provider public.stock_ingestion_provider;
  partial_batch_id uuid;
  old_sub text := current_setting('request.jwt.claim.sub', true);
  clean_message text;
begin
  if p_status is null or p_status not in ('validated','no_change','failed') then raise exception 'Choose a valid completed ingestion status'; end if;
  if coalesce(p_booking_row_count,0) < 0 or coalesce(p_reordering_row_count,0) < 0 then raise exception 'Ingestion row counts cannot be negative'; end if;
  select * into run_row from public.stock_ingestion_runs where id = p_run_id for update;
  if not found then raise exception 'Ingestion run not found'; end if;
  if run_row.status <> 'running' then raise exception 'Only running ingestion jobs can be finished'; end if;

  if p_status in ('validated','no_change') then
    if coalesce(p_source_checksum,'') !~ '^[0-9a-f]{64}$' then raise exception 'A completed ingestion requires a SHA-256 checksum'; end if;
    select * into batch_row from public.stock_import_batches where id=p_import_batch_id;
    if not found or batch_row.source_checksum<>p_source_checksum
       or batch_row.status not in ('validated','active','superseded') then
      raise exception 'Matching stock import batch not found';
    end if;
    if batch_row.booking_row_count<>p_booking_row_count or batch_row.reordering_row_count<>p_reordering_row_count then
      raise exception 'Stock import batch row counts do not match the completed extract';
    end if;
    if p_status='validated' and (
      batch_row.status<>'validated' or batch_row.imported_by<>run_row.actor_user_id
      or batch_row.ingestion_run_id<>p_run_id or batch_row.created_at<run_row.started_at
    ) then raise exception 'Validated ingestion batch does not match the completed extract'; end if;
    select provider into source_provider from public.stock_ingestion_sources where id=run_row.source_id;
    if source_provider='google_sheets' and batch_row.source_type<>'google_sheets' then
      raise exception 'Stock import batch does not match the ingestion provider';
    end if;
    clean_message := '';
  else
    clean_message := left(regexp_replace(coalesce(nullif(btrim(p_error_message), ''), 'Stock ingestion failed.'), '[[:cntrl:]]+', ' ', 'g'), 1000);
    clean_message := regexp_replace(
      clean_message,
      '(api[_ -]?key|token|password|secret|authorization|cookie)[[:space:]]*[:=][[:space:]]*[^[:space:],;]+',
      '\1=[redacted]', 'gi'
    );
    select id into partial_batch_id from public.stock_import_batches
    where ingestion_run_id=p_run_id and status in ('staged','validated')
    for update;
    if partial_batch_id is not null then
      perform set_config('request.jwt.claim.sub', run_row.actor_user_id::text, true);
      update public.stock_import_batches
      set status='rejected', validation_errors=validation_errors || jsonb_build_array(
        jsonb_build_object('dataset','import','message',clean_message)
      )
      where id=partial_batch_id;
      perform set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true);
    end if;
  end if;
  update public.stock_ingestion_runs
  set status=p_status, import_batch_id=case when p_status='failed' then partial_batch_id else p_import_batch_id end,
      source_checksum=case when p_status='failed' then null else p_source_checksum end,
      booking_row_count=coalesce(p_booking_row_count,0), reordering_row_count=coalesce(p_reordering_row_count,0),
      error_message=clean_message, finished_at=now()
  where id=p_run_id;
  return true;
end;
$$;

create or replace function public.service_create_stock_import_batch(
  p_actor_user_id uuid, p_run_id uuid, p_source_type text, p_source_name text, p_source_checksum text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  old_sub text := current_setting('request.jwt.claim.sub', true);
  saved_id uuid;
  run_row public.stock_ingestion_runs%rowtype;
  batch_row public.stock_import_batches%rowtype;
begin
  perform public.assert_active_stock_administrator(p_actor_user_id);
  if coalesce(btrim(p_source_checksum),'') !~ '^[0-9a-fA-F]{64}$' then
    raise exception 'Stock import checksum must be a SHA-256 value';
  end if;
  select * into run_row from public.stock_ingestion_runs where id=p_run_id for update;
  if not found or run_row.status<>'running' or run_row.actor_user_id<>p_actor_user_id then
    raise exception 'A matching running ingestion job is required';
  end if;
  select * into batch_row from public.stock_import_batches where ingestion_run_id=p_run_id;
  if found then
    if batch_row.imported_by<>p_actor_user_id or batch_row.source_type<>p_source_type
       or batch_row.source_checksum<>lower(btrim(p_source_checksum)) or batch_row.status<>'staged' then
      raise exception 'Existing ingestion batch does not match this job';
    end if;
    return batch_row.id;
  end if;
  perform set_config('request.jwt.claim.sub', p_actor_user_id::text, true);
  begin
    saved_id := public.create_stock_import_batch(p_source_type, p_source_name, p_source_checksum);
    update public.stock_import_batches set ingestion_run_id=p_run_id where id=saved_id;
  exception when others then
    perform set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true);
    raise;
  end;
  perform set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true);
  return saved_id;
end;
$$;

create or replace function public.service_validate_and_finish_stock_ingestion(
  p_actor_user_id uuid, p_run_id uuid, p_batch_id uuid, p_source_checksum text,
  p_booking_row_count integer, p_reordering_row_count integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  old_sub text := current_setting('request.jwt.claim.sub', true);
  run_row public.stock_ingestion_runs%rowtype;
  valid boolean;
begin
  perform public.assert_active_stock_administrator(p_actor_user_id);
  select * into run_row from public.stock_ingestion_runs where id=p_run_id for update;
  if not found or run_row.status<>'running' or run_row.actor_user_id<>p_actor_user_id then
    raise exception 'A matching running ingestion job is required';
  end if;
  if not exists (
    select 1 from public.stock_import_batches
    where id=p_batch_id and ingestion_run_id=p_run_id and imported_by=p_actor_user_id and status='staged'
  ) then raise exception 'A matching staged ingestion batch is required'; end if;
  perform set_config('request.jwt.claim.sub', p_actor_user_id::text, true);
  begin
    valid := public.validate_stock_import(p_batch_id);
    if not valid then raise exception 'Stock import validation failed'; end if;
    perform public.finish_stock_ingestion_run(
      p_run_id,'validated',p_batch_id,p_source_checksum,p_booking_row_count,p_reordering_row_count,''
    );
  exception when others then
    perform set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true);
    raise;
  end;
  perform set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true);
  return true;
end;
$$;

create or replace function public.service_append_stock_booking_items(
  p_actor_user_id uuid, p_batch_id uuid, p_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare old_sub text := current_setting('request.jwt.claim.sub', true); saved_count integer;
begin
  perform public.assert_active_stock_administrator(p_actor_user_id);
  perform set_config('request.jwt.claim.sub', p_actor_user_id::text, true);
  begin saved_count := public.append_stock_booking_items(p_batch_id, p_rows);
  exception when others then
    perform set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true); raise;
  end;
  perform set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true);
  return saved_count;
end;
$$;

create or replace function public.service_append_stock_reordering_items(
  p_actor_user_id uuid, p_batch_id uuid, p_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare old_sub text := current_setting('request.jwt.claim.sub', true); saved_count integer;
begin
  perform public.assert_active_stock_administrator(p_actor_user_id);
  perform set_config('request.jwt.claim.sub', p_actor_user_id::text, true);
  begin saved_count := public.append_stock_reordering_items(p_batch_id, p_rows);
  exception when others then
    perform set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true); raise;
  end;
  perform set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true);
  return saved_count;
end;
$$;

create or replace function public.service_validate_stock_import(p_actor_user_id uuid, p_batch_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare old_sub text := current_setting('request.jwt.claim.sub', true); saved_result boolean;
begin
  perform public.assert_active_stock_administrator(p_actor_user_id);
  perform set_config('request.jwt.claim.sub', p_actor_user_id::text, true);
  begin saved_result := public.validate_stock_import(p_batch_id);
  exception when others then
    perform set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true); raise;
  end;
  perform set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true);
  return saved_result;
end;
$$;

create or replace function public.service_reject_stock_import(
  p_actor_user_id uuid, p_batch_id uuid, p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare old_sub text := current_setting('request.jwt.claim.sub', true); saved_result boolean;
begin
  perform public.assert_active_stock_administrator(p_actor_user_id);
  perform set_config('request.jwt.claim.sub', p_actor_user_id::text, true);
  begin saved_result := public.reject_stock_import(p_batch_id, p_reason);
  exception when others then
    perform set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true); raise;
  end;
  perform set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true);
  return saved_result;
end;
$$;

revoke all on function public.save_stock_ingestion_source(uuid,public.stock_ingestion_provider,text,jsonb,boolean,boolean) from public, anon;
revoke all on function public.delete_stock_ingestion_source(uuid) from public, anon;
grant execute on function public.save_stock_ingestion_source(uuid,public.stock_ingestion_provider,text,jsonb,boolean,boolean) to authenticated;
grant execute on function public.delete_stock_ingestion_source(uuid) to authenticated;

revoke all on function public.assert_active_stock_administrator(uuid) from public, anon, authenticated, service_role;
revoke all on function public.claim_stock_ingestion_run(uuid,text,uuid) from public, anon, authenticated;
revoke all on function public.finish_stock_ingestion_run(uuid,text,uuid,text,integer,integer,text) from public, anon, authenticated;
revoke all on function public.service_create_stock_import_batch(uuid,uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.service_validate_and_finish_stock_ingestion(uuid,uuid,uuid,text,integer,integer) from public, anon, authenticated;
revoke all on function public.service_append_stock_booking_items(uuid,uuid,jsonb) from public, anon, authenticated;
revoke all on function public.service_append_stock_reordering_items(uuid,uuid,jsonb) from public, anon, authenticated;
revoke all on function public.service_validate_stock_import(uuid,uuid) from public, anon, authenticated;
revoke all on function public.service_reject_stock_import(uuid,uuid,text) from public, anon, authenticated;

grant execute on function public.claim_stock_ingestion_run(uuid,text,uuid) to service_role;
grant execute on function public.finish_stock_ingestion_run(uuid,text,uuid,text,integer,integer,text) to service_role;
grant execute on function public.service_create_stock_import_batch(uuid,uuid,text,text,text) to service_role;
grant execute on function public.service_validate_and_finish_stock_ingestion(uuid,uuid,uuid,text,integer,integer) to service_role;
grant execute on function public.service_append_stock_booking_items(uuid,uuid,jsonb) to service_role;
grant execute on function public.service_append_stock_reordering_items(uuid,uuid,jsonb) to service_role;
grant execute on function public.service_validate_stock_import(uuid,uuid) to service_role;
grant execute on function public.service_reject_stock_import(uuid,uuid,text) to service_role;
