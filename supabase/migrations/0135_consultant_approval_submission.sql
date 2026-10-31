-- Save consultant edits and request approval atomically, preserving all existing checks.
create function public.submit_sales_desk_rfq_for_approval(p_id uuid,p_values jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if p_values is null or jsonb_typeof(p_values)<>'object' then
   raise exception 'RFQ changes must be an object' using errcode='22023';
 end if;
 if p_values<>'{}'::jsonb then perform public.update_sales_desk_rfq(p_id,p_values); end if;
 return public.request_sales_desk_approval(p_id);
end$$;
revoke all on function public.submit_sales_desk_rfq_for_approval(uuid,jsonb) from public,anon;
grant execute on function public.submit_sales_desk_rfq_for_approval(uuid,jsonb) to authenticated;
notify pgrst,'reload schema';
