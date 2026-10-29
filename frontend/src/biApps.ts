import type {SupabaseClient} from '@supabase/supabase-js'
import {asColorMeasure,asMeasure,checkFields,type AppVariable,hasAggregation,parseExpression,plainField,type ExprNode,type MasterMeasure} from './biExpression.ts'

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
// drill: further levels of a drill-down dimension (Qlik drill-down group): the chart moves to the
// next level when one value of the current level is selected
export type ObjectItem={expr:string;label?:string;format?:NumberFormat;background?:string;textColor?:string;drill?:string[]}
export type ObjectKind='kpi'|'bar'|'line'|'pie'|'table'|'pivot'|'filter'|'text'
  |'combo'|'scatter'|'gauge'|'bullet'|'funnel'|'waterfall'|'treemap'|'histogram'|'boxplot'|'distribution'|'radar'|'mekko'|'grid'|'wordcloud'
  |'variable'|'slider'|'datepicker'|'button'|'navigation'|'tabs'|'layout'|'trellis'|'image'|'textimage'|'divider'|'video'
  |'pnl'|'variance'|'sankey'|'network'|'orgchart'|'map'|'animator'|'insights'|'writetable'
export type ObjectOptions={
  conditions?:string[];sortBy?:number;sortDesc?:boolean;limit?:number
  horizontal?:boolean;stacked?:boolean;text?:string;totals?:boolean
  columnOrder?:number[]   // tables: display order of the query columns (dimensions first, then measures)
  comboBars?:number;secondaryAxis?:boolean   // combo: how many measures are bars; lines on a second axis
  gaugeMin?:number;gaugeMax?:number;bins?:number
  // controls
  variable?:string;inputStyle?:'input'|'dropdown'|'buttons';choices?:string;min?:number;max?:number;step?:number
  action?:'clear'|'select'|'variable'|'sheet'|'url';actionTarget?:string;actionValue?:string;vertical?:boolean
  // containers: the container lists its objects; each contained object points back at it
  children?:string[];child?:string;container?:string;columns?:number
  // media
  url?:string;fit?:'contain'|'cover';color?:string;thickness?:number;imageSide?:'left'|'right'|'top'
  // batch 3
  rowStyles?:string;tiles?:boolean;interval?:number;loop?:boolean
  writeColumns?:WriteColumn[];writeEditors?:'everyone'|'builders'
  // write tables: the parsed dimensions, saved so the database can check row access on the rows
  keyDims?:ExprNode[]
  // alternate state (Qlik): the object follows its own selections, e.g. to compare two branches
  state?:string
  subtotals?:boolean
}
export const ALTERNATE_STATES=['A','B']
export type WriteColumn={name:string;type:'text'|'number'|'choice';choices?:string}
export type WriteCell={row_key:string;column:string;value:string;updated_at:string;updated_by:string}
export type SheetObject={id:string;kind:ObjectKind;title:string;x:number;y:number;w:number;h:number;dimensions:ObjectItem[];measures:ObjectItem[];options:ObjectOptions}
export type Sheet={id:string;title:string;position:number;objects:SheetObject[];updated_at?:string}
export type AppSummary={id:string;name:string;description:string;updated_at:string;can_edit:boolean;tables:string[];sheets:{id:string;title:string}[];last_loaded_at:string|null}
// Calculated field: a per-row expression over one table's loaded fields, used like any other field
export type CalcField={table:string;name:string;expression:string}
export type AppDetail={id:string;name:string;description:string;measures:MasterMeasure[];variables:AppVariable[];calc_fields?:CalcField[];variableValues?:Record<string,string>
  // selections of the alternate states (and of the main state as "Main"), for set analysis like Sum({A} sales)
  stateSelections?:Record<string,Selection[]>;updated_at:string;can_edit:boolean;model:ModelTable[];sheets:Sheet[];access:AccessEntry[]|null}
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
  combo:{label:'Combo chart',dims:[1,1],measures:[2,6],w:12,h:7,hint:'Bars and lines together, e.g. sales as bars and margin % as a line on a second axis.'},
  scatter:{label:'Scatter plot',dims:[1,1],measures:[2,3],w:12,h:8,hint:'One point per value: the first measure across, the second up, an optional third as bubble size.'},
  gauge:{label:'Gauge',dims:[0,0],measures:[1,2],w:6,h:5,hint:'One value on a scale. A second measure is drawn as the target.'},
  bullet:{label:'Bullet chart',dims:[0,1],measures:[1,3],w:12,h:6,hint:'Value against a target (second measure) and a range (third), per dimension value.'},
  funnel:{label:'Funnel chart',dims:[1,1],measures:[1,1],w:8,h:7,hint:'Stages from largest to smallest, e.g. quotes, orders, invoices.'},
  waterfall:{label:'Waterfall chart',dims:[1,1],measures:[1,1],w:12,h:7,hint:'How each value adds to or takes from a running total.'},
  treemap:{label:'Treemap',dims:[1,2],measures:[1,1],w:12,h:8,hint:'Rectangles sized by value. A second dimension nests inside the first.'},
  histogram:{label:'Histogram',dims:[1,1],measures:[0,0],w:12,h:7,hint:'How many records fall in each range of a number field (no measure needed).'},
  boxplot:{label:'Box plot',dims:[1,2],measures:[1,1],w:12,h:7,hint:'Spread of a measure: with two dimensions, one box per value of the first, over the values of the second.'},
  distribution:{label:'Distribution plot',dims:[1,2],measures:[1,1],w:12,h:7,hint:'Every value as a dot: with two dimensions, one column per value of the first.'},
  radar:{label:'Radar chart',dims:[1,2],measures:[1,4],w:8,h:8,hint:'One axis per value of the first dimension; one shape per measure or per value of the second dimension.'},
  mekko:{label:'Mekko chart',dims:[2,2],measures:[1,1],w:12,h:8,hint:'Column width is the total per first dimension; segments show the share of the second.'},
  grid:{label:'Grid chart',dims:[2,2],measures:[1,1],w:12,h:8,hint:'A heat map: first dimension down, second across, colour by value.'},
  wordcloud:{label:'Word cloud',dims:[1,1],measures:[1,1],w:8,h:6,hint:'Values sized by the measure.'},
  variable:{label:'Variable input',dims:[0,0],measures:[0,0],w:6,h:3,hint:'Lets people change an app variable: a text box, a dropdown or buttons.'},
  slider:{label:'Slider',dims:[0,0],measures:[0,0],w:6,h:3,hint:'Sets a number variable by dragging, e.g. a minimum quantity used in a condition.'},
  datepicker:{label:'Date picker',dims:[1,1],measures:[0,0],w:8,h:3,hint:'Select a date or a date range on a date field, with quick ranges such as This month.'},
  button:{label:'Button',dims:[0,1],measures:[0,0],w:4,h:2,hint:'Clears selections, selects values, sets a variable, goes to a sheet or opens a link.'},
  navigation:{label:'Navigation menu',dims:[0,0],measures:[0,0],w:6,h:5,hint:'Buttons for every sheet in the app.'},
  tabs:{label:'Tab container',dims:[0,0],measures:[0,0],w:12,h:8,hint:'Several objects in one place, one tab each.'},
  layout:{label:'Layout container',dims:[0,0],measures:[0,0],w:12,h:8,hint:'Several objects side by side (or stacked) inside one frame.'},
  trellis:{label:'Trellis container',dims:[1,1],measures:[0,0],w:24,h:10,hint:'Repeats one object for every value of a dimension, e.g. the same chart per branch.'},
  image:{label:'Image',dims:[0,0],measures:[0,0],w:6,h:5,hint:'A picture from a web address (https).'},
  textimage:{label:'Text & image',dims:[0,0],measures:[0,0],w:12,h:5,hint:'A note with a picture next to it.'},
  divider:{label:'Line',dims:[0,0],measures:[0,0],w:24,h:2,hint:'A horizontal or vertical line to separate parts of a sheet.'},
  video:{label:'Video player',dims:[0,0],measures:[0,0],w:12,h:7,hint:'A YouTube or Vimeo video, or a video file (https).'},
  pnl:{label:'P&L pivot',dims:[1,2],measures:[1,4],w:24,h:9,hint:'Rows in your own order with styles (bold, header, line, indent); a second dimension becomes columns with a total.'},
  variance:{label:'Variance waterfall',dims:[1,1],measures:[2,2],w:12,h:7,hint:'From the second measure (e.g. budget or last year) to the first (actual), one step per value.'},
  sankey:{label:'Sankey chart',dims:[2,4],measures:[1,1],w:12,h:8,hint:'Flows from the first dimension to the next, e.g. branch → category → supplier.'},
  network:{label:'Network chart',dims:[2,2],measures:[0,1],w:12,h:9,hint:'Links between the values of two dimensions (from → to); a measure sets the link weight.'},
  orgchart:{label:'Org chart',dims:[2,3],measures:[0,1],w:24,h:9,hint:'A tree from a node and its parent; an optional third dimension is shown under the name.'},
  map:{label:'Map',dims:[1,1],measures:[2,3],w:12,h:9,hint:'Points placed by latitude (first measure) and longitude (second); a third measure sizes the bubbles.'},
  animator:{label:'Animator',dims:[1,1],measures:[0,0],w:8,h:3,hint:'Plays through the values of a dimension (e.g. month by month), selecting each in turn.'},
  insights:{label:'Insights',dims:[1,1],measures:[1,1],w:8,h:6,hint:'Written findings about a measure: total, highest and lowest, share and biggest changes.'},
  writetable:{label:'Write table',dims:[1,6],measures:[0,10],w:24,h:8,hint:'A table with extra columns people can type into, e.g. an order quantity or a comment.'},
}

export const CONTAINER_KINDS:ObjectKind[]=['tabs','layout','trellis']
// Objects that never query data and have no dimensions or measures to fill in.
export const NO_DATA_KINDS:ObjectKind[]=['text','variable','slider','button','navigation','tabs','layout','image','textimage','divider','video']

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------
function fail(error:{message:string}|null){if(error)throw new Error(error.message)}
export async function loadMyAccess(client:SupabaseClient){const {data,error}=await client.rpc('bi_my_access');fail(error);return data as MyAccess}
export async function loadApps(client:SupabaseClient){const {data,error}=await client.rpc('bi_list_apps');fail(error);return (data||[]) as AppSummary[]}
export async function loadApp(client:SupabaseClient,id:string){const {data,error}=await client.rpc('bi_get_app',{p_app:id});fail(error);return normalizeApp(data as AppDetail)}
export async function saveApp(client:SupabaseClient,app:{id?:string;name:string;description:string;model:ModelTable[];measures:MasterMeasure[];variables?:AppVariable[];access?:AccessEntry[];calc_fields?:CalcField[]}){
  const payload={...app,
    calc_fields:app.calc_fields?.filter(c=>app.model.some(t=>t.alias===c.table)).map(c=>({...c,node:parseExpression(c.expression)})),
    model:app.model.map(({alias,table_name,parent_alias,join_type,join_pairs})=>({alias,table_name,parent_alias,join_type,join_pairs}))}
  const {data,error}=await client.rpc('bi_save_app',{p:payload});fail(error);return data as string
}
export async function deleteApp(client:SupabaseClient,id:string){const {error}=await client.rpc('bi_delete_app',{p_app:id});fail(error)}
export async function saveSheet(client:SupabaseClient,appId:string,sheet:{id?:string;title:string;position?:number;objects:SheetObject[]}){
  const {data,error}=await client.rpc('bi_save_sheet',{p:{...sheet,app_id:appId}});fail(error);return data as string
}
export async function deleteSheet(client:SupabaseClient,id:string){const {error}=await client.rpc('bi_delete_sheet',{p_sheet:id});fail(error)}
export async function loadPrincipals(client:SupabaseClient){const {data,error}=await client.rpc('bi_list_principals');fail(error);return data as Principals}
// Report rendering (headless Chrome) runs signed out with a ticket instead of a session: these
// calls then go through the bi_render_* functions, which run as the report's recipient.
let renderTicket:string|null=null
export function setRenderTicket(ticket:string|null){renderTicket=ticket}
// Number of data requests in flight, so the report renderer knows when a sheet has finished loading.
let pending=0
export const pendingRequests=()=>pending
async function track<T>(work:()=>Promise<T>){pending++;try{return await work()}finally{pending--}}

export async function loadWriteCells(client:SupabaseClient,appId:string,objectId:string){return track(async()=>{
  const {data,error}=renderTicket?await client.rpc('bi_render_write_get',{p_ticket:renderTicket,p_object:objectId}):await client.rpc('bi_write_get',{p_app:appId,p_object:objectId})
  fail(error);return (data||[]) as WriteCell[]})}
export async function saveWriteCell(client:SupabaseClient,appId:string,objectId:string,rowKey:string,column:string,value:string){
  const {error}=await client.rpc('bi_write_set',{p_app:appId,p_object:objectId,p_row_key:rowKey,p_column:column,p_value:value});fail(error)}
export async function runQuery(client:SupabaseClient,appId:string,spec:unknown){return track(async()=>{
  const {data,error}=renderTicket?await client.rpc('bi_render_query',{p_ticket:renderTicket,p_spec:spec}):await client.rpc('bi_query',{p_app:appId,p_spec:spec})
  fail(error);return data as QueryResult})}

// Write tables keep their parsed dimensions with the sheet, so row access can be checked per row.
export function withWriteKeys(objects:SheetObject[],app:Pick<AppDetail,'model'|'measures'|'variables'>):SheetObject[]{
  const variableValues=Object.fromEntries((app.variables||[]).map(v=>[v.name,v.value]))
  return objects.map(object=>{
    if(object.kind!=='writetable')return object
    const {keyDims:_old,...options}=object.options
    const compiled=compileObject(object,{...app,variableValues})
    return {...object,options:compiled.errors.length?options:{...options,keyDims:compiled.dimensions.map(d=>d.node)}}
  })
}

// Row access (like Qlik section access)
export type RowRule={type:'role'|'user';principal:string;field:string;all:boolean;values:string[]}
export type RowAccess={enabled:boolean;rules:RowRule[]}
export type MyRowAccess=null|{'#deny'?:true}&Record<string,string[]|null|true>
export async function loadRowAccess(client:SupabaseClient,appId:string){const {data,error}=await client.rpc('bi_get_row_access',{p_app:appId});fail(error);return data as RowAccess}
export async function saveRowAccess(client:SupabaseClient,appId:string,access:RowAccess){const {error}=await client.rpc('bi_save_row_access',{p_app:appId,p:access});fail(error)}
export async function loadMyRowAccess(client:SupabaseClient,appId:string){const {data,error}=await client.rpc('bi_my_row_access',{p_app:appId});fail(error);return data as MyRowAccess}
export function rowRuleProblem(rule:RowRule,model:ModelTable[]):string|null{
  if(!rule.principal)return 'Choose who the rule is for'
  const [alias,column]=rule.field.split('.')
  if(!model.some(t=>t.alias===alias&&t.columns.some(c=>c.name===column)))return 'Choose a field'
  if(!rule.all&&!rule.values.some(v=>v.trim()))return 'Choose at least one value, or all values'
  return null
}
// "branch: Centurion, Pretoria · region: all"
export function describeRowAccess(access:MyRowAccess){
  if(!access)return null
  if(access['#deny'])return 'You have not been given any rows in this app yet. Ask a report builder.'
  return Object.entries(access).map(([field,values])=>`${field.split('.')[1]||field}: ${Array.isArray(values)?values.join(', '):'all'}`).join(' · ')
}

export function normalizeApp(app:AppDetail):AppDetail{
  return {...app,measures:app.measures||[],variables:app.variables||[],calc_fields:app.calc_fields||[],model:(app.model||[]).map(table=>({...table,join_pairs:table.join_pairs||[],columns:table.columns||[]})),
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

// Table column order as query column indexes (dimensions first, then measures); invalid or
// missing entries fall back to the natural order.
export function columnOrder(object:Pick<SheetObject,'dimensions'|'measures'|'options'>){
  const total=object.dimensions.length+object.measures.length
  const saved=(object.options.columnOrder||[]).filter((i,k,all)=>Number.isInteger(i)&&i>=0&&i<total&&all.indexOf(i)===k)
  return [...saved,...Array.from({length:total},(_,i)=>i).filter(i=>!saved.includes(i))]
}

// Keep sorting and column order pointing at the same columns when dimensions or measures move.
export function moveColumn(object:SheetObject,kind:'dimension'|'measure',from:number,to:number):Partial<SheetObject>{
  const dims=object.dimensions.length
  const offset=kind==='dimension'?0:dims
  const list=kind==='dimension'?object.dimensions:object.measures
  const order=list.map((_,i)=>i);const [moved]=order.splice(from,1);order.splice(to,0,moved)
  const remap=(column:number)=>column>=offset&&column<offset+list.length?offset+order.indexOf(column-offset):column
  const next=[...list];const [item]=next.splice(from,1);next.splice(to,0,item)
  const options={...object.options}
  if(options.sortBy!=null)options.sortBy=remap(options.sortBy)
  if(options.columnOrder)options.columnOrder=columnOrder(object).map(remap)
  return kind==='dimension'?{dimensions:next,options}:{measures:next,options}
}

// After adding (at the end) or removing a dimension/measure, keep sort and column order on the same columns.
export function fitOptions(object:SheetObject,dims:number,measures:number,removed?:{kind:'dimension'|'measure';index:number}){
  const options={...object.options}
  const oldDims=object.dimensions.length
  const map=(column:number)=>{
    let kind:'dimension'|'measure'=column<oldDims?'dimension':'measure'
    let i=kind==='dimension'?column:column-oldDims
    if(removed&&removed.kind===kind){if(i===removed.index)return -1;if(i>removed.index)i--}
    if(kind==='dimension')return i<dims?i:-1
    kind='measure';return i<measures?dims+i:-1
  }
  if(options.sortBy!=null){const s=map(options.sortBy);options.sortBy=s<0?undefined:s}
  if(options.columnOrder)options.columnOrder=options.columnOrder.map(map).filter(i=>i>=0)
  return options
}

// ---------------------------------------------------------------------------
// Data model helpers
// ---------------------------------------------------------------------------

// Tables in link order: the first table, then the tables linked to it breadth-first.
// (Links are two-way; the first table only decides what Count(*) counts.)
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
  else if(roots.length!==1)problems.push('Link every table to another table.')
  for(const table of model){
    const parent=model.find(other=>other.alias===table.parent_alias)
    if(table.parent_alias&&!parent)problems.push(`${table.alias} links to a table that is not in the app.`)
    else if(parent&&!table.join_pairs.length)problems.push(`Choose the fields that link ${table.alias} and ${table.parent_alias}.`)
    else if(parent)for(const [mine,theirs] of table.join_pairs){
      if(!table.columns.some(column=>column.name===mine))problems.push(`${table.alias} has no field ${mine} to link on.`)
      if(!parent.columns.some(column=>column.name===theirs))problems.push(`${parent.alias} has no field ${theirs} to link on.`)
    }
  }
  if(roots.length===1&&orderedModel(model).length!==model.length)problems.push('Every table must be linked to the others.')
  return problems
}

// The links between tables form a tree stored as parent links. These keep the same two-way
// links while changing which table is first (reroot) or what a table is linked to (relink).
export function rerootModel(model:ModelTable[],alias:string):ModelTable[]{
  const byAlias=new Map(model.map(table=>[table.alias,{...table,join_pairs:[...table.join_pairs]}]))
  if(!byAlias.has(alias))return model
  const path:string[]=[];let cursor:string|null=alias;let guard=0
  while(cursor&&guard++<50){path.push(cursor);cursor=byAlias.get(cursor)?.parent_alias??null}
  for(let i=path.length-1;i>0;i--){const parent=byAlias.get(path[i])!,child=byAlias.get(path[i-1])!
    parent.parent_alias=child.alias;parent.join_pairs=child.join_pairs.map(([mine,theirs])=>[theirs,mine] as [string,string]);parent.join_type=child.join_type}
  const root=byAlias.get(alias)!;root.parent_alias=null;root.join_pairs=[]
  return [root,...model.filter(table=>table.alias!==alias).map(table=>byAlias.get(table.alias)!)]
}

// Link `alias` to `target` instead of the table it is linked to on the way to `target`;
// the first table stays first.
export function relinkModel(model:ModelTable[],alias:string,target:string,pairs:[string,string][]){
  const first=orderedModel(model)[0]?.alias
  if(alias===target||!first)return model
  const linked=rerootModel(model,target).map(table=>table.alias===alias?{...table,parent_alias:target,join_pairs:pairs}:table)
  return rerootModel(linked,first)
}

// Remove a table; the tables linked through it are linked to its neighbour (fields to choose again).
export function removeFromModel(model:ModelTable[],alias:string){
  const table=model.find(item=>item.alias===alias);if(!table)return model
  let working=model
  if(!table.parent_alias){
    const child=model.find(item=>item.parent_alias===alias)
    if(!child)return model.filter(item=>item.alias!==alias)
    working=rerootModel(model,child.alias)
  }
  const removed=working.find(item=>item.alias===alias)!
  const neighbour=working.find(item=>item.alias===removed.parent_alias)
  return working.filter(item=>item.alias!==alias).map(item=>item.parent_alias===alias
    ?{...item,parent_alias:removed.parent_alias,join_pairs:neighbour?suggestLinks(item.columns,neighbour.columns).filter(link=>link.likelyKey).map(link=>link.pair):[]}:item)
}

// Problems with a calculated field (null when fine). Its expression may only use its own table's
// loaded fields and no aggregations.
export function calcFieldProblem(field:CalcField,all:CalcField[],model:ModelTable[]):string|null{
  const table=model.find(t=>t.alias===field.table)
  if(!table)return 'Choose a table'
  if(!/^[a-z][a-z0-9_]{0,62}$/.test(field.name))return 'Name: start with a letter; use a–z, 0–9 and _'
  if(table.columns.some(c=>c.name===field.name&&c.type!=='calculated'))return `${field.table} already has a field named ${field.name}`
  if(all.filter(c=>c.table===field.table&&c.name===field.name).length>1)return 'Two calculated fields have this name'
  if(!field.expression.trim())return 'Enter an expression'
  try{
    const node=parseExpression(field.expression)
    const problem=checkFields(node,[{alias:table.alias,columns:table.columns.filter(c=>c.type!=='calculated')}])
    if(problem)return `${problem} (calculated fields use their own table's fields)`
    if(hasAggregation(node))return 'Calculated fields work per row; use aggregations such as Sum() in measures'
  }catch(error){return (error as Error).message}
  return null
}
// The model with valid calculated fields added to their tables' columns (for pickers and checks)
export function withCalcFields(model:ModelTable[],calc:CalcField[]):ModelTable[]{
  return model.map(table=>({...table,columns:[...table.columns.filter(c=>c.type!=='calculated'),
    ...calc.filter(c=>c.table===table.alias&&!calcFieldProblem(c,calc,model)).map(c=>({name:c.name,type:'calculated'}))]}))
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
export type DrillInfo={level:number;levels:{label:string;key:string;node:ExprNode}[]}
export type CompiledObject={
  dimensions:{node:ExprNode;label:string;selectKey:string;format?:NumberFormat;drill?:DrillInfo}[]
  measures:{node:ExprNode;label:string;format?:NumberFormat}[]
  conditions:ExprNode[]
  // table and pivot cell colours: one extra query column each, after the measures
  styles:{column:number;kind:'background'|'color';node:ExprNode}[]
  errors:string[]
  // other states' selections, sent with every query so sets like {A} work
  states?:Record<string,{expr:ExprNode;values:FieldValue[]}[]>
}

export function compileObject(object:SheetObject,app:Pick<AppDetail,'model'|'measures'>&{variableValues?:Record<string,string>;stateSelections?:Record<string,Selection[]>},extraConditions:ExprNode[]=[],selections:Selection[]=[]):CompiledObject{
  const errors:string[]=[]
  const info=KIND_INFO[object.kind]
  const parse=(text:string,where:string)=>{
    try{
      const node=parseExpression(text,{measures:app.measures,variables:app.variableValues})
      const problem=checkFields(node,app.model)
      if(problem){errors.push(`${where}: ${problem}`);return null}
      return node
    }catch(error){errors.push(`${where}: ${(error as Error).message}`);return null}
  }
  const dimensions:CompiledObject['dimensions']=[]
  object.dimensions.forEach((item,i)=>{
    const levelTexts=[item.expr,...(item.drill||[]).filter(text=>text.trim())]
    const levels:DrillInfo['levels']=[]
    for(const [k,text] of levelTexts.entries()){
      const node=parse(text,k?`Dimension ${i+1}, drill level ${k+1}`:`Dimension ${i+1}`);if(!node)return
      if(hasAggregation(node)){errors.push(`Dimension ${i+1}: dimensions cannot use aggregations such as Sum() or Count(); put those in a measure`);return}
      levels.push({node,label:k===0&&item.label?item.label:(node.t==='field'?humanize(node.name):text),key:selectionKey(app.model,node)||'expr:'+JSON.stringify(node)})
    }
    // drill down: move on while exactly one value of the level is selected
    let level=0
    while(level<levels.length-1&&selections.find(sel=>sel.key===levels[level].key)?.values.length===1)level++
    const current=levels[level]
    dimensions.push({node:current.node,label:current.label,selectKey:current.key,format:item.format,drill:levels.length>1?{level,levels}:undefined})
  })
  const measures:CompiledObject['measures']=[]
  object.measures.forEach((item,i)=>{
    const parsed=parse(item.expr,`Measure ${i+1}`);if(!parsed)return
    const node=asMeasure(parsed)
    if(!hasAggregation(node)){errors.push(`Measure ${i+1}: use a field or an aggregation such as Sum(…)`);return}
    const master=app.measures.find(measure=>`[${measure.name}]`.toLowerCase()===item.expr.trim().toLowerCase())
    measures.push({node,label:item.label||master?.name||item.expr,format:item.format||(master?.format as NumberFormat|undefined)})
  })
  const conditions:ExprNode[]=[...extraConditions]
  ;(object.options.conditions||[]).filter(text=>text.trim()).forEach((text,i)=>{
    const node=parse(text,`Condition ${i+1}`);if(!node)return
    if(hasAggregation(node))errors.push(`Condition ${i+1}: conditions filter rows and cannot aggregate`)
    else conditions.push(node)
  })
  const styles:CompiledObject['styles']=[]
  if(object.kind==='table'||object.kind==='pivot'){
    const items=[...object.dimensions.map((item,i)=>({item,column:i,where:`Dimension ${i+1}`})),...object.measures.map((item,i)=>({item,column:object.dimensions.length+i,where:`Measure ${i+1}`}))]
    for(const {item,column,where} of items)for(const [kind,text] of [['background',item.background],['color',item.textColor]] as const){
      if(!text?.trim())continue
      const parsed=parse(text,`${where} ${kind==='background'?'background':'text'} colour`);if(!parsed)continue
      styles.push({column,kind,node:asColorMeasure(parsed)})
    }
  }
  if(!NO_DATA_KINDS.includes(object.kind)){
    if(object.dimensions.length<info.dims[0]||object.dimensions.length>info.dims[1])errors.push(info.dims[0]===info.dims[1]?`${info.label} needs ${info.dims[0]} dimension${info.dims[0]===1?'':'s'}.`:`${info.label} needs ${info.dims[0]} to ${info.dims[1]} dimensions.`)
    if(object.measures.length<info.measures[0]||object.measures.length>info.measures[1])errors.push(info.measures[0]===info.measures[1]?`${info.label} needs ${info.measures[0]} measure${info.measures[0]===1?'':'s'}.`:`${info.label} needs ${info.measures[0]} to ${info.measures[1]} measures.`)
    if(object.kind==='table'&&!object.dimensions.length&&!object.measures.length)errors.push('Add a dimension or a measure.')
    if((object.kind==='bar'||object.kind==='line'||object.kind==='radar')&&object.dimensions.length===2&&object.measures.length>1)errors.push('With two dimensions, use one measure.')
  }
  // send other states' selections only when a measure's set refers to a state, e.g. Sum({A} sales)
  const usesState=(node:ExprNode):boolean=>node.t==='fn'?Boolean(node.set&&node.set.base!=='$'&&node.set.base!=='1')||node.args.some(usesState)
    :node.t==='bin'?usesState(node.l)||usesState(node.r):node.t==='neg'||node.t==='not'?usesState(node.e):false
  const states=!measures.some(m=>usesState(m.node))&&!styles.some(st=>usesState(st.node))?{}:Object.fromEntries(Object.entries(app.stateSelections||{}).map(([name,list])=>[name,list.filter(sel=>sel.values.length).map(sel=>({expr:sel.node,values:sel.values}))]))
  return {dimensions,measures,conditions,styles,errors,states:Object.keys(states).length?states:undefined}
}

export function buildSpec(compiled:CompiledObject,selections:Selection[],options:{
  ignoreKey?:string|null;dimensions?:number[];measures?:number[];sort?:{index:number;desc:boolean}[];limit?:number;offset?:number;styles?:boolean
}={}){
  const dims=(options.dimensions??compiled.dimensions.map((_,i)=>i)).map(i=>compiled.dimensions[i])
  const meas=(options.measures??compiled.measures.map((_,i)=>i)).map(i=>compiled.measures[i])
  return {
    dimensions:dims.map(item=>({expr:item.node})),
    measures:[...meas.map(item=>({expr:item.node})),...(options.styles?compiled.styles.map(style=>({expr:style.node})):[])],
    selections:selections.filter(item=>item.key!==options.ignoreKey&&item.values.length).map(item=>({expr:item.node,values:item.values})),
    conditions:compiled.conditions,
    ...(compiled.states?{states:compiled.states}:{}),
    sort:options.sort||[],
    limit:options.limit??1000,
    offset:options.offset??0,
  }
}

// Default sort: charts with a measure sort by the first measure (largest first), except line
// charts, which follow the dimension (usually time).
export function defaultSort(object:SheetObject,compiled:CompiledObject){
  if(object.options.sortBy!=null&&object.options.sortBy<compiled.dimensions.length+compiled.measures.length)return [{index:object.options.sortBy,desc:Boolean(object.options.sortDesc)}]
  if(['line','pivot','filter','waterfall','histogram','grid','pnl','variance','animator','insights'].includes(object.kind)||!compiled.measures.length)return compiled.dimensions.map((_,index)=>({index,desc:false}))
  return [{index:compiled.dimensions.length,desc:true}]
}

// Colours from expressions are applied only when they look like a colour: #rgb / #rrggbb(aa),
// rgb()/rgba() with numbers, or a plain colour name.
export function safeColor(value:FieldValue):string|null{
  if(typeof value!=='string')return null
  const text=value.trim().toLowerCase()
  if(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(text))return text
  if(/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/.test(text))return text
  if(/^[a-z]{3,20}$/.test(text))return text
  return null
}
// Readable text on a coloured background (dark on light colours, white on dark ones).
export function contrastText(color:string){
  let r=128,g=128,b=128
  const hex=/^#([0-9a-f]{3}|[0-9a-f]{6})/.exec(color)
  const rgb=/^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color.replace(/\s+/g,''))
  if(hex){const h=hex[1].length===3?hex[1].split('').map(c=>c+c).join(''):hex[1];r=parseInt(h.slice(0,2),16);g=parseInt(h.slice(2,4),16);b=parseInt(h.slice(4,6),16)}
  else if(rgb){r=+rgb[1];g=+rgb[2];b=+rgb[3]}
  else if(['black','navy','darkblue','darkgreen','darkred','maroon','purple','indigo','teal','green','blue','red','brown','darkslategray','dimgray','gray','grey','crimson','firebrick','darkviolet','midnightblue'].includes(color))return '#ffffff'
  else return '#16324a'
  return (0.299*r+0.587*g+0.114*b)>150?'#16324a':'#ffffff'
}
// Style for one table cell, from the colour columns at the end of a result row.
export function cellStyle(compiled:CompiledObject,row:FieldValue[],column:number,styleStart:number){
  const style:{background?:string;color?:string}={}
  compiled.styles.forEach((item,k)=>{if(item.column!==column)return
    const color=safeColor(row[styleStart+k]);if(!color)return
    if(item.kind==='background')style.background=color;else style.color=color})
  if(style.background&&!style.color)style.color=contrastText(style.background)
  return style
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
// Objects shown inside a container are not placed on the sheet grid themselves.
export function isContained(object:SheetObject,objects:SheetObject[]){
  const owner=object.options.container&&objects.find(item=>item.id===object.options.container)
  return Boolean(owner&&((owner.options.children||[]).includes(object.id)||owner.options.child===object.id))
}
// Put `child` into `container` (or take it out with container=null), keeping both sides in step.
export function setContainer(objects:SheetObject[],childId:string,containerId:string|null){
  return objects.map(item=>{
    if(item.id===childId)return {...item,options:{...item.options,container:containerId||undefined}}
    const children=(item.options.children||[]).filter(id=>id!==childId)
    const child=item.options.child===childId?undefined:item.options.child
    if(item.id===containerId){
      return item.kind==='trellis'?{...item,options:{...item.options,child:childId}}:{...item,options:{...item.options,children:[...children,childId]}}
    }
    return children.length!==(item.options.children||[]).length||child!==item.options.child?{...item,options:{...item.options,children,child}}:item
  })
}
// Removing an object also removes it from its container, and frees the objects inside it.
export function removeObject(objects:SheetObject[],id:string){
  const removed=objects.find(item=>item.id===id)
  const inside=new Set([...(removed?.options.children||[]),...(removed?.options.child?[removed.options.child]:[])])
  return setContainer(objects,id,null).filter(item=>item.id!==id).map(item=>inside.has(item.id)?{...item,options:{...item.options,container:undefined}}:item)
}

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
