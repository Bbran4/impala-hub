import {
  autoMapImportHeaders,
  buildStockImportRows,
  fieldsForDataset,
  type ParsedImportTable,
  type StockImportDataset,
} from './stockImportFiles.ts'

export const STOCK_INGESTION_MAPPING_VERSION = 'stock-import-v1'
export const MAX_STOCK_IMPORT_ROWS = 100_000

const normalizeHeader = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '')
const cellText = (value: unknown) => value == null ? '' : String(value).trim()

function headerScore(row: unknown[], dataset: StockImportDataset) {
  const fields = fieldsForDataset(dataset)
  const normalized = new Set(row.map(normalizeHeader).filter(Boolean))
  const partNumber = fields.find((field) => field.key === 'part_number')
  const hasPartNumber = Boolean(partNumber?.aliases.some((alias) => normalized.has(normalizeHeader(alias))))
  if (!hasPartNumber) return -1
  return fields.reduce((score, field) => score + (field.aliases.some((alias) => normalized.has(normalizeHeader(alias))) ? (field.required ? 5 : 1) : 0), 0)
}

function columnName(index: number) {
  let value = index + 1
  let result = ''
  while (value) {
    value -= 1
    result = String.fromCharCode(65 + (value % 26)) + result
    value = Math.floor(value / 26)
  }
  return result
}

export function buildGoogleSheetImport(
  values: unknown[][],
  formulaValues: unknown[][],
  dataset: StockImportDataset,
  sheetName: string,
) {
  let headerIndex = -1
  let bestScore = -1
  values.slice(0, 20).forEach((row, index) => {
    const score = headerScore(row, dataset)
    if (score > bestScore) { headerIndex = index; bestScore = score }
  })
  if (headerIndex < 0) throw new Error(`${sheetName} does not contain a recognizable Part Number header in its first 20 rows.`)

  const headers = values[headerIndex].map((header, index) => cellText(header) || `Column ${index + 1}`)
  if (headers.length > 100) throw new Error(`${sheetName} exceeds the 100-column import limit.`)
  if (new Set(headers.map(normalizeHeader)).size !== headers.length) throw new Error(`${sheetName} contains duplicate column headers after normalization.`)

  const data = values.slice(headerIndex + 1).filter((row) => row.some((value) => cellText(value)))
  if (data.length > MAX_STOCK_IMPORT_ROWS) throw new Error(`${sheetName} exceeds the ${MAX_STOCK_IMPORT_ROWS.toLocaleString()}-row import limit.`)
  const formulaCells: string[] = []
  formulaValues.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    if (typeof value === 'string' && value.startsWith('=')) formulaCells.push(`${sheetName}!${columnName(columnIndex)}${rowIndex + 1}`)
  }))

  const table: ParsedImportTable = {
    fileName: `Google Sheets · ${sheetName}`,
    fileChecksum: '',
    sheetName,
    headers,
    rows: data.map((row) => headers.map((_, index) => cellText(row[index]))),
    sourceRowNumbers: data.map((_, index) => headerIndex + index + 2),
    formulaCells,
  }
  const mapping = autoMapImportHeaders(headers, fieldsForDataset(dataset))
  const result = buildStockImportRows(table, dataset, mapping)
  if (result.errors.length) {
    const details = result.errors.slice(0, 10).map((error) => `${error.row ? `row ${error.row}: ` : ''}${error.message}`).join('; ')
    throw new Error(`${sheetName} failed validation: ${details}${result.errors.length > 10 ? '; additional issues omitted' : ''}`)
  }
  return result.rows
}

function canonicalRows(rows: Record<string, unknown>[]) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right))))
}

export async function checksumGoogleStockRows(bookingRows: Record<string, unknown>[], reorderingRows: Record<string, unknown>[]) {
  const content = JSON.stringify({ mappingVersion: STOCK_INGESTION_MAPPING_VERSION, bookingRows: canonicalRows(bookingRows), reorderingRows: canonicalRows(reorderingRows) })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function extractGoogleSpreadsheetId(value: string) {
  const trimmed = value.trim()
  const match = trimmed.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)
  const id = match?.[1] || trimmed
  if (!/^[A-Za-z0-9_-]{20,}$/.test(id)) throw new Error('Enter a valid Google Sheets URL or spreadsheet ID.')
  return id
}
