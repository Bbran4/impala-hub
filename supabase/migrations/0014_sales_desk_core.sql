-- Sales Desk RFQ foundation. Supabase Auth owns identity; these tables own RFQs.
create table if not exists public.sales_desk_media_platforms (
  id uuid primary key default gen_random_uuid(), name text not null unique,
  sort_order integer not null default 0, is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.sales_desk_statuses (
  id uuid primary key default gen_random_uuid(), name text not null unique,
  sort_order integer not null default 0, is_active boolean not null default true,
  is_closed boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.sales_desk_sales_codes (
  id uuid primary key default gen_random_uuid(), code text not null unique, display_name text not null default '',
  is_active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.sales_desk_rfqs (
  id uuid primary key default gen_random_uuid(), rfq_no text not null unique, business_date date not null,
  daily_number integer not null, rfq_type text not null default 'quotation' check (rfq_type in ('quotation','invoice')),
  original_rfq_no text, converted_at timestamptz,
  media_platform_id uuid not null references public.sales_desk_media_platforms(id),
  customer_name text not null, contact_number text not null default '', email_address text not null default '',
  query_information text not null default '', sales_code_id uuid references public.sales_desk_sales_codes(id),
  claimed_at timestamptz, received_at timestamptz not null default now(), remarks text not null default '',
  status_id uuid not null references public.sales_desk_statuses(id), document_number text not null default '',
  created_by uuid not null references auth.users(id), updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (business_date, daily_number)
);
create index if not exists sales_desk_rfqs_received_idx on public.sales_desk_rfqs(received_at desc);
create table if not exists public.sales_desk_rfq_audit (
  id bigint generated always as identity primary key, rfq_id uuid not null references public.sales_desk_rfqs(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id), action text not null, changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists public.sales_desk_rfq_attachments (
  id uuid primary key default gen_random_uuid(), rfq_id uuid not null references public.sales_desk_rfqs(id) on delete restrict,
  original_name text not null, storage_path text not null unique, content_type text not null, size integer not null,
  uploaded_by uuid not null references auth.users(id), created_at timestamptz not null default now()
);
create table if not exists public.sales_desk_notifications (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  rfq_id uuid not null references public.sales_desk_rfqs(id) on delete restrict, kind text not null, message text not null,
  is_read boolean not null default false, created_at timestamptz not null default now()
);

insert into public.sales_desk_statuses (name, sort_order, is_closed) values
 ('Unclaimed',0,false),('New',1,false),('In Progress',2,false),('Awaiting Customer',3,false),
 ('Quotation Issued',4,false),('Converted to Sale',5,true),('Lost',6,true),('Closed',7,true)
on conflict (name) do nothing;
insert into public.sales_desk_media_platforms (name, sort_order) values
 ('Facebook',0),('WhatsApp',1),('Email',2),('Telephone',3),('Walk-in',4)
on conflict (name) do nothing;

create or replace function public.next_sales_desk_rfq_number()
returns table(rfq_no text, business_date date, daily_number integer)
language plpgsql security definer set search_path = public
as $$
declare d date := (now() at time zone 'Africa/Johannesburg')::date; n integer;
begin
  select coalesce(max(s.daily_number),0)+1 into n from public.sales_desk_rfqs s where s.business_date=d;
  return query select 'IMP' || to_char(d,'YYMMDD') || lpad(n::text,2,'0'), d, n;
end; $$;

alter table public.sales_desk_media_platforms enable row level security;
alter table public.sales_desk_statuses enable row level security;
alter table public.sales_desk_sales_codes enable row level security;
alter table public.sales_desk_rfqs enable row level security;
alter table public.sales_desk_rfq_audit enable row level security;
alter table public.sales_desk_rfq_attachments enable row level security;
alter table public.sales_desk_notifications enable row level security;
create policy "active users read sales desk config" on public.sales_desk_media_platforms for select to authenticated using (public.is_active_user());
create policy "active users read sales desk statuses" on public.sales_desk_statuses for select to authenticated using (public.is_active_user());
create policy "active users read sales desk codes" on public.sales_desk_sales_codes for select to authenticated using (public.is_active_user());
create policy "active users manage sales desk rfqs" on public.sales_desk_rfqs for all to authenticated using (public.is_active_user()) with check (public.is_active_user());
create policy "active users read sales desk audit" on public.sales_desk_rfq_audit for select to authenticated using (public.is_active_user());
create policy "active users manage sales desk attachments" on public.sales_desk_rfq_attachments for all to authenticated using (public.is_active_user()) with check (public.is_active_user());
create policy "users read own sales desk notifications" on public.sales_desk_notifications for select to authenticated using (user_id=auth.uid() or public.has_role('administrator') or public.has_role('management'));
grant select on public.sales_desk_media_platforms, public.sales_desk_statuses, public.sales_desk_sales_codes to authenticated;
grant select, insert, update on public.sales_desk_rfqs to authenticated;
grant select on public.sales_desk_rfq_audit, public.sales_desk_rfq_attachments, public.sales_desk_notifications to authenticated;
grant execute on function public.next_sales_desk_rfq_number() to authenticated;
