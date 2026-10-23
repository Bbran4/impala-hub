alter table public.profiles add column if not exists sales_code text;
create unique index if not exists profiles_sales_code_unique on public.profiles (upper(sales_code)) where sales_code is not null and sales_code <> '';
insert into public.sales_desk_sales_codes (code, display_name)
select upper(btrim(sales_code)), coalesce(nullif(btrim(display_name), ''), coalesce(email, ''))
from public.profiles where sales_code is not null and btrim(sales_code) <> ''
on conflict (code) do update set display_name = excluded.display_name, updated_at = now();

create or replace function public.sync_sales_profile_code()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.sales_code is not null and btrim(new.sales_code) <> '' then
    insert into public.sales_desk_sales_codes (code, display_name)
    values (upper(btrim(new.sales_code)), coalesce(nullif(btrim(new.display_name), ''), coalesce(new.email, '')))
    on conflict (code) do update set display_name = excluded.display_name, updated_at = now();
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_sync_sales_code on public.profiles;
create trigger profiles_sync_sales_code after insert or update of sales_code, display_name on public.profiles
for each row execute procedure public.sync_sales_profile_code();
grant select, update on public.profiles to authenticated;
