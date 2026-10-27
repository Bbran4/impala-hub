import type { SupabaseClient } from '@supabase/supabase-js'
import { extractGoogleSpreadsheetId } from './googleSheetsStock.ts'

export type StockIngestionSource = {
  id: string
  provider: 'google_sheets' | 'qlik' | 'odbc'
  name: string
  configuration: { spreadsheet_id?: string; booking_tab?: string; reordering_tab?: string }
  is_active: boolean
  schedule_enabled: boolean
  configured_by: string
  created_at: string
  updated_at: string
}

export type StockIngestionRun = {
  id: string
  source_id: string
  trigger_type: 'manual' | 'scheduled'
  status: 'running' | 'validated' | 'no_change' | 'failed'
  import_batch_id: string | null
  requested_by: string | null
  source_checksum: string | null
  booking_row_count: number
  reordering_row_count: number
  error_message: string
  started_at: string
  finished_at: string | null
}

async function requireResult<T>(promise: PromiseLike<{ data: T | null; error: { message: string } | null }>) {
  const result = await promise
  if (result.error) throw new Error(result.error.message)
  return result.data
}

export async function loadStockIngestion(client: SupabaseClient) {
  const [sources, runs] = await Promise.all([
    requireResult(client.from('stock_ingestion_sources').select('*').order('created_at', { ascending: true })),
    requireResult(client.from('stock_ingestion_runs').select('*').order('started_at', { ascending: false }).limit(20)),
  ])
  return { sources: (sources || []) as StockIngestionSource[], runs: (runs || []) as StockIngestionRun[] }
}

export async function saveGoogleSheetsSource(client: SupabaseClient, input: {
  id?: string
  name: string
  spreadsheet: string
  bookingTab: string
  reorderingTab: string
  isActive: boolean
  scheduleEnabled: boolean
}) {
  const configuration = {
    spreadsheet_id: extractGoogleSpreadsheetId(input.spreadsheet),
    booking_tab: input.bookingTab.trim(),
    reordering_tab: input.reorderingTab.trim(),
  }
  if (!input.name.trim()) throw new Error('Enter a source name.')
  if (!configuration.booking_tab || !configuration.reordering_tab) throw new Error('Enter both Google Sheets tab names.')
  const result = await client.rpc('save_stock_ingestion_source', {
    p_source_id: input.id || null,
    p_provider: 'google_sheets',
    p_name: input.name.trim(),
    p_configuration: configuration,
    p_is_active: input.isActive,
    p_schedule_enabled: input.scheduleEnabled,
  })
  if (result.error) throw new Error(result.error.message)
  return result.data as string
}

export async function syncStockIngestionSource(client: SupabaseClient, sourceId: string) {
  const session = await client.auth.getSession()
  const token = session.data.session?.access_token
  if (!token) throw new Error('Your session has expired. Sign in again.')
  const response = await fetch('/api/stock/ingestion/sync', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.detail || 'Could not synchronize the stock source.')
  return body as { status: 'validated' | 'no_change'; batchId?: string; bookingRows: number; reorderingRows: number }
}
