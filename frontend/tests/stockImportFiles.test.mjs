import { test } from 'node:test'
import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import ExcelJS from 'exceljs'
import {
  BOOKING_IMPORT_FIELDS, REORDERING_IMPORT_FIELDS, autoMapImportHeaders, buildStockImportRows,
  combineStockImportChecksums, parseDelimitedText, parseStockImportFile,
} from '../src/stockImportFiles.ts'

test('CSV parsing supports BOM, quoted commas, embedded newlines and semicolons', () => {
  assert.deepEqual(parseDelimitedText('\uFEFFPart Number,Description\r\nP1,"Brake, front"\r\nP2,"Two\nlines"'), [
    ['Part Number','Description'],['P1','Brake, front'],['P2','Two\nlines'],
  ])
  assert.deepEqual(parseDelimitedText('Part Number;Description\nP1;Brake'), [['Part Number','Description'],['P1','Brake']])
  assert.deepEqual(parseDelimitedText('Stock export\nPart Number;Description\nP1;Brake'), [['Stock export'],['Part Number','Description'],['P1','Brake']])
})

test('malformed delimited files fail closed', () => {
  assert.throws(()=>parseDelimitedText('Part Number,Description\nP1,"Unclosed'),/unclosed quoted/i)
  assert.throws(()=>parseDelimitedText('Part Number,Description\nP"1,Part'),/quote inside an unquoted/i)
  assert.throws(()=>parseDelimitedText('Part Number,Description\nP1,Part,Unexpected'),/inconsistent column/i)
  assert.throws(()=>parseDelimitedText('Part Number,Description\nP1,Part\0bad'),/NUL/i)
})

test('booking mapping normalizes aliases and validates duplicate keys and whole numbers', () => {
  const headers=['Stock Code','Brand','Qty on hand ER','Maximum ER','Picking Slip ER']
  const mapping=autoMapImportHeaders(headers,BOOKING_IMPORT_FIELDS)
  const table={fileName:'booking.csv',fileChecksum:'a'.repeat(64),sheetName:'CSV',headers,formulaCells:[],sourceRowNumbers:[2,3],rows:[['P1','Generic','4','10','2'],['P1','Generic','4.5','10','2']]}
  const result=buildStockImportRows(table,'booking',mapping)
  assert.equal(result.rows[0].part_number,'P1')
  assert.equal(result.rows[0].qoh_er,4)
  assert.match(result.errors.map(error=>error.message).join(' '),/whole number/i)
  assert.match(result.errors.map(error=>error.message).join(' '),/Duplicate Part Number/i)
})

test('reordering validation handles South African currency and supplier vocabulary', () => {
  const headers=['Part No','Last Cost','Supplier Type','Global Safety']
  const mapping=autoMapImportHeaders(headers,REORDERING_IMPORT_FIELDS)
  const valid={fileName:'reorder.csv',fileChecksum:'b'.repeat(64),sheetName:'CSV',headers,formulaCells:[],sourceRowNumbers:[2],rows:[['P2','R1,234.50','LOCAL','50']]}
  const result=buildStockImportRows(valid,'reordering',mapping)
  assert.deepEqual(result.errors,[])
  assert.equal(result.rows[0].last_cost,1234.5)
  assert.equal(result.rows[0].supplier_type,'local')
  const blankCost={...valid,rows:[['P2','','Local','50']]}
  assert.equal(buildStockImportRows(blankCost,'reordering',mapping).rows[0].last_cost,null)
  const invalid={...valid,rows:[['P2','10','Overseas','50']]}
  assert.match(buildStockImportRows(invalid,'reordering',mapping).errors[0].message,/Local, International or blank/i)
})

test('numeric and formula-like text validation is strict', () => {
  const headers=['Part Number','QOH ER','Max ER']
  const mapping=autoMapImportHeaders(headers,BOOKING_IMPORT_FIELDS)
  const table={fileName:'booking.csv',fileChecksum:'a'.repeat(64),sheetName:'CSV',headers,formulaCells:[],sourceRowNumbers:[2,3,4],rows:[['=1+1','1','5'],['P2','1e3','5'],['P3','1','-1']]}
  const messages=buildStockImportRows(table,'booking',mapping).errors.map(error=>error.message).join(' ')
  assert.match(messages,/unsafe spreadsheet formula/i)
  assert.match(messages,/supported precision/i)
  assert.match(messages,/Max ER must be 0 or greater/i)
})

test('XLSX parser selects the worksheet matching each dataset and reports formulas', async () => {
  const workbook=new ExcelJS.Workbook()
  workbook.addWorksheet('Booking').addRows([['Part Number','Description','QOH ER','Max ER'],['B1','Booking part',2,5]])
  const reorder=workbook.addWorksheet('Reordering')
  reorder.addRows([['Part Number','Description','Global Safety','Avg Sales'],['R1','Reorder part',100,{formula:'1+2',result:3}]])
  const bytes=await workbook.xlsx.writeBuffer()
  const file=new File([bytes],'stock.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})
  const booking=await parseStockImportFile(file,'booking')
  const reordering=await parseStockImportFile(file,'reordering')
  assert.equal(booking.sheetName,'Booking')
  assert.equal(reordering.sheetName,'Reordering')
  assert.equal(booking.rows[0][0],'B1')
  assert.match(reordering.formulaCells.join(','),/Reordering!D2/)
})

test('file parsing rejects invalid UTF-8 and normalized duplicate headers', async () => {
  const invalidUtf8=new File([new Uint8Array([0x50,0x61,0x72,0x74,0x2c,0xff])],'bad.csv',{type:'text/csv'})
  await assert.rejects(()=>parseStockImportFile(invalidUtf8,'booking'),/valid UTF-8/i)
  const duplicate=new File(['Part Number,part-number,Description\nP1,P1,Part'],'duplicate.csv',{type:'text/csv'})
  await assert.rejects(()=>parseStockImportFile(duplicate,'booking'),/unique after punctuation and spacing/i)
})

test('paired file checksums produce a stable SHA-256 import identity', async () => {
  const first=await combineStockImportChecksums('a'.repeat(64),'b'.repeat(64))
  const second=await combineStockImportChecksums('a'.repeat(64),'b'.repeat(64))
  const reversed=await combineStockImportChecksums('b'.repeat(64),'a'.repeat(64))
  assert.match(first,/^[0-9a-f]{64}$/)
  assert.equal(first,'6173cf9d3267e6b926102c8b149812658d05d834916fd23f7451c48c888147ab')
  assert.equal(first,second)
  assert.notEqual(first,reversed)
  await assert.rejects(()=>combineStockImportChecksums('bad','b'.repeat(64)),/SHA-256/i)
})
