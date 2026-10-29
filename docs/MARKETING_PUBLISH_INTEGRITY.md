# Marketing publishing integrity rollout

Apply migration `0093_marketing_publish_integrity.sql` before serving the updated Marketing handlers. GitHub/Vercel deployment does not apply Supabase migrations automatically. No new environment variables are needed.

If migration 0093 reports duplicate Facebook identities, reconcile those records first. It intentionally preserves all rows rather than guessing which title, campaign assignment or owner should survive. Find conflicts with:

```sql
select provider_ids->>'facebook' as facebook_id, array_agg(id) as post_ids
from public.posts
where nullif(provider_ids->>'facebook','') is not null
group by provider_ids->>'facebook' having count(*) > 1;
```

Both publishers atomically claim the current row before contacting Facebook. Requests have a 20-second timeout. A definitive provider rejection may become `failed`; timeouts, uncertain responses and failed receipt saves become `publish_unknown`. Neither manual publishing nor cron retries unknown outcomes. The cron quarantines `publishing` attempts older than ten minutes, including unfinished attempts from the previous deployment. Run the authenticated scheduler after rollout to recover those attempts promptly.

There is no distributed transaction between Facebook and Supabase. An administrator must check the Page before resolving an unknown outcome through trusted server/database access. If the post exists, link its canonical Page post ID and mark it published; if sync already imported it, reconcile the two local rows and preserve campaign/title/ownership before assigning the identity. Only reset an attempt to failed after verifying it was not published. Do not reset unknown outcomes automatically.

Browser writes cannot change lifecycle, provider IDs, metrics, owner or existing identity fields. Content edits are restricted to draft/awaiting-approval/failed posts without a Facebook receipt; locked posts retain permission-checked campaign reassignment. The frontend uses `save_marketing_post` to validate and save content/scheduling atomically. Only service-role calls can invoke `sync_facebook_post`; it serializes each provider identity and preserves local title, campaign, owner and other provider IDs.

Verification: run frontend tests, the frontend production build, and `supabase test db` against a migrated local stack. Database regression tests cover identity uniqueness, sync preservation, protected fields and scheduling. Publisher tests cover competing claims, canonical photo IDs, timeouts, provider rejection, failed receipt persistence and stable media identity.
