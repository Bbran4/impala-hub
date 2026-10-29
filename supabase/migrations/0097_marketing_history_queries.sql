-- Audit events are generated atomically, never supplied by browser clients.
revoke insert,update,delete on public.audit_log from public,anon,authenticated;
drop policy if exists "active users write audit log" on public.audit_log;
drop policy if exists "active users read audit log" on public.audit_log;
create policy "permitted users read audit log" on public.audit_log for select to authenticated
using (public.is_active_user() and (entity_type <> 'post' or public.has_marketing_permission('posts.view') or public.has_marketing_permission('feed.view')));
create index audit_log_post_history_idx on public.audit_log(entity_id,id desc) where entity_type='post';

create function public.audit_marketing_post()
returns trigger language plpgsql security definer set search_path='' as $$
declare before_row jsonb := case when tg_op='INSERT' then '{}'::jsonb else to_jsonb(old) end;
  after_row jsonb := case when tg_op='DELETE' then '{}'::jsonb else to_jsonb(new) end;
  changed text[]; actor_name text;
begin
  select array_agg(k order by k) into changed from (
    select jsonb_object_keys(before_row || after_row) k
  ) keys where k not in ('updated_at','metrics_refreshed_at') and before_row->k is distinct from after_row->k;
  if tg_op='UPDATE' and coalesce(cardinality(changed),0)=0 then return new; end if;
  select coalesce(nullif(p.display_name,''),p.email) into actor_name from public.profiles p where p.id=auth.uid();
  insert into public.audit_log(actor_id,action,entity_type,entity_id,details)
  values(auth.uid(),case tg_op when 'INSERT' then 'created' when 'DELETE' then 'deleted' else 'updated' end,
    'post',coalesce(new.id,old.id)::text,jsonb_build_object('changed',changed,'status',coalesce(new.status,old.status),
    'actor_name',coalesce(actor_name,'System'),
    'before',jsonb_build_object('status',before_row->'status','campaign_id',before_row->'campaign_id','publish_at',before_row->'publish_at'),
    'after',jsonb_build_object('status',after_row->'status','campaign_id',after_row->'campaign_id','publish_at',after_row->'publish_at')));
  return coalesce(new,old);
end $$;
revoke all on function public.audit_marketing_post() from public,anon,authenticated;
create trigger posts_audit after insert or update or delete on public.posts for each row execute function public.audit_marketing_post();

-- Remove previously cached expiring provider URLs; the next sync copies them to Storage.
update public.posts p set media=coalesce((select jsonb_agg(m) from jsonb_array_elements(p.media) m
  where coalesce(m->>'url','') !~* '^https://[^/]*(fbcdn\.net|fbsbx\.com)/'),'[]'::jsonb)
where p.provider_ids ? 'facebook' and exists(select 1 from jsonb_array_elements(p.media) m
  where coalesce(m->>'url','') ~* '^https://[^/]*(fbcdn\.net|fbsbx\.com)/');

create index posts_display_date_idx on public.posts((coalesce(published_at,publish_at,created_at)) desc,id desc);

-- Campaign options deliberately expose only the existing permission-checked option set.
-- One literal ILIKE expression searches title, caption and campaign name together.
create function public.marketing_filtered_post_ids(p_month date default null,p_campaign uuid default null,
  p_unassigned boolean default false,p_search text default '',p_status text default null,p_channel text default null)
returns table(id uuid,sort_at timestamptz) language plpgsql stable security invoker set search_path='' as $$
begin
  if not (public.has_marketing_permission('posts.view') or public.has_marketing_permission('feed.view')) then
    raise exception 'Marketing post view permission required' using errcode='42501'; end if;
  if p_month is not null and p_month <> date_trunc('month',p_month::timestamp)::date then raise exception 'Choose the first day of a month' using errcode='22023'; end if;
  if length(coalesce(p_search,''))>200 then raise exception 'Search is limited to 200 characters' using errcode='22023'; end if;
  return query select p.id,coalesce(p.published_at,p.publish_at,p.created_at) from public.posts p
  left join public.my_marketing_campaign_options() c on c.id=p.campaign_id
  where (p_month is null or (coalesce(p.published_at,p.publish_at,p.created_at) >= p_month::timestamp at time zone 'Africa/Johannesburg'
    and coalesce(p.published_at,p.publish_at,p.created_at) < (p_month+interval '1 month') at time zone 'Africa/Johannesburg'))
    and (p_campaign is null or p.campaign_id=p_campaign) and (not p_unassigned or p.campaign_id is null)
    and (p_status is null or p.status=p_status) and (p_channel is null or p_channel=any(p.channels))
    and concat_ws(' ',p.title,p.caption,c.name) ilike '%' || replace(replace(replace(btrim(coalesce(p_search,'')), E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_') || '%' escape E'\\';
end $$;
revoke all on function public.marketing_filtered_post_ids(date,uuid,boolean,text,text,text) from public,anon;
grant execute on function public.marketing_filtered_post_ids(date,uuid,boolean,text,text,text) to authenticated;

create function public.marketing_post_page(p_month date default null,p_campaign uuid default null,
  p_unassigned boolean default false,p_search text default '',p_status text default null,p_channel text default null,
  p_offset integer default 0,p_limit integer default 50,p_preview boolean default false,p_summary boolean default false)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if p_offset is null or p_offset<0 or p_limit is null or p_limit not between 1 and 100 then raise exception 'Invalid post page' using errcode='22023'; end if;
  with matching as materialized (
    select id,sort_at from public.marketing_filtered_post_ids(p_month,p_campaign,p_unassigned,p_search,p_status,p_channel)
  ), selected as (
    select id,sort_at from matching order by sort_at desc,id desc limit p_limit offset p_offset
  ), page as (
    select p.id,title,caption,campaign_id,channels,status,publish_at,published_at,created_at,updated_at,last_error,
      provider_ids,likes,reactions,saves,comments,shares,clicks,views,impressions,reach,metrics_refreshed_at,
      case when p_preview and jsonb_array_length(media)>0 then jsonb_build_array(media->0) else '[]'::jsonb end media,
      jsonb_array_length(media) media_count,coalesce(published_at,publish_at,created_at) sort_at
    from selected picked join public.posts p on p.id=picked.id
  ), summary as (
    select p.campaign_id,coalesce(c.name,'No campaign') label,c.campaign_type,count(*) posts,
      coalesce(sum(p.likes),0) likes,coalesce(sum(p.comments),0) comments,coalesce(sum(p.shares),0) shares,coalesce(sum(p.clicks),0) clicks
    from matching m join public.posts p on p.id=m.id left join public.my_marketing_campaign_options() c on c.id=p.campaign_id
    where p_summary group by p.campaign_id,c.name,c.campaign_type
  )
  select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(page)-'sort_at' order by sort_at desc,id desc) from page),'[]'::jsonb),
    'total',(select count(*) from matching),'offset',p_offset,'limit',p_limit,
    'summary',coalesce((select jsonb_agg(to_jsonb(summary) order by label,campaign_id) from summary),'[]'::jsonb)) into result;
  return result;
end $$;
revoke all on function public.marketing_post_page(date,uuid,boolean,text,text,text,integer,integer,boolean,boolean) from public,anon;
grant execute on function public.marketing_post_page(date,uuid,boolean,text,text,text,integer,integer,boolean,boolean) to authenticated;
