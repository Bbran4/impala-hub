import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {buildRows,checkWebConnector,columnProblems,convertCell,guessColumns,inferType,safeName,uniqueNames} from '../src/biConnectorLogic.ts'
import {layoutGraph,modelLinks,sharedFieldLinks} from '../src/biModelGraph.ts'

test('upload names are made safe and unique',()=>{
  assert.equal(safeName('Budget 2026 (final).xlsx'),'budget_2026_final_xlsx')
  assert.equal(safeName('2026 targets'),'col_2026_targets')
  assert.equal(safeName('Café Région'),'cafe_region')
  assert.deepEqual(uniqueNames(['Branch','branch','',' _bi_loaded_at']),['branch','branch_2','col_3','bi_loaded_at_src'])
})

test('column types are guessed from the data',()=>{
  assert.equal(inferType(['1','2','',null]),'bigint')
  assert.equal(inferType(['1,5','2','1 250,75']),'numeric')
  assert.equal(inferType([1.5,2]),'numeric')
  assert.equal(inferType(['2026-10-01','31/10/2026','2026/10/1']),'date')
  assert.equal(convertCell('2026/10/1','date'),'2026-10-01')
  assert.equal(inferType([new Date(Date.UTC(2026,9,1))]),'date')
  assert.equal(inferType([new Date(Date.UTC(2026,9,1,14,30))]),'timestamp')
  assert.equal(inferType(['yes','No']),'boolean')
  assert.equal(inferType(['A1','2']),'text')
  assert.equal(inferType([null,'']),'text')
})

test('cells are converted for the database, with readable errors',()=>{
  assert.equal(convertCell('1 250,75','numeric'),1250.75)
  assert.equal(convertCell('31/10/2026','date'),'2026-10-31')
  assert.equal(convertCell('ja','boolean'),true)
  assert.equal(convertCell('  ','bigint'),null)
  assert.throws(()=>convertCell('abc','bigint'),/"abc" is not a whole number/)
  const sheet={name:'S',headers:['Branch','Target','Month'],rows:[['Centurion','100,5','2026-10-01'],['Pretoria','x','2026-10-01']]}
  const cols=guessColumns(sheet)
  assert.deepEqual(cols.map(c=>[c.name,c.type]),[['branch','text'],['target','text'],['month','date']])
  cols[1].type='numeric'
  const built=buildRows(sheet,cols)
  assert.deepEqual(built.rows[0],{branch:'Centurion',target:100.5,month:'2026-10-01'})
  assert.match(built.problems[0],/Row 3, Target: "x" is not a number/)
  assert.equal(columnProblems(cols.map(c=>({...c,include:false}))),'Include at least one column')
  assert.match(columnProblems([{...cols[0],name:'Bad Name'}]),/must start with a letter/)
})

test('web connectors are checked against what the agent allows',()=>{
  const agent={name:'erp-agent',last_seen_at:null,version:'0.3.0',connector_options:{hosts:['api.courier.co.za'],folders:[],secrets:{COURIER_KEY:'api.courier.co.za'}}}
  assert.equal(checkWebConnector('https://api.courier.co.za/v1/x',[{name:'Authorization',value:'Bearer ${COURIER_KEY}'}],agent),null)
  assert.match(checkWebConnector('https://evil.test/x',[],agent),/not allowed by agent erp-agent/)
  assert.match(checkWebConnector('https://api.courier.co.za/x',[{name:'X',value:'${ERP_PASSWORD}'}],agent),/not in \[connectors.secrets\]/)
  assert.match(checkWebConnector('ftp://api.courier.co.za/x',[],agent),/https/)
})

test('relationships: shared fields, app links and layout',()=>{
  const tables=[{name:'lines',columns:[{name:'invoice_no',type:'bigint'},{name:'item_code',type:'text'},{name:'modified_at',type:'timestamp'}]},
    {name:'invoices',columns:[{name:'invoice_no',type:'bigint'},{name:'branch',type:'text'},{name:'modified_at',type:'timestamp'}]},
    {name:'items',columns:[{name:'item_code',type:'text'},{name:'description',type:'text'}]},
    {name:'budget',columns:[{name:'branch',type:'text'},{name:'target',type:'numeric'}]}]
  const links=sharedFieldLinks(tables,{keysOnly:true})
  assert.deepEqual(links.map(l=>`${l.a}-${l.b}:${l.fields.map(f=>f[0]).join(',')}`),['lines-invoices:invoice_no','lines-items:item_code'])
  assert.equal(sharedFieldLinks(tables).length,3,'branch links invoices and budget when all shared fields are shown')
  assert.deepEqual(modelLinks([{alias:'lines',parent_alias:null,join_pairs:[]},{alias:'items',parent_alias:'lines',join_pairs:[['item_code','item_code']]}]),
    [{a:'items',b:'lines',fields:[['item_code','item_code']],kind:'link'}])
  const pos=layoutGraph(tables.map(t=>t.name),links,{lines:100,invoices:100,items:100,budget:100})
  assert.equal(pos.get('lines').x,20,'the most connected table is on the left')
  assert.ok(pos.get('invoices').x>pos.get('lines').x&&pos.get('items').x===pos.get('invoices').x)
  assert.ok(pos.get('budget').y>=Math.max(pos.get('invoices').y,pos.get('items').y)+100,'unconnected tables go below')
})

import {checkGsheetConnector,checkSharepointConnector,spreadsheetId,versionAtLeast,agentSupports,hasWildcard} from '../src/biConnectorLogic.ts'

const cloudAgent={name:'erp-agent',version:'0.4.0',last_seen_at:null,connector_options:{hosts:[],folders:[],secrets:{},
  sharepoint:{finance:'/sites/Finance · Documents / Budgets',jaco:'OneDrive of jaco@impala.co.za'},microsoft:true,google:'reports@impala.iam.gserviceaccount.com'}}

test('SharePoint/OneDrive connector checks',()=>{
  assert.equal(checkSharepointConnector('finance','2026/Budget 2026.xlsx',cloudAgent),null)
  assert.equal(checkSharepointConnector('jaco','/Sales/sales *.csv/',cloudAgent),null)
  assert.match(checkSharepointConnector('hr','a.xlsx',cloudAgent),/locations agent erp-agent allows/)
  assert.match(checkSharepointConnector('finance','../HR/pay.xlsx',cloudAgent),/may not contain/)
  assert.match(checkSharepointConnector('finance','a\\b.xlsx',cloudAgent),/may not contain/)
  assert.match(checkSharepointConnector('finance','*/pay.xlsx',cloudAgent),/only allowed in the file name/)
  assert.match(checkSharepointConnector('finance','notes.docx',cloudAgent),/Excel/)
  assert.match(checkSharepointConnector('finance','a.xlsx',{...cloudAgent,version:'0.3.0'}),/update it to 0.4.0/)
  assert.match(checkSharepointConnector('finance','a.xlsx',{...cloudAgent,connector_options:{...cloudAgent.connector_options,microsoft:false}}),/app registration/)
  assert.equal(hasWildcard('Sales/sales *.csv'),true);assert.equal(hasWildcard('Sales*/a.csv'),false)
})

test('Google Sheets connector checks',()=>{
  const id='1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
  assert.equal(spreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`),id)
  assert.equal(spreadsheetId(id),id);assert.equal(spreadsheetId('https://example.com/x'),null)
  assert.equal(checkGsheetConnector(`https://docs.google.com/spreadsheets/d/${id}/edit`,'Targets','A1:F500',cloudAgent),null)
  assert.equal(checkGsheetConnector(id,'','A:F',cloudAgent),null)
  assert.match(checkGsheetConnector('nope','','',cloudAgent),/Paste the link/)
  assert.match(checkGsheetConnector(id,"A'!B",'',cloudAgent),/cannot contain/)
  assert.match(checkGsheetConnector(id,'','A1;B',cloudAgent),/range/)
  assert.match(checkGsheetConnector(id,'','',{...cloudAgent,connector_options:{...cloudAgent.connector_options,google:null}}),/service account/)
})

test('agent versions',()=>{
  assert.equal(versionAtLeast('0.10.0','0.4.0'),true);assert.equal(versionAtLeast('0.3.9','0.4.0'),false);assert.equal(versionAtLeast(null,'0.4.0'),false)
  assert.equal(agentSupports({...cloudAgent,version:'0.3.0'},'web'),true);assert.equal(agentSupports({...cloudAgent,version:'0.3.0'},'gsheet'),false)
})

test('migration 0090 accepts the new kinds and the agent runs them',()=>{
  const sql=readFileSync(new URL('../../supabase/migrations/0090_bi_connectors_more.sql',import.meta.url),'utf8')
  const agentPy=readFileSync(new URL('../../bi-agent/impala_bi_agent.py',import.meta.url),'utf8')
  for(const kind of ['sharepoint','gsheet']){assert.ok(sql.includes(`'${kind}'`));assert.ok(agentPy.includes(`con["kind"] == "${kind}"`))}
})
