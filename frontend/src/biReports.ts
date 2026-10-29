// Report emails: schedules per app (which sheets, to whom, when). Sent by api/reporting/send-due.
import type {SupabaseClient} from '@supabase/supabase-js'
import type {AccessEntry} from './biApps'

export type Frequency='daily'|'weekdays'|'weekly'|'monthly'
export type ReportSchedule={
  id?:string;name:string;sheet_ids:string[];recipients:AccessEntry[];frequency:Frequency;send_time:string
  weekdays:number[];month_day:number|null;timezone:string;subject:string;message:string;enabled:boolean
  next_run_at?:string|null;last_run_at?:string|null;recipient_count?:number
}
export type ReportDelivery={id:string;schedule_id:string;email:string;status:'pending'|'sending'|'sent'|'failed'|'skipped';error:string|null;is_test:boolean;attempts:number;created_at:string;sent_at:string|null}

export const DAYS=['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
export const TIMEZONES=['Africa/Johannesburg','Africa/Windhoek','Africa/Gaborone','Africa/Harare','Africa/Maputo','Africa/Nairobi','Africa/Lagos','Europe/London','UTC']

export function newSchedule(sheetIds:string[]):ReportSchedule{
  return {name:'',sheet_ids:sheetIds.slice(0,1),recipients:[],frequency:'weekdays',send_time:'07:00',weekdays:[1],month_day:1,timezone:'Africa/Johannesburg',subject:'',message:'',enabled:true}
}

// "Weekdays at 07:00", "Mon, Wed at 16:30", "Monthly on day 1 at 06:00"
export function describeSchedule(s:Pick<ReportSchedule,'frequency'|'send_time'|'weekdays'|'month_day'|'timezone'>){
  const when=s.frequency==='daily'?'Every day':s.frequency==='weekdays'?'Weekdays':s.frequency==='weekly'
    ?([...s.weekdays].sort((a,b)=>a-b).map(d=>DAYS[d-1]).join(', ')||'No days chosen')
    :`Monthly on day ${s.month_day||1}${(s.month_day||1)>28?' (or the last day)':''}`
  return `${when} at ${s.send_time}${s.timezone!=='Africa/Johannesburg'?` (${s.timezone})`:''}`
}

export function scheduleProblem(s:ReportSchedule):string|null{
  if(!s.name.trim())return 'Give the report email a name'
  if(!s.sheet_ids.length)return 'Choose at least one sheet'
  if(!s.recipients.length)return 'Choose who gets it'
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
  return data as {schedules:ReportSchedule[];deliveries:ReportDelivery[]}
}
export async function saveReport(client:SupabaseClient,appId:string,s:ReportSchedule){
  const {next_run_at:_n,last_run_at:_l,recipient_count:_c,...rest}=s
  const {data,error}=await client.rpc('bi_save_report',{p:{...rest,app_id:appId,month_day:s.frequency==='monthly'?Number(s.month_day):null}});fail(error);return data as string
}
export async function deleteReport(client:SupabaseClient,id:string){const {error}=await client.rpc('bi_delete_report',{p_id:id});fail(error)}
export async function sendReportNow(client:SupabaseClient,id:string,test:boolean){const {data,error}=await client.rpc('bi_send_report_now',{p_id:id,p_test:test});fail(error);return data as number}
