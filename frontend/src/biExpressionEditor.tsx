import {useEffect,useMemo,useRef,useState,type KeyboardEvent as ReactKeyboardEvent,type ReactNode} from 'react'
import {BookOpen,Database,Maximize2,Play,Search,Sigma,X,FunctionSquare} from 'lucide-react'
import {createPortal} from 'react-dom'
import {supabase} from './supabase'
import {asMeasure,checkFields,ExpressionError,hasAggregation,parseExpression,type MasterMeasure} from './biExpression'
import {CATEGORIES,FUNCTION_CATALOGUE,OPERATORS,searchFunctions,type FunctionCategory,type FunctionSpec} from './biFunctions'
import {displayValue,orderedModel,runQuery,type ModelTable,type Selection} from './biApps'

export type ExpressionKind='dimension'|'measure'|'condition'
export type ExpressionContext={appId?:string;model:ModelTable[];measures:MasterMeasure[];selections?:Selection[]}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------
export type ExpressionProblem={message:string;line:number;column:number}

export function checkExpression(text:string,kind:ExpressionKind,ctx:ExpressionContext):ExpressionProblem|null{
  if(!text.trim())return null
  try{
    const node=parseExpression(text,{measures:ctx.measures})
    const fieldProblem=checkFields(node,ctx.model)
    if(fieldProblem)return {message:fieldProblem,...locate(text,text.length)}
    const agg=hasAggregation(kind==='measure'?asMeasure(node):node)
    if(kind==='measure'&&!agg)return {message:'A measure needs a field or an aggregation such as Sum(…), Count(…) or Avg(…)',...locate(text,0)}
    if(kind!=='measure'&&agg)return {message:kind==='dimension'?'Dimensions cannot use aggregations such as Sum(); put those in a measure':'Conditions filter rows and cannot use aggregations',...locate(text,0)}
    return null
  }catch(error){
    const position=error instanceof ExpressionError?error.position:0
    return {message:(error as Error).message,...locate(text,position)}
  }
}
function locate(text:string,position:number){
  const before=text.slice(0,position).split('\n')
  return {line:before.length,column:before[before.length-1].length+1}
}

// ---------------------------------------------------------------------------
// Searchable list of master measures, fields and functions
// ---------------------------------------------------------------------------
type PickItem={key:string;group:'Master measures'|'Fields'|'Functions';label:string;detail:string;insert:string;caretBack?:number;replaceAll?:boolean;spec?:FunctionSpec}

export function fieldRefFor(field:{table:string;name:string},all:{table:string;name:string}[]){
  const shared=all.filter(f=>f.name===field.name).length>1
  const plain=/^[a-z][a-z0-9_]*$/.test(field.name)?field.name:`[${field.name}]`
  return shared&&all.find(f=>f.name===field.name)?.table!==field.table?`${field.table}.${field.name}`:plain
}

function buildItems(kind:ExpressionKind,ctx:ExpressionContext,query:string,inline=false):PickItem[]{
  const needle=query.trim().toLowerCase()
  const fields=orderedModel(ctx.model).flatMap(table=>table.columns.map(column=>({table:table.alias,name:column.name,type:column.type})))
  const items:PickItem[]=[]
  if(kind==='measure')for(const m of ctx.measures){
    if(needle&&!m.name.toLowerCase().includes(needle))continue
    items.push({key:'m:'+m.name,group:'Master measures',label:`[${m.name}]`,detail:m.expression,insert:`[${m.name}]`})
  }
  for(const f of fields){
    const ref=fieldRefFor(f,fields)
    if(needle&&!(inline?ref:`${ref} ${f.table} ${f.type}`).toLowerCase().includes(needle))continue
    items.push({key:`f:${f.table}.${f.name}`,group:'Fields',label:ref,detail:`${f.table} · ${f.type}`,insert:ref})
  }
  const specs=searchFunctions(needle).filter(spec=>kind==='measure'||!spec.aggregate)
  for(const spec of specs)items.push({key:'fn:'+spec.name,group:'Functions',label:spec.signature,detail:spec.description,insert:spec.args[1]===0?`${spec.name}()`:`${spec.name}(`,spec})
  return items
}

export function ExpressionPicker({kind,ctx,query,onQuery,onPick,autoFocus,showSearch=true,activeIndex,onActiveIndex,tall}:{
  kind:ExpressionKind;ctx:ExpressionContext;query:string;onQuery?:(q:string)=>void;onPick:(item:PickItem)=>void
  autoFocus?:boolean;showSearch?:boolean;activeIndex:number;onActiveIndex:(i:number)=>void;tall?:boolean
}){
  const items=useMemo(()=>buildItems(kind,ctx,query,!showSearch),[kind,ctx,query,showSearch])
  const listRef=useRef<HTMLDivElement>(null)
  const active=items[Math.min(activeIndex,items.length-1)]
  useEffect(()=>{listRef.current?.querySelector('.active')?.scrollIntoView({block:'nearest'})},[activeIndex])
  let lastGroup=''
  return <div className={`bi-picker ${tall?'tall':''}`}>
    {showSearch&&<label className="bi-picker-search"><Search size={13}/><input autoFocus={autoFocus} placeholder="Search fields, measures and functions" value={query}
      onChange={event=>{onQuery?.(event.target.value);onActiveIndex(0)}}
      onKeyDown={event=>pickerKeys(event,items,activeIndex,onActiveIndex,onPick)}/>{query&&<button type="button" aria-label="Clear search" onClick={()=>onQuery?.('')}><X size={12}/></button>}</label>}
    <div className="bi-picker-list" ref={listRef} role="listbox">
      {items.map((item,i)=>{const head=item.group!==lastGroup;lastGroup=item.group
        const Icon=item.group==='Fields'?Database:item.group==='Master measures'?Sigma:FunctionSquare
        return <div key={item.key}>{head&&<span className="bi-picker-group">{item.group}</span>}
          <button type="button" role="option" aria-selected={i===activeIndex} className={i===activeIndex?'active':''} onMouseEnter={()=>onActiveIndex(i)} onClick={()=>onPick(item)}>
            <Icon size={12}/><code>{item.label}</code><small>{item.detail}</small></button></div>})}
      {!items.length&&<p className="bi-muted bi-picker-empty">Nothing matches "{query}".</p>}
    </div>
    {active?.spec&&tall&&<FunctionHelp spec={active.spec}/>}
  </div>
}

function pickerKeys(event:ReactKeyboardEvent,items:PickItem[],active:number,setActive:(i:number)=>void,onPick:(item:PickItem)=>void){
  if(event.key==='ArrowDown'){event.preventDefault();setActive(Math.min(items.length-1,active+1))}
  else if(event.key==='ArrowUp'){event.preventDefault();setActive(Math.max(0,active-1))}
  else if(event.key==='Enter'&&items[active]){event.preventDefault();onPick(items[active])}
}

function FunctionHelp({spec}:{spec:FunctionSpec}){
  return <div className="bi-fn-help"><b>{spec.signature}</b><p>{spec.description}</p>{spec.examples.map(example=><div key={example.expr}><code>{example.expr}</code><small>→ {example.result}</small></div>)}</div>
}

// Text before the caret that looks like a word being typed (used to filter suggestions).
function wordAtCaret(text:string,caret:number){
  const match=/[A-Za-z_][A-Za-z0-9_.]*$/.exec(text.slice(0,caret))
  return match?{word:match[0],start:caret-match[0].length}:{word:'',start:caret}
}

function insertAt(el:HTMLInputElement|HTMLTextAreaElement|null,value:string,item:PickItem,kind:ExpressionKind,onChange:(v:string)=>void){
  const caret=el?.selectionStart??value.length
  const {word,start}=wordAtCaret(value,caret)
  // a dimension that is empty (or just a partial word) becomes the picked field
  const from=word?start:caret,to=el?.selectionEnd??caret
  const next=kind==='dimension'&&item.group==='Fields'&&value.slice(0,from).trim()===''&&value.slice(to).trim()===''
    ?item.insert:value.slice(0,from)+item.insert+value.slice(to)
  onChange(next)
  const pos=(kind==='dimension'&&next===item.insert?next.length:from+item.insert.length)
  requestAnimationFrame(()=>{if(el){el.focus();el.setSelectionRange(pos,pos)}})
}

// ---------------------------------------------------------------------------
// The one-line expression box (with suggestions) and its expand button
// ---------------------------------------------------------------------------
export function ExpressionInput({value,kind,ctx,onChange,label}:{value:string;kind:ExpressionKind;ctx:ExpressionContext;onChange:(v:string)=>void;label?:string}){
  const ref=useRef<HTMLInputElement>(null)
  const [open,setOpen]=useState(false)
  const [expanded,setExpanded]=useState(false)
  const [active,setActive]=useState(0)
  const [caret,setCaret]=useState(0)
  const problem=useMemo(()=>checkExpression(value,kind,ctx),[value,kind,ctx])
  const word=wordAtCaret(value,caret).word
  const items=useMemo(()=>buildItems(kind,ctx,word,true),[kind,ctx,word])
  const placeholder=kind==='measure'?'e.g. Sum(qty * unit_price)':kind==='condition'?'e.g. invoice_date = Today()-1':'Field, e.g. branch'
  const multiLine=value.includes('\n')
  return <div className="bi-expr">
    <div className="bi-expr-box">
      <input ref={ref} value={multiLine?value.replace(/\s*\n\s*/g,' ⏎ '):value} readOnly={multiLine} placeholder={placeholder} aria-label={label||kind}
        className={problem?'invalid':''} spellCheck={false}
        onChange={event=>{onChange(event.target.value);setCaret(event.target.selectionStart??0);setActive(0);setOpen(true)}}
        onClick={event=>multiLine?setExpanded(true):setCaret((event.target as HTMLInputElement).selectionStart??0)}
        onKeyUp={event=>setCaret((event.target as HTMLInputElement).selectionStart??0)}
        onFocus={()=>{if(!multiLine)setOpen(true)}} onBlur={()=>setTimeout(()=>setOpen(false),150)}
        onKeyDown={event=>{
          if(event.key==='Escape'){setOpen(false);return}
          if(open&&(event.key==='ArrowDown'||event.key==='ArrowUp'||(event.key==='Enter'&&word)))pickerKeys(event,items,active,setActive,item=>{insertAt(ref.current,value,item,kind,onChange);setActive(0)})
        }}/>
      <button type="button" className="bi-expand" title="Open the large editor" aria-label="Open the large editor" onClick={()=>{setOpen(false);setExpanded(true)}}><Maximize2 size={13}/></button>
    </div>
    {problem&&<small className="bi-expr-error">{problem.message}</small>}
    {open&&!multiLine&&<div className="bi-expr-menu" onMouseDown={event=>event.preventDefault()}>
      <ExpressionPicker kind={kind} ctx={ctx} query={word} showSearch={false} activeIndex={active} onActiveIndex={setActive}
        onPick={item=>{insertAt(ref.current,value,item,kind,onChange);setActive(0)}}/>
      <div className="bi-expr-menu-foot"><span>Type to search · ↑↓ and Enter to insert</span><button type="button" className="text-button" onClick={()=>{setOpen(false);setExpanded(true)}}><Maximize2 size={11}/>Large editor</button></div>
    </div>}
    {expanded&&<ExpressionEditorModal value={value} kind={kind} ctx={ctx} title={label} onCancel={()=>setExpanded(false)} onApply={next=>{onChange(next);setExpanded(false)}}/>}
  </div>
}

// ---------------------------------------------------------------------------
// The large editor
// ---------------------------------------------------------------------------
export function ExpressionEditorModal({value,kind,ctx,title,onApply,onCancel}:{value:string;kind:ExpressionKind;ctx:ExpressionContext;title?:string;onApply:(v:string)=>void;onCancel:()=>void}){
  const [text,setText]=useState(value)
  const [query,setQuery]=useState('')
  const [active,setActive]=useState(0)
  const [result,setResult]=useState<{ok:boolean;content:ReactNode}|null>(null)
  const [testing,setTesting]=useState(false)
  const ref=useRef<HTMLTextAreaElement>(null)
  const gutter=useRef<HTMLDivElement>(null)
  const problem=useMemo(()=>checkExpression(text,kind,ctx),[text,kind,ctx])
  const lines=text.split('\n').length
  useEffect(()=>{const el=ref.current;if(el){el.focus();el.setSelectionRange(el.value.length,el.value.length)}},[])
  useEffect(()=>{const close=(event:KeyboardEvent)=>{if(event.key==='Escape')onCancel()};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close)},[onCancel])

  async function test(){
    if(!supabase||!ctx.appId||problem||!text.trim())return
    setTesting(true);setResult(null)
    try{
      const parsed=parseExpression(text,{measures:ctx.measures})
      const node=kind==='measure'?asMeasure(parsed):parsed
      const selections=(ctx.selections||[]).map(item=>({expr:item.node,values:item.values}))
      if(kind==='measure'){
        const out=await runQuery(supabase,ctx.appId,{measures:[{expr:node}],selections,limit:1})
        setResult({ok:true,content:<>Result over {selections.length?'the current selections':'all data'}: <b>{displayValue(out.rows[0]?.[0]??null)}</b></>})
      }else if(kind==='dimension'){
        const out=await runQuery(supabase,ctx.appId,{dimensions:[{expr:node}],measures:[{expr:{t:'fn',name:'count',args:[{t:'star'}]}}],selections,sort:[{index:1,desc:true}],limit:8})
        setResult({ok:true,content:<>Most common values: {out.rows.map((row,i)=><span key={i} className="bi-chip-plain">{displayValue(row[0])} <small>({displayValue(row[1])} rows)</small></span>)}{out.has_more&&' …'}</>})
      }else{
        const [all,match]=await Promise.all([
          runQuery(supabase,ctx.appId,{measures:[{expr:{t:'fn',name:'count',args:[{t:'star'}]}}],selections,limit:1}),
          runQuery(supabase,ctx.appId,{measures:[{expr:{t:'fn',name:'count',args:[{t:'star'}]}}],selections,conditions:[node],limit:1})])
        setResult({ok:true,content:<>Matches <b>{displayValue(match.rows[0]?.[0]??0)}</b> of {displayValue(all.rows[0]?.[0]??0)} rows.</>})
      }
    }catch(error){setResult({ok:false,content:(error as Error).message})}
    finally{setTesting(false)}
  }
  function pick(item:PickItem){
    const el=ref.current;const start=el?.selectionStart??text.length,end=el?.selectionEnd??start
    const next=text.slice(0,start)+item.insert+text.slice(end)
    setText(next);setResult(null)
    requestAnimationFrame(()=>{if(el){el.focus();const pos=start+item.insert.length;el.setSelectionRange(pos,pos)}})
  }
  const kindLabel=kind==='measure'?'Measure':kind==='dimension'?'Dimension':'Condition'
  return createPortal(<div className="overlay bi-modal-overlay" onMouseDown={event=>{if(event.target===event.currentTarget)onCancel()}}>
    <div className="bi-modal" role="dialog" aria-modal="true" aria-label={`Edit ${kindLabel.toLowerCase()} expression`}>
      <div className="bi-modal-head"><div><span className="eyebrow">{kindLabel.toUpperCase()} EXPRESSION</span><h2>{title||'Edit expression'}</h2></div>
        <button className="icon-button" aria-label="Close" onClick={onCancel}><X size={18}/></button></div>
      <div className="bi-modal-body">
        <div className="bi-modal-editor">
          <div className="bi-code">
            <div className="bi-gutter" ref={gutter} aria-hidden="true">{Array.from({length:lines},(_,i)=><span key={i} className={problem?.line===i+1?'err':''}>{i+1}</span>)}</div>
            <textarea ref={ref} value={text} spellCheck={false} className={problem?'invalid':''} wrap="off"
              placeholder={kind==='measure'?'Sum(qty * unit_price)  // write on several lines, with comments':'Write the expression here'}
              onScroll={event=>{if(gutter.current)gutter.current.scrollTop=(event.target as HTMLTextAreaElement).scrollTop}}
              onChange={event=>{setText(event.target.value);setResult(null)}}
              onKeyDown={event=>{
                if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();if(!problem)onApply(text)}
                if(event.key==='Tab'){event.preventDefault();const el=event.currentTarget;const s=el.selectionStart;setText(text.slice(0,s)+'  '+text.slice(el.selectionEnd));requestAnimationFrame(()=>el.setSelectionRange(s+2,s+2))}
              }}/>
          </div>
          <div className={`bi-status ${problem?'error':text.trim()?'ok':''}`}>
            {problem?<>Line {problem.line}, column {problem.column}: {problem.message}</>:text.trim()?<>Looks good.{kind==='measure'&&' Measures are calculated per value of the chart’s dimensions.'}</>:<>Empty</>}
          </div>
          {result&&<div className={`bi-test-result ${result.ok?'':'error'}`}>{result.content}</div>}
        </div>
        <aside className="bi-modal-side">
          <ExpressionPicker kind={kind} ctx={ctx} query={query} onQuery={setQuery} activeIndex={active} onActiveIndex={setActive} onPick={pick} tall/>
        </aside>
      </div>
      <div className="editor-foot bi-modal-foot">
        <span className="bi-muted">Ctrl+Enter to apply · Esc to cancel · Tab indents</span>
        {ctx.appId?<button className="secondary" disabled={Boolean(problem)||!text.trim()||testing} onClick={()=>void test()}><Play size={14}/>{testing?'Testing…':'Test'}</button>
          :<span className="bi-muted">Save the app first to test against data</span>}
        <button className="secondary" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={Boolean(problem)} onClick={()=>onApply(text)}>Apply</button>
      </div>
    </div>
  </div>,document.body)
}

// ---------------------------------------------------------------------------
// Function reference page
// ---------------------------------------------------------------------------
export function FunctionReference(){
  const [query,setQuery]=useState('')
  const [category,setCategory]=useState<FunctionCategory|'All'>('All')
  const specs=searchFunctions(query).filter(spec=>category==='All'||spec.category===category)
  return <section className="rfq-workspace">
    <div className="sd-session-bar"><BookOpen size={18}/><span>Function reference</span><small className="rp-live">{FUNCTION_CATALOGUE.length} functions for dimensions, measures and conditions</small></div>
    <div className="rp-toolbar">
      <label className="rp-search"><Search size={15}/><input placeholder="Search, e.g. text, month, join, round" value={query} onChange={event=>setQuery(event.target.value)}/></label>
      <div className="sd-view-tabs bi-ref-tabs">{(['All',...CATEGORIES] as const).map(item=><button key={item} className={category===item?'active':''} onClick={()=>setCategory(item)}>{item}</button>)}</div>
    </div>
    {!query&&category==='All'&&<div className="bi-card"><h3>Operators and syntax</h3><table className="bi-ref-ops"><tbody>{OPERATORS.map(o=><tr key={o.op}><td><code>{o.op}</code></td><td>{o.description}</td><td><code>{o.example}</code></td></tr>)}</tbody></table>
      <p className="hint">Dimensions split the data and cannot aggregate. Measures combine records with an aggregation; a field on its own in a measure means <code>Only(field)</code>, as in Qlik. Conditions filter rows before anything is calculated. Master measures are used as <code>[Name]</code>. Function names are not case-sensitive. Each aggregation counts every record of the tables it uses once, so <code>Sum(qty_on_hand)</code> adds each stock item once even when it is on many invoice lines.</p></div>}
    <div className="bi-ref-grid">{specs.map(spec=><article key={spec.name} className="bi-ref-card">
      <div className="bi-ref-head"><code>{spec.signature}</code><span className="sd-type">{spec.category}</span></div>
      <p>{spec.description}{spec.aliases?.length?<> Also written as {spec.aliases.join(', ')}().</>:null}</p>
      {spec.examples.map(example=><div key={example.expr} className="bi-ref-example"><code>{example.expr}</code><small>→ {example.result}</small></div>)}
    </article>)}</div>
    {!specs.length&&<div className="rfq-empty-card"><Search size={24}/><h3>No functions match</h3><p>Try another word, or All categories.</p></div>}
  </section>
}
