drop policy if exists "active users manage sales desk rfqs" on public.sales_desk_rfqs;
create policy "sales desk users read permitted rfqs" on public.sales_desk_rfqs for select to authenticated
using (
  public.is_active_user() and (
    public.has_role('administrator') or public.has_role('management') or
    (public.has_role('sales') and (
      not exists (select 1 from public.profiles p where p.id = auth.uid() and nullif(p.sales_code, '') is not null) or
      sales_code_id is null or
      exists (select 1 from public.sales_desk_sales_codes sc join public.profiles p on upper(p.sales_code)=upper(sc.code) where sc.id=sales_code_id and p.id=auth.uid())
    ))
  )
);
create policy "sales desk managers create rfqs" on public.sales_desk_rfqs for insert to authenticated
with check (public.is_active_user() and (public.has_role('administrator') or (public.has_role('sales') and not exists (select 1 from public.profiles p where p.id=auth.uid() and nullif(p.sales_code, '') is not null))));
create policy "sales desk users update permitted rfqs" on public.sales_desk_rfqs for update to authenticated
using (
  public.is_active_user() and (
    public.has_role('administrator') or
    (public.has_role('sales') and (not exists (select 1 from public.profiles p where p.id=auth.uid() and nullif(p.sales_code, '') is not null) or exists (select 1 from public.sales_desk_sales_codes sc join public.profiles p on upper(p.sales_code)=upper(sc.code) where sc.id=sales_code_id and p.id=auth.uid())))
  )
)
with check (public.is_active_user());
create policy "sales desk managers archive rfqs" on public.sales_desk_rfqs for delete to authenticated
using (public.is_active_user() and (public.has_role('administrator') or (public.has_role('sales') and not exists (select 1 from public.profiles p where p.id=auth.uid() and nullif(p.sales_code, '') is not null))));
