import type {SupabaseClient} from '@supabase/supabase-js'
import {AGGREGATIONS,checkFields,hasAggregation,parseExpression,plainField,type ExprNode,type MasterMeasure} from './biExpression.ts'

// Reporting apps: data model, sheets and objects. All data access goes through the
// role-checked public.bi_* functions (migrations 0046 and 0047).

export type FieldValue=string|number|boolean|null
export type Column={name:string;type:string}
export type ModelTable={
  alias:string;table_name:string;parent_alias:string|null;join_type:'left'|'inner';join_pairs:[string,string][]
  description?:string|null;row_count?:number|null;last_loaded_at?:string|null;columns:Column[]
}
export type AccessEntry={type:'role'|'user';principal:string}
export type NumberFormat='auto'|'number'|'integer'|'money'|'percent'
export type ObjectItem={expr:string;label?:string;format?:NumberFormat}
export type ObjectKind='kpi'|'bar'|'line'|'pie'|'table'|'pivot'|'filter'|'text'
export type ObjectOptions={
  conditions?:string[];sortBy?:number;sortDesc?:boolean;limit?:number
  horizontal?:boolean;stacked?:boolean;text?:string;totals?:boolean
}
export type SheetObject={id:string;kind:ObjectKind;title:string;x:number;y:number;w:number;h:number;dimensions:ObjectItem[];measures:ObjectItem[];options:ObjectOptions}
export type Sheet={id:string;title:string;position:number;objects:SheetObject[];updated_at?:string}
export type AppSummary={id:string;name:string;description:string;updated_at:string;can_edit:boolean;tables:string[];sheets:{id:string;title:string}[];last_loaded_at:string|null}
export type AppDetail={id:string;name:string;description:string;measures:MasterMeasure[];updated_at:string;can_edit:boolean;model:ModelTable[];sheets:Sheet[];access:AccessEntry[]|null}
export type MyAccess={admin:boolean;builder:boolean;catalogue:boolean;apps:number}
export type Principals={roles:{id:string;label:string}[];users:{id:string;name:string;email:string}[]}
export type Selection={key:string;label:string;node:ExprNode;values:FieldValue[]}
export type QueryResult={rows:FieldValue[][];has_more:boolean}

export const GRID_COLS=24
export const ROW_HEIGHT=44
export const SERIES_COLORS=['#2a78d6','#eb6834','#1baf7a','#eda100','#e87ba4','#008300','#6250d6','#e34948']

export const KIND_INFO:Record<ObjectKind,{label:string;dims:[number,number];measures:[number,number];w:number;h:number;hint:string}>={
  kpi:{label:'KPI',dims:[0,0],measures:[1,2],w:6,h:3,hint:'One headline number, with an optional second for comparison.'},
  bar:{label:'Bar chart',dims:[1,2],measures:[1,4],w:12,h:7,hint:'Compare values across categories. A second dimension splits each bar.'},
  line:{label:'Line chart',dims:[1,2],measures:[1,4],w:12,h:7,hint:'Show change over time. A second dimension draws one line per value.'},
  pie:{label:'Pie chart',dims:[1,1],measures:[1,1],w:8,h:7,hint:'Share of a whole across a few categories.'},
  table:{label:'Table',dims:[0,10],measures:[0,20],w:24,h:8,hint:'Rows of dimensions and measures, sortable, with totals.'},
  pivot:{label:'Pivot table',dims:[2,4],measures:[1,4],w:24,h:8,hint:'The last dimension becomes the columns.'},
  filter:{label:'Filter pane',dims:[1,1],measures:[0,0],w:6,h:7,hint:'Lists the values of a field so people can select them.'},
  text:{label:'Text',dims:[0,0],measures:[0,0],w:8,h:3,hint:'A heading or note.'},
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------
function fail(error:{message:string}|null){if(error)throw new Error(error.message)}
export async function loadMyAccess(client:SupabaseClient){const {data,error}=await client.rpc('bi_my_access');fail(error);return data as MyAccess}
export async function loadApps(client:SupabaseClient){const {data,error}=await client.rpc('bi_list_apps');fail(error);return (data||[]) as AppSummary[]}
export async function loadApp(client:SupabaseClient,id:string){const {data,error}=await client.rpc('bi_get_app',{p_app:id});fail(error);return normalizeApp(data as AppDetail)}
export async function saveApp(client:SupabaseClient,app:{id?:string;name:string;description:string;model:ModelTable[];measures:MasterMeasure[];access?:AccessEntry[]}){
  const payload={...app,model:app.model.map(({alias,table_name,parent_alias,join_type,join_pairs})=>({alias,table_name,parent_alias,join_type,join_pairs}))}
  const {data,error}=await client.rpc('bi_save_app',{p:payload});fail(error);return data as string
}
export async function deleteApp(client:SupabaseClient,id:string){const {error}=await client.rpc('bi_delete_app',{p_app:id});fail(error)}
export async function saveSheet(client:SupabaseClient,appId:string,sheet:{id?:string;title:string;position?:number;objects:SheetObject[]}){
  const {data,error}=await client.rpc('bi_save_sheet',{p:{...sheet,app_id:appId}});fail(error);return data as string
}
export async function deleteSheet(client:SupabaseClient,id:string){const {error}=await client.rpc('bi_delete_sheet',{p_sheet:id});fail(error)}
export async function loadPrincipals(client:SupabaseClient){const {data,error}=await client.rpc('bi_list_principals');fail(error);return data as Principals}
export async function runQuery(client:SupabaseClient,appId:string,spec:unknown){const {data,error}=await client.rpc('bi_query',{p_app:appId,p_spec:spec});fail(error);return data as QueryResult}

export function normalizeApp(app:AppDetail):AppDetail{
  return {...app,measures:app.measures||[],model:(app.model||[]).map(table=>({...table,join_pairs:table.join_pairs||[],columns:table.columns||[]})),
    sheets:(app.sheets||[]).map(sheet=>({...sheet,objects:(sheet.objects||[]).map(normalizeObject)}))}
}
export function normalizeObject(object:Partial<SheetObject>):SheetObject{
  const kind=(object.kind&&object.kind in KIND_INFO?object.kind:'table') as ObjectKind
  return {id:object.id||newId(),kind,title:object.title||'',x:clampInt(object.x,0,GRID_COLS-1,0),y:clampInt(object.y,0,1000,0),
    w:clampInt(object.w,2,GRID_COLS,KIND_INFO[kind].w),h:clampInt(object.h,2,40,KIND_INFO[kind].h),
    dimensions:object.dimensions||[],measures:object.measures||[],options:object.options||{}}
}
function clampInt(value:unknown,min:number,max:number,fallback:number){const n=Number(value);return Number.isFinite(n)?Math.min(max,Math.max(min,Math.round(n))):fallback}
export function humanize(name:string){const text=name.replace(/_/g,' ').trim();return text.charAt(0).toUpperCase()+text.slice(1)}
export function newId(){return Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4)}

// ---------------------------------------------------------------------------
// Data model helpers
// ---------------------------------------------------------------------------

// Tables in join order: the main table first, then children breadth-first.
export function orderedModel(model:ModelTable[]){
  const root=model.find(table=>!table.parent_alias);if(!root)return model
  const out=[root];const queue=[root.alias]
  while(queue.length){const parent=queue.shift()!;for(const child of model.filter(table=>table.parent_alias===parent)){out.push(child);queue.push(child.alias)}}
  return out.concat(model.filter(table=>!out.includes(table)))
}

// Which table a field belongs to: explicit table, else the first table (in join order) that has it.
export function resolveField(model:ModelTable[],ref:{table?:string;name:string}){
  if(ref.table)return model.some(table=>table.alias===ref.table&&table.columns.some(column=>column.name===ref.name))?ref.table:null
  return orderedModel(model).find(table=>table.columns.some(column=>column.name===ref.name))?.alias||null
}

// Suggested links between two tables: fields with the same name, key-like names first.
const KEY_LIKE=/(^id$|_id$|_no$|_code$|_key$|^code$|_number$|_num$)/
export function suggestLinks(child:Column[],parent:Column[]){
  const parentNames=new Set(parent.map(column=>column.name))
  return child.filter(column=>parentNames.has(column.name)).map(column=>({pair:[column.name,column.name] as [string,string],likelyKey:KEY_LIKE.test(column.name)}))
    .sort((a,b)=>Number(b.likelyKey)-Number(a.likelyKey)||a.pair[0].localeCompare(b.pair[0]))
}

export function modelProblems(model:ModelTable[]){
  const problems:string[]=[]
  const roots=model.filter(table=>!table.parent_alias)
  if(!model.length)problems.push('Add at least one table.')
  else if(roots.length!==1)problems.push('Choose exactly one main table.')
  for(const table of model){
    if(table.parent_alias&&!table.join_pairs.length)problems.push(`Choose how ${table.alias} links to ${table.parent_alias}.`)
    if(table.parent_alias&&!model.some(other=>other.alias===table.parent_alias))problems.push(`${table.alias} links to a table that is not in the model.`)
  }
  if(roots.length===1&&orderedModel(model).length!==model.length)problems.push('Every table must link back to the main table.')
  return problems
}

// ---------------------------------------------------------------------------
// Selections (Qlik-style: clicking values filters every object in the app)
// ---------------------------------------------------------------------------
export function selectionKey(model:ModelTable[],node:ExprNode){
  const field=plainField(node)
  if(!field)return null
  const alias=resolveField(model,field)
  return alias?`${alias}.${field.name}`:null
}

export function toggleSelection(selections:Selection[],selection:{key:string;label:string;node:ExprNode},value:FieldValue,additive:boolean){
  const existing=selections.find(item=>item.key===selection.key)
  if(!existing)return [...selections,{...selection,values:[value]}]
  const has=existing.values.some(item=>sameValue(item,value))
  let values:FieldValue[]
  if(additive)values=has?existing.values.filter(item=>!sameValue(item,value)):[...existing.values,value]
  else values=has&&existing.values.length===1?[]:[value]
  return values.length?selections.map(item=>item.key===selection.key?{...item,values}:item):selections.filter(item=>item.key!==selection.key)
}
export function sameValue(a:FieldValue,b:FieldValue){
  if(typeof a==='number'||typeof b==='number')return Number(a)===Number(b)&&a!==null&&b!==null
  return a===b
}

// ---------------------------------------------------------------------------
// Query specs
// ---------------------------------------------------------------------------
export type CompiledObject={
  dimensions:{node:ExprNode;label:string;selectKey:string;format?:NumberFormat}[]
  measures:{node:ExprNode;label:string;format?:NumberFormat}[]
  conditions:ExprNode[]
  errors:string[]
}

export function compileObject(object:SheetObject,app:Pick<AppDetail,'model'|'measures'>):CompiledObject{
  const errors:string[]=[]
  const info=KIND_INFO[object.kind]
  const parse=(text:string,where:string)=>{
    try{
      const node=parseExpression(text,{measures:app.measures})
      const problem=checkFields(node,app.model)
      if(problem){errors.push(`${where}: ${problem}`);return null}
      return node
    }catch(error){errors.push(`${where}: ${(error as Error).message}`);return null}
  }
  const dimensions:CompiledObject['dimensions']=[]
  object.dimensions.forEach((item,i)=>{
    const node=parse(item.expr,`Dimension ${i+1}`);if(!node)return
    if(hasAggregation(node)){errors.push(`Dimension ${i+1}: dimensions cannot use ${AGGREGATIONS.map(name=>name[0].toUpperCase()+name.slice(1)+'()').join(', ')}`);return}
    dimensions.push({node,label:item.label||(node.t==='field'?humanize(node.name):item.expr),selectKey:selectionKey(app.model,node)||'expr:'+JSON.stringify(node),format:item.format})
  })
  const measures:CompiledObject['measures']=[]
  object.measures.forEach((item,i)=>{
    const node=parse(item.expr,`Measure ${i+1}`);if(!node)return
    if(!hasAggregation(node)){errors.push(`Measure ${i+1}: use an aggregation such as Sum(${item.expr})`);return}
    const master=app.measures.find(measure=>`[${measure.name}]`.toLowerCase()===item.expr.trim().toLowerCase())
    measures.push({node,label:item.label||master?.name||item.expr,format:item.format||(master?.format as NumberFormat|undefined)})
  })
  const conditions:ExprNode[]=[]
  ;(object.options.conditions||[]).filter(text=>text.trim()).forEach((text,i)=>{
    const node=parse(text,`Condition ${i+1}`);if(!node)return
    if(hasAggregation(node))errors.push(`Condition ${i+1}: conditions filter rows and cannot aggregate`)
    else conditions.push(node)
  })
  if(object.kind!=='text'){
    if(object.dimensions.length<info.dims[0]||object.dimensions.length>info.dims[1])errors.push(info.dims[0]===info.dims[1]?`${info.label} needs ${info.dims[0]} dimension${info.dims[0]===1?'':'s'}.`:`${info.label} needs ${info.dims[0]} to ${info.dims[1]} dimensions.`)
    if(object.measures.length<info.measures[0]||object.measures.length>info.measures[1])errors.push(info.measures[0]===info.measures[1]?`${info.label} needs ${info.measures[0]} measure${info.measures[0]===1?'':'s'}.`:`${info.label} needs ${info.measures[0]} to ${info.measures[1]} measures.`)
    if(object.kind==='table'&&!object.dimensions.length&&!object.measures.length)errors.push('Add a dimension or a measure.')
    if((object.kind==='bar'||object.kind==='line')&&object.dimensions.length===2&&object.measures.length>1)errors.push('With two dimensions, use one measure.')
  }
  return {dimensions,measures,conditions,errors}
}

export function buildSpec(compiled:CompiledObject,selections:Selection[],options:{
  ignoreKey?:string|null;dimensions?:number[];measures?:number[];sort?:{index:number;desc:boolean}[];limit?:number;offset?:number
}={}){
  const dims=(options.dimensions??compiled.dimensions.map((_,i)=>i)).map(i=>compiled.dimensions[i])
  const meas=(options.measures??compiled.measures.map((_,i)=>i)).map(i=>compiled.measures[i])
  return {
    dimensions:dims.map(item=>({expr:item.node})),
    measures:meas.map(item=>({expr:item.node})),
    selections:selections.filter(item=>item.key!==options.ignoreKey&&item.values.length).map(item=>({expr:item.node,values:item.values})),
    conditions:compiled.conditions,
    sort:options.sort||[],
    limit:options.limit??1000,
    offset:options.offset??0,
  }
}

// Default sort: charts with a measure sort by the first measure (largest first), except line
// charts, which follow the dimension (usually time).
export function defaultSort(object:SheetObject,compiled:CompiledObject){
  if(object.options.sortBy!=null&&object.options.sortBy<compiled.dimensions.length+compiled.measures.length)return [{index:object.options.sortBy,desc:Boolean(object.options.sortDesc)}]
  if(object.kind==='line'||object.kind==='pivot'||object.kind==='filter'||!compiled.measures.length)return compiled.dimensions.map((_,index)=>({index,desc:false}))
  return [{index:compiled.dimensions.length,desc:true}]
}

// ---------------------------------------------------------------------------
// Shaping results
// ---------------------------------------------------------------------------
export type Series={name:string;color:string;values:(number|null)[]}
export type SeriesData={categories:FieldValue[];series:Series[]}

// [dim, m1, m2...] -> one series per measure; [dim, splitDim, m] -> one series per split value.
// Colour follows the series name (stable when filters change); more than 8 split values fold into "Other".
export function toSeries(rows:FieldValue[][],dimCount:number,measureLabels:string[],stableOrder:string[]=[]):SeriesData{
  const categories:FieldValue[]=[];const catIndex=new Map<string,number>()
  const cat=(value:FieldValue)=>{const key=JSON.stringify(value);if(!catIndex.has(key)){catIndex.set(key,categories.length);categories.push(value)}return catIndex.get(key)!}
  if(dimCount<2){
    const series=measureLabels.map((name,i)=>({name,color:SERIES_COLORS[i%SERIES_COLORS.length],values:[] as (number|null)[]}))
    for(const row of rows){const c=cat(row[0]);series.forEach((s,i)=>{s.values[c]=toNumber(row[1+i])})}
    series.forEach(s=>{for(let i=0;i<categories.length;i++)if(s.values[i]===undefined)s.values[i]=null})
    return {categories,series}
  }
  const totals=new Map<string,number>()
  for(const row of rows){const name=displayValue(row[1]);totals.set(name,(totals.get(name)||0)+Math.abs(toNumber(row[2])||0))}
  const ranked=[...totals.keys()].sort((a,b)=>(totals.get(b)||0)-(totals.get(a)||0))
  const keep=ranked.length>8?ranked.slice(0,7):ranked
  const names=[...stableOrder.filter(name=>keep.includes(name)),...keep.filter(name=>!stableOrder.includes(name))]
  if(ranked.length>8)names.push('Other')
  const series=names.map((name,i)=>({name,color:name==='Other'?'#9aa5ae':SERIES_COLORS[i%SERIES_COLORS.length],values:[] as (number|null)[]}))
  const byName=new Map(series.map(s=>[s.name,s]))
  for(const row of rows){
    const c=cat(row[0]);const name=displayValue(row[1]);const s=byName.get(keep.includes(name)?name:'Other')!
    s.values[c]=(s.values[c]||0)+(toNumber(row[2])||0)
  }
  series.forEach(s=>{for(let i=0;i<categories.length;i++)if(s.values[i]===undefined)s.values[i]=null})
  return {categories,series}
}

export type PivotData={rowKeys:FieldValue[][];colKeys:FieldValue[];cells:Map<string,FieldValue[]>}
// rows: [r1..rk, col, m1..mn]
export function toPivot(rows:FieldValue[][],rowDims:number):PivotData{
  const rowKeys:FieldValue[][]=[];const seenRows=new Set<string>();const colKeys:FieldValue[]=[];const seenCols=new Set<string>()
  const cells=new Map<string,FieldValue[]>()
  for(const row of rows){
    const r=row.slice(0,rowDims);const c=row[rowDims];const rk=JSON.stringify(r);const ck=JSON.stringify(c)
    if(!seenRows.has(rk)){seenRows.add(rk);rowKeys.push(r)}
    if(!seenCols.has(ck)){seenCols.add(ck);colKeys.push(c)}
    cells.set(rk+'|'+ck,row.slice(rowDims+1))
  }
  colKeys.sort((a,b)=>compareValues(a,b))
  return {rowKeys,colKeys,cells}
}

export function compareValues(a:FieldValue,b:FieldValue){
  if(a===null)return b===null?0:1
  if(b===null)return -1
  if(typeof a==='number'&&typeof b==='number')return a-b
  return String(a).localeCompare(String(b),undefined,{numeric:true,sensitivity:'base'})
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
export function toNumber(value:FieldValue){
  if(value===null||value===undefined||value==='')return null
  const n=typeof value==='number'?value:Number(value)
  return Number.isFinite(n)?n:null
}
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/
const TIMESTAMP_RE=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
export function displayValue(value:FieldValue,format?:NumberFormat){
  if(value===null||value===undefined)return '(empty)'
  if(typeof value==='number')return formatNumber(value,format)
  if(typeof value==='boolean')return value?'Yes':'No'
  if(TIMESTAMP_RE.test(value))return value.slice(0,16).replace('T',' ')
  if(DATE_RE.test(value))return value
  if(format&&format!=='auto'&&value!==''&&Number.isFinite(Number(value)))return formatNumber(Number(value),format)
  return value
}
export function formatNumber(value:number|null,format:NumberFormat='auto'){
  if(value===null||!Number.isFinite(value))return '—'
  switch(format){
    case 'integer':return Math.round(value).toLocaleString('en-ZA')
    case 'money':return 'R '+value.toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2})
    case 'percent':return (value*100).toLocaleString('en-ZA',{maximumFractionDigits:1})+'%'
    case 'number':return value.toLocaleString('en-ZA',{maximumFractionDigits:2})
    default:return value.toLocaleString('en-ZA',{maximumFractionDigits:Math.abs(value)>=100?0:2})
  }
}
export function compactNumber(value:number,format:NumberFormat='auto'){
  const abs=Math.abs(value)
  const scaled=abs>=1e9?[value/1e9,'B']:abs>=1e6?[value/1e6,'M']:abs>=1e3?[value/1e3,'K']:[value,''] as [number,string]
  if(format==='percent')return formatNumber(value,'percent')
  const text=`${Number((scaled[0] as number).toFixed(Math.abs(scaled[0] as number)>=10||!scaled[1]?0:1))}${scaled[1]}`
  return format==='money'?'R '+text:text
}
export function niceTicks(min:number,max:number,count=5){
  if(min===max){max=min===0?1:min*1.1;if(min>0)min=0}
  const lo=Math.min(0,min),hi=Math.max(0,max)
  const raw=(hi-lo)/count;const mag=10**Math.floor(Math.log10(raw));const step=[1,2,2.5,5,10].map(s=>s*mag).find(s=>s>=raw)||mag*10
  const ticks:number[]=[];for(let v=Math.floor(lo/step)*step;v<=hi+step*1e-9;v+=step)ticks.push(Number(v.toFixed(10)))
  if(ticks[ticks.length-1]<hi)ticks.push(ticks[ticks.length-1]+step)
  return ticks
}

export function toCsv(headers:string[],rows:FieldValue[][]){
  const cell=(value:FieldValue)=>{const text=value===null?'':String(value);return /[",\n\r]/.test(text)||/^[=+\-@]/.test(text)?`"${text.replace(/^([=+\-@])/,"'$1").replace(/"/g,'""')}"`:text}
  return [headers,...rows].map(row=>row.map(cell).join(',')).join('\r\n')
}

// ---------------------------------------------------------------------------
// Sheet layout (24-column grid)
// ---------------------------------------------------------------------------
function overlaps(a:SheetObject,b:SheetObject){return a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h}

// Keeps objects inside the grid and pushes anything overlapping the anchored object downwards.
export function resolveLayout(objects:SheetObject[],anchorId?:string){
  const placed:SheetObject[]=[]
  const fixed=objects.map(object=>({...object,w:Math.min(object.w,GRID_COLS),x:Math.max(0,Math.min(object.x,GRID_COLS-Math.min(object.w,GRID_COLS))),y:Math.max(0,object.y)}))
  const order=[...fixed].sort((a,b)=>a.id===anchorId?-1:b.id===anchorId?1:a.y-b.y||a.x-b.x)
  for(const object of order){
    const item={...object}
    while(placed.some(other=>overlaps(item,other)))item.y=Math.max(...placed.filter(other=>overlaps(item,other)).map(other=>other.y+other.h))
    placed.push(item)
  }
  // float everything up as far as it goes, like a dashboard grid
  let moved=true
  while(moved){
    moved=false
    for(const item of [...placed].sort((a,b)=>a.y-b.y)){
      while(item.y>0&&!placed.some(other=>other!==item&&overlaps({...item,y:item.y-1},other))){item.y--;moved=true}
    }
  }
  return objects.map(object=>placed.find(item=>item.id===object.id)!)
}

export function freeSpot(objects:SheetObject[],w:number,h:number){
  for(let y=0;y<200;y++)for(let x=0;x<=GRID_COLS-w;x++){
    const candidate={id:'_',kind:'text',title:'',x,y,w,h,dimensions:[],measures:[],options:{}} as SheetObject
    if(!objects.some(other=>overlaps(candidate,other)))return {x,y}
  }
  return {x:0,y:Math.max(0,...objects.map(object=>object.y+object.h))}
}
