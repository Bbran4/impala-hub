-- Generic application permissions.
-- Role rows provide defaults; a user row is an explicit override. A null
-- override means inherit the role default, false is an explicit deny.

create table if not exists public.application_permission_catalog (
  app_id text not null check (app_id in (
    'marketing', 'sales_desk', 'returns_claims', 'stock_control',
    'fleet_management', 'ecommerce', 'reporting'
  )),
  permission_key text not null,
  group_label text not null,
  label text not null,
  position integer not null default 0,
  primary key (app_id, permission_key)
);

create table if not exists public.application_role_permissions (
  role_id text not null references public.roles(id) on delete cascade,
  app_id text not null,
  permission_key text not null,
  primary key (role_id, app_id, permission_key),
  foreign key (app_id, permission_key)
    references public.application_permission_catalog(app_id, permission_key)
    on delete cascade
);

create table if not exists public.application_user_permission_overrides (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  app_id text not null,
  permission_key text not null,
  enabled boolean not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (profile_id, app_id, permission_key),
  foreign key (app_id, permission_key)
    references public.application_permission_catalog(app_id, permission_key)
    on delete cascade
);

alter table public.application_permission_catalog enable row level security;
alter table public.application_role_permissions enable row level security;
alter table public.application_user_permission_overrides enable row level security;
revoke all on public.application_permission_catalog from public, anon, authenticated;
revoke all on public.application_role_permissions from public, anon, authenticated;
revoke all on public.application_user_permission_overrides from public, anon, authenticated;

insert into public.application_permission_catalog(app_id, permission_key, group_label, label, position) values
('marketing','feed.view','Feed','View',10),
('marketing','feed.create','Feed','Create',20),
('marketing','feed.edit','Feed','Edit',30),
('marketing','feed.delete','Feed','Delete',40),
('marketing','feed.manage_accounts','Feed','Manage accounts',50),
('marketing','feed.assign_campaign','Feed','Assign to campaign',60),
('marketing','posts.view','Posts','View',70),
('marketing','posts.create','Posts','Create',80),
('marketing','posts.edit','Posts','Edit',90),
('marketing','posts.delete','Posts','Delete',100),
('marketing','posts.assign_campaign','Posts','Assign to campaign',110),
('marketing','campaigns.view','Campaigns','View',120),
('marketing','campaigns.create','Campaigns','Create',130),
('marketing','campaigns.edit','Campaigns','Edit',140),
('marketing','campaigns.delete','Campaigns','Delete',150),
('marketing','campaigns.assign_campaign','Campaigns','Assign to campaign',160),
('marketing','campaigns.change_status','Campaigns','Change status',170),
('marketing','marketing.refresh','Workspace','Refresh and sync',180),
('marketing','marketing.publish','Workspace','Publish content',190),
('sales_desk','sales_desk.view','RFQs','View',10),
('sales_desk','sales_desk.create','RFQs','Create',20),
('sales_desk','sales_desk.edit','RFQs','Edit',30),
('sales_desk','sales_desk.delete','RFQs','Delete',40),
('sales_desk','sales_desk.refresh','RFQs','Refresh',50),
('sales_desk','sales_desk.assign','RFQs','Assign and claim',60),
('sales_desk','sales_desk.configuration','Configuration','Manage configuration',70),
('returns_claims','returns_claims.view','Returns and claims','View',10),
('returns_claims','returns_claims.create','Returns and claims','Create',20),
('returns_claims','returns_claims.edit','Returns and claims','Edit',30),
('returns_claims','returns_claims.delete','Returns and claims','Delete',40),
('returns_claims','returns_claims.refresh','Returns and claims','Refresh',50),
('returns_claims','returns_claims.attachments','Returns and claims','Manage attachments',60),
('returns_claims','returns_claims.export','Returns and claims','Export',70),
('stock_control','stock_control.view','Stock control','View',10),
('stock_control','stock_control.create','Stock control','Create',20),
('stock_control','stock_control.edit','Stock control','Edit',30),
('stock_control','stock_control.delete','Stock control','Delete',40),
('stock_control','stock_control.refresh','Stock control','Refresh and sync',50),
('stock_control','stock_control.import','Stock control','Import data',60),
('stock_control','stock_control.configuration','Configuration','Manage configuration',70),
('fleet_management','fleet_management.view','Fleet management','View',10),
('fleet_management','fleet_management.create','Fleet management','Create',20),
('fleet_management','fleet_management.edit','Fleet management','Edit',30),
('fleet_management','fleet_management.delete','Fleet management','Delete',40),
('fleet_management','fleet_management.refresh','Fleet management','Refresh',50),
('ecommerce','ecommerce.view','E-commerce','View',10),
('ecommerce','ecommerce.create','E-commerce','Create',20),
('ecommerce','ecommerce.edit','E-commerce','Edit',30),
('ecommerce','ecommerce.delete','E-commerce','Delete',40),
('ecommerce','ecommerce.refresh','E-commerce','Refresh',50),
('reporting','reporting.view','Reporting','View',10),
('reporting','reporting.create','Reporting','Create',20),
('reporting','reporting.edit','Reporting','Edit',30),
('reporting','reporting.delete','Reporting','Delete',40),
('reporting','reporting.refresh','Reporting','Refresh and reload',50),
('reporting','reporting.export','Reporting','Export',60)
on conflict (app_id, permission_key) do update set
  group_label = excluded.group_label, label = excluded.label, position = excluded.position;

-- Sensible role defaults. Delete remains an explicit administrator/user override.
insert into public.application_role_permissions(role_id, app_id, permission_key)
select role_id, app_id, permission_key from (
  values
    ('marketing','marketing','feed.view'), ('marketing','marketing','feed.create'),
    ('marketing','marketing','feed.edit'), ('marketing','marketing','marketing.refresh'),
    ('marketing','marketing','feed.manage_accounts'), ('marketing','marketing','marketing.publish'),
    ('marketing','marketing','feed.assign_campaign'), ('marketing','marketing','posts.view'),
    ('marketing','marketing','posts.create'), ('marketing','marketing','posts.edit'),
    ('marketing','marketing','posts.assign_campaign'), ('marketing','marketing','campaigns.view'),
    ('marketing','marketing','campaigns.create'), ('marketing','marketing','campaigns.edit'),
    ('marketing','marketing','campaigns.assign_campaign'), ('marketing','marketing','campaigns.change_status'),
    ('management','marketing','feed.view'), ('management','marketing','marketing.refresh'),
    ('sales','sales_desk','sales_desk.view'), ('sales','sales_desk','sales_desk.create'),
    ('sales','sales_desk','sales_desk.edit'), ('sales','sales_desk','sales_desk.refresh'),
    ('sales','sales_desk','sales_desk.assign'), ('sales_manager','sales_desk','sales_desk.view'),
    ('sales_manager','sales_desk','sales_desk.create'), ('sales_manager','sales_desk','sales_desk.edit'),
    ('sales_manager','sales_desk','sales_desk.refresh'), ('sales_manager','sales_desk','sales_desk.assign'),
    ('sales_manager','sales_desk','sales_desk.configuration'),
    ('returns','returns_claims','returns_claims.view'), ('returns','returns_claims','returns_claims.create'),
    ('returns','returns_claims','returns_claims.edit'), ('returns','returns_claims','returns_claims.refresh'),
    ('returns','returns_claims','returns_claims.attachments'), ('returns','returns_claims','returns_claims.export'),
    ('stock','stock_control','stock_control.view'), ('stock','stock_control','stock_control.create'),
    ('stock','stock_control','stock_control.edit'), ('stock','stock_control','stock_control.refresh'),
    ('stock','stock_control','stock_control.import'), ('stock','stock_control','stock_control.configuration'),
    ('fleet','fleet_management','fleet_management.view'), ('fleet','fleet_management','fleet_management.create'),
    ('fleet','fleet_management','fleet_management.edit'), ('fleet','fleet_management','fleet_management.refresh'),
    ('ecommerce','ecommerce','ecommerce.view'), ('ecommerce','ecommerce','ecommerce.create'),
    ('ecommerce','ecommerce','ecommerce.edit'), ('ecommerce','ecommerce','ecommerce.refresh'),
    ('reporting','reporting','reporting.view'), ('reporting','reporting','reporting.create'),
    ('reporting','reporting','reporting.edit'), ('reporting','reporting','reporting.refresh'),
    ('reporting','reporting','reporting.export'), ('report_builder','reporting','reporting.view'),
    ('report_builder','reporting','reporting.create'), ('report_builder','reporting','reporting.edit'),
    ('report_builder','reporting','reporting.refresh'), ('report_builder','reporting','reporting.export'),
    ('management','reporting','reporting.view'), ('management','reporting','reporting.refresh')
) defaults(role_id, app_id, permission_key)
on conflict do nothing;

create or replace function public.has_application_permission(p_app_id text, p_permission_key text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_active_user() and (
    public.has_role('administrator') or (
      public.can_access_workspace(p_app_id) and (
        coalesce((select override.enabled
          from public.application_user_permission_overrides override
          where override.profile_id = auth.uid()
            and override.app_id = p_app_id
            and override.permission_key = p_permission_key),
          (select exists (
            select 1 from public.application_role_permissions role_permission
            join public.profile_roles profile_role on profile_role.role_id = role_permission.role_id
            where profile_role.profile_id = auth.uid()
              and role_permission.app_id = p_app_id
              and role_permission.permission_key = p_permission_key
          )) or (p_app_id = 'marketing' and exists (
            select 1 from public.marketing_user_permissions legacy
            where legacy.profile_id = auth.uid() and legacy.permission_key = p_permission_key
          )), false)
      )
    )
  );
$$;

create or replace function public.admin_list_permission_users()
returns table(profile_id uuid, display_name text, email text, roles text[])
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.is_active_user() and public.has_role('administrator')) then
    raise exception 'Only active administrators can list permission users' using errcode = '42501';
  end if;
  return query
  select profile.id, profile.display_name, profile.email,
    coalesce(array_agg(role.label order by role.label) filter (where role.id is not null), '{}'::text[])
  from public.profiles profile
  left join public.profile_roles profile_role on profile_role.profile_id = profile.id
  left join public.roles role on role.id = profile_role.role_id
  where profile.active = true
  group by profile.id, profile.display_name, profile.email
  order by lower(coalesce(nullif(btrim(profile.display_name), ''), profile.email, '')), profile.id;
end;
$$;

create or replace function public.admin_get_user_app_permissions(p_profile_id uuid, p_app_id text)
returns table(permission_key text, group_label text, label text, effective_enabled boolean, override_enabled boolean, role_granted boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.is_active_user() and public.has_role('administrator')) then
    raise exception 'Only active administrators can view permissions' using errcode = '42501';
  end if;
  return query
  select catalog.permission_key, catalog.group_label, catalog.label,
    coalesce(permission_override.enabled, role_grant.granted, false),
    permission_override.enabled, coalesce(role_grant.granted, false)
  from public.application_permission_catalog catalog
  left join public.application_user_permission_overrides permission_override
    on permission_override.profile_id = p_profile_id
    and permission_override.app_id = catalog.app_id
    and permission_override.permission_key = catalog.permission_key
  left join lateral (
    select true as granted
    from public.application_role_permissions role_permission
    join public.profile_roles profile_role on profile_role.role_id = role_permission.role_id
    where profile_role.profile_id = p_profile_id
      and role_permission.app_id = catalog.app_id
      and role_permission.permission_key = catalog.permission_key
    limit 1
  ) role_grant on true
  where catalog.app_id = p_app_id
  order by catalog.position, catalog.permission_key;
end;
$$;

create or replace function public.admin_set_user_app_permission(
  p_profile_id uuid, p_app_id text, p_permission_key text, p_enabled boolean
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not (public.is_active_user() and public.has_role('administrator')) then
    raise exception 'Only active administrators can change permissions' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_profile_id and active = true) then
    raise exception 'Active profile not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.application_permission_catalog where app_id = p_app_id and permission_key = p_permission_key) then
    raise exception 'Unknown application permission' using errcode = '22023';
  end if;
  if p_enabled is null then
    delete from public.application_user_permission_overrides
    where profile_id = p_profile_id and app_id = p_app_id and permission_key = p_permission_key;
  else
    insert into public.application_user_permission_overrides(profile_id, app_id, permission_key, enabled, updated_by)
    values (p_profile_id, p_app_id, p_permission_key, p_enabled, auth.uid())
    on conflict (profile_id, app_id, permission_key) do update
      set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now();
  end if;
  return true;
end;
$$;

revoke all on function public.has_application_permission(text, text) from public, anon;
revoke all on function public.admin_list_permission_users() from public, anon;
revoke all on function public.admin_get_user_app_permissions(uuid, text) from public, anon;
revoke all on function public.admin_set_user_app_permission(uuid, text, text, boolean) from public, anon;
grant execute on function public.has_application_permission(text, text) to authenticated;
grant execute on function public.admin_list_permission_users() to authenticated;
grant execute on function public.admin_get_user_app_permissions(uuid, text) to authenticated;
grant execute on function public.admin_set_user_app_permission(uuid, text, text, boolean) to authenticated;

-- Keep existing Marketing enforcement compatible while allowing the new generic
-- role/override permissions to take precedence.
create or replace function public.has_marketing_permission(required_permission text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.has_application_permission('marketing', required_permission);
$$;

create or replace function public.my_marketing_permissions()
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(catalog.permission_key order by catalog.position), '{}'::text[])
  from public.application_permission_catalog catalog
  where catalog.app_id = 'marketing'
    and public.has_marketing_permission(catalog.permission_key);
$$;

revoke all on function public.has_marketing_permission(text) from public, anon;
revoke all on function public.my_marketing_permissions() from public, anon;
grant execute on function public.has_marketing_permission(text) to authenticated;
grant execute on function public.my_marketing_permissions() to authenticated;

notify pgrst, 'reload schema';
