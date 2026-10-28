-- Platform-wide, recipient-only notifications.
-- App triggers own notification creation; browser users can only read their own
-- notifications and mark them read through the narrow RPCs below.

create table if not exists public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('marketing', 'sales_desk', 'returns_claims', 'stock_control', 'system')),
  kind text not null,
  title text not null check (char_length(btrim(title)) between 1 and 180),
  description text not null default '',
  target_page text,
  target_record_id uuid,
  actor_user_id uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  dedupe_key text unique,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists user_notifications_recipient_created_idx
  on public.user_notifications (user_id, created_at desc);
create index if not exists user_notifications_recipient_unread_idx
  on public.user_notifications (user_id, channel, created_at desc)
  where read_at is null;

alter table public.user_notifications enable row level security;

alter table public.sales_desk_statuses add column if not exists semantic_key text;
update public.sales_desk_statuses
set semantic_key = 'in_progress'
where id = (
  select id from public.sales_desk_statuses
  where lower(name) = 'in progress'
  order by case when name = 'In Progress' then 0 else 1 end, created_at, id
  limit 1
) and semantic_key is null;
create unique index if not exists sales_desk_statuses_semantic_key_unique
  on public.sales_desk_statuses (semantic_key) where semantic_key is not null;

-- Manager authority must not be inferred from a blank, user-editable sales code.
insert into public.roles (id, label, description)
values ('sales_manager', 'Sales Manager', 'Manage Sales Desk assignment and RFQ workflows')
on conflict (id) do nothing;

insert into public.profile_roles (profile_id, role_id)
select pr.profile_id, 'sales_manager'
from public.profile_roles pr
join public.profiles p on p.id = pr.profile_id
where pr.role_id = 'sales'
  and nullif(btrim(p.sales_code), '') is null
  and not exists (
    select 1 from public.profile_roles existing
    where existing.profile_id = pr.profile_id and existing.role_id = 'sales_manager'
  );

create or replace function public.can_access_workspace(workspace_name text)
returns boolean language sql stable security definer set search_path = public
as $$
  select public.is_active_user() and (
    public.has_role('administrator') or
    (workspace_name = 'sales_desk' and (public.has_role('sales') or public.has_role('sales_manager') or public.has_role('management'))) or
    (workspace_name = 'returns_claims' and (public.has_role('returns') or public.has_role('management'))) or
    (workspace_name = 'marketing' and (public.has_role('marketing') or public.has_role('management'))) or
    (workspace_name = 'stock_control' and (public.has_role('stock') or public.has_role('management')))
  );
$$;

drop policy if exists "sales desk users read permitted rfqs" on public.sales_desk_rfqs;
create policy "sales desk users read permitted rfqs" on public.sales_desk_rfqs for select to authenticated
using (
  public.is_active_user() and (
    public.has_role('administrator') or public.has_role('management') or public.has_role('sales_manager') or
    (public.has_role('sales') and (
      sales_code_id is null or
      exists (
        select 1 from public.sales_desk_sales_codes sc
        join public.profiles p on upper(p.sales_code) = upper(sc.code)
        where sc.id = sales_code_id and p.id = auth.uid()
      )
    ))
  )
);

drop policy if exists "sales desk managers create rfqs" on public.sales_desk_rfqs;
create policy "sales desk managers create rfqs" on public.sales_desk_rfqs for insert to authenticated
with check (public.is_active_user() and public.has_role('administrator'));

-- Preserve browser-based claiming while preventing an assigned salesperson from
-- changing the resulting owner through a direct Supabase update.
drop policy if exists "sales desk users update permitted rfqs" on public.sales_desk_rfqs;
create policy "sales desk users update permitted rfqs" on public.sales_desk_rfqs for update to authenticated
using (
  public.is_active_user() and (
    public.has_role('administrator') or public.has_role('sales_manager') or
    (public.has_role('sales') and (
      exists (
        select 1 from public.sales_desk_sales_codes sc
        join public.profiles p on upper(p.sales_code) = upper(sc.code)
        where sc.id = sales_code_id and p.id = auth.uid()
      ) or sales_code_id is null
    ))
  )
)
with check (
  public.is_active_user() and (
    public.has_role('administrator') or public.has_role('sales_manager') or
    (public.has_role('sales') and (
      exists (
        select 1 from public.sales_desk_sales_codes sc
        join public.profiles p on upper(p.sales_code) = upper(sc.code)
        where sc.id = sales_code_id and p.id = auth.uid()
      )
    ))
  )
);

drop policy if exists "sales desk managers archive rfqs" on public.sales_desk_rfqs;
create policy "sales desk managers archive rfqs" on public.sales_desk_rfqs for delete to authenticated
using (public.is_active_user() and (public.has_role('administrator') or public.has_role('sales_manager')));

drop policy if exists "users read their own notifications" on public.user_notifications;
create policy "users read their own notifications"
on public.user_notifications for select to authenticated
using (
  user_id = auth.uid()
  and public.is_active_user()
  and (channel = 'system' or public.can_access_workspace(channel))
  and (
    channel <> 'sales_desk'
    or kind <> 'rfq_in_progress'
    or exists (
      select 1
      from public.sales_desk_rfqs r
      join public.sales_desk_sales_codes sc on sc.id = r.sales_code_id
      join public.profiles p on p.id = auth.uid() and upper(p.sales_code) = upper(sc.code)
      where r.id = target_record_id and r.deleted_at is null
    )
  )
);

revoke all on public.user_notifications from anon, authenticated;
grant select on public.user_notifications to authenticated;

create or replace function public.mark_user_notification_read(notification_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_active_user() then
    return false;
  end if;

  update public.user_notifications
  set read_at = coalesce(read_at, now())
  where id = notification_id
    and user_id = auth.uid()
    and (channel = 'system' or public.can_access_workspace(channel))
    and (
      channel <> 'sales_desk'
      or kind <> 'rfq_in_progress'
      or exists (
        select 1
        from public.sales_desk_rfqs r
        join public.sales_desk_sales_codes sc on sc.id = r.sales_code_id
        join public.profiles p on p.id = auth.uid() and upper(p.sales_code) = upper(sc.code)
        where r.id = target_record_id and r.deleted_at is null
      )
    );
  return found;
end;
$$;

create or replace function public.mark_all_user_notifications_read(notification_channel text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare changed integer;
begin
  if auth.uid() is null or not public.is_active_user() then
    return 0;
  end if;

  if notification_channel is not null and notification_channel not in ('marketing', 'sales_desk', 'returns_claims', 'stock_control', 'system') then
    raise exception 'Unknown notification channel';
  end if;

  update public.user_notifications
  set read_at = now()
  where user_id = auth.uid()
    and read_at is null
    and (notification_channel is null or channel = notification_channel)
    and (channel = 'system' or public.can_access_workspace(channel))
    and (
      channel <> 'sales_desk'
      or kind <> 'rfq_in_progress'
      or exists (
        select 1
        from public.sales_desk_rfqs r
        join public.sales_desk_sales_codes sc on sc.id = r.sales_code_id
        join public.profiles p on p.id = auth.uid() and upper(p.sales_code) = upper(sc.code)
        where r.id = target_record_id and r.deleted_at is null
      )
    );
  get diagnostics changed = row_count;
  return changed;
end;
$$;

revoke all on function public.mark_user_notification_read(uuid) from public, anon;
revoke all on function public.mark_all_user_notifications_read(text) from public, anon;
grant execute on function public.mark_user_notification_read(uuid) to authenticated;
grant execute on function public.mark_all_user_notifications_read(text) to authenticated;

create or replace function public.user_notification_unread_counts()
returns table(notification_channel text, unread_count bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select n.channel, count(*)::bigint
  from public.user_notifications n
  where n.read_at is null
  group by n.channel
  union all
  select '__all__', count(*)::bigint
  from public.user_notifications n
  where n.read_at is null;
$$;

revoke all on function public.user_notification_unread_counts() from public, anon;
grant execute on function public.user_notification_unread_counts() to authenticated;

create or replace function public.notify_sales_desk_rfq_in_progress()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  status_name text;
  recipient record;
  notification_description text;
begin
  if new.deleted_at is not null or new.sales_code_id is null then
    return new;
  end if;

  select coalesce(s.semantic_key, lower(replace(s.name, ' ', '_'))) into status_name
  from public.sales_desk_statuses s
  where s.id = new.status_id;

  if coalesce(status_name, '') <> 'in_progress' then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.status_id is not distinct from new.status_id
     and old.sales_code_id is not distinct from new.sales_code_id then
    return new;
  end if;

  notification_description := concat_ws(
    ' · ',
    nullif(btrim(new.customer_name), ''),
    nullif(left(btrim(new.query_information), 260), '')
  );

  for recipient in
    select p.id
    from public.profiles p
    join public.sales_desk_sales_codes sc on upper(sc.code) = upper(p.sales_code)
    join public.profile_roles pr on pr.profile_id = p.id and pr.role_id = 'sales'
    where sc.id = new.sales_code_id and p.active = true
  loop
    insert into public.user_notifications (
      user_id, channel, kind, title, description, target_page,
      target_record_id, actor_user_id, metadata, dedupe_key
    ) values (
      recipient.id,
      'sales_desk',
      'rfq_in_progress',
      'RFQ in progress: ' || new.rfq_no,
      notification_description,
      'RFQs',
      new.id,
      new.updated_by,
      jsonb_build_object('rfq_no', new.rfq_no, 'customer_name', new.customer_name),
      'sales_desk:rfq_in_progress:' || new.id::text || ':' || recipient.id::text
    )
    on conflict (dedupe_key) do update
      set title = excluded.title,
          description = excluded.description,
          actor_user_id = excluded.actor_user_id,
          metadata = excluded.metadata,
          read_at = null,
          created_at = now();
  end loop;

  return new;
end;
$$;

drop trigger if exists sales_desk_rfq_in_progress_notification on public.sales_desk_rfqs;
create trigger sales_desk_rfq_in_progress_notification
after insert or update of status_id, sales_code_id on public.sales_desk_rfqs
for each row execute function public.notify_sales_desk_rfq_in_progress();

-- Surface already-assigned, active work when this feature is first deployed.
insert into public.user_notifications (
  user_id, channel, kind, title, description, target_page,
  target_record_id, actor_user_id, metadata, dedupe_key
)
select
  p.id,
  'sales_desk',
  'rfq_in_progress',
  'RFQ in progress: ' || r.rfq_no,
  concat_ws(' · ', nullif(btrim(r.customer_name), ''), nullif(left(btrim(r.query_information), 260), '')),
  'RFQs',
  r.id,
  r.updated_by,
  jsonb_build_object('rfq_no', r.rfq_no, 'customer_name', r.customer_name),
  'sales_desk:rfq_in_progress:' || r.id::text || ':' || p.id::text
from public.sales_desk_rfqs r
join public.sales_desk_statuses s on s.id = r.status_id and coalesce(s.semantic_key, lower(replace(s.name, ' ', '_'))) = 'in_progress'
join public.sales_desk_sales_codes sc on sc.id = r.sales_code_id
join public.profiles p on upper(p.sales_code) = upper(sc.code) and p.active = true
join public.profile_roles pr on pr.profile_id = p.id and pr.role_id = 'sales'
where r.deleted_at is null
on conflict (dedupe_key) do nothing;
