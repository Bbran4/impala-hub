-- Reporting batch 5: more data connectors run by the agent.
--   * sharepoint: an Excel/CSV file in a SharePoint document library or a OneDrive, read through Microsoft Graph with
--     the agent's own app registration. The app only names a location the agent's config.toml lists.
--   * gsheet: a tab of a Google Sheet, read with the agent's Google service account (the sheet must be shared with it).
--   A second database needs nothing here: it is another [sources.x] ODBC source in the agent's config.toml and tables.toml.
-- Migration numbering: Reporting uses even numbers (see supabase/README.md).

alter table bi.connectors drop constraint connectors_kind_check;
alter table bi.connectors add constraint connectors_kind_check check (kind in ('upload', 'web', 'folder', 'sharepoint', 'gsheet'));

-- Create or change a connector the agent runs. p = {name, kind, description, agent_name, config, interval_minutes, enabled}
create or replace function public.bi_save_connector(p jsonb)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  k text := p->>'kind';
  cfg jsonb := coalesce(p->'config', '{}');
  h jsonb;
  is_new boolean;
begin
  perform bi.require_admin();
  if k not in ('web', 'folder', 'sharepoint', 'gsheet') then
    raise exception 'Only web, folder, SharePoint/OneDrive and Google Sheets connectors are saved here; upload a file for an upload' using errcode = '22023';
  end if;
  perform bi.check_connector_name(p->>'name', k);
  if coalesce(p->>'agent_name', '') = '' then raise exception 'Choose the agent that runs this connector' using errcode = '22023'; end if;
  if jsonb_typeof(cfg) <> 'object' or pg_column_size(cfg) > 20000 then raise exception 'Invalid connector settings' using errcode = '22023'; end if;
  if (p->>'interval_minutes') is not null and (p->>'interval_minutes')::int < 5 then
    raise exception 'The schedule must be at least every 5 minutes' using errcode = '22023';
  end if;
  if k = 'web' then
    if coalesce(cfg->>'url', '') !~ '^https?://[^\s/$.?#][^\s]*$' or length(cfg->>'url') > 2000 then
      raise exception 'Enter a web address starting with https://' using errcode = '22023';
    end if;
    if coalesce(cfg->>'format', 'json') not in ('json', 'csv') then raise exception 'Format must be json or csv' using errcode = '22023'; end if;
    if jsonb_typeof(coalesce(cfg->'headers', '[]')) <> 'array' or jsonb_array_length(coalesce(cfg->'headers', '[]')) > 10 then
      raise exception 'At most 10 headers' using errcode = '22023';
    end if;
    for h in select * from jsonb_array_elements(coalesce(cfg->'headers', '[]')) loop
      if coalesce(h->>'name', '') !~ '^[A-Za-z0-9-]{1,64}$' or length(coalesce(h->>'value', '')) > 1000 then
        raise exception 'Invalid header "%"', h->>'name' using errcode = '22023';
      end if;
    end loop;
    if length(coalesce(cfg->>'records_path', '')) > 200 then raise exception 'The records path is too long' using errcode = '22023'; end if;
  elsif k = 'sharepoint' then
    -- location: a name from [connectors.sharepoint] in the agent's config.toml; path: the file in that library or OneDrive,
    -- with * or ? allowed in the file name only (newest match, or all combined)
    if coalesce(cfg->>'location', '') !~ '^[a-z][a-z0-9_]{0,62}$' then raise exception 'Choose one of the agent''s SharePoint or OneDrive locations' using errcode = '22023'; end if;
    if length(coalesce(cfg->>'path', '')) not between 1 and 400 or (cfg->>'path') !~ '^[^\\:<>|"]+$' or (cfg->>'path') ~ '(^|/)\.\.(/|$)' or (cfg->>'path') ~ '[*?].*/'
       or (cfg->>'path') !~* '\.(xlsx|xlsm|csv|txt)$' then
      raise exception 'Enter the path of an .xlsx or .csv file in the library, e.g. Budgets/Budget 2026.xlsx (wildcards only in the file name)' using errcode = '22023';
    end if;
    if coalesce(cfg->>'combine', 'latest') not in ('latest', 'all') then raise exception 'Combine must be latest or all' using errcode = '22023'; end if;
    if length(coalesce(cfg->>'sheet', '')) > 100 then raise exception 'The sheet name is too long' using errcode = '22023'; end if;
  elsif k = 'gsheet' then
    if coalesce(cfg->>'spreadsheet_id', '') !~ '^[A-Za-z0-9_-]{20,100}$' then
      raise exception 'Paste the Google Sheets link or its ID (the long code between /d/ and /edit)' using errcode = '22023';
    end if;
    if length(coalesce(cfg->>'sheet', '')) > 100 or coalesce(cfg->>'sheet', '') ~ '[''!]' then raise exception 'Invalid tab name' using errcode = '22023'; end if;
    if coalesce(cfg->>'range', '') !~ '^([A-Z]{1,3}[0-9]{0,7}:[A-Z]{1,3}[0-9]{0,7})?$' then raise exception 'The range must look like A1:H500 or A:H' using errcode = '22023'; end if;
  else
    if coalesce(cfg->>'folder', '') !~ '^[a-z][a-z0-9_]{0,62}$' then raise exception 'Choose one of the agent''s folders' using errcode = '22023'; end if;
    if coalesce(cfg->>'pattern', '') !~ '^[A-Za-z0-9 _.*?()-]{1,100}$' then
      raise exception 'The file pattern may use letters, digits, spaces, . _ - ( ) and the wildcards * and ?' using errcode = '22023';
    end if;
    if coalesce(cfg->>'combine', 'latest') not in ('latest', 'all') then raise exception 'Combine must be latest or all' using errcode = '22023'; end if;
    if length(coalesce(cfg->>'sheet', '')) > 100 then raise exception 'The sheet name is too long' using errcode = '22023'; end if;
  end if;

  is_new := not exists (select 1 from bi.connectors c where c.name = p->>'name');
  insert into bi.connectors (name, kind, description, agent_name, config, interval_minutes, enabled, reload_requested, created_by, updated_by)
  values (p->>'name', k, coalesce(p->>'description', ''), p->>'agent_name', cfg, (p->>'interval_minutes')::int,
          coalesce((p->>'enabled')::boolean, true), true, auth.uid(), auth.uid())
  on conflict (name) do update set description = excluded.description, agent_name = excluded.agent_name, config = excluded.config,
    interval_minutes = excluded.interval_minutes, enabled = excluded.enabled, reload_requested = true, updated_by = auth.uid();
  insert into bi.audit_log (actor, actor_id, action, object_type, object_name, details)
  values (bi.app_actor(), auth.uid(), case when is_new then 'add' else 'change' end, 'connector', p->>'name',
          jsonb_build_object('kind', k, 'agent', p->>'agent_name', 'config', cfg - 'headers',
                             'headers', (select jsonb_agg(x->>'name') from jsonb_array_elements(coalesce(cfg->'headers', '[]')) x)));
end;
$$;


-- bi_reload_connector already accepts every kind except uploads.
