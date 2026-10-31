-- Earlier category backfills omitted the common Complete/Completed custom labels.
-- Repair only unclassified legacy values; retain explicitly chosen other outcomes.
update public.sales_desk_statuses set metric_category='completed',is_closed=true
where lower(btrim(name)) in ('complete','completed') and metric_category='other';
update public.sales_desk_statuses set is_closed=true where metric_category='completed' and not is_closed;

-- Completion is one workflow outcome, not two independent configuration switches.
create function public.close_completed_rfq_status() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.metric_category='completed' then new.is_closed:=true; end if;
 return new;
end$$;
create trigger close_completed_rfq_status before insert or update on public.sales_desk_statuses
for each row execute function public.close_completed_rfq_status();
revoke all on function public.close_completed_rfq_status() from public,anon,authenticated;
notify pgrst,'reload schema';
