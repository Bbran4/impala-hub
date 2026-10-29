-- Refuse rollout on duplicate provider identities; do not silently discard local campaigns.
do $$ begin
  if exists (select 1 from public.posts where nullif(provider_ids->>'facebook','') is not null
    group by provider_ids->>'facebook' having count(*) > 1) then
    raise exception 'Duplicate Facebook post IDs exist. Reconcile duplicate posts and their campaign assignments before applying 0093.';
  end if;
end $$;
create unique index posts_facebook_identity_idx on public.posts ((provider_ids->>'facebook'))
where nullif(provider_ids->>'facebook','') is not null;

alter table public.posts add column publish_started_at timestamptz;
alter table public.posts drop constraint posts_status_check;
alter table public.posts add constraint posts_status_check check
  (status in ('draft','awaiting_approval','scheduled','publishing','published','failed','publish_unknown'));

create or replace function public.authorize_marketing_post_write()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  editable text[] := array['title','caption','campaign_id','channels','whatsapp_recipient_type',
    'whatsapp_recipient_id','whatsapp_recipient_name','media','publish_at','updated_at'];
begin
  -- Only trusted database/server execution may write lifecycle/provider columns.
  if current_user in ('postgres','service_role') then return new; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.provider_ids <> '{}'::jsonb or new.published_at is not null
      or new.publish_started_at is not null or new.last_error is not null
      or new.created_by is distinct from auth.uid()
      or num_nonnulls(new.clicks,new.reach,new.impressions,new.views,new.likes,new.comments,
        new.shares,new.reactions,new.engagements,new.saves,new.metrics_refreshed_at) > 0 then
      raise exception 'Post lifecycle and provider fields are server-managed' using errcode='42501';
    end if;
  else
    if (to_jsonb(new) - editable) is distinct from (to_jsonb(old) - editable) then
      raise exception 'Post lifecycle and provider fields are server-managed' using errcode='42501';
    end if;
    if (old.status not in ('draft','awaiting_approval','failed') or nullif(old.provider_ids->>'facebook','') is not null)
      and (to_jsonb(new) - array['campaign_id','updated_at']) is distinct from (to_jsonb(old) - array['campaign_id','updated_at']) then
      raise exception 'Only campaign assignment may change on a locked post' using errcode='42501';
    end if;
    if (to_jsonb(new) - array['campaign_id','updated_at']) is distinct from (to_jsonb(old) - array['campaign_id','updated_at'])
      and not (public.has_marketing_permission('posts.edit') or public.has_marketing_permission('feed.edit')) then
      raise exception 'Post edit permission required' using errcode='42501';
    end if;
  end if;
  if (tg_op = 'INSERT' and new.campaign_id is not null or tg_op = 'UPDATE' and new.campaign_id is distinct from old.campaign_id)
    and not (public.has_marketing_permission('feed.assign_campaign') or public.has_marketing_permission('posts.assign_campaign') or public.has_marketing_permission('campaigns.assign_campaign')) then
    raise exception 'Campaign assignment permission required' using errcode='42501';
  end if;
  return new;
end $$;

-- Unfinished attempts from older deployments must never be blindly retried.
update public.posts set publish_started_at = coalesce(updated_at, now()) where status = 'publishing';

-- A checked, atomic content-save/schedule command, not arbitrary privileged JSON writes.
create function public.save_marketing_post(p_id uuid, p_values jsonb)
returns public.posts language plpgsql security definer set search_path = '' as $$
declare previous public.posts; proposed public.posts; result public.posts; creating boolean := p_id is null;
begin
  if p_values is null or jsonb_typeof(p_values) <> 'object' or exists (
    select 1 from jsonb_object_keys(p_values) k where k not in
    ('title','caption','campaign_id','channels','whatsapp_recipient_type','whatsapp_recipient_id','whatsapp_recipient_name','media','status','publish_at')) then
    raise exception 'Unsupported post fields' using errcode='22023';
  end if;
  if creating then
    if not (public.has_marketing_permission('posts.create') or public.has_marketing_permission('feed.create')) then
      raise exception 'Post create permission required' using errcode='42501'; end if;
    previous.title := ''; previous.caption := ''; previous.channels := '{}'; previous.media := '[]'; previous.status := 'draft';
  else
    if not (public.has_marketing_permission('posts.edit') or public.has_marketing_permission('feed.edit')
      or public.has_marketing_permission('feed.assign_campaign') or public.has_marketing_permission('posts.assign_campaign')
      or public.has_marketing_permission('campaigns.assign_campaign')) then
      raise exception 'Post edit or campaign assignment permission required' using errcode='42501'; end if;
    select * into previous from public.posts where id=p_id for update;
    if not found then raise exception 'Post not found' using errcode='P0002'; end if;
  end if;
  proposed := jsonb_populate_record(previous,p_values);
  if not creating and (to_jsonb(proposed)-'campaign_id') is distinct from (to_jsonb(previous)-'campaign_id') then
    if previous.status not in ('draft','awaiting_approval','failed') or nullif(previous.provider_ids->>'facebook','') is not null then
      raise exception 'Only campaign assignment may change on a locked post' using errcode='42501'; end if;
    if not (public.has_marketing_permission('posts.edit') or public.has_marketing_permission('feed.edit')) then
      raise exception 'Post edit permission required' using errcode='42501'; end if;
  end if;
  if (creating and proposed.campaign_id is not null or not creating and proposed.campaign_id is distinct from previous.campaign_id)
    and not (public.has_marketing_permission('feed.assign_campaign') or public.has_marketing_permission('posts.assign_campaign') or public.has_marketing_permission('campaigns.assign_campaign')) then
    raise exception 'Campaign assignment permission required' using errcode='42501'; end if;
  if creating or proposed.status is distinct from previous.status then
    if proposed.status not in ('draft','awaiting_approval','scheduled') then
      raise exception 'Invalid post transition' using errcode='22023'; end if;
  end if;
  if proposed.status='scheduled' and (creating or proposed.status is distinct from previous.status or proposed.publish_at is distinct from previous.publish_at)
    and (proposed.publish_at is null or proposed.publish_at <= now()) then
    raise exception 'Choose a future publication time' using errcode='22023'; end if;
  if creating then
    insert into public.posts(title,caption,campaign_id,channels,whatsapp_recipient_type,whatsapp_recipient_id,whatsapp_recipient_name,media,status,publish_at,created_by)
    values(proposed.title,proposed.caption,proposed.campaign_id,proposed.channels,proposed.whatsapp_recipient_type,proposed.whatsapp_recipient_id,proposed.whatsapp_recipient_name,proposed.media,proposed.status,proposed.publish_at,auth.uid()) returning * into result;
  else
    update public.posts set title=proposed.title,caption=proposed.caption,campaign_id=proposed.campaign_id,channels=proposed.channels,
      whatsapp_recipient_type=proposed.whatsapp_recipient_type,whatsapp_recipient_id=proposed.whatsapp_recipient_id,
      whatsapp_recipient_name=proposed.whatsapp_recipient_name,media=proposed.media,status=proposed.status,publish_at=proposed.publish_at
      where id=p_id returning * into result;
  end if;
  return result;
end $$;
revoke all on function public.save_marketing_post(uuid,jsonb) from public,anon;
grant execute on function public.save_marketing_post(uuid,jsonb) to authenticated;

-- Serializing each provider identity makes concurrent syncs converge without a destructive upsert.
create function public.sync_facebook_post(p_values jsonb,p_actor uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare existing public.posts; incoming public.posts; result uuid; identity text := p_values->'provider_ids'->>'facebook';
begin
  if nullif(identity,'') is null then raise exception 'Facebook identity required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(identity,0));
  select * into existing from public.posts where provider_ids->>'facebook'=identity for update;
  incoming := jsonb_populate_record(null::public.posts,p_values);
  if existing.id is null then
    insert into public.posts(caption,channels,status,published_at,media,provider_ids,likes,comments,shares,impressions,reach,views,clicks,metrics_refreshed_at,created_by)
    values(incoming.caption,array['facebook'],'published',incoming.published_at,incoming.media,incoming.provider_ids,incoming.likes,incoming.comments,incoming.shares,incoming.impressions,incoming.reach,incoming.views,incoming.clicks,incoming.metrics_refreshed_at,p_actor) returning id into result;
  else
    update public.posts set caption=incoming.caption,media=incoming.media,provider_ids=existing.provider_ids || incoming.provider_ids,
      likes=incoming.likes,comments=incoming.comments,shares=incoming.shares,impressions=incoming.impressions,reach=incoming.reach,
      views=incoming.views,clicks=incoming.clicks,metrics_refreshed_at=incoming.metrics_refreshed_at where id=existing.id;
    result := existing.id;
  end if;
  return result;
end $$;
revoke all on function public.sync_facebook_post(jsonb,uuid) from public,anon,authenticated;
grant execute on function public.sync_facebook_post(jsonb,uuid) to service_role;
