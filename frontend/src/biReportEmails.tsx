// Report emails for one app: schedules (sheets, recipients, when), test sends and the send history.
import {useCallback,useEffect,useState} from 'react'
import {ArrowLeft,CalendarClock,Mail,Pencil,Plus,RefreshCw,Send,Trash2} from 'lucide-react'
import {supabase} from './supabase'
import {loadPrincipals,type AppDetail,type Principals} from './biApps'
import {DAYS,TIMEZONES,defaultSubject,deleteReport,describeSchedule,loadReports,newSchedule,saveReport,scheduleProblem,sendReportNow,type ReportDelivery,type ReportSchedule} from './biReports'

const STATUS:Record<ReportDelivery['status'],[string,string]>={pending:['Queued','stale'],sending:['Sending','stale'],sent:['Sent','fresh'],failed:['Failed','failed'],skipped:['Skipped','never']}
const when=(iso?:string|null)=>iso?new Date(iso).toLocaleString('en-ZA',{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'—'

export default function ReportEmails({app,onClose,setNotice,setError}:{app:AppDetail;onClose:()=>void;setNotice:(m:string)=>void;setError:(m:string)=>void}){
  const [data,setData]=useState<{schedules:ReportSchedule[];deliveries:ReportDelivery[]}|null>(null)
  const [principals,setPrincipals]=useState<Principals|null>(null)
  const [editing,setEditing]=useState<ReportSchedule|null>(null)
  const [busy,setBusy]=useState('')
  const [setup,setSetup]=useState<{configured:boolean;missing:string[]}|null>(null)
  const load=useCallback(async()=>{if(!supabase)return
    try{setData(await loadReports(supabase,app.id))}catch(error){setError((error as Error).message)}},[app.id,setError])
  useEffect(()=>{void load()
    if(supabase)loadPrincipals(supabase).then(setPrincipals).catch(()=>setPrincipals(null))
    fetch('/api/reporting/send-due?status=1').then(r=>r.ok?r.json():null).then(setSetup).catch(()=>setSetup(null))},[load])
  // keep the history fresh while something is queued
  useEffect(()=>{if(!data?.deliveries.some(d=>d.status==='pending'||d.status==='sending'))return
    const timer=setInterval(()=>void load(),10000);return()=>clearInterval(timer)},[data,load])

  async function act(s:ReportSchedule,action:'test'|'all'|'delete'){
    if(!supabase||!s.id)return
    if(action==='delete'&&!confirm(`Delete the report email "${s.name}" and its history?`))return
    if(action==='all'&&!confirm(`Send "${s.name}" to all ${s.recipient_count??''} recipients now?`))return
    setBusy(s.id)
    try{
      if(action==='delete'){await deleteReport(supabase,s.id);setNotice('Report email deleted.')}
      else{const n=await sendReportNow(supabase,s.id,action==='test');setNotice(n?`Queued ${n} email${n===1?'':'s'}; ${action==='test'?'it':'they'} should arrive within a few minutes.`:'Nobody to send to (does your profile have an email address?).')}
      await load()
    }catch(error){setError((error as Error).message)}finally{setBusy('')}
  }

  if(editing)return <ScheduleForm app={app} schedule={editing} principals={principals} onClose={()=>setEditing(null)} onSaved={async()=>{setEditing(null);await load()}} setNotice={setNotice} setError={setError}/>
  const sheetTitle=(id:string)=>app.sheets.find(s=>s.id===id)?.title||'(deleted sheet)'
  const scheduleName=(id:string)=>data?.schedules.find(s=>s.id===id)?.name||''
  return <section className="rfq-workspace bi-reports">
    <div className="sd-session-bar"><Mail size={18}/><span>Report emails · {app.name}</span>
      <div className="bi-app-actions"><button className="secondary" onClick={onClose}><ArrowLeft size={15}/>Back to the app</button>
        <button className="primary" disabled={!app.sheets.length} onClick={()=>setEditing(newSchedule(app.sheets.map(s=>s.id)))}><Plus size={15}/>New report email</button></div></div>
    {setup&&!setup.configured&&<div className="bi-card bi-report-setup"><b>Email sending is not set up yet.</b> Emails will queue until these settings are added in Vercel: <code>{setup.missing.join(', ')}</code>. See the Reporting guide.</div>}
    <p className="hint">Each person gets a PDF and a picture of the chosen sheets, drawn with their own access (row access applies), plus a link to the app. Recipients who cannot open the app are skipped.</p>
    <div className="rfq-table-wrap"><table className="rfq-table"><thead><tr><th>Report email</th><th>Sheets</th><th>To</th><th>When</th><th>Next</th><th/></tr></thead><tbody>
      {(data?.schedules||[]).map(s=><tr key={s.id} className="rfq-data-row">
        <td><b>{s.name}</b>{!s.enabled&&<span className="rp-badge never">Paused</span>}{s.subject&&<div className="rp-sub">{s.subject}</div>}</td>
        <td>{s.sheet_ids.map(sheetTitle).join(', ')}</td>
        <td>{s.recipient_count} {s.recipient_count===1?'person':'people'}<div className="rp-sub">{s.recipients.map(r=>r.type==='role'?principals?.roles.find(x=>x.id===r.principal)?.label||r.principal:principals?.users.find(x=>x.id===r.principal)?.name||'someone').join(', ')}</div></td>
        <td><CalendarClock size={13}/> {describeSchedule(s)}</td>
        <td>{s.enabled?when(s.next_run_at):'—'}<div className="rp-sub">{s.last_run_at?`last ${when(s.last_run_at)}`:'never sent'}</div></td>
        <td className="bi-conn-actions">
          <button className="secondary" disabled={busy===s.id} onClick={()=>void act(s,'test')} title="Send it to yourself now"><Send size={14}/>Test to me</button>
          <button className="secondary" disabled={busy===s.id} onClick={()=>void act(s,'all')}><Mail size={14}/>Send now</button>
          <button className="icon-button" aria-label={`Edit ${s.name}`} onClick={()=>setEditing(s)}><Pencil size={14}/></button>
          <button className="icon-button" aria-label={`Delete ${s.name}`} disabled={busy===s.id} onClick={()=>void act(s,'delete')}><Trash2 size={14}/></button></td>
      </tr>)}
      {data&&!data.schedules.length&&<tr className="rfq-data-row"><td colSpan={6} className="bi-muted">No report emails yet. Choose sheets, who gets them and when.</td></tr>}
    </tbody></table></div>
    <div className="bi-card"><h3>Sent<button className="text-button bi-dm-toggle" onClick={()=>void load()}><RefreshCw size={13}/>Refresh</button></h3>
      <div className="rfq-table-wrap"><table className="rfq-table"><thead><tr><th>Queued</th><th>Report email</th><th>To</th><th>Status</th><th>Sent</th></tr></thead><tbody>
        {(data?.deliveries||[]).map(d=><tr key={d.id} className="rfq-data-row"><td>{when(d.created_at)}</td><td>{scheduleName(d.schedule_id)}{d.is_test&&<span className="rp-badge never">Test</span>}</td><td>{d.email}</td>
          <td><span className={`rp-badge ${STATUS[d.status][1]}`}>{STATUS[d.status][0]}</span>{d.attempts>1&&d.status!=='sent'&&<small className="bi-muted"> attempt {d.attempts}</small>}{d.error&&<div className="rp-sub bi-conn-error">{d.error}</div>}</td>
          <td>{when(d.sent_at)}</td></tr>)}
        {data&&!data.deliveries.length&&<tr className="rfq-data-row"><td colSpan={5} className="bi-muted">Nothing sent yet.</td></tr>}
      </tbody></table></div></div>
  </section>
}

function ScheduleForm({app,schedule,principals,onClose,onSaved,setNotice,setError}:{app:AppDetail;schedule:ReportSchedule;principals:Principals|null;onClose:()=>void;onSaved:()=>void;setNotice:(m:string)=>void;setError:(m:string)=>void}){
  const [s,setS]=useState<ReportSchedule>(schedule)
  const [search,setSearch]=useState('')
  const [saving,setSaving]=useState(false)
  const set=(changes:Partial<ReportSchedule>)=>setS(current=>({...current,...changes}))
  const problem=scheduleProblem(s)
  const has=(type:'role'|'user',id:string)=>s.recipients.some(r=>r.type===type&&r.principal===id)
  const toggle=(type:'role'|'user',id:string)=>set({recipients:has(type,id)?s.recipients.filter(r=>!(r.type===type&&r.principal===id)):[...s.recipients,{type,principal:id}]})
  const toggleSheet=(id:string)=>set({sheet_ids:s.sheet_ids.includes(id)?s.sheet_ids.filter(x=>x!==id):app.sheets.map(x=>x.id).filter(x=>x===id||s.sheet_ids.includes(x))})
  const users=(principals?.users||[]).filter(u=>{const n=search.trim().toLowerCase();return !n||u.name.toLowerCase().includes(n)||(u.email||'').toLowerCase().includes(n)})
  async function save(){
    if(!supabase||problem)return
    setSaving(true)
    try{await saveReport(supabase,app.id,s);setNotice(`Saved "${s.name}". ${s.enabled?describeSchedule(s)+'.':'It is paused.'}`);onSaved()}
    catch(error){setError((error as Error).message)}finally{setSaving(false)}
  }
  return <section className="rfq-workspace bi-settings bi-conn-form">
    <div className="sd-session-bar"><Mail size={18}/><span>{schedule.id?`Edit ${schedule.name}`:'New report email'} · {app.name}</span>
      <div className="bi-app-actions"><button className="secondary" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={Boolean(problem)||saving} onClick={()=>void save()}>{saving?'Saving…':'Save'}</button></div></div>
    {problem&&<p className="bi-expr-error bi-conn-problem">{problem}</p>}
    <div className="bi-card"><div className="bi-form-grid">
      <label>Name<input value={s.name} maxLength={120} placeholder="e.g. Daily branch sales" onChange={event=>set({name:event.target.value})}/></label>
      <label>Email subject<input value={s.subject} maxLength={200} placeholder={defaultSubject(app.name,s.name||'…')} onChange={event=>set({subject:event.target.value})}/></label>
      <label className="bi-span2">Message (optional)<textarea rows={3} value={s.message} maxLength={2000} placeholder="Shown above the report, e.g. Yesterday's sales per branch." onChange={event=>set({message:event.target.value})}/></label>
      <label className="bi-check"><input type="checkbox" checked={s.enabled} onChange={event=>set({enabled:event.target.checked})}/>On (untick to pause)</label>
    </div></div>
    <div className="bi-card"><h3>Sheets</h3><p className="hint">Each sheet is sent as a PDF page and a picture, in this order.</p>
      <div className="bi-rule-chips">{app.sheets.map(sheet=><label key={sheet.id} className={`bi-chip ${s.sheet_ids.includes(sheet.id)?'on':''}`}><input type="checkbox" checked={s.sheet_ids.includes(sheet.id)} onChange={()=>toggleSheet(sheet.id)}/>{sheet.title}</label>)}</div></div>
    <div className="bi-card"><h3>When</h3><div className="bi-form-grid">
      <label>How often<select value={s.frequency} onChange={event=>set({frequency:event.target.value as ReportSchedule['frequency']})}>
        <option value="daily">Every day</option><option value="weekdays">Weekdays (Mon–Fri)</option><option value="weekly">Weekly, on chosen days</option><option value="monthly">Monthly</option></select></label>
      <label>Time<input type="time" value={s.send_time} onChange={event=>set({send_time:event.target.value})}/></label>
      {s.frequency==='weekly'&&<div className="bi-span2"><b className="bi-label">Days</b><div className="bi-rule-chips">{DAYS.map((d,i)=><label key={d} className={`bi-chip ${s.weekdays.includes(i+1)?'on':''}`}><input type="checkbox" checked={s.weekdays.includes(i+1)} onChange={()=>set({weekdays:s.weekdays.includes(i+1)?s.weekdays.filter(x=>x!==i+1):[...s.weekdays,i+1]})}/>{d}</label>)}</div></div>}
      {s.frequency==='monthly'&&<label>Day of the month<input type="number" min={1} max={31} value={s.month_day??1} onChange={event=>set({month_day:Number(event.target.value)})}/></label>}
      <label>Time zone<select value={s.timezone} onChange={event=>set({timezone:event.target.value})}>{[...new Set([s.timezone,...TIMEZONES])].map(z=><option key={z}>{z}</option>)}</select></label>
    </div><p className="hint">{describeSchedule(s)}. Emails go out within a few minutes of this time.</p></div>
    <div className="bi-card"><h3>Who gets it</h3><p className="hint">Hub users only. Everyone in a chosen role gets their own copy with their own data.</p>
      <div className="bi-access"><div><b>Roles</b>{(principals?.roles||[]).map(r=><label key={r.id} className="bi-check"><input type="checkbox" checked={has('role',r.id)} onChange={()=>toggle('role',r.id)}/>{r.label}</label>)}</div>
        <div><b>People</b><input placeholder="Search by name or email" value={search} onChange={event=>setSearch(event.target.value)}/>
          <div className="bi-user-list">{users.slice(0,50).map(u=><label key={u.id} className="bi-check"><input type="checkbox" checked={has('user',u.id)} onChange={()=>toggle('user',u.id)}/>{u.name}<small>{u.email}</small></label>)}</div></div></div></div>
  </section>
}
