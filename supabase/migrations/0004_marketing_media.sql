insert into storage.buckets (id, name, public)
values ('marketing-media', 'marketing-media', true)
on conflict (id) do update set public = true;

create policy "authenticated users upload marketing media"
on storage.objects for insert to authenticated
with check (bucket_id = 'marketing-media' and public.is_active_user());

create policy "authenticated users update marketing media"
on storage.objects for update to authenticated
using (bucket_id = 'marketing-media' and public.is_active_user())
with check (bucket_id = 'marketing-media' and public.is_active_user());

create policy "authenticated users delete marketing media"
on storage.objects for delete to authenticated
using (bucket_id = 'marketing-media' and public.is_active_user());
