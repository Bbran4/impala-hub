insert into storage.buckets (id,name,public) values ('returns-claim-attachments','returns-claim-attachments',false) on conflict (id) do update set public=false;
create table if not exists public.returns_claim_attachments (
  id uuid primary key default gen_random_uuid(), claim_id uuid not null references public.returns_claims(id) on delete restrict,
  original_name text not null, storage_path text not null unique, content_type text not null, size integer not null,
  uploaded_by uuid not null references auth.users(id), created_at timestamptz not null default now()
);
alter table public.returns_claim_attachments enable row level security;
create policy "returns users read attachments" on public.returns_claim_attachments for select to authenticated using (public.is_active_user() and (public.has_role('administrator') or public.has_role('management') or public.has_role('returns')));
create policy "returns users insert attachments" on public.returns_claim_attachments for insert to authenticated with check (public.is_active_user() and uploaded_by=auth.uid() and (public.has_role('administrator') or public.has_role('management') or public.has_role('returns')));
grant select, insert on public.returns_claim_attachments to authenticated;
create policy "returns users upload files" on storage.objects for insert to authenticated with check (bucket_id='returns-claim-attachments' and public.is_active_user() and (public.has_role('administrator') or public.has_role('management') or public.has_role('returns')));
create policy "returns users read files" on storage.objects for select to authenticated using (bucket_id='returns-claim-attachments' and public.is_active_user() and (public.has_role('administrator') or public.has_role('management') or public.has_role('returns')));
