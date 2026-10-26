import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkStockImportRows, prepareStockImportSource, stageAndValidateStockImport } from '../src/stockImportPipeline.ts'

test('stock imports are split into bounded sequential chunks', () => {
  const rows = Array.from({ length: 1201 }, (_, index) => index + 1)
  const chunks = chunkStockImportRows(rows, 500)
  assert.deepEqual(chunks.map((chunk) => chunk.length), [500, 500, 201])
  assert.equal(chunks[0][0], 1)
  assert.equal(chunks[2][200], 1201)
})

test('empty imports produce no upload calls and chunk limits are enforced', () => {
  assert.deepEqual(chunkStockImportRows([], 500), [])
  assert.throws(() => chunkStockImportRows([1], 0), /between 1 and 2,000/i)
  assert.throws(() => chunkStockImportRows([1], 2001), /between 1 and 2,000/i)
  assert.throws(() => chunkStockImportRows([1], 1.5), /between 1 and 2,000/i)
})

test('stock import source identity requires a file name and SHA-256 checksum', () => {
  assert.deepEqual(prepareStockImportSource('manual_csv', ' stock.csv ', 'A'.repeat(64)), {
    source_type: 'manual_csv', source_name: 'stock.csv', source_checksum: 'a'.repeat(64),
  })
  assert.throws(() => prepareStockImportSource('manual_csv', ' ', 'a'.repeat(64)), /between 1 and 255/i)
  assert.throws(() => prepareStockImportSource('manual_csv', 'stock.csv', 'not-a-checksum'), /SHA-256/i)
})

test('staging uploads sequential chunks, then validates without activating', async () => {
  const calls=[]
  const client={rpc:async(name,params)=>{calls.push([name,params]);return {data:name==='create_stock_import_batch'?'batch-1':name.startsWith('append_')?params.p_rows.length:true,error:null}}}
  const rows=Array.from({length:1201},(_,index)=>({part_number:`P${index}`}))
  const batchId=await stageAndValidateStockImport(client,{sourceType:'manual_csv',sourceName:'stock.csv',checksum:'a'.repeat(64),bookingRows:rows,reorderingRows:[{part_number:'R1'}],chunkSize:500})
  assert.equal(batchId,'batch-1')
  assert.deepEqual(calls.map(([name,params])=>[name,params.p_rows?.length]),[
    ['create_stock_import_batch',undefined],['append_stock_booking_items',500],['append_stock_booking_items',500],['append_stock_booking_items',201],['append_stock_reordering_items',1],['validate_stock_import',undefined],
  ])
  assert.equal(calls.some(([name])=>name==='activate_stock_import'),false)
})

test('a rejected chunk stops uploads and asks the database to finalize diagnostics', async () => {
  const calls=[]
  const client={rpc:async(name,params)=>{calls.push(name);if(name==='create_stock_import_batch')return {data:'batch-2',error:null};if(name==='append_stock_booking_items')return {data:0,error:null};return {data:false,error:null}}}
  await assert.rejects(()=>stageAndValidateStockImport(client,{sourceType:'manual_csv',sourceName:'stock.csv',checksum:'b'.repeat(64),bookingRows:[{part_number:'B1'}],reorderingRows:[{part_number:'R1'}]}),/chunk was rejected/i)
  assert.deepEqual(calls,['create_stock_import_batch','append_stock_booking_items','validate_stock_import'])
})
