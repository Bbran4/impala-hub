drop policy if exists "active users write sales desk audit" on public.sales_desk_rfq_audit;
create policy "active users write sales desk audit" on public.sales_desk_rfq_audit
for insert to authenticated
with check (public.is_active_user() and actor_user_id = auth.uid());
