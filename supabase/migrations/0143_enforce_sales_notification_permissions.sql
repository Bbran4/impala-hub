-- Sales notification permissions are authoritative for both new and existing
-- notifications. A deny must also remove the item from the unread badge.

create or replace function public.rfq_user_permission(p_user uuid, p_key text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select p.active and coalesce(
      (select override.enabled
       from public.application_user_permission_overrides override
       where override.profile_id = p.id
         and override.app_id = 'sales_desk'
         and override.permission_key = p_key),
      exists (
        select 1
        from public.profile_roles role_row
        where role_row.profile_id = p.id
          and role_row.role_id = 'administrator'
          and not p.normal_user_view
      ) or exists (
        select 1
        from public.application_role_permissions role_permission
        join public.profile_roles role_row on role_row.role_id = role_permission.role_id
        where role_row.profile_id = p.id
          and role_permission.app_id = 'sales_desk'
          and role_permission.permission_key = p_key
          and (role_row.role_id <> 'administrator' or not p.normal_user_view)
      ), false
    )
    from public.profiles p
    where p.id = p_user
  ), false);
$$;

create or replace function public.rfq_notification_managers(p_key text)
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select p.id
  from public.profiles p
  where p.active
    and exists (
      select 1 from public.profile_roles role_row
      where role_row.profile_id = p.id and role_row.role_id = 'sales_manager'
    )
    and public.rfq_user_permission(p.id, 'sales_desk.view')
    and public.rfq_user_permission(p.id, p_key);
$$;

-- Restrictive policies combine with the original recipient/scope policy.
-- Therefore an explicit deny hides old rows immediately without deleting the
-- audit trail or notification history.
drop policy if exists "sales notification permissions" on public.user_notifications;
create policy "sales notification permissions"
on public.user_notifications as restrictive for select to authenticated
using (
  channel <> 'sales_desk'
  or kind not in ('rfq_created', 'rfq_updated', 'rfq_converted_to_invoice', 'rfq_in_progress')
  or public.rfq_user_permission(
    user_id,
    case
      when kind = 'rfq_converted_to_invoice' then 'sales_desk.receive_invoice_notifications'
      else 'sales_desk.receive_rfq_notifications'
    end
  )
);

create or replace function public.user_notification_unread_counts()
returns table(notification_channel text, unread_count bigint)
language sql stable security invoker set search_path = public
as $$
  select n.channel, count(*)::bigint
  from public.user_notifications n
  where n.user_id = auth.uid()
    and n.read_at is null
    and (
      n.channel <> 'sales_desk'
      or n.kind not in ('rfq_created', 'rfq_updated', 'rfq_converted_to_invoice', 'rfq_in_progress')
      or public.rfq_user_permission(
        n.user_id,
        case when n.kind = 'rfq_converted_to_invoice'
             then 'sales_desk.receive_invoice_notifications'
             else 'sales_desk.receive_rfq_notifications' end
      )
    )
  group by n.channel
  union all
  select '__all__', count(*)::bigint
  from public.user_notifications n
  where n.user_id = auth.uid()
    and n.read_at is null
    and (
      n.channel <> 'sales_desk'
      or n.kind not in ('rfq_created', 'rfq_updated', 'rfq_converted_to_invoice', 'rfq_in_progress')
      or public.rfq_user_permission(
        n.user_id,
        case when n.kind = 'rfq_converted_to_invoice'
             then 'sales_desk.receive_invoice_notifications'
             else 'sales_desk.receive_rfq_notifications' end
      )
    );
$$;

revoke all on function public.rfq_user_permission(uuid, text) from public, anon, authenticated;
revoke all on function public.rfq_notification_managers(text) from public, anon, authenticated;
revoke all on function public.user_notification_unread_counts() from public, anon;
grant execute on function public.user_notification_unread_counts() to authenticated;
notify pgrst, 'reload schema';
