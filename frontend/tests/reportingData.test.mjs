import {test} from 'node:test'
import assert from 'node:assert/strict'
import {ago,buildLoadUnits,filterDataTables,freshness,isAgentOnline,runDuration,scheduleLabel,summarizeLoads} from '../src/reportingData.ts'

const now=new Date('2026-10-28T10:00:00Z')
const minutesAgo=minutes=>new Date(now.getTime()-minutes*60000).toISOString()
const job=(overrides={})=>({id:1,target_table:'stock_items',description:null,source_name:'erp',group_name:null,sql_query:'SELECT 1',load_mode:'full',key_columns:[],incremental_column:null,watermark:null,interval_minutes:60,managed_by:'erp-agent',enabled:true,reload_requested:false,full_reload_requested:false,last_run_at:null,last_status:'success',last_error:null,last_row_count:3,row_count:3,last_loaded_at:null,applied_at:null,applied_by:null,...overrides})
const group=(overrides={})=>({name:'sales',description:null,interval_minutes:15,managed_by:'erp-agent',enabled:true,reload_requested:false,full_reload_requested:false,last_run_at:null,last_status:'success',last_error:null,...overrides})

test('agent is online only while its heartbeat is recent',()=>{
  assert.equal(isAgentOnline({name:'a',sources:[],app_requests:{},version:null,hostname:null,started_at:null,last_seen_at:minutesAgo(1)},now),true)
  assert.equal(isAgentOnline({name:'a',sources:[],app_requests:{},version:null,hostname:null,started_at:null,last_seen_at:minutesAgo(3)},now),false)
  assert.equal(isAgentOnline({name:'a',sources:[],app_requests:{},version:null,hostname:null,started_at:null,last_seen_at:null},now),false)
})

test('schedules read naturally',()=>{
  assert.equal(scheduleLabel(null),'Manual only')
  assert.equal(scheduleLabel(15),'Every 15 min')
  assert.equal(scheduleLabel(60),'Hourly')
  assert.equal(scheduleLabel(120),'Every 2 hours')
  assert.equal(scheduleLabel(1440),'Daily')
  assert.equal(scheduleLabel(90),'Every 90 min')
})

test('relative times',()=>{
  assert.equal(ago(null,now),'Never')
  assert.equal(ago(minutesAgo(0.2),now),'Just now')
  assert.equal(ago(minutesAgo(14),now),'14 min ago')
  assert.equal(ago(minutesAgo(180),now),'3 h ago')
  assert.equal(ago(minutesAgo(60*24*3),now),'3 days ago')
})

test('freshness allows one and a half schedules before a table is stale',()=>{
  assert.equal(freshness({last_loaded_at:minutesAgo(20),interval_minutes:15,last_status:'success'},now),'fresh')
  assert.equal(freshness({last_loaded_at:minutesAgo(23),interval_minutes:15,last_status:'success'},now),'stale')
  assert.equal(freshness({last_loaded_at:minutesAgo(5000),interval_minutes:null,last_status:'success'},now),'fresh')
  assert.equal(freshness({last_loaded_at:minutesAgo(1),interval_minutes:15,last_status:'error'},now),'failed')
  assert.equal(freshness({last_loaded_at:null,interval_minutes:15,last_status:null},now),'never')
})

test('groups come first with their tables, then single tables',()=>{
  const units=buildLoadUnits({groups:[group()],jobs:[job({target_table:'zeta'}),job({id:2,target_table:'invoice_lines',group_name:'sales',interval_minutes:null}),job({id:3,target_table:'invoices',group_name:'sales',interval_minutes:null}),job({id:4,target_table:'alpha'})]})
  assert.deepEqual(units.map(unit=>`${unit.kind}:${unit.name}`),['group:sales','table:alpha','table:zeta'])
  assert.deepEqual(units[0].jobs.map(item=>item.target_table),['invoice_lines','invoices'])
})

test('a pending reload on a grouped table shows on its group',()=>{
  const units=buildLoadUnits({groups:[group()],jobs:[job({target_table:'invoices',group_name:'sales',reload_requested:true,interval_minutes:null})]})
  assert.equal(units[0].pending,'reload')
  const full=buildLoadUnits({groups:[group({reload_requested:true,full_reload_requested:true})],jobs:[]})
  assert.equal(full[0].pending,'full')
})

test('load summary counts tables, failures and pauses',()=>{
  const units=buildLoadUnits({groups:[group({last_status:'error'})],jobs:[job({group_name:'sales',interval_minutes:null}),job({id:2,target_table:'b',enabled:false})]})
  assert.deepEqual(summarizeLoads(units),{tables:2,failing:1,paused:1,running:0})
})

test('run durations',()=>{
  assert.equal(runDuration({started_at:'2026-10-28T10:00:00Z',finished_at:null}),'—')
  assert.equal(runDuration({started_at:'2026-10-28T10:00:00Z',finished_at:'2026-10-28T10:00:00.400Z'}),'<1s')
  assert.equal(runDuration({started_at:'2026-10-28T10:00:00Z',finished_at:'2026-10-28T10:00:42Z'}),'42s')
  assert.equal(runDuration({started_at:'2026-10-28T10:00:00Z',finished_at:'2026-10-28T10:02:05Z'}),'2m 5s')
})

test('table search covers names, descriptions, groups and columns',()=>{
  const tables=[{table_name:'invoices',description:'Invoice headers',group_name:'sales',columns:[{name:'customer_code',type:'text'}],row_count:1,last_loaded_at:null,last_status:null,interval_minutes:null},
    {table_name:'stock_items',description:null,group_name:null,columns:[{name:'item_code',type:'text'}],row_count:1,last_loaded_at:null,last_status:null,interval_minutes:null}]
  for(const search of ['INVOICES','headers','sales','customer'])assert.deepEqual(filterDataTables(tables,search).map(table=>table.table_name),['invoices'])
  assert.equal(filterDataTables(tables,'  ').length,2)
})
