-- Idempotent repair for projects where the RFQ tables were created before seed data ran.
insert into public.sales_desk_statuses (name, sort_order, is_active, is_closed) values
 ('Unclaimed',0,true,false),('New',1,true,false),('In Progress',2,true,false),('Awaiting Customer',3,true,false),
 ('Quotation Issued',4,true,false),('Converted to Sale',5,true,true),('Lost',6,true,true),('Closed',7,true,true)
on conflict (name) do update set is_active = true;
insert into public.sales_desk_media_platforms (name, sort_order, is_active) values
 ('Facebook',0,true),('WhatsApp',1,true),('Email',2,true),('Telephone',3,true),('Walk-in',4,true)
on conflict (name) do update set is_active = true;
grant select on public.sales_desk_media_platforms, public.sales_desk_statuses, public.sales_desk_sales_codes to authenticated;
