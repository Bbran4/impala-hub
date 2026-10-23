grant select, insert, update, delete on public.sales_desk_media_platforms to authenticated;
grant select, insert, update, delete on public.sales_desk_statuses to authenticated;
grant select, insert, update, delete on public.sales_desk_sales_codes to authenticated;
drop policy if exists "active users manage media platforms" on public.sales_desk_media_platforms;
create policy "active users manage media platforms" on public.sales_desk_media_platforms for all to authenticated using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists "active users manage statuses" on public.sales_desk_statuses;
create policy "active users manage statuses" on public.sales_desk_statuses for all to authenticated using (public.is_active_user()) with check (public.is_active_user());
