-- Reporting batch 3: report emails with a filter (bookmark, selections, conditions), Excel attachments,
-- alerts (send only when a measure crosses a threshold), self-subscriptions and opting out.

alter table bi.report_schedules
  drop constraint report_schedules_sheet_ids_check,
  add constraint report_schedules_sheet_ids_check check (cardinality(sheet_ids) <= 20),
  add column kind text not null default 'report' check (kind in ('report', 'alert')),
  add column bookmark_id uuid references bi.bookmarks (id) on delete set null,
  add column selections jsonb not null default '[]' check (jsonb_typeof(selections) = 'array'),
  add column conditions jsonb not null default '[]' check (jsonb_typeof(conditions) = 'array'),
  add column attach_excel boolean not null default false,
  add column alert jsonb,
  add column personal boolean not null default false,
  add column owner uuid;

alter table bi.render_tickets alter column sheet_id drop not null;
alter table bi.report_deliveries drop constraint report_deliveries_status_check,
  add constraint report_deliveries_status_check check (status in ('pending', 'sending', 'sent', 'failed', 'skipped', 'not_needed'));

-- People who asked not to get a report email any more
create table bi.report_optouts (
  schedule_id uuid not null references bi.report_schedules (id) on delete cascade,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (schedule_id, user_id)
);
alter table bi.report_optouts enable row level security;
grant all on bi.report_optouts to service_role;

-- Checks the parts of a schedule shared by builders' schedules and personal subscriptions
create function bi.check_report_extras(p jsonb, p_app uuid)
returns void language plpgsql stable security definer set search_path = ''
as $$
declare
  c jsonb;
  a jsonb := p->'alert';
begin
  perform bi.check_selection_list(coalesce(p->'selections', '[]'));
  if jsonb_typeof(coalesce(p->'conditions', '[]')) <> 'array' or jsonb_array_length(coalesce(p->'conditions', '[]')) > 10 then
    raise exception 'Too many conditions' using errcode = '22023';
  end if;
  for c in select * from jsonb_array_elements(coalesce(p->'conditions', '[]')) loop
    if coalesce(jsonb_typeof(c->'node'), '') <> 'object' or length(coalesce(c->>'text', '')) not between 1 and 2000 then
      raise exception 'Invalid condition' using errcode = '22023';
    end if;
  end loop;
  if nullif(p->>'bookmark_id', '') is not null and not exists (
      select 1 from bi.bookmarks b where b.id = (p->>'bookmark_id')::uuid and b.app_id = p_app and (b.shared or b.owner = auth.uid())) then
    raise exception 'Choose a bookmark of this app' using errcode = '22023';
  end if;
  if coalesce(p->>'kind', 'report') = 'alert' then
    if jsonb_typeof(a) <> 'object' or coalesce(jsonb_typeof(a->'measure'->'node'), '') <> 'object' or length(coalesce(a->'measure'->>'text', '')) not between 1 and 2000 then
      raise exception 'An alert needs a measure, e.g. Sum(qty_on_hand)' using errcode = '22023';
    end if;
    if coalesce(a->>'op', '') not in ('>', '>=', '<', '<=', '=', '<>') then raise exception 'Choose a comparison' using errcode = '22023'; end if;
    if jsonb_typeof(a->'value') <> 'number' then raise exception 'Enter the number to compare with' using errcode = '22023'; end if;
    if a ? 'dimension' and jsonb_typeof(a->'dimension') = 'object' and coalesce(jsonb_typeof(a->'dimension'->'node'), '') <> 'object' then
      raise exception 'Invalid alert dimension' using errcode = '22023';
    end if;
  elsif jsonb_array_length(coalesce(p->'sheet_ids', '[]')) = 0 then
    raise exception 'Choose at least one sheet' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.bi_save_report(p jsonb)
returns uuid language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_app uuid := (p->>'app_id')::uuid;
  v_sheets uuid[];
  v_days integer[];
  v_tz text := coalesce(nullif(p->>'timezone', ''), 'Africa/Johannesburg');
  v_time time;
  r jsonb;
  is_new boolean := v_id is null;
begin
  perform bi.require_builder();
  if not exists (select 1 from bi.apps a where a.id = v_app) then raise exception 'App not found' using errcode = 'P0002'; end if;
  if v_id is not null and not exists (select 1 from bi.report_schedules s where s.id = v_id and s.app_id = v_app) then
    raise exception 'Report email not found' using errcode = 'P0002';
  end if;
  if coalesce(p->>'kind', 'report') not in ('report', 'alert') then raise exception 'Invalid kind' using errcode = '22023'; end if;
  v_sheets := array(select (x #>> '{}')::uuid from jsonb_array_elements(coalesce(p->'sheet_ids', '[]')) x);
  if exists (select 1 from unnest(v_sheets) x where not exists (select 1 from bi.sheets s where s.id = x and s.app_id = v_app)) then
    raise exception 'A chosen sheet is not in this app' using errcode = '22023';
  end if;
  perform bi.check_report_extras(p, v_app);
  if jsonb_typeof(p->'recipients') <> 'array' or jsonb_array_length(p->'recipients') = 0 then
    raise exception 'Choose at least one recipient' using errcode = '22023';
  end if;
  if jsonb_array_length(p->'recipients') > 200 then raise exception 'Too many recipients' using errcode = '22023'; end if;
  for r in select * from jsonb_array_elements(p->'recipients') loop
    if (r->>'type' = 'role' and not exists (select 1 from public.roles x where x.id = r->>'principal'))
       or (r->>'type' = 'user' and not exists (select 1 from public.profiles x where x.id::text = r->>'principal'))
       or coalesce(r->>'type', '') not in ('role', 'user') then
      raise exception 'Unknown recipient' using errcode = '22023';
    end if;
  end loop;
  if coalesce(p->>'frequency', '') not in ('daily', 'weekdays', 'weekly', 'monthly') then
    raise exception 'Choose how often to send' using errcode = '22023';
  end if;
  if coalesce(p->>'send_time', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Enter a time like 07:00' using errcode = '22023'; end if;
  v_time := (p->>'send_time')::time;
  v_days := array(select (x #>> '{}')::int from jsonb_array_elements(coalesce(p->'weekdays', '[]')) x);
  if p->>'frequency' = 'weekly' and (cardinality(v_days) = 0 or not v_days <@ array[1, 2, 3, 4, 5, 6, 7]) then
    raise exception 'Choose the days of the week' using errcode = '22023';
  end if;
  if p->>'frequency' = 'monthly' and coalesce((p->>'month_day')::int, 0) not between 1 and 31 then
    raise exception 'Choose the day of the month' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_tz) then
    raise exception 'Unknown time zone %', v_tz using errcode = '22023';
  end if;

  if is_new then
    insert into bi.report_schedules (app_id, name, sheet_ids, recipients, frequency, send_time, weekdays, month_day, timezone,
      subject, message, enabled, next_run_at, kind, bookmark_id, selections, conditions, attach_excel, alert, owner, created_by, updated_by)
    values (v_app, btrim(p->>'name'), v_sheets, p->'recipients', p->>'frequency', v_time, v_days, (p->>'month_day')::int, v_tz,
      coalesce(p->>'subject', ''), coalesce(p->>'message', ''), coalesce((p->>'enabled')::boolean, true),
      bi.report_next_run(p->>'frequency', v_time, v_days, (p->>'month_day')::int, v_tz, now()),
      coalesce(p->>'kind', 'report'), nullif(p->>'bookmark_id', '')::uuid, coalesce(p->'selections', '[]'), coalesce(p->'conditions', '[]'),
      coalesce((p->>'attach_excel')::boolean, false), case when p->>'kind' = 'alert' then p->'alert' end, auth.uid(), auth.uid(), auth.uid())
    returning id into v_id;
  else
    update bi.report_schedules s set name = btrim(p->>'name'), sheet_ids = v_sheets, recipients = p->'recipients',
      frequency = p->>'frequency', send_time = v_time, weekdays = v_days, month_day = (p->>'month_day')::int, timezone = v_tz,
      subject = coalesce(p->>'subject', ''), message = coalesce(p->>'message', ''), enabled = coalesce((p->>'enabled')::boolean, true),
      next_run_at = bi.report_next_run(p->>'frequency', v_time, v_days, (p->>'month_day')::int, v_tz, now()),
      kind = coalesce(p->>'kind', 'report'), bookmark_id = nullif(p->>'bookmark_id', '')::uuid, selections = coalesce(p->'selections', '[]'),
      conditions = coalesce(p->'conditions', '[]'), attach_excel = coalesce((p->>'attach_excel')::boolean, false),
      alert = case when p->>'kind' = 'alert' then p->'alert' end, updated_by = auth.uid(), updated_at = now()
    where s.id = v_id;
  end if;
  insert into bi.audit_log (actor, actor_id, action, object_type, object_name, details)
  values (bi.app_actor(), auth.uid(), case when is_new then 'add' else 'change' end, case when p->>'kind' = 'alert' then 'alert' else 'report email' end,
          btrim(p->>'name'), jsonb_build_object('app_id', v_app, 'frequency', p->>'frequency', 'time', p->>'send_time', 'sheets', cardinality(v_sheets),
                             'recipients', p->'recipients'));
  return v_id;
end;
$$;

create or replace function public.bi_list_reports(p_app uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  perform bi.require_builder();
  return jsonb_build_object(
    'schedules', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'sheet_ids', to_jsonb(s.sheet_ids), 'recipients', s.recipients, 'frequency', s.frequency,
        'send_time', to_char(s.send_time, 'HH24:MI'), 'weekdays', to_jsonb(s.weekdays), 'month_day', s.month_day,
        'timezone', s.timezone, 'subject', s.subject, 'message', s.message, 'enabled', s.enabled,
        'next_run_at', s.next_run_at, 'last_run_at', s.last_run_at, 'kind', s.kind, 'bookmark_id', s.bookmark_id,
        'selections', s.selections, 'conditions', s.conditions, 'attach_excel', s.attach_excel, 'alert', s.alert,
        'personal', s.personal, 'owner_name', (select coalesce(nullif(p.display_name, ''), p.email) from public.profiles p where p.id = s.owner),
        'optouts', (select count(*) from bi.report_optouts o where o.schedule_id = s.id),
        'recipient_count', (select count(*) from bi.report_recipients(s.recipients) r
                            where not exists (select 1 from bi.report_optouts o where o.schedule_id = s.id and o.user_id = r.user_id)))
        order by s.personal, lower(s.name)), '[]') from bi.report_schedules s where s.app_id = p_app),
    'deliveries', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id, 'schedule_id', d.schedule_id, 'email', d.email, 'status', d.status, 'error', d.error, 'is_test', d.is_test,
        'attempts', d.attempts, 'created_at', d.created_at, 'sent_at', d.sent_at) order by d.created_at desc), '[]')
      from (select d.* from bi.report_deliveries d join bi.report_schedules s on s.id = d.schedule_id
            where s.app_id = p_app order by d.created_at desc limit 100) d));
end;
$$;

-- Builders send a schedule now; the owner of a personal subscription can send a test to themselves
create or replace function public.bi_send_report_now(p_id uuid, p_test boolean default true)
returns integer language plpgsql volatile security definer set search_path = ''
as $$
declare
  s bi.report_schedules;
  n integer;
begin
  select * into s from bi.report_schedules x where x.id = p_id;
  if s.id is null then raise exception 'Report email not found' using errcode = 'P0002'; end if;
  if not (bi.can_build() or (s.personal and s.owner = auth.uid() and p_test)) then
    raise exception 'Only administrators and report builders can send report emails' using errcode = '42501';
  end if;
  if p_test then
    insert into bi.report_deliveries (schedule_id, recipient, email, is_test)
    select s.id, p.id, p.email, true from public.profiles p where p.id = auth.uid() and coalesce(p.email, '') <> '';
  else
    insert into bi.report_deliveries (schedule_id, recipient, email)
    select s.id, r.user_id, r.email from bi.report_recipients(s.recipients) r
    where not exists (select 1 from bi.report_optouts o where o.schedule_id = s.id and o.user_id = r.user_id);
  end if;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Viewers: subscribe to a sheet or an alert themselves, see the emails they get, opt out
-- ---------------------------------------------------------------------------
-- p = {id?, app_id, kind, name, sheet_ids, frequency, send_time, weekdays, month_day, bookmark_id, selections, conditions, attach_excel, alert, enabled}
create function public.bi_subscribe(p jsonb)
returns uuid language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_app uuid := (p->>'app_id')::uuid;
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_sheets uuid[];
  v_days integer[];
  v_time time;
begin
  if not bi.can_view_app(v_app) then raise exception 'You do not have access to this app' using errcode = '42501'; end if;
  if v_id is not null and not exists (select 1 from bi.report_schedules s where s.id = v_id and s.personal and s.owner = auth.uid()) then
    raise exception 'Subscription not found' using errcode = 'P0002';
  end if;
  if (select count(*) from bi.report_schedules s where s.personal and s.owner = auth.uid()) >= 20 and v_id is null then
    raise exception 'You can have up to 20 subscriptions' using errcode = '22023';
  end if;
  if coalesce(p->>'kind', 'report') not in ('report', 'alert') then raise exception 'Invalid kind' using errcode = '22023'; end if;
  v_sheets := array(select (x #>> '{}')::uuid from jsonb_array_elements(coalesce(p->'sheet_ids', '[]')) x);
  if cardinality(v_sheets) > 10 or exists (select 1 from unnest(v_sheets) x where not exists (select 1 from bi.sheets s where s.id = x and s.app_id = v_app)) then
    raise exception 'Choose sheets of this app' using errcode = '22023';
  end if;
  perform bi.check_report_extras(p, v_app);
  if coalesce(p->>'frequency', '') not in ('daily', 'weekdays', 'weekly', 'monthly') then raise exception 'Choose how often to send' using errcode = '22023'; end if;
  if coalesce(p->>'send_time', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Enter a time like 07:00' using errcode = '22023'; end if;
  v_time := (p->>'send_time')::time;
  v_days := array(select (x #>> '{}')::int from jsonb_array_elements(coalesce(p->'weekdays', '[]')) x);
  if p->>'frequency' = 'weekly' and (cardinality(v_days) = 0 or not v_days <@ array[1, 2, 3, 4, 5, 6, 7]) then
    raise exception 'Choose the days of the week' using errcode = '22023';
  end if;
  if p->>'frequency' = 'monthly' and coalesce((p->>'month_day')::int, 0) not between 1 and 31 then raise exception 'Choose the day of the month' using errcode = '22023'; end if;
  if v_id is null then
    insert into bi.report_schedules (app_id, name, sheet_ids, recipients, frequency, send_time, weekdays, month_day, enabled, next_run_at,
      kind, bookmark_id, selections, conditions, attach_excel, alert, personal, owner, created_by, updated_by)
    values (v_app, coalesce(nullif(btrim(p->>'name'), ''), 'My subscription'), v_sheets, jsonb_build_array(jsonb_build_object('type', 'user', 'principal', auth.uid()::text)),
      p->>'frequency', v_time, v_days, (p->>'month_day')::int, coalesce((p->>'enabled')::boolean, true),
      bi.report_next_run(p->>'frequency', v_time, v_days, (p->>'month_day')::int, 'Africa/Johannesburg', now()),
      coalesce(p->>'kind', 'report'), nullif(p->>'bookmark_id', '')::uuid, coalesce(p->'selections', '[]'), coalesce(p->'conditions', '[]'),
      coalesce((p->>'attach_excel')::boolean, false), case when p->>'kind' = 'alert' then p->'alert' end, true, auth.uid(), auth.uid(), auth.uid())
    returning id into v_id;
  else
    update bi.report_schedules s set name = coalesce(nullif(btrim(p->>'name'), ''), 'My subscription'), sheet_ids = v_sheets, frequency = p->>'frequency',
      send_time = v_time, weekdays = v_days, month_day = (p->>'month_day')::int, enabled = coalesce((p->>'enabled')::boolean, true),
      next_run_at = bi.report_next_run(p->>'frequency', v_time, v_days, (p->>'month_day')::int, s.timezone, now()),
      kind = coalesce(p->>'kind', 'report'), bookmark_id = nullif(p->>'bookmark_id', '')::uuid, selections = coalesce(p->'selections', '[]'),
      conditions = coalesce(p->'conditions', '[]'), attach_excel = coalesce((p->>'attach_excel')::boolean, false),
      alert = case when p->>'kind' = 'alert' then p->'alert' end, updated_by = auth.uid(), updated_at = now()
    where s.id = v_id;
  end if;
  return v_id;
end;
$$;

create function public.bi_unsubscribe(p_id uuid)
returns void language plpgsql volatile security definer set search_path = ''
as $$
begin
  delete from bi.report_schedules s where s.id = p_id and s.personal and s.owner = auth.uid();
  if not found then raise exception 'Subscription not found' using errcode = 'P0002'; end if;
end;
$$;

-- The report emails the signed-in user gets from an app: own subscriptions, and builders' emails to them
create function public.bi_my_report_emails(p_app uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not bi.can_view_app(p_app) then raise exception 'You do not have access to this app' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'kind', s.kind, 'personal', s.personal,
      'sheet_ids', to_jsonb(s.sheet_ids), 'frequency', s.frequency, 'send_time', to_char(s.send_time, 'HH24:MI'), 'weekdays', to_jsonb(s.weekdays),
      'month_day', s.month_day, 'timezone', s.timezone, 'enabled', s.enabled, 'next_run_at', s.next_run_at, 'bookmark_id', s.bookmark_id,
      'selections', s.selections, 'conditions', s.conditions, 'attach_excel', s.attach_excel, 'alert', s.alert,
      'opted_out', exists (select 1 from bi.report_optouts o where o.schedule_id = s.id and o.user_id = auth.uid()))
      order by s.personal desc, lower(s.name))
    from bi.report_schedules s
    where s.app_id = p_app and ((s.personal and s.owner = auth.uid())
      or (not s.personal and exists (select 1 from bi.report_recipients(s.recipients) r where r.user_id = auth.uid())))), '[]');
end;
$$;

create function public.bi_set_report_optout(p_id uuid, p_optout boolean)
returns void language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not exists (select 1 from bi.report_schedules s where s.id = p_id and not s.personal
                 and exists (select 1 from bi.report_recipients(s.recipients) r where r.user_id = auth.uid())) then
    raise exception 'Report email not found' using errcode = 'P0002';
  end if;
  if p_optout then
    insert into bi.report_optouts (schedule_id, user_id) values (p_id, auth.uid()) on conflict do nothing;
  else
    delete from bi.report_optouts o where o.schedule_id = p_id and o.user_id = auth.uid();
  end if;
  insert into bi.audit_log (actor, actor_id, action, object_type, object_name)
  select bi.app_actor(), auth.uid(), case when p_optout then 'opt out' else 'opt in' end, 'report email', s.name from bi.report_schedules s where s.id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Sender
-- ---------------------------------------------------------------------------
create or replace function public.bi_report_claim(p_limit integer default 5)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  sched record;
  d record;
  sh record;
  token text;
  sheets jsonb;
  result jsonb := '[]';
begin
  for sched in select * from bi.report_schedules x where x.enabled and x.next_run_at <= now() for update skip locked loop
    insert into bi.report_deliveries (schedule_id, recipient, email, status, error)
    select sched.id, r.user_id, r.email,
           case when bi.user_can_view_app(sched.app_id, r.user_id) then 'pending' else 'skipped' end,
           case when bi.user_can_view_app(sched.app_id, r.user_id) then null else 'This person cannot open the app' end
    from bi.report_recipients(sched.recipients) r
    where not exists (select 1 from bi.report_optouts o where o.schedule_id = sched.id and o.user_id = r.user_id);
    update bi.report_schedules x set last_run_at = now(),
      next_run_at = bi.report_next_run(x.frequency, x.send_time, x.weekdays, x.month_day, x.timezone, now())
    where x.id = sched.id;
  end loop;

  update bi.report_deliveries x set status = case when x.attempts >= 3 then 'failed' else 'pending' end,
    error = case when x.attempts >= 3 then coalesce(x.error, 'Gave up after 3 attempts') else x.error end, lease_until = null
  where x.status = 'sending' and x.lease_until < now();
  delete from bi.render_tickets t where t.expires_at < now();

  for d in
    select x.id from bi.report_deliveries x where x.status = 'pending' and (x.lease_until is null or x.lease_until < now())
    order by x.is_test desc, x.created_at limit greatest(1, least(coalesce(p_limit, 5), 50)) for update skip locked
  loop
    update bi.report_deliveries x set status = 'sending', attempts = x.attempts + 1, lease_until = now() + interval '10 minutes'
    where x.id = d.id;
    select x.*, rs.app_id, rs.name as schedule_name, rs.subject, rs.message, rs.sheet_ids, rs.kind, rs.attach_excel, rs.alert, a.name as app_name,
           coalesce(nullif(p.display_name, ''), p.email) as recipient_name
      into d from bi.report_deliveries x join bi.report_schedules rs on rs.id = x.schedule_id join bi.apps a on a.id = rs.app_id
      left join public.profiles p on p.id = x.recipient where x.id = d.id;
    if not bi.user_can_view_app(d.app_id, d.recipient) then
      update bi.report_deliveries x set status = 'skipped', error = 'This person cannot open the app', lease_until = null where x.id = d.id;
      continue;
    end if;
    sheets := '[]';
    for sh in select bs.id, bs.title from unnest(d.sheet_ids) with ordinality u(id, k) join bi.sheets bs on bs.id = u.id order by u.k loop
      token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
      insert into bi.render_tickets (token_hash, delivery_id, user_id, app_id, sheet_id, expires_at)
      values (encode(sha256(convert_to(token, 'UTF8')), 'hex'), d.id, d.recipient, d.app_id, sh.id, now() + interval '15 minutes');
      sheets := sheets || jsonb_build_object('sheet_id', sh.id, 'title', sh.title, 'ticket', token);
    end loop;
    -- an alert also gets a ticket without a sheet, to check its condition as the recipient
    token := null;
    if d.kind = 'alert' then
      token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
      insert into bi.render_tickets (token_hash, delivery_id, user_id, app_id, sheet_id, expires_at)
      values (encode(sha256(convert_to(token, 'UTF8')), 'hex'), d.id, d.recipient, d.app_id, null, now() + interval '15 minutes');
    elsif jsonb_array_length(sheets) = 0 then
      update bi.report_deliveries x set status = 'failed', error = 'The chosen sheets no longer exist', lease_until = null where x.id = d.id;
      continue;
    end if;
    result := result || jsonb_build_object('delivery_id', d.id, 'email', d.email, 'recipient_name', d.recipient_name,
      'app_id', d.app_id, 'app_name', d.app_name, 'schedule_name', d.schedule_name, 'subject', d.subject, 'message', d.message,
      'is_test', d.is_test, 'attempt', d.attempts, 'sheets', sheets, 'kind', d.kind, 'attach_excel', d.attach_excel, 'alert_ticket', token);
  end loop;
  return result;
end;
$$;

-- p_status: 'sent', 'failed', 'retry', or 'not_needed' (an alert whose condition was not met)
create or replace function public.bi_report_finish(p_delivery uuid, p_status text, p_error text default null)
returns void language plpgsql volatile security definer set search_path = ''
as $$
begin
  if p_status not in ('sent', 'failed', 'retry', 'not_needed') then raise exception 'Invalid status' using errcode = '22023'; end if;
  update bi.report_deliveries x set
    status = case when p_status in ('sent', 'not_needed') then p_status when p_status = 'retry' and x.attempts < 3 then 'pending' else 'failed' end,
    error = case when p_status = 'sent' then null when p_status = 'not_needed' then coalesce(p_error, 'The alert''s condition was not met')
                 else left(coalesce(p_error, 'Sending failed'), 1000) end,
    sent_at = case when p_status = 'sent' then now() else null end,
    lease_until = case when p_status = 'retry' and x.attempts < 3 then now() + x.attempts * interval '5 minutes' end
  where x.id = p_delivery;
  delete from bi.render_tickets t where t.delivery_id = p_delivery;
end;
$$;

-- The filter of the schedule behind a ticket: bookmark selections plus the schedule's own selections,
-- the bookmark's compare states and variables, and the conditions for every chart
create function bi.ticket_filter(t bi.render_tickets)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'selections', coalesce(b.selections, '[]') || s.selections,
    'states', coalesce(b.states, '{}'),
    'variables', coalesce(b.variables, '{}'),
    'conditions', coalesce((select jsonb_agg(c->'node') from jsonb_array_elements(s.conditions) c), '[]'))
  from bi.report_deliveries d join bi.report_schedules s on s.id = d.schedule_id
  left join bi.bookmarks b on b.id = s.bookmark_id
  where d.id = t.delivery_id;
$$;

create or replace function public.bi_render_app(p_ticket text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  t bi.render_tickets := bi.use_ticket(p_ticket);
begin
  return jsonb_build_object('app', public.bi_get_app(t.app_id), 'sheet_id', t.sheet_id,
    'recipient', (select coalesce(nullif(p.display_name, ''), p.email) from public.profiles p where p.id = t.user_id),
    'row_access', bi.row_filter(t.app_id), 'filter', bi.ticket_filter(t));
end;
$$;

-- Checks an alert as its recipient: the measure (per dimension value, if any) compared with the threshold.
-- Returns the rows that meet the condition (at most 200).
create function public.bi_render_alert(p_ticket text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  t bi.render_tickets := bi.use_ticket(p_ticket);
  s bi.report_schedules;
  f jsonb := bi.ticket_filter(t);
  a jsonb;
  r jsonb;
  rows_out jsonb := '[]';
  row jsonb;
  v numeric;
  hit boolean;
  has_dim boolean;
begin
  select rs.* into s from bi.report_deliveries d join bi.report_schedules rs on rs.id = d.schedule_id where d.id = t.delivery_id;
  if s.kind <> 'alert' then raise exception 'Not an alert' using errcode = '22023'; end if;
  a := s.alert;
  has_dim := coalesce(jsonb_typeof(a->'dimension'->'node'), '') = 'object';
  r := public.bi_query(t.app_id, jsonb_build_object(
    'dimensions', case when has_dim then jsonb_build_array(jsonb_build_object('expr', a->'dimension'->'node')) else '[]'::jsonb end,
    'measures', jsonb_build_array(jsonb_build_object('expr', a->'measure'->'node')),
    'selections', (select coalesce(jsonb_agg(jsonb_build_object('expr', x->'node', 'values', x->'values')), '[]') from jsonb_array_elements(f->'selections') x),
    'conditions', f->'conditions',
    'sort', jsonb_build_array(jsonb_build_object('index', case when has_dim then 1 else 0 end, 'desc', a->>'op' in ('>', '>='))),
    'limit', 10000));
  for row in select * from jsonb_array_elements(r->'rows') loop
    begin
      v := (row->>(case when has_dim then 1 else 0 end))::numeric;
    exception when others then
      v := null;
    end;
    hit := case a->>'op' when '>' then v > (a->>'value')::numeric when '>=' then v >= (a->>'value')::numeric
      when '<' then v < (a->>'value')::numeric when '<=' then v <= (a->>'value')::numeric
      when '=' then v = (a->>'value')::numeric when '<>' then v <> (a->>'value')::numeric end;
    if coalesce(hit, false) then rows_out := rows_out || jsonb_build_array(row); end if;
    exit when jsonb_array_length(rows_out) >= 200;
  end loop;
  return jsonb_build_object('matched', jsonb_array_length(rows_out) > 0, 'rows', rows_out,
    'measure', a->'measure'->>'text', 'dimension', a->'dimension'->>'text', 'op', a->>'op', 'value', a->'value',
    'label', coalesce(nullif(a->>'label', ''), a->'measure'->>'text'), 'dimension_label', coalesce(nullif(a->>'dimension_label', ''), a->'dimension'->>'text'));
end;
$$;

revoke all on function bi.check_report_extras(jsonb, uuid), bi.ticket_filter(bi.render_tickets) from public, anon, authenticated;
revoke all on function public.bi_subscribe(jsonb), public.bi_unsubscribe(uuid), public.bi_my_report_emails(uuid), public.bi_set_report_optout(uuid, boolean),
  public.bi_render_alert(text), public.bi_save_report(jsonb), public.bi_list_reports(uuid), public.bi_send_report_now(uuid, boolean),
  public.bi_report_claim(integer), public.bi_report_finish(uuid, text, text), public.bi_render_app(text) from public, anon, authenticated;
grant execute on function public.bi_subscribe(jsonb), public.bi_unsubscribe(uuid), public.bi_my_report_emails(uuid), public.bi_set_report_optout(uuid, boolean),
  public.bi_save_report(jsonb), public.bi_list_reports(uuid), public.bi_send_report_now(uuid, boolean) to authenticated;
grant execute on function public.bi_render_app(text), public.bi_render_alert(text) to anon, authenticated, service_role;
grant execute on function public.bi_report_claim(integer), public.bi_report_finish(uuid, text, text) to service_role;
