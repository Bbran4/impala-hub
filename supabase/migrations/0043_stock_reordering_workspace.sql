-- Shared, read-only Stock Reordering workspace. Calculations use the active
-- snapshot and shared thresholds so every browser sees the same result.

create or replace view public.stock_reordering_workspace
with (security_invoker = true)
as
select
  item.id,
  item.import_batch_id,
  item.source_row_number,
  item.legacy_id,
  item.franchise,
  item.part_number,
  item.description,
  item.alt_1,
  item.alt_2,
  item.alt_3,
  item.alt_4,
  item.qoh_er,
  item.safety_er,
  item.qoh_pta,
  item.safety_pta,
  item.qoh_wh,
  item.safety_wh,
  item.global_safety,
  item.qty_on_order,
  item.qty_to_order,
  item.lead_time,
  item.avg_sales,
  item.sales_this_month,
  item.gauge,
  item.supplier,
  item.last_cost,
  item.supplier_type,
  batch.source_name,
  batch.activated_at as snapshot_activated_at,
  settings.slow_max_avg_sales,
  settings.ab_min_avg_sales,
  case
    when item.global_safety > 0 then
      ((item.qoh_er + item.qoh_pta + item.qoh_wh) / item.global_safety) * 100
    else 0
  end as supply_percentage,
  item.avg_sales <= settings.slow_max_avg_sales as is_slow_mover,
  item.avg_sales >= settings.ab_min_avg_sales as is_ab_mover
from public.stock_reordering_items item
join public.stock_import_batches batch
  on batch.id=item.import_batch_id and batch.status='active'
cross join public.stock_settings settings
where settings.singleton;

revoke all on public.stock_reordering_workspace from public, anon;
grant select on public.stock_reordering_workspace to authenticated;

