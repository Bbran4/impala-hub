import {useCallback,useEffect,useMemo,useRef,useState,type PointerEvent as ReactPointerEvent} from 'react'
import {
  ArrowLeft,BarChart3,Copy,Database,Filter,GripVertical,LayoutGrid,LineChart,Link2,Pencil,PieChart,Plus,Save,Settings2,
  Sigma,Table2,Trash2,Type,Users,X,Grid3x3,Gauge,
} from 'lucide-react'
import {supabase} from './supabase'
import {checkFields,FUNCTIONS,parseExpression,type MasterMeasure} from './biExpression'
import {
  GRID_COLS,KIND_INFO,ROW_HEIGHT,compileObject,deleteApp,deleteSheet,displayValue,freeSpot,loadApp,loadApps,loadPrincipals,
  modelProblems,newId,normalizeObject,orderedModel,resolveLayout,saveApp,saveSheet,suggestLinks,toggleSelection,
  type AccessEntry,type AppDetail,type AppSummary,type ModelTable,type NumberFormat,type ObjectKind,
  type Principals,type Selection,type Sheet,type SheetObject,
} from './biApps'
import {loadDataTables,ago,type DataTable} from './reportingData'
import {ObjectBody,type SelectFn} from './biCharts'
import './reportingApps.css'

type Props={canBuild:boolean;setNotice:(message:string)=>void;setError:(message:string)=>void}

const KIND_ICONS:Record<ObjectKind,typeof BarChart3>={kpi:Gauge,bar:BarChart3,line:LineChart,pie:PieChart,table:Table2,pivot:Grid3x3,filter:Filter,text:Type}
const FORMATS:[NumberFormat,string][]=[['auto','Automatic'],['number','Number'],['integer','Whole number'],['money','Rand (R)'],['percent','Percent']]

export default function ReportingApps({canBuild,setNotice,setError}:Props){
  const [openId,setOpenId]=useState<string|null>(()=>{try{return sessionStorage.getItem('bi-open-app')}catch{return null}})
  const [creating,setCreating]=useState(false)
  useEffect(()=>{try{openId?sessionStorage.setItem('bi-open-app',openId):sessionStorage.removeItem('bi-open-app')}catch{/* storage unavailable */}},[openId])
  if(creating)return <AppSettings app={null} onClose={()=>setCreating(false)} onSaved={id=>{setCreating(false);setOpenId(id)}} setNotice={setNotice} setError={setError}/>
  if(openId)return <AppView appId={openId} canBuild={canBuild} onBack={()=>setOpenId(null)} setNotice={setNotice} setError={setError}/>
  return <AppHub canBuild={canBuild} onOpen={setOpenId} onCreate={()=>setCreating(true)} setError={setError}/>
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------
function AppHub({canBuild,onOpen,onCreate,setError}:{canBuild:boolean;onOpen:(id:string)=>void;onCreate:()=>void;setError:(m:string)=>void}){
  const [apps,setApps]=useState<AppSummary[]|null>(null)
  useEffect(()=>{if(supabase)loadApps(supabase).then(setApps).catch(error=>{setError((error as Error).message);setApps([])})},[setError])
  const now=new Date()
  return <section className="rfq-workspace">
    <div className="sd-session-bar"><LayoutGrid size={18}/><span>Apps</span>{canBuild&&<button className="primary" onClick={onCreate}><Plus size={15}/>Create app</button>}</div>
    {apps&&!apps.length&&<div className="rfq-empty-card"><LayoutGrid size={26}/><h3>No apps yet</h3><p>{canBuild?'Create an app: choose the loaded ERP tables it uses, link them, then build dashboard sheets.':'No apps have been shared with you yet. Ask an administrator or report builder.'}</p></div>}
    <div className="bi-app-grid">{(apps||[]).map(app=><button key={app.id} className="bi-app-card" onClick={()=>onOpen(app.id)}>
      <div className="bi-app-card-icon"><BarChart3 size={22}/></div>
      <h3>{app.name}</h3><p>{app.description||'No description'}</p>
      <div className="bi-app-meta"><span>{app.sheets.length} sheet{app.sheets.length===1?'':'s'}</span><span>{app.tables.length} table{app.tables.length===1?'':'s'}</span><span>Data {ago(app.last_loaded_at,now).toLowerCase()}</span></div>
    </button>)}</div>
  </section>
}

// ---------------------------------------------------------------------------
// App view: sheets, selections, editing
// ---------------------------------------------------------------------------
function AppView({appId,canBuild,onBack,setNotice,setError}:{appId:string;canBuild:boolean;onBack:()=>void;setNotice:(m:string)=>void;setError:(m:string)=>void}){
  const [app,setApp]=useState<AppDetail|null>(null)
  const [sheetId,setSheetId]=useState<string|null>(null)
  const [selections,setSelections]=useState<Selection[]>([])
  const [editing,setEditing]=useState<Sheet|null>(null)
  const [selectedObject,setSelectedObject]=useState<string|null>(null)
  const [settings,setSettings]=useState(false)
  const [saving,setSaving]=useState(false)
  const [version,setVersion]=useState('')
  const load=useCallback(async(keepSheet?:string|null)=>{
    try{
      const loaded=await loadApp(supabase!,appId)
      setApp(loaded);setVersion(loaded.model.map(table=>table.last_loaded_at||'').join('|'))
      setSheetId(current=>{const wanted=keepSheet??current;return loaded.sheets.some(sheet=>sheet.id===wanted)?wanted:loaded.sheets[0]?.id||null})
    }catch(error){setError((error as Error).message);onBack()}
  },[appId,onBack,setError])
  useEffect(()=>{void load()},[load])
  // pick up fresh data from the sync agent every minute
  useEffect(()=>{const timer=setInterval(()=>{if(document.visibilityState==='visible'&&!editing)void load()},60000);return()=>clearInterval(timer)},[load,editing])

  const sheet=editing||app?.sheets.find(item=>item.id===sheetId)||null
  const onSelect:SelectFn=(dimension,value,additive)=>{if(!editing)setSelections(current=>toggleSelection(current,dimension,value,additive))}

  async function addSheet(){
    if(!app)return
    try{const title=`Sheet ${app.sheets.length+1}`;const id=await saveSheet(supabase!,app.id,{title,objects:[]});await load(id);setEditing({id,title,position:app.sheets.length,objects:[]});setSelectedObject(null)}
    catch(error){setError((error as Error).message)}
  }
  async function saveEditing(){
    if(!app||!editing)return
    setSaving(true)
    try{await saveSheet(supabase!,app.id,{id:editing.id,title:editing.title,position:editing.position,objects:editing.objects});setEditing(null);setSelectedObject(null);await load(editing.id);setNotice('Sheet saved.')}
    catch(error){setError((error as Error).message)}finally{setSaving(false)}
  }
  async function duplicateSheet(){
    if(!app||!sheet)return
    try{const id=await saveSheet(supabase!,app.id,{title:`${sheet.title} (copy)`,objects:sheet.objects.map(object=>({...object,id:newId()}))});await load(id);setNotice('Sheet duplicated.')}
    catch(error){setError((error as Error).message)}
  }
  async function removeSheet(){
    if(!app||!sheet||!confirm(`Delete the sheet "${sheet.title}"? This cannot be undone.`))return
    try{await deleteSheet(supabase!,sheet.id);setEditing(null);await load(null);setNotice('Sheet deleted.')}
    catch(error){setError((error as Error).message)}
  }
  function cancelEditing(){
    if(editing&&JSON.stringify(editing)!==JSON.stringify(app?.sheets.find(s=>s.id===editing.id))&&!confirm('Discard your changes to this sheet?'))return
    setEditing(null);setSelectedObject(null)
  }

  if(!app)return <section className="rfq-workspace"><div className="sd-session-bar"><span>Loading app…</span></div></section>
  if(settings)return <AppSettings app={app} onClose={()=>setSettings(false)} onSaved={async()=>{setSettings(false);setSelections([]);await load()}} onDeleted={onBack} setNotice={setNotice} setError={setError}/>

  return <section className="bi-app">
    <div className="bi-app-bar">
      <button className="secondary" onClick={()=>editing?cancelEditing():onBack()}><ArrowLeft size={15}/>{editing?'Stop editing':'Apps'}</button>
      <div className="bi-app-title"><b>{app.name}</b>{app.description&&<small>{app.description}</small>}</div>
      {canBuild&&!editing&&<div className="bi-app-actions">
        <button className="secondary" onClick={()=>setSettings(true)}><Settings2 size={15}/>Data model &amp; sharing</button>
        {sheet&&<button className="secondary" onClick={()=>{setEditing(structuredClone(sheet));setSelectedObject(null)}}><Pencil size={15}/>Edit sheet</button>}
      </div>}
      {editing&&<div className="bi-app-actions">
        <button className="secondary" onClick={()=>void duplicateSheet()} disabled={saving}><Copy size={15}/>Duplicate</button>
        <button className="secondary danger" onClick={()=>void removeSheet()} disabled={saving}><Trash2 size={15}/>Delete sheet</button>
        <button className="secondary" onClick={cancelEditing} disabled={saving}>Cancel</button>
        <button className="primary" onClick={()=>void saveEditing()} disabled={saving}><Save size={15}/>{saving?'Saving…':'Save sheet'}</button>
      </div>}
    </div>

    <div className="bi-sheet-tabs">
      {app.sheets.map(item=><button key={item.id} className={item.id===sheet?.id?'active':''} disabled={Boolean(editing)&&item.id!==editing?.id} onClick={()=>setSheetId(item.id)}>{item.id===editing?.id?editing.title:item.title}</button>)}
      {canBuild&&!editing&&<button className="bi-add-sheet" onClick={()=>void addSheet()}><Plus size={14}/>Sheet</button>}
    </div>

    {!editing&&<SelectionsBar selections={selections} onClear={key=>setSelections(current=>key?current.filter(item=>item.key!==key):[])}/>}

    {!sheet&&<div className="rfq-empty-card"><LayoutGrid size={26}/><h3>No sheets yet</h3><p>{canBuild?'Add a sheet, then add charts, tables and filters to it.':'This app has no sheets yet.'}</p></div>}
    {sheet&&<div className={`bi-workarea ${editing?'editing':''}`}>
      {editing&&<ObjectPalette onAdd={kind=>{const info=KIND_INFO[kind];const spot=freeSpot(editing.objects,info.w,info.h)
        const object=normalizeObject({id:newId(),kind,title:'',...spot,w:info.w,h:info.h,dimensions:kind==='kpi'||kind==='text'?[]:[{expr:''}],measures:kind==='filter'||kind==='text'?[]:[{expr:''}],options:kind==='text'?{text:''}:{}})
        setEditing({...editing,objects:[...editing.objects,object]});setSelectedObject(object.id)}}/>}
      <SheetCanvas sheet={sheet} app={app} editing={Boolean(editing)} selections={selections} onSelect={onSelect} version={version}
        selectedObject={selectedObject} onPick={setSelectedObject}
        onChange={objects=>editing&&setEditing({...editing,objects})}/>
      {editing&&<SidePanel app={app} sheet={editing} objectId={selectedObject}
        onSheet={title=>setEditing({...editing,title})}
        onObject={object=>setEditing({...editing,objects:editing.objects.map(item=>item.id===object.id?object:item)})}
        onDelete={id=>{setEditing({...editing,objects:resolveLayout(editing.objects.filter(item=>item.id!==id))});setSelectedObject(null)}}
        onClose={()=>setSelectedObject(null)}/>}
    </div>}
  </section>
}

function SelectionsBar({selections,onClear}:{selections:Selection[];onClear:(key?:string)=>void}){
  return <div className="bi-selections">
    {!selections.length?<span className="bi-muted">No selections. Click a bar, slice, row or filter value to filter every chart in this app; Ctrl+click adds to a selection.</span>
      :<>{selections.map(item=><span key={item.key} className="bi-chip"><b>{item.label}</b>{item.values.length<=3?item.values.map(value=>displayValue(value)).join(', '):`${item.values.length} of values`}
        <button aria-label={`Clear ${item.label}`} onClick={()=>onClear(item.key)}><X size={12}/></button></span>)}
        <button className="text-button" onClick={()=>onClear()}>Clear all</button></>}
  </div>
}

function ObjectPalette({onAdd}:{onAdd:(kind:ObjectKind)=>void}){
  return <aside className="bi-palette"><span className="nav-label">ADD</span>{(Object.keys(KIND_INFO) as ObjectKind[]).map(kind=>{const Icon=KIND_ICONS[kind];return <button key={kind} title={KIND_INFO[kind].hint} onClick={()=>onAdd(kind)}><Icon size={18}/><span>{KIND_INFO[kind].label}</span></button>})}</aside>
}

// ---------------------------------------------------------------------------
// Sheet canvas (24-column grid; drag the header to move, the corner to resize)
// ---------------------------------------------------------------------------
function SheetCanvas({sheet,app,editing,selections,onSelect,version,selectedObject,onPick,onChange}:{
  sheet:Sheet;app:AppDetail;editing:boolean;selections:Selection[];onSelect:SelectFn;version:string
  selectedObject:string|null;onPick:(id:string|null)=>void;onChange:(objects:SheetObject[])=>void
}){
  const ref=useRef<HTMLDivElement>(null)
  const [drag,setDrag]=useState<{id:string;mode:'move'|'resize';startX:number;startY:number;orig:SheetObject;current:SheetObject}|null>(null)
  const [width,setWidth]=useState(1000)
  useEffect(()=>{if(!ref.current)return;const observer=new ResizeObserver(([entry])=>setWidth(entry.contentRect.width));observer.observe(ref.current);return()=>observer.disconnect()},[])
  const narrow=width<720&&!editing
  const col=width/GRID_COLS
  const objects=sheet.objects.map(object=>drag&&object.id===drag.id?drag.current:object)
  const height=Math.max(8,...objects.map(object=>object.y+object.h))*ROW_HEIGHT+(editing?ROW_HEIGHT*4:0)

  function start(event:ReactPointerEvent,object:SheetObject,mode:'move'|'resize'){
    if(!editing)return
    event.preventDefault();event.stopPropagation();onPick(object.id)
    ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
    setDrag({id:object.id,mode,startX:event.clientX,startY:event.clientY,orig:object,current:object})
  }
  function move(event:ReactPointerEvent){
    if(!drag)return
    const dx=Math.round((event.clientX-drag.startX)/col),dy=Math.round((event.clientY-drag.startY)/ROW_HEIGHT)
    const o=drag.orig
    const current=drag.mode==='move'
      ?{...o,x:Math.max(0,Math.min(GRID_COLS-o.w,o.x+dx)),y:Math.max(0,o.y+dy)}
      :{...o,w:Math.max(2,Math.min(GRID_COLS-o.x,o.w+dx)),h:Math.max(2,o.h+dy)}
    if(current.x!==drag.current.x||current.y!==drag.current.y||current.w!==drag.current.w||current.h!==drag.current.h)setDrag({...drag,current})
  }
  function end(){
    if(!drag)return
    onChange(resolveLayout(sheet.objects.map(object=>object.id===drag.id?drag.current:object),drag.id))
    setDrag(null)
  }

  return <div className={`bi-canvas ${editing?'editing':''} ${narrow?'narrow':''}`} ref={ref} style={narrow?undefined:{height}}
    onPointerMove={move} onPointerUp={end} onPointerCancel={end} onClick={event=>{if(editing&&event.target===event.currentTarget)onPick(null)}}>
    {editing&&<div className="bi-grid-lines" style={{backgroundSize:`${col}px ${ROW_HEIGHT}px`}}/>}
    {(narrow?[...objects].sort((a,b)=>a.y-b.y||a.x-b.x):objects).map(object=>{const Icon=KIND_ICONS[object.kind]
      const style=narrow?{height:Math.max(3,object.h)*ROW_HEIGHT}:{left:object.x*col,top:object.y*ROW_HEIGHT,width:object.w*col,height:object.h*ROW_HEIGHT}
      return <div key={object.id} className={`bi-object ${object.kind} ${selectedObject===object.id?'picked':''} ${drag?.id===object.id?'dragging':''}`} style={style}
        onClick={()=>editing&&onPick(object.id)}>
        <div className="bi-object-inner">
          {(object.title||editing)&&<div className={`bi-object-head ${editing?'handle':''}`} onPointerDown={event=>start(event,object,'move')}>
            {editing&&<GripVertical size={14}/>}<span>{object.title||(editing?<i className="bi-muted"><Icon size={13}/> {KIND_INFO[object.kind].label}</i>:'')}</span>
          </div>}
          <div className="bi-object-body"><ObjectBody object={object} app={app} selections={editing?[]:selections} onSelect={onSelect} dataVersion={version}/></div>
        </div>
        {editing&&<div className="bi-resize" onPointerDown={event=>start(event,object,'resize')} title="Drag to resize"/>}
      </div>})}
    {editing&&!objects.length&&<div className="bi-canvas-empty">Add charts, tables and filters from the left.</div>}
  </div>
}

// ---------------------------------------------------------------------------
// Side panel: sheet title and object properties
// ---------------------------------------------------------------------------
function SidePanel({app,sheet,objectId,onSheet,onObject,onDelete,onClose}:{
  app:AppDetail;sheet:Sheet;objectId:string|null;onSheet:(title:string)=>void;onObject:(object:SheetObject)=>void;onDelete:(id:string)=>void;onClose:()=>void
}){
  const object=sheet.objects.find(item=>item.id===objectId)
  if(!object)return <aside className="bi-panel">
    <h3>Sheet</h3>
    <label>Title<input value={sheet.title} maxLength={120} onChange={event=>onSheet(event.target.value)}/></label>
    <p className="hint">Click an object to change it. Drag an object by its header to move it, and by its bottom-right corner to resize it.</p>
    <FieldList app={app}/>
  </aside>
  const info=KIND_INFO[object.kind]
  const compiled=compileObject(object,app)
  const set=(changes:Partial<SheetObject>)=>onObject({...object,...changes})
  const setOption=(changes:Partial<SheetObject['options']>)=>set({options:{...object.options,...changes}})
  const columns=[...object.dimensions.map((d,i)=>d.label||d.expr||`Dimension ${i+1}`),...object.measures.map((m,i)=>m.label||m.expr||`Measure ${i+1}`)]
  return <aside className="bi-panel">
    <div className="bi-panel-head"><h3>{info.label}</h3><button className="icon-button" aria-label="Close" onClick={onClose}><X size={16}/></button></div>
    <label>Type<select value={object.kind} onChange={event=>{const kind=event.target.value as ObjectKind;const next=KIND_INFO[kind]
      set({kind,dimensions:object.dimensions.slice(0,next.dims[1]),measures:object.measures.slice(0,next.measures[1])})}}>
      {(Object.keys(KIND_INFO) as ObjectKind[]).map(kind=><option key={kind} value={kind}>{KIND_INFO[kind].label}</option>)}</select></label>
    <p className="hint">{info.hint}</p>
    <label>Title<input value={object.title} maxLength={120} onChange={event=>set({title:event.target.value})}/></label>
    {object.kind==='text'&&<label>Text<textarea rows={5} value={object.options.text||''} onChange={event=>setOption({text:event.target.value})}/></label>}

    {info.dims[1]>0&&<ItemList title="Dimensions" kind="dimension" app={app} items={object.dimensions} max={info.dims[1]} onChange={dimensions=>set({dimensions})}/>}
    {info.measures[1]>0&&<ItemList title="Measures" kind="measure" app={app} items={object.measures} max={info.measures[1]} onChange={measures=>set({measures})}/>}

    {object.kind!=='text'&&<details className="bi-section" open={Boolean(object.options.conditions?.length)}>
      <summary>Conditions</summary>
      <p className="hint">Only rows matching every condition are used, for example <code>invoice_date = Today()-1</code>.</p>
      {(object.options.conditions||[]).map((condition,i)=><div key={i} className="bi-row">
        <ExpressionInput app={app} value={condition} kind="condition" onChange={value=>setOption({conditions:(object.options.conditions||[]).map((c,j)=>j===i?value:c)})}/>
        <button className="icon-button" aria-label="Remove condition" onClick={()=>setOption({conditions:(object.options.conditions||[]).filter((_,j)=>j!==i)})}><Trash2 size={14}/></button></div>)}
      <button className="text-button" onClick={()=>setOption({conditions:[...(object.options.conditions||[]),'']})}><Plus size={13}/>Add condition</button>
    </details>}

    {['bar','line','pie','table'].includes(object.kind)&&<details className="bi-section">
      <summary>Sorting and display</summary>
      {object.kind!=='pie'&&<label>Sort by<select value={object.options.sortBy??''} onChange={event=>setOption({sortBy:event.target.value===''?undefined:Number(event.target.value)})}>
        <option value="">Automatic</option>{columns.map((name,i)=><option key={i} value={i}>{name}</option>)}</select></label>}
      {object.options.sortBy!=null&&<label className="bi-check"><input type="checkbox" checked={Boolean(object.options.sortDesc)} onChange={event=>setOption({sortDesc:event.target.checked})}/>Largest / latest first</label>}
      {(object.kind==='bar'||object.kind==='line')&&<label>Maximum values<input type="number" min={1} max={1000} value={object.options.limit||''} placeholder={object.kind==='line'?'500':'100'} onChange={event=>setOption({limit:event.target.value?Math.max(1,Math.min(1000,Number(event.target.value))):undefined})}/></label>}
      {object.kind==='bar'&&<label className="bi-check"><input type="checkbox" checked={Boolean(object.options.horizontal)} onChange={event=>setOption({horizontal:event.target.checked})}/>Horizontal bars</label>}
      {object.kind==='bar'&&<label className="bi-check"><input type="checkbox" checked={Boolean(object.options.stacked)} onChange={event=>setOption({stacked:event.target.checked})}/>Stack the second dimension</label>}
      {object.kind==='table'&&<label className="bi-check"><input type="checkbox" checked={object.options.totals!==false} onChange={event=>setOption({totals:event.target.checked})}/>Show totals</label>}
    </details>}

    {compiled.errors.length>0&&<div className="bi-panel-errors">{compiled.errors.map((error,i)=><p key={i}>{error}</p>)}</div>}
    <button className="secondary danger bi-delete" onClick={()=>onDelete(object.id)}><Trash2 size={14}/>Remove object</button>
  </aside>
}

function ItemList({title,kind,app,items,max,onChange}:{title:string;kind:'dimension'|'measure';app:AppDetail;items:SheetObject['dimensions'];max:number;onChange:(items:SheetObject['dimensions'])=>void}){
  return <div className="bi-section"><div className="bi-section-title">{kind==='measure'?<Sigma size={14}/>:<Database size={14}/>}{title}<small>{items.length}/{max}</small></div>
    {items.map((item,i)=><div key={i} className="bi-item">
      <div className="bi-row"><ExpressionInput app={app} value={item.expr} kind={kind} onChange={expr=>onChange(items.map((x,j)=>j===i?{...x,expr}:x))}/>
        <button className="icon-button" aria-label={`Remove ${kind}`} onClick={()=>onChange(items.filter((_,j)=>j!==i))}><Trash2 size={14}/></button></div>
      <div className="bi-row bi-sub">
        <input placeholder="Label (optional)" value={item.label||''} onChange={event=>onChange(items.map((x,j)=>j===i?{...x,label:event.target.value||undefined}:x))}/>
        <select aria-label="Number format" value={item.format||'auto'} onChange={event=>onChange(items.map((x,j)=>j===i?{...x,format:event.target.value as NumberFormat}:x))}>{FORMATS.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
      </div>
    </div>)}
    {items.length<max&&<button className="text-button" onClick={()=>onChange([...items,{expr:''}])}><Plus size={13}/>Add {kind}</button>}
  </div>
}

// Expression box with field / function / master-measure suggestions and live checking.
function ExpressionInput({app,value,kind,onChange}:{app:AppDetail;value:string;kind:'dimension'|'measure'|'condition';onChange:(value:string)=>void}){
  const [open,setOpen]=useState(false)
  const fields=useMemo(()=>orderedModel(app.model).flatMap(table=>table.columns.map(column=>({table:table.alias,name:column.name,type:column.type}))),[app.model])
  const problem=useMemo(()=>{
    if(!value.trim())return ''
    try{const node=parseExpression(value,{measures:app.measures});return checkFields(node,app.model)||''}catch(error){return (error as Error).message}
  },[value,app])
  const insert=(text:string)=>{onChange(value&&kind!=='dimension'?`${value}${/[\s(,]$/.test(value)?'':' '}${text}`:text);setOpen(false)}
  const placeholder=kind==='measure'?'e.g. Sum(qty * unit_price)':kind==='condition'?'e.g. invoice_date = Today()-1':'Field, e.g. branch'
  return <div className="bi-expr">
    <div className="bi-expr-box"><input value={value} placeholder={placeholder} className={problem?'invalid':''} spellCheck={false} onChange={event=>onChange(event.target.value)} onFocus={()=>setOpen(true)} onBlur={()=>setTimeout(()=>setOpen(false),150)}/></div>
    {problem&&<small className="bi-expr-error">{problem}</small>}
    {open&&<div className="bi-expr-menu" onMouseDown={event=>event.preventDefault()}>
      {kind==='measure'&&app.measures.length>0&&<><span>Master measures</span>{app.measures.map(m=><button key={m.name} onClick={()=>onChange(`[${m.name}]`)}><Sigma size={12}/>{m.name}<small>{m.expression}</small></button>)}</>}
      {kind==='measure'&&<><span>Quick measures</span>{fields.filter(f=>/numeric|int|double|real|bigint/.test(f.type)).slice(0,12).map(f=><button key={`s-${f.table}.${f.name}`} onClick={()=>onChange(`Sum(${fieldRef(f,fields)})`)}>Sum({fieldRef(f,fields)})</button>)}
        <button onClick={()=>onChange('Count(*)')}>Count(*)</button></>}
      <span>Fields</span>{fields.map(f=><button key={`${f.table}.${f.name}`} onClick={()=>insert(fieldRef(f,fields))}>{fieldRef(f,fields)}<small>{f.table} · {f.type}</small></button>)}
      {kind!=='dimension'&&<><span>Functions</span>{Object.values(FUNCTIONS).map(sig=><button key={sig} onClick={()=>insert(sig.split(',')[0].replace(/\(.*$/,'('))}>{sig}</button>)}</>}
    </div>}
  </div>
}
function fieldRef(field:{table:string;name:string},fields:{table:string;name:string}[]){
  const shared=fields.filter(f=>f.name===field.name).length>1
  return shared&&fields.find(f=>f.name===field.name)?.table!==field.table?`${field.table}.${field.name}`:field.name
}

function FieldList({app}:{app:AppDetail}){
  return <div className="bi-section"><div className="bi-section-title"><Database size={14}/>Fields in this app</div>
    {orderedModel(app.model).map(table=><details key={table.alias} className="bi-fields"><summary>{table.alias}<small>{table.columns.length} fields</small></summary>
      <ul>{table.columns.map(column=><li key={column.name}><code>{column.name}</code><small>{column.type}</small></li>)}</ul></details>)}
  </div>
}

// ---------------------------------------------------------------------------
// App settings: details, data model, master measures, sharing
// ---------------------------------------------------------------------------
function AppSettings({app,onClose,onSaved,onDeleted,setNotice,setError}:{app:AppDetail|null;onClose:()=>void;onSaved:(id:string)=>void;onDeleted?:()=>void;setNotice:(m:string)=>void;setError:(m:string)=>void}){
  const [name,setName]=useState(app?.name||'')
  const [description,setDescription]=useState(app?.description||'')
  const [model,setModel]=useState<ModelTable[]>(app?.model||[])
  const [measures,setMeasures]=useState<MasterMeasure[]>(app?.measures||[])
  const [access,setAccess]=useState<AccessEntry[]>(app?.access||[])
  const [catalogue,setCatalogue]=useState<DataTable[]>([])
  const [principals,setPrincipals]=useState<Principals|null>(null)
  const [saving,setSaving]=useState(false)
  const [userSearch,setUserSearch]=useState('')
  useEffect(()=>{
    if(!supabase)return
    loadDataTables(supabase).then(setCatalogue).catch(error=>setError((error as Error).message))
    loadPrincipals(supabase).then(setPrincipals).catch(error=>setError((error as Error).message))
  },[setError])
  // keep model columns in sync with the catalogue (new columns appear after a load)
  const withColumns=useMemo(()=>model.map(table=>{const loaded=catalogue.find(item=>item.table_name===table.table_name);return loaded?{...table,columns:loaded.columns.filter(c=>c.name!=='_bi_loaded_at')}:table}),[model,catalogue])
  const problems=modelProblems(withColumns)
  const measureProblems=measures.map(m=>{if(!m.name.trim()||!m.expression.trim())return 'Needs a name and an expression'
    try{const node=parseExpression(m.expression,{measures});return checkFields(node,withColumns)||''}catch(error){return (error as Error).message}})

  function addTable(tableName:string){
    const loaded=catalogue.find(item=>item.table_name===tableName);if(!loaded)return
    let alias=tableName.replace(/^[^a-z]+/,'')||'t';let n=2;while(model.some(t=>t.alias===alias))alias=`${tableName}_${n++}`
    const columns=loaded.columns.filter(c=>c.name!=='_bi_loaded_at')
    if(!model.length){setModel([{alias,table_name:tableName,parent_alias:null,join_type:'left',join_pairs:[],columns}]);return}
    // link to the first table that shares a key-like field
    const parent=orderedModel(withColumns).map(table=>({table,links:suggestLinks(columns,table.columns)})).find(item=>item.links.some(l=>l.likelyKey))||{table:withColumns[0],links:suggestLinks(columns,withColumns[0].columns)}
    setModel([...model,{alias,table_name:tableName,parent_alias:parent.table.alias,join_type:'left',join_pairs:parent.links.filter(l=>l.likelyKey).map(l=>l.pair),columns}])
  }
  const update=(alias:string,changes:Partial<ModelTable>)=>setModel(model.map(t=>t.alias===alias?{...t,...changes}:t))
  function removeTable(alias:string){
    const removed=model.find(t=>t.alias===alias)
    setModel(model.filter(t=>t.alias!==alias).map(t=>t.parent_alias===alias?{...t,parent_alias:removed?.parent_alias??null,join_pairs:[]}:t))
  }
  function makeMain(alias:string){
    // re-root the tree: reverse links on the path from the old main table
    const byAlias=new Map(model.map(t=>[t.alias,{...t}]))
    const path:string[]=[];let cursor:string|null=alias
    while(cursor){path.push(cursor);cursor=byAlias.get(cursor)!.parent_alias}
    for(let i=path.length-1;i>0;i--){const parent=byAlias.get(path[i])!,child=byAlias.get(path[i-1])!
      parent.parent_alias=child.alias;parent.join_pairs=child.join_pairs.map(([c,p])=>[p,c] as [string,string]);parent.join_type=child.join_type}
    const root=byAlias.get(alias)!;root.parent_alias=null;root.join_pairs=[]
    setModel([root,...model.filter(t=>t.alias!==alias).map(t=>byAlias.get(t.alias)!)])
  }

  async function save(){
    if(!supabase)return
    setSaving(true)
    try{const id=await saveApp(supabase,{id:app?.id,name,description,model:withColumns,measures,access});setNotice(app?'App saved.':'App created. Add a sheet to start building.');onSaved(id)}
    catch(error){setError((error as Error).message)}finally{setSaving(false)}
  }
  async function remove(){
    if(!app||!supabase||!confirm(`Delete the app "${app.name}" and all its sheets? The loaded data is not affected.`))return
    try{await deleteApp(supabase,app.id);setNotice('App deleted.');onDeleted?.()}catch(error){setError((error as Error).message)}
  }
  const users=(principals?.users||[]).filter(u=>{const needle=userSearch.trim().toLowerCase();return !needle||u.name.toLowerCase().includes(needle)||(u.email||'').toLowerCase().includes(needle)})
  const hasAccess=(type:'role'|'user',principal:string)=>access.some(a=>a.type===type&&a.principal===principal)
  const toggleAccess=(type:'role'|'user',principal:string)=>setAccess(hasAccess(type,principal)?access.filter(a=>!(a.type===type&&a.principal===principal)):[...access,{type,principal}])
  const ordered=orderedModel(withColumns)

  return <section className="rfq-workspace bi-settings">
    <div className="sd-session-bar"><Settings2 size={18}/><span>{app?`${app.name}: data model & sharing`:'Create app'}</span>
      <div className="bi-app-actions">{app&&<button className="secondary danger" onClick={()=>void remove()}><Trash2 size={15}/>Delete app</button>}
        <button className="secondary" onClick={onClose} disabled={saving}>Cancel</button>
        <button className="primary" disabled={saving||!name.trim()||problems.length>0||measureProblems.some(Boolean)} onClick={()=>void save()}><Save size={15}/>{saving?'Saving…':app?'Save':'Create app'}</button></div></div>

    <div className="bi-card"><h3>Details</h3><div className="bi-form-grid">
      <label>Name<input value={name} maxLength={120} placeholder="e.g. Sales" onChange={event=>setName(event.target.value)}/></label>
      <label>Description<input value={description} maxLength={500} placeholder="What this app is for" onChange={event=>setDescription(event.target.value)}/></label></div></div>

    <div className="bi-card"><h3><Link2 size={16}/>Data model</h3>
      <p className="hint">Choose the loaded tables this app uses. The main table holds the rows you count and sum (for example invoice lines); every other table links to it, or to a table already linked, on matching fields. Fields with the same name are suggested, like Qlik's associations.</p>
      <div className="bi-model">{ordered.map(table=>{const parent=withColumns.find(t=>t.alias===table.parent_alias);const suggestions=parent?suggestLinks(table.columns,parent.columns):[]
        return <div key={table.alias} className={`bi-model-table ${table.parent_alias?'':'is-main'}`} style={{marginLeft:Math.min(4,depth(table,withColumns))*28}}>
          <div className="bi-model-head"><Database size={15}/><b>{table.alias}</b>{table.alias!==table.table_name&&<small>({table.table_name})</small>}
            {!table.parent_alias?<span className="sd-type">Main table</span>:<button className="text-button" onClick={()=>makeMain(table.alias)}>Make main table</button>}
            <small className="bi-muted">{table.columns.length} fields{catalogue.find(c=>c.table_name===table.table_name)?.row_count!=null?` · ${Number(catalogue.find(c=>c.table_name===table.table_name)?.row_count).toLocaleString()} rows`:''}</small>
            <button className="icon-button" aria-label={`Remove ${table.alias}`} onClick={()=>removeTable(table.alias)}><Trash2 size={14}/></button></div>
          {table.parent_alias&&<div className="bi-link">
            <label>Links to<select value={table.parent_alias} onChange={event=>update(table.alias,{parent_alias:event.target.value,join_pairs:suggestLinks(table.columns,withColumns.find(t=>t.alias===event.target.value)?.columns||[]).filter(l=>l.likelyKey).map(l=>l.pair)})}>
              {withColumns.filter(t=>t.alias!==table.alias&&!isDescendant(t.alias,table.alias,withColumns)).map(t=><option key={t.alias} value={t.alias}>{t.alias}</option>)}</select></label>
            <label>Keep<select value={table.join_type} onChange={event=>update(table.alias,{join_type:event.target.value as 'left'|'inner'})}>
              <option value="left">All rows of {table.parent_alias}</option><option value="inner">Only rows that match</option></select></label>
            <div className="bi-pairs">{table.join_pairs.map((pair,i)=><span key={i} className="bi-chip"><code>{table.alias}.{pair[0]}</code> = <code>{table.parent_alias}.{pair[1]}</code>
              <button aria-label="Remove link field" onClick={()=>update(table.alias,{join_pairs:table.join_pairs.filter((_,j)=>j!==i)})}><X size={12}/></button></span>)}
              {suggestions.filter(s=>!table.join_pairs.some(p=>p[0]===s.pair[0]&&p[1]===s.pair[1])).map(s=><button key={s.pair[0]} className="secondary bi-suggest" onClick={()=>update(table.alias,{join_pairs:[...table.join_pairs,s.pair]})}><Plus size={12}/>{s.pair[0]}</button>)}
              <PairPicker child={table} parent={parent} onAdd={pair=>update(table.alias,{join_pairs:[...table.join_pairs,pair]})}/></div>
          </div>}
        </div>})}
        {!model.length&&<p className="bi-muted">No tables yet. Add the main table first.</p>}
      </div>
      <label className="bi-add-table">Add a table<select value="" onChange={event=>event.target.value&&addTable(event.target.value)}>
        <option value="">Choose a loaded table…</option>
        {catalogue.map(table=><option key={table.table_name} value={table.table_name}>{table.table_name}{table.description?` — ${table.description}`:''}{model.some(m=>m.table_name===table.table_name)?' (in model)':''}</option>)}</select></label>
      {problems.length>0&&model.length>0&&<div className="bi-panel-errors">{problems.map(p=><p key={p}>{p}</p>)}</div>}
    </div>

    <div className="bi-card"><h3><Sigma size={16}/>Master measures</h3>
      <p className="hint">Reusable calculations every sheet can use as <code>[Name]</code>, so "Sales" means the same thing everywhere. Measures can use other measures, e.g. <code>([Sales]-[Cost])/[Sales]</code>.</p>
      {measures.map((m,i)=><div key={i} className="bi-measure-row">
        <input placeholder="Name" value={m.name} onChange={event=>setMeasures(measures.map((x,j)=>j===i?{...x,name:event.target.value}:x))}/>
        <input placeholder="Sum(qty * unit_price)" className={measureProblems[i]?'invalid':''} spellCheck={false} value={m.expression} onChange={event=>setMeasures(measures.map((x,j)=>j===i?{...x,expression:event.target.value}:x))}/>
        <select value={m.format||'auto'} onChange={event=>setMeasures(measures.map((x,j)=>j===i?{...x,format:event.target.value}:x))}>{FORMATS.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>
        <button className="icon-button" aria-label="Remove measure" onClick={()=>setMeasures(measures.filter((_,j)=>j!==i))}><Trash2 size={14}/></button>
        {measureProblems[i]&&<small className="bi-expr-error">{measureProblems[i]}</small>}
      </div>)}
      <button className="text-button" onClick={()=>setMeasures([...measures,{name:'',expression:''}])}><Plus size={13}/>Add master measure</button>
    </div>

    <div className="bi-card"><h3><Users size={16}/>Who can open this app</h3>
      <p className="hint">Administrators and report builders always have access. Everyone else needs one of these roles, or to be added by name. People given access by name see the Reporting card even without a Reporting role.</p>
      <div className="bi-access"><div><b>Roles</b>{(principals?.roles||[]).filter(r=>r.id!=='administrator'&&r.id!=='report_builder').map(r=><label key={r.id} className="bi-check"><input type="checkbox" checked={hasAccess('role',r.id)} onChange={()=>toggleAccess('role',r.id)}/>{r.label}</label>)}</div>
        <div><b>People</b><input placeholder="Search by name or email" value={userSearch} onChange={event=>setUserSearch(event.target.value)}/>
          <div className="bi-user-list">{users.slice(0,50).map(u=><label key={u.id} className="bi-check"><input type="checkbox" checked={hasAccess('user',u.id)} onChange={()=>toggleAccess('user',u.id)}/>{u.name}<small>{u.email}</small></label>)}</div></div></div>
    </div>
  </section>
}

function depth(table:ModelTable,model:ModelTable[]){let d=0,cursor=table.parent_alias;while(cursor&&d<10){d++;cursor=model.find(t=>t.alias===cursor)?.parent_alias||null}return d}
function isDescendant(alias:string,ancestor:string,model:ModelTable[]){let cursor:string|null=alias;let guard=0;while(cursor&&guard++<20){if(cursor===ancestor)return true;cursor=model.find(t=>t.alias===cursor)?.parent_alias||null}return false}

function PairPicker({child,parent,onAdd}:{child:ModelTable;parent?:ModelTable;onAdd:(pair:[string,string])=>void}){
  const [a,setA]=useState('');const [b,setB]=useState('')
  if(!parent)return null
  return <span className="bi-pair-picker">
    <select aria-label={`Field in ${child.alias}`} value={a} onChange={event=>setA(event.target.value)}><option value="">{child.alias} field…</option>{child.columns.map(c=><option key={c.name}>{c.name}</option>)}</select>=
    <select aria-label={`Field in ${parent.alias}`} value={b} onChange={event=>setB(event.target.value)}><option value="">{parent.alias} field…</option>{parent.columns.map(c=><option key={c.name}>{c.name}</option>)}</select>
    <button className="secondary" disabled={!a||!b} onClick={()=>{onAdd([a,b]);setA('');setB('')}}>Link</button>
  </span>
}

