import type { SupabaseClient } from '@supabase/supabase-js'
import { parseDelimitedText } from './stockImportFiles.ts'

// Sales Desk → Cross Reference. The xref schema is not exposed to browsers; everything goes
// through the permission-checked public.xref_* functions (migration 0092_xref_cross_reference.sql).

export type XrefHit = {
  sku: string; brand: string | null; title: string | null; description: string | null
  match?: 'exact' | 'starts' | 'contains' | 'description'
  matched_kind?: 'sku' | 'oe' | 'cross' | 'description'
  matched_number?: string | null
  via?: string[]; via_count?: number
}
export type XrefSearchResult = {
  query: string; direct: XrefHit[]; linked: XrefHit[]
  direct_total: number; linked_total: number; more: boolean; linked_skipped: boolean
}
export type XrefSpec = { label: string; value: string }
export type XrefPart = {
  sku: string; brand: string | null; brand_description: string | null
  title: string | null; description: string | null; warranty: string | null
  oe_numbers: string[]; cross_numbers: string[]
  package_length_cm: number | null; package_width_cm: number | null; package_height_cm: number | null; package_weight_kg: number | null
  specs: XrefSpec[]; updated_at: string | null; updated_by: string | null
}
export type XrefImportLog = { id: string; file_name: string | null; by: string | null; at: string; finished: boolean; rows: number; created: number; replaced: number; skipped: number }
export type XrefSummary = { parts: number; brands: number; numbers: number; can_import: boolean; imports: XrefImportLog[] }

export type XrefImportRow = {
  row: number; sku: string; brand: string; brand_description: string; title: string; description: string; warranty: string
  oe_numbers: string[]; cross_numbers: string[]
  package_length_cm: number | null; package_width_cm: number | null; package_height_cm: number | null; package_weight_kg: number | null
  specs: XrefSpec[]
}
export type XrefIssue = { row: number | null; sku?: string; message: string }
export type XrefPrepared = {
  rows: XrefImportRow[]
  errors: XrefIssue[]        // rows that will not be imported
  warnings: XrefIssue[]      // imported, but worth knowing
  columns: { header: string; field: string | null }[]
  specColumns: number
}

// ---------------------------------------------------------------------------------------------
// Numbers are compared like the database does: upper case, only A-Z and 0-9.
export const normalizeNumber = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '')

export const splitNumbers = (value: string) => {
  const seen = new Set<string>(); const out: string[] = []
  for (const piece of String(value || '').split(/[;\r\n]+/)) {
    const number = piece.trim(); const key = normalizeNumber(number)
    if (!key || seen.has(key)) continue
    seen.add(key); out.push(number)
  }
  return out
}

// "Cyl. Bore: 131 mm" → { label: "Cyl. Bore", value: "131 mm" } (split on the first ":")
export const parseSpec = (value: string): XrefSpec | null => {
  const text = String(value || '').trim()
  if (!text) return null
  const at = text.indexOf(':')
  if (at < 0) return { label: '', value: text }
  return { label: text.slice(0, at).trim(), value: text.slice(at + 1).trim() }
}

export const parseMeasure = (value: string): number | null | 'invalid' => {
  const text = String(value || '').trim().replace(/\s/g, '').replace(',', '.')
  if (!text) return null
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(text)) return 'invalid'
  return Number(text)
}

const headerKey = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '')
const FIELDS: { field: keyof XrefImportRow; label: string; aliases: string[] }[] = [
  { field: 'sku', label: 'Part number / SKU', aliases: ['partnumbersku', 'partnumber', 'sku', 'partno', 'ourpartnumber', 'itemcode', 'stockcode'] },
  { field: 'brand', label: 'Brand', aliases: ['brand', 'brandname', 'supplier'] },
  { field: 'brand_description', label: 'Brand Description', aliases: ['branddescription', 'aboutbrand', 'branddesc'] },
  { field: 'title', label: 'Title', aliases: ['title', 'shortdescription'] },
  { field: 'description', label: 'Description', aliases: ['description', 'fulldescription', 'longdescription'] },
  { field: 'warranty', label: 'Warranty', aliases: ['warranty'] },
  { field: 'oe_numbers', label: 'OE numbers', aliases: ['oenumbers', 'oenumber', 'oe', 'oenos', 'oeno', 'oepartnumbers'] },
  { field: 'cross_numbers', label: 'Cross ref Numbers', aliases: ['crossrefnumbers', 'crossrefnumber', 'crossref', 'crossreference', 'crossreferencenumbers', 'crossrefs'] },
  { field: 'package_length_cm', label: 'Package Length (cm)', aliases: ['packagelengthcm', 'packagelength'] },
  { field: 'package_width_cm', label: 'Package Width (cm)', aliases: ['packagewidthcm', 'packagewidth'] },
  { field: 'package_height_cm', label: 'Package Height (cm)', aliases: ['packageheightcm', 'packageheight'] },
  { field: 'package_weight_kg', label: 'Package Weight (kg)', aliases: ['packageweightkg', 'packageweight'] },
]
export const TEMPLATE_HEADERS = [...FIELDS.map((f) => f.label), ...Array.from({ length: 10 }, (_, i) => `Ekstra ${i + 1}`)]
const isSpecHeader = (key: string) => /^(ekstra|extra|spec|specification|attribute)\d*$/.test(key)

export function mapHeaders(headers: string[]) {
  const used = new Set<string>()
  return headers.map((header) => {
    const key = headerKey(header)
    if (isSpecHeader(key)) return { header, field: 'spec' }
    const match = FIELDS.find((f) => !used.has(f.field) && f.aliases.includes(key))
    if (match) { used.add(match.field); return { header, field: match.field as string } }
    return { header, field: null as string | null }
  })
}

// Turn the sheet's rows into import rows. sourceRows are the file row numbers (header = row 1).
export function prepareImport(headers: string[], rows: string[][], sourceRows?: number[]): XrefPrepared {
  const columns = mapHeaders(headers)
  const errors: XrefIssue[] = []; const warnings: XrefIssue[] = []
  const at = (field: string) => columns.findIndex((c) => c.field === field)
  if (at('sku') < 0) {
    return { rows: [], columns, specColumns: 0, warnings, errors: [{ row: null, message: 'No "Part number / SKU" column was found in the file.' }] }
  }
  const specIdx = columns.map((c, i) => (c.field === 'spec' ? i : -1)).filter((i) => i >= 0)
  for (const c of columns) if (!c.field && c.header.trim()) warnings.push({ row: null, message: `Column "${c.header}" is not used.` })

  const byKey = new Map<string, XrefImportRow>()
  rows.forEach((cells, index) => {
    const rowNo = sourceRows?.[index] ?? index + 2
    const get = (field: string) => { const i = at(field); return i < 0 ? '' : String(cells[i] ?? '').trim() }
    if (cells.every((c) => !String(c ?? '').trim())) return
    const sku = get('sku')
    if (!sku) { errors.push({ row: rowNo, message: 'No part number / SKU' }); return }
    if (sku.length > 100) { errors.push({ row: rowNo, sku: sku.slice(0, 40) + '…', message: 'Part number longer than 100 characters' }); return }
    const measures: Record<string, number | null> = {}
    for (const field of ['package_length_cm', 'package_width_cm', 'package_height_cm', 'package_weight_kg']) {
      const value = parseMeasure(get(field))
      if (value === 'invalid') { errors.push({ row: rowNo, sku, message: `${FIELDS.find((f) => f.field === field)!.label} is not a number: "${get(field)}"` }); return }
      measures[field] = value
    }
    const specs = specIdx.map((i) => parseSpec(String(cells[i] ?? ''))).filter((s): s is XrefSpec => !!s)
    const row: XrefImportRow = {
      row: rowNo, sku, brand: get('brand'), brand_description: get('brand_description'), title: get('title'),
      description: get('description'), warranty: get('warranty'),
      oe_numbers: splitNumbers(get('oe_numbers')), cross_numbers: splitNumbers(get('cross_numbers')),
      package_length_cm: measures.package_length_cm, package_width_cm: measures.package_width_cm,
      package_height_cm: measures.package_height_cm, package_weight_kg: measures.package_weight_kg, specs,
    }
    const key = sku.toUpperCase()
    const earlier = byKey.get(key)
    if (earlier) { warnings.push({ row: rowNo, sku, message: `Same part number as row ${earlier.row}; this later row is used.` }); byKey.delete(key) }
    if (!row.description && !row.title) warnings.push({ row: rowNo, sku, message: 'No description' })
    byKey.set(key, row)
  })
  return { rows: [...byKey.values()], errors, warnings, columns, specColumns: specIdx.length }
}

export const chunk = <T,>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size))

// Read the first visible worksheet that has a Part number / SKU column (or a CSV file).
export async function readPartsFile(file: { name: string; arrayBuffer: () => Promise<ArrayBuffer> }) {
  const extension = file.name.toLowerCase().split('.').pop()
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (extension === 'csv' || extension === 'txt') {
    const rows = parseDelimitedText(new TextDecoder('utf-8').decode(bytes)).map((r: unknown[]) => r.map((c) => String(c ?? '')))
    const headerAt = rows.findIndex((r) => mapHeaders(r).some((c) => c.field === 'sku'))
    if (headerAt < 0) throw new Error('No "Part number / SKU" column was found in the file.')
    return { headers: rows[headerAt], rows: rows.slice(headerAt + 1), sourceRows: rows.slice(headerAt + 1).map((_, i) => headerAt + i + 2), sheet: 'CSV' }
  }
  if (extension !== 'xlsx') throw new Error('Choose an Excel (.xlsx) or CSV file.')
  const module: any = await import('exceljs'); const excel = module.default || module
  const workbook = new excel.Workbook()
  await workbook.xlsx.load(bytes)
  let found: { headers: string[]; rows: string[][]; sourceRows: number[]; sheet: string } | null = null
  workbook.eachSheet((sheet: any) => {
    if (found || (sheet.state && sheet.state !== 'visible')) return
    const all: { n: number; cells: string[] }[] = []
    sheet.eachRow({ includeEmpty: false }, (row: any, n: number) => {
      const cells: string[] = []
      for (let c = 1; c <= Math.min(row.cellCount, 200); c++) {
        const cell = row.getCell(c); const v = cell.value
        const raw = v && typeof v === 'object' ? ('result' in v ? v.result : 'richText' in v ? v.richText.map((t: any) => t.text).join('') : 'text' in v ? v.text : v) : v
        cells.push(typeof raw === 'number' ? String(raw) : String(cell.text ?? raw ?? '').trim() || String(raw ?? '').trim())
      }
      all.push({ n, cells })
    })
    const headerAt = all.findIndex((r) => mapHeaders(r.cells).some((c) => c.field === 'sku'))
    if (headerAt < 0) return
    const data = all.slice(headerAt + 1)
    found = { headers: all[headerAt].cells, rows: data.map((r) => r.cells), sourceRows: data.map((r) => r.n), sheet: sheet.name }
  })
  if (!found) throw new Error('No worksheet has a "Part number / SKU" column.')
  return found as { headers: string[]; rows: string[][]; sourceRows: number[]; sheet: string }
}

export async function templateWorkbook() {
  const module: any = await import('exceljs'); const excel = module.default || module
  const workbook = new excel.Workbook(); const sheet = workbook.addWorksheet('Parts')
  sheet.addRow(TEMPLATE_HEADERS)
  sheet.addRow(['MH037WN5601', 'Mahle', 'About the brand…', 'LINER KIT', 'LINER KIT VOLVO D13', '1 year', '20760235;20858450', '89886110;861612;14-451190-00', 16, 16, 31.8, 6.672, 'Cyl. Bore: 131 mm', 'Outer Diameter: 144mm'])
  sheet.getRow(1).font = { bold: true }
  sheet.columns.forEach((col: any) => { col.width = 22 })
  return new Blob([await workbook.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

// ---------------------------------------------------------------------------------------------
const fail = (error: { message: string } | null) => { if (error) throw new Error(error.message) }

export async function xrefSearch(client: SupabaseClient, query: string, limit = 100): Promise<XrefSearchResult> {
  const { data, error } = await client.rpc('xref_search', { p_query: query, p_limit: limit }); fail(error)
  return data as XrefSearchResult
}
export async function xrefGetPart(client: SupabaseClient, sku: string): Promise<XrefPart | null> {
  const { data, error } = await client.rpc('xref_get_part', { p_sku: sku }); fail(error)
  return (data as XrefPart) || null
}
export async function xrefSummary(client: SupabaseClient): Promise<XrefSummary> {
  const { data, error } = await client.rpc('xref_summary'); fail(error)
  return data as XrefSummary
}

export type XrefImportOutcome = { created: number; replaced: number; skipped: XrefIssue[] }
export async function xrefImport(client: SupabaseClient, rows: XrefImportRow[], fileName: string,
                                 onProgress?: (done: number, total: number) => void, size = 500): Promise<XrefImportOutcome> {
  const parts = chunk(rows, size)
  let importId: string | null = null
  const outcome: XrefImportOutcome = { created: 0, replaced: 0, skipped: [] }
  if (!parts.length) return outcome
  for (let i = 0; i < parts.length; i++) {
    const { data, error } = await client.rpc('xref_import', { p_rows: parts[i], p_file_name: fileName, p_import_id: importId, p_finished: i === parts.length - 1 })
    fail(error)
    const r = data as { import_id: string; created: number; replaced: number; skipped: { row: number; sku?: string; reason: string }[] }
    importId = r.import_id
    outcome.created += r.created; outcome.replaced += r.replaced
    outcome.skipped.push(...r.skipped.map((s) => ({ row: s.row, sku: s.sku, message: s.reason })))
    onProgress?.(Math.min((i + 1) * size, rows.length), rows.length)
  }
  return outcome
}

// How a result was found, for the small line under the description.
export const matchLabel = (hit: XrefHit) => {
  if (hit.via?.length) {
    const more = (hit.via_count || hit.via.length) - hit.via.length
    return `Linked via ${hit.via.join(', ')}${more > 0 ? ` +${more} more` : ''}`
  }
  if (hit.match === 'description') return 'Description'
  const kind = hit.matched_kind === 'sku' ? 'Part number' : hit.matched_kind === 'oe' ? 'OE' : 'Cross ref'
  return `${kind} ${hit.matched_number || ''}`.trim()
}

export const fmtMeasure = (value: number | null, unit: string) => (value == null ? null : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 3 })} ${unit}`)
