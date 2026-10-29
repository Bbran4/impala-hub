// Reporting batch 4: comments, version history, copying apps, the master item library, usage
// statistics and data quality (calls and pure helpers; the screens are in biCollab.tsx).
import type {SupabaseClient} from '@supabase/supabase-js'

export type Comment={id:string;object_id:string;body:string;resolved:boolean;author:string|null;mine:boolean;created_at:string;edited_at:string|null}
export type Version={id:number;kind:'app'|'sheet';object_id:string;label:string;saved_at:string;saved_by:string|null;deleted:boolean;exists:boolean
  summary:{objects?:number;tables?:number;measures?:number}}
export type LibraryItem={id?:string;kind:'measure'|'dimension';name:string;expression:string;format?:string|null;description:string;updated_at?:string;updated_by?:string|null;used_in?:number}
export type UsageSheet={sheet_id:string;title:string;views:number;people:number;last_opened:string|null}
export type UsageApp={app_id:string;name:string;views:number;people:number;last_opened:string|null;sheets:UsageSheet[];report_emails:number}
export type Usage={days:number;apps:UsageApp[];people:{name:string;views:number;apps:number;last_opened:string}[];by_day:{day:string;views:number;people:number}[]}
export type QualityRun={at:string;status:'running'|'success'|'error';rows:number|null;error:string|null}
export type QualityTable={table_name:string;description:string|null;row_count:number|null;last_loaded_at:string|null;source:string;interval_minutes:number|null
  runs:QualityRun[];empty_fields:string[];mostly_empty:{field:string;empty:number}[];issues:number}

function fail(error:{message:string}|null){if(error)throw new Error(error.message)}
const call=async<T>(client:SupabaseClient,name:string,args:Record<string,unknown>={})=>{const {data,error}=await client.rpc(name,args);fail(error);return data as T}

export const loadComments=(c:SupabaseClient,app:string,sheet:string)=>call<Comment[]>(c,'bi_list_comments',{p_app:app,p_sheet:sheet}).then(list=>list||[])
export const addComment=(c:SupabaseClient,app:string,sheet:string,object:string,body:string)=>call<string>(c,'bi_add_comment',{p_app:app,p_sheet:sheet,p_object:object,p_body:body})
export const updateComment=(c:SupabaseClient,id:string,body:string|null,resolved:boolean|null)=>call<void>(c,'bi_update_comment',{p_id:id,p_body:body,p_resolved:resolved})
export const deleteComment=(c:SupabaseClient,id:string)=>call<void>(c,'bi_delete_comment',{p_id:id})
export const loadVersions=(c:SupabaseClient,app:string)=>call<Version[]>(c,'bi_list_versions',{p_app:app}).then(list=>list||[])
export const restoreVersion=(c:SupabaseClient,id:number)=>call<string>(c,'bi_restore_version',{p_id:id})
export const copyApp=(c:SupabaseClient,app:string,name:string,withAccess:boolean)=>call<string>(c,'bi_copy_app',{p_app:app,p_name:name,p_with_access:withAccess})
export const loadLibrary=(c:SupabaseClient)=>call<LibraryItem[]>(c,'bi_list_library').then(list=>list||[])
export const saveLibraryItem=(c:SupabaseClient,item:LibraryItem)=>call<string>(c,'bi_save_library_item',{p:item})
export const deleteLibraryItem=(c:SupabaseClient,id:string)=>call<void>(c,'bi_delete_library_item',{p_id:id})
export const loadUsage=(c:SupabaseClient,days:number)=>call<Usage>(c,'bi_usage',{p_days:days})
export const loadQuality=(c:SupabaseClient)=>call<QualityTable[]>(c,'bi_data_quality').then(list=>list||[])

// Comments per object, open ones first, for the counts shown on each chart
export function commentCounts(comments:Comment[]){
  const counts=new Map<string,{open:number;total:number}>()
  for(const c of comments){const n=counts.get(c.object_id)||{open:0,total:0};n.total++;if(!c.resolved)n.open++;counts.set(c.object_id,n)}
  return counts
}

// The issues of a loaded table, in words (the database counts them the same way)
export function qualityIssues(t:QualityTable,now=new Date()):string[]{
  const out:string[]=[]
  if(!t.last_loaded_at)out.push('Never loaded')
  if(t.runs[0]?.status==='error')out.push(`Last load failed${t.runs[0].error?`: ${t.runs[0].error}`:''}`)
  if(t.interval_minutes&&t.last_loaded_at&&now.getTime()-new Date(t.last_loaded_at).getTime()>(3*t.interval_minutes+60)*60000)
    out.push(`Not loaded for ${hoursAgo(t.last_loaded_at,now)} (loads every ${t.interval_minutes>=60?`${Math.round(t.interval_minutes/60)} h`:`${t.interval_minutes} min`})`)
  const [last,before]=[t.runs[0]?.rows,t.runs[1]?.rows]
  if(before&&last!=null&&last<0.8*before)out.push(`Rows dropped from ${before.toLocaleString('en-ZA')} to ${last.toLocaleString('en-ZA')}`)
  if(t.empty_fields.length)out.push(`Always empty: ${t.empty_fields.join(', ')}`)
  return out
}
function hoursAgo(iso:string,now:Date){const h=Math.round((now.getTime()-new Date(iso).getTime())/3600000);return h>=48?`${Math.round(h/24)} days`:`${h} h`}

// Sheets nobody opened in the period (candidates to remove when moving off Qlik)
export function unusedSheets(usage:Usage){return usage.apps.flatMap(app=>app.sheets.filter(s=>!s.views).map(s=>({app:app.name,...s})))}
