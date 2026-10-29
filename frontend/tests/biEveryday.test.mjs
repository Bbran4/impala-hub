import {test} from 'node:test'
import assert from 'node:assert/strict'
import {excelFormat,excelValue,sheetNames,safeFileName,workbookBuffer} from '../src/biExport.ts'
import {bookmarkState} from '../src/biApps.ts'

test('Excel export: names, formats and values',()=>{
  assert.deepEqual(sheetNames(['Sales by branch','Sales by branch','A very long chart title that is longer than Excel allows','Bad: [name]?','']),
    ['Sales by branch','Sales by branch (2)','A very long chart title that is','Bad name','Chart 5'])
  assert.equal(excelFormat('money'),'"R" #,##0.00');assert.equal(excelFormat('percent'),'0.0%');assert.equal(excelFormat('auto'),undefined)
  assert.equal(excelValue(12.5),12.5);assert.equal(excelValue(true),'Yes');assert.equal(excelValue(null),null)
  assert.deepEqual(excelValue('2026-10-01'),new Date('2026-10-01T00:00:00Z'))
  assert.equal(excelValue('Centurion'),'Centurion')
  assert.equal(safeFileName('Sales: overview / Oct'),'Sales overview  Oct')
})

test('Excel export builds a workbook with one tab per chart',async()=>{
  const buffer=await workbookBuffer([{title:'Sales',headers:['Branch','Sales'],formats:[undefined,'money'],rows:[['Centurion',1250.5],['Pretoria',900]]},
    {title:'Months',headers:['Month','Qty'],formats:[undefined,'integer'],rows:[['2026-10-01',5]]}])
  const {default:ExcelJS}=await import('exceljs')
  const book=new ExcelJS.Workbook();await book.xlsx.load(buffer)
  assert.deepEqual(book.worksheets.map(w=>w.name),['Sales','Months'])
  assert.equal(book.worksheets[0].getCell('B2').value,1250.5)
  assert.equal(book.worksheets[0].getColumn(2).numFmt,'"R" #,##0.00')
  assert.ok(book.worksheets[1].getCell('A2').value instanceof Date,'dates are real dates')
})

test('bookmarks keep only selections with values',()=>{
  const sel=(key,values)=>({key,label:key,node:{t:'field',name:key},values})
  assert.deepEqual(bookmarkState([sel('a',['x']),sel('b',[])],{A:[sel('c',['y'])],B:[sel('d',[])]}),{selections:[sel('a',['x'])],states:{A:[sel('c',['y'])]}})
})
