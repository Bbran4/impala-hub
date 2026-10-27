import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGoogleSheetImport, checksumGoogleStockRows, extractGoogleSpreadsheetId } from '../src/googleSheetsStock.ts'
import { safeStockIngestionError } from '../server/stock/ingestion/safeError.ts'

const bookingHeaders=['Source ID','Franchise','Part Number','Description','Unit Size','On Picking Slip ER','QOH ER','Max ER','On Picking Slip PTA','QOH PTA','Max PTA','QOH WH','Max WH','Bin ER','Bin PTA','Bin WH']
const reorderingHeaders=['Source ID','Franchise','Part Number','Description','Alternative 1','Alternative 2','Alternative 3','Alternative 4','QOH ER','Safety ER','QOH PTA','Safety PTA','QOH WH','Safety WH','Global Safety','Qty on Order','Qty to Order','Lead Time','Average Sales','Sales This Month','Gauge','Supplier','Last Cost','Supplier Type']

test('Google Sheets rows use the same canonical import validation', () => {
  const booking=buildGoogleSheetImport([bookingHeaders,['1','UrbanWear','UW-1','Shirt','Each','1','4','10','0','2','8','12','20','A1','B1','W1']],[], 'booking','Stock Booking')
  const reordering=buildGoogleSheetImport([reorderingHeaders,['1','UrbanWear','UW-1','Shirt','','','','','4','2','2','2','12','4','8','0','0','7','12','5','Steady','Test Supplier','99.95','Local']],[], 'reordering','Stock Reordering')
  assert.equal(booking.length,1)
  assert.equal(booking[0].part_number,'UW-1')
  assert.equal(booking[0].qoh_wh,12)
  assert.equal(reordering[0].supplier_type,'local')
  assert.equal(reordering[0].last_cost,99.95)
})

test('Google Sheets ingestion rejects formulas and missing required headers', () => {
  assert.throws(()=>buildGoogleSheetImport([bookingHeaders,['1','UrbanWear','UW-1']],[[...bookingHeaders],['1','UrbanWear','=A1']], 'booking','Stock Booking'),/Formulas are not supported/i)
  assert.throws(()=>buildGoogleSheetImport([['Description','QOH'],['Shirt','2']],[], 'booking','Stock Booking'),/Part Number header/i)
})

test('canonical checksum is stable and changes with stock content', async () => {
  const booking=[{part_number:'A',qoh_er:2,source_row_number:2}]
  const reordering=[{part_number:'A',qoh_er:2,source_row_number:2}]
  const first=await checksumGoogleStockRows(booking,reordering)
  const second=await checksumGoogleStockRows([{qoh_er:2,source_row_number:2,part_number:'A'}],reordering)
  const changed=await checksumGoogleStockRows([{part_number:'A',qoh_er:3,source_row_number:2}],reordering)
  assert.match(first,/^[0-9a-f]{64}$/)
  assert.equal(first,second)
  assert.notEqual(first,changed)
})

test('spreadsheet URLs and IDs normalize to the same source identifier', () => {
  const id='1KAG2Vm6M9N6-xqIYLF-R45W2MCxXNB5Q9Eswdt90-yg'
  assert.equal(extractGoogleSpreadsheetId(id),id)
  assert.equal(extractGoogleSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`),id)
  assert.throws(()=>extractGoogleSpreadsheetId('not-a-sheet'),/valid Google Sheets/i)
})

test('server diagnostics redact credentials, URLs and control characters', () => {
  const message=safeStockIngestionError(new Error('upstream failed\ntoken=top-secret\npassword: hunter2\nBearer abc.def\nhttps://example.test/private'))
  const authorization=safeStockIngestionError(new Error('authorization=Basic dXNlcjpwYXNz'))
  const privateKey=safeStockIngestionError(new Error('password=-----BEGIN PRIVATE KEY-----\nSECRET-MATERIAL\n-----END PRIVATE KEY-----'))
  assert.doesNotMatch(message,/top-secret|hunter2|abc\.def|example\.test/)
  assert.doesNotMatch(authorization,/dXNlcjpwYXNz/)
  assert.doesNotMatch(privateKey,/SECRET-MATERIAL|BEGIN PRIVATE KEY/)
  assert.match(message,/token=\[redacted\]/)
  assert.match(authorization,/authorization=\[redacted\]/)
})
