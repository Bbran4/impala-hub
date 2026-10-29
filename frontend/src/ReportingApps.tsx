import {useCallback,useEffect,useMemo,useRef,useState,type PointerEvent as ReactPointerEvent,type ReactNode} from 'react'
import {
  ArrowLeft,BarChart3,Palette,Copy,Database,Filter,GripVertical,LayoutGrid,LineChart,Link2,Pencil,PieChart,Plus,Save,Settings2,
  Sigma,Table2,Trash2,Type,Users,X,Grid3x3,Gauge,Hash,ChartColumnIncreasing,ScatterChart,Target,ListFilter,ChartNoAxesColumn,LayoutDashboard,
  BarChartBig,ChartCandlestick,Grip,Radar,Columns3,Cloud,
} from 'lucide-react'
import {supabase} from './supabase'
import {type MasterMeasure} from './biExpression'
import {checkExpression,ExpressionInput,type ExpressionContext} from './biExpressionEditor'
import {
  GRID_COLS,KIND_INFO,ROW_HEIGHT,compileObject,deleteApp,deleteSheet,displayValue,freeSpot,loadApp,loadApps,loadPrincipals,
  columnOrder,fitOptions,modelProblems,moveColumn,newId,normalizeObject,orderedModel,relinkModel,removeFromModel,rerootModel,resolveLayout,saveApp,saveSheet,suggestLinks,toggleSelection,
  type AccessEntry,type AppDetail,type AppSummary,type ModelTable,type NumberFormat,type ObjectKind,
  type Principals,type Selection,type Sheet,type SheetObject,
} from './biApps'
import {loadDataTables,ago,type DataTable} from './reportingData'
import {ObjectBody,type SelectFn} from './biCharts'
import './reportingApps.css'

type Props={canBuild:boolean;setNotice:(message:string)=>void;setError:(message:string)=>void}

const KIND_ICONS:Record<ObjectKind,typeof BarChart3>={kpi:Hash,bar:BarChart3,line:LineChart,pie:PieChart,table:Table2,pivot:Grid3x3,filter:Filter,text:Type,
  combo:ChartColumnIncreasing,scatter:ScatterChart,gauge:Gauge,bullet:Target,funnel:ListFilter,waterfall:ChartNoAxesColumn,treemap:LayoutDashboard,histogram:BarChartBig,
  boxplot:ChartCandlestick,distribution:Grip,radar:Radar,mekko:Columns3,grid:LayoutGrid,wordcloud:Cloud}
const PALETTE:{title:string;kinds:ObjectKind[]}[]=[
  {title:'Charts',kinds:['bar','line','combo','pie','kpi','gauge','scatter','treemap','waterfall','funnel','bullet','radar','mekko','grid','histogram','boxplot','distribution','wordcloud']},
  {title:'Tables',kinds:['table','pivot']},
  {title:'Filters & text',kinds:['filter','text']},
]
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
  const [search,setSearch]=useState('')
  const needle=search.trim().toLowerCase()
  return <aside className="bi-palette"><input className="bi-palette-search" placeholder="Find a chart" value={search} onChange={event=>setSearch(event.target.value)} aria-label="Find a chart type"/>
    {PALETTE.map(group=>{const kinds=group.kinds.filter(kind=>!needle||`${KIND_INFO[kind].label} ${KIND_INFO[kind].hint}`.toLowerCase().includes(needle));if(!kinds.length)return null
      return <div key={group.title} className="bi-palette-group"><span className="nav-label">{group.title.toUpperCase()}</span>
        <div className="bi-palette-grid">{kinds.map(kind=>{const Icon=KIND_ICONS[kind];return <button key={kind} title={KIND_INFO[kind].hint} onClick={()=>onAdd(kind)}><Icon size={17}/><span>{KIND_INFO[kind].label.replace(/ chart$/,'')}</span></button>})}</div></div>})}
  </aside>
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
  const ctx:ExpressionContext={appId:app.id,model:app.model,measures:app.measures}
  const columns=[...object.dimensions.map((d,i)=>d.label||d.expr||`Dimension ${i+1}`),...object.measures.map((m,i)=>m.label||m.expr||`Measure ${i+1}`)]
  return <aside className="bi-panel">
    <div className="bi-panel-head"><h3>{info.label}</h3><button className="icon-button" aria-label="Close" onClick={onClose}><X size={16}/></button></div>
    <label>Type<select value={object.kind} onChange={event=>{const kind=event.target.value as ObjectKind;const next=KIND_INFO[kind]
      const dimensions=object.dimensions.slice(0,next.dims[1]),measures=object.measures.slice(0,next.measures[1])
      set({kind,dimensions,measures,options:fitOptions(object,dimensions.length,measures.length)})}}>
      {(Object.keys(KIND_INFO) as ObjectKind[]).map(kind=><option key={kind} value={kind}>{KIND_INFO[kind].label}</option>)}</select></label>
    <p className="hint">{info.hint}</p>
    <label>Title<input value={object.title} maxLength={120} onChange={event=>set({title:event.target.value})}/></label>
    {object.kind==='text'&&<label>Text<textarea rows={5} value={object.options.text||''} onChange={event=>setOption({text:event.target.value})}/></label>}

    {info.dims[1]>0&&<ItemList title="Dimensions" kind="dimension" ctx={ctx} items={object.dimensions} max={info.dims[1]} colors={object.kind==='table'} onChange={dimensions=>set({dimensions,options:fitOptions(object,dimensions.length,object.measures.length)})}
      onMove={(from,to)=>set(moveColumn(object,'dimension',from,to))}
      onRemove={i=>{const dimensions=object.dimensions.filter((_,j)=>j!==i);set({dimensions,options:fitOptions(object,dimensions.length,object.measures.length,{kind:'dimension',index:i})})}}/>}
    {info.measures[1]>0&&<ItemList title="Measures" kind="measure" ctx={ctx} items={object.measures} max={info.measures[1]} colors={object.kind==='table'||object.kind==='pivot'} onChange={measures=>set({measures,options:fitOptions(object,object.dimensions.length,measures.length)})}
      onMove={(from,to)=>set(moveColumn(object,'measure',from,to))}
      onRemove={i=>{const measures=object.measures.filter((_,j)=>j!==i);set({measures,options:fitOptions(object,object.dimensions.length,measures.length,{kind:'measure',index:i})})}}/>}
    {object.kind==='table'&&object.dimensions.length+object.measures.length>1&&<div className="bi-section"><div className="bi-section-title"><Table2 size={14}/>Column order</div>
      <p className="hint">Drag to put any column first, including measures before dimensions.</p>
      <SortableList count={columnOrder(object).length} onMove={(from,to)=>setOption({columnOrder:moveIndex(columnOrder(object),from,to)})}
        label={i=>columns[columnOrder(object)[i]]} render={i=>{const c=columnOrder(object)[i];return <div className="bi-column-chip">{c<object.dimensions.length?<Database size={12}/>:<Sigma size={12}/>}<span>{columns[c]}</span></div>}}/>
    </div>}

    {object.kind!=='text'&&<details className="bi-section" open={Boolean(object.options.conditions?.length)}>
      <summary>Conditions</summary>
      <p className="hint">Only rows matching every condition are used, for example <code>invoice_date = Today()-1</code>.</p>
      {(object.options.conditions||[]).map((condition,i)=><div key={i} className="bi-row">
        <ExpressionInput ctx={ctx} label={`Condition ${i+1}`} value={condition} kind="condition" onChange={value=>setOption({conditions:(object.options.conditions||[]).map((c,j)=>j===i?value:c)})}/>
        <button className="icon-button" aria-label="Remove condition" onClick={()=>setOption({conditions:(object.options.conditions||[]).filter((_,j)=>j!==i)})}><Trash2 size={14}/></button></div>)}
      <button className="text-button" onClick={()=>setOption({conditions:[...(object.options.conditions||[]),'']})}><Plus size={13}/>Add condition</button>
    </details>}

    {['combo','gauge','histogram'].includes(object.kind)&&<details className="bi-section" open>
      <summary>Chart options</summary>
      {object.kind==='combo'&&<label>Measures drawn as bars<select value={object.options.comboBars??1} onChange={event=>setOption({comboBars:Number(event.target.value)})}>
        {object.measures.map((_,i)=><option key={i} value={i+1}>{i+1===1?'The first':`The first ${i+1}`}{i+1<object.measures.length?' (the rest are lines)':' (all bars)'}</option>)}<option value={0}>None (all lines)</option></select></label>}
      {object.kind==='combo'&&<label className="bi-check"><input type="checkbox" checked={Boolean(object.options.secondaryAxis)} onChange={event=>setOption({secondaryAxis:event.target.checked})}/>Lines on a second axis (right)</label>}
      {object.kind==='gauge'&&<div className="bi-row"><label>Minimum<input type="number" value={object.options.gaugeMin??''} placeholder="0" onChange={event=>setOption({gaugeMin:event.target.value===''?undefined:Number(event.target.value)})}/></label>
        <label>Maximum<input type="number" value={object.options.gaugeMax??''} placeholder="Automatic" onChange={event=>setOption({gaugeMax:event.target.value===''?undefined:Number(event.target.value)})}/></label></div>}
      {object.kind==='histogram'&&<label>Number of bars<input type="number" min={2} max={60} value={object.options.bins??''} placeholder="Automatic" onChange={event=>setOption({bins:event.target.value?Math.max(2,Math.min(60,Number(event.target.value))):undefined})}/></label>}
    </details>}

    {['bar','line','pie','table','combo','funnel','waterfall','wordcloud','scatter'].includes(object.kind)&&<details className="bi-section">
      <summary>Sorting and display</summary>
      {object.kind!=='pie'&&<label>Sort by<select value={object.options.sortBy??''} onChange={event=>setOption({sortBy:event.target.value===''?undefined:Number(event.target.value)})}>
        <option value="">Automatic</option>{columns.map((name,i)=><option key={i} value={i}>{name}</option>)}</select></label>}
      {object.options.sortBy!=null&&<label className="bi-check"><input type="checkbox" checked={Boolean(object.options.sortDesc)} onChange={event=>setOption({sortDesc:event.target.checked})}/>Largest / latest first</label>}
      {['bar','line','combo','scatter','wordcloud'].includes(object.kind)&&<label>Maximum values<input type="number" min={1} max={1000} value={object.options.limit||''} placeholder={object.kind==='line'?'500':'100'} onChange={event=>setOption({limit:event.target.value?Math.max(1,Math.min(1000,Number(event.target.value))):undefined})}/></label>}
      {object.kind==='bar'&&<label className="bi-check"><input type="checkbox" checked={Boolean(object.options.horizontal)} onChange={event=>setOption({horizontal:event.target.checked})}/>Horizontal bars</label>}
      {object.kind==='bar'&&<label className="bi-check"><input type="checkbox" checked={Boolean(object.options.stacked)} onChange={event=>setOption({stacked:event.target.checked})}/>Stack the second dimension</label>}
      {object.kind==='table'&&<label className="bi-check"><input type="checkbox" checked={object.options.totals!==false} onChange={event=>setOption({totals:event.target.checked})}/>Show totals</label>}
    </details>}

    {compiled.errors.length>0&&<div className="bi-panel-errors">{compiled.errors.map((error,i)=><p key={i}>{error}</p>)}</div>}
    <button className="secondary danger bi-delete" onClick={()=>onDelete(object.id)}><Trash2 size={14}/>Remove object</button>
  </aside>
}

// Drag-to-reorder list: drag an entry by its grip (mouse, pen or touch), or focus the grip and use Alt+↑/↓.
function SortableList({count,onMove,label,render}:{count:number;onMove:(from:number,to:number)=>void;label:(i:number)=>string;render:(i:number)=>ReactNode}){
  const listRef=useRef<HTMLDivElement>(null)
  const [drag,setDrag]=useState<{from:number;over:number}|null>(null)
  function overIndex(clientY:number){
    const items=[...(listRef.current?.children||[])] as HTMLElement[]
    const index=items.findIndex(item=>{const r=item.getBoundingClientRect();return clientY<r.top+r.height/2})
    return index<0?items.length-1:index
  }
  function start(event:ReactPointerEvent<HTMLButtonElement>,i:number){
    if(event.button!==0)return
    event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);setDrag({from:i,over:i})
  }
  return <div className="bi-sortable" ref={listRef}>{Array.from({length:count},(_,i)=><div key={i}
      className={`bi-sortable-item ${drag?.from===i?'dragging':''} ${drag&&drag.over===i&&drag.from!==i?(drag.from<i?'drop-after':'drop-before'):''}`}>
      {count>1&&<button type="button" className="bi-grip" aria-label={`Move ${label(i)} (Alt+arrow keys)`} title="Drag to change the order"
        onPointerDown={event=>start(event,i)}
        onPointerMove={event=>{if(drag)setDrag({...drag,over:overIndex(event.clientY)})}}
        onPointerUp={()=>{if(drag&&drag.over!==drag.from)onMove(drag.from,drag.over);setDrag(null)}}
        onPointerCancel={()=>setDrag(null)}
        onKeyDown={event=>{if(!event.altKey)return
          if(event.key==='ArrowUp'&&i>0){event.preventDefault();onMove(i,i-1)}
          if(event.key==='ArrowDown'&&i<count-1){event.preventDefault();onMove(i,i+1)}}}><GripVertical size={14}/></button>}
      <div className="bi-sortable-body">{render(i)}</div>
    </div>)}</div>
}
export function moveIndex<T>(items:T[],from:number,to:number){const next=[...items];const [item]=next.splice(from,1);next.splice(to,0,item);return next}

function ItemList({title,kind,ctx,items,max,colors,onChange,onMove,onRemove}:{title:string;kind:'dimension'|'measure';ctx:ExpressionContext;items:SheetObject['dimensions'];max:number;colors?:boolean;onChange:(items:SheetObject['dimensions'])=>void;onMove:(from:number,to:number)=>void;onRemove:(index:number)=>void}){
  return <div className="bi-section"><div className="bi-section-title">{kind==='measure'?<Sigma size={14}/>:<Database size={14}/>}{title}<small>{items.length}/{max}</small></div>
    <SortableList count={items.length} onMove={onMove} label={i=>items[i].label||items[i].expr||`${kind} ${i+1}`} render={i=>{const item=items[i]
      return <div className="bi-item">
      <div className="bi-row"><ExpressionInput ctx={ctx} label={item.label||`${kind==='measure'?'Measure':'Dimension'} ${i+1}`} value={item.expr} kind={kind} onChange={expr=>onChange(items.map((x,j)=>j===i?{...x,expr}:x))}/>
        <button className="icon-button" aria-label={`Remove ${kind}`} onClick={()=>onRemove(i)}><Trash2 size={14}/></button></div>
      <div className="bi-row bi-sub">
        <input placeholder="Label (optional)" value={item.label||''} onChange={event=>onChange(items.map((x,j)=>j===i?{...x,label:event.target.value||undefined}:x))}/>
        <select aria-label="Number format" value={item.format||'auto'} onChange={event=>onChange(items.map((x,j)=>j===i?{...x,format:event.target.value as NumberFormat}:x))}>{FORMATS.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
      </div>
      {colors&&<details className="bi-colors" open={Boolean(item.background||item.textColor)}>
        <summary><Palette size={12}/>Colours{(item.background||item.textColor)&&<small>on</small>}</summary>
        <label>Background colour<ExpressionInput ctx={ctx} kind="color" label={`${item.label||item.expr||kind} background colour`} value={item.background||''} onChange={background=>onChange(items.map((x,j)=>j===i?{...x,background:background||undefined}:x))}/></label>
        <label>Text colour<ExpressionInput ctx={ctx} kind="color" label={`${item.label||item.expr||kind} text colour`} value={item.textColor||''} onChange={textColor=>onChange(items.map((x,j)=>j===i?{...x,textColor:textColor||undefined}:x))}/></label>
        <p className="hint">Calculated per row, e.g. <code>If(Sum(qty) &lt; 10, 'red')</code>, <code>RGB(27, 175, 122)</code> or <code>ColorMix1(Sum(qty) / 100, '#ffffff', '#1baf7a')</code>. Empty or non-colour results leave the cell as it is.</p>
      </details>}
    </div>}}/>
    {items.length<max&&<button className="text-button" onClick={()=>onChange([...items,{expr:''}])}><Plus size={13}/>Add {kind}</button>}
  </div>
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
  const measureCtx=useMemo<ExpressionContext>(()=>({appId:app?.id,model:withColumns,measures}),[app?.id,withColumns,measures])
  const measureProblems=measures.map(m=>{if(!m.name.trim()||!m.expression.trim())return 'Needs a name and an expression'
    if(measures.filter(x=>x.name.trim().toLowerCase()===m.name.trim().toLowerCase()).length>1)return 'Two master measures have this name'
    return checkExpression(m.expression,'measure',measureCtx)?.message||''})

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
  const removeTable=(alias:string)=>setModel(removeFromModel(withColumns,alias))
  const relink=(alias:string,target:string)=>{const table=withColumns.find(t=>t.alias===alias),other=withColumns.find(t=>t.alias===target);if(!table||!other)return
    setModel(relinkModel(withColumns,alias,target,suggestLinks(table.columns,other.columns).filter(l=>l.likelyKey).map(l=>l.pair)))}

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
      <p className="hint">Choose the loaded tables this app uses and link them on matching key fields, like Qlik's associations. There is no main table: a chart uses only the tables it needs, and records without a match in a linked table are still shown (for example stock items that never sold). Fields with the same name are suggested.</p>
      <div className="bi-model">{ordered.map(table=>{const parent=withColumns.find(t=>t.alias===table.parent_alias);const suggestions=parent?suggestLinks(table.columns,parent.columns):[]
        const linkedFrom=withColumns.filter(t=>t.parent_alias===table.alias)
        const rows=catalogue.find(c=>c.table_name===table.table_name)?.row_count
        return <div key={table.alias} className="bi-model-table">
          <div className="bi-model-head"><Database size={15}/><b>{table.alias}</b>{table.alias!==table.table_name&&<small>({table.table_name})</small>}
            <small className="bi-muted">{table.columns.length} fields{rows!=null?` · ${Number(rows).toLocaleString()} rows`:''}</small>
            <button className="icon-button" aria-label={`Remove ${table.alias}`} title="Remove from the app" onClick={()=>removeTable(table.alias)}><Trash2 size={14}/></button></div>
          {withColumns.length>1&&<div className="bi-link">
            <label>Linked to<select value={table.parent_alias||''} onChange={event=>event.target.value&&relink(table.alias,event.target.value)}>
              {!table.parent_alias&&<option value="">{linkedFrom.length?`(linked from ${linkedFrom.map(t=>t.alias).join(', ')})`:'Choose a table…'}</option>}
              {withColumns.filter(t=>t.alias!==table.alias).map(t=><option key={t.alias} value={t.alias}>{t.alias}</option>)}</select></label>
            {parent&&<div className="bi-pairs">{table.join_pairs.map((pair,i)=><span key={i} className="bi-chip"><code>{table.alias}.{pair[0]}</code> = <code>{table.parent_alias}.{pair[1]}</code>
              <button aria-label="Remove link field" onClick={()=>update(table.alias,{join_pairs:table.join_pairs.filter((_,j)=>j!==i)})}><X size={12}/></button></span>)}
              {suggestions.filter(s=>!table.join_pairs.some(p=>p[0]===s.pair[0]&&p[1]===s.pair[1])).map(s=><button key={s.pair[0]} className="secondary bi-suggest" onClick={()=>update(table.alias,{join_pairs:[...table.join_pairs,s.pair]})}><Plus size={12}/>{s.pair[0]}</button>)}
              <PairPicker child={table} parent={parent} onAdd={pair=>update(table.alias,{join_pairs:[...table.join_pairs,pair]})}/></div>}
          </div>}
        </div>})}
        {!model.length&&<p className="bi-muted">No tables yet. Add a table to start.</p>}
      </div>
      {withColumns.length>1&&<label className="bi-add-table">Count(*) counts records of<select value={ordered[0]?.alias||''} onChange={event=>setModel(rerootModel(withColumns,event.target.value))}>
        {ordered.map(t=><option key={t.alias} value={t.alias}>{t.alias}</option>)}</select></label>}
      <label className="bi-add-table">Add a table<select value="" onChange={event=>event.target.value&&addTable(event.target.value)}>
        <option value="">Choose a loaded table…</option>
        {catalogue.map(table=><option key={table.table_name} value={table.table_name}>{table.table_name}{table.description?` — ${table.description}`:''}{model.some(m=>m.table_name===table.table_name)?' (in model)':''}</option>)}</select></label>
      {problems.length>0&&model.length>0&&<div className="bi-panel-errors">{problems.map(p=><p key={p}>{p}</p>)}</div>}
    </div>

    <div className="bi-card"><h3><Sigma size={16}/>Master measures</h3>
      <p className="hint">Reusable calculations every sheet can use as <code>[Name]</code>, so "Sales" means the same thing everywhere. Measures can use other measures, e.g. <code>([Sales]-[Cost])/[Sales]</code>.</p>
      {measures.map((m,i)=><div key={i} className="bi-measure-row">
        <input placeholder="Name" value={m.name} onChange={event=>setMeasures(measures.map((x,j)=>j===i?{...x,name:event.target.value}:x))}/>
        <ExpressionInput ctx={measureCtx} kind="measure" label={m.name||`Master measure ${i+1}`} value={m.expression} onChange={expression=>setMeasures(measures.map((x,j)=>j===i?{...x,expression}:x))}/>
        <select value={m.format||'auto'} onChange={event=>setMeasures(measures.map((x,j)=>j===i?{...x,format:event.target.value}:x))}>{FORMATS.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>
        <button className="icon-button" aria-label="Remove measure" onClick={()=>setMeasures(measures.filter((_,j)=>j!==i))}><Trash2 size={14}/></button>
        {(measureProblems[i].startsWith('Needs')||measureProblems[i].startsWith('Two'))&&<small className="bi-expr-error">{measureProblems[i]}</small>}
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


function PairPicker({child,parent,onAdd}:{child:ModelTable;parent?:ModelTable;onAdd:(pair:[string,string])=>void}){
  const [a,setA]=useState('');const [b,setB]=useState('')
  if(!parent)return null
  return <span className="bi-pair-picker">
    <select aria-label={`Field in ${child.alias}`} value={a} onChange={event=>setA(event.target.value)}><option value="">{child.alias} field…</option>{child.columns.map(c=><option key={c.name}>{c.name}</option>)}</select>=
    <select aria-label={`Field in ${parent.alias}`} value={b} onChange={event=>setB(event.target.value)}><option value="">{parent.alias} field…</option>{parent.columns.map(c=><option key={c.name}>{c.name}</option>)}</select>
    <button className="secondary" disabled={!a||!b} onClick={()=>{onAdd([a,b]);setA('');setB('')}}>Link</button>
  </span>
}

