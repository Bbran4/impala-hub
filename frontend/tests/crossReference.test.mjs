import { test } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import {
  chunk, mapHeaders, matchLabel, normalizeNumber, parseMeasure, parseSpec, prepareImport, readPartsFile, splitNumbers,
  templateWorkbook, TEMPLATE_HEADERS, xrefImport,
} from '../src/crossReferenceLogic.ts'

// The headers exactly as in the sample file (Parts_info_002.xlsx)
const SAMPLE_HEADERS = ['Part number /SKU', 'Brand', 'Brand Description', 'Title', 'Description', 'Warranty', 'OE numbers', 'Cross ref Numbers',
  'Package Length (cm)', 'Package Width (cm)', 'Package height (cm)', 'Package Weight (kg)',
  'Ekstra 1', 'Ekstra 2', 'Ekstra 3', 'Ekstra 4', 'Ekstra 5', 'Ekstra 6', 'Ekstra 7', 'Ekstra 8', 'Ekstra 9', 'Ekstra 10']
const SAMPLE_ROWS = [
  ['MH037WN5601', 'Mahle', 'Mahle is a reputable supplier…', 'LINER KIT', 'LINER KIT VOLVO D13', '1 year', '20760235;20858450', '89886110;861612;14-451190-00', 16, 16, 31.8, 6.672,
    'Cyl. Bore: 131 mm', 'Outer Diameter: 144mm', 'Length: 261.8mm', 'Flange Diameter: 159.6mm', 'Top Land Height: 0.99', 'Processing: finished', 'Gasket/Seal design: Soft Material Gasket', 'Cylinder Liner: Without cylinder liner ring', 'Supplementary Info 2: Wet cylinder liner', null],
  ['P040076', 'PAI', 'PAI is…', 'CONROD BOLT', 'CONROD BOLT CUMMINS ISX', '2 years', 3678574, null, 5.08, 5.08, 15.24, 0.43, 'Bolt Type: Flanged 12-Point', 'Thread size: M12x1.25'],
  ['FEB173607', 'Febi', 'Febi Bilstein is…', 'AIR FILTER KIT', 'AIR FILTER KIT VOLVO FH VERSION 4', '3 years', '21834205S1;21115501S1;21115483S1;21243188S1;7421243188S1',
    'A-71420-S;A-71400;A-71410;ADG1893R;LX3141;ADG1896R;LXS300; LXS319;C331460/3;CF1940;AF2797;AF4187;47531;105983', 34, 34, 42, null, 'Filter type: filter insert', 'Height: 383mm', 'Height: 415mm'],
  ['4962732X', 'ACV', 'ACV is…', 'CYLINDER HEAD AFTERMARKET', 'CYLINDER HEAD AFTERMARKET CUMMINS ISX', '1 year', '5413782;4962732;4331387;3683986;3683002;3682863', null, 121.92, 48.26, 30.48, 233, 'Head type: Assembly', 'Includes: Cam bushes', 'Includes: Valves'],
  ['VR02-10808-02', 'Victor-Reinz', 'Victor Reinz is…', 'UPPER GASKET SET', 'UPPER GASKET SET CUMMINS ISX', '1 year', '4352144;4955595;4025300', 'HS54775-1;131637;132057;4955595', null, null, null, null, 'Supplementary Article: Without Valve Stem Seals'],
]

async function sampleFile(rows = SAMPLE_ROWS, name = 'Parts_info_002.xlsx') {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Sheet1')
  ws.addRow(SAMPLE_HEADERS); rows.forEach((r) => ws.addRow(r))
  const buffer = await wb.xlsx.writeBuffer()
  return { name, arrayBuffer: async () => buffer }
}

test('numbers compare without case, spaces, dashes, slashes and dots', () => {
  assert.equal(normalizeNumber('14-451190-00'), '1445119000')
  assert.equal(normalizeNumber('c331460/3'), 'C3314603')
})

test('OE and cross ref numbers split on ";" and are trimmed and de-duplicated', () => {
  assert.deepEqual(splitNumbers('LXS300; LXS319;;C331460/3'), ['LXS300', 'LXS319', 'C331460/3'])
  assert.deepEqual(splitNumbers('4955595;4955-595;4955595'), ['4955595'])
  assert.deepEqual(splitNumbers(''), [])
})

test('extra info splits on the first ":"', () => {
  assert.deepEqual(parseSpec('Cyl. Bore: 131 mm'), { label: 'Cyl. Bore', value: '131 mm' })
  assert.deepEqual(parseSpec('Length(mm): 100'), { label: 'Length(mm)', value: '100' })
  assert.deepEqual(parseSpec('Ratio: 1:2'), { label: 'Ratio', value: '1:2' })
  assert.deepEqual(parseSpec('Wet cylinder liner'), { label: '', value: 'Wet cylinder liner' })
  assert.equal(parseSpec('  '), null)
})

test('package sizes accept a decimal comma and reject text', () => {
  assert.equal(parseMeasure('5,08'), 5.08)
  assert.equal(parseMeasure(''), null)
  assert.equal(parseMeasure('heavy'), 'invalid')
  assert.equal(parseMeasure('-3'), 'invalid')
})

test('the sample headers are all recognised', () => {
  const map = mapHeaders(SAMPLE_HEADERS)
  assert.deepEqual(map.slice(0, 12).map((c) => c.field), ['sku', 'brand', 'brand_description', 'title', 'description', 'warranty', 'oe_numbers', 'cross_numbers',
    'package_length_cm', 'package_width_cm', 'package_height_cm', 'package_weight_kg'])
  assert.ok(map.slice(12).every((c) => c.field === 'spec'))
  assert.equal(mapHeaders(['Notes'])[0].field, null)
})

test('the sample file reads into five parts', async () => {
  const sheet = await readPartsFile(await sampleFile())
  const prepared = prepareImport(sheet.headers, sheet.rows, sheet.sourceRows)
  assert.equal(prepared.rows.length, 5)
  assert.deepEqual(prepared.errors, [])
  const mahle = prepared.rows[0]
  assert.equal(mahle.row, 2)
  assert.deepEqual(mahle.cross_numbers, ['89886110', '861612', '14-451190-00'])
  assert.equal(mahle.package_height_cm, 31.8)
  assert.equal(mahle.specs.length, 9)
  assert.deepEqual(mahle.specs[8], { label: 'Supplementary Info 2', value: 'Wet cylinder liner' })
  const pai = prepared.rows[1]
  assert.deepEqual(pai.oe_numbers, ['3678574'], 'a number stored as a number cell is read as text')
  assert.deepEqual(pai.cross_numbers, [])
  const febi = prepared.rows[2]
  assert.equal(febi.cross_numbers.length, 14)
  assert.equal(febi.package_weight_kg, null)
  assert.deepEqual(febi.specs.filter((s) => s.label === 'Height').map((s) => s.value), ['383mm', '415mm'])
  assert.equal(prepared.rows[4].package_length_cm, null)
})

test('rows without a SKU or with a bad size are skipped; a repeated SKU uses the later row', () => {
  const p = prepareImport(SAMPLE_HEADERS, [
    ['', 'Brand'], ['A1', 'X', '', '', 'FIRST'], ['B1', 'X', '', '', 'B', '', '', '', 'long'], ['a1', 'X', '', '', 'SECOND'], [],
  ])
  assert.deepEqual(p.errors.map((e) => e.row), [2, 4])
  assert.equal(p.rows.length, 1)
  assert.equal(p.rows[0].description, 'SECOND')
  assert.match(p.warnings[0].message, /row 3/)
})

test('a file without a SKU column is refused', async () => {
  assert.equal(prepareImport(['Brand', 'Description'], [['X', 'Y']]).errors[0].row, null)
  const wb = new ExcelJS.Workbook(); wb.addWorksheet('S').addRow(['Brand'])
  const buffer = await wb.xlsx.writeBuffer()
  await assert.rejects(readPartsFile({ name: 'x.xlsx', arrayBuffer: async () => buffer }), /Part number/)
  await assert.rejects(readPartsFile({ name: 'x.pdf', arrayBuffer: async () => new ArrayBuffer(0) }), /xlsx/)
})

test('CSV files are read too', async () => {
  const csv = 'Part number /SKU,Brand,OE numbers\nP1,PAI,"1;2"\n'
  const sheet = await readPartsFile({ name: 'p.csv', arrayBuffer: async () => new TextEncoder().encode(csv).buffer })
  assert.deepEqual(prepareImport(sheet.headers, sheet.rows, sheet.sourceRows).rows[0].oe_numbers, ['1', '2'])
})

test('the template has every column and reads back', async () => {
  const blob = await templateWorkbook()
  const sheet = await readPartsFile({ name: 't.xlsx', arrayBuffer: () => blob.arrayBuffer() })
  assert.deepEqual(sheet.headers, TEMPLATE_HEADERS)
  assert.equal(prepareImport(sheet.headers, sheet.rows, sheet.sourceRows).rows[0].sku, 'MH037WN5601')
})

test('imports are sent in chunks under one import id, the last one finishing it', async () => {
  const calls = []
  const client = { rpc: async (name, args) => { calls.push({ name, args }); return { data: { import_id: 'imp-1', created: args.p_rows.length - 1, replaced: 1, skipped: [{ row: 9, reason: 'x' }] }, error: null } } }
  const rows = Array.from({ length: 1201 }, (_, i) => ({ row: i + 2, sku: 'S' + i }))
  const progress = []
  const out = await xrefImport(client, rows, 'f.xlsx', (d) => progress.push(d))
  assert.deepEqual(calls.map((c) => c.args.p_rows.length), [500, 500, 201])
  assert.deepEqual(calls.map((c) => c.args.p_import_id), [null, 'imp-1', 'imp-1'])
  assert.deepEqual(calls.map((c) => c.args.p_finished), [false, false, true])
  assert.deepEqual(progress, [500, 1000, 1201])
  assert.equal(out.created + out.replaced, 1201)
  assert.equal(out.skipped.length, 3)
  await assert.rejects(xrefImport({ rpc: async () => ({ data: null, error: { message: 'Only administrators can import' } }) }, rows, 'f'), /administrators/)
  assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]])
})

test('results say why they were found', () => {
  assert.equal(matchLabel({ sku: 'A', match: 'exact', matched_kind: 'oe', matched_number: '4955595' }), 'OE 4955595')
  assert.equal(matchLabel({ sku: 'A', match: 'contains', matched_kind: 'cross', matched_number: '14-451190-00' }), 'Cross ref 14-451190-00')
  assert.equal(matchLabel({ sku: 'A', match: 'description', matched_kind: 'description' }), 'Description')
  assert.equal(matchLabel({ sku: 'A', via: ['1', '2', '3'], via_count: 5 }), 'Linked via 1, 2, 3 +2 more')
})
