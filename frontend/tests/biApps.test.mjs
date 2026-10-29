import {test} from 'node:test'
import assert from 'node:assert/strict'
import {buildSpec,compactNumber,compileObject,defaultSort,displayValue,formatNumber,freeSpot,modelProblems,niceTicks,normalizeObject,orderedModel,resolveField,resolveLayout,selectionKey,suggestLinks,toCsv,toPivot,toSeries,toggleSelection} from '../src/biApps.ts'
import {parseExpression} from '../src/biExpression.ts'

const cols=(...names)=>names.map(name=>({name,type:'text'}))
const model=[
  {alias:'invoices',table_name:'t_invoices',parent_alias:'lines',join_type:'left',join_pairs:[['invoice_no','invoice_no']],columns:cols('invoice_no','branch','invoice_date')},
  {alias:'lines',table_name:'t_lines',parent_alias:null,join_type:'left',join_pairs:[],columns:cols('invoice_no','item_code','qty','unit_price')},
  {alias:'items',table_name:'t_items',parent_alias:'lines',join_type:'left',join_pairs:[['item_code','item_code']],columns:cols('item_code','description')},
]
const app={model,measures:[{name:'Sales',expression:'Sum(qty*unit_price)',format:'money'}]}
const object=(overrides)=>normalizeObject({id:'o',kind:'bar',dimensions:[{expr:'branch'}],measures:[{expr:'[Sales]'}],options:{},...overrides})

test('model order puts the main table first and resolves shared field names to it',()=>{
  assert.deepEqual(orderedModel(model).map(table=>table.alias),['lines','invoices','items'])
  assert.equal(resolveField(model,{name:'invoice_no'}),'lines')
  assert.equal(resolveField(model,{name:'branch'}),'invoices')
  assert.equal(resolveField(model,{table:'items',name:'item_code'}),'items')
  assert.equal(resolveField(model,{name:'salary'}),null)
  assert.equal(selectionKey(model,parseExpression('invoice_no')),'lines.invoice_no')
  assert.equal(selectionKey(model,parseExpression('Year(invoice_date)')),null)
})

test('link suggestions prefer key-like same-named fields',()=>{
  const suggestions=suggestLinks(cols('item_code','description','qty'),cols('item_code','description','branch'))
  assert.deepEqual(suggestions.map(item=>[item.pair[0],item.likelyKey]),[['item_code',true],['description',false]])
})

test('model problems are explained',()=>{
  assert.deepEqual(modelProblems(model),[])
  assert.match(modelProblems(model.map(table=>({...table,parent_alias:null})))[0],/exactly one main table/)
  assert.match(modelProblems([model[1],{...model[2],join_pairs:[]}])[0],/Choose how items links to lines/)
})

test('objects compile with master measures, labels, formats and selection keys',()=>{
  const compiled=compileObject(object(),app)
  assert.deepEqual(compiled.errors,[])
  assert.equal(compiled.measures[0].label,'Sales');assert.equal(compiled.measures[0].format,'money')
  assert.equal(compiled.dimensions[0].selectKey,'invoices.branch')
})

test('a bare field in a measure means Only(field), like Qlik',()=>{
  const compiled=compileObject(object({measures:[{expr:'qty - Sum(qty)'}]}),app)
  assert.deepEqual(compiled.errors,[])
  assert.deepEqual(compiled.measures[0].node,{t:'bin',op:'-',l:{t:'fn',name:'only',args:[{t:'field',name:'qty'}]},r:{t:'fn',name:'sum',args:[{t:'field',name:'qty'}]}})
})

test('object validation catches the common mistakes',()=>{
  assert.match(compileObject(object({measures:[{expr:'1 + 2'}]}),app).errors[0],/use a field or an aggregation/)
  assert.match(compileObject(object({dimensions:[{expr:'Sum(qty)'}]}),app).errors[0],/dimensions cannot use aggregations/)
  assert.match(compileObject(object({dimensions:[{expr:'salary'}]}),app).errors[0],/Unknown field "salary"/)
  assert.match(compileObject(object({kind:'pie',measures:[{expr:'[Sales]'},{expr:'Count(*)'}]}),app).errors[0],/Pie chart needs 1 measure/)
  assert.match(compileObject(object({kind:'kpi',dimensions:[{expr:'branch'}]}),app).errors[0],/KPI needs 0 dimensions/)
  assert.match(compileObject(object({dimensions:[{expr:'branch'},{expr:'item_code'}],measures:[{expr:'[Sales]'},{expr:'Count(*)'}]}),app).errors[0],/two dimensions, use one measure/)
  assert.match(compileObject(object({options:{conditions:['Sum(qty) > 1']}}),app).errors[0],/cannot aggregate/)
})

test('query specs carry selections except the ignored field, plus conditions and sort',()=>{
  const compiled=compileObject(object({options:{conditions:['invoice_date = Today()-1']}}),app)
  const selections=[{key:'invoices.branch',label:'branch',node:parseExpression('branch'),values:['Centurion']},{key:'lines.item_code',label:'item_code',node:parseExpression('item_code'),values:['BRK','FLT']}]
  const spec=buildSpec(compiled,selections,{ignoreKey:'invoices.branch',sort:defaultSort(object(),compiled),limit:50})
  assert.equal(spec.selections.length,1);assert.deepEqual(spec.selections[0].values,['BRK','FLT'])
  assert.equal(spec.conditions.length,1);assert.deepEqual(spec.sort,[{index:1,desc:true}]);assert.equal(spec.limit,50)
  assert.deepEqual(defaultSort(object({kind:'line'}),compiled),[{index:0,desc:false}])
  assert.deepEqual(buildSpec(compiled,[],{dimensions:[],measures:[0]}).dimensions,[])
})

test('selections toggle like Qlik: click replaces, ctrl-click adds, clicking the only value clears',()=>{
  const sel={key:'invoices.branch',label:'branch',node:parseExpression('branch')}
  let s=toggleSelection([],sel,'A',false);assert.deepEqual(s[0].values,['A'])
  s=toggleSelection(s,sel,'B',false);assert.deepEqual(s[0].values,['B'])
  s=toggleSelection(s,sel,'C',true);assert.deepEqual(s[0].values,['B','C'])
  s=toggleSelection(s,sel,'B',true);assert.deepEqual(s[0].values,['C'])
  s=toggleSelection(s,sel,'C',false);assert.deepEqual(s,[])
  assert.deepEqual(toggleSelection([{...sel,values:[50]}],sel,'50',true),[])
})

test('series: one per measure, or one per split value with stable colours and an Other bucket',()=>{
  const one=toSeries([['A',10,1],['B',5,2]],1,['Sales','Count'])
  assert.deepEqual(one.categories,['A','B']);assert.deepEqual(one.series.map(s=>s.values),[[10,5],[1,2]])
  const rows=[];for(let i=0;i<10;i++)rows.push(['Jan',`S${i}`,10-i]);rows.push(['Feb','S0',3])
  const split=toSeries(rows,2,['Sales'])
  assert.equal(split.series.length,8);assert.equal(split.series[7].name,'Other');assert.equal(split.series[7].values[0],1+2+3)
  assert.deepEqual(split.series[0].values,[10,3])
  const stable=toSeries([['Jan','B',1],['Jan','A',5]],2,['Sales'],['B','A'])
  assert.deepEqual(stable.series.map(s=>[s.name,s.color]),[['B','#2a78d6'],['A','#eb6834']])
})

test('pivot shapes rows by the last dimension',()=>{
  const pivot=toPivot([['Centurion','2026-10',5],['Centurion','2026-09',3],['Pretoria','2026-10',1]],1)
  assert.deepEqual(pivot.rowKeys,[['Centurion'],['Pretoria']]);assert.deepEqual(pivot.colKeys,['2026-09','2026-10'])
  assert.deepEqual(pivot.cells.get('["Pretoria"]|"2026-10"'),[1])
})

test('number formats, compact axis labels and ticks',()=>{
  assert.equal(formatNumber(1234.5,'money').replace(/\s/g,' '),'R 1 234,50')
  assert.equal(formatNumber(0.256,'percent').replace(',','.'),'25.6%')
  assert.equal(compactNumber(1500),'1.5K');assert.equal(compactNumber(2_400_000,'money'),'R 2.4M');assert.equal(compactNumber(12),'12')
  assert.deepEqual(niceTicks(0,87),[0,20,40,60,80,100])
  assert.deepEqual(niceTicks(-5,10).slice(0,2),[-5,0])
  assert.equal(displayValue(null),'(empty)');assert.equal(displayValue('2026-10-27T10:15:00'),'2026-10-27 10:15')
})

test('CSV export quotes and defuses formula-looking cells',()=>{
  assert.equal(toCsv(['a','b'],[['x,y','=SUM(A1)'],[null,'say "hi"']]),'a,b\r\n"x,y","\'=SUM(A1)"\r\n,"say ""hi"""')
})

test('layout pushes overlaps down, floats objects up and finds free space',()=>{
  const a=normalizeObject({id:'a',kind:'bar',x:0,y:0,w:12,h:4}),b=normalizeObject({id:'b',kind:'bar',x:12,y:0,w:12,h:4}),c=normalizeObject({id:'c',kind:'table',x:0,y:4,w:24,h:4})
  const moved=resolveLayout([a,b,{...c,y:2}],'c')
  assert.deepEqual(moved.map(o=>[o.id,o.x,o.y]),[['a',0,4],['b',12,4],['c',0,0]])
  const floated=resolveLayout([{...a,y:5},b])
  assert.equal(floated[0].y,0)
  assert.deepEqual(freeSpot([a,b],6,3),{x:0,y:4})
  assert.equal(resolveLayout([{...a,x:20}])[0].x,12)
})
