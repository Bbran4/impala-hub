-- Distinct from connection health checks and individual post metric refreshes.
alter table public.provider_connections add column last_synced_at timestamptz;
