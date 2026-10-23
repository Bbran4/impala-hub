grant select, insert, update, delete on public.campaign_types to authenticated;
drop policy if exists "active users read campaign types" on public.campaign_types;
create policy "active users read campaign types" on public.campaign_types for select to authenticated using (public.is_active_user());
