import {test} from 'node:test'
import assert from 'node:assert/strict'
import {buttonValue,quickRanges,safeUrl,trellisCondition,videoSource} from '../src/biControlLogic.ts'
import {expandVariables,parseExpression} from '../src/biExpression.ts'
import {compileObject,isContained,normalizeObject,removeObject,setContainer} from '../src/biApps.ts'

test('variables are expanded like Qlik dollar expansion',()=>{
  const vars={vMin:'10',vBranch:'Centurion',vSales:'Sum(qty * unit_price)',vNested:'$(vMin) * 2'}
  assert.equal(expandVariables('Sum(qty) > $(vMin)',vars),'Sum(qty) > 10')
  assert.equal(expandVariables("branch = '$( vbranch )'",vars),"branch = 'Centurion'")
  assert.equal(expandVariables('$(vNested)',vars),'10 * 2')
  assert.deepEqual(parseExpression('$(vSales) / 2',{variables:vars}),parseExpression('Sum(qty * unit_price) / 2'))
  assert.throws(()=>parseExpression('$(vNope)',{variables:vars}),/Unknown variable "vNope"/)
  assert.throws(()=>expandVariables('$(a)',{a:'$(b)',b:'$(a)'}),/too deeply/)
  assert.equal(expandVariables('no variables',undefined),'no variables')
})

test('objects use the current variable values',()=>{
  const app={model:[{alias:'lines',table_name:'t',parent_alias:null,join_type:'left',join_pairs:[],columns:[{name:'qty',type:'bigint'}]}],measures:[],variableValues:{vMin:'5'}}
  const compiled=compileObject(normalizeObject({kind:'kpi',measures:[{expr:'Sum(qty)'}],options:{conditions:['qty > $(vMin)']}}),app)
  assert.deepEqual(compiled.errors,[])
  assert.deepEqual(compiled.conditions[0],{t:'bin',op:'>',l:{t:'field',name:'qty'},r:{t:'num',v:5}})
  const extra=compileObject(normalizeObject({kind:'kpi',measures:[{expr:'Sum(qty)'}]}),app,[{t:'bin',op:'=',l:{t:'field',name:'qty'},r:{t:'num',v:1}}])
  assert.equal(extra.conditions.length,1)
})

test('containers keep both sides in step',()=>{
  let objects=[normalizeObject({id:'tabs',kind:'tabs'}),normalizeObject({id:'a',kind:'bar'}),normalizeObject({id:'b',kind:'pie'}),normalizeObject({id:'t',kind:'trellis'})]
  objects=setContainer(objects,'a','tabs');objects=setContainer(objects,'b','tabs')
  assert.deepEqual(objects[0].options.children,['a','b']);assert.equal(objects[1].options.container,'tabs')
  assert.ok(isContained(objects[1],objects))
  objects=setContainer(objects,'a','t')
  assert.deepEqual(objects[0].options.children,['b']);assert.equal(objects[3].options.child,'a');assert.equal(objects[1].options.container,'t')
  objects=setContainer(objects,'b',null)
  assert.deepEqual(objects[0].options.children,[]);assert.equal(isContained(objects[2],objects),false)
  const removed=removeObject(objects,'t')
  assert.equal(removed.find(o=>o.id==='a').options.container,undefined)
  assert.equal(removed.length,3)
})

test('buttons, links and videos only accept safe values',()=>{
  assert.equal(buttonValue(' 2026 '),2026);assert.equal(buttonValue('Centurion'),'Centurion')
  assert.equal(safeUrl('javascript:alert(1)'),null);assert.equal(safeUrl('https://impala.co.za/x'),'https://impala.co.za/x');assert.equal(safeUrl('nope'),null)
  assert.deepEqual(videoSource('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),{kind:'embed',src:'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'})
  assert.deepEqual(videoSource('https://youtu.be/dQw4w9WgXcQ'),{kind:'embed',src:'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'})
  assert.deepEqual(videoSource('https://vimeo.com/76979871'),{kind:'embed',src:'https://player.vimeo.com/video/76979871'})
  assert.deepEqual(videoSource('https://cdn.example.com/a/training.mp4'),{kind:'file',src:'https://cdn.example.com/a/training.mp4'})
  assert.equal(videoSource('https://evil.example.com/page'),null)
  assert.equal(videoSource('https://www.youtube.com/watch?v=<script>'),null)
})

test('date ranges and trellis filters',()=>{
  const ranges=Object.fromEntries(quickRanges(new Date(2026,9,29)).map(r=>[r.label,[r.from,r.to]]))
  assert.deepEqual(ranges['Today'],['2026-10-29','2026-10-29'])
  assert.deepEqual(ranges['This week'],['2026-10-26','2026-10-29'])
  assert.deepEqual(ranges['Last month'],['2026-09-01','2026-09-30'])
  assert.deepEqual(ranges['This year'],['2026-01-01','2026-10-29'])
  const field={t:'field',name:'branch'}
  assert.deepEqual(trellisCondition(field,'Centurion'),{t:'bin',op:'=',l:field,r:{t:'str',v:'Centurion'}})
  assert.deepEqual(trellisCondition(field,null),{t:'fn',name:'isnull',args:[field]})
})
