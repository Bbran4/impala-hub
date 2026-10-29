import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {commentCounts,qualityIssues,unusedSheets} from '../src/biCollabLogic.ts'

test('comment counts per chart: open and total',()=>{
  const c=(object_id,resolved)=>({id:Math.random().toString(),object_id,resolved,body:'x',author:'A',mine:true,created_at:'',edited_at:null})
  const counts=commentCounts([c('a',false),c('a',true),c('a',false),c('b',true)])
  assert.deepEqual(counts.get('a'),{open:2,total:3})
  assert.deepEqual(counts.get('b'),{open:0,total:1})
  assert.equal(counts.get('c'),undefined)
})

test('data quality issues in words',()=>{
  const now=new Date('2026-10-29T12:00:00Z')
  const base={table_name:'stock',description:null,row_count:1000,source:'erp',mostly_empty:[],issues:0}
  const ok={...base,last_loaded_at:'2026-10-29T11:30:00Z',interval_minutes:60,empty_fields:[],
    runs:[{at:'2026-10-29T11:30:00Z',status:'success',rows:1000,error:null},{at:'2026-10-29T10:30:00Z',status:'success',rows:990,error:null}]}
  assert.deepEqual(qualityIssues(ok,now),[])
  assert.deepEqual(qualityIssues({...ok,last_loaded_at:null,runs:[]},now),['Never loaded'])
  assert.deepEqual(qualityIssues({...ok,runs:[{at:'',status:'error',rows:null,error:'timeout'},...ok.runs]},now),['Last load failed: timeout'])
  // late: more than 3 intervals + an hour
  assert.match(qualityIssues({...ok,last_loaded_at:'2026-10-29T06:00:00Z'},now)[0],/^Not loaded for 6 h \(loads every 1 h\)$/)
  assert.match(qualityIssues({...ok,last_loaded_at:'2026-10-25T06:00:00Z'},now)[0],/4 days/)
  // row count dropped by more than 20%
  assert.match(qualityIssues({...ok,runs:[{...ok.runs[0],rows:700},ok.runs[1]]},now)[0],/^Rows dropped from 990 to 700$/)
  assert.deepEqual(qualityIssues({...ok,runs:[{...ok.runs[0],rows:800},ok.runs[1]]},now),[])
  assert.deepEqual(qualityIssues({...ok,empty_fields:['fax','notes']},now),['Always empty: fax, notes'])
})

test('unused sheets from usage',()=>{
  const usage={days:30,people:[],by_day:[],apps:[{app_id:'1',name:'Sales',views:3,people:1,last_opened:null,report_emails:0,
    sheets:[{sheet_id:'s1',title:'Overview',views:3,people:1,last_opened:null},{sheet_id:'s2',title:'Old',views:0,people:0,last_opened:null}]}]}
  assert.deepEqual(unusedSheets(usage).map(s=>[s.app,s.title]),[['Sales','Old']])
})

test('every batch 4 RPC the frontend calls exists in migration 0088 with matching argument names',()=>{
  const sql=readFileSync(new URL('../../supabase/migrations/0088_bi_collaboration.sql',import.meta.url),'utf8')
  const src=readFileSync(new URL('../src/biCollabLogic.ts',import.meta.url),'utf8')
  const calls=[...src.matchAll(/'(bi_[a-z_]+)'(?:,\{([^}]*)\})?/g)]
  assert.ok(calls.length>=12)
  for(const [,name,args] of calls){
    const def=sql.match(new RegExp(`create function public\\.${name}\\(([^)]*)\\)`))
    assert.ok(def,`${name} is defined`)
    for(const arg of (args||'').split(',').map(a=>a.split(':')[0].trim()).filter(Boolean))assert.ok(def[1].includes(arg),`${name} has ${arg}`)
  }
})

test('new Reporting pages are routed and in the navigation',()=>{
  const reporting=readFileSync(new URL('../src/Reporting.tsx',import.meta.url),'utf8')
  const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8')
  for(const page of ['Data Quality','Usage','Master Items']){
    assert.ok(reporting.includes(`page==='${page}'`),`${page} routed`)
    assert.ok(app.includes(`['${page}',`),`${page} in the nav`)
  }
  assert.ok(app.includes("new CustomEvent('bi-open'"),'comment notifications open the app at the sheet')
})
