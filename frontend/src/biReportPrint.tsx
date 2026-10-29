// The page headless Chrome opens to draw a sheet for a report email: /#report-print=<ticket>.
// Signed out; the ticket stands in for the recipient (their access and row access apply).
import {useEffect,useMemo,useState} from 'react'
import {supabase} from './supabase'
import {normalizeApp,pendingRequests,setRenderTicket,type AppDetail,type Selection} from './biApps'
import type {ExprNode} from './biExpression'
import {objectTable} from './biEveryday'
import type {AppRuntime} from './biChartKit'
import {SheetCanvas} from './ReportingApps'
import './reporting.css'
import './reportingApps.css'

// #report-print=<ticket>[&excel=1]
export function printTicket(hash:string){const m=/^#report-print=([A-Za-z0-9]{32,128})(&excel=1)?$/.exec(hash);return m?m[1]:null}
type Filter={selections:Selection[];states:Record<string,Selection[]>;variables:Record<string,string>;conditions:ExprNode[]}
declare global{interface Window{__reportTables?:unknown}}

export default function ReportPrint({ticket}:{ticket:string}){
  const [data,setData]=useState<{app:AppDetail;sheet_id:string;recipient:string;filter?:Filter}|null>(null)
  const [excel]=useState(()=>location.hash.includes('&excel=1'))
  const [error,setError]=useState('')
  useEffect(()=>{
    setRenderTicket(ticket)
    history.replaceState(null,'',location.pathname)
    if(!supabase){setError('Not configured');return}
    supabase.rpc('bi_render_app',{p_ticket:ticket}).then(({data:result,error:failure})=>{
      if(failure){setError(failure.message);return}
      setData({...result,app:normalizeApp(result.app)})
    })
  },[ticket])
  // tell the renderer when every chart has its data (no requests for a second) and images have loaded
  useEffect(()=>{
    if(error){document.body.dataset.reportError=error;return}
    if(!data)return
    const started=Date.now();let quiet=0
    const timer=setInterval(()=>{
      const images=[...document.images].every(img=>img.complete)
      quiet=pendingRequests()===0&&images&&!document.querySelector('.is-loading')?quiet+1:0
      if(quiet>=4&&Date.now()-started>1500){document.body.dataset.reportReady='1';clearInterval(timer);if(excel)void collectTables()}
    },250)
    return()=>clearInterval(timer)
  },[data,error])
  const filter=data?.filter
  const app=useMemo(()=>data?{...data.app,variableValues:{...Object.fromEntries(data.app.variables.map(v=>[v.name,v.value])),...(data.filter?.variables||{})},
    stateSelections:{Main:data.filter?.selections||[],...(data.filter?.states||{})}}:null,[data])
  // Excel attachment: every chart's data, read the same way (as the recipient, with the filter)
  async function collectTables(){
    try{
      const current=app?.sheets.find(s=>s.id===data?.sheet_id)
      if(!app||!current){window.__reportTables=[];return}
      const tables=await Promise.all(current.objects.map(object=>objectTable(object,app,object.options.state?filter?.states?.[object.options.state]||[]:filter?.selections||[],filter?.conditions||[]).catch(()=>null)))
      window.__reportTables=tables.filter(Boolean)
    }catch{window.__reportTables=[]}
    document.body.dataset.excelReady='1'
  }
  const sheet=app?.sheets.find(s=>s.id===data?.sheet_id)||null
  const runtime=useMemo<AppRuntime|undefined>(()=>app&&sheet?{objects:sheet.objects,sheets:app.sheets.map(s=>({id:s.id,title:s.title})),sheetId:sheet.id,editing:false,
    variables:app.variables,values:app.variableValues||{},goToSheet:()=>{},setVariable:()=>{},clearSelections:()=>{},setSelection:()=>{}}:undefined,[app,sheet])
  if(error)return <div className="bi-print-error">{error}</div>
  if(!app||!sheet)return <div className="bi-print-loading">Loading…</div>
  const stamp=new Date().toLocaleString('en-ZA',{weekday:'long',day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'})
  return <main className="bi-print">
    <header className="bi-print-head"><div><b>{app.name}</b><span>{sheet.title}</span></div><small>{stamp} · for {data!.recipient}</small></header>
    {filter&&filter.selections.length>0&&<div className="bi-print-filter">{filter.selections.map(s=>`${s.label}: ${s.values.slice(0,4).join(', ')}${s.values.length>4?'…':''}`).join(' · ')}</div>}
    <SheetCanvas sheet={sheet} app={app} runtime={runtime} editing={false} selections={filter?.selections||[]} stateSelections={filter?.states||{}} extraConditions={filter?.conditions}
      onSelect={()=>{}} version="" selectedObject={null} onPick={()=>{}} onChange={()=>{}}/>
  </main>
}
