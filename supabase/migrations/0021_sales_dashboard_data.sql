create table if not exists public.sales_desk_daily_sales (
  id uuid primary key default gen_random_uuid(), business_date date not null default ((now() at time zone 'Africa/Johannesburg')::date),
  sales_person text not null, total_sales numeric(14,2) not null default 0, total_credits numeric(14,2) not null default 0,
  gross_sales numeric(14,2) not null default 0, gp_percent numeric(7,2) not null default 0,
  is_temporary boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (business_date, sales_person)
);
create table if not exists public.sales_desk_rfq_performance (
  id uuid primary key default gen_random_uuid(), business_date date not null default ((now() at time zone 'Africa/Johannesburg')::date),
  sales_person text not null, in_progress integer not null default 0, complete integer not null default 0, dropped integer not null default 0,
  scrapped integer not null default 0, irrelevant integer not null default 0, total integer not null default 0,
  bonus_points numeric(10,2), response_time text, score numeric(10,2), is_temporary boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (business_date, sales_person)
);
insert into public.sales_desk_daily_sales (sales_person,total_sales,total_credits,gross_sales,gp_percent) values
 ('Fredrik',56186.21,0,56186.21,9.09),('Charles',24722.13,0,24722.13,23.83),('Jan',14250,-6490,7760,50.66),
 ('Ian',7200,0,7200,24.58),('Miguel',825,0,825,30.67),('Brenton',0,0,0,0)
on conflict (business_date,sales_person) do update set total_sales=excluded.total_sales,total_credits=excluded.total_credits,gross_sales=excluded.gross_sales,gp_percent=excluded.gp_percent;
insert into public.sales_desk_rfq_performance (sales_person) values
 ('Fredrik'),('Charles'),('Jan'),('Ian'),('Miguel'),('Brenton')
on conflict (business_date,sales_person) do nothing;
alter table public.sales_desk_daily_sales enable row level security;
alter table public.sales_desk_rfq_performance enable row level security;
create policy "active users read daily sales" on public.sales_desk_daily_sales for select to authenticated using (public.is_active_user());
create policy "active users read rfq performance" on public.sales_desk_rfq_performance for select to authenticated using (public.is_active_user());
grant select on public.sales_desk_daily_sales, public.sales_desk_rfq_performance to authenticated;
