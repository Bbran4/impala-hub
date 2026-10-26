import { claimReportRows, summarizeClaims } from './returnsReporting.ts'

export async function createClaimsWorkbook(rows: Record<string, any>[], today: string, filters: string) {
  if (!rows.length) throw new Error('No claims match the selected filters.')
  const module = await import('exceljs')
  const excel = module.default || module
  const workbook = new excel.Workbook()
  workbook.creator = 'Impala Hub'
  const summary = workbook.addWorksheet('Summary')
  summary.columns = [{ header: 'Report', key: 'metric', width: 32 }, { header: 'Value', key: 'value', width: 85 }]
  summary.addRows([
    ['Returns & Claims', today], ['Timezone', 'Africa/Johannesburg'], ['Filters', filters],
    ['Default SLA', '7 calendar days; warning in final 2 days'],
    ...Object.entries(summarizeClaims(rows, today)).map(([label, value]) => [label.replace(/([A-Z])/g,' $1'), value]),
    ['By status', 'Count'], ...Array.from(new Set(rows.map(row => row.status))).sort().map(status => [status, rows.filter(row => row.status === status).length]),
    ['By company', 'Count'], ...Array.from(new Set(rows.map(row => row.company))).sort().map(company => [company, rows.filter(row => row.company === company).length]),
  ])
  const sheet = workbook.addWorksheet('Claims', { views: [{ state: 'frozen', ySplit: 1 }] })
  const report = claimReportRows(rows, today)
  const columns = Object.keys(report[0])
  sheet.columns = columns.map(header => ({ header, key: header, width: Math.min(40, Math.max(16, header.length + 2)) }))
  for (const row of report) sheet.addRow(row)
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: report.length + 1, column: columns.length } }
  sheet.getColumn('Credit amount (R)').numFmt = '#,##0.00'
  for (const worksheet of [summary,sheet]) {
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF263A50' } }
  }
  // String cells are written as strings, never Excel formulas.
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}
