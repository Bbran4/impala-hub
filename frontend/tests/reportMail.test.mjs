import {test} from 'node:test'
import assert from 'node:assert/strict'
import {emailBody,errorText,fileName,hubUrl,subjectFor} from '../api/reporting/_reportMail.ts'
import {defaultSubject,describeSchedule,newSchedule,scheduleProblem} from '../src/biReports.ts'
import {describeRowAccess,rowRuleProblem,withWriteKeys} from '../src/biApps.ts'

const delivery={delivery_id:'d1',email:'a@b.co.za',recipient_name:'Thandi Mokoena',app_id:'a',app_name:'Sales',schedule_name:'Daily <branch> sales',
  subject:'',message:'Yesterday\'s numbers.\nCall me with questions.',is_test:false,attempt:1,sheets:[]}

test('report emails: subject, file names, hub address',()=>{
  assert.equal(subjectFor(delivery),'Sales: Daily <branch> sales')
  assert.equal(subjectFor({...delivery,subject:'Sales\r\nBcc: x@y.z',is_test:true}),'[Test] Sales Bcc: x@y.z','no header injection')
  assert.equal(fileName('Sales','Overview / week','pdf'),'Sales - Overview week.pdf')
  assert.ok(fileName('Sales','A'.repeat(300),'pdf').length<=124,'long names are cut')
  assert.equal(hubUrl({REPORT_HUB_URL:'https://hub.impala.co.za/'}),'https://hub.impala.co.za')
  assert.equal(hubUrl({VERCEL_PROJECT_PRODUCTION_URL:'impala-hub.vercel.app'}),'https://impala-hub.vercel.app')
  assert.equal(hubUrl({REPORT_HUB_URL:'http://evil.example'}),null,'only https')
  assert.equal(hubUrl({REPORT_HUB_URL:'http://127.0.0.1:5174'}),'http://127.0.0.1:5174','or localhost for testing')
  assert.equal(hubUrl({}),null)
})

test('report emails: body escapes text and shows each sheet',()=>{
  const {html,text}=emailBody(delivery,[{title:'Overview',cid:'sheet1@x'},{title:'A&B',cid:'sheet2@x'}],'https://hub.example/',new Date('2026-10-29T05:00:00Z'))
  assert.match(html,/Hi Thandi,/)
  assert.match(html,/Daily &lt;branch&gt; sales/,'names are escaped')
  assert.ok(!html.includes('<branch>'))
  assert.match(html,/cid:sheet1@x/);assert.match(html,/A&amp;B/)
  assert.match(html,/href="https:\/\/hub.example\/"/)
  assert.match(text,/Attached: Overview, A&B/)
  assert.match(text,/Thursday, 29 October/)
})

test('report emails: errors never include secrets',()=>{
  assert.equal(errorText(new Error('auth failed for pass s3cret-pw at host'),['s3cret-pw']),'auth failed for pass *** at host')
  assert.equal(errorText('x'.repeat(900),[]).length,500)
})

test('report schedules: descriptions and checks',()=>{
  const s={...newSchedule(['s1']),name:'Daily',recipients:[{type:'role',principal:'management'}]}
  assert.equal(describeSchedule(s),'Weekdays at 07:00')
  assert.equal(describeSchedule({...s,frequency:'weekly',weekdays:[5,1]}),'Mon, Fri at 07:00')
  assert.equal(describeSchedule({...s,frequency:'monthly',month_day:31,timezone:'UTC'}),'Monthly on day 31 (or the last day) at 07:00 (UTC)')
  assert.equal(scheduleProblem(s),null)
  assert.equal(scheduleProblem({...s,recipients:[]}),'Choose who gets it')
  assert.equal(scheduleProblem({...s,send_time:'7am'}),'Enter a time like 07:00')
  assert.equal(scheduleProblem({...s,frequency:'weekly',weekdays:[]}),'Choose the days of the week')
  assert.equal(defaultSubject('Sales','Daily'),'Sales: Daily')
})

test('row access: rule checks and what viewers are told',()=>{
  const model=[{alias:'invoices',table_name:'t',parent_alias:null,join_type:'left',join_pairs:[],columns:[{name:'branch',type:'text'}]}]
  assert.equal(rowRuleProblem({type:'role',principal:'management',field:'invoices.branch',all:false,values:['Centurion']},model),null)
  assert.equal(rowRuleProblem({type:'role',principal:'',field:'invoices.branch',all:true,values:[]},model),'Choose who the rule is for')
  assert.equal(rowRuleProblem({type:'role',principal:'x',field:'invoices.nope',all:true,values:[]},model),'Choose a field')
  assert.equal(rowRuleProblem({type:'role',principal:'x',field:'invoices.branch',all:false,values:[' ']},model),'Choose at least one value, or all values')
  assert.equal(describeRowAccess(null),null)
  assert.equal(describeRowAccess({'invoices.branch':['Centurion','Pretoria'],'items.group':null}),'branch: Centurion, Pretoria · group: all')
  assert.match(describeRowAccess({'#deny':true}),/not been given any rows/)
})

test('write tables keep their parsed dimensions for row access checks',()=>{
  const app={model:[{alias:'items',table_name:'t',parent_alias:null,join_type:'left',join_pairs:[],columns:[{name:'item_code',type:'text'}]}],measures:[],variables:[]}
  const objects=[{id:'w',kind:'writetable',title:'',x:0,y:0,w:4,h:4,dimensions:[{expr:'item_code'}],measures:[],options:{writeColumns:[{name:'Note',type:'text'}]}},
    {id:'b',kind:'bar',title:'',x:0,y:0,w:4,h:4,dimensions:[{expr:'item_code'}],measures:[],options:{}}]
  const out=withWriteKeys(objects,app)
  assert.deepEqual(out[0].options.keyDims,[{t:'field',name:'item_code'}])
  assert.equal(out[1].options.keyDims,undefined,'other objects are unchanged')
  assert.equal(withWriteKeys([{...objects[0],dimensions:[{expr:'nope'}]}],app)[0].options.keyDims,undefined,'not when the dimensions have errors')
})

test('Vercel Hobby allows at most 12 functions per deployment',async()=>{
  const {readdirSync,statSync}=await import('node:fs')
  const walk=dir=>readdirSync(dir).flatMap(name=>{const path=`${dir}/${name}`;if(name.startsWith('_')||name.startsWith('.'))return [];return statSync(path).isDirectory()?walk(path):/\.(ts|js|mjs)$/.test(name)?[path]:[]})
  const functions=walk(new URL('../api',import.meta.url).pathname)
  assert.ok(functions.length<=12,`${functions.length} functions in api/: ${functions.join(', ')}`)
})

test('alerts: the email shows the condition and the rows',async()=>{
  const {emailBody:body,alertSentence}=await import('../api/reporting/_reportMail.ts')
  const alert={matched:true,rows:[['Brake pads <x>',3],['Battery',1.5]],measure:'Sum(reorder - on_hand)',dimension:'item',op:'>',value:0,label:'Short by',dimension_label:'Item'}
  assert.equal(alertSentence(alert),'Short by is above 0')
  const {html,text}=body({...delivery,kind:'alert'},[],'https://hub.example/',new Date('2026-10-29T05:00:00Z'),alert)
  assert.match(html,/Alert:<\/b> Short by is above 0 for 2 Item values/)
  assert.match(html,/Brake pads &lt;x&gt;/);assert.ok(!html.includes('attached as PDF'),'no sheets mentioned without sheets')
  assert.match(text,/Alert: Short by is above 0/);assert.match(text,/Battery: 1.5/)
})

test('schedules: alert checks and the payload sent to the database',async()=>{
  const {newAlert,normalizeSchedule,schedulePayload}=await import('../src/biReports.ts')
  const app={id:'app',model:[{alias:'stock',table_name:'t',parent_alias:null,join_type:'left',join_pairs:[],columns:[{name:'item',type:'text'},{name:'on_hand',type:'bigint'}]}],measures:[{name:'Stock',expression:'Sum(on_hand)'}],variables:[]}
  const base={...newSchedule([]),name:'Low stock',kind:'alert',recipients:[{type:'role',principal:'management'}],alert:newAlert()}
  assert.match(scheduleProblem(base,app),/Enter the measure/)
  assert.match(scheduleProblem({...base,alert:{...base.alert,measure:{text:'on_hand + nope'}}},app),/Unknown field "nope"/)
  assert.match(scheduleProblem({...base,alert:{...base.alert,measure:{text:'[Stock]'}},conditions:[{text:'Sum(on_hand) > 1'}]},app),/Condition 1: cannot use aggregations/)
  const ok={...base,alert:{...base.alert,measure:{text:'[Stock]'},dimension:{text:'item'},op:'<',value:'5'}}
  assert.equal(scheduleProblem(ok,app),null,'alerts need no sheets')
  assert.equal(scheduleProblem({...ok,recipients:[]},app,true),null,'personal subscriptions need no recipients')
  const payload=schedulePayload({...ok,conditions:[{text:'on_hand > 0'},{text:' '}]},app)
  assert.deepEqual(payload.alert.measure.node,{t:'fn',name:'sum',args:[{t:'field',name:'on_hand'}]})
  assert.deepEqual(payload.alert.dimension.node,{t:'field',name:'item'})
  assert.equal(payload.alert.value,5);assert.equal(payload.alert.label,'[Stock]')
  assert.equal(payload.conditions.length,1,'empty conditions are dropped')
  assert.equal(normalizeSchedule({name:'Old'}).kind,'report','older schedules are reports')
})
