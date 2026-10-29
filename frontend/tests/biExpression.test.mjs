import {test} from 'node:test'
import assert from 'node:assert/strict'
import {ExpressionError,checkFields,fieldKey,hasAggregation,parseExpression,plainField,referencedFields} from '../src/biExpression.ts'

const f=(name,table)=>table?{t:'field',table,name}:{t:'field',name}

test('aggregations over arithmetic follow operator precedence',()=>{
  assert.deepEqual(parseExpression('Sum(qty * unit_price - discount)'),
    {t:'fn',name:'sum',args:[{t:'bin',op:'-',l:{t:'bin',op:'*',l:f('qty'),r:f('unit_price')},r:f('discount')}]})
  assert.deepEqual(parseExpression('1 + 2 * 3'),{t:'bin',op:'+',l:{t:'num',v:1},r:{t:'bin',op:'*',l:{t:'num',v:2},r:{t:'num',v:3}}})
  assert.deepEqual(parseExpression('(1 + 2) * 3'),{t:'bin',op:'*',l:{t:'bin',op:'+',l:{t:'num',v:1},r:{t:'num',v:2}},r:{t:'num',v:3}})
})

test('Qlik field syntax: brackets, spaces, table prefix, case',()=>{
  assert.deepEqual(parseExpression('[Cost Price]'),f('cost_price'))
  assert.deepEqual(parseExpression('invoices.Branch'),f('branch','invoices'))
  assert.deepEqual(parseExpression('SUM(Qty)'),{t:'fn',name:'sum',args:[f('qty')]})
  assert.equal(fieldKey('Qty On Hand'),'qty_on_hand')
  assert.equal(fieldKey('2024 Sales'),'c_2024_sales')
})

test('Count variants',()=>{
  assert.deepEqual(parseExpression('Count(*)'),{t:'fn',name:'count',args:[{t:'star'}]})
  assert.deepEqual(parseExpression('Count(DISTINCT invoice_no)'),{t:'fn',name:'count',args:[f('invoice_no')],distinct:true})
})

test('text, comparisons, logic and dates',()=>{
  assert.deepEqual(parseExpression("branch = 'Centurion' and qty >= 2"),
    {t:'bin',op:'and',l:{t:'bin',op:'=',l:f('branch'),r:{t:'str',v:'Centurion'}},r:{t:'bin',op:'>=',l:f('qty'),r:{t:'num',v:2}}})
  assert.deepEqual(parseExpression("'it''s'"),{t:'str',v:"it's"})
  assert.deepEqual(parseExpression('invoice_date = Today() - 1'),
    {t:'bin',op:'=',l:f('invoice_date'),r:{t:'bin',op:'-',l:{t:'fn',name:'today',args:[]},r:{t:'num',v:1}}})
  assert.deepEqual(parseExpression('-5'),{t:'num',v:-5})
  assert.deepEqual(parseExpression('not qty > 1'),{t:'not',e:{t:'bin',op:'>',l:f('qty'),r:{t:'num',v:1}}})
  assert.deepEqual(parseExpression('a != b'),{t:'bin',op:'<>',l:f('a'),r:f('b')})
})

test('master measures expand when bracketed',()=>{
  const measures=[{name:'Sales',expression:'Sum(qty*unit_price)'},{name:'Cost',expression:'Sum(qty*cost_price)'},{name:'Margin %',expression:'([Sales]-[Cost])/[Sales]'}]
  const node=parseExpression('[Margin %]',{measures})
  assert.equal(node.t,'bin');assert.equal(hasAggregation(node),true)
  assert.deepEqual(referencedFields(node).map(field=>field.name).sort(),['cost_price','qty','qty','qty','unit_price','unit_price'].sort())
  assert.throws(()=>parseExpression('[Loop]',{measures:[{name:'Loop',expression:'[Loop]+1'}]}),/refers to itself/)
})

test('helpful errors with positions',()=>{
  for(const [src,message] of [['Sum(qty','closing )'],["'open",'closing quote'],['DropTable(x)','Unknown function'],['qty +','ends too early'],['qty qty','Unexpected'],['','empty'],['Sum(*)','Count(*)'],['a ; b','Unexpected ";"']]){
    assert.throws(()=>parseExpression(src),error=>error instanceof ExpressionError&&error.message.includes(message),src)
  }
})

test('aggregation detection, plain fields and model checks',()=>{
  assert.equal(hasAggregation(parseExpression('Year(invoice_date)')),false)
  assert.equal(hasAggregation(parseExpression('Round(Sum(x),2)')),true)
  assert.deepEqual(plainField(parseExpression('branch')),{table:undefined,name:'branch'})
  assert.equal(plainField(parseExpression('Year(d)')),null)
  const model=[{alias:'lines',columns:[{name:'qty'}]},{alias:'items',columns:[{name:'description'}]}]
  assert.equal(checkFields(parseExpression('Sum(qty)'),model),null)
  assert.equal(checkFields(parseExpression('items.description'),model),null)
  assert.match(checkFields(parseExpression('salary'),model),/Unknown field "salary"/)
  assert.match(checkFields(parseExpression('payroll.salary'),model),/Unknown table/)
})

test('comments are ignored, so long expressions can be annotated',()=>{
  assert.deepEqual(parseExpression('Sum(qty) // units sold'),{t:'fn',name:'sum',args:[f('qty')]})
  assert.deepEqual(parseExpression('/* sales */ Sum(qty * /* price */ unit_price)\n// done'),parseExpression('Sum(qty*unit_price)'))
  assert.deepEqual(parseExpression('Sum(qty) / 2'),{t:'bin',op:'/',l:{t:'fn',name:'sum',args:[f('qty')]},r:{t:'num',v:2}})
  assert.throws(()=>parseExpression('Sum(qty) /* open'),/closing \*\//)
})

test('argument counts and DISTINCT are checked against the catalogue',()=>{
  assert.throws(()=>parseExpression("Replace(branch, 'a')"),/Replace\(\) takes 3 arguments: Replace\(text, from, to\)/)
  assert.throws(()=>parseExpression('Left(item_code)'),/Left\(\) takes 2 arguments/)
  assert.throws(()=>parseExpression('Today(1)'),/Today\(\) takes 0 arguments/)
  assert.throws(()=>parseExpression('RangeSum(qty)'),/at least 2/)
  assert.throws(()=>parseExpression('Max(DISTINCT qty)'),/does not take DISTINCT/)
  assert.deepEqual(parseExpression("Concat(DISTINCT branch, ', ')"),{t:'fn',name:'concat',args:[f('branch'),{t:'str',v:', '}],distinct:true})
  assert.deepEqual(parseExpression('Coalesce(a, b)'),{t:'fn',name:'alt',args:[f('a'),f('b')]},'aliases map to the catalogue name')
  assert.equal(parseExpression('RangeSum(1,2,3,4,5)').args.length,5)
})

test('every catalogue example parses, and aggregations are recognised',async()=>{
  const {FUNCTION_CATALOGUE}=await import('../src/biFunctions.ts')
  for(const spec of FUNCTION_CATALOGUE)for(const example of spec.examples){
    const node=parseExpression(example.expr)
    if(spec.aggregate)assert.equal(hasAggregation(node),true,example.expr)
  }
})
