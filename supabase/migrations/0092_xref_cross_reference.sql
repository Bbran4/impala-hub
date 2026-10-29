-- =============================================================================
-- Sales Desk: Cross Reference
--
-- One table of parts for every supplier/brand, a brands table and a table of every
-- number a part is known by (our SKU, OE numbers, other brands' cross reference numbers).
-- Numbers are compared "normalised": upper case with everything except A-Z and 0-9
-- removed, so 14-451190-00, 14 451190 00 and 1445119000 are the same number.
--
-- Search (Sales Desk users): matches SKU / OE / cross reference numbers (whole or part
-- of the number) and description words, then adds every part that shares any number
-- with the parts found by number (one link step).
-- Import (administrators only): a row replaces that SKU completely; SKUs that are not
-- in the file are kept.
--
-- The xref schema is not reachable from the browser; everything goes through the
-- permission-checked functions below.
-- =============================================================================

create extension if not exists pg_trgm with schema extensions;

create schema if not exists xref;
revoke all on schema xref from public, anon, authenticated;

create or replace function xref.norm(value text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select nullif(regexp_replace(upper(coalesce(value, '')), '[^A-Z0-9]', '', 'g'), '')
$$;

create table xref.brands (
  brand_key text primary key,                      -- lower(trim(name))
  name text not null,
  description text,
  updated_at timestamptz not null default now()
);

create table xref.imports (
  id uuid primary key default gen_random_uuid(),
  file_name text,
  imported_by uuid,
  imported_by_name text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  rows_received integer not null default 0,
  parts_created integer not null default 0,
  parts_replaced integer not null default 0,
  rows_skipped integer not null default 0
);

create table xref.parts (
  sku_key text primary key,                        -- upper(trim(sku)); one row per SKU
  sku text not null,
  brand_key text references xref.brands(brand_key) on update cascade,
  title text,
  description text,
  warranty text,
  package_length_cm numeric(12,3),
  package_width_cm numeric(12,3),
  package_height_cm numeric(12,3),
  package_weight_kg numeric(12,3),
  specs jsonb not null default '[]',               -- [{"label": "Cyl. Bore", "value": "131 mm"}, …] in file order
  search_text text generated always as (lower(coalesce(title, '') || ' ' || coalesce(description, ''))) stored,
  import_id uuid references xref.imports(id) on delete set null,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint parts_specs_array check (jsonb_typeof(specs) = 'array')
);
create index parts_search_text_trgm on xref.parts using gin (search_text extensions.gin_trgm_ops);
create index parts_brand on xref.parts (brand_key);

create table xref.part_numbers (
  sku_key text not null references xref.parts(sku_key) on delete cascade,
  kind text not null check (kind in ('sku', 'oe', 'cross')),
  position integer not null,
  number_raw text not null,
  number_norm text collate "C" not null,       -- "C" so the index serves exact and starts-with lookups
  primary key (sku_key, kind, number_norm)
);
create index part_numbers_norm on xref.part_numbers (number_norm);
create index part_numbers_norm_trgm on xref.part_numbers using gin (number_norm extensions.gin_trgm_ops);

alter table xref.brands enable row level security;
alter table xref.imports enable row level security;
alter table xref.parts enable row level security;
alter table xref.part_numbers enable row level security;
revoke all on all tables in schema xref from public, anon, authenticated;
revoke all on all functions in schema xref from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Access helpers
create or replace function xref.require_sales_desk()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(public.can_access_workspace('sales_desk'), false) then
    raise exception 'You do not have access to the Sales Desk' using errcode = '42501';
  end if;
end $$;

create or replace function xref.require_admin()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.is_active_user() and public.has_role('administrator')) then
    raise exception 'Only administrators can import cross reference data' using errcode = '42501';
  end if;
end $$;
revoke all on function xref.require_sales_desk(), xref.require_admin(), xref.norm(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Search
create or replace function public.xref_search(p_query text, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  q text := left(btrim(coalesce(p_query, '')), 200);
  qn text := xref.norm(q);
  words text[];
  lim integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  cap constant integer := 1000;      -- most number / description hits read per search
  link_cap constant integer := 200;  -- link only when at most this many parts were found by number
  num_rows jsonb; num_keys text[]; desc_keys text[];
  more boolean; link_skipped boolean;
  result jsonb;
begin
  perform xref.require_sales_desk();
  if length(q) < 2 then
    return jsonb_build_object('query', q, 'more', false, 'linked_skipped', false, 'direct', '[]'::jsonb, 'linked', '[]'::jsonb, 'direct_total', 0, 'linked_total', 0);
  end if;
  -- description words; LIKE wildcards in what the user typed are taken literally
  select coalesce(array_agg('%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%'), '{}')
    into words
    from regexp_split_to_table(lower(q), '\s+') w where w <> '';

  -- Number matches: whole number, start of a number, or (3+ characters) anywhere in a number.
  -- Each kind is capped so a very short search stays quick; 'more' tells the app there were more.
  with num_hits as (
    select n.sku_key, n.kind, n.number_raw, 0 as rank from xref.part_numbers n
     where qn is not null and length(qn) >= 2 and n.number_norm = qn
    union all
    (select n.sku_key, n.kind, n.number_raw, 1 from xref.part_numbers n
      where qn is not null and length(qn) >= 2 and n.number_norm like qn || '%' and n.number_norm <> qn
      limit cap)
    union all
    (select n.sku_key, n.kind, n.number_raw, 2 from xref.part_numbers n
      where qn is not null and length(qn) >= 3 and n.number_norm like '%' || qn || '%' and n.number_norm not like qn || '%'
      limit cap)
  ), num_best as (
    select distinct on (sku_key) sku_key, kind, number_raw, rank
      from num_hits
     order by sku_key, rank, case kind when 'sku' then 0 when 'oe' then 1 else 2 end, number_raw
  )
  select coalesce(jsonb_agg(jsonb_build_object('k', sku_key, 'kind', kind, 'num', number_raw, 'rank', rank)), '[]'::jsonb),
         (select count(*) >= cap from num_hits where rank > 0 group by rank order by 1 desc limit 1)
    into num_rows, more
    from num_best;
  more := coalesce(more, false);

  select coalesce(array_agg(x->>'k'), '{}') into num_keys from jsonb_array_elements(num_rows) x;

  select coalesce(array_agg(p.sku_key), '{}') into desc_keys
    from (select p.sku_key from xref.parts p
           where cardinality(words) > 0 and p.search_text like all (words) and p.sku_key <> all (num_keys)
           limit cap) p;
  if cardinality(desc_keys) >= cap then more := true; end if;

  -- One link step from the parts found by number. Skipped when the search is too broad to be useful.
  link_skipped := cardinality(num_keys) > link_cap;

  with direct as (
    select x->>'k' as sku_key, x->>'kind' as matched_kind, x->>'num' as matched_number, (x->>'rank')::int as rank
      from jsonb_array_elements(num_rows) x
    union all
    select k, 'description', null, 3 from unnest(desc_keys) k
  ), direct_page as (
    select * from direct order by rank, sku_key limit lim
  ), linked as (
    select n2.sku_key,
           array_agg(distinct n1.number_raw order by n1.number_raw) as via,
           count(distinct n1.number_norm) as shared
      from xref.part_numbers n1
      join xref.part_numbers n2 on n2.number_norm = n1.number_norm
     where not link_skipped
       and n1.sku_key = any (num_keys)
       and n2.sku_key <> all (num_keys) and n2.sku_key <> all (desc_keys)
     group by n2.sku_key
  ), linked_page as (
    select * from linked order by shared desc, sku_key limit lim
  )
  select jsonb_build_object(
    'query', q,
    'more', more,
    'linked_skipped', link_skipped,
    'direct_total', (select count(*) from direct),
    'linked_total', (select count(*) from linked),
    'direct', coalesce((
      select jsonb_agg(jsonb_build_object(
               'sku', p.sku, 'brand', b.name, 'title', p.title, 'description', p.description,
               'match', case d.rank when 0 then 'exact' when 1 then 'starts' when 2 then 'contains' else 'description' end,
               'matched_kind', d.matched_kind, 'matched_number', d.matched_number)
             order by d.rank, p.sku_key)
        from direct_page d join xref.parts p on p.sku_key = d.sku_key
        left join xref.brands b on b.brand_key = p.brand_key), '[]'::jsonb),
    'linked', coalesce((
      select jsonb_agg(jsonb_build_object(
               'sku', p.sku, 'brand', b.name, 'title', p.title, 'description', p.description,
               'via', to_jsonb(l.via[1:3]), 'via_count', cardinality(l.via))
             order by l.shared desc, p.sku_key)
        from linked_page l join xref.parts p on p.sku_key = l.sku_key
        left join xref.brands b on b.brand_key = p.brand_key), '[]'::jsonb)
  ) into result;
  return result;
end $$;

-- -----------------------------------------------------------------------------
-- One part with everything on its import line
create or replace function public.xref_get_part(p_sku text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  perform xref.require_sales_desk();
  select jsonb_build_object(
    'sku', p.sku, 'brand', b.name, 'brand_description', b.description,
    'title', p.title, 'description', p.description, 'warranty', p.warranty,
    'oe_numbers', coalesce((select jsonb_agg(n.number_raw order by n.position) from xref.part_numbers n where n.sku_key = p.sku_key and n.kind = 'oe'), '[]'::jsonb),
    'cross_numbers', coalesce((select jsonb_agg(n.number_raw order by n.position) from xref.part_numbers n where n.sku_key = p.sku_key and n.kind = 'cross'), '[]'::jsonb),
    'package_length_cm', p.package_length_cm, 'package_width_cm', p.package_width_cm,
    'package_height_cm', p.package_height_cm, 'package_weight_kg', p.package_weight_kg,
    'specs', p.specs, 'updated_at', p.updated_at,
    'updated_by', (select pr.display_name from public.profiles pr where pr.id = p.updated_by))
    into result
    from xref.parts p left join xref.brands b on b.brand_key = p.brand_key
   where p.sku_key = upper(btrim(coalesce(p_sku, '')));
  return result;  -- null when the SKU doesn't exist
end $$;

-- -----------------------------------------------------------------------------
-- Totals for the tab header, and recent imports for administrators
create or replace function public.xref_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare is_admin boolean := public.has_role('administrator');
begin
  perform xref.require_sales_desk();
  return jsonb_build_object(
    'parts', (select count(*) from xref.parts),
    'brands', (select count(*) from xref.brands b where exists (select 1 from xref.parts p where p.brand_key = b.brand_key)),
    'numbers', (select count(*) from xref.part_numbers where kind <> 'sku'),
    'can_import', is_admin,
    'imports', case when is_admin then coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'file_name', i.file_name, 'by', i.imported_by_name,
               'at', coalesce(i.finished_at, i.started_at), 'finished', i.finished_at is not null,
               'rows', i.rows_received, 'created', i.parts_created, 'replaced', i.parts_replaced, 'skipped', i.rows_skipped)
             order by i.started_at desc)
        from (select * from xref.imports order by started_at desc limit 10) i), '[]'::jsonb) else '[]'::jsonb end);
end $$;

-- -----------------------------------------------------------------------------
-- Import (administrators). The browser reads the file and sends it in chunks:
--   1st call  p_import_id = null  -> creates the import, returns its id
--   next calls pass that id; the last call passes p_finished = true.
-- Each row: {row, sku, brand, brand_description, title, description, warranty,
--            oe_numbers[], cross_numbers[], package_length_cm, package_width_cm,
--            package_height_cm, package_weight_kg, specs[{label,value}]}
create or replace function xref.to_measure(value jsonb)
returns numeric language plpgsql immutable set search_path = '' as $$
declare t text; n numeric;
begin
  if value is null or jsonb_typeof(value) = 'null' then return null; end if;
  t := replace(btrim(value #>> '{}'), ',', '.');
  if t = '' then return null; end if;
  n := t::numeric;
  if n < 0 or n >= 1000000000 then raise exception 'out of range'; end if;
  return round(n, 3);
end $$;
revoke all on function xref.to_measure(jsonb) from public, anon, authenticated;

create or replace function public.xref_import(p_rows jsonb, p_file_name text default null,
                                              p_import_id uuid default null, p_finished boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  imp uuid := p_import_id;
  r jsonb;
  rown integer;
  v_sku text; v_key text; v_brand text; v_brand_key text; v_brand_desc text;
  v_len numeric; v_wid numeric; v_hgt numeric; v_wgt numeric;
  v_specs jsonb;
  inserted boolean;
  created integer := 0; replaced integer := 0;
  skipped jsonb := '[]'::jsonb;
  me_name text;
begin
  perform xref.require_admin();
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Rows must be a list' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    raise exception 'Send at most 1000 rows per call' using errcode = '22023';
  end if;

  if imp is null then
    select display_name into me_name from public.profiles where id = auth.uid();
    insert into xref.imports(file_name, imported_by, imported_by_name)
    values (left(nullif(btrim(coalesce(p_file_name, '')), ''), 255), auth.uid(), me_name)
    returning id into imp;
  elsif not exists (select 1 from xref.imports where id = imp and finished_at is null and imported_by = auth.uid()) then
    raise exception 'That import is not open' using errcode = '22023';
  end if;

  for r, rown in select e, coalesce((e ->> 'row')::integer, o::integer) from jsonb_array_elements(p_rows) with ordinality x(e, o) loop
    begin
      if jsonb_typeof(r) <> 'object' then raise exception 'not a row'; end if;
      v_sku := btrim(coalesce(r ->> 'sku', ''));
      if v_sku = '' then
        skipped := skipped || jsonb_build_object('row', rown, 'reason', 'No part number / SKU'); continue;
      end if;
      if length(v_sku) > 100 then
        skipped := skipped || jsonb_build_object('row', rown, 'sku', left(v_sku, 100), 'reason', 'Part number longer than 100 characters'); continue;
      end if;
      v_key := upper(v_sku);

      begin
        v_len := xref.to_measure(r -> 'package_length_cm');
        v_wid := xref.to_measure(r -> 'package_width_cm');
        v_hgt := xref.to_measure(r -> 'package_height_cm');
        v_wgt := xref.to_measure(r -> 'package_weight_kg');
      exception when others then
        skipped := skipped || jsonb_build_object('row', rown, 'sku', v_sku, 'reason', 'A package size or weight is not a number'); continue;
      end;

      select coalesce(jsonb_agg(jsonb_build_object('label', left(btrim(coalesce(s ->> 'label', '')), 200),
                                                   'value', left(btrim(coalesce(s ->> 'value', '')), 1000)) order by o), '[]'::jsonb)
        into v_specs
        from jsonb_array_elements(case when jsonb_typeof(r -> 'specs') = 'array' then r -> 'specs' else '[]'::jsonb end) with ordinality x(s, o)
       where jsonb_typeof(s) = 'object' and (btrim(coalesce(s ->> 'label', '')) <> '' or btrim(coalesce(s ->> 'value', '')) <> '');

      v_brand := nullif(left(btrim(coalesce(r ->> 'brand', '')), 200), '');
      v_brand_key := lower(v_brand);
      v_brand_desc := nullif(left(btrim(coalesce(r ->> 'brand_description', '')), 5000), '');
      if v_brand_key is not null then
        insert into xref.brands as b (brand_key, name, description) values (v_brand_key, v_brand, v_brand_desc)
        on conflict (brand_key) do update
          set name = excluded.name,
              description = coalesce(excluded.description, b.description),
              updated_at = now();
      end if;

      insert into xref.parts as p (sku_key, sku, brand_key, title, description, warranty,
                                   package_length_cm, package_width_cm, package_height_cm, package_weight_kg,
                                   specs, import_id, updated_by)
      values (v_key, v_sku, v_brand_key,
              nullif(left(btrim(coalesce(r ->> 'title', '')), 500), ''),
              nullif(left(btrim(coalesce(r ->> 'description', '')), 5000), ''),
              nullif(left(btrim(coalesce(r ->> 'warranty', '')), 200), ''),
              v_len, v_wid, v_hgt, v_wgt, v_specs, imp, auth.uid())
      on conflict (sku_key) do update set
        sku = excluded.sku, brand_key = excluded.brand_key, title = excluded.title,
        description = excluded.description, warranty = excluded.warranty,
        package_length_cm = excluded.package_length_cm, package_width_cm = excluded.package_width_cm,
        package_height_cm = excluded.package_height_cm, package_weight_kg = excluded.package_weight_kg,
        specs = excluded.specs, import_id = excluded.import_id, updated_by = excluded.updated_by, updated_at = now()
      returning (xmax = 0) into inserted;

      delete from xref.part_numbers where sku_key = v_key;
      insert into xref.part_numbers (sku_key, kind, position, number_raw, number_norm)
      select distinct on (kind, number_norm) v_key, kind, position, number_raw, number_norm
        from (
          select 'sku'::text as kind, 0::bigint as position, v_sku as number_raw, xref.norm(v_sku) as number_norm
          union all
          select k.kind, x.o, left(btrim(x.v), 100), xref.norm(left(btrim(x.v), 100))
            from (values ('oe', 'oe_numbers'), ('cross', 'cross_numbers')) k(kind, field)
            cross join lateral jsonb_array_elements_text(
              case when jsonb_typeof(r -> k.field) = 'array' then r -> k.field else '[]'::jsonb end) with ordinality x(v, o)
           where x.o <= 500
        ) nums
       where number_norm is not null
       order by kind, number_norm, position;

      if inserted then created := created + 1; else replaced := replaced + 1; end if;
    exception when others then
      skipped := skipped || jsonb_build_object('row', rown, 'sku', v_sku, 'reason', 'Could not be imported: ' || left(sqlerrm, 200));
    end;
  end loop;

  update xref.imports set
    rows_received = rows_received + jsonb_array_length(p_rows),
    parts_created = parts_created + created,
    parts_replaced = parts_replaced + replaced,
    rows_skipped = rows_skipped + jsonb_array_length(skipped),
    finished_at = case when p_finished then now() else null end
  where id = imp;

  return jsonb_build_object('import_id', imp, 'created', created, 'replaced', replaced, 'skipped', skipped);
end $$;

revoke all on function public.xref_search(text, integer), public.xref_get_part(text), public.xref_summary(),
                       public.xref_import(jsonb, text, uuid, boolean) from public, anon;
grant execute on function public.xref_search(text, integer), public.xref_get_part(text), public.xref_summary(),
                          public.xref_import(jsonb, text, uuid, boolean) to authenticated;
