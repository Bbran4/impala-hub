-- Keep contains-search responsive as the Stock Max Level table grows.
create extension if not exists pg_trgm;
create index if not exists stock_max_levels_part_no_trgm_idx
  on public.stock_max_levels using gin (lower(part_no) extensions.gin_trgm_ops);
analyze public.stock_max_levels;
