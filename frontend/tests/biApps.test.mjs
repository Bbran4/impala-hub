import {test} from 'node:test'
import assert from 'node:assert/strict'
import {buildSpec,cellStyle,columnOrder,contrastText,fitOptions,moveColumn,safeColor,compactNumber,compileObject,defaultSort,displayValue,formatNumber,freeSpot,modelProblems,niceTicks,relinkModel,removeFromModel,rerootModel,normalizeObject,orderedModel,resolveField,resolveLayout,selectionKey,suggestLinks,toCsv,toPivot,toSeries,toggleSelection} from '../src/biApps.ts'
import {parseExpression} from '../src/biExpression.ts'

const cols=(...names)=>names.map(name=>({name,type:'text'}))
const model=[
  {alias:'invoices',table_name:'t_invoices',parent_alias:'lines',join_type:'left',join_pairs:[['invoice_no','invoice_no']],columns:cols('invoice_no','branch','invoice_date')},
  {alias:'lines',table_name:'t_lines',parent_alias:null,join_type:'left',join_pairs:[],columns:cols('invoice_no','item_code','qty','unit_price')},
  {alias:'items',table_name:'t_items',parent_alias:'lines',join_type:'left',join_pairs:[['item_code','item_code']],columns:cols('item_code','description')},
]
const app={model,measures:[{name:'Sales',expression:'Sum(qty*unit_price)',format:'money'}]}
const object=(overrides)=>normalizeObject({id:'o',kind:'bar',dimensions:[{expr:'branch'}],measures:[{expr:'[Sales]'}],options:{},...overrides})

test('model order puts the first table first and resolves shared field names to it',()=>{
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
  assert.match(modelProblems(model.map(table=>({...table,parent_alias:null})))[0],/Link every table to another table/)
  assert.match(modelProblems([model[1],{...model[2],join_pairs:[]}])[0],/Choose the fields that link items and lines/)
  assert.match(modelProblems([model[1],{...model[2],join_pairs:[['nope','item_code']]}])[0],/items has no field nope/)
})

// two-way links: the same pairs of tables stay linked whichever table is first
const links=m=>m.filter(t=>t.parent_alias).map(t=>[t.alias,t.parent_alias,...t.join_pairs.flat()].join(' ')).sort()
const undirected=m=>m.filter(t=>t.parent_alias).map(t=>[t.alias,t.parent_alias].sort().join('-')).sort()

test('rerooting keeps the same links',()=>{
  const rerooted=rerootModel(model,'items')
  assert.equal(orderedModel(rerooted)[0].alias,'items')
  assert.deepEqual(undirected(rerooted),undirected(model))
  assert.deepEqual(links(rerooted),['invoices lines invoice_no invoice_no','lines items item_code item_code'])
  assert.deepEqual(modelProblems(rerooted),[])
})

test('relinking moves one link and keeps the first table',()=>{
  const relinked=relinkModel(model,'items','invoices',[['item_code','invoice_no']])
  assert.equal(orderedModel(relinked)[0].alias,'lines')
  assert.deepEqual(undirected(relinked),['invoices-items','invoices-lines'])
  // the first table can be linked to something else too; the link it had through that table moves
  const fromFirst=relinkModel(model,'lines','items',[['item_code','item_code']])
  assert.deepEqual(undirected(fromFirst),undirected(model))
  const chain=relinkModel(relinked,'lines','items',[['item_code','item_code']])
  assert.deepEqual(undirected(chain),['invoices-items','items-lines'])
  assert.equal(orderedModel(chain)[0].alias,'lines')
})

test('removing a table relinks the tables linked through it',()=>{
  const removed=removeFromModel(model,'lines')
  assert.deepEqual(removed.map(t=>t.alias).sort(),['invoices','items'])
  assert.equal(removed.filter(t=>!t.parent_alias).length,1)
  assert.deepEqual(modelProblems(removed),['Choose the fields that link items and invoices.'])
  assert.deepEqual(modelProblems(removeFromModel(model,'items')),[])
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

test('moving dimensions and measures keeps sort and column order on the same columns',()=>{
  const table=object({kind:'table',dimensions:[{expr:'branch'},{expr:'item_code'}],measures:[{expr:'Sum(qty)'},{expr:'[Sales]'}],options:{sortBy:3,columnOrder:[2,0,1,3]}})
  const moved=moveColumn(table,'measure',1,0)
  assert.deepEqual(moved.measures.map(m=>m.expr),['[Sales]','Sum(qty)'])
  assert.equal(moved.options.sortBy,2)
  assert.deepEqual(moved.options.columnOrder,[3,0,1,2])
  const dims=moveColumn(table,'dimension',1,0)
  assert.deepEqual(dims.dimensions.map(d=>d.expr),['item_code','branch'])
  assert.deepEqual(dims.options.columnOrder,[2,1,0,3])
  assert.deepEqual(columnOrder({...table,options:{columnOrder:[3,3,9]}}),[3,0,1,2])
})

test('adding or removing a column keeps the options aligned',()=>{
  const table=object({kind:'table',dimensions:[{expr:'branch'},{expr:'item_code'}],measures:[{expr:'Sum(qty)'}],options:{sortBy:2,columnOrder:[2,1,0]}})
  assert.deepEqual(fitOptions(table,3,1),{sortBy:3,columnOrder:[3,1,0]})
  assert.deepEqual(fitOptions(table,1,1,{kind:'dimension',index:0}),{sortBy:1,columnOrder:[1,0]})
  assert.deepEqual(fitOptions(table,2,0,{kind:'measure',index:0}),{sortBy:undefined,columnOrder:[1,0]})
})

test('cell colours come from extra query columns and only real colours are used',()=>{
  assert.equal(safeColor('#E34948'),'#e34948');assert.equal(safeColor('rgb(1, 2, 3)'),'rgb(1, 2, 3)');assert.equal(safeColor('red'),'red')
  assert.equal(safeColor('url(javascript:alert(1))'),null);assert.equal(safeColor('red; color: blue'),null);assert.equal(safeColor(12),null)
  assert.equal(contrastText('#ffffff'),'#16324a');assert.equal(contrastText('rgb(20,30,40)'),'#ffffff')
  const table=object({kind:'table',dimensions:[{expr:'branch',background:"If(branch = 'Centurion', 'gold')"}],measures:[{expr:'Sum(qty)',textColor:"If(Sum(qty) < 0, 'red', 'green')"},{expr:'[Sales]',background:"'#ffffff'"}]})
  const compiled=compileObject(table,app)
  assert.deepEqual(compiled.errors,[])
  assert.deepEqual(compiled.styles.map(style=>[style.column,style.kind]),[[0,'background'],[1,'color'],[2,'background']])
  assert.deepEqual(compiled.styles[2].node,{t:'fn',name:'only',args:[{t:'str',v:'#ffffff'}]})
  assert.equal(buildSpec(compiled,[],{styles:true}).measures.length,5)
  assert.equal(buildSpec(compiled,[]).measures.length,2)
  const row=['Centurion',5,100,'gold','green','#ffffff']
  assert.deepEqual(cellStyle(compiled,row,0,3),{background:'gold',color:'#16324a'})
  assert.deepEqual(cellStyle(compiled,row,1,3),{color:'green'})
  assert.deepEqual(cellStyle(compiled,['Pretoria',5,100,null,'nope',null],0,3),{})
})
