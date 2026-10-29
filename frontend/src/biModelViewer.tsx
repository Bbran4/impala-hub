// Data model viewer (like Qlik's): tables as boxes with their fields, lines for how they connect.
// Used on Reporting → Data Model (all loaded tables, or one app) and in an app's data model settings.
import {useEffect,useMemo,useRef,useState,type PointerEvent as ReactPointerEvent} from 'react'
import {Database,KeyRound,Network,Search} from 'lucide-react'
import {supabase} from './supabase'
import {loadApp,loadApps,type AppSummary} from './biApps'
import {layoutGraph,modelLinks,sharedFieldLinks,type GraphLink,type GraphTable} from './biModelGraph'
import {loadDataTables,type DataTable} from './reportingData'

const BOX_W=220,HEAD=38,ROW=20,MAX_FIELDS=12

export function ModelDiagram({tables,links,emptyText}:{tables:GraphTable[];links:GraphLink[];emptyText?:string}){
  const [expanded,setExpanded]=useState<Set<string>>(new Set())
  const [hoverField,setHoverField]=useState<string|null>(null)
  const [picked,setPicked]=useState<string|null>(null)
  const [moved,setMoved]=useState<Record<string,{x:number;y:number}>>({})
  const drag=useRef<{name:string;dx:number;dy:number}|null>(null)
  const host=useRef<HTMLDivElement>(null)
  const linked=useMemo(()=>{const m=new Map<string,Set<string>>();for(const l of links){for(const [fa,fb] of l.fields){m.set(l.a,(m.get(l.a)||new Set()).add(fa));m.set(l.b,(m.get(l.b)||new Set()).add(fb))}}return m},[links])
  const shown=(t:GraphTable)=>{const keys=linked.get(t.name)||new Set();const ordered=[...t.columns.filter(c=>keys.has(c.name)),...t.columns.filter(c=>!keys.has(c.name)&&c.name!=='_bi_loaded_at')]
    return expanded.has(t.name)?ordered:ordered.slice(0,Math.max(MAX_FIELDS,keys.size))}
  const heights=Object.fromEntries(tables.map(t=>{const n=shown(t).length,more=t.columns.filter(c=>c.name!=='_bi_loaded_at').length>n;return [t.name,HEAD+n*ROW+(more?ROW:0)+8]}))
  const auto=useMemo(()=>layoutGraph(tables.map(t=>t.name),links,heights,BOX_W),[tables,links,JSON.stringify(heights)])// eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>setMoved({}),[tables,links])
  const pos=(n:string)=>moved[n]||auto.get(n)||{x:0,y:0}
  const fieldY=(t:GraphTable,field:string)=>{const i=shown(t).findIndex(c=>c.name===field);return pos(t.name).y+(i<0?HEAD/2:HEAD+i*ROW+ROW/2)}
  const byName=new Map(tables.map(t=>[t.name,t]))
  const width=Math.max(400,...tables.map(t=>pos(t.name).x+BOX_W+40)),height=Math.max(200,...tables.map(t=>pos(t.name).y+heights[t.name]+30))
  function start(event:ReactPointerEvent,name:string){
    const r=host.current!.getBoundingClientRect(),p=pos(name)
    drag.current={name,dx:event.clientX-r.left+host.current!.scrollLeft-p.x,dy:event.clientY-r.top+host.current!.scrollTop-p.y}
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);setPicked(name)
  }
  function move(event:ReactPointerEvent){
    if(!drag.current)return
    const r=host.current!.getBoundingClientRect()
    setMoved(m=>({...m,[drag.current!.name]:{x:Math.max(0,event.clientX-r.left+host.current!.scrollLeft-drag.current!.dx),y:Math.max(0,event.clientY-r.top+host.current!.scrollTop-drag.current!.dy)}}))
  }
  if(!tables.length)return <p className="bi-muted">{emptyText||'No tables'}</p>
  const pickedTable=picked?byName.get(picked):null
  const pickedLinks=picked?links.filter(l=>l.a===picked||l.b===picked):[]
  return <div className="bi-dm">
    <div className="bi-dm-canvas" ref={host} style={{height:`min(70vh, ${Math.max(320,height+24)}px)`}} onPointerMove={move} onPointerUp={()=>{drag.current=null}}>
      <svg width={width} height={height} className="bi-dm-lines">
        {links.flatMap((l,i)=>{const ta=byName.get(l.a),tb=byName.get(l.b);if(!ta||!tb)return []
          return l.fields.map(([fa,fb],k)=>{const pa=pos(l.a),pb=pos(l.b);const aRight=pa.x<pb.x
            const x1=aRight?pa.x+BOX_W:pa.x,x2=aRight?pb.x:pb.x+BOX_W,y1=fieldY(ta,fa),y2=fieldY(tb,fb)
            const bend=Math.max(40,Math.abs(x2-x1)/2)*(aRight?1:-1)
            const active=hoverField===fa||hoverField===fb||picked===l.a||picked===l.b
            return <path key={`${i}-${k}`} d={`M${x1},${y1}C${x1+bend},${y1} ${x2-bend},${y2} ${x2},${y2}`} className={`bi-dm-link ${l.kind} ${active?'active':''}`}/>})})}
      </svg>
      {tables.map(t=>{const p=pos(t.name),keys=linked.get(t.name)||new Set(),fields=shown(t),hidden=t.columns.filter(c=>c.name!=='_bi_loaded_at').length-fields.length
        return <div key={t.name} className={`bi-dm-table ${picked===t.name?'picked':''}`} style={{left:p.x,top:p.y,width:BOX_W}}>
          <div className="bi-dm-head" onPointerDown={event=>start(event,t.name)} title="Drag to move; click for details">
            <Database size={13}/><b>{t.name}</b>{t.source&&<span className={`bi-dm-source ${t.source}`}>{t.source}</span>}
            <small>{t.rows!=null?`${Number(t.rows).toLocaleString()} rows`:''}</small></div>
          {t.subtitle&&<div className="bi-dm-sub">{t.subtitle}</div>}
          {fields.map(c=><div key={c.name} className={`bi-dm-field ${keys.has(c.name)?'key':''} ${hoverField===c.name?'hover':''}`} onMouseEnter={()=>setHoverField(c.name)} onMouseLeave={()=>setHoverField(null)}>
            {keys.has(c.name)?<KeyRound size={11}/>:<span className="bi-dm-dot"/>}<span>{c.name}</span><small>{c.type.replace(' without time zone','').replace('timestamp with time zone','timestamptz')}</small></div>)}
          {hidden>0&&<button className="bi-dm-more" onClick={()=>setExpanded(s=>new Set(s).add(t.name))}>+ {hidden} more fields</button>}
        </div>})}
    </div>
    <aside className="bi-dm-side">{pickedTable?<>
      <h3>{pickedTable.name}</h3>{pickedTable.subtitle&&<p className="bi-muted">{pickedTable.subtitle}</p>}
      <p className="bi-muted">{pickedTable.rows!=null?`${Number(pickedTable.rows).toLocaleString()} rows · `:''}{pickedTable.columns.filter(c=>c.name!=='_bi_loaded_at').length} fields{pickedTable.source?` · ${pickedTable.source}`:''}</p>
      <div className="bi-section-title"><Network size={13}/>Connected to</div>
      {pickedLinks.length?pickedLinks.map((l,i)=><p key={i} className="bi-dm-linkline"><b>{l.a===picked?l.b:l.a}</b> on {l.fields.map(([fa,fb])=><code key={fa+fb}>{l.a===picked?fa:fb}{fa!==fb?` = ${l.a===picked?fb:fa}`:''}</code>)}</p>):<p className="bi-muted">Not connected to any other table.</p>}
      <div className="bi-section-title"><Database size={13}/>Fields</div>
      <ul className="bi-dm-fieldlist">{pickedTable.columns.filter(c=>c.name!=='_bi_loaded_at').map(c=><li key={c.name}><code>{c.name}</code><small>{c.type}</small></li>)}</ul>
    </>:<p className="bi-muted">Click a table's title for its fields and connections. Hover a field to follow it to other tables; drag titles to rearrange.</p>}</aside>
  </div>
}

// Reporting → Data Model
export function DataModelPage({setError}:{setError:(m:string)=>void}){
  const [tables,setTables]=useState<DataTable[]>([])
  const [apps,setApps]=useState<AppSummary[]>([])
  const [view,setView]=useState('all')
  const [keysOnly,setKeysOnly]=useState(true)
  const [search,setSearch]=useState('')
  const [appGraph,setAppGraph]=useState<{tables:GraphTable[];links:GraphLink[]}|null>(null)
  useEffect(()=>{if(!supabase)return
    loadDataTables(supabase).then(setTables).catch(error=>setError((error as Error).message))
    loadApps(supabase).then(setApps).catch(()=>setApps([]))},[setError])
  useEffect(()=>{if(view==='all'||!supabase){setAppGraph(null);return}
    loadApp(supabase,view).then(app=>setAppGraph({
      tables:app.model.map(t=>{const d=tables.find(x=>x.table_name===t.table_name);return {name:t.alias,columns:t.columns,rows:d?.row_count??null,source:d?.source||null,subtitle:t.alias!==t.table_name?`table ${t.table_name}`:undefined}}),
      links:modelLinks(app.model)})).catch(error=>setError((error as Error).message))},[view,tables,setError])
  const all=useMemo(()=>{
    const needle=search.trim().toLowerCase()
    const list:GraphTable[]=tables.filter(t=>!needle||t.table_name.includes(needle)||t.columns.some(c=>c.name.includes(needle)))
      .map(t=>({name:t.table_name,columns:t.columns,rows:t.row_count,source:t.source||null,subtitle:t.description||undefined}))
    return {tables:list,links:sharedFieldLinks(list,{keysOnly})}
  },[tables,keysOnly,search])
  const graph=view==='all'?all:appGraph
  return <section className="rfq-workspace">
    <div className="sd-session-bar"><Network size={18}/><span>Data model</span><small className="rp-live">{view==='all'?'All loaded tables: lines join fields with the same name, which apps can link on.':'The links this app uses.'}</small></div>
    <div className="rp-toolbar bi-dm-tools">
      <label className="rp-field">Show<select value={view} onChange={event=>setView(event.target.value)}><option value="all">All loaded tables</option>{apps.map(a=><option key={a.id} value={a.id}>App: {a.name}</option>)}</select></label>
      {view==='all'&&<><label className="rp-search"><Search size={15}/><input placeholder="Find a table or field" value={search} onChange={event=>setSearch(event.target.value)}/></label>
        <label className="bi-check"><input type="checkbox" checked={keysOnly} onChange={event=>setKeysOnly(event.target.checked)}/>Only key-like fields (…_code, …_no, …_id)</label></>}
    </div>
    {graph?<ModelDiagram tables={graph.tables} links={graph.links} emptyText={view==='all'?'No tables are loaded yet.':'This app has no tables.'}/>:<p className="bi-muted">Loading…</p>}
  </section>
}
