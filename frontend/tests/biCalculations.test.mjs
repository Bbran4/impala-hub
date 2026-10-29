import {test} from 'node:test'
import assert from 'node:assert/strict'
import {parseExpression,hasAggregation,referencedFields} from '../src/biExpression.ts'
import {calcFieldProblem,compileObject,buildSpec,withCalcFields} from '../src/biApps.ts'

test('set analysis parses into a set on the aggregation',()=>{
  assert.deepEqual(parseExpression("Sum({<branch={'Centurion', 'Pretoria'}, year={2025}>} qty)"),
    {t:'fn',name:'sum',args:[{t:'field',name:'qty'}],set:{base:'$',mods:[
      {field:{t:'field',name:'branch'},op:'=',values:[{v:'Centurion'},{v:'Pretoria'}]},
      {field:{t:'field',name:'year'},op:'=',values:[{v:2025}]}]}})
  assert.deepEqual(parseExpression('Sum({1} qty)').set,{base:'1',mods:[]})
  assert.deepEqual(parseExpression('Sum({$<branch=>} qty)').set,{base:'$',mods:[{field:{t:'field',name:'branch'},op:'=',values:null}]})
  assert.deepEqual(parseExpression('Sum({A} qty)').set,{base:'A',mods:[]})
  assert.deepEqual(parseExpression('Sum({<code-={"IT*"}>} qty)').set.mods[0],{field:{t:'field',name:'code'},op:'-=',values:[{search:'IT*'}]})
  assert.deepEqual(parseExpression('Sum({<qty={">=2<=4"}>} qty)').set.mods[0].values,[{cmp:[{op:'>=',e:{t:'num',v:2}},{op:'<=',e:{t:'num',v:4}}]}])
  assert.deepEqual(parseExpression('Sum({<d={">=$(=AddDays(Today(), -7))"}>} qty)').set.mods[0].values[0].cmp[0],
    {op:'>=',e:{t:'fn',name:'adddays',args:[{t:'fn',name:'today',args:[]},{t:'num',v:-7}]}})
  assert.deepEqual(parseExpression('Sum({<year={$(=Year(Today()) - 1)}>} qty)').set.mods[0].values[0].e.t,'bin')
  assert.deepEqual(parseExpression('Count({<x={-1}>} DISTINCT code)').distinct,true)
  assert.deepEqual(parseExpression("Sum({<[Invoice Date]+={'2026-10-01'}>} qty)").set.mods[0].field,{t:'field',name:'invoice_date'})
  assert.deepEqual(parseExpression('Count({1} *)'),{t:'fn',name:'count',args:[{t:'star'}],set:{base:'1',mods:[]}})
  assert.deepEqual(parseExpression('Sum({<y={$(vYear)}>} qty)',{variables:{vYear:'2025'}}).set.mods[0].values,[{v:2025}])
})

test('set analysis mistakes get clear messages',()=>{
  assert.throws(()=>parseExpression('Upper({1} code)'),/does not take a set/)
  assert.throws(()=>parseExpression('Sum({2} qty)'),/starts with \$/)
  assert.throws(()=>parseExpression('Sum({<branch+=>} qty)'),/needs a list of values/)
  assert.throws(()=>parseExpression("Sum({<branch {'x'}>} qty)"),/Expected = after the field name/)
  assert.throws(()=>parseExpression('Sum({<y={$(=Sum(qty))}>} qty)'),/without aggregations/)
  assert.throws(()=>parseExpression('Sum({<y={"abc>} qty)'),/closing "/)
})

test('chart functions, TOTAL and Aggr',()=>{
  assert.deepEqual(parseExpression('Above(TOTAL Sum(qty), 2)'),{t:'fn',name:'above',args:[{t:'fn',name:'sum',args:[{t:'field',name:'qty'}]},{t:'num',v:2}],total:true})
  assert.throws(()=>parseExpression('Upper(TOTAL code)'),/does not take TOTAL/)
  assert.ok(hasAggregation(parseExpression('RowNo()')),'RowNo() works as a measure on its own')
  assert.ok(hasAggregation(parseExpression('Avg(Aggr(Sum(qty), customer))')))
  assert.deepEqual(parseExpression('RangeSum(Above(Sum(qty), 0, RowNo()))').args[0].args[2],{t:'fn',name:'rowno',args:[]})
  assert.deepEqual(referencedFields(parseExpression('Sum({<branch={\'x\'}, d={">=$(=Date(start))"}>} qty)')).map(f=>f.name),['qty','branch','d','start'])
})

const model=[{alias:'lines',table_name:'t',parent_alias:null,join_type:'left',join_pairs:[],columns:[{name:'qty',type:'bigint'},{name:'price',type:'numeric'},{name:'category',type:'text'},{name:'grp',type:'text'},{name:'item',type:'text'}]}]

test('calculated fields are checked and added to the model',()=>{
  const ok={table:'lines',name:'value',expression:'qty * price'}
  assert.equal(calcFieldProblem(ok,[ok],model),null)
  assert.match(calcFieldProblem({...ok,name:'Value'},[ok],model),/start with a letter/)
  assert.match(calcFieldProblem({...ok,name:'qty'},[ok],model),/already has a field/)
  assert.match(calcFieldProblem({...ok,expression:'Sum(qty)'},[ok],model),/per row/)
  assert.match(calcFieldProblem({...ok,expression:'branch'},[ok],model),/own table/)
  assert.match(calcFieldProblem(ok,[ok,ok],model),/Two calculated fields/)
  const out=withCalcFields(model,[ok,{table:'lines',name:'bad',expression:'Sum(qty)'}])
  assert.deepEqual(out[0].columns.slice(-1),[{name:'value',type:'calculated'}],'only valid calculated fields are added')
})

test('drill-down follows the selections',()=>{
  const object={id:'o',kind:'bar',title:'',x:0,y:0,w:4,h:4,dimensions:[{expr:'category',drill:['grp','item']}],measures:[{expr:'Sum(qty)'}],options:{}}
  const app={model,measures:[]}
  const at=sels=>compileObject(object,app,[],sels).dimensions[0]
  assert.equal(at([]).node.name,'category');assert.equal(at([]).drill.level,0)
  const sel=(key,values)=>({key,label:key,node:{t:'field',name:key.split('.')[1]},values})
  assert.equal(at([sel('lines.category',['Brakes'])]).node.name,'grp','one category selected: next level')
  assert.equal(at([sel('lines.category',['Brakes','Engine'])]).node.name,'category','two selected: stays')
  assert.equal(at([sel('lines.category',['Brakes']),sel('lines.grp',['Pads'])]).node.name,'item')
  assert.equal(at([sel('lines.category',['Brakes']),sel('lines.grp',['Pads'])]).drill.level,2)
})

test('alternate state selections go with queries that use them',()=>{
  const app={model,measures:[],stateSelections:{Main:[],A:[{key:'lines.category',label:'c',node:{t:'field',name:'category'},values:['Brakes']}]}}
  const plain=compileObject({id:'o',kind:'kpi',title:'',x:0,y:0,w:4,h:4,dimensions:[],measures:[{expr:'Sum(qty)'}],options:{}},app)
  assert.equal(buildSpec(plain,[]).states,undefined,'not sent when no set refers to a state')
  const withA=compileObject({id:'o',kind:'kpi',title:'',x:0,y:0,w:4,h:4,dimensions:[],measures:[{expr:'Sum({A} qty)'}],options:{}},app)
  assert.deepEqual(buildSpec(withA,[]).states,{Main:[],A:[{expr:{t:'field',name:'category'},values:['Brakes']}]})
})
