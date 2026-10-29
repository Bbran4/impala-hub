// Row access (like Qlik section access): per app, which rows each user or role may see.
import {useEffect,useMemo,useState} from 'react'
import {Plus,Save,ShieldCheck,Trash2} from 'lucide-react'
import {supabase} from './supabase'
import {loadRowAccess,rowRuleProblem,runQuery,saveRowAccess,type AppDetail,type Principals,type RowAccess,type RowRule} from './biApps'

export default function RowAccessCard({app,principals,setNotice,setError}:{app:AppDetail;principals:Principals|null;setNotice:(m:string)=>void;setError:(m:string)=>void}){
  const [saved,setSaved]=useState<RowAccess|null>(null)
  const [access,setAccess]=useState<RowAccess>({enabled:false,rules:[]})
  const [saving,setSaving]=useState(false)
  useEffect(()=>{if(!supabase)return
    loadRowAccess(supabase,app.id).then(data=>{setSaved(data);setAccess(data)}).catch(error=>setError((error as Error).message))},[app.id,setError])
  const fields=useMemo(()=>app.model.flatMap(t=>t.columns.map(c=>`${t.alias}.${c.name}`)),[app.model])
  const problems=access.rules.map(rule=>rowRuleProblem(rule,app.model))
  const changed=JSON.stringify(saved)!==JSON.stringify(access)
  const set=(i:number,changes:Partial<RowRule>)=>setAccess({...access,rules:access.rules.map((r,j)=>j===i?{...r,...changes}:r)})
  const who=(rule:RowRule)=>rule.type==='role'?principals?.roles.find(r=>r.id===rule.principal)?.label:principals?.users.find(u=>u.id===rule.principal)?.name
  async function save(){
    if(!supabase)return
    setSaving(true)
    try{await saveRowAccess(supabase,app.id,access);setSaved(access);setNotice(access.enabled?'Row access saved. Viewers now only see their rows.':'Row access saved (off: everyone with access sees all rows).')}
    catch(error){setError((error as Error).message)}finally{setSaving(false)}
  }
  const lastField=access.rules.at(-1)?.field||fields.find(f=>/branch|location|region|warehouse|rep/.test(f))||fields[0]||''
  return <div className="bi-card bi-row-access"><h3><ShieldCheck size={16}/>Row access</h3>
    <p className="hint">Like Qlik section access: limit which records each person sees in this app, for example only their own branch. Every chart, table, filter, export and report email follows it. Administrators and report builders always see everything. When it is on, viewers without a rule see no data.</p>
    <label className="bi-check"><input type="checkbox" checked={access.enabled} onChange={event=>setAccess({...access,enabled:event.target.checked})}/>Limit rows for viewers of this app</label>
    {access.rules.length>0&&<div className="bi-rule-list">{access.rules.map((rule,i)=><RuleRow key={i} app={app} rule={rule} fields={fields} principals={principals} problem={problems[i]}
      onChange={changes=>set(i,changes)} onRemove={()=>setAccess({...access,rules:access.rules.filter((_,j)=>j!==i)})}/>)}</div>}
    <div className="bi-row bi-rule-actions">
      <button className="text-button" onClick={()=>setAccess({...access,rules:[...access.rules,{type:'role',principal:'',field:lastField,all:false,values:[]}]})}><Plus size={13}/>Add rule</button>
      <button className="primary" disabled={!changed||saving||problems.some(Boolean)} onClick={()=>void save()}><Save size={14}/>{saving?'Saving…':'Save row access'}</button>
    </div>
    {access.enabled&&access.rules.length>0&&<p className="hint">Several rules for the same person add up (e.g. a role rule plus a personal one). Rules on different fields both apply. {access.rules.filter(r=>r.principal).slice(0,3).map(r=>`${who(r)||'?'} sees ${r.field.split('.')[1]} ${r.all?'(all)':r.values.join(', ')}`).join('; ')}{access.rules.length>3?'; …':'.'}</p>}
  </div>
}

function RuleRow({app,rule,fields,principals,problem,onChange,onRemove}:{app:AppDetail;rule:RowRule;fields:string[];principals:Principals|null;problem:string|null;onChange:(c:Partial<RowRule>)=>void;onRemove:()=>void}){
  const [options,setOptions]=useState<string[]>([])
  const [search,setSearch]=useState('')
  const [extra,setExtra]=useState('')
  useEffect(()=>{
    const [table,name]=rule.field.split('.')
    if(!supabase||!table||!name){setOptions([]);return}
    let alive=true
    runQuery(supabase,app.id,{dimensions:[{expr:{t:'field',table,name}}],limit:1000})
      .then(result=>{if(alive)setOptions(result.rows.map(r=>r[0]).filter(v=>v!==null).map(v=>String(v)))}).catch(()=>{if(alive)setOptions([])})
    return()=>{alive=false}
  },[app.id,rule.field])
  const shown=[...new Set([...rule.values,...options])].filter(v=>!search||v.toLowerCase().includes(search.toLowerCase())).slice(0,200)
  const toggle=(v:string)=>onChange({values:rule.values.includes(v)?rule.values.filter(x=>x!==v):[...rule.values,v]})
  return <div className={`bi-rule ${problem?'invalid':''}`}>
    <div className="bi-rule-head">
      <select value={rule.type} onChange={event=>onChange({type:event.target.value as 'role',principal:''})} aria-label="Rule for"><option value="role">Role</option><option value="user">Person</option></select>
      <select value={rule.principal} onChange={event=>onChange({principal:event.target.value})} aria-label="Who">
        <option value="">Choose…</option>
        {rule.type==='role'?(principals?.roles||[]).filter(r=>r.id!=='administrator'&&r.id!=='report_builder').map(r=><option key={r.id} value={r.id}>{r.label}</option>)
          :(principals?.users||[]).map(u=><option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
      <span>sees rows where</span>
      <select value={rule.field} onChange={event=>onChange({field:event.target.value,values:[]})} aria-label="Field">{fields.map(f=><option key={f} value={f}>{f}</option>)}</select>
      <span>is</span>
      <label className="bi-check"><input type="checkbox" checked={rule.all} onChange={event=>onChange({all:event.target.checked})}/>any value</label>
      <button className="icon-button" aria-label="Remove rule" onClick={onRemove}><Trash2 size={14}/></button>
    </div>
    {!rule.all&&<div className="bi-rule-values">
      {options.length>12&&<input placeholder="Find a value" value={search} onChange={event=>setSearch(event.target.value)}/>}
      <div className="bi-rule-chips">{shown.map(v=><label key={v} className={`bi-chip ${rule.values.includes(v)?'on':''}`}><input type="checkbox" checked={rule.values.includes(v)} onChange={()=>toggle(v)}/>{v}</label>)}
        <span className="bi-rule-extra"><input placeholder="Other value" value={extra} onChange={event=>setExtra(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&extra.trim()){event.preventDefault();if(!rule.values.includes(extra.trim()))onChange({values:[...rule.values,extra.trim()]});setExtra('')}}}/></span></div>
    </div>}
    {problem&&<small className="bi-expr-error">{problem}</small>}
  </div>
}
