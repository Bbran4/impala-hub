// Shared pieces for Reporting chart objects: data fetching, sizing, messages, tooltip, legend.
import {useEffect,useLayoutEffect,useState,type ReactNode} from 'react'
import {AlertTriangle,Loader2} from 'lucide-react'
import {supabase} from './supabase'
import {runQuery,sameValue,type AppDetail,type CompiledObject,type FieldValue,type Selection,type SheetObject} from './biApps'

export type SelectFn=(dimension:{key:string;label:string;node:CompiledObject['dimensions'][number]['node']},value:FieldValue,additive:boolean)=>void

export type ObjectProps={object:SheetObject;app:AppDetail;selections:Selection[];onSelect:SelectFn;dataVersion:string}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------
export const cache=new Map<string,{rows:FieldValue[][];has_more:boolean}>()

export function useQuery(appId:string,spec:unknown|null,version:string){
  const key=spec?appId+'|'+version+'|'+JSON.stringify(spec):''
  const [state,setState]=useState<{key:string;rows:FieldValue[][];has_more:boolean;error:string;loading:boolean}>({key:'',rows:[],has_more:false,error:'',loading:false})
  useEffect(()=>{
    if(!spec||!supabase){setState({key,rows:[],has_more:false,error:'',loading:false});return}
    const hit=cache.get(key)
    if(hit){setState({key,...hit,error:'',loading:false});return}
    let alive=true
    setState(current=>({...current,key,error:'',loading:true}))
    runQuery(supabase,appId,spec).then(result=>{
      if(cache.size>300)cache.delete(cache.keys().next().value!)
      cache.set(key,result)
      if(alive)setState({key,rows:result.rows,has_more:result.has_more,error:'',loading:false})
    }).catch(error=>{if(alive)setState({key,rows:[],has_more:false,error:(error as Error).message,loading:false})})
    return()=>{alive=false}
  },[key])// eslint-disable-line react-hooks/exhaustive-deps
  // until the new result arrives, report loading (and keep showing the previous rows)
  return state.key===key?state:{...state,loading:Boolean(spec)}
}

// Measures an element; a callback ref so it works when the element mounts after the first render.
export function useSize<T extends HTMLElement>(){
  const [node,setNode]=useState<T|null>(null);const [size,setSize]=useState({width:0,height:0})
  useLayoutEffect(()=>{
    if(!node)return
    const observer=new ResizeObserver(([entry])=>setSize({width:Math.floor(entry.contentRect.width),height:Math.floor(entry.contentRect.height)}))
    observer.observe(node);return()=>observer.disconnect()
  },[node])
  return [setNode,size] as const
}

export function Message({kind,children}:{kind:'error'|'empty'|'loading';children:ReactNode}){
  return <div className={`bi-message ${kind}`}>{kind==='error'?<AlertTriangle size={16}/>:kind==='loading'?<Loader2 size={16} className="bi-spin"/>:null}<span>{children}</span></div>
}


// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------
export type Tip={x:number;y:number;title:string;lines:{color?:string;label:string;value:string}[]}
export function Tooltip({tip,width}:{tip:Tip|null;width:number}){
  if(!tip)return null
  const left=Math.min(Math.max(tip.x+12,4),Math.max(4,width-220))
  return <div className="bi-tooltip" style={{left,top:Math.max(4,tip.y-10)}}>
    <b>{tip.title}</b>
    {tip.lines.map((line,i)=><div key={i}>{line.color&&<i style={{background:line.color}}/>}<span>{line.label}</span><em>{line.value}</em></div>)}
  </div>
}

export function Legend({items,onClick,selected}:{items:{name:string;color:string;value?:FieldValue}[];onClick?:(value:FieldValue,additive:boolean)=>void;selected?:FieldValue[]}){
  if(items.length<2)return null
  return <div className="bi-legend">{items.map(item=><button key={item.name} type="button" disabled={!onClick||item.name==='Other'}
    className={selected?.some(value=>sameValue(value,item.value??item.name))?'selected':''}
    onClick={event=>onClick?.(item.value??item.name,event.ctrlKey||event.metaKey)}><i style={{background:item.color}}/>{item.name}</button>)}</div>
}

export function selectedValues(selections:Selection[],key:string){return selections.find(item=>item.key===key)?.values||[]}


export function truncate(text:string,max:number){return text.length>max?text.slice(0,Math.max(1,max-1))+'…':text}

export type Compiled={compiled:CompiledObject}
