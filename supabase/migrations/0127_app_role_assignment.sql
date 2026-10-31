-- App-specific role selection never grants platform Administrator/Management.
create function public.app_assignable_roles(p_app_id text)
returns text[] language sql immutable set search_path='' as $$
 select case p_app_id when 'sales_desk' then array['sales_manager','sales']
 when 'marketing' then array['marketing'] when 'returns_claims' then array['returns']
 when 'stock_control' then array['stock'] when 'fleet_management' then array['fleet']
 when 'ecommerce' then array['ecommerce'] when 'reporting' then array['report_builder','reporting'] else null end;
$$;
revoke all on function public.app_assignable_roles(text) from public,anon;
grant execute on function public.app_assignable_roles(text) to authenticated;

create function public.admin_app_role_settings(p_app_id text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare allowed text[]:=public.app_assignable_roles(p_app_id);
begin
 if not public.can_manage_app_settings() then raise exception 'Administrator settings access required' using errcode='42501';end if;
 if allowed is null then raise exception 'Unknown application' using errcode='22023';end if;
 return jsonb_build_object(
 'roles',(select jsonb_agg(jsonb_build_object('id',r.id,'label',case when r.id='sales' then 'Sales consultant' else r.label end) order by array_position(allowed,r.id))
   from public.roles r where r.id=any(allowed)),
 'users',(select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('assigned_role',(
   select r.role_id from public.profile_roles r where r.profile_id=a.profile_id and r.role_id=any(allowed)
   order by array_position(allowed,r.role_id) limit 1)) order by lower(coalesce(a.display_name,a.email,'')),a.profile_id),'[]'::jsonb)
   from public.admin_list_app_access(p_app_id) a));
end$$;

create function public.admin_set_app_role(p_profile_id uuid,p_app_id text,p_role_id text)
returns boolean language plpgsql security definer set search_path='' as $$
declare allowed text[]:=public.app_assignable_roles(p_app_id);previous text[];old_role text;selected text:=nullif(p_role_id,'');
begin
 if not public.can_manage_app_settings() then raise exception 'Administrator settings access required' using errcode='42501';end if;
 if allowed is null or (selected is not null and not selected=any(allowed)) then
   raise exception 'Choose a role belonging to this application' using errcode='22023';end if;
 perform 1 from public.profiles where id=p_profile_id and active for update;
 if not found then raise exception 'Active employee not found' using errcode='P0002';end if;
 select coalesce(array_agg(role_id order by role_id),'{}'::text[]) into previous
   from public.profile_roles where profile_id=p_profile_id and role_id=any(allowed);
 if previous=(case when selected is null then '{}'::text[] else array[selected] end) then return false;end if;
 foreach old_role in array previous loop
   if old_role is distinct from selected then
     delete from public.profile_roles where profile_id=p_profile_id and role_id=old_role;
     insert into public.admin_app_access_audit(actor_user_id,profile_id,app_id,role_id,action)
     values(auth.uid(),p_profile_id,p_app_id,old_role,'revoke');
   end if;
 end loop;
 if selected is not null and not selected=any(previous) then
   insert into public.profile_roles(profile_id,role_id) values(p_profile_id,selected);
   insert into public.admin_app_access_audit(actor_user_id,profile_id,app_id,role_id,action)
   values(auth.uid(),p_profile_id,p_app_id,selected,'grant');
 end if;
 return true;
end$$;
revoke all on function public.admin_app_role_settings(text),public.admin_set_app_role(uuid,text,text) from public,anon;
grant execute on function public.admin_app_role_settings(text),public.admin_set_app_role(uuid,text,text) to authenticated;
