// Report emails for one app: schedules and alerts (sheets, filter, recipients, when), test sends and the
// send history; and, for everyone, "Email me": own subscriptions and opting out of builders' emails.
import {useCallback,useEffect,useState} from 'react'
import {ArrowLeft,BellRing,CalendarClock,Mail,Pencil,Plus,RefreshCw,Send,Trash2} from 'lucide-react'
import {supabase} from './supabase'
import {displayValue,loadBookmarks,loadPrincipals,type AppDetail,type Bookmark,type Principals,type Selection} from './biApps'
import {ExpressionInput,type ExpressionContext} from './biExpressionEditor'
import {
  ALERT_OPS,DAYS,TIMEZONES,defaultSubject,deleteReport,describeSchedule,loadMyReportEmails,loadReports,newAlert,newSchedule,saveReport,scheduleProblem,
  sendReportNow,setOptout,subscribe,unsubscribe,type ReportDelivery,type ReportSchedule,
} from './biReports'

const STATUS:Record<ReportDelivery['status'],[string,string]>={pending:['Queued','stale'],sending:['Sending','stale'],sent:['Sent','fresh'],failed:['Failed','failed'],
  skipped:['Skipped','never'],not_needed:['Not needed','never']}
const when=(iso?:string|null)=>iso?new Date(iso).toLocaleString('en-ZA',{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'—'
const describeAlert=(s:ReportSchedule)=>s.alert?`${s.alert.label||s.alert.measure.text} ${ALERT_OPS.find(o=>o[0]===s.alert!.op)?.[1]||s.alert.op} ${s.alert.value}${s.alert.dimension?.text?` for any ${s.alert.dimension_label||s.alert.dimension.text}`:''}`:''

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
    if(action==='delete'&&!confirm(`Delete "${s.name}" and its history?`))return
    if(action==='all'&&!confirm(`Send "${s.name}" to all ${s.recipient_count??''} recipients now?`))return
    setBusy(s.id)
    try{
      if(action==='delete'){await deleteReport(supabase,s.id);setNotice('Deleted.')}
      else{const n=await sendReportNow(supabase,s.id,action==='test');setNotice(n?`Queued ${n} email${n===1?'':'s'}; ${action==='test'?'it':'they'} should arrive within a few minutes${s.kind==='alert'?' (alerts only when the condition is met)':''}.`:'Nobody to send to (does your profile have an email address?).')}
      await load()
    }catch(error){setError((error as Error).message)}finally{setBusy('')}
  }

  if(editing)return <ScheduleForm app={app} schedule={editing} principals={principals} onClose={()=>setEditing(null)} onSaved={async()=>{setEditing(null);await load()}} setNotice={setNotice} setError={setError}/>
  const sheetTitle=(id:string)=>app.sheets.find(s=>s.id===id)?.title||'(deleted sheet)'
  const scheduleName=(id:string)=>data?.schedules.find(s=>s.id===id)?.name||''
  return <section className="rfq-workspace bi-reports">
    <div className="sd-session-bar"><Mail size={18}/><span>Report emails · {app.name}</span>
      <div className="bi-app-actions"><button className="secondary" onClick={onClose}><ArrowLeft size={15}/>Back to the app</button>
        <button className="secondary" onClick={()=>setEditing({...newSchedule([]),kind:'alert',alert:newAlert()})}><BellRing size={15}/>New alert</button>
        <button className="primary" disabled={!app.sheets.length} onClick={()=>setEditing(newSchedule(app.sheets.map(s=>s.id)))}><Plus size={15}/>New report email</button></div></div>
    {setup&&!setup.configured&&<div className="bi-card bi-report-setup"><b>Email sending is not set up yet.</b> Emails will queue until these settings are added in Vercel: <code>{setup.missing.join(', ')}</code>. See the Reporting guide.</div>}
    <p className="hint">Report emails send a PDF and a picture of the chosen sheets (and Excel if chosen). Alerts are checked on their schedule and only sent when the condition is met. Everything is drawn with each person's own access (row access applies); people who cannot open the app are skipped, and people can stop an email under <b>Email me</b>.</p>
    <div className="rfq-table-wrap"><table className="rfq-table"><thead><tr><th>Name</th><th>Sends</th><th>To</th><th>When</th><th>Next</th><th/></tr></thead><tbody>
      {(data?.schedules||[]).map(s=><tr key={s.id} className="rfq-data-row">
        <td><b>{s.name}</b>{s.kind==='alert'&&<span className="rp-badge stale">Alert</span>}{s.personal&&<span className="rp-badge never">Personal</span>}{!s.enabled&&<span className="rp-badge never">Paused</span>}
          {s.subject&&<div className="rp-sub">{s.subject}</div>}{s.personal&&s.owner_name&&<div className="rp-sub">subscribed by {s.owner_name}</div>}</td>
        <td>{s.kind==='alert'&&<div>{describeAlert(s)}</div>}{s.sheet_ids.map(sheetTitle).join(', ')}{s.attach_excel&&<div className="rp-sub">+ Excel</div>}
          {(s.bookmark_id||s.selections.length>0||s.conditions.length>0)&&<div className="rp-sub">filtered</div>}</td>
        <td>{s.recipient_count} {s.recipient_count===1?'person':'people'}<div className="rp-sub">{s.recipients.map(r=>r.type==='role'?principals?.roles.find(x=>x.id===r.principal)?.label||r.principal:principals?.users.find(x=>x.id===r.principal)?.name||'someone').join(', ')}{s.optouts?` · ${s.optouts} stopped it`:''}</div></td>
        <td><CalendarClock size={13}/> {describeSchedule(s)}</td>
        <td>{s.enabled?when(s.next_run_at):'—'}<div className="rp-sub">{s.last_run_at?`last ${when(s.last_run_at)}`:'never sent'}</div></td>
        <td className="bi-conn-actions">
          <button className="secondary" disabled={busy===s.id} onClick={()=>void act(s,'test')} title="Send it to yourself now"><Send size={14}/>Test to me</button>
          {!s.personal&&<button className="secondary" disabled={busy===s.id} onClick={()=>void act(s,'all')}><Mail size={14}/>Send now</button>}
          {!s.personal&&<button className="icon-button" aria-label={`Edit ${s.name}`} onClick={()=>setEditing(s)}><Pencil size={14}/></button>}
          <button className="icon-button" aria-label={`Delete ${s.name}`} disabled={busy===s.id} onClick={()=>void act(s,'delete')}><Trash2 size={14}/></button></td>
      </tr>)}
      {data&&!data.schedules.length&&<tr className="rfq-data-row"><td colSpan={6} className="bi-muted">No report emails or alerts yet.</td></tr>}
    </tbody></table></div>
    <div className="bi-card"><h3>Sent<button className="text-button bi-dm-toggle" onClick={()=>void load()}><RefreshCw size={13}/>Refresh</button></h3>
      <div className="rfq-table-wrap"><table className="rfq-table"><thead><tr><th>Queued</th><th>Name</th><th>To</th><th>Status</th><th>Sent</th></tr></thead><tbody>
        {(data?.deliveries||[]).map(d=><tr key={d.id} className="rfq-data-row"><td>{when(d.created_at)}</td><td>{scheduleName(d.schedule_id)}{d.is_test&&<span className="rp-badge never">Test</span>}</td><td>{d.email}</td>
          <td><span className={`rp-badge ${STATUS[d.status][1]}`}>{STATUS[d.status][0]}</span>{d.attempts>1&&d.status!=='sent'&&<small className="bi-muted"> attempt {d.attempts}</small>}{d.error&&<div className="rp-sub bi-conn-error">{d.error}</div>}</td>
          <td>{when(d.sent_at)}</td></tr>)}
        {data&&!data.deliveries.length&&<tr className="rfq-data-row"><td colSpan={5} className="bi-muted">Nothing sent yet.</td></tr>}
      </tbody></table></div></div>
  </section>
}

// The form for builders' report emails and alerts, and (personal) for viewers' own subscriptions
export function ScheduleForm({app,schedule,principals,personal=false,onClose,onSaved,setNotice,setError}:{app:AppDetail;schedule:ReportSchedule;principals:Principals|null;personal?:boolean
  onClose:()=>void;onSaved:()=>void;setNotice:(m:string)=>void;setError:(m:string)=>void}){
  const [s,setS]=useState<ReportSchedule>(schedule)
  const [search,setSearch]=useState('')
  const [saving,setSaving]=useState(false)
  const [bookmarks,setBookmarks]=useState<Bookmark[]>([])
  useEffect(()=>{if(supabase)loadBookmarks(supabase,app.id).then(list=>setBookmarks(list.filter(b=>b.shared||personal))).catch(()=>setBookmarks([]))},[app.id,personal])
  const set=(changes:Partial<ReportSchedule>)=>setS(current=>({...current,...changes}))
  const ctx:ExpressionContext={appId:app.id,model:app.model,measures:app.measures,variables:Object.fromEntries((app.variables||[]).map(v=>[v.name,v.value]))}
  const problem=scheduleProblem(s,{...app,variableValues:ctx.variables},personal)
  const has=(type:'role'|'user',id:string)=>s.recipients.some(r=>r.type===type&&r.principal===id)
  const toggle=(type:'role'|'user',id:string)=>set({recipients:has(type,id)?s.recipients.filter(r=>!(r.type===type&&r.principal===id)):[...s.recipients,{type,principal:id}]})
  const toggleSheet=(id:string)=>set({sheet_ids:s.sheet_ids.includes(id)?s.sheet_ids.filter(x=>x!==id):app.sheets.map(x=>x.id).filter(x=>x===id||s.sheet_ids.includes(x))})
  const users=(principals?.users||[]).filter(u=>{const n=search.trim().toLowerCase();return !n||u.name.toLowerCase().includes(n)||(u.email||'').toLowerCase().includes(n)})
  const alert=s.alert||newAlert()
  const setAlert=(changes:Partial<typeof alert>)=>set({alert:{...alert,...changes}})
  const what=s.kind==='alert'?'alert':personal?'subscription':'report email'
  async function save(){
    if(!supabase||problem)return
    setSaving(true)
    try{
      if(personal)await subscribe(supabase,app,s);else await saveReport(supabase,app,s)
      setNotice(`Saved "${s.name}". ${s.enabled?describeSchedule(s)+'.':'It is paused.'}`);onSaved()
    }catch(error){setError((error as Error).message)}finally{setSaving(false)}
  }
  return <section className="rfq-workspace bi-settings bi-conn-form">
    <div className="sd-session-bar">{s.kind==='alert'?<BellRing size={18}/>:<Mail size={18}/>}<span>{schedule.id?`Edit ${schedule.name}`:`New ${what}`} · {app.name}</span>
      <div className="bi-app-actions"><button className="secondary" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={Boolean(problem)||saving} onClick={()=>void save()}>{saving?'Saving…':'Save'}</button></div></div>
    {problem&&<p className="bi-expr-error bi-conn-problem">{problem}</p>}
    <div className="bi-card"><div className="bi-form-grid">
      <label>Name<input value={s.name} maxLength={120} placeholder={s.kind==='alert'?'e.g. Stock below reorder level':'e.g. Daily branch sales'} onChange={event=>set({name:event.target.value})}/></label>
      <label>Type<select value={s.kind} onChange={event=>set({kind:event.target.value as ReportSchedule['kind'],alert:event.target.value==='alert'?s.alert||newAlert():null})}>
        <option value="report">Report: send the sheets every time</option><option value="alert">Alert: only when a condition is met</option></select></label>
      {!personal&&<label>Email subject<input value={s.subject} maxLength={200} placeholder={defaultSubject(app.name,s.name||'…')} onChange={event=>set({subject:event.target.value})}/></label>}
      {!personal&&<label className="bi-span2">Message (optional)<textarea rows={3} value={s.message} maxLength={2000} placeholder="Shown above the report, e.g. Yesterday's sales per branch." onChange={event=>set({message:event.target.value})}/></label>}
      <label className="bi-check"><input type="checkbox" checked={s.enabled} onChange={event=>set({enabled:event.target.checked})}/>On (untick to pause)</label>
    </div></div>
    {s.kind==='alert'&&<div className="bi-card"><h3><BellRing size={16}/>Condition</h3>
      <div className="bi-form-grid">
        <label>Measure<ExpressionInput ctx={ctx} kind="measure" label="Alert measure" value={alert.measure.text} onChange={text=>setAlert({measure:{text}})}/></label>
        <label>Name in the email (optional)<input value={alert.label} maxLength={80} placeholder="e.g. Short by" onChange={event=>setAlert({label:event.target.value})}/></label>
        <label>Send when it<select value={alert.op} onChange={event=>setAlert({op:event.target.value as typeof alert.op})}>{ALERT_OPS.map(([op,label])=><option key={op} value={op}>{label}</option>)}</select></label>
        <label>Number<input type="number" value={Number.isFinite(alert.value)?alert.value:''} onChange={event=>setAlert({value:Number(event.target.value)})}/></label>
        <label className="bi-span2">For each (optional: check per value, e.g. per item; the email lists the ones that meet the condition)
          <ExpressionInput ctx={ctx} kind="dimension" label="Alert dimension" value={alert.dimension?.text||''} onChange={text=>setAlert({dimension:text?{text}:null})}/></label>
      </div>
      <p className="hint">Example: measure <code>Sum(reorder_level - qty_on_hand)</code> above <code>0</code> for each <code>description</code> emails the items to reorder. The condition is checked as each recipient, with their access and the filter below.</p></div>}
    <div className="bi-card"><h3>Sheets</h3><p className="hint">{s.kind==='alert'?'Optional: sheets to attach when the alert is sent.':'Each sheet is sent as a PDF page and a picture, in this order.'}</p>
      <div className="bi-rule-chips">{app.sheets.map(sheet=><label key={sheet.id} className={`bi-chip ${s.sheet_ids.includes(sheet.id)?'on':''}`}><input type="checkbox" checked={s.sheet_ids.includes(sheet.id)} onChange={()=>toggleSheet(sheet.id)}/>{sheet.title}</label>)}</div>
      <label className="bi-check"><input type="checkbox" checked={s.attach_excel} onChange={event=>set({attach_excel:event.target.checked})}/>Attach the data as Excel (one tab per chart{s.kind==='alert'?', plus the alert\'s rows':''})</label></div>
    <div className="bi-card"><h3>Filter</h3><p className="hint">Optional. Narrows what is sent, on top of each person's own access.</p>
      <div className="bi-form-grid">
        <label>Bookmark<select value={s.bookmark_id||''} onChange={event=>set({bookmark_id:event.target.value||null})}>
          <option value="">None</option>{bookmarks.map(b=><option key={b.id} value={b.id}>{b.name}{b.shared?'':' (yours)'}</option>)}</select></label>
        <div className="bi-span2"><b className="bi-label">Conditions (e.g. <code>invoice_date = Today() - 1</code> for yesterday)</b>
          {s.conditions.map((c,i)=><div key={i} className="bi-row"><ExpressionInput ctx={ctx} kind="condition" label={`Condition ${i+1}`} value={c.text} onChange={text=>set({conditions:s.conditions.map((x,j)=>j===i?{text}:x)})}/>
            <button className="icon-button" aria-label="Remove condition" onClick={()=>set({conditions:s.conditions.filter((_,j)=>j!==i)})}><Trash2 size={14}/></button></div>)}
          <button className="text-button" onClick={()=>set({conditions:[...s.conditions,{text:''}]})}><Plus size={13}/>Add condition</button></div>
        {s.selections.length>0&&<div className="bi-span2"><b className="bi-label">Selections</b><div className="bi-rule-chips">{s.selections.map(sel=><span key={sel.key} className="bi-chip on">{sel.label}: {sel.values.slice(0,3).map(v=>displayValue(v)).join(', ')}{sel.values.length>3?'…':''}
          <button aria-label={`Remove ${sel.label}`} onClick={()=>set({selections:s.selections.filter(x=>x.key!==sel.key)})}>×</button></span>)}</div></div>}
      </div></div>
    <div className="bi-card"><h3>When</h3><div className="bi-form-grid">
      <label>How often<select value={s.frequency} onChange={event=>set({frequency:event.target.value as ReportSchedule['frequency']})}>
        <option value="daily">Every day</option><option value="weekdays">Weekdays (Mon–Fri)</option><option value="weekly">Weekly, on chosen days</option><option value="monthly">Monthly</option></select></label>
      <label>Time<input type="time" value={s.send_time} onChange={event=>set({send_time:event.target.value})}/></label>
      {s.frequency==='weekly'&&<div className="bi-span2"><b className="bi-label">Days</b><div className="bi-rule-chips">{DAYS.map((d,i)=><label key={d} className={`bi-chip ${s.weekdays.includes(i+1)?'on':''}`}><input type="checkbox" checked={s.weekdays.includes(i+1)} onChange={()=>set({weekdays:s.weekdays.includes(i+1)?s.weekdays.filter(x=>x!==i+1):[...s.weekdays,i+1]})}/>{d}</label>)}</div></div>}
      {s.frequency==='monthly'&&<label>Day of the month<input type="number" min={1} max={31} value={s.month_day??1} onChange={event=>set({month_day:Number(event.target.value)})}/></label>}
      {!personal&&<label>Time zone<select value={s.timezone} onChange={event=>set({timezone:event.target.value})}>{[...new Set([s.timezone,...TIMEZONES])].map(z=><option key={z}>{z}</option>)}</select></label>}
    </div><p className="hint">{describeSchedule(s)}. {s.kind==='alert'?'Checked':'Sent'} within a few minutes of this time.</p></div>
    {!personal&&<div className="bi-card"><h3>Who gets it</h3><p className="hint">Hub users only. Everyone in a chosen role gets their own copy with their own data.</p>
      <div className="bi-access"><div><b>Roles</b>{(principals?.roles||[]).map(r=><label key={r.id} className="bi-check"><input type="checkbox" checked={has('role',r.id)} onChange={()=>toggle('role',r.id)}/>{r.label}</label>)}</div>
        <div><b>People</b><input placeholder="Search by name or email" value={search} onChange={event=>setSearch(event.target.value)}/>
          <div className="bi-user-list">{users.slice(0,50).map(u=><label key={u.id} className="bi-check"><input type="checkbox" checked={has('user',u.id)} onChange={()=>toggle('user',u.id)}/>{u.name}<small>{u.email}</small></label>)}</div></div></div></div>}
  </section>
}

// Everyone: "Email me" — own subscriptions (with the current selections) and the emails sent to them
export function MyReportEmails({app,sheetId,selections,onClose,setNotice,setError}:{app:AppDetail;sheetId:string|null;selections:Selection[];onClose:()=>void;setNotice:(m:string)=>void;setError:(m:string)=>void}){
  const [list,setList]=useState<ReportSchedule[]|null>(null)
  const [editing,setEditing]=useState<ReportSchedule|null>(null)
  const load=useCallback(async()=>{if(!supabase)return;try{setList(await loadMyReportEmails(supabase,app.id))}catch(error){setError((error as Error).message)}},[app.id,setError])
  useEffect(()=>{void load()},[load])
  async function act(s:ReportSchedule,action:'test'|'delete'|'stop'|'resume'){
    if(!supabase||!s.id)return
    try{
      if(action==='test'){await sendReportNow(supabase,s.id,true);setNotice('A test is on its way to you.')}
      else if(action==='delete'){if(!confirm(`Remove your subscription "${s.name}"?`))return;await unsubscribe(supabase,s.id);setNotice('Subscription removed.')}
      else{await setOptout(supabase,s.id,action==='stop');setNotice(action==='stop'?`You will no longer get "${s.name}".`:`You will get "${s.name}" again.`)}
      await load()
    }catch(error){setError((error as Error).message)}
  }
  if(editing)return <ScheduleForm app={app} schedule={editing} principals={null} personal onClose={()=>setEditing(null)} onSaved={async()=>{setEditing(null);await load()}} setNotice={setNotice} setError={setError}/>
  const sheetTitle=(id:string)=>app.sheets.find(s=>s.id===id)?.title||'(deleted sheet)'
  const fresh=()=>({...newSchedule(sheetId?[sheetId]:app.sheets.slice(0,1).map(s=>s.id)),name:`${app.sheets.find(s=>s.id===sheetId)?.title||app.name}`,selections:selections.filter(s=>s.values.length)})
  const mine=(list||[]).filter(s=>s.personal),theirs=(list||[]).filter(s=>!s.personal)
  return <section className="rfq-workspace bi-reports">
    <div className="sd-session-bar"><Mail size={18}/><span>Email me · {app.name}</span>
      <div className="bi-app-actions"><button className="secondary" onClick={onClose}><ArrowLeft size={15}/>Back to the app</button>
        <button className="secondary" onClick={()=>setEditing({...fresh(),name:'',kind:'alert',alert:newAlert(),sheet_ids:[]})}><BellRing size={15}/>Alert me</button>
        <button className="primary" onClick={()=>setEditing(fresh())}><Plus size={15}/>Email me this sheet</button></div></div>
    <p className="hint">Subscriptions send you sheets (as PDF and picture) on a schedule, with your current selections if you had any. Alerts email you only when something happens, e.g. stock below the reorder level.</p>
    <div className="bi-card"><h3>My subscriptions and alerts</h3>
      {!mine.length&&<p className="bi-muted">None yet.</p>}
      {mine.map(s=><div key={s.id} className="bi-sub-row"><div><b>{s.name}</b>{s.kind==='alert'&&<span className="rp-badge stale">Alert</span>}{!s.enabled&&<span className="rp-badge never">Paused</span>}
        <small>{s.kind==='alert'?describeAlert(s)+' · ':''}{s.sheet_ids.map(sheetTitle).join(', ')}{s.sheet_ids.length?' · ':''}{describeSchedule(s)}{s.selections.length?` · ${s.selections.map(sel=>`${sel.label}: ${sel.values.slice(0,2).map(v=>displayValue(v)).join(', ')}`).join('; ')}`:''}</small></div>
        <div className="bi-conn-actions"><button className="secondary" onClick={()=>void act(s,'test')}><Send size={14}/>Send me now</button>
          <button className="icon-button" aria-label={`Edit ${s.name}`} onClick={()=>setEditing(s)}><Pencil size={14}/></button>
          <button className="icon-button" aria-label={`Remove ${s.name}`} onClick={()=>void act(s,'delete')}><Trash2 size={14}/></button></div></div>)}
    </div>
    <div className="bi-card"><h3>Sent to me by report builders</h3>
      {!theirs.length&&<p className="bi-muted">No report emails from this app are sent to you.</p>}
      {theirs.map(s=><div key={s.id} className="bi-sub-row"><div><b>{s.name}</b>{s.kind==='alert'&&<span className="rp-badge stale">Alert</span>}{s.opted_out&&<span className="rp-badge never">Stopped</span>}
        <small>{s.sheet_ids.map(sheetTitle).join(', ')}{s.sheet_ids.length?' · ':''}{describeSchedule(s)}</small></div>
        <div className="bi-conn-actions">{s.opted_out?<button className="secondary" onClick={()=>void act(s,'resume')}>Send it to me again</button>:<button className="secondary" onClick={()=>void act(s,'stop')}>Stop sending me this</button>}</div></div>)}
    </div>
  </section>
}
