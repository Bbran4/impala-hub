create or replace function public.sales_desk_code_owners()
returns table(display_name text, sales_code text)
language sql stable security definer set search_path = public
as $$
  select p.display_name, p.sales_code from public.profiles p
  where p.active = true and p.sales_code is not null and btrim(p.sales_code) <> ''
    and (public.has_role('administrator') or public.has_role('management') or p.id = auth.uid());
$$;
grant execute on function public.sales_desk_code_owners() to authenticated;
