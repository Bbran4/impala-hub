import type {SupabaseClient} from '@supabase/supabase-js'

// Reporting workspace data. The bi schema is not exposed to browsers; everything goes
// through the role-checked public.bi_* functions (migration 0046_bi_reporting.sql).

export type LoadStatus='running'|'success'|'error'|null
export type DataColumn={name:string;type:string}
export type DataTable={
  table_name:string;description:string|null;group_name:string|null;columns:DataColumn[]
  row_count:number|null;last_loaded_at:string|null;last_status:LoadStatus;interval_minutes:number|null
  source?:'erp'|'upload'|'web'|'folder'|'sharepoint'|'gsheet'|'other'|null
}
export type BiAgent={name:string;sources:string[];app_requests:Record<string,string[]>;version:string|null;hostname:string|null;started_at:string|null;last_seen_at:string|null}
export type BiGroup={
  name:string;description:string|null;interval_minutes:number|null;managed_by:string;enabled:boolean
  reload_requested:boolean;full_reload_requested:boolean;last_run_at:string|null;last_status:LoadStatus;last_error:string|null
}
export type BiJob={
  id:number;target_table:string;description:string|null;source_name:string;group_name:string|null;sql_query:string
  load_mode:'full'|'append'|'upsert';key_columns:string[];incremental_column:string|null;watermark:string|null
  interval_minutes:number|null;managed_by:string;enabled:boolean;reload_requested:boolean;full_reload_requested:boolean
  last_run_at:string|null;last_status:LoadStatus;last_error:string|null;last_row_count:number|null
  row_count:number|null;last_loaded_at:string|null;applied_at:string|null;applied_by:string|null
}
export type LoadStatusSnapshot={server_time:string;agents:BiAgent[];groups:BiGroup[];jobs:BiJob[]}
export type SyncRun={
  id:number;batch_id:string;target_table:string;group_name:string|null;agent_name:string|null
  trigger:'schedule'|'manual'|'full_reload';status:'running'|'success'|'error'
  started_at:string;finished_at:string|null;row_count:number|null;error:string|null
}
export type AuditEntry={id:number;at:string;actor:string;action:string;object_type:string;object_name:string;details:Record<string,unknown>}
export type LoadUnit={kind:'group'|'table';name:string;description:string|null;interval_minutes:number|null;enabled:boolean
  pending:'reload'|'full'|null;last_run_at:string|null;last_status:LoadStatus;last_error:string|null;jobs:BiJob[]}

export const AGENT_ONLINE_SECONDS=120

function fail(error:{message:string}|null){if(error)throw new Error(error.message)}

export async function loadDataTables(client:SupabaseClient){
  const {data,error}=await client.rpc('bi_data_tables');fail(error)
  return (data||[]) as DataTable[]
}
export async function loadLoadStatus(client:SupabaseClient){
  const {data,error}=await client.rpc('bi_load_status');fail(error)
  return data as LoadStatusSnapshot
}
export async function loadSyncRuns(client:SupabaseClient,table:string|null=null,limit=200){
  const {data,error}=await client.rpc('bi_sync_runs',{p_limit:limit,p_table:table});fail(error)
  return (data||[]) as SyncRun[]
}
export async function loadAuditLog(client:SupabaseClient,limit=200){
  const {data,error}=await client.rpc('bi_audit_log',{p_limit:limit});fail(error)
  return (data||[]) as AuditEntry[]
}
export async function requestReload(client:SupabaseClient,kind:'group'|'table',name:string,full:boolean){
  const {error}=await client.rpc('bi_request_reload',{p_kind:kind,p_name:name,p_full:full});fail(error)
}
export async function setLoadEnabled(client:SupabaseClient,kind:'group'|'table',name:string,enabled:boolean){
  const {error}=await client.rpc('bi_set_enabled',{p_kind:kind,p_name:name,p_enabled:enabled});fail(error)
}
export async function testSourceConnection(client:SupabaseClient,source:string,timeoutMs=30000,pollMs=1500){
  const {data,error}=await client.rpc('bi_test_connection',{p_source:source});fail(error)
  const deadline=Date.now()+timeoutMs
  while(Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,pollMs))
    const result=await client.rpc('bi_agent_request',{p_id:data});fail(result.error)
    const request=result.data as {status:string;result:Record<string,string>|null;error:string|null}|null
    if(request&&request.status==='done')return {ok:true,message:`${request.result?.dbms||'Connected'} ${request.result?.dbms_version||''}`.trim()}
    if(request&&request.status==='error')return {ok:false,message:request.error||'The agent could not connect.'}
  }
  return {ok:false,message:'The agent did not answer. Check that it is running.'}
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

export function isAgentOnline(agent:BiAgent,now:Date){
  return Boolean(agent.last_seen_at)&&now.getTime()-new Date(agent.last_seen_at!).getTime()<=AGENT_ONLINE_SECONDS*1000
}

export function scheduleLabel(minutes:number|null){
  if(!minutes)return 'Manual only'
  if(minutes%1440===0)return minutes===1440?'Daily':`Every ${minutes/1440} days`
  if(minutes%60===0)return minutes===60?'Hourly':`Every ${minutes/60} hours`
  return `Every ${minutes} min`
}

export function ago(iso:string|null,now:Date){
  if(!iso)return 'Never'
  const seconds=Math.max(0,Math.round((now.getTime()-new Date(iso).getTime())/1000))
  if(seconds<60)return 'Just now'
  const minutes=Math.round(seconds/60);if(minutes<60)return `${minutes} min ago`
  const hours=Math.round(minutes/60);if(hours<48)return `${hours} h ago`
  return `${Math.round(hours/24)} days ago`
}

// Fresh: loaded within 1.5 schedules. Stale: older than that. Manual tables are never stale.
export function freshness(table:{last_loaded_at:string|null;interval_minutes:number|null;last_status:LoadStatus},now:Date):'fresh'|'stale'|'failed'|'never'{
  if(!table.last_loaded_at)return table.last_status==='error'?'failed':'never'
  if(table.last_status==='error')return 'failed'
  if(!table.interval_minutes)return 'fresh'
  const ageMinutes=(now.getTime()-new Date(table.last_loaded_at).getTime())/60000
  return ageMinutes<=table.interval_minutes*1.5?'fresh':'stale'
}

// Groups (with their tables) first, then ungrouped tables, each alphabetical.
export function buildLoadUnits(snapshot:Pick<LoadStatusSnapshot,'groups'|'jobs'>):LoadUnit[]{
  const pending=(item:{reload_requested:boolean;full_reload_requested:boolean}):LoadUnit['pending']=>item.full_reload_requested?'full':item.reload_requested?'reload':null
  const groups=[...snapshot.groups].sort((a,b)=>a.name.localeCompare(b.name)).map(group=>{
    const jobs=snapshot.jobs.filter(job=>job.group_name===group.name).sort((a,b)=>a.target_table.localeCompare(b.target_table))
    const memberPending:LoadUnit['pending']=jobs.some(job=>job.full_reload_requested)?'full':jobs.some(job=>job.reload_requested)?'reload':null
    return {kind:'group' as const,name:group.name,description:group.description,interval_minutes:group.interval_minutes,enabled:group.enabled,
      pending:pending(group)||memberPending,last_run_at:group.last_run_at,last_status:group.last_status,last_error:group.last_error,jobs}
  })
  const singles=snapshot.jobs.filter(job=>!job.group_name).sort((a,b)=>a.target_table.localeCompare(b.target_table)).map(job=>({
    kind:'table' as const,name:job.target_table,description:job.description,interval_minutes:job.interval_minutes,enabled:job.enabled,
    pending:pending(job),last_run_at:job.last_run_at,last_status:job.last_status,last_error:job.last_error,jobs:[job]}))
  return [...groups,...singles]
}

export function summarizeLoads(units:LoadUnit[]){
  return {
    tables:units.reduce((total,unit)=>total+unit.jobs.length,0),
    failing:units.filter(unit=>unit.last_status==='error').length,
    paused:units.filter(unit=>!unit.enabled).length,
    running:units.filter(unit=>unit.last_status==='running').length,
  }
}

export function runDuration(run:Pick<SyncRun,'started_at'|'finished_at'>){
  if(!run.finished_at)return '—'
  const seconds=(new Date(run.finished_at).getTime()-new Date(run.started_at).getTime())/1000
  if(seconds<1)return '<1s'
  if(seconds<90)return `${Math.round(seconds)}s`
  return `${Math.floor(seconds/60)}m ${Math.round(seconds%60)}s`
}

export function filterDataTables(tables:DataTable[],search:string){
  const needle=search.trim().toLowerCase()
  if(!needle)return tables
  return tables.filter(table=>[table.table_name,table.description||'',table.group_name||'',...table.columns.map(column=>column.name)].join(' ').toLowerCase().includes(needle))
}

export const AUDIT_LABELS:Record<string,string>={
  add:'Added',change:'Changed',remove:'Removed',reload_requested:'Reload requested',full_reload_requested:'Full reload requested',paused:'Paused',resumed:'Resumed',
}
