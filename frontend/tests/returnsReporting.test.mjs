import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allowedClaimStatuses, validateClaimStatus, johannesburgDate, claimTiming, matchesClaimDates, summarizeClaims, claimReportRows, claimsCsv, csvCell } from '../src/returnsReporting.ts'
import { createClaimsWorkbook } from '../src/returnsExport.ts'
import ExcelJS from 'exceljs'

const open = { id: '1', claim_no: 'RC2026102601', date: '2026-10-26', company: 'Pretoria', status: 'In Progress', sla_days: 7, handover_method: 'Not required', handover_status: 'Not required', qty: 1 }
test('new claims start open and closed claims must reopen through In Progress', () => {
  assert.equal(allowedClaimStatuses().includes('Completed'), false)
  assert.deepEqual(allowedClaimStatuses('Rejected'), ['Rejected','In Progress'])
  assert.throws(() => validateClaimStatus(null, { ...open, status: 'Completed' }))
  assert.throws(() => validateClaimStatus({ ...open, status: 'Rejected' }, { ...open, status: 'Completed' }))
})
test('rejection and reopening require a fresh reason', () => {
  assert.throws(() => validateClaimStatus(open, { ...open, status: 'Rejected' }))
  assert.doesNotThrow(() => validateClaimStatus(open, { ...open, status: 'Rejected', status_change_reason: 'Supplier declined warranty' }))
  const closed = { ...open, status: 'Completed', status_change_reason: 'Old reason' }
  assert.throws(() => validateClaimStatus(closed, { ...open, status_change_reason: 'Old reason' }))
  assert.throws(() => validateClaimStatus(closed, { ...open, status_change_reason: '  OLD   reason  ' }))
  assert.doesNotThrow(() => validateClaimStatus(closed, { ...open, status_change_reason: 'Customer returned with additional evidence' }))
})
test('completion needs the requested receipt and completed handover', () => {
  assert.throws(() => validateClaimStatus(open, { ...open, status: 'Completed', outcome_request: 'Credit' }))
  const credit = { ...open, status: 'Completed', outcome_request: 'Credit', credit_received_on: '2026-10-27' }
  assert.doesNotThrow(() => validateClaimStatus(open, credit))
  assert.throws(() => validateClaimStatus(open, { ...credit, handover_method: 'Pickup', handover_status: 'Pending' }))
  assert.doesNotThrow(() => validateClaimStatus(open, { ...credit, handover_method: 'Pickup', handover_status: 'Completed' }))
  assert.throws(() => validateClaimStatus(open, { ...credit, outcome_request: 'Replacement Part' }))
})
test('waiting statuses require supplier and handover information', () => {
  assert.throws(() => validateClaimStatus(open, { ...open, status: 'Waiting for Reply from Supplier' }))
  assert.throws(() => validateClaimStatus(open, { ...open, status: 'Awaiting Pickup/dropoff at supplier' }))
  assert.doesNotThrow(() => validateClaimStatus(open, { ...open, status: 'Awaiting Pickup/dropoff at supplier', handover_method: 'Drop-off', handover_status: 'Scheduled' }))
})
test('legacy closure permits unrelated edits but prevents removing new receipt evidence', () => {
  const legacy = { ...open, status: 'Completed' }
  assert.doesNotThrow(() => validateClaimStatus(legacy, { ...legacy, comments: 'Corrected spelling' }))
  const closed = { ...legacy, outcome_request: 'Credit', credit_received_on: '2026-10-27' }
  assert.throws(() => validateClaimStatus(closed, { ...closed, credit_received_on: null }))
})
test('SLA defaults and bounds are validated', () => {
  assert.doesNotThrow(() => validateClaimStatus(null, open))
  for (const sla_days of [0,366,1.5,'bad']) assert.throws(() => validateClaimStatus(null, { ...open, sla_days }))
})
test('Johannesburg dates and calendar-day ageing handle midnight and leap days', () => {
  assert.equal(johannesburgDate(new Date('2026-10-26T22:01:00Z')), '2026-10-27')
  assert.equal(claimTiming({ ...open, date: '2028-02-27' }, '2028-03-01').age_days, 3)
  assert.equal(claimTiming(open, '2026-10-25').age_days, 0)
})
test('warning starts in final two days and overdue begins after due date', () => {
  assert.equal(claimTiming(open, '2026-10-30').label, 'On track')
  assert.equal(claimTiming(open, '2026-10-31').label, 'Due soon')
  assert.equal(claimTiming(open, '2026-11-02').label, 'Due today')
  assert.equal(claimTiming(open, '2026-11-03').overdue, true)
  const closed = claimTiming({ ...open, status: 'Completed', closed_at: '2026-10-28T10:00:00Z' }, '2026-12-01')
  assert.equal(closed.age_days, 2)
  assert.equal(closed.overdue, false)
})
test('date bounds are inclusive and overdue filter excludes closed claims', () => {
  assert.equal(matchesClaimDates(open, '2026-10-26', '2026-10-26', '', '2026-11-03'), true)
  assert.equal(matchesClaimDates(open, '2026-10-27', '', '', '2026-11-03'), false)
  assert.equal(matchesClaimDates({ ...open, status: 'Rejected', updated_at: '2026-10-27T00:00:00Z' }, '', '', 'overdue', '2026-11-03'), false)
})
test('report summary and rows use the same filtered records', () => {
  const filtered = [open].filter(row => matchesClaimDates(row, '', '', 'overdue', '2026-11-03'))
  assert.equal(summarizeClaims(filtered, '2026-11-03').overdue, 1)
  assert.equal(claimReportRows(filtered, '2026-11-03')[0]['Age (calendar days)'], 8)
})
test('CSV escapes commas, quotes, newlines and spreadsheet formula strings', () => {
  assert.equal(csvCell('one,"two"\nthree'), '"one,""two""\nthree"')
  for (const value of ['=1+1',' +cmd','-cmd','@SUM(1)','\tcmd']) assert.ok(csvCell(value).startsWith('"\''))
  assert.equal(csvCell(-5), '"-5"')
  assert.ok(claimsCsv([{ Customer: 'Brenden', Quantity: 1 }]).startsWith('\uFEFF'))
})
test('XLSX round-trip preserves detail numbers, filters, summary and text without formulas', async () => {
  const bytes = await createClaimsWorkbook([{ ...open, customer: '=1+1', credit_amount: 25.5, credit_received_on: '2026-10-27' }], '2026-11-03', 'Company: Pretoria')
  assert.equal(String.fromCharCode(...bytes.slice(0,2)), 'PK')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes)
  const claims = workbook.getWorksheet('Claims')
  assert.equal(claims.rowCount, 2)
  assert.equal(claims.getCell('E2').value, '=1+1')
  assert.equal(claims.getCell('E2').type, ExcelJS.ValueType.String)
  assert.equal(claims.getCell('M2').value, 1)
  assert.ok(workbook.getWorksheet('Summary').getColumn(2).values.includes('Company: Pretoria'))
})
