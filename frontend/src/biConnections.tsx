// Reporting → Data Connections (administrators): data that does not come from the ERP.
// Excel/CSV uploads are loaded from the browser; web and folder connectors are run by the agent
// within what its config.toml allows.
import {useCallback,useEffect,useMemo,useState} from 'react'
import {CloudDownload,FileSpreadsheet,FolderOpen,Globe,Pencil,Plus,RefreshCw,Trash2,Upload,X} from 'lucide-react'
import {supabase} from './supabase'
import {
  UPLOAD_TYPES,buildRows,checkWebConnector,columnProblems,deleteConnector,guessColumns,loadConnectors,readUploadFile,reloadConnector,safeName,
  saveConnector,uploadTable,type Connector,type ConnectorAgent,type UploadColumn,type UploadSheet,type UploadType,
} from './biConnectorLogic'
import {ago} from './reportingData'

type Props={setNotice:(m:string)=>void;setError:(m:string)=>void}
type Editing={kind:'upload';replace?:Connector}|{kind:'web'|'folder';connector?:Connector}

const KIND_LABEL={upload:'Excel / CSV upload',web:'Web API',folder:'Folder files'}
const KIND_ICON={upload:FileSpreadsheet,web:Globe,folder:FolderOpen}

export default function DataConnections({setNotice,setError}:Props){
  const [data,setData]=useState<{connectors:Connector[];agents:ConnectorAgent[]}|null>(null)
  const [editing,setEditing]=useState<Editing|null>(null)
  const [busy,setBusy]=useState('')
  const load=useCallback(async()=>{try{setData(await loadConnectors(supabase!))}catch(error){setError((error as Error).message)}},[setError])
  useEffect(()=>{void load();const t=setInterval(()=>{if(document.visibilityState==='visible')void load()},10000);return()=>clearInterval(t)},[load])
  const now=new Date()
  async function act(c:Connector,action:'reload'|'delete'){
    if(action==='delete'&&!confirm(`Remove the connector "${c.name}" and its table? Apps that use the table will show an error until it is removed from them.`))return
    setBusy(c.name)
    try{
      if(action==='reload'){await reloadConnector(supabase!,c.name);setNotice(`Asked agent ${c.agent_name} to load ${c.name}. It starts within a few seconds.`)}
      else{await deleteConnector(supabase!,c.name,true);setNotice(`Removed ${c.name}.`)}
      await load()
    }catch(error){setError((error as Error).message)}finally{setBusy('')}
  }
  if(editing?.kind==='upload')return <UploadWizard replace={editing.replace} existing={data?.connectors||[]} onClose={()=>setEditing(null)} onDone={async message=>{setNotice(message);setEditing(null);await load()}} setError={setError}/>
  if(editing)return <ConnectorForm kind={editing.kind} connector={editing.connector} agents={data?.agents||[]} existing={data?.connectors||[]} onClose={()=>setEditing(null)}
    onDone={async message=>{setNotice(message);setEditing(null);await load()}} setError={setError}/>
  return <section className="rfq-workspace">
    <div className="sd-session-bar"><CloudDownload size={18}/><span>Data connections</span><small className="rp-live">Data that does not come from the ERP. The ERP itself is loaded from tables.toml on the agent machine.</small></div>
    <div className="bi-conn-new">
      <button className="bi-conn-card" onClick={()=>setEditing({kind:'upload'})}><FileSpreadsheet size={22}/><b>Upload Excel or CSV</b><span>Budgets, targets, price lists… loaded straight from your computer.</span></button>
      <button className="bi-conn-card" onClick={()=>setEditing({kind:'web'})}><Globe size={22}/><b>Web API</b><span>JSON or CSV from a web address, fetched by the agent on a schedule.</span></button>
      <button className="bi-conn-card" onClick={()=>setEditing({kind:'folder'})}><FolderOpen size={22}/><b>Files from a folder</b><span>Excel or CSV files in a network folder the agent can read.</span></button>
    </div>
    <div className="rfq-table-wrap"><table className="rfq-table"><thead><tr><th>Table</th><th>Kind</th><th>From</th><th>Status</th><th>Rows</th><th>Last loaded</th><th>Schedule</th><th/></tr></thead><tbody>
      {(data?.connectors||[]).map(c=>{const Icon=KIND_ICON[c.kind]
        return <tr key={c.id} className="rfq-data-row">
          <td><b>{c.name}</b>{c.description&&<small className="rp-sub">{c.description}</small>}</td>
          <td><span className="bi-conn-kind"><Icon size={13}/>{KIND_LABEL[c.kind]}</span></td>
          <td className="bi-conn-from">{c.kind==='upload'?c.config.file||'—':c.kind==='web'?<code>{c.config.url}</code>:<><code>{c.config.folder}</code> / <code>{c.config.pattern}</code></>}{c.agent_name&&<small className="rp-sub">agent {c.agent_name}</small>}</td>
          <td>{c.reload_requested?<span className="rp-badge stale">Waiting for agent</span>:c.last_status==='error'?<span className="rp-badge failed" title={c.last_error||''}>Failed</span>:c.last_status==='running'?<span className="rp-badge stale">Loading…</span>:c.last_status==='success'?<span className="rp-badge fresh">Loaded</span>:<span className="rp-badge never">Not loaded yet</span>}
            {c.last_status==='error'&&c.last_error&&<small className="rp-sub bi-conn-error">{c.last_error}</small>}</td>
          <td>{c.row_count!=null?Number(c.row_count).toLocaleString():'—'}</td>
          <td>{ago(c.last_loaded_at||c.last_run_at,now)}</td>
          <td>{c.kind==='upload'?'When uploaded':c.interval_minutes?`Every ${c.interval_minutes} min${c.enabled?'':' (paused)'}`:'Only on Reload'}</td>
          <td className="bi-conn-actions">
            {c.kind==='upload'?<button className="secondary" onClick={()=>setEditing({kind:'upload',replace:c})}><Upload size={14}/>Replace file</button>
              :<><button className="secondary" disabled={busy===c.name} onClick={()=>void act(c,'reload')}><RefreshCw size={14}/>Reload</button>
                <button className="icon-button" aria-label={`Edit ${c.name}`} onClick={()=>setEditing({kind:c.kind as 'web'|'folder',connector:c})}><Pencil size={14}/></button></>}
            <button className="icon-button" aria-label={`Remove ${c.name}`} disabled={busy===c.name} onClick={()=>void act(c,'delete')}><Trash2 size={14}/></button>
          </td></tr>})}
      {data&&!data.connectors.length&&<tr><td colSpan={8}><p className="bi-muted">No connectors yet. Start with an upload, a web API or a folder above.</p></td></tr>}
    </tbody></table></div>
    {data&&<div className="bi-card bi-conn-agents"><h3>What the agents allow</h3>
      {data.agents.length?data.agents.map(a=><p key={a.name}><b>{a.name}</b>{' · '}hosts: {(a.connector_options.hosts||[]).join(', ')||'none'}{' · '}folders: {(a.connector_options.folders||[]).join(', ')||'none'}{' · '}secrets: {Object.keys(a.connector_options.secrets||{}).join(', ')||'none'}
        {(!a.version||a.version<'0.3.0')&&<small className="bi-muted"> (agent {a.version||'?'}: update to 0.3.0 for web and folder connectors)</small>}</p>):<p className="bi-muted">No agent has connected yet.</p>}
      <p className="hint">Each agent's config.toml decides which web hosts and folders connectors may use, and which API keys from its .env may be sent to which host. Change it there and restart the agent.</p></div>}
  </section>
}

// ---------------------------------------------------------------------------
// Upload wizard
// ---------------------------------------------------------------------------
function UploadWizard({replace,existing,onClose,onDone,setError}:{replace?:Connector;existing:Connector[];onClose:()=>void;onDone:(message:string)=>void;setError:(m:string)=>void}){
  const [file,setFile]=useState<File|null>(null)
  const [sheets,setSheets]=useState<UploadSheet[]>([])
  const [sheetIndex,setSheetIndex]=useState(0)
  const [columns,setColumns]=useState<UploadColumn[]>([])
  const [name,setName]=useState(replace?.name||'')
  const [description,setDescription]=useState(replace?.description||'')
  const [reading,setReading]=useState(false)
  const [progress,setProgress]=useState<number|null>(null)
  const sheet=sheets[sheetIndex]
  async function pick(f:File|null){
    if(!f)return
    setReading(true);setFile(f)
    try{const list=await readUploadFile(f);setSheets(list);setSheetIndex(0);setColumns(guessColumns(list[0]));if(!replace&&!name)setName(safeName(f.name.replace(/\.[^.]+$/,''),'upload'))}
    catch(error){setError((error as Error).message);setSheets([])}finally{setReading(false)}
  }
  const built=useMemo(()=>sheet?buildRows(sheet,columns):{rows:[],problems:[]},[sheet,columns])
  const taken=!replace&&existing.some(c=>c.name===name)
  const problem=!sheet?'Choose a file':!/^[a-z][a-z0-9_]{0,62}$/.test(name)?'The table name must start with a letter and use only lower case letters, digits and _':taken?`A connector named ${name} already exists`:columnProblems(columns)||(built.problems.length?built.problems[0]:null)
  async function upload(){
    if(problem||!sheet||!file)return
    setProgress(0)
    try{const n=await uploadTable(supabase!,name,description,file.name,columns,built.rows,setProgress);onDone(`Loaded ${n.toLocaleString()} rows into ${name}. Add it to an app under Data model & sharing.`)}
    catch(error){setError((error as Error).message);setProgress(null)}
  }
  const set=(i:number,changes:Partial<UploadColumn>)=>setColumns(columns.map((c,j)=>j===i?{...c,...changes}:c))
  return <section className="rfq-workspace bi-settings bi-conn-form">
    <div className="sd-session-bar"><FileSpreadsheet size={18}/><span>{replace?`Replace the file for ${replace.name}`:'Upload Excel or CSV'}</span>
      <div className="bi-app-actions"><button className="secondary" onClick={onClose} disabled={progress!==null}>Cancel</button>
        <button className="primary" disabled={Boolean(problem)||progress!==null} onClick={()=>void upload()}><Upload size={15}/>{progress!==null?`Uploading ${progress.toLocaleString()} / ${built.rows.length.toLocaleString()}…`:'Load table'}</button></div></div>
    <div className="bi-card"><div className="bi-form-grid">
      <label>File<input type="file" accept=".csv,.tsv,.txt,.xlsx,.xlsm" onChange={event=>void pick(event.target.files?.[0]||null)} disabled={reading||progress!==null}/></label>
      {sheets.length>1&&<label>Sheet<select value={sheetIndex} onChange={event=>{const i=Number(event.target.value);setSheetIndex(i);setColumns(guessColumns(sheets[i]))}}>{sheets.map((s,i)=><option key={i} value={i}>{s.name}</option>)}</select></label>}
      <label>Table name<input value={name} disabled={Boolean(replace)} onChange={event=>setName(event.target.value.toLowerCase())} placeholder="e.g. budget_2026"/></label>
      <label>Description<input value={description} maxLength={500} onChange={event=>setDescription(event.target.value)} placeholder="What this table holds"/></label>
    </div>
    {reading&&<p className="bi-muted">Reading the file…</p>}
    {problem&&sheet&&<p className="bi-expr-error">{problem}{built.problems.length>1&&` (and ${built.problems.length-1} more)`}</p>}
    {replace&&<p className="hint">The table is replaced with the new file. Apps keep working if the column names stay the same.</p>}</div>
    {sheet&&<div className="bi-card"><h3>Columns <small className="bi-muted">{sheet.rows.length.toLocaleString()} rows</small></h3>
      <p className="hint">Names are made safe for the database; the type is guessed from the data and can be changed.</p>
      <div className="bi-table-scroll"><table className="bi-table bi-upload-preview"><thead>
        <tr>{columns.map((c,i)=><th key={i}><label className="bi-check"><input type="checkbox" checked={c.include} onChange={event=>set(i,{include:event.target.checked})}/>{c.source}</label></th>)}</tr>
        <tr>{columns.map((c,i)=><th key={i}><input value={c.name} disabled={!c.include} onChange={event=>set(i,{name:event.target.value.toLowerCase()})} aria-label={`Name for ${c.source}`}/></th>)}</tr>
        <tr>{columns.map((c,i)=><th key={i}><select value={c.type} disabled={!c.include} onChange={event=>set(i,{type:event.target.value as UploadType})} aria-label={`Type for ${c.source}`}>{UPLOAD_TYPES.map(t=><option key={t.value} value={t.value}>{t.label}</option>)}</select></th>)}</tr>
      </thead><tbody>{sheet.rows.slice(0,15).map((row,r)=><tr key={r}>{columns.map((c,i)=><td key={i} className={c.include?'':'bi-muted'}>{row[c.index] instanceof Date?(row[c.index] as Date).toISOString().slice(0,10):String(row[c.index]??'')}</td>)}</tr>)}</tbody></table></div>
    </div>}
  </section>
}

// ---------------------------------------------------------------------------
// Web and folder connector form
// ---------------------------------------------------------------------------
function ConnectorForm({kind,connector,agents,existing,onClose,onDone,setError}:{kind:'web'|'folder';connector?:Connector;agents:ConnectorAgent[];existing:Connector[];onClose:()=>void;onDone:(m:string)=>void;setError:(m:string)=>void}){
  const c=connector?.config||{}
  const [name,setName]=useState(connector?.name||'')
  const [description,setDescription]=useState(connector?.description||'')
  const [agentName,setAgentName]=useState(connector?.agent_name||agents[0]?.name||'')
  const [url,setUrl]=useState<string>(c.url||'')
  const [format,setFormat]=useState<'json'|'csv'>(c.format||'json')
  const [recordsPath,setRecordsPath]=useState<string>(c.records_path||'')
  const [headers,setHeaders]=useState<{name:string;value:string}[]>(c.headers||[])
  const [folder,setFolder]=useState<string>(c.folder||'')
  const [pattern,setPattern]=useState<string>(c.pattern||'*.xlsx')
  const [sheet,setSheet]=useState<string>(c.sheet||'')
  const [combine,setCombine]=useState<'latest'|'all'>(c.combine||'latest')
  const [interval,setEvery]=useState<string>(connector?.interval_minutes?String(connector.interval_minutes):'60')
  const [enabled,setEnabled]=useState(connector?.enabled??true)
  const [saving,setSaving]=useState(false)
  const agent=agents.find(a=>a.name===agentName)
  const folders=agent?.connector_options.folders||[]
  const problem=!/^[a-z][a-z0-9_]{0,62}$/.test(name)?'The table name must start with a letter and use only lower case letters, digits and _'
    :!connector&&existing.some(x=>x.name===name)?`A connector named ${name} already exists`
    :interval&&Number(interval)<5?'The schedule must be at least every 5 minutes'
    :kind==='web'?checkWebConnector(url,headers,agent)
    :!agent?'Choose the agent that runs this connector':!folders.includes(folder)?`Choose one of the folders agent ${agentName} allows${folders.length?'':' (none yet: add [connectors.folders] to its config.toml)'}`
    :!/^[A-Za-z0-9 _.*?()-]{1,100}$/.test(pattern)?'The file pattern may use letters, digits, spaces, . _ - ( ) and the wildcards * and ?':null
  async function save(){
    if(problem)return
    setSaving(true)
    try{
      await saveConnector(supabase!,{name,kind,description,agent_name:agentName,interval_minutes:interval?Number(interval):null,enabled,
        config:kind==='web'?{url,format,records_path:recordsPath,headers:headers.filter(h=>h.name.trim())}:{folder,pattern,sheet,combine}})
      onDone(`Saved ${name}. Agent ${agentName} loads it within a few seconds; the status shows here.`)
    }catch(error){setError((error as Error).message)}finally{setSaving(false)}
  }
  return <section className="rfq-workspace bi-settings bi-conn-form">
    <div className="sd-session-bar">{kind==='web'?<Globe size={18}/>:<FolderOpen size={18}/>}<span>{connector?`Edit ${connector.name}`:kind==='web'?'New web API connector':'New folder connector'}</span>
      <div className="bi-app-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={Boolean(problem)||saving} onClick={()=>void save()}>{saving?'Saving…':'Save and load'}</button></div></div>
    <div className="bi-card"><div className="bi-form-grid">
      <label>Table name<input value={name} disabled={Boolean(connector)} onChange={event=>setName(event.target.value.toLowerCase())} placeholder={kind==='web'?'e.g. courier_deliveries':'e.g. branch_targets'}/></label>
      <label>Description<input value={description} maxLength={500} onChange={event=>setDescription(event.target.value)}/></label>
      <label>Agent<select value={agentName} onChange={event=>setAgentName(event.target.value)}><option value="">Choose…</option>{agents.map(a=><option key={a.name} value={a.name}>{a.name}</option>)}</select></label>
      <label>Load every (minutes)<input type="number" min={5} value={interval} placeholder="Only on Reload" onChange={event=>setEvery(event.target.value)}/></label>
    </div>
    <label className="bi-check"><input type="checkbox" checked={enabled} onChange={event=>setEnabled(event.target.checked)}/>Schedule on</label></div>
    {kind==='web'?<div className="bi-card"><h3>Web API</h3><div className="bi-form-grid">
      <label className="bi-span2">Web address<input value={url} onChange={event=>setUrl(event.target.value)} placeholder="https://api.example.com/v1/deliveries"/></label>
      <label>Format<select value={format} onChange={event=>setFormat(event.target.value as 'json')}><option value="json">JSON</option><option value="csv">CSV</option></select></label>
      {format==='json'&&<label>Records path<input value={recordsPath} onChange={event=>setRecordsPath(event.target.value)} placeholder="e.g. data.items (empty: the whole response)"/></label>}
    </div>
      <div className="bi-section-title">Headers</div>
      {headers.map((h,i)=><div key={i} className="bi-row bi-conn-header"><input placeholder="Name, e.g. Authorization" value={h.name} onChange={event=>setHeaders(headers.map((x,j)=>j===i?{...x,name:event.target.value}:x))}/>
        <input placeholder="Value, e.g. Bearer ${COURIER_API_KEY}" value={h.value} onChange={event=>setHeaders(headers.map((x,j)=>j===i?{...x,value:event.target.value}:x))}/>
        <button className="icon-button" aria-label="Remove header" onClick={()=>setHeaders(headers.filter((_,j)=>j!==i))}><X size={14}/></button></div>)}
      <button className="text-button" onClick={()=>setHeaders([...headers,{name:'',value:''}])}><Plus size={13}/>Add header</button>
      <p className="hint">Never type an API key here: use <code>${'{'}NAME{'}'}</code> for a value in the agent's .env. {agent&&<>Agent {agent.name} allows hosts <b>{(agent.connector_options.hosts||[]).join(', ')||'none'}</b> and secrets <b>{Object.entries(agent.connector_options.secrets||{}).map(([k,v])=>`${k} → ${v}`).join(', ')||'none'}</b>.</>} JSON objects inside records become columns like <code>meta_zone</code>; lists are kept as text.</p>
    </div>
    :<div className="bi-card"><h3>Files from a folder</h3><div className="bi-form-grid">
      <label>Folder<select value={folder} onChange={event=>setFolder(event.target.value)}><option value="">Choose…</option>{folders.map(f=><option key={f}>{f}</option>)}</select></label>
      <label>File name pattern<input value={pattern} onChange={event=>setPattern(event.target.value)} placeholder="e.g. targets *.xlsx"/></label>
      <label>Sheet (Excel)<input value={sheet} onChange={event=>setSheet(event.target.value)} placeholder="First sheet"/></label>
      <label>When several files match<select value={combine} onChange={event=>setCombine(event.target.value as 'latest')}><option value="latest">Use the newest file</option><option value="all">Combine all files (adds source_file)</option></select></label>
    </div><p className="hint">Folders are set up by name in the agent's config.toml; the first non-empty row of each file is the header.</p></div>}
    {problem&&<p className="bi-expr-error bi-conn-problem">{problem}</p>}
  </section>
}
