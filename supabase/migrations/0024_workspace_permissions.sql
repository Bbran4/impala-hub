-- Central workspace permission contract for future server-side enforcement.
create or replace function public.can_access_workspace(workspace_name text)
returns boolean language sql stable security definer set search_path = public
as $$
  select public.is_active_user() and (
    public.has_role('administrator') or
    (workspace_name = 'sales_desk' and (public.has_role('sales') or public.has_role('management'))) or
    (workspace_name = 'returns_claims' and (public.has_role('returns') or public.has_role('management'))) or
    (workspace_name = 'marketing' and (public.has_role('marketing') or public.has_role('management'))) or
    (workspace_name = 'stock_control' and (public.has_role('stock') or public.has_role('management')))
  );
$$;
grant execute on function public.can_access_workspace(text) to authenticated;
