import { GoogleAuth } from 'google-auth-library'
import { buildGoogleSheetImport, checksumGoogleStockRows } from '../../../src/googleSheetsStock'

export type GoogleSheetsSourceConfig = {
  spreadsheet_id: string
  booking_tab: string
  reordering_tab: string
}

export type StockSourceEnvelope = {
  sourceType: 'google_sheets'
  sourceName: string
  sourceRevision: string
  retrievedAt: string
  checksum: string
  bookingRows: Record<string, unknown>[]
  reorderingRows: Record<string, unknown>[]
}

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'
const MAX_RANGE_ROW = 100_022

const quoteSheet = (name: string) => `'${name.replace(/'/g, "''")}'!A1:CV${MAX_RANGE_ROW}`

async function googleAccessToken() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim()
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n')
  if (!clientEmail || !privateKey) throw new Error('Google Sheets server credentials are not configured.')
  const auth = new GoogleAuth({ credentials: { client_email: clientEmail, private_key: privateKey }, scopes: [SHEETS_SCOPE] })
  const token = await auth.getAccessToken()
  if (!token) throw new Error('Google did not issue a Sheets access token.')
  return token
}

async function fetchWithRetry(url: string, token: string) {
  let lastError = 'Google Sheets request failed.'
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) })
      if (response.ok) return response.json()
      const body = await response.json().catch(() => ({}))
      lastError = body?.error?.message || `Google Sheets returned HTTP ${response.status}.`
      if (response.status !== 429 && response.status < 500) break
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (4 ** attempt)))
  }
  throw new Error(lastError)
}

async function readRanges(spreadsheetId: string, ranges: string[], token: string, valueRenderOption: 'FORMATTED_VALUE' | 'FORMULA') {
  const params = new URLSearchParams({ majorDimension: 'ROWS', valueRenderOption })
  ranges.forEach((range) => params.append('ranges', range))
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet?${params}`
  const body = await fetchWithRetry(url, token)
  const valueRanges = Array.isArray(body?.valueRanges) ? body.valueRanges : []
  if (valueRanges.length !== ranges.length) throw new Error('Google Sheets did not return both configured stock ranges.')
  return valueRanges.map((range: any) => Array.isArray(range.values) ? range.values as unknown[][] : [])
}

export async function fetchGoogleSheetsStock(sourceName: string, config: GoogleSheetsSourceConfig): Promise<StockSourceEnvelope> {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(config.spreadsheet_id || '')) throw new Error('The configured Google spreadsheet ID is invalid.')
  if (!config.booking_tab?.trim() || !config.reordering_tab?.trim()) throw new Error('Both Google Sheets tab names are required.')
  const ranges = [quoteSheet(config.booking_tab.trim()), quoteSheet(config.reordering_tab.trim())]
  const token = await googleAccessToken()
  const [values, formulas] = await Promise.all([
    readRanges(config.spreadsheet_id, ranges, token, 'FORMATTED_VALUE'),
    readRanges(config.spreadsheet_id, ranges, token, 'FORMULA'),
  ])
  const bookingRows = buildGoogleSheetImport(values[0], formulas[0], 'booking', config.booking_tab.trim())
  const reorderingRows = buildGoogleSheetImport(values[1], formulas[1], 'reordering', config.reordering_tab.trim())
  const checksum = await checksumGoogleStockRows(bookingRows, reorderingRows)
  return {
    sourceType: 'google_sheets', sourceName, sourceRevision: checksum.slice(0, 16), retrievedAt: new Date().toISOString(), checksum,
    bookingRows, reorderingRows,
  }
}
