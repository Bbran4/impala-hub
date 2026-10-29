// Reporting batch 4 screens: comments on charts, version history, copying an app, the master item library,
// usage statistics and data quality.
import {Fragment,useCallback,useEffect,useMemo,useState} from 'react'
import {
  AlertTriangle,BookMarked,CheckCircle2,ChevronDown,ChevronRight,Copy,Gauge,History,MessageSquare,Plus,RefreshCw,RotateCcw,Save,Search,Trash2,Users,X,
} from 'lucide-react'
import {supabase} from './supabase'
import {ago} from './reportingData'
import type {AppDetail,Sheet} from './biApps'
import {
  addComment,copyApp,deleteComment,deleteLibraryItem,loadComments,loadLibrary,loadQuality,loadUsage,loadVersions,qualityIssues,restoreVersion,
  saveLibraryItem,unusedSheets,updateComment,type Comment,type LibraryItem,type QualityTable,type Usage,type Version,
} from './biCollabLogic'

type Messages={setNotice:(m:string)=>void;setError:(m:string)=>void}
const err=(setError:(m:string)=>void)=>(error:unknown)=>setError((error as Error).message)
const when=(iso:string|null)=>iso?new Date(iso).toLocaleString('en-ZA',{dateStyle:'medium',timeStyle:'short'}):'—'
const FORMAT_LABEL:Record<string,string>={auto:'Automatic',number:'Number',integer:'Whole number',money:'Rand (R)',percent:'Percent'}

// ---------------------------------------------------------------------------
// Comments: a panel beside the sheet with the threads of one chart (or all charts)
// ---------------------------------------------------------------------------
export function useSheetComments(appId:string|undefined,sheetId:string|undefined){
  const [comments,setComments]=useState<Comment[]>([])
  const reload=useCallback(()=>{if(supabase&&appId&&sheetId)loadComments(supabase,appId,sheetId).then(setComments).catch(()=>setComments([]));else setComments([])},[appId,sheetId])
  useEffect(()=>{reload()},[reload])
  return {comments,reload}
}

export function CommentsPanel({app,sheet,objectId,comments,onPick,onChanged,onClose,setError}:{
  app:AppDetail;sheet:Sheet;objectId:string|null;comments:Comment[];onPick:(id:string|null)=>void;onChanged:()=>void;onClose:()=>void;setError:(m:string)=>void
}){
  const [text,setText]=useState('')
  const [showResolved,setShowResolved]=useState(false)
  const [editing,setEditing]=useState<{id:string;body:string}|null>(null)
  const [busy,setBusy]=useState(false)
  const titleOf=(id:string)=>{const object=sheet.objects.find(o=>o.id===id);return object?.title||(object?`Untitled ${object.kind}`:'Removed chart')}
  const shown=comments.filter(c=>(!objectId||c.object_id===objectId)&&(showResolved||!c.resolved))
  const groups=[...new Set(shown.map(c=>c.object_id))]
  const resolvedCount=comments.filter(c=>(!objectId||c.object_id===objectId)&&c.resolved).length
  async function run(action:()=>Promise<unknown>){
    if(!supabase)return
    setBusy(true);try{await action();onChanged()}catch(error){setError((error as Error).message)}finally{setBusy(false)}
  }
  const post=()=>{if(objectId&&text.trim())void run(async()=>{await addComment(supabase!,app.id,sheet.id,objectId,text.trim());setText('')})}
  return <aside className="bi-comments" aria-label="Comments">
    <div className="bi-comments-head"><MessageSquare size={16}/><b>{objectId?titleOf(objectId):'Comments on this sheet'}</b>
      <button className="icon-button" aria-label="Close comments" onClick={onClose}><X size={15}/></button></div>
    <div className="bi-comments-filter">
      <select aria-label="Chart" value={objectId||''} onChange={event=>onPick(event.target.value||null)}>
        <option value="">All charts</option>
        {sheet.objects.filter(o=>!['divider','layout','tabs'].includes(o.kind)).map(o=><option key={o.id} value={o.id}>{o.title||`Untitled ${o.kind}`}</option>)}
      </select>
      {resolvedCount>0&&<label className="bi-check"><input type="checkbox" checked={showResolved} onChange={event=>setShowResolved(event.target.checked)}/>Show {resolvedCount} resolved</label>}
    </div>
    <div className="bi-comments-list">
      {!shown.length&&<p className="bi-muted">{objectId?'No comments on this chart yet. Ask a question or note something for the team.':'No open comments on this sheet. Choose a chart to start a thread.'}</p>}
      {groups.map(group=><div key={group} className="bi-comment-group">
        {!objectId&&<button className="bi-comment-chart" onClick={()=>onPick(group)}>{titleOf(group)}</button>}
        {shown.filter(c=>c.object_id===group).map(c=><div key={c.id} className={`bi-comment ${c.resolved?'resolved':''}`}>
          <div className="bi-comment-meta"><b>{c.author||'Someone'}</b><small title={when(c.created_at)}>{ago(c.created_at,new Date()).toLowerCase()}{c.edited_at?' · edited':''}</small></div>
          {editing?.id===c.id
            ?<div className="bi-comment-edit"><textarea value={editing.body} maxLength={2000} onChange={event=>setEditing({id:c.id,body:event.target.value})}/>
              <div className="bi-row"><button className="secondary" onClick={()=>setEditing(null)}>Cancel</button>
                <button className="primary" disabled={busy||!editing.body.trim()} onClick={()=>void run(async()=>{await updateComment(supabase!,c.id,editing.body.trim(),null);setEditing(null)})}>Save</button></div></div>
            :<p>{c.body}</p>}
          <div className="bi-comment-actions">
            <button className="text-button" disabled={busy} onClick={()=>void run(()=>updateComment(supabase!,c.id,null,!c.resolved))}>{c.resolved?<><RotateCcw size={12}/>Reopen</>:<><CheckCircle2 size={12}/>Resolve</>}</button>
            {c.mine&&editing?.id!==c.id&&<button className="text-button" onClick={()=>setEditing({id:c.id,body:c.body})}>Edit</button>}
            {c.mine&&<button className="text-button danger" disabled={busy} onClick={()=>{if(confirm('Delete this comment?'))void run(()=>deleteComment(supabase!,c.id))}}><Trash2 size={12}/>Delete</button>}
          </div>
        </div>)}
      </div>)}
    </div>
    {objectId?<div className="bi-comment-new">
      <textarea placeholder="Write a comment… Others in this thread are notified." value={text} maxLength={2000} onChange={event=>setText(event.target.value)}
        onKeyDown={event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey))post()}}/>
      <button className="primary" disabled={busy||!text.trim()} onClick={post}>Comment</button>
    </div>:<p className="hint">Choose a chart above, or click the comment icon on a chart, to add a comment.</p>}
  </aside>
}

// ---------------------------------------------------------------------------
// Version history (builders): earlier versions of the app settings and of each sheet
// ---------------------------------------------------------------------------
export function VersionHistory({app,onClose,onRestored,setNotice,setError}:{app:AppDetail;onClose:()=>void;onRestored:(sheetId:string|null)=>void}&Messages){
  const [versions,setVersions]=useState<Version[]|null>(null)
  const [filter,setFilter]=useState('')
  const [busy,setBusy]=useState<number|null>(null)
  useEffect(()=>{if(supabase)loadVersions(supabase,app.id).then(setVersions).catch(error=>{setError((error as Error).message);setVersions([])})},[app.id,setError])
  const subjects=useMemo(()=>{const seen=new Map<string,string>();for(const v of versions||[])if(!seen.has(v.object_id))seen.set(v.object_id,v.kind==='app'?'App settings':app.sheets.find(s=>s.id===v.object_id)?.title||v.label);return [...seen]},[versions,app.sheets])
  const shown=(versions||[]).filter(v=>!filter||v.object_id===filter)
  async function restore(v:Version){
    const what=v.kind==='app'?'the app settings (name, data model, master measures, variables and calculated fields)':`the sheet "${v.label}"`
    if(!supabase||!confirm(`Restore ${what} as saved ${when(v.saved_at)}? The current version is kept in the history, so you can undo this.`))return
    setBusy(v.id)
    try{await restoreVersion(supabase,v.id);setNotice(v.kind==='app'?'App settings restored.':v.exists?`Sheet "${v.label}" restored.`:`Deleted sheet "${v.label}" brought back.`);onRestored(v.kind==='sheet'?v.object_id:null)}
    catch(error){setError((error as Error).message)}finally{setBusy(null)}
  }
  return <section className="rfq-workspace bi-settings">
    <div className="sd-session-bar"><History size={18}/><span>{app.name}: version history</span><div className="bi-app-actions"><button className="secondary" onClick={onClose}>Back to the app</button></div></div>
    <div className="bi-card">
      <p className="hint">Every time a sheet or the app settings are saved or a sheet is deleted, the version before is kept (the last 50 of each). Restoring keeps the current version here too, so a restore can be undone.</p>
      {subjects.length>1&&<label className="bi-add-table">Show<select value={filter} onChange={event=>setFilter(event.target.value)}><option value="">Everything</option>{subjects.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>}
      {versions===null?<p className="bi-muted">Loading…</p>:!shown.length?<p className="bi-muted">No earlier versions yet. They appear after the first change to a sheet or the app.</p>:
      <div className="rfq-table-wrap"><table className="rfq-table"><thead><tr><th>What</th><th>Version from</th><th>Changed by</th><th>Contents</th><th/></tr></thead><tbody>
        {shown.map(v=><tr key={v.id} className="rfq-data-row">
          <td><b>{v.kind==='app'?'App settings':v.label}</b>{v.kind==='sheet'&&!v.exists&&<span className="rp-badge failed">Deleted</span>}{v.deleted&&v.exists&&<small className="rp-sub">deleted, since brought back</small>}</td>
          <td title={when(v.saved_at)}>{when(v.saved_at)}</td>
          <td>{v.saved_by||'—'}</td>
          <td>{v.kind==='sheet'?`${v.summary.objects??0} object${v.summary.objects===1?'':'s'}`:`${v.summary.tables??0} tables · ${v.summary.measures??0} measures`}</td>
          <td><button className="secondary" disabled={busy!==null} onClick={()=>void restore(v)}><RotateCcw size={14}/>{busy===v.id?'Restoring…':v.kind==='sheet'&&!v.exists?'Bring back':'Restore'}</button></td>
        </tr>)}
      </tbody></table></div>}
    </div>
  </section>
}

// ---------------------------------------------------------------------------
// Copy an app (builders), from the app settings
// ---------------------------------------------------------------------------
export function CopyAppButton({app,onCopied,setNotice,setError}:{app:AppDetail;onCopied:(id:string)=>void}&Messages){
  const [open,setOpen]=useState(false)
  const [name,setName]=useState(`${app.name} (copy)`)
  const [withAccess,setWithAccess]=useState(false)
  const [busy,setBusy]=useState(false)
  async function copy(){
    if(!supabase||!name.trim())return
    setBusy(true)
    try{const id=await copyApp(supabase,app.id,name.trim(),withAccess);setNotice(`"${name.trim()}" created as a copy of "${app.name}".`);setOpen(false);onCopied(id)}
    catch(error){setError((error as Error).message)}finally{setBusy(false)}
  }
  return <div className="bi-menu">
    <button className="secondary" onClick={()=>setOpen(!open)} aria-expanded={open}><Copy size={15}/>Copy app</button>
    {open&&<div className="bi-menu-pop bi-copy-app">
      <div className="bi-menu-title">Copy this app</div>
      <p className="bi-muted">Copies the data model, sheets, master measures, variables and calculated fields. Bookmarks, comments and report emails stay with the original.</p>
      <label>Name of the copy<input value={name} maxLength={120} onChange={event=>setName(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')void copy()}}/></label>
      <label className="bi-check"><input type="checkbox" checked={withAccess} onChange={event=>setWithAccess(event.target.checked)}/>Also copy who can open it and the row access</label>
      <div className="bi-row"><button className="secondary" onClick={()=>setOpen(false)}>Cancel</button><button className="primary" disabled={busy||!name.trim()} onClick={()=>void copy()}>{busy?'Copying…':'Copy app'}</button></div>
    </div>}
  </div>
}

// ---------------------------------------------------------------------------
// Master item library: measures (and dimensions) shared by every app
// ---------------------------------------------------------------------------
export function useLibrary(setError:(m:string)=>void){
  const [items,setItems]=useState<LibraryItem[]|null>(null)
  const reload=useCallback(()=>{if(supabase)loadLibrary(supabase).then(setItems).catch(error=>{setError((error as Error).message);setItems([])})},[setError])
  useEffect(()=>{reload()},[reload])
  return {items,reload}
}

// In the app settings: pick a library measure to add to the app's master measures
export function LibraryPicker({items,existing,onAdd}:{items:LibraryItem[]|null;existing:string[];onAdd:(item:LibraryItem)=>void}){
  const measures=(items||[]).filter(i=>i.kind==='measure')
  if(!measures.length)return null
  const taken=new Set(existing.map(n=>n.trim().toLowerCase()))
  return <label className="bi-library-pick"><BookMarked size={13}/><select value="" onChange={event=>{const item=measures.find(i=>i.id===event.target.value);if(item)onAdd(item)}} aria-label="Add from the library">
    <option value="">Add from the library…</option>
    {measures.map(i=><option key={i.id} value={i.id} disabled={taken.has(i.name.trim().toLowerCase())}>{i.name}{taken.has(i.name.trim().toLowerCase())?' (in this app)':''} — {i.expression.slice(0,60)}</option>)}
  </select></label>
}

// Saves an app's master measure to the library (or updates the library item with the same name)
export async function saveMeasureToLibrary(items:LibraryItem[]|null,measure:{name:string;expression:string;format?:string},description=''){
  if(!supabase)return
  const existing=(items||[]).find(i=>i.kind==='measure'&&i.name.trim().toLowerCase()===measure.name.trim().toLowerCase())
  if(existing&&!confirm(`The library already has "${existing.name}" (${existing.expression}). Replace it with this expression?`))return false
  await saveLibraryItem(supabase,{id:existing?.id,kind:'measure',name:measure.name.trim(),expression:measure.expression,format:measure.format||null,description:existing?.description||description})
  return true
}

export function LibraryPage({setNotice,setError}:Messages){
  const {items,reload}=useLibrary(setError)
  const [edit,setEdit]=useState<LibraryItem|null>(null)
  const [search,setSearch]=useState('')
  const [busy,setBusy]=useState(false)
  const needle=search.trim().toLowerCase()
  const shown=(items||[]).filter(i=>!needle||`${i.name} ${i.expression} ${i.description}`.toLowerCase().includes(needle))
  async function save(){
    if(!supabase||!edit)return
    setBusy(true)
    try{await saveLibraryItem(supabase,{...edit,name:edit.name.trim()});setNotice(`"${edit.name.trim()}" saved to the library.`);setEdit(null);reload()}
    catch(error){setError((error as Error).message)}finally{setBusy(false)}
  }
  async function remove(item:LibraryItem){
    if(!supabase||!item.id||!confirm(`Remove "${item.name}" from the library? Apps that already use it keep their own copy.`))return
    try{await deleteLibraryItem(supabase,item.id);reload()}catch(error){setError((error as Error).message)}
  }
  return <section className="rfq-workspace">
    <div className="sd-session-bar"><BookMarked size={18}/><span>Master items</span><button className="primary" onClick={()=>setEdit({kind:'measure',name:'',expression:'',format:'auto',description:''})}><Plus size={15}/>New item</button></div>
    <div className="bi-card">
      <p className="hint">Measures and dimensions defined once for every app, so "Sales" or "Gross margin %" means the same in every report. Add them to an app from <b>Data model &amp; sharing → Master measures → Add from the library</b>; an app keeps its own copy, so changing the library does not change existing apps.</p>
    </div>
    <div className="rp-toolbar"><label className="rp-search"><Search size={15}/><input placeholder="Search names, expressions and descriptions" value={search} onChange={event=>setSearch(event.target.value)}/></label></div>
    {edit&&<div className="bi-card bi-library-edit"><h3>{edit.id?`Edit ${edit.name}`:'New library item'}</h3>
      <div className="bi-form-grid">
        <label>Kind<select value={edit.kind} onChange={event=>setEdit({...edit,kind:event.target.value as LibraryItem['kind']})}><option value="measure">Measure (with an aggregation, e.g. Sum)</option><option value="dimension">Dimension (a field or per-row expression)</option></select></label>
        <label>Name<input value={edit.name} maxLength={80} placeholder="e.g. Gross margin %" onChange={event=>setEdit({...edit,name:event.target.value})}/></label>
        <label className="wide">Expression<input value={edit.expression} placeholder={edit.kind==='measure'?'e.g. (Sum(sales)-Sum(cost))/Sum(sales)':'e.g. YearMonth(invoice_date)'} onChange={event=>setEdit({...edit,expression:event.target.value})}/></label>
        {edit.kind==='measure'&&<label>Number format<select value={edit.format||'auto'} onChange={event=>setEdit({...edit,format:event.target.value})}>{Object.entries(FORMAT_LABEL).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>}
        <label className="wide">Description<input value={edit.description} maxLength={500} placeholder="What it means and where the numbers come from" onChange={event=>setEdit({...edit,description:event.target.value})}/></label>
      </div>
      <p className="hint">Field names are checked when the item is added to an app, against that app's data model.</p>
      <div className="bi-row"><button className="secondary" onClick={()=>setEdit(null)}>Cancel</button><button className="primary" disabled={busy||!edit.name.trim()||!edit.expression.trim()} onClick={()=>void save()}><Save size={14}/>{busy?'Saving…':'Save'}</button></div>
    </div>}
    <div className="rfq-table-wrap"><table className="rfq-table"><thead><tr><th>Name</th><th>Kind</th><th>Expression</th><th>Used in</th><th>Changed</th><th/></tr></thead><tbody>
      {shown.map(i=><tr key={i.id} className="rfq-data-row">
        <td><b>{i.name}</b>{i.description&&<small className="rp-sub">{i.description}</small>}</td>
        <td>{i.kind==='measure'?'Measure':'Dimension'}{i.kind==='measure'&&i.format&&i.format!=='auto'&&<small className="rp-sub">{FORMAT_LABEL[i.format]}</small>}</td>
        <td><code>{i.expression}</code></td>
        <td>{i.kind==='measure'?`${i.used_in||0} app${i.used_in===1?'':'s'}`:'—'}</td>
        <td>{i.updated_at?ago(i.updated_at,new Date()):'—'}{i.updated_by&&<small className="rp-sub">{i.updated_by}</small>}</td>
        <td className="bi-row-actions"><button className="secondary" onClick={()=>setEdit({...i,format:i.format||'auto'})}>Edit</button><button className="icon-button" aria-label={`Remove ${i.name}`} onClick={()=>void remove(i)}><Trash2 size={14}/></button></td>
      </tr>)}
      {items&&!shown.length&&<tr><td colSpan={6}><div className="rfq-empty"><BookMarked size={28}/><h3>{items.length?'Nothing matches':'The library is empty'}</h3><p>{items.length?'Try a different search.':'Create items here, or save an app\'s master measure to the library from its settings.'}</p></div></td></tr>}
    </tbody></table></div>
  </section>
}

// ---------------------------------------------------------------------------
// Usage (builders and administrators): which apps and sheets people open
// ---------------------------------------------------------------------------
export function UsagePage({setError}:{setError:(m:string)=>void}){
  const [days,setDays]=useState(30)
  const [usage,setUsage]=useState<Usage|null>(null)
  const [open,setOpen]=useState<string|null>(null)
  const load=useCallback(()=>{if(supabase)loadUsage(supabase,days).then(setUsage).catch(err(setError))},[days,setError])
  useEffect(()=>{load()},[load])
  const now=new Date()
  const totals=useMemo(()=>usage?{views:usage.by_day.reduce((s,d)=>s+d.views,0),people:usage.people.length,apps:usage.apps.filter(a=>a.views).length,unused:unusedSheets(usage).length}:null,[usage])
  return <section className="rfq-workspace">
    <div className="sd-session-bar"><Users size={18}/><span>Usage</span><div className="bi-app-actions">
      <select value={days} onChange={event=>setDays(Number(event.target.value))} aria-label="Period"><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last year</option></select>
      <button className="secondary" onClick={load}><RefreshCw size={15}/>Refresh</button></div></div>
    {usage&&totals&&<>
      <div className="sd-metrics">
        <div className="sd-metric"><span>Sheets opened</span><strong>{totals.views.toLocaleString('en-ZA')}</strong></div>
        <div className="sd-metric"><span>People</span><strong>{totals.people}</strong></div>
        <div className="sd-metric"><span>Apps used</span><strong>{totals.apps} of {usage.apps.length}</strong></div>
        <div className="sd-metric"><span>Sheets not opened</span><strong>{totals.unused}</strong></div>
      </div>
      <div className="bi-card"><h3>Sheets opened per day</h3><UsageBars days={usage.by_day} period={usage.days}/></div>
      <div className="bi-usage-grid">
        <div className="rfq-table-wrap"><table className="rfq-table"><thead><tr><th/><th>App</th><th>Opened</th><th>People</th><th>Report emails sent</th><th>Last opened</th></tr></thead><tbody>
          {usage.apps.map(app=>{const expanded=open===app.app_id;return <Fragment key={app.app_id}>
            <tr className="rfq-data-row rp-click" onClick={()=>setOpen(expanded?null:app.app_id)}>
              <td className="rp-chevron">{expanded?<ChevronDown size={15}/>:<ChevronRight size={15}/>}</td>
              <td><b>{app.name}</b><small className="rp-sub">{app.sheets.length} sheet{app.sheets.length===1?'':'s'}</small></td>
              <td>{app.views}</td><td>{app.people}</td><td>{app.report_emails}</td><td>{app.last_opened?ago(app.last_opened,now):'Never'}</td></tr>
            {expanded&&app.sheets.map(s=><tr key={s.sheet_id} className="rp-detail-row bi-usage-sheet"><td/><td>{s.title}{!s.views&&<span className="rp-badge stale">Not opened</span>}</td><td>{s.views}</td><td>{s.people}</td><td/><td>{s.last_opened?ago(s.last_opened,now):'Never'}</td></tr>)}
          </Fragment>})}
          {!usage.apps.length&&<tr><td colSpan={6}><div className="rfq-empty"><h3>No apps yet</h3></div></td></tr>}
        </tbody></table></div>
        <div className="rfq-table-wrap"><table className="rfq-table"><thead><tr><th>Person</th><th>Opened</th><th>Apps</th><th>Last</th></tr></thead><tbody>
          {usage.people.map(p=><tr key={p.name} className="rfq-data-row"><td>{p.name}</td><td>{p.views}</td><td>{p.apps}</td><td>{ago(p.last_opened,now)}</td></tr>)}
          {!usage.people.length&&<tr><td colSpan={4}><p className="bi-muted">Nobody opened a sheet in this period.</p></td></tr>}
        </tbody></table></div>
      </div>
      <p className="hint">Counts each time someone opens a sheet. Sheets nobody opens are candidates to remove or merge when moving the Qlik apps over.</p>
    </>}
    {!usage&&<p className="bi-muted">Loading…</p>}
  </section>
}

function UsageBars({days,period}:{days:Usage['by_day'];period:number}){
  // one bar per day of the period, days without views included
  const series=useMemo(()=>{const map=new Map(days.map(d=>[d.day.slice(0,10),d]));const out:{day:string;views:number;people:number}[]=[]
    const start=new Date();start.setHours(0,0,0,0);start.setDate(start.getDate()-Math.min(period,365)+1)
    for(let d=new Date(start);d<=new Date();d.setDate(d.getDate()+1)){const key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;out.push(map.get(key)||{day:key,views:0,people:0})}
    return out},[days,period])
  const max=Math.max(1,...series.map(d=>d.views))
  const w=Math.max(2,Math.min(24,700/series.length))
  return <div className="bi-usage-bars" role="img" aria-label={`Sheets opened per day, up to ${max} a day`}>
    <svg viewBox={`0 0 ${series.length*w} 120`} preserveAspectRatio="none">{series.map((d,i)=><rect key={d.day} x={i*w+w*0.15} width={w*0.7} y={120-d.views/max*112} height={d.views/max*112} rx={Math.min(2,w*0.2)}><title>{`${d.day}: ${d.views} opened by ${d.people} ${d.people===1?'person':'people'}`}</title></rect>)}</svg>
    <div className="bi-usage-axis"><span>{series[0]?.day}</span><span>max {max} a day</span><span>{series.at(-1)?.day}</span></div>
  </div>
}

// ---------------------------------------------------------------------------
// Data quality: loads that failed or are late, row counts that dropped, fields that are always empty
// ---------------------------------------------------------------------------
export function DataQualityPage({setError}:{setError:(m:string)=>void}){
  const [tables,setTables]=useState<QualityTable[]|null>(null)
  const [onlyIssues,setOnlyIssues]=useState(false)
  const [open,setOpen]=useState<string|null>(null)
  const [busy,setBusy]=useState(false)
  const load=useCallback(()=>{if(!supabase)return;setBusy(true);loadQuality(supabase).then(setTables).catch(err(setError)).finally(()=>setBusy(false))},[setError])
  useEffect(()=>{load()},[load])
  const now=new Date()
  const rows=(tables||[]).map(t=>({t,issues:qualityIssues(t,now)}))
  const shown=rows.filter(r=>!onlyIssues||r.issues.length)
  return <section className="rfq-workspace">
    <div className="sd-session-bar"><Gauge size={18}/><span>Data quality</span><div className="bi-app-actions"><button className="secondary" disabled={busy} onClick={load}><RefreshCw size={15}/>{busy?'Checking…':'Check again'}</button></div></div>
    {tables&&<div className="sd-metrics">
      <div className="sd-metric"><span>Tables</span><strong>{tables.length}</strong></div>
      <div className="sd-metric"><span>With issues</span><strong>{rows.filter(r=>r.issues.length).length}</strong></div>
      <div className="sd-metric"><span>Failed last load</span><strong>{tables.filter(t=>t.runs[0]?.status==='error').length}</strong></div>
      <div className="sd-metric"><span>Always-empty fields</span><strong>{tables.reduce((s,t)=>s+t.empty_fields.length,0)}</strong></div>
    </div>}
    <div className="rp-toolbar"><label className="bi-check bi-toolbar-check"><input type="checkbox" checked={onlyIssues} onChange={event=>setOnlyIssues(event.target.checked)}/>Only tables with issues</label></div>
    <div className="rfq-table-wrap"><table className="rfq-table"><thead><tr><th/><th>Table</th><th>Rows</th><th>Last loaded</th><th>Last loads</th><th>Issues</th></tr></thead><tbody>
      {shown.map(({t,issues})=>{const expanded=open===t.table_name;return <Fragment key={t.table_name}>
        <tr className="rfq-data-row rp-click" onClick={()=>setOpen(expanded?null:t.table_name)}>
          <td className="rp-chevron">{expanded?<ChevronDown size={15}/>:<ChevronRight size={15}/>}</td>
          <td><b>{t.table_name}</b>{t.description&&<small className="rp-sub">{t.description}</small>}</td>
          <td>{t.row_count==null?'—':Number(t.row_count).toLocaleString('en-ZA')}</td>
          <td title={when(t.last_loaded_at)}>{ago(t.last_loaded_at,now)}</td>
          <td><span className="bi-run-dots">{t.runs.slice(0,10).reverse().map((r,i)=><i key={i} className={r.status} title={`${when(r.at)}: ${r.status==='success'?`${r.rows?.toLocaleString('en-ZA')??'?'} rows`:r.status}${r.error?` — ${r.error}`:''}`}/>)}</span></td>
          <td>{issues.length?<span className="rp-badge failed"><AlertTriangle size={12}/>{issues.length} issue{issues.length===1?'':'s'}</span>:<span className="rp-badge fresh">OK</span>}</td>
        </tr>
        {expanded&&<tr className="rp-detail-row"><td colSpan={6}><div className="bi-quality-detail">
          {issues.length?<ul>{issues.map(i=><li key={i}>{i}</li>)}</ul>:<p className="bi-muted">No issues found.</p>}
          {t.mostly_empty.length>0&&<p><b>Mostly empty fields:</b> {t.mostly_empty.map(m=>`${m.field} (${Math.round(m.empty*100)}% empty)`).join(', ')}</p>}
          {t.runs.length>0&&<p><b>Rows per load:</b> {t.runs.filter(r=>r.status==='success').slice(0,8).map(r=>`${new Date(r.at).toLocaleDateString('en-ZA',{day:'numeric',month:'short'})} ${r.rows?.toLocaleString('en-ZA')??'?'}`).join(' · ')||'—'}</p>}
        </div></td></tr>}
      </Fragment>})}
      {tables&&!shown.length&&<tr><td colSpan={6}><div className="rfq-empty"><CheckCircle2 size={28}/><h3>{tables.length?'No issues':'No data loaded yet'}</h3><p>{tables.length?'Every loaded table looks healthy.':'Tables appear once the sync agent or a data connection loads them.'}</p></div></td></tr>}
    </tbody></table></div>
    <p className="hint">Checks every loaded table: the last load failed, loads are more than three intervals late, the row count dropped by more than 20% since the load before, or a field is empty in every row (from the database statistics, refreshed after loads).</p>
  </section>
}
