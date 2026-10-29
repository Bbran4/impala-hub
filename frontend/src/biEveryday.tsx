// Everyday tools in an app: bookmarks, smart search and exports.
import {useEffect,useRef,useState} from 'react'
import {Bookmark as BookmarkIcon,Download,FileSpreadsheet,Printer,Search,Share2,Trash2,X} from 'lucide-react'
import {supabase} from './supabase'
import {
  NO_DATA_KINDS,bookmarkState,buildSpec,compileObject,defaultSort,deleteBookmark,displayValue,loadBookmarks,runQuery,saveBookmark,searchValues,
  type AppDetail,type Bookmark,type FieldValue,type SearchHit,type Selection,type Sheet,type SheetObject,
} from './biApps'
import {downloadWorkbook,type ExportTable} from './biExport'
import type {ExprNode} from './biExpression'

// Closes a dropdown when clicking elsewhere
function useOutside(open:boolean,close:()=>void){
  const ref=useRef<HTMLDivElement>(null)
  useEffect(()=>{if(!open)return
    const handler=(event:MouseEvent)=>{if(ref.current&&!ref.current.contains(event.target as Node))close()}
    document.addEventListener('mousedown',handler);return()=>document.removeEventListener('mousedown',handler)},[open,close])
  return ref
}

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------
export function BookmarkMenu({app,canBuild,sheetId,selections,states,variables,onApply,setNotice,setError}:{
  app:AppDetail;canBuild:boolean;sheetId:string|null;selections:Selection[];states:Record<string,Selection[]>;variables:Record<string,string>
  onApply:(bookmark:Bookmark)=>void;setNotice:(m:string)=>void;setError:(m:string)=>void
}){
  const [open,setOpen]=useState(false)
  const [list,setList]=useState<Bookmark[]>([])
  const [name,setName]=useState('')
  const [shared,setShared]=useState(false)
  const [busy,setBusy]=useState(false)
  const ref=useOutside(open,()=>setOpen(false))
  const load=()=>{if(supabase)loadBookmarks(supabase,app.id).then(setList).catch(error=>setError((error as Error).message))}
  useEffect(()=>{if(open)load()},[open])// eslint-disable-line react-hooks/exhaustive-deps
  async function save(){
    if(!supabase||!name.trim())return
    setBusy(true)
    try{await saveBookmark(supabase,app.id,{name:name.trim(),shared,sheet_id:sheetId,...bookmarkState(selections,states),variables});setName('');setShared(false);setNotice(`Bookmark "${name.trim()}" saved.`);load()}
    catch(error){setError((error as Error).message)}finally{setBusy(false)}
  }
  async function remove(bookmark:Bookmark){
    if(!supabase||!confirm(`Delete the bookmark "${bookmark.name}"?`))return
    try{await deleteBookmark(supabase,bookmark.id);load()}catch(error){setError((error as Error).message)}
  }
  const count=selections.filter(s=>s.values.length).length
  return <div className="bi-menu" ref={ref}>
    <button className="secondary" onClick={()=>setOpen(!open)} aria-expanded={open}><BookmarkIcon size={15}/>Bookmarks</button>
    {open&&<div className="bi-menu-pop bi-bookmarks">
      <div className="bi-menu-title">Bookmarks</div>
      {!list.length&&<p className="bi-muted">None yet. Save the current selections to come back to them.</p>}
      <ul>{list.map(b=><li key={b.id}>
        <button className="bi-bookmark" onClick={()=>{onApply(b);setOpen(false)}}>
          <b>{b.name}</b>{b.shared&&<span className="bi-pill"><Share2 size={10}/>Shared</span>}
          <small>{b.selections.length?b.selections.map(s=>`${s.label}: ${s.values.slice(0,2).map(v=>displayValue(v)).join(', ')}${s.values.length>2?'…':''}`).join(' · '):'No selections'}{!b.mine&&b.owner_name?` — ${b.owner_name}`:''}</small>
        </button>
        {(b.mine||(b.shared&&canBuild))&&<button className="icon-button" aria-label={`Delete ${b.name}`} onClick={()=>void remove(b)}><Trash2 size={13}/></button>}
      </li>)}</ul>
      <div className="bi-menu-form">
        <input placeholder={count===1?'Name for this selection':count?`Name for these ${count} selections`:'Name (saves the sheet, no selections)'} value={name} maxLength={80} onChange={event=>setName(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')void save()}}/>
        {canBuild&&<label className="bi-check"><input type="checkbox" checked={shared} onChange={event=>setShared(event.target.checked)}/>Share with everyone who can open this app</label>}
        <button className="primary" disabled={!name.trim()||busy} onClick={()=>void save()}>Save bookmark</button>
      </div>
    </div>}
  </div>
}

// ---------------------------------------------------------------------------
// Smart search: type to find values in any field, click to select
// ---------------------------------------------------------------------------
export function SmartSearch({app,selections,onPick}:{app:AppDetail;selections:Selection[];onPick:(hit:SearchHit,value:FieldValue)=>void}){
  const [text,setText]=useState('')
  const [hits,setHits]=useState<SearchHit[]|null>(null)
  const [loading,setLoading]=useState(false)
  const ref=useOutside(hits!==null,()=>setHits(null))
  useEffect(()=>{
    const needle=text.trim()
    if(needle.length<2||!supabase){setHits(null);return}
    let alive=true
    setLoading(true)
    const timer=setTimeout(()=>{searchValues(supabase!,app.id,needle,selections).then(result=>{if(alive)setHits(result)}).catch(()=>{if(alive)setHits([])}).finally(()=>{if(alive)setLoading(false)})},300)
    return()=>{alive=false;clearTimeout(timer)}
  },[text,app.id,selections])
  const label=(hit:SearchHit)=>{const table=app.model.find(t=>t.alias===hit.table);return `${hit.field.replace(/_/g,' ')}${app.model.length>1&&table?` (${table.alias})`:''}`}
  return <div className="bi-menu bi-smart-search" ref={ref}>
    <label className="bi-search-box"><Search size={14}/><input placeholder="Search all fields…" value={text} onChange={event=>setText(event.target.value)} onKeyDown={event=>{if(event.key==='Escape'){setText('');setHits(null)}}}/>
      {text&&<button type="button" aria-label="Clear search" onClick={()=>{setText('');setHits(null)}}><X size={12}/></button>}</label>
    {hits!==null&&<div className="bi-menu-pop bi-search-results">
      {loading&&<p className="bi-muted">Searching…</p>}
      {!loading&&!hits.length&&<p className="bi-muted">No values contain "{text.trim()}".</p>}
      {hits.map(hit=><div key={hit.table+hit.field} className="bi-search-group"><div className="bi-menu-title">{label(hit)}</div>
        <div className="bi-rule-chips">{hit.values.map((value,i)=><button key={i} className="bi-chip" onClick={()=>{onPick(hit,value);setText('');setHits(null)}}>{displayValue(value)}</button>)}
          {hit.more&&<span className="bi-muted">and more…</span>}</div></div>)}
    </div>}
  </div>
}

// ---------------------------------------------------------------------------
// Exports: the sheet as PDF (the browser's print to PDF) or every chart's data as Excel
// ---------------------------------------------------------------------------
export async function objectTable(object:SheetObject,app:AppDetail,selections:Selection[],extraConditions:ExprNode[]=[]):Promise<ExportTable|null>{
  if(NO_DATA_KINDS.includes(object.kind)||['tabs','layout','trellis','filter','animator','button','datepicker','variable','slider'].includes(object.kind)||!supabase)return null
  const compiled=compileObject(object,app,extraConditions,selections)
  if(compiled.errors.length||!compiled.dimensions.length&&!compiled.measures.length)return null
  const result=await runQuery(supabase,app.id,buildSpec(compiled,selections,{sort:defaultSort(object,compiled),limit:10000}))
  return {title:object.title||compiled.measures[0]?.label||compiled.dimensions[0]?.label||object.kind,
    headers:[...compiled.dimensions.map(d=>d.label),...compiled.measures.map(m=>m.label)],
    formats:[...compiled.dimensions.map(d=>d.format),...compiled.measures.map(m=>m.format)],rows:result.rows}
}

export function ExportMenu({app,sheet,selectionsFor,setError}:{app:AppDetail;sheet:Sheet;selectionsFor:(object:SheetObject)=>Selection[];setError:(m:string)=>void}){
  const [open,setOpen]=useState(false)
  const [busy,setBusy]=useState(false)
  const ref=useOutside(open,()=>setOpen(false))
  async function excel(){
    setBusy(true)
    try{
      const tables=(await Promise.all(sheet.objects.map(object=>objectTable(object,app,selectionsFor(object))))).filter((t):t is ExportTable=>Boolean(t))
      if(!tables.length){setError('This sheet has no charts or tables to export.');return}
      await downloadWorkbook(tables,`${app.name} - ${sheet.title}`)
      setOpen(false)
    }catch(error){setError((error as Error).message)}finally{setBusy(false)}
  }
  function print(){
    setOpen(false)
    document.body.classList.add('bi-printing')
    const done=()=>{document.body.classList.remove('bi-printing');window.removeEventListener('afterprint',done)}
    window.addEventListener('afterprint',done)
    setTimeout(()=>window.print(),50)
  }
  return <div className="bi-menu" ref={ref}>
    <button className="secondary" onClick={()=>setOpen(!open)} aria-expanded={open}><Download size={15}/>Export</button>
    {open&&<div className="bi-menu-pop bi-export">
      <button className="bi-menu-item" onClick={print}><Printer size={15}/><span><b>PDF or print</b><small>The sheet as you see it, with the current selections. Choose "Save as PDF" in the print window.</small></span></button>
      <button className="bi-menu-item" disabled={busy} onClick={()=>void excel()}><FileSpreadsheet size={15}/><span><b>{busy?'Exporting…':'Excel'}</b><small>The data of every chart and table on this sheet, one tab each (up to 10,000 rows).</small></span></button>
    </div>}
  </div>
}
