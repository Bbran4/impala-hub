// Report emails: schedules per app (which sheets, to whom, when). Sent by api/reporting/send-due.
import type {SupabaseClient} from '@supabase/supabase-js'
import type {AccessEntry,AppDetail,Selection} from './biApps'
import {checkFields,hasAggregation,parseExpression,asMeasure,type ExprNode} from './biExpression.ts'

export type Frequency='daily'|'weekdays'|'weekly'|'monthly'
export type ReportSchedule={
  id?:string;name:string;sheet_ids:string[];recipients:AccessEntry[];frequency:Frequency;send_time:string
  weekdays:number[];month_day:number|null;timezone:string;subject:string;message:string;enabled:boolean
  next_run_at?:string|null;last_run_at?:string|null;recipient_count?:number
  // batch 3: what to send (a report, or an alert that is only sent when its condition is met), a filter
  // (bookmark, selections, conditions) and an Excel attachment
  kind:'report'|'alert';bookmark_id:string|null;selections:Selection[];conditions:{text:string;node?:ExprNode}[];attach_excel:boolean
  alert:AlertSpec|null;personal?:boolean;owner_name?:string|null;optouts?:number;opted_out?:boolean
}
export type AlertSpec={label:string;measure:{text:string;node?:ExprNode};dimension:{text:string;node?:ExprNode}|null;dimension_label?:string;op:'>'|'>='|'<'|'<='|'='|'<>';value:number}
export type ReportDelivery={id:string;schedule_id:string;email:string;status:'pending'|'sending'|'sent'|'failed'|'skipped'|'not_needed';error:string|null;is_test:boolean;attempts:number;created_at:string;sent_at:string|null}

export const DAYS=['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
export const TIMEZONES=['Africa/Johannesburg','Africa/Windhoek','Africa/Gaborone','Africa/Harare','Africa/Maputo','Africa/Nairobi','Africa/Lagos','Europe/London','UTC']

export function newSchedule(sheetIds:string[]):ReportSchedule{
  return {name:'',sheet_ids:sheetIds.slice(0,1),recipients:[],frequency:'weekdays',send_time:'07:00',weekdays:[1],month_day:1,timezone:'Africa/Johannesburg',subject:'',message:'',enabled:true,
    kind:'report',bookmark_id:null,selections:[],conditions:[],attach_excel:false,alert:null}
}
export function newAlert():AlertSpec{return {label:'',measure:{text:''},dimension:null,op:'>',value:0}}
export const ALERT_OPS:[AlertSpec['op'],string][]=[['>','is above'],['>=','is at least'],['<','is below'],['<=','is at most'],['=','equals'],['<>','is not']]

// Fills in defaults for schedules saved before batch 3
export function normalizeSchedule(s:Partial<ReportSchedule>&{name:string}):ReportSchedule{
  return {...newSchedule([]),...s,sheet_ids:s.sheet_ids||[],recipients:s.recipients||[],weekdays:s.weekdays||[],selections:s.selections||[],conditions:s.conditions||[],
    kind:s.kind||'report',bookmark_id:s.bookmark_id||null,attach_excel:Boolean(s.attach_excel),alert:s.alert||null} as ReportSchedule
}

// "Weekdays at 07:00", "Mon, Wed at 16:30", "Monthly on day 1 at 06:00"
export function describeSchedule(s:Pick<ReportSchedule,'frequency'|'send_time'|'weekdays'|'month_day'|'timezone'>){
  const when=s.frequency==='daily'?'Every day':s.frequency==='weekdays'?'Weekdays':s.frequency==='weekly'
    ?([...s.weekdays].sort((a,b)=>a-b).map(d=>DAYS[d-1]).join(', ')||'No days chosen')
    :`Monthly on day ${s.month_day||1}${(s.month_day||1)>28?' (or the last day)':''}`
  return `${when} at ${s.send_time}${s.timezone!=='Africa/Johannesburg'?` (${s.timezone})`:''}`
}

type ExprApp=Pick<AppDetail,'model'|'measures'>&{variableValues?:Record<string,string>}
function expressionProblem(text:string,kind:'measure'|'dimension'|'condition',app:ExprApp){
  try{
    const parsed=parseExpression(text,{measures:app.measures,variables:app.variableValues})
    const node=kind==='measure'?asMeasure(parsed):parsed
    const problem=checkFields(node,app.model);if(problem)return problem
    if(kind==='measure'&&!hasAggregation(node))return 'needs an aggregation such as Sum()'
    if(kind!=='measure'&&hasAggregation(node))return 'cannot use aggregations'
    return null
  }catch(error){return (error as Error).message}
}
export function scheduleProblem(s:ReportSchedule,app?:ExprApp,personal=false):string|null{
  if(!s.name.trim())return personal?'Give the subscription a name':'Give the report email a name'
  if(s.kind==='report'&&!s.sheet_ids.length)return 'Choose at least one sheet'
  if(!personal&&!s.recipients.length)return 'Choose who gets it'
  if(s.kind==='alert'){
    if(!s.alert||!s.alert.measure.text.trim())return 'Enter the measure the alert checks, e.g. Sum(qty_on_hand)'
    if(!Number.isFinite(Number(s.alert.value)))return 'Enter the number to compare with'
    if(app){const p=expressionProblem(s.alert.measure.text,'measure',app);if(p)return `Alert measure: ${p}`
      if(s.alert.dimension?.text.trim()){const d=expressionProblem(s.alert.dimension.text,'dimension',app);if(d)return `Alert “for each”: ${d}`}}
  }
  if(app)for(const [i,c] of s.conditions.entries()){if(!c.text.trim())return `Condition ${i+1} is empty`;const p=expressionProblem(c.text,'condition',app);if(p)return `Condition ${i+1}: ${p}`}
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.send_time))return 'Enter a time like 07:00'
  if(s.frequency==='weekly'&&!s.weekdays.length)return 'Choose the days of the week'
  if(s.frequency==='monthly'&&!(Number(s.month_day)>=1&&Number(s.month_day)<=31))return 'Choose a day of the month (1–31)'
  if(s.subject.length>200||s.message.length>2000)return 'The subject or message is too long'
  return null
}

// Subject used when none is given (the sender does the same).
export function defaultSubject(appName:string,scheduleName:string){return `${appName}: ${scheduleName}`}

function fail(error:{message:string}|null){if(error)throw new Error(error.message)}
export async function loadReports(client:SupabaseClient,appId:string){
  const {data,error}=await client.rpc('bi_list_reports',{p_app:appId});fail(error)
  const result=data as {schedules:ReportSchedule[];deliveries:ReportDelivery[]}
  return {...result,schedules:result.schedules.map(normalizeSchedule)}
}
// The schedule as sent to the database: expressions parsed into syntax trees (like charts)
export function schedulePayload(s:ReportSchedule,app:AppDetail){
  const {next_run_at:_n,last_run_at:_l,recipient_count:_c,owner_name:_o,optouts:_x,opted_out:_y,personal:_p,...rest}=s
  const parse=(text:string,measure=false)=>{const node=parseExpression(text,{measures:app.measures,variables:Object.fromEntries((app.variables||[]).map(v=>[v.name,v.value]))});return measure?asMeasure(node):node}
  return {...rest,app_id:app.id,month_day:s.frequency==='monthly'?Number(s.month_day):null,
    sheet_ids:s.kind==='alert'?s.sheet_ids:s.sheet_ids,
    conditions:s.conditions.filter(c=>c.text.trim()).map(c=>({text:c.text,node:parse(c.text)})),
    alert:s.kind==='alert'&&s.alert?{...s.alert,value:Number(s.alert.value),label:s.alert.label.trim()||s.alert.measure.text,
      measure:{text:s.alert.measure.text,node:parse(s.alert.measure.text,true)},
      dimension:s.alert.dimension?.text.trim()?{text:s.alert.dimension.text,node:parse(s.alert.dimension.text)}:null}:null}
}
export async function saveReport(client:SupabaseClient,app:AppDetail,s:ReportSchedule){
  const {data,error}=await client.rpc('bi_save_report',{p:schedulePayload(s,app)});fail(error);return data as string
}
// Viewers: their own subscriptions, the emails they get, opting out
export async function subscribe(client:SupabaseClient,app:AppDetail,s:ReportSchedule){
  const {data,error}=await client.rpc('bi_subscribe',{p:schedulePayload(s,app)});fail(error);return data as string}
export async function unsubscribe(client:SupabaseClient,id:string){const {error}=await client.rpc('bi_unsubscribe',{p_id:id});fail(error)}
export async function loadMyReportEmails(client:SupabaseClient,appId:string){
  const {data,error}=await client.rpc('bi_my_report_emails',{p_app:appId});fail(error);return ((data||[]) as ReportSchedule[]).map(normalizeSchedule)}
export async function setOptout(client:SupabaseClient,id:string,optout:boolean){const {error}=await client.rpc('bi_set_report_optout',{p_id:id,p_optout:optout});fail(error)}
export async function deleteReport(client:SupabaseClient,id:string){const {error}=await client.rpc('bi_delete_report',{p_id:id});fail(error)}
export async function sendReportNow(client:SupabaseClient,id:string,test:boolean){const {data,error}=await client.rpc('bi_send_report_now',{p_id:id,p_test:test});fail(error);return data as number}
