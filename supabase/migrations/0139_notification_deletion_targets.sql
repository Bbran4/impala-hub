alter table public.user_notifications add column dismissed_at timestamptz;
-- Keep the event's deduplication key so a retry cannot recreate a deleted alert.
create policy "hide dismissed notifications" on public.user_notifications as restrictive for select to authenticated
using(dismissed_at is null);
create function public.delete_user_notification(p_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if not public.is_active_user() then return false; end if;
 update public.user_notifications set dismissed_at=coalesce(dismissed_at,now()),read_at=coalesce(read_at,now())
 where id=p_id and user_id=auth.uid();
 return found;
end$$;
revoke all on function public.delete_user_notification(uuid) from public,anon;
grant execute on function public.delete_user_notification(uuid) to authenticated;

-- Resolve against live RLS before navigating, including stale browser notifications.
create function public.open_user_notification(p_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare n public.user_notifications;
begin
 select * into n from public.user_notifications where id=p_id;
 if not found then return jsonb_build_object('status','missing'); end if;
 if n.channel='sales_desk' and n.target_record_id is not null and not exists(
   select 1 from public.sales_desk_rfqs r where r.id=n.target_record_id and r.deleted_at is null
 ) then
   perform public.delete_user_notification(p_id);
   return jsonb_build_object('status','unavailable');
 end if;
 perform public.mark_user_notification_read(p_id);
 return jsonb_build_object('status','ready','notification',to_jsonb(n));
end$$;
revoke all on function public.open_user_notification(uuid) from public,anon;
grant execute on function public.open_user_notification(uuid) to authenticated;
notify pgrst,'reload schema';
