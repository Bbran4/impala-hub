alter table public.posts drop constraint if exists posts_status_check;
alter table public.posts add constraint posts_status_check check (status in ('draft', 'awaiting_approval', 'scheduled', 'publishing', 'published', 'failed'));
create index if not exists posts_due_schedule_idx on public.posts (status, publish_at) where status = 'scheduled';
