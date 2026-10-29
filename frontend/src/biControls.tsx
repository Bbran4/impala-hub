// Reporting objects that don't draw data (batch 2): variable input, slider, date picker, button,
// navigation menu, tab / layout / trellis containers, image, text & image, line and video player.
import {useEffect,useMemo,useState,type ReactNode} from 'react'
import {CalendarDays,ExternalLink,ImageOff,X} from 'lucide-react'
import {supabase} from './supabase'
import {buildSpec,displayValue,runQuery,safeColor,type CompiledObject,type FieldValue,type SheetObject} from './biApps'
import {type ExprNode} from './biExpression'
import {buttonValue,quickRanges,safeUrl,trellisCondition,videoSource} from './biControlLogic'
import {Message,selectedValues,useQuery,type Compiled,type ObjectProps} from './biChartKit'

type Props=ObjectProps&Compiled&{renderChild:(object:SheetObject,extraConditions?:ExprNode[])=>ReactNode}

function needsRuntime(props:ObjectProps){return props.runtime?null:<Message kind="empty">Available when the app is open</Message>}

// ---------------------------------------------------------------------------
// Variable input and slider
// ---------------------------------------------------------------------------
export function VariableInput(props:ObjectProps){
  const {object,runtime}=props
  const name=object.options.variable||''
  const current=runtime?.values[name]??''
  const [draft,setDraft]=useState(current)
  useEffect(()=>setDraft(current),[current])
  if(!runtime)return needsRuntime(props)
  if(!name||!runtime.variables.some(v=>v.name===name))return <Message kind="empty">Choose a variable (define variables under Data model &amp; sharing)</Message>
  const choices=(object.options.choices||'').split(',').map(c=>c.trim()).filter(Boolean)
  const style=object.options.inputStyle||'input'
  const set=(value:string)=>runtime.setVariable(name,value)
  const description=runtime.variables.find(v=>v.name===name)?.description
  return <div className="bi-control">
    {style==='input'&&<form className="bi-control-row" onSubmit={event=>{event.preventDefault();set(draft)}}>
      <input value={draft} onChange={event=>setDraft(event.target.value)} onBlur={()=>draft!==current&&set(draft)} aria-label={name} disabled={runtime.editing}/>
      {draft!==current&&<button type="submit" className="primary">Apply</button>}</form>}
    {style==='dropdown'&&<select value={current} onChange={event=>set(event.target.value)} aria-label={name} disabled={runtime.editing}>
      {!choices.includes(current)&&<option value={current}>{current||'(empty)'}</option>}{choices.map(c=><option key={c} value={c}>{c}</option>)}</select>}
    {style==='buttons'&&<div className="bi-control-buttons">{choices.map(c=><button key={c} type="button" className={c===current?'active':''} disabled={runtime.editing} onClick={()=>set(c)}>{c}</button>)}</div>}
    {description&&<small className="bi-muted">{description}</small>}
  </div>
}

export function SliderObject(props:ObjectProps){
  const {object,runtime}=props
  const name=object.options.variable||''
  const min=object.options.min??0,max=object.options.max??100,step=object.options.step||1
  const value=Number(runtime?.values[name]??min)
  const [draft,setDraft]=useState(value)
  useEffect(()=>setDraft(value),[value])
  if(!runtime)return needsRuntime(props)
  if(!name||!runtime.variables.some(v=>v.name===name))return <Message kind="empty">Choose a number variable (define variables under Data model &amp; sharing)</Message>
  return <div className="bi-control">
    <div className="bi-slider"><input type="range" min={min} max={max} step={step} value={Number.isFinite(draft)?draft:min} disabled={runtime.editing} aria-label={name}
      onChange={event=>setDraft(Number(event.target.value))}
      onPointerUp={()=>runtime.setVariable(name,String(draft))} onKeyUp={()=>runtime.setVariable(name,String(draft))}/>
      <b>{Number.isFinite(draft)?draft.toLocaleString('en-ZA'):'—'}</b></div>
    <div className="bi-slider-scale"><small>{min.toLocaleString('en-ZA')}</small><small>{max.toLocaleString('en-ZA')}</small></div>
  </div>
}

// ---------------------------------------------------------------------------
// Date picker: selects every value of a date field between two dates
// ---------------------------------------------------------------------------
export function DatePicker(props:ObjectProps&Compiled){
  const {app,selections,compiled,runtime}=props
  const dim=compiled.dimensions[0]
  const selected=selectedValues(selections,dim.selectKey).filter((v):v is string=>typeof v==='string').sort()
  const [from,setFrom]=useState(selected[0]||'');const [to,setTo]=useState(selected[selected.length-1]||'')
  const [busy,setBusy]=useState(false);const [problem,setProblem]=useState('')
  useEffect(()=>{if(selected.length){setFrom(selected[0]);setTo(selected[selected.length-1])}},[selected.join('|')])// eslint-disable-line react-hooks/exhaustive-deps
  if(!runtime)return needsRuntime(props)
  async function apply(a:string,b:string){
    if(!supabase||!a||!b)return
    setBusy(true);setProblem('')
    try{
      const lo=a<=b?a:b,hi=a<=b?b:a
      const spec={...buildSpec(compiled,selections,{ignoreKey:dim.selectKey,measures:[],limit:5000}),
        conditions:[...compiled.conditions,{t:'bin',op:'>=',l:dim.node,r:{t:'str',v:lo}},{t:'bin',op:'<=',l:dim.node,r:{t:'str',v:hi}}]}
      const out=await runQuery(supabase,app.id,spec)
      const values=out.rows.map(row=>row[0]).filter(v=>v!==null)
      if(!values.length){setProblem('No data between those dates');return}
      runtime!.setSelection({key:dim.selectKey,label:dim.label,node:dim.node},values)
      setFrom(lo);setTo(hi)
    }catch(error){setProblem((error as Error).message)}finally{setBusy(false)}
  }
  return <div className="bi-control bi-datepicker">
    <div className="bi-control-row"><CalendarDays size={15}/>
      <input type="date" value={from} max={to||undefined} onChange={event=>setFrom(event.target.value)} aria-label={`${dim.label} from`} disabled={runtime.editing}/>
      <span>to</span>
      <input type="date" value={to} min={from||undefined} onChange={event=>setTo(event.target.value)} aria-label={`${dim.label} to`} disabled={runtime.editing}/>
      <button type="button" className="primary" disabled={busy||!from||!to||runtime.editing} onClick={()=>void apply(from,to)}>{busy?'…':'Select'}</button>
      {selected.length>0&&<button type="button" className="icon-button" aria-label="Clear dates" onClick={()=>runtime.setSelection({key:dim.selectKey,label:dim.label,node:dim.node},[])}><X size={14}/></button>}
    </div>
    <div className="bi-control-buttons small">{quickRanges().map(r=><button key={r.label} type="button" disabled={busy||runtime.editing} onClick={()=>void apply(r.from,r.to)}>{r.label}</button>)}</div>
    {problem&&<small className="bi-expr-error">{problem}</small>}
  </div>
}

// ---------------------------------------------------------------------------
// Button and navigation menu
// ---------------------------------------------------------------------------
export function ButtonObject(props:ObjectProps&{selectTarget?:CompiledObject['dimensions'][number]|null}){
  const {object,runtime,selectTarget}=props
  if(!runtime)return needsRuntime(props)
  const o=object.options
  const label=o.text?.trim()||object.title||'Button'
  function run(){
    if(!runtime||runtime.editing)return
    switch(o.action||'clear'){
      case 'clear':runtime.clearSelections();break
      case 'select':if(selectTarget)runtime.setSelection({key:selectTarget.selectKey,label:selectTarget.label,node:selectTarget.node},(o.actionValue||'').split(',').map(v=>v.trim()).filter(Boolean).map(buttonValue));break
      case 'variable':if(o.actionTarget)runtime.setVariable(o.actionTarget,o.actionValue||'');break
      case 'sheet':if(o.actionTarget)runtime.goToSheet(o.actionTarget);break
      case 'url':{const url=safeUrl(o.actionTarget);if(url)window.open(url,'_blank','noopener,noreferrer');break}
    }
  }
  const color=safeColor(o.color||null)
  return <div className="bi-button-wrap"><button type="button" className="bi-object-button" style={color?{background:color,borderColor:color}:undefined} onClick={run} disabled={runtime.editing}>
    {label}{o.action==='url'&&<ExternalLink size={13}/>}</button></div>
}

export function NavigationMenu(props:ObjectProps){
  const {object,runtime}=props
  if(!runtime)return needsRuntime(props)
  return <nav className={`bi-navigation ${object.options.vertical===false?'horizontal':''}`}>{runtime.sheets.map(sheet=>
    <button key={sheet.id} type="button" className={sheet.id===runtime.sheetId?'active':''} disabled={runtime.editing} onClick={()=>runtime.goToSheet(sheet.id)}>{sheet.title}</button>)}</nav>
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------
function childObjects(object:SheetObject,objects:SheetObject[]){
  return (object.options.children||[]).map(id=>objects.find(item=>item.id===id)).filter((item):item is SheetObject=>Boolean(item))
}
function ChildFrame({object,children}:{object:SheetObject;children:ReactNode}){
  return <div className="bi-child">{object.title&&<div className="bi-child-title">{object.title}</div>}<div className="bi-child-body">{children}</div></div>
}
export function TabContainer(props:Props){
  const {object,runtime,renderChild}=props
  const kids=runtime?childObjects(object,runtime.objects):[]
  const [active,setActive]=useState(0)
  if(!runtime)return needsRuntime(props)
  if(!kids.length)return <Message kind="empty">Add objects to this container in its settings</Message>
  const current=kids[Math.min(active,kids.length-1)]
  return <div className="bi-tabs-object">
    <div className="bi-tabs-bar" role="tablist">{kids.map((kid,i)=><button key={kid.id} role="tab" aria-selected={kid===current} className={kid===current?'active':''} onClick={()=>setActive(i)}>{kid.title||`Tab ${i+1}`}</button>)}</div>
    <div className="bi-child-body">{renderChild(current)}</div>
  </div>
}
export function LayoutContainer(props:Props){
  const {object,runtime,renderChild}=props
  if(!runtime)return needsRuntime(props)
  const kids=childObjects(object,runtime.objects)
  if(!kids.length)return <Message kind="empty">Add objects to this container in its settings</Message>
  return <div className={`bi-layout-object ${object.options.vertical?'vertical':''}`}>{kids.map(kid=><ChildFrame key={kid.id} object={kid}>{renderChild(kid)}</ChildFrame>)}</div>
}
export function TrellisContainer(props:Props){
  const {object,app,selections,dataVersion,compiled,runtime,renderChild}=props
  const dim=compiled.dimensions[0]
  const spec=useMemo(()=>buildSpec(compiled,selections,{measures:[],sort:[{index:0,desc:false}],limit:Math.min(24,object.options.limit||12)+1}),[compiled,selections,object.options.limit])
  const result=useQuery(app.id,spec,dataVersion)
  if(!runtime)return needsRuntime(props)
  const child=runtime.objects.find(item=>item.id===object.options.child)
  if(!child)return <Message kind="empty">Choose the object to repeat in this container's settings</Message>
  if(result.error)return <Message kind="error">{result.error}</Message>
  const limit=Math.min(24,object.options.limit||12)
  const values=result.rows.map(row=>row[0]).filter(v=>v!==null).slice(0,limit)
  const columns=Math.max(1,Math.min(6,object.options.columns||Math.ceil(Math.sqrt(values.length||1))))
  return <div className="bi-trellis-wrap">
    <div className="bi-trellis" style={{gridTemplateColumns:`repeat(${columns},minmax(0,1fr))`}}>
      {values.map(value=><ChildFrame key={JSON.stringify(value)} object={{...child,title:`${child.title?child.title+' · ':''}${displayValue(value,dim.format)}`}}>
        {renderChild({...child,title:''},[trellisCondition(dim.node,value)])}</ChildFrame>)}
    </div>
    {result.rows.filter(row=>row[0]!==null).length>limit&&<small className="bi-note">Showing the first {limit} values of {dim.label}</small>}
  </div>
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------
function Picture({url,fit,alt}:{url?:string;fit?:'contain'|'cover';alt:string}){
  const safe=safeUrl(url);const [failed,setFailed]=useState(false)
  useEffect(()=>setFailed(false),[safe])
  if(!safe||failed)return <div className="bi-image-empty"><ImageOff size={22}/><span>{safe?'The picture could not be loaded':'Add a picture address (https://…)'}</span></div>
  return <img className="bi-image" src={safe} alt={alt} style={{objectFit:fit||'contain'}} onError={()=>setFailed(true)} referrerPolicy="no-referrer"/>
}
export function ImageObject({object}:ObjectProps){return <Picture url={object.options.url} fit={object.options.fit} alt={object.title||'Picture'}/>}
export function TextImageObject({object}:ObjectProps){
  const text=object.options.text||''
  return <div className={`bi-textimage ${object.options.imageSide||'left'}`}>
    <div className="bi-textimage-picture"><Picture url={object.options.url} fit={object.options.fit||'cover'} alt={object.title||'Picture'}/></div>
    <div className="bi-text">{text.split(/\n{2,}/).map((block,i)=><p key={i}>{block.split('\n').map((line,j)=><span key={j}>{j>0&&<br/>}{line}</span>)}</p>)}</div>
  </div>
}
export function DividerObject({object}:ObjectProps){
  const color=safeColor(object.options.color||null)||'#c9d3db',thickness=Math.max(1,Math.min(12,object.options.thickness||2))
  return <div className={`bi-divider ${object.options.vertical?'vertical':''}`}><span style={object.options.vertical?{borderLeft:`${thickness}px solid ${color}`}:{borderTop:`${thickness}px solid ${color}`}}/></div>
}
export function VideoObject({object}:ObjectProps){
  const source=videoSource(object.options.url)
  if(!source)return <div className="bi-image-empty"><ImageOff size={22}/><span>Add a YouTube or Vimeo link, or a video file address (https://…mp4)</span></div>
  if(source.kind==='file')return <video className="bi-video" src={source.src} controls preload="metadata"/>
  return <iframe className="bi-video" src={source.src} title={object.title||'Video'} allow="encrypted-media; picture-in-picture; fullscreen" referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"/>
}
