-- Per-user Marketing permissions. Administrators always retain full access.

create table if not exists public.marketing_user_permissions (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  permission_key text not null check (permission_key in (
    'feed.view', 'feed.create', 'feed.edit', 'feed.delete',
    'feed.manage_accounts', 'feed.assign_campaign',
    'posts.view', 'posts.create', 'posts.edit', 'posts.delete',
    'posts.assign_campaign',
    'campaigns.view', 'campaigns.create', 'campaigns.edit', 'campaigns.delete',
    'campaigns.assign_campaign', 'campaigns.change_status'
  )),
  granted_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (profile_id, permission_key)
);

alter table public.marketing_user_permissions enable row level security;
revoke all on public.marketing_user_permissions from public, anon, authenticated;

create or replace function public.has_marketing_permission(required_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_active_user() and public.can_access_workspace('marketing') and (
    public.has_role('administrator') or exists (
      select 1
      from public.marketing_user_permissions permission
      where permission.profile_id = auth.uid()
        and permission.permission_key = required_permission
    )
  );
$$;

revoke all on function public.has_marketing_permission(text) from public, anon;
grant execute on function public.has_marketing_permission(text) to authenticated;

create or replace function public.my_marketing_permissions()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not public.can_access_workspace('marketing') then array[]::text[]
    when public.has_role('administrator') then array[
      'feed.view', 'feed.create', 'feed.edit', 'feed.delete',
      'feed.manage_accounts', 'feed.assign_campaign',
      'posts.view', 'posts.create', 'posts.edit', 'posts.delete',
      'posts.assign_campaign',
      'campaigns.view', 'campaigns.create', 'campaigns.edit', 'campaigns.delete',
      'campaigns.assign_campaign', 'campaigns.change_status'
    ]::text[]
    else coalesce((
      select array_agg(permission.permission_key order by permission.permission_key)
      from public.marketing_user_permissions permission
      where permission.profile_id = auth.uid()
    ), array[]::text[])
  end;
$$;

revoke all on function public.my_marketing_permissions() from public, anon;
grant execute on function public.my_marketing_permissions() to authenticated;

create or replace function public.my_marketing_campaign_options()
returns table (
  id uuid, name text, objective text, campaign_type text, stage text,
  start_date date, end_date date, owner_id uuid, created_at timestamptz, updated_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (
    public.has_marketing_permission('feed.view') or public.has_marketing_permission('posts.view')
    or public.has_marketing_permission('feed.assign_campaign') or public.has_marketing_permission('posts.assign_campaign')
    or public.has_marketing_permission('campaigns.assign_campaign')
  ) then
    raise exception 'Marketing campaign option access required' using errcode = '42501';
  end if;
  return query
  select campaign.id, campaign.name, ''::text, campaign.campaign_type, campaign.stage,
    campaign.start_date, campaign.end_date, null::uuid, campaign.created_at, campaign.updated_at
  from public.campaigns campaign
  order by lower(campaign.name), campaign.id;
end;
$$;

create or replace function public.my_marketing_campaign_post_counts()
returns table (campaign_id uuid, post_count bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_marketing_permission('campaigns.view') then
    raise exception 'Campaign view permission required' using errcode = '42501';
  end if;
  return query
  select post.campaign_id, count(*)
  from public.posts post
  where post.campaign_id is not null
  group by post.campaign_id;
end;
$$;

revoke all on function public.my_marketing_campaign_options() from public, anon;
revoke all on function public.my_marketing_campaign_post_counts() from public, anon;
grant execute on function public.my_marketing_campaign_options() to authenticated;
grant execute on function public.my_marketing_campaign_post_counts() to authenticated;

-- Evaluate workspace access for a target profile without changing auth.uid().
create or replace function public.can_profile_access_workspace(target_profile_id uuid, workspace_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles profile
    where profile.id = target_profile_id and profile.active = true
  ) and exists (
    select 1 from public.profile_roles role_assignment
    where role_assignment.profile_id = target_profile_id
      and (
        role_assignment.role_id = 'administrator'
        or (workspace_name = 'marketing' and role_assignment.role_id in ('marketing', 'management'))
        or (workspace_name = 'sales_desk' and role_assignment.role_id in ('sales', 'sales_manager', 'management'))
        or (workspace_name = 'returns_claims' and role_assignment.role_id in ('returns', 'management'))
        or (workspace_name = 'stock_control' and role_assignment.role_id in ('stock', 'management'))
        or (workspace_name = 'fleet_management' and role_assignment.role_id = 'fleet')
        or (workspace_name = 'ecommerce' and role_assignment.role_id = 'ecommerce')
        or (workspace_name = 'reporting' and role_assignment.role_id in ('reporting', 'management', 'report_builder'))
      )
  );
$$;

revoke all on function public.can_profile_access_workspace(uuid, text) from public, anon, authenticated;

-- Recreate after the helper above exists (PostgreSQL resolves function bodies at creation).
create or replace function public.admin_list_marketing_permissions()
returns table (
  profile_id uuid, display_name text, email text, sales_code text,
  can_open boolean, is_administrator boolean, permissions text[]
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (public.is_active_user() and public.has_role('administrator')) then
    raise exception 'Only active administrators can list Marketing permissions' using errcode = '42501';
  end if;
  return query
  select profile.id, profile.display_name, profile.email, profile.sales_code,
    public.can_profile_access_workspace(profile.id, 'marketing'),
    exists (select 1 from public.profile_roles r where r.profile_id = profile.id and r.role_id = 'administrator'),
    coalesce((select array_agg(p.permission_key order by p.permission_key)
      from public.marketing_user_permissions p where p.profile_id = profile.id), array[]::text[])
  from public.profiles profile
  where profile.active = true
  order by lower(coalesce(nullif(btrim(profile.display_name), ''), profile.email, '')), profile.id;
end;
$$;

create or replace function public.admin_set_marketing_permission(
  p_profile_id uuid,
  p_permission_key text,
  p_enabled boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed boolean := false;
begin
  if not (public.is_active_user() and public.has_role('administrator')) then
    raise exception 'Only active administrators can change Marketing permissions' using errcode = '42501';
  end if;
  if p_enabled is null then raise exception 'p_enabled must not be null' using errcode = '22004'; end if;
  if p_permission_key not in (
    'feed.view', 'feed.create', 'feed.edit', 'feed.delete',
    'feed.manage_accounts', 'feed.assign_campaign',
    'posts.view', 'posts.create', 'posts.edit', 'posts.delete', 'posts.assign_campaign',
    'campaigns.view', 'campaigns.create', 'campaigns.edit', 'campaigns.delete',
    'campaigns.assign_campaign', 'campaigns.change_status'
  ) then
    raise exception 'Unknown Marketing permission: %', p_permission_key using errcode = '22023';
  end if;
  if not public.can_profile_access_workspace(p_profile_id, 'marketing') then
    raise exception 'The selected user cannot open Marketing' using errcode = '42501';
  end if;
  if exists (select 1 from public.profile_roles r where r.profile_id = p_profile_id and r.role_id = 'administrator') then
    return false;
  end if;

  if p_enabled then
    insert into public.marketing_user_permissions (profile_id, permission_key, granted_by, updated_at)
    values (p_profile_id, p_permission_key, auth.uid(), now())
    on conflict (profile_id, permission_key) do update
      set granted_by = excluded.granted_by, updated_at = excluded.updated_at;
    changed := true;
  else
    delete from public.marketing_user_permissions
    where profile_id = p_profile_id and permission_key = p_permission_key;
    changed := found;
  end if;
  return changed;
end;
$$;

revoke all on function public.admin_list_marketing_permissions() from public, anon;
revoke all on function public.admin_set_marketing_permission(uuid, text, boolean) from public, anon;
grant execute on function public.admin_list_marketing_permissions() to authenticated;
grant execute on function public.admin_set_marketing_permission(uuid, text, boolean) to authenticated;

-- Preserve current behaviour on rollout. Administrators remain implicit and are not stored.
insert into public.marketing_user_permissions (profile_id, permission_key)
select profile.id, permission.permission_key
from public.profiles profile
cross join unnest(array[
  'feed.view', 'feed.create', 'feed.edit', 'feed.delete',
  'feed.assign_campaign',
  'posts.view', 'posts.create', 'posts.edit', 'posts.delete', 'posts.assign_campaign',
  'campaigns.view', 'campaigns.create', 'campaigns.edit', 'campaigns.delete',
  'campaigns.assign_campaign', 'campaigns.change_status'
]::text[]) permission(permission_key)
where profile.active = true
  and public.can_profile_access_workspace(profile.id, 'marketing')
  and not exists (select 1 from public.profile_roles r where r.profile_id = profile.id and r.role_id = 'administrator')
on conflict (profile_id, permission_key) do nothing;

-- New direct Marketing grants start with the current full-access behaviour.
create or replace function public.seed_marketing_permissions_for_role()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.role_id in ('marketing', 'management') then
    insert into public.marketing_user_permissions (profile_id, permission_key)
    select new.profile_id, key
    from unnest(array[
      'feed.view', 'feed.create', 'feed.edit', 'feed.delete',
      'feed.assign_campaign',
      'posts.view', 'posts.create', 'posts.edit', 'posts.delete', 'posts.assign_campaign',
      'campaigns.view', 'campaigns.create', 'campaigns.edit', 'campaigns.delete',
      'campaigns.assign_campaign', 'campaigns.change_status'
    ]::text[]) key
    on conflict (profile_id, permission_key) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists profile_roles_seed_marketing_permissions on public.profile_roles;
create trigger profile_roles_seed_marketing_permissions
after insert on public.profile_roles for each row execute function public.seed_marketing_permissions_for_role();

drop policy if exists "active users read campaigns" on public.campaigns;
drop policy if exists "active users manage campaigns" on public.campaigns;
drop policy if exists "active users read posts" on public.posts;
drop policy if exists "active users manage posts" on public.posts;

create policy "permitted users read campaigns" on public.campaigns for select to authenticated
using (public.has_marketing_permission('campaigns.view'));
create policy "permitted users create campaigns" on public.campaigns for insert to authenticated
with check (public.has_marketing_permission('campaigns.create'));
create policy "permitted users update campaigns" on public.campaigns for update to authenticated
using (public.has_marketing_permission('campaigns.edit') or public.has_marketing_permission('campaigns.change_status'))
with check (public.has_marketing_permission('campaigns.edit') or public.has_marketing_permission('campaigns.change_status'));
create policy "permitted users delete campaigns" on public.campaigns for delete to authenticated
using (public.has_marketing_permission('campaigns.delete'));

create policy "permitted users read posts" on public.posts for select to authenticated
using (public.has_marketing_permission('feed.view') or public.has_marketing_permission('posts.view'));
create policy "permitted users create posts" on public.posts for insert to authenticated
with check (public.has_marketing_permission('feed.create') or public.has_marketing_permission('posts.create'));
create policy "permitted users update posts" on public.posts for update to authenticated
using (public.has_marketing_permission('feed.edit') or public.has_marketing_permission('posts.edit')
  or public.has_marketing_permission('feed.assign_campaign') or public.has_marketing_permission('posts.assign_campaign')
  or public.has_marketing_permission('campaigns.assign_campaign'))
with check (public.has_marketing_permission('feed.edit') or public.has_marketing_permission('posts.edit')
  or public.has_marketing_permission('feed.assign_campaign') or public.has_marketing_permission('posts.assign_campaign')
  or public.has_marketing_permission('campaigns.assign_campaign'));
create policy "permitted users delete posts" on public.posts for delete to authenticated
using (public.has_marketing_permission('feed.delete') or public.has_marketing_permission('posts.delete'));

create or replace function public.authorize_marketing_campaign_update()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if auth.role() = 'service_role' then return new; end if;
  if tg_op = 'INSERT' then
    if new.stage <> 'new' and not public.has_marketing_permission('campaigns.change_status') then
      raise exception 'Marketing permission required: campaigns.change_status' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.stage is distinct from old.stage and not public.has_marketing_permission('campaigns.change_status') then
    raise exception 'Marketing permission required: campaigns.change_status' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['stage','updated_at']) is distinct from (to_jsonb(old) - array['stage','updated_at'])
    and not public.has_marketing_permission('campaigns.edit') then
    raise exception 'Marketing permission required: campaigns.edit' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.authorize_marketing_post_write()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if auth.role() = 'service_role' then return new; end if;
  if tg_op = 'INSERT' then
    if new.campaign_id is not null and not (
      public.has_marketing_permission('feed.assign_campaign') or
      public.has_marketing_permission('posts.assign_campaign') or
      public.has_marketing_permission('campaigns.assign_campaign')) then
      raise exception 'Marketing permission required: assign to campaign' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.campaign_id is distinct from old.campaign_id and not (
    public.has_marketing_permission('feed.assign_campaign') or
    public.has_marketing_permission('posts.assign_campaign') or
    public.has_marketing_permission('campaigns.assign_campaign')) then
    raise exception 'Marketing permission required: assign to campaign' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['campaign_id','updated_at']) is distinct from (to_jsonb(old) - array['campaign_id','updated_at'])
    and not (public.has_marketing_permission('feed.edit') or public.has_marketing_permission('posts.edit')) then
    raise exception 'Marketing permission required: edit posts' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.prevent_nonempty_campaign_delete()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if auth.role() = 'service_role' then return old; end if;
  if exists (select 1 from public.posts post where post.campaign_id = old.id) then
    raise exception 'Campaigns can only be deleted when they contain no posts' using errcode = '23503';
  end if;
  return old;
end;
$$;

drop trigger if exists campaigns_authorize_marketing_update on public.campaigns;
create trigger campaigns_authorize_marketing_update before insert or update on public.campaigns
for each row execute function public.authorize_marketing_campaign_update();
drop trigger if exists posts_authorize_marketing_write on public.posts;
create trigger posts_authorize_marketing_write before insert or update on public.posts
for each row execute function public.authorize_marketing_post_write();
drop trigger if exists campaigns_prevent_nonempty_delete on public.campaigns;
create trigger campaigns_prevent_nonempty_delete before delete on public.campaigns
for each row execute function public.prevent_nonempty_campaign_delete();

drop policy if exists "authenticated users upload marketing media" on storage.objects;
drop policy if exists "authenticated users update marketing media" on storage.objects;
drop policy if exists "authenticated users delete marketing media" on storage.objects;
create policy "permitted users upload marketing media" on storage.objects for insert to authenticated
with check (bucket_id = 'marketing-media' and (
  public.has_marketing_permission('feed.create') or public.has_marketing_permission('posts.create')
  ) and (storage.foldername(name))[1] = auth.uid()::text);
create policy "permitted users update marketing media" on storage.objects for update to authenticated
using (bucket_id = 'marketing-media' and (
  public.has_marketing_permission('feed.edit') or public.has_marketing_permission('posts.edit')
  ) and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'marketing-media' and (
  public.has_marketing_permission('feed.edit') or public.has_marketing_permission('posts.edit')
  ) and (storage.foldername(name))[1] = auth.uid()::text);
create policy "permitted users delete marketing media" on storage.objects for delete to authenticated
using (bucket_id = 'marketing-media' and (
  public.has_marketing_permission('feed.delete') or public.has_marketing_permission('posts.delete')
  ) and (storage.foldername(name))[1] = auth.uid()::text);
