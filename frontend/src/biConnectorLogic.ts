// Excel/CSV uploads for Reporting data connectors: reading the file, naming and typing columns,
// and turning rows into values the database accepts (bi_upload_* in migration 0072).
import type {SupabaseClient} from '@supabase/supabase-js'
import {parseDelimitedText} from './stockImportFiles.ts'

export type UploadType='text'|'bigint'|'numeric'|'date'|'timestamp'|'boolean'
export type Cell=string|number|boolean|Date|null
export type UploadSheet={name:string;headers:string[];rows:Cell[][]}
export type UploadColumn={source:string;index:number;name:string;type:UploadType;include:boolean}

export const UPLOAD_TYPES:{value:UploadType;label:string}[]=[
  {value:'text',label:'Text'},{value:'bigint',label:'Whole number'},{value:'numeric',label:'Number'},
  {value:'date',label:'Date'},{value:'timestamp',label:'Date and time'},{value:'boolean',label:'Yes/no'},
]

// Database-safe names: lower case letters, digits and _, starting with a letter, unique.
export function safeName(text:string,fallback='col'){
  let s=String(text||'').normalize('NFKD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'')
  if(!s)s=fallback
  if(!/^[a-z]/.test(s))s=`${fallback}_${s}`
  return s.slice(0,63)
}
export function uniqueNames(names:string[]){
  const seen=new Set<string>()
  return names.map((name,i)=>{let base=safeName(name,`col_${i+1}`);if(base==='_bi_loaded_at'||base==='bi_loaded_at')base+='_src'
    let candidate=base,n=2;while(seen.has(candidate)){const suffix=`_${n++}`;candidate=base.slice(0,63-suffix.length)+suffix}
    seen.add(candidate);return candidate})
}

const INT=/^-?\d{1,15}$/,NUM=/^-?(\d{1,3}([  ]\d{3})+|\d+)([.,]\d+)?$/,ISO_DATE=/^\d{4}-\d{2}-\d{2}$/,DMY=/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/,YMD=/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/
const ISO_TS=/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/,BOOL=/^(true|false|yes|no|ja|nee)$/i
const isBlank=(v:Cell)=>v===null||v===undefined||(typeof v==='string'&&v.trim()==='')
const midnight=(d:Date)=>d.getUTCHours()===0&&d.getUTCMinutes()===0&&d.getUTCSeconds()===0&&d.getUTCMilliseconds()===0

export function inferType(values:Cell[]):UploadType{
  const vals=values.filter(v=>!isBlank(v))
  if(!vals.length)return 'text'
  const all=(test:(v:Cell)=>boolean)=>vals.every(test)
  const str=(v:Cell)=>typeof v==='string'?v.trim():''
  if(all(v=>typeof v==='boolean'||BOOL.test(str(v))))return 'boolean'
  if(all(v=>(typeof v==='number'&&Number.isInteger(v)&&Math.abs(v)<1e15)||INT.test(str(v))))return 'bigint'
  if(all(v=>(typeof v==='number'&&Number.isFinite(v))||NUM.test(str(v))))return 'numeric'
  if(all(v=>(v instanceof Date&&midnight(v))||ISO_DATE.test(str(v))||DMY.test(str(v))||YMD.test(str(v))))return 'date'
  if(all(v=>v instanceof Date||ISO_TS.test(str(v))||ISO_DATE.test(str(v))))return 'timestamp'
  return 'text'
}

// A cell as the database expects it for the column type; throws with a readable message when it does not fit.
export function convertCell(value:Cell,type:UploadType):string|number|boolean|null{
  if(isBlank(value))return null
  const s=typeof value==='string'?value.trim():''
  switch(type){
    case 'text':return value instanceof Date?(midnight(value)?value.toISOString().slice(0,10):value.toISOString()):String(value).trim()
    case 'boolean':if(typeof value==='boolean')return value;if(BOOL.test(s))return /^(true|yes|ja)$/i.test(s);break
    case 'bigint':if(typeof value==='number'&&Number.isInteger(value))return value;if(INT.test(s))return Number(s);break
    case 'numeric':if(typeof value==='number'&&Number.isFinite(value))return value;if(NUM.test(s))return Number(s.replace(/[  ]/g,'').replace(',','.'));break
    case 'date':{
      if(value instanceof Date)return value.toISOString().slice(0,10)
      if(ISO_DATE.test(s))return s
      const m=DMY.exec(s);if(m)return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`
      const y=YMD.exec(s);if(y)return `${y[1]}-${y[2].padStart(2,'0')}-${y[3].padStart(2,'0')}`
      break}
    case 'timestamp':if(value instanceof Date)return value.toISOString().replace('T',' ').replace('Z','');if(ISO_TS.test(s)||ISO_DATE.test(s))return s;break
  }
  throw new Error(`"${String(value)}" is not a ${UPLOAD_TYPES.find(t=>t.value===type)?.label.toLowerCase()}`)
}

export function guessColumns(sheet:UploadSheet):UploadColumn[]{
  const names=uniqueNames(sheet.headers)
  return sheet.headers.map((header,index)=>({source:header,index,name:names[index],type:inferType(sheet.rows.slice(0,5000).map(row=>row[index]??null)),include:true}))
}

// Rows as objects for bi_upload_rows; collects the first problems instead of failing on the first one.
export function buildRows(sheet:UploadSheet,columns:UploadColumn[]){
  const used=columns.filter(c=>c.include)
  const problems:string[]=[]
  const rows=sheet.rows.map((row,r)=>{const out:Record<string,unknown>={}
    for(const c of used){try{out[c.name]=convertCell(row[c.index]??null,c.type)}catch(error){if(problems.length<5)problems.push(`Row ${r+2}, ${c.source}: ${(error as Error).message}`);out[c.name]=null}}
    return out})
  return {rows,problems}
}

export function columnProblems(columns:UploadColumn[]){
  const used=columns.filter(c=>c.include)
  if(!used.length)return 'Include at least one column'
  for(const c of used)if(!/^[a-z][a-z0-9_]{0,62}$/.test(c.name))return `Column name "${c.name}" must start with a letter and use only lower case letters, digits and _`
  const names=used.map(c=>c.name);const dup=names.find((n,i)=>names.indexOf(n)!==i);if(dup)return `Column "${dup}" appears twice`
  return null
}

// Read a CSV/TSV/TXT or XLSX file into sheets of rows (first non-empty row = headers).
export async function readUploadFile(file:File):Promise<UploadSheet[]>{
  const extension=file.name.split('.').pop()?.toLowerCase()||''
  const bytes=new Uint8Array(await file.arrayBuffer())
  if(bytes.length>50*1024*1024)throw new Error('Files can be at most 50 MB')
  if(['csv','tsv','txt'].includes(extension)){
    let text:string
    try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{text=new TextDecoder('windows-1252').decode(bytes)}
    const rows=parseDelimitedText(text)
    return [toSheet('CSV',rows)]
  }
  if(extension!=='xlsx'&&extension!=='xlsm')throw new Error('Choose a CSV or Excel (.xlsx) file. Older .xls files are not supported; save them as .xlsx first.')
  const module=await import('exceljs');const excel=(module as {default?:unknown}).default||module
  const workbook=new (excel as {Workbook:new()=>{xlsx:{load:(b:Uint8Array)=>Promise<unknown>};eachSheet:(fn:(sheet:any)=>void)=>void}}).Workbook()// eslint-disable-line @typescript-eslint/no-explicit-any
  await workbook.xlsx.load(bytes)
  const sheets:UploadSheet[]=[]
  workbook.eachSheet((sheet:any)=>{// eslint-disable-line @typescript-eslint/no-explicit-any
    if(sheet.state&&sheet.state!=='visible')return
    const rows:Cell[][]=[]
    sheet.eachRow({includeEmpty:false},(row:any)=>{// eslint-disable-line @typescript-eslint/no-explicit-any
      const values:Cell[]=[]
      for(let c=1;c<=Math.min(row.cellCount,300);c++){let v=row.getCell(c).value
        if(v&&typeof v==='object'&&!(v instanceof Date)){v='result' in v?v.result:'text' in v?v.text:'richText' in v?v.richText.map((p:{text:string})=>p.text).join(''):'hyperlink' in v?v.text??v.hyperlink:null}
        values.push(v===undefined?null:v as Cell)}
      rows.push(values)})
    if(rows.length)sheets.push(toSheet(sheet.name,rows))
  })
  if(!sheets.length)throw new Error('The workbook has no visible sheets with data')
  return sheets
}
function toSheet(name:string,raw:Cell[][]):UploadSheet{
  const rows=raw.filter(r=>r.some(v=>!isBlank(v)))
  const header=rows[0]||[]
  const width=Math.max(header.length,...rows.slice(1,200).map(r=>r.length))
  const headers=Array.from({length:width},(_,i)=>{const h=header[i];return isBlank(h??null)?`Column ${i+1}`:h instanceof Date?h.toISOString().slice(0,10):String(h).trim()})
  return {name,headers,rows:rows.slice(1).map(r=>Array.from({length:width},(_,i)=>r[i]??null))}
}

// Upload in chunks; reports progress (rows sent).
export async function uploadTable(client:SupabaseClient,name:string,description:string,fileName:string,columns:UploadColumn[],rows:Record<string,unknown>[],onProgress:(sent:number)=>void){
  const used=columns.filter(c=>c.include)
  const fail=(error:{message:string}|null)=>{if(error)throw new Error(error.message)}
  fail((await client.rpc('bi_upload_begin',{p_name:name,p_columns:used.map(c=>({name:c.name,type:c.type}))})).error)
  for(let i=0;i<rows.length;i+=2000){
    fail((await client.rpc('bi_upload_rows',{p_name:name,p_rows:rows.slice(i,i+2000)})).error)
    onProgress(Math.min(rows.length,i+2000))
  }
  const {data,error}=await client.rpc('bi_upload_finish',{p_name:name,p_description:description,p_file:fileName});fail(error)
  return Number(data)
}

// ---------------------------------------------------------------------------
// Web and folder connectors
// ---------------------------------------------------------------------------
export type ConnectorKind='upload'|'web'|'folder'|'sharepoint'|'gsheet'
export type AgentKind=Exclude<ConnectorKind,'upload'>
export type Connector={id:string;name:string;kind:ConnectorKind;description:string;agent_name:string|null;config:Record<string,any>// eslint-disable-line @typescript-eslint/no-explicit-any
  interval_minutes:number|null;enabled:boolean;reload_requested:boolean;last_run_at:string|null;last_status:'running'|'success'|'error'|null
  last_error:string|null;last_row_count:number|null;row_count:number|null;last_loaded_at:string|null;columns:{name:string;type:string}[]|null;updated_at:string}
export type ConnectorAgent={name:string;last_seen_at:string|null;version:string|null;connector_options:{hosts?:string[];folders?:string[];secrets?:Record<string,string>
  // batch 5 (agent 0.4.0): SharePoint/OneDrive locations by name, a Microsoft app registration, the Google service account
  sharepoint?:Record<string,string>;microsoft?:boolean;google?:string|null}}

export async function loadConnectors(client:SupabaseClient){
  const {data,error}=await client.rpc('bi_list_connectors');if(error)throw new Error(error.message)
  return data as {connectors:Connector[];agents:ConnectorAgent[]}
}
export async function saveConnector(client:SupabaseClient,connector:{name:string;kind:AgentKind;description:string;agent_name:string;config:Record<string,unknown>;interval_minutes:number|null;enabled:boolean}){
  const {error}=await client.rpc('bi_save_connector',{p:connector});if(error)throw new Error(error.message)
}
export async function reloadConnector(client:SupabaseClient,name:string){const {error}=await client.rpc('bi_reload_connector',{p_name:name});if(error)throw new Error(error.message)}
export async function deleteConnector(client:SupabaseClient,name:string,dropTable:boolean){const {error}=await client.rpc('bi_delete_connector',{p_name:name,p_drop_table:dropTable});if(error)throw new Error(error.message)}

// Is this web address allowed by the agent, and may each ${SECRET} in the headers be sent there?
export function checkWebConnector(url:string,headers:{name:string;value:string}[],agent?:ConnectorAgent){
  let host='',port=''
  try{const u=new URL(url);if(!/^https?:$/.test(u.protocol))return 'The address must start with https:// (or http://)';host=u.hostname.toLowerCase();port=u.port}catch{return 'Enter a full web address, e.g. https://api.example.com/v1/items'}
  if(!agent)return 'Choose the agent that runs this connector'
  const hosts=agent.connector_options.hosts||[];const full=port?`${host}:${port}`:host
  if(!hosts.includes(full)&&!hosts.includes(host))return `${full} is not allowed by agent ${agent.name}. Add it to [connectors] allow_hosts in that agent's config.toml.`
  for(const h of headers)for(const m of h.value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)){
    const allowed=agent.connector_options.secrets?.[m[1]]
    if(!allowed)return `\${${m[1]}} is not in [connectors.secrets] of agent ${agent.name}`
    if(allowed!==full&&allowed!==host)return `\${${m[1]}} may only be sent to ${allowed}`
  }
  return null
}

// ---------------------------------------------------------------------------
// SharePoint / OneDrive and Google Sheets (run by agent 0.4.0 or later)
// ---------------------------------------------------------------------------
export const agentSupports=(agent:ConnectorAgent|undefined,kind:AgentKind)=>{
  if(!agent)return false
  if(kind==='web'||kind==='folder')return true
  return versionAtLeast(agent.version,'0.4.0')
}
export function versionAtLeast(version:string|null|undefined,wanted:string){
  const a=String(version||'0').split('.').map(n=>parseInt(n,10)||0),b=wanted.split('.').map(Number)
  for(let i=0;i<3;i++){if((a[i]||0)!==b[i])return (a[i]||0)>b[i]}
  return true
}

// Is this a path of an Excel or CSV file inside the location (wildcards only in the file name)?
export function checkSharepointConnector(location:string,path:string,agent?:ConnectorAgent){
  if(!agent)return 'Choose the agent that runs this connector'
  if(!agentSupports(agent,'sharepoint'))return `Agent ${agent.name} is version ${agent.version||'?'}; update it to 0.4.0 for SharePoint and OneDrive`
  if(!agent.connector_options.microsoft)return `Agent ${agent.name} has no Microsoft app registration yet: add [connectors.microsoft] to its config.toml (see the agent README)`
  const locations=Object.keys(agent.connector_options.sharepoint||{})
  if(!locations.includes(location))return `Choose one of the SharePoint/OneDrive locations agent ${agent.name} allows${locations.length?'':' (none yet: add [connectors.sharepoint] to its config.toml)'}`
  const p=path.trim().replace(/^\/+|\/+$/g,'')
  if(!p)return 'Enter the path of the file, e.g. Budgets/Budget 2026.xlsx'
  if(p.length>400||/[\\:<>|"]/.test(p)||p.split('/').includes('..'))return 'The path may not contain .. or any of \\ : < > | "'
  const parts=p.split('/');if(/[*?]/.test(parts.slice(0,-1).join('/')))return 'Wildcards (* ?) are only allowed in the file name'
  if(!/\.(xlsx|xlsm|csv|txt)$/i.test(parts.at(-1)!))return 'Choose an Excel (.xlsx) or CSV file'
  return null
}
export const hasWildcard=(path:string)=>/[*?]/.test(path.split('/').at(-1)||'')

// Accepts a Google Sheets link or its ID; returns the ID (or null)
export function spreadsheetId(text:string){
  const t=text.trim()
  const m=/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,100})/.exec(t)
  if(m)return m[1]
  return /^[A-Za-z0-9_-]{20,100}$/.test(t)?t:null
}
export function checkGsheetConnector(link:string,sheet:string,range:string,agent?:ConnectorAgent){
  if(!agent)return 'Choose the agent that runs this connector'
  if(!agentSupports(agent,'gsheet'))return `Agent ${agent.name} is version ${agent.version||'?'}; update it to 0.4.0 for Google Sheets`
  if(!agent.connector_options.google)return `Agent ${agent.name} has no Google service account yet: add [connectors.google] to its config.toml (see the agent README)`
  if(!spreadsheetId(link))return 'Paste the link of the Google Sheet (or its ID, the long code between /d/ and /edit)'
  if(/['!]/.test(sheet)||sheet.length>100)return "The tab name cannot contain ' or !"
  if(range&&!/^[A-Z]{1,3}[0-9]{0,7}:[A-Z]{1,3}[0-9]{0,7}$/.test(range))return 'The range must look like A1:H500 or A:H (or leave it empty for the whole tab)'
  return null
}
