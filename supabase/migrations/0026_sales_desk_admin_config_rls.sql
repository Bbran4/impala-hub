drop policy if exists "active users manage media platforms" on public.sales_desk_media_platforms;
create policy "administrators manage media platforms" on public.sales_desk_media_platforms for all to authenticated
using (public.is_active_user() and public.has_role('administrator'))
with check (public.is_active_user() and public.has_role('administrator'));
drop policy if exists "active users manage statuses" on public.sales_desk_statuses;
create policy "administrators manage statuses" on public.sales_desk_statuses for all to authenticated
using (public.is_active_user() and public.has_role('administrator'))
with check (public.is_active_user() and public.has_role('administrator'));
