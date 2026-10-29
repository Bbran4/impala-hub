import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {FUNCTION_CATALOGUE,findFunction,searchFunctions} from '../src/biFunctions.ts'

test('catalogue entries are complete and unique',()=>{
  const names=new Set()
  for(const spec of FUNCTION_CATALOGUE){
    assert.ok(!names.has(spec.name.toLowerCase()),`duplicate ${spec.name}`);names.add(spec.name.toLowerCase())
    assert.ok(spec.signature.startsWith(spec.name+'('),spec.name)
    assert.ok(spec.description.length>10&&spec.examples.length>0,spec.name)
    assert.ok(spec.args[0]<=spec.args[1],spec.name)
  }
  assert.equal(findFunction('SUBFIELD').name,'SubField');assert.equal(findFunction('coalesce').name,'Alt');assert.equal(findFunction('pg_sleep'),undefined)
})

test('search finds functions by name, then by description',()=>{
  assert.equal(searchFunctions('sub')[0].name,'SubField')
  assert.equal(searchFunctions('Sum')[0].name,'Sum')
  assert.ok(searchFunctions('join text').some(spec=>spec.name==='Concat'))
  assert.ok(searchFunctions('first day month').some(spec=>spec.name==='MonthStart'))
  assert.deepEqual(searchFunctions('zzzz'),[])
  assert.equal(searchFunctions('').length,FUNCTION_CATALOGUE.length)
})

test('every function is implemented and tested in the database, and documented',()=>{
  const migration=readFileSync(new URL('../../supabase/migrations/0066_bi_linked_tables.sql',import.meta.url),'utf8').toLowerCase()
  const dbTest=readFileSync(new URL('../../supabase/tests/bi_functions.test.sql',import.meta.url),'utf8').toLowerCase()
  const docs=readFileSync(new URL('../../docs/REPORTING_FUNCTIONS.md',import.meta.url),'utf8')
  for(const spec of FUNCTION_CATALOGUE){
    const name=spec.name.toLowerCase()
    assert.ok(migration.includes(`'${name}'`),`${spec.name} missing from the database compiler`)
    assert.ok(dbTest.includes(`${name}(`),`${spec.name} has no database test`)
    assert.ok(docs.includes(`### ${spec.name}`),`${spec.name} missing from docs/REPORTING_FUNCTIONS.md (run: node scripts/gen-function-docs.mjs)`)
  }
})
