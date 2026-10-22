-- Impala Hub identity foundation.
-- Supabase Auth owns credentials; these tables own application identity and roles.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  email text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.roles (
  id text primary key,
  label text not null,
  description text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.profile_roles (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role_id text not null references public.roles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (profile_id, role_id)
);

insert into public.roles (id, label, description) values
  ('administrator', 'Administrator', 'Full platform administration'),
  ('marketing', 'Marketing', 'Marketing and publishing workspace'),
  ('sales', 'Sales', 'Sales Desk and RFQ workspace'),
  ('stock', 'Stock', 'Stock control workspace'),
  ('returns', 'Returns and Claims', 'Returns and claims workspace'),
  ('management', 'Management', 'Read-only management reporting')
on conflict (id) do nothing;

alter table public.profiles enable row level security;
alter table public.roles enable row level security;
alter table public.profile_roles enable row level security;

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.profiles where id = auth.uid() and active = true); $$;

create or replace function public.has_role(required_role text)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profile_roles pr
    join public.profiles p on p.id = pr.profile_id
    where pr.profile_id = auth.uid() and pr.role_id = required_role and p.active = true
  );
$$;

create policy "Users can read their own profile" on public.profiles for select to authenticated using (id = auth.uid());
create policy "Users can update their own display name" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy "Authenticated users can read roles" on public.roles for select to authenticated using (public.is_active_user());
create policy "Users can read their own role assignments" on public.profile_roles for select to authenticated using (profile_id = auth.uid());

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(coalesce(new.email, ''), '@', 1)), new.email)
  on conflict (id) do update set email = excluded.email, updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();
