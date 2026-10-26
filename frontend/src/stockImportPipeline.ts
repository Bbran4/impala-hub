import type { SupabaseClient } from '@supabase/supabase-js'

export const STOCK_IMPORT_SOURCE_TYPES = ['manual_csv', 'manual_xlsx', 'google_sheets', 'qlik', 'sqlite_migration'] as const
export type StockImportSourceType = (typeof STOCK_IMPORT_SOURCE_TYPES)[number]
export type StockImportBatch = {
  id: string
  source_type: StockImportSourceType
  source_name: string
  source_checksum: string | null
  status: 'staged' | 'validated' | 'active' | 'rejected' | 'superseded'
  booking_row_count: number
  reordering_row_count: number
  rejected_row_count: number
  validation_errors: Array<{ dataset?: string; row_start?: number; row_end?: number; sqlstate?: string; message: string }>
  imported_by: string
  activated_by: string | null
  created_at: string
  validated_at: string | null
  activated_at: string | null
  superseded_at: string | null
}

export function chunkStockImportRows<T>(rows: T[], chunkSize = 500): T[][] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 2000) throw new Error('Import chunk size must be between 1 and 2,000 rows.')
  const chunks: T[][] = []
  for (let index = 0; index < rows.length; index += chunkSize) chunks.push(rows.slice(index, index + chunkSize))
  return chunks
}

async function rpc<T>(client: SupabaseClient, name: string, params: Record<string, unknown>) {
  const result = await client.rpc(name, params)
  if (result.error) throw new Error(result.error.message)
  return result.data as T
}

export function prepareStockImportSource(sourceType: StockImportSourceType, sourceName: string, checksum: string) {
  if (!STOCK_IMPORT_SOURCE_TYPES.includes(sourceType)) throw new Error('Choose a valid stock import source type.')
  const name = sourceName.trim()
  const hash = checksum.trim().toLowerCase()
  if (!name || name.length > 255) throw new Error('Stock import source name must be between 1 and 255 characters.')
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Stock import checksum must be a SHA-256 value.')
  return { source_type: sourceType, source_name: name, source_checksum: hash }
}

export async function createStockImportBatch(client: SupabaseClient, sourceType: StockImportSourceType, sourceName: string, checksum: string) {
  const source = prepareStockImportSource(sourceType, sourceName, checksum)
  return rpc<string>(client, 'create_stock_import_batch', { p_source_type: source.source_type, p_source_name: source.source_name, p_source_checksum: source.source_checksum })
}

async function appendRows(client: SupabaseClient, functionName: string, batchId: string, rows: Record<string, unknown>[], chunkSize: number) {
  let inserted = 0
  for (const chunk of chunkStockImportRows(rows, chunkSize)) {
    const count = await rpc<number>(client, functionName, { p_batch_id: batchId, p_rows: chunk })
    if (count !== chunk.length) throw new Error('A stock import chunk was rejected. Review the batch validation errors before continuing.')
    inserted += count
  }
  return inserted
}

export const appendStockBookingRows = (client: SupabaseClient, batchId: string, rows: Record<string, unknown>[], chunkSize = 500) =>
  appendRows(client, 'append_stock_booking_items', batchId, rows, chunkSize)
export const appendStockReorderingRows = (client: SupabaseClient, batchId: string, rows: Record<string, unknown>[], chunkSize = 500) =>
  appendRows(client, 'append_stock_reordering_items', batchId, rows, chunkSize)
export const validateStockImport = (client: SupabaseClient, batchId: string) => rpc<boolean>(client, 'validate_stock_import', { p_batch_id: batchId })
export const activateStockImport = (client: SupabaseClient, batchId: string) => rpc<boolean>(client, 'activate_stock_import', { p_batch_id: batchId })
export const rejectStockImport = (client: SupabaseClient, batchId: string, reason: string) => rpc<boolean>(client, 'reject_stock_import', { p_batch_id: batchId, p_reason: reason.trim() })

export async function stageAndValidateStockImport(client: SupabaseClient, input: {
  sourceType: StockImportSourceType
  sourceName: string
  checksum: string
  bookingRows: Record<string, unknown>[]
  reorderingRows: Record<string, unknown>[]
  chunkSize?: number
}) {
  const batchId=await createStockImportBatch(client,input.sourceType,input.sourceName,input.checksum)
  try {
    await appendStockBookingRows(client,batchId,input.bookingRows,input.chunkSize)
    await appendStockReorderingRows(client,batchId,input.reorderingRows,input.chunkSize)
  } catch(error) {
    try { await validateStockImport(client,batchId) } catch { /* Retain the staged batch for administrator recovery. */ }
    throw error
  }
  const valid=await validateStockImport(client,batchId)
  if(!valid)throw new Error('Supabase rejected the staged import. Review its validation errors before continuing.')
  return batchId
}

export async function loadStockImportBatches(client: SupabaseClient) {
  const result = await client.from('stock_import_batches').select('*').order('created_at', { ascending: false })
  if (result.error) throw new Error(result.error.message)
  return (result.data || []) as StockImportBatch[]
}
