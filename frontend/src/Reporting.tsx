import {Fragment,useCallback,useEffect,useMemo,useState} from 'react'
import {ChevronDown,ChevronRight,Database,History,Pause,Play,PlugZap,RefreshCw,RotateCcw,Search,ServerCog,ShieldCheck} from 'lucide-react'
import {supabase} from './supabase'
import {
  AUDIT_LABELS,ago,buildLoadUnits,filterDataTables,freshness,isAgentOnline,loadAuditLog,loadDataTables,loadLoadStatus,
  loadSyncRuns,requestReload,runDuration,scheduleLabel,setLoadEnabled,summarizeLoads,testSourceConnection,
  type AuditEntry,type DataTable,type LoadStatusSnapshot,type LoadUnit,type SyncRun,
} from './reportingData'
import ReportingApps from './ReportingApps'
import DataConnections from './biConnections'
import {DataModelPage} from './biModelViewer'
import {FunctionReference} from './biExpressionEditor'
import {DataQualityPage,LibraryPage,UsagePage} from './biCollab'
import './reporting.css'

type Props={page:string;isAdministrator:boolean;canBuild:boolean;setNotice:(message:string)=>void;setError:(message:string)=>void}

export const REPORTING_PAGES=['Dashboards','Data','Data Model','Data Connections','Data Loads','Run History','Audit Log','Data Quality','Usage','Master Items','Function Reference','Reporting Roadmap'] as const
export const REPORTING_BUILDER_PAGES=['Usage','Master Items']
export const REPORTING_ADMIN_PAGES=['Data Connections','Data Loads','Run History','Audit Log']

const REPORTING_ROADMAP_ROWS=[
  ['Data loader','Qlik load script','On-premises sync agent: any ODBC source, full/upsert/append, incremental watermarks, grouped transactional loads','Implemented'],
  ['Load definitions','Qlik data load editor','tables.toml on the agent machine with validate, dry-run test, plan and apply; fingerprint-checked','Implemented'],
  ['Load monitoring','Qlik reload tasks','Agent heartbeat, load status, Reload now, Reload everything, pause/resume, run history and audit log','Implemented'],
  ['Data model viewer','Qlik data model viewer','Diagram of all loaded tables (fields with the same name) or of an app\'s links; drag tables, follow a field','Implemented'],
  ['Data connections','Qlik data connections (non-ERP)','Excel/CSV upload in the browser; web APIs and folder files fetched by the agent within its config.toml allowlists','Implemented'],
  ['Data catalogue','Qlik data catalogue','Loaded tables, columns, row counts and freshness for Reporting users','Implemented'],
  ['Apps and data models','Qlik apps and associative model','Apps choose loaded tables and link them on matching fields; queries join only what each chart needs','Implemented'],
  ['Sheets and charts','Qlik sheets','Drag-and-resize sheets with 22 object types: bar, line, combo, pie, KPI, gauge, scatter, treemap, waterfall, funnel, bullet, radar, mekko, grid, histogram, box plot, distribution, word cloud, table, pivot, filter pane, text; drag to reorder dimensions, measures and table columns','Implemented'],
  ['Expressions','Qlik chart expressions','70+ functions (aggregation, text, number, date, logic), & concatenation, comments, master measures and row conditions; large editor with search and Test','Implemented'],
  ['Conditional colours','Qlik background/text colour expressions','Per-column colour expressions in tables and pivots: If(), RGB(), ColorMix1()','Implemented'],
  ['Associative data model','Qlik associations (no main table)','Tables link on key fields both ways; charts join only what they need and keep unmatched records','Implemented'],
  ['Variables and controls','Qlik variables, variable input, slider, date picker, button, navigation','App variables used as $(name) in expressions and titles; controls change them per viewer','Implemented'],
  ['Containers and media','Qlik tab, layout and trellis containers; image, text & image, line, video','Objects grouped in tabs or side by side, one chart repeated per value, pictures and videos','Implemented'],
  ['Visualization bundle','Qlik P&L pivot, variance waterfall, Sankey, network, org chart, map, animator, NL insights','All available; insights are calculated from the data (no AI service); the map places points by latitude/longitude on OpenStreetMap','Implemented'],
  ['Write table','Qlik write table','Editable text, number and choice columns saved per row for everyone (optionally builders only)','Implemented'],
  ['Selections','Qlik associative selections','Click any value to filter every object in the app; Ctrl+click to add; selections bar','Implemented'],
  ['Function reference','Qlik help: chart functions','Searchable in-app reference and docs/REPORTING_FUNCTIONS.md, generated from the same list the editor and database use','Implemented'],
  ['App access','Qlik spaces','Apps shared with roles or named people; builders are administrators and report builders','Implemented'],
  ['Set analysis and Aggr','Qlik set analysis, Aggr(), Above()/RangeSum()','Sets ({1}, {<field={…}>}, +=/-=/*=, searches, $(=…)), Aggr() and chart functions for running totals and comparisons','Implemented'],
  ['Calculated fields','Qlik load-script fields','Per-row expressions on a table in the app model, used like loaded fields','Implemented'],
  ['Drill-down, compare, pivot totals','Qlik drill-down groups, alternate states, pivot totals','Drill-down dimensions with a path; Compare A/B objects with their own selections; pivot totals and collapsible subtotals','Implemented'],
  ['Bookmarks and smart search','Qlik bookmarks, smart search','Personal or shared bookmarks (selections, compare states, variables, sheet); search every text field and click to select','Implemented'],
  ['Exports, favourites, phones','Qlik export to Excel/PDF, favourites, mobile','Sheet to PDF (print) or Excel (one tab per chart), table to Excel; favourite sheets and recently opened on the Reporting home; phone layout','Implemented'],
  ['Alerts, subscriptions, filtered emails','Qlik alerting, NPrinting filters and subscriptions','Report emails with a bookmark/conditions filter and Excel; alerts only when a measure meets a condition; Email me subscriptions and opting out','Implemented'],
  ['Comments','Qlik notes and comments','Comment on any chart; threads can be resolved and the others in a thread are notified in the Hub','Implemented'],
  ['Version history','Qlik app versions (publish/duplicate)','Earlier versions of each sheet and of the app settings, restore (also deleted sheets); copy an app with or without its access','Implemented'],
  ['Master item library','Qlik master items shared across apps','Library of measures and dimensions for every app; add to or save from an app','Implemented'],
  ['Usage and data quality','Qlik monitoring apps','Which apps and sheets are opened, by whom and per day; tables with failed or late loads, dropped row counts and always-empty fields','Implemented'],
  ['Stock history','Qlik QVD snapshots','Keep daily stock levels over time (only changes stored, about 150–200 MB a year)','Planned'],
  ['Row-level access','Qlik section access','Per app: users or roles see only rows where a field has their values (e.g. own branch); enforced in the database for every query','Implemented'],
  ['Scheduled emails','Qlik NPrinting','Chosen sheets as picture + PDF to roles or people, daily/weekdays/weekly/monthly, each drawn with the recipient’s row access','Implemented'],
  ['Smart Stock feed','ERP stock snapshots','Feed Smart Stock imports from the ERP through the sync agent','Planned'],
]

const SOURCE_LABEL={erp:'ERP',upload:'Upload',web:'Web API',folder:'Folder',other:'—'}
const STATUS_LABEL={success:'Loaded',error:'Failed',running:'Loading…'}
const FRESHNESS_LABEL={fresh:'Up to date',stale:'Out of date',failed:'Last load failed',never:'Not loaded yet'}
const count=(value:number|null|undefined)=>value==null?'—':Number(value).toLocaleString()
const when=(iso:string|null)=>iso?new Date(iso).toLocaleString():'—'

function usePolling(load:()=>Promise<void>,intervalMs:number){
  useEffect(()=>{
    void load()
    const timer=setInterval(()=>{if(document.visibilityState==='visible')void load()},intervalMs)
    const onVisible=()=>{if(document.visibilityState==='visible')void load()}
    document.addEventListener('visibilitychange',onVisible)
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',onVisible)}
  },[load,intervalMs])
}

export default function Reporting({page,isAdministrator,canBuild,setNotice,setError}:Props){
  if(REPORTING_ADMIN_PAGES.includes(page)&&!isAdministrator)return <section className="rfq-workspace"><div className="rfq-empty-card"><ShieldCheck size={26}/><h3>Administrators only</h3><p>The data loader is managed by administrators.</p></div></section>
  if(REPORTING_BUILDER_PAGES.includes(page)&&!canBuild)return <section className="rfq-workspace"><div className="rfq-empty-card"><ShieldCheck size={26}/><h3>Report builders only</h3><p>Ask an administrator for the report builder role.</p></div></section>
  if(!supabase)return <section className="rfq-workspace"><div className="rfq-empty-card"><Database size={26}/><h3>Supabase is not configured</h3><p>Reporting needs the Supabase connection.</p></div></section>
  if(page==='Dashboards')return <ReportingApps canBuild={canBuild} setNotice={setNotice} setError={setError}/>
  if(page==='Data Model')return <DataModelPage setError={setError}/>
  if(page==='Data Connections')return <DataConnections setNotice={setNotice} setError={setError}/>
  if(page==='Data Loads')return <DataLoads setNotice={setNotice} setError={setError}/>
  if(page==='Run History')return <RunHistory setError={setError}/>
  if(page==='Audit Log')return <AuditLog setError={setError}/>
  if(page==='Data Quality')return <DataQualityPage setError={setError}/>
  if(page==='Usage')return <UsagePage setError={setError}/>
  if(page==='Master Items')return <LibraryPage setNotice={setNotice} setError={setError}/>
  if(page==='Function Reference')return <FunctionReference/>
  if(page==='Reporting Roadmap')return <ReportingRoadmap/>
  return <DataCatalogue setError={setError}/>
}

// ---------------------------------------------------------------------------
// Data: what is loaded and how fresh it is (all Reporting users)
// ---------------------------------------------------------------------------
function DataCatalogue({setError}:{setError:(message:string)=>void}){
  const [tables,setTables]=useState<DataTable[]>([]);const [busy,setBusy]=useState(true);const [search,setSearch]=useState('')
  const [open,setOpen]=useState<string|null>(null);const [now,setNow]=useState(new Date());const [loaded,setLoaded]=useState(false)
  const load=useCallback(async()=>{
    try{setTables(await loadDataTables(supabase!));setNow(new Date());setLoaded(true);setError('')}
    catch(error){setError((error as Error).message)}finally{setBusy(false)}
  },[setError])
  usePolling(load,30000)
  const visible=useMemo(()=>filterDataTables(tables,search),[tables,search])
  const states=tables.map(table=>freshness(table,now))
  const latest=tables.reduce<string|null>((max,table)=>table.last_loaded_at&&(!max||table.last_loaded_at>max)?table.last_loaded_at:max,null)
  return <section className="rfq-workspace">
    <div className="sd-session-bar"><Database size={18}/><span>Reporting workspace</span><small className="rp-live">Updates automatically · last checked {now.toLocaleTimeString()}</small></div>
    <div className="sd-metrics">
      <div className="sd-metric"><span>Tables</span><strong>{tables.length}</strong></div>
      <div className="sd-metric"><span>Up to date</span><strong>{states.filter(state=>state==='fresh').length}</strong></div>
      <div className="sd-metric"><span>Need attention</span><strong>{states.filter(state=>state==='stale'||state==='failed').length}</strong></div>
      <div className="sd-metric"><span>Last load</span><strong className="rp-metric-text">{ago(latest,now)}</strong></div>
    </div>
    <div className="rp-toolbar"><label className="rp-search"><Search size={15}/><input placeholder="Search tables, descriptions or columns" value={search} onChange={event=>setSearch(event.target.value)}/></label><button className="secondary" disabled={busy} onClick={()=>{setBusy(true);void load()}}><RefreshCw size={15}/>{busy?'Loading…':'Refresh'}</button></div>
    <div className="rfq-table-wrap"><table className="rfq-table"><thead><tr><th/><th>Table</th><th>Status</th><th>Rows</th><th>Last loaded</th><th>Schedule</th><th>From</th></tr></thead><tbody>
      {visible.map(table=>{const state=freshness(table,now);const expanded=open===table.table_name;return <Fragment key={table.table_name}>
        <tr className="rfq-data-row rp-click" onClick={()=>setOpen(expanded?null:table.table_name)}>
          <td className="rp-chevron">{expanded?<ChevronDown size={15}/>:<ChevronRight size={15}/>}</td>
          <td><b>{table.table_name}</b>{table.description&&<small className="rp-sub">{table.description}</small>}</td>
          <td><span className={`rp-badge ${state}`}>{FRESHNESS_LABEL[state]}</span></td>
          <td>{count(table.row_count)}</td>
          <td title={when(table.last_loaded_at)}>{ago(table.last_loaded_at,now)}</td>
          <td>{scheduleLabel(table.interval_minutes)}</td>
          <td>{SOURCE_LABEL[table.source||'other']}{table.group_name&&<small className="rp-sub">group {table.group_name}</small>}</td>
        </tr>
        {expanded&&<tr className="rp-detail-row"><td colSpan={7}><div className="rp-columns">{table.columns.map(column=><span key={column.name}><b>{column.name}</b><small>{column.type}</small></span>)}</div></td></tr>}
      </Fragment>})}
      {!visible.length&&<tr><td colSpan={7}><div className="rfq-empty"><Database size={28}/><h3>{loaded&&tables.length?'No matching tables':'No data loaded yet'}</h3><p>{loaded&&tables.length?'Try a different search.':'Tables appear here once the Impala BI sync agent has loaded them from the ERP.'}</p></div></td></tr>}
    </tbody></table></div>
  </section>
}

// ---------------------------------------------------------------------------
// Data Loads: agent, groups and tables with controls (administrators)
// ---------------------------------------------------------------------------
function DataLoads({setNotice,setError}:{setNotice:(message:string)=>void;setError:(message:string)=>void}){
  const [status,setStatus]=useState<LoadStatusSnapshot|null>(null);const [busy,setBusy]=useState(true);const [acting,setActing]=useState('')
  const [open,setOpen]=useState<string|null>(null);const [testing,setTesting]=useState('');const [tests,setTests]=useState<Record<string,{ok:boolean;message:string}>>({})
  const load=useCallback(async()=>{
    try{setStatus(await loadLoadStatus(supabase!));setError('')}
    catch(error){setError((error as Error).message)}finally{setBusy(false)}
  },[setError])
  usePolling(load,10000)
  const now=status?new Date(status.server_time):new Date()
  const units=useMemo(()=>status?buildLoadUnits(status):[],[status])
  const summary=summarizeLoads(units)

  async function act(unit:LoadUnit,action:'reload'|'full'|'pause'|'resume'){
    const label=unit.kind==='group'?`group ${unit.name} (${unit.jobs.length} tables)`:`table ${unit.name}`
    if(action==='full'&&!confirm(`Reload everything for ${label}?\n\nThe table${unit.jobs.length>1?'s are':' is'} emptied and loaded again from the start. Use this after rows were deleted in the ERP.`))return
    setActing(`${unit.kind}:${unit.name}`)
    try{
      if(action==='reload'||action==='full')await requestReload(supabase!,unit.kind,unit.name,action==='full')
      else await setLoadEnabled(supabase!,unit.kind,unit.name,action==='resume')
      setNotice(action==='pause'?`Paused the schedule for ${label}.`:action==='resume'?`Resumed the schedule for ${label}.`:`Requested ${action==='full'?'a full reload':'a reload'} of ${label}. The agent picks it up within seconds.`)
      await load()
    }catch(error){setError((error as Error).message)}finally{setActing('')}
  }
  async function testSource(source:string){
    setTesting(source)
    try{const result=await testSourceConnection(supabase!,source);setTests(current=>({...current,[source]:result}))}
    catch(error){setError((error as Error).message)}finally{setTesting('')}
  }

  return <section className="rfq-workspace">
    <div className="sd-session-bar"><ServerCog size={18}/><span>Data loader</span><small className="rp-live">Updates every 10 seconds</small><button className="secondary" disabled={busy} onClick={()=>{setBusy(true);void load()}}><RefreshCw size={15}/>Refresh</button></div>

    {status&&!status.agents.length&&<div className="security-note"><PlugZap size={20}/><div><b>No sync agent has connected yet</b><p>Install the Impala BI sync agent on a machine that can reach the ERP and run <code>--apply</code> (see bi-agent/README.md). It appears here once it is running.</p></div></div>}
    {status&&status.agents.length>0&&<div className="rp-agents">{status.agents.map(agent=>{const online=isAgentOnline(agent,now);return <div className="rp-agent" key={agent.name}>
      <div className="rp-agent-head"><span className={`rp-dot ${online?'online':'offline'}`}/><b>{agent.name}</b><span className={`rp-badge ${online?'fresh':'failed'}`}>{online?'Online':'Offline'}</span></div>
      <small>{agent.hostname||'Unknown host'} · version {agent.version||'?'} · last seen {ago(agent.last_seen_at,now)}</small>
      <div className="rp-sources">{agent.sources.map(source=><span key={source} className="rp-source"><b>{source}</b>
        <button className="secondary" disabled={!online||testing===source} onClick={()=>void testSource(source)}><PlugZap size={13}/>{testing===source?'Testing…':'Test connection'}</button>
        {tests[source]&&<small className={tests[source].ok?'rp-ok':'rp-fail'}>{tests[source].message}</small>}
      </span>)}</div>
    </div>})}</div>}

    <div className="sd-metrics">
      <div className="sd-metric"><span>Tables</span><strong>{summary.tables}</strong></div>
      <div className="sd-metric"><span>Failing</span><strong className={summary.failing?'rp-fail':''}>{summary.failing}</strong></div>
      <div className="sd-metric"><span>Paused</span><strong>{summary.paused}</strong></div>
      <div className="sd-metric"><span>Loading now</span><strong>{summary.running}</strong></div>
    </div>

    <div className="rfq-table-wrap"><table className="rfq-table rp-loads"><thead><tr><th/><th>Group / table</th><th>Status</th><th>Schedule</th><th>Last run</th><th>Rows</th><th>Actions</th></tr></thead><tbody>
      {units.map(unit=>{const key=`${unit.kind}:${unit.name}`;const expanded=open===key;const rows=unit.jobs.reduce((total,job)=>total+(job.row_count||0),0)
        return <Fragment key={key}>
          <tr className={`rfq-data-row ${unit.last_status==='error'?'rp-row-error':''}`}>
            <td className="rp-chevron rp-click" onClick={()=>setOpen(expanded?null:key)}>{expanded?<ChevronDown size={15}/>:<ChevronRight size={15}/>}</td>
            <td className="rp-click" onClick={()=>setOpen(expanded?null:key)}><b>{unit.name}</b>{unit.kind==='group'&&<span className="sd-type">Group · {unit.jobs.length} tables</span>}{unit.description&&<small className="rp-sub">{unit.description}</small>}</td>
            <td><span className={`rp-badge ${unit.last_status==='error'?'failed':unit.last_status==='running'?'running':unit.last_status?'fresh':'never'}`}>{unit.last_status?STATUS_LABEL[unit.last_status]:'Not loaded yet'}</span>{unit.pending&&<small className="rp-sub">{unit.pending==='full'?'Full reload queued':'Reload queued'}</small>}</td>
            <td>{unit.enabled?scheduleLabel(unit.interval_minutes):<span className="rp-badge paused">Paused</span>}</td>
            <td title={when(unit.last_run_at)}>{ago(unit.last_run_at,now)}</td>
            <td>{count(rows)}</td>
            <td><div className="row-actions">
              <button className="secondary" title="Load changes now" disabled={acting===key||Boolean(unit.pending)||unit.last_status==='running'} onClick={()=>void act(unit,'reload')}><RefreshCw size={14}/>Reload</button>
              <button className="secondary" title="Empty and reload from the start" disabled={acting===key||unit.pending==='full'||unit.last_status==='running'} onClick={()=>void act(unit,'full')}><RotateCcw size={14}/>Full</button>
              {unit.enabled
                ?<button className="secondary" title="Pause the schedule" disabled={acting===key} onClick={()=>void act(unit,'pause')}><Pause size={14}/>Pause</button>
                :<button className="secondary" title="Resume the schedule" disabled={acting===key} onClick={()=>void act(unit,'resume')}><Play size={14}/>Resume</button>}
            </div></td>
          </tr>
          {unit.last_error&&<tr className="rp-error-row"><td/><td colSpan={6}>{unit.last_error}</td></tr>}
          {expanded&&<tr className="rp-detail-row"><td colSpan={7}>{unit.jobs.map(job=><div className="rp-job" key={job.id}>
            <div className="rp-job-head"><b>{job.target_table}</b><span>{job.load_mode} from {job.source_name}</span>{job.key_columns.length>0&&<span>keys: {job.key_columns.join(', ')}</span>}{job.incremental_column&&<span>incremental on {job.incremental_column} (now {job.watermark||'start'})</span>}<span>{count(job.row_count)} rows</span>{!job.enabled&&<span className="rp-badge paused">Paused</span>}</div>
            {job.last_error&&unit.kind==='group'&&<p className="rp-fail">{job.last_error}</p>}
            <pre className="rp-sql">{job.sql_query}</pre>
            <small className="rp-sub">Defined in tables.toml on agent {job.managed_by}{job.applied_by?` · last applied ${when(job.applied_at)} by ${job.applied_by}`:''}</small>
          </div>)}</td></tr>}
        </Fragment>})}
      {status&&!units.length&&<tr><td colSpan={7}><div className="rfq-empty"><Database size={28}/><h3>No tables defined</h3><p>Add tables to tables.toml on the agent machine, then run <code>run_agent.bat --plan</code> and <code>--apply</code>.</p></div></td></tr>}
    </tbody></table></div>
    <p className="hint">Queries are defined in tables.toml on the agent machine and cannot be changed from the app. Every action here is recorded in the audit log.</p>
  </section>
}

// ---------------------------------------------------------------------------
// Run History (administrators)
// ---------------------------------------------------------------------------
function RunHistory({setError}:{setError:(message:string)=>void}){
  const [runs,setRuns]=useState<SyncRun[]>([]);const [busy,setBusy]=useState(true);const [table,setTable]=useState('');const [onlyFailed,setOnlyFailed]=useState(false);const [tables,setTables]=useState<string[]>([])
  const load=useCallback(async()=>{
    try{const result=await loadSyncRuns(supabase!,table||null,300);setRuns(result);setTables(current=>Array.from(new Set([...current,...result.map(run=>run.target_table)])).sort());setError('')}
    catch(error){setError((error as Error).message)}finally{setBusy(false)}
  },[table,setError])
  usePolling(load,20000)
  const visible=onlyFailed?runs.filter(run=>run.status==='error'):runs
  return <section className="rfq-workspace">
    <div className="sd-session-bar"><History size={18}/><span>Run history</span><small className="rp-live">Last 300 runs</small></div>
    <div className="rp-toolbar"><label className="rp-field">Table<select value={table} onChange={event=>{setTable(event.target.value);setBusy(true)}}><option value="">All tables</option>{tables.map(name=><option key={name} value={name}>{name}</option>)}</select></label>
      <label className="rp-check"><input type="checkbox" checked={onlyFailed} onChange={event=>setOnlyFailed(event.target.checked)}/>Failed only</label>
      <button className="secondary" disabled={busy} onClick={()=>{setBusy(true);void load()}}><RefreshCw size={15}/>{busy?'Loading…':'Refresh'}</button></div>
    <div className="rfq-table-wrap"><table className="rfq-table"><thead><tr><th>Started</th><th>Table</th><th>Group</th><th>Trigger</th><th>Status</th><th>Rows read</th><th>Duration</th><th>Error</th></tr></thead><tbody>
      {visible.map(run=><tr className={`rfq-data-row ${run.status==='error'?'rp-row-error':''}`} key={run.id}>
        <td>{when(run.started_at)}</td><td>{run.target_table}</td><td>{run.group_name||'—'}</td>
        <td>{run.trigger==='full_reload'?'Full reload':run.trigger==='manual'?'Reload now':'Schedule'}</td>
        <td><span className={`rp-badge ${run.status==='error'?'failed':run.status==='running'?'running':'fresh'}`}>{STATUS_LABEL[run.status]}</span></td>
        <td>{count(run.row_count)}</td><td>{runDuration(run)}</td><td className="rp-error-cell">{run.error||''}</td>
      </tr>)}
      {!visible.length&&<tr><td colSpan={8}><div className="rfq-empty"><History size={28}/><h3>No runs</h3><p>Loads appear here as the sync agent runs them.</p></div></td></tr>}
    </tbody></table></div>
  </section>
}

// ---------------------------------------------------------------------------
// Audit Log (administrators)
// ---------------------------------------------------------------------------
function AuditLog({setError}:{setError:(message:string)=>void}){
  const [entries,setEntries]=useState<AuditEntry[]>([]);const [busy,setBusy]=useState(true)
  const load=useCallback(async()=>{
    try{setEntries(await loadAuditLog(supabase!,300));setError('')}
    catch(error){setError((error as Error).message)}finally{setBusy(false)}
  },[setError])
  usePolling(load,30000)
  return <section className="rfq-workspace">
    <div className="sd-session-bar"><ShieldCheck size={18}/><span>Audit log</span><small className="rp-live">Changes to what is loaded and every action from the app</small><button className="secondary" disabled={busy} onClick={()=>{setBusy(true);void load()}}><RefreshCw size={15}/>Refresh</button></div>
    <div className="rfq-table-wrap"><table className="rfq-table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>What</th><th>Details</th></tr></thead><tbody>
      {entries.map(entry=>{const details=Array.isArray(entry.details?.details)?(entry.details.details as string[]).join('; '):''
        return <tr className="rfq-data-row" key={entry.id}><td>{when(entry.at)}</td><td>{entry.actor}</td><td><span className={`rp-badge ${entry.action==='remove'?'failed':entry.action==='paused'?'paused':'neutral'}`}>{AUDIT_LABELS[entry.action]||entry.action}</span></td><td>{entry.object_type} <b>{entry.object_name}</b></td><td className="rp-error-cell">{details}</td></tr>})}
      {!entries.length&&<tr><td colSpan={5}><div className="rfq-empty"><ShieldCheck size={28}/><h3>Nothing recorded yet</h3><p>Applying tables.toml and using the controls on Data Loads are recorded here.</p></div></td></tr>}
    </tbody></table></div>
  </section>
}

function ReportingRoadmap(){
  return <section className="roadmap-page">
    <div className="section-head"><div><h2>Reporting roadmap</h2><p>Replacing the Qlik Sense functions Impala uses, step by step.</p></div></div>
    <div className="roadmap-priorities"><strong>Next priorities</strong><span>Connect the sync agent to the ERP</span><span>Rebuild the daily Qlik reports as apps</span><span>Set up SMTP for report emails</span><span>Agree row access rules per branch</span></div>
    <div className="roadmap-table-wrap"><table className="roadmap-table"><thead><tr><th>Capability</th><th>Qlik equivalent</th><th>Impala Hub</th><th>Status</th></tr></thead><tbody>
      {REPORTING_ROADMAP_ROWS.map(([capability,reference,impala,status])=><tr key={capability}><td>{capability}</td><td>{reference}</td><td>{impala}</td><td><span className={'roadmap-status '+(status==='Implemented'?'complete':'partial')}>{status}</span></td></tr>)}
    </tbody></table></div>
  </section>
}
