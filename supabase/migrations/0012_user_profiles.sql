alter table public.profiles add column if not exists first_name text not null default '';
alter table public.profiles add column if not exists surname text not null default '';
alter table public.profiles add column if not exists avatar_url text;

insert into storage.buckets (id, name, public) values ('profile-avatars', 'profile-avatars', true)
on conflict (id) do update set public = true;
create policy "users upload own avatar" on storage.objects for insert to authenticated
with check (bucket_id = 'profile-avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "users update own avatar" on storage.objects for update to authenticated
using (bucket_id = 'profile-avatars' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'profile-avatars' and (storage.foldername(name))[1] = auth.uid()::text);
