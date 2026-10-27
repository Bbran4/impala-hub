import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { fetchStockSource, type StockIngestionSource } from './sourceAdapters'
import { safeStockIngestionError } from './safeError'

const CHUNK_SIZE = 2_000

function serverConfig() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !publishableKey || !serviceKey) throw new Error('Stock ingestion server configuration is incomplete.')
  return { url, publishableKey, serviceKey }
}

async function rpc<T>(client: SupabaseClient, name: string, params: Record<string, unknown>) {
  const result = await client.rpc(name, params)
  if (result.error) throw new Error(result.error.message)
  return result.data as T
}

async function appendRows(client: SupabaseClient, name: string, actorId: string, batchId: string, rows: Record<string, unknown>[]) {
  let inserted = 0
  for (let index = 0; index < rows.length; index += CHUNK_SIZE) {
    const chunk = rows.slice(index, index + CHUNK_SIZE)
    const count = await rpc<number>(client, name, { p_actor_user_id: actorId, p_batch_id: batchId, p_rows: chunk })
    if (count !== chunk.length) throw new Error('A stock ingestion chunk was rejected by Supabase.')
    inserted += count
  }
  return inserted
}

async function finishRun(client: SupabaseClient, input: {
  runId: string; status: 'validated' | 'no_change' | 'failed'; batchId?: string | null; checksum?: string | null;
  bookingRows?: number; reorderingRows?: number; error?: string;
}) {
  await rpc(client, 'finish_stock_ingestion_run', {
    p_run_id: input.runId, p_status: input.status, p_import_batch_id: input.batchId || null,
    p_source_checksum: input.checksum || null, p_booking_row_count: input.bookingRows || 0,
    p_reordering_row_count: input.reorderingRows || 0, p_error_message: input.error || '',
  })
}

async function createRunBatch(client: SupabaseClient, input: Record<string, unknown>) {
  try { return await rpc<string>(client, 'service_create_stock_import_batch', input) }
  catch (firstError) {
    try { return await rpc<string>(client, 'service_create_stock_import_batch', input) }
    catch { throw firstError }
  }
}

async function completedRun(client: SupabaseClient, runId: string) {
  const result = await client.from('stock_ingestion_runs')
    .select('status,import_batch_id,booking_row_count,reordering_row_count').eq('id', runId).maybeSingle()
  if (result.error) throw new Error(result.error.message)
  if (result.data?.status !== 'validated' && result.data?.status !== 'no_change') return null
  return {
    status: result.data.status as 'validated' | 'no_change', batchId: result.data.import_batch_id,
    bookingRows: result.data.booking_row_count, reorderingRows: result.data.reordering_row_count,
  }
}

async function runSource(admin: SupabaseClient, source: StockIngestionSource, triggerType: 'manual' | 'scheduled', requestedBy: string | null) {
  const actorId = requestedBy || source.configured_by
  const runId = await rpc<string | null>(admin, 'claim_stock_ingestion_run', {
    p_source_id: source.id, p_trigger_type: triggerType, p_requested_by: requestedBy,
  })
  if (!runId) return { sourceId: source.id, status: 'already_running' as const }
  let batchId: string | null = null
  try {
    const envelope = await fetchStockSource(source)
    const existing = await admin.from('stock_import_batches').select('id,status').eq('source_checksum', envelope.checksum).in('status', ['validated', 'active', 'superseded']).maybeSingle()
    if (existing.error) throw new Error(existing.error.message)
    if (existing.data) {
      await finishRun(admin, { runId, status: 'no_change', batchId: existing.data.id, checksum: envelope.checksum, bookingRows: envelope.bookingRows.length, reorderingRows: envelope.reorderingRows.length })
      return { sourceId: source.id, status: 'no_change' as const, batchId: existing.data.id, bookingRows: envelope.bookingRows.length, reorderingRows: envelope.reorderingRows.length }
    }
    batchId = await createRunBatch(admin, {
      p_actor_user_id: actorId, p_run_id: runId, p_source_type: envelope.sourceType,
      p_source_name: `${source.name} · ${envelope.retrievedAt}`.slice(0, 255), p_source_checksum: envelope.checksum,
    })
    const bookingRows = await appendRows(admin, 'service_append_stock_booking_items', actorId, batchId, envelope.bookingRows)
    const reorderingRows = await appendRows(admin, 'service_append_stock_reordering_items', actorId, batchId, envelope.reorderingRows)
    if (bookingRows !== envelope.bookingRows.length || reorderingRows !== envelope.reorderingRows.length) throw new Error('Supabase row counts do not match the complete Google Sheets extract.')
    const valid = await rpc<boolean>(admin, 'service_validate_and_finish_stock_ingestion', {
      p_actor_user_id: actorId, p_run_id: runId, p_batch_id: batchId, p_source_checksum: envelope.checksum,
      p_booking_row_count: bookingRows, p_reordering_row_count: reorderingRows,
    })
    if (!valid) throw new Error('Supabase rejected the staged Google Sheets import.')
    return { sourceId: source.id, status: 'validated' as const, batchId, bookingRows, reorderingRows }
  } catch (error) {
    const message = safeStockIngestionError(error)
    try {
      const recovered = await completedRun(admin, runId)
      if (recovered) return { sourceId: source.id, ...recovered }
      await finishRun(admin, { runId, status: 'failed', batchId, error: message })
    } catch { /* A later scheduled/manual claim safely expires an interrupted running job. */ }
    throw new Error(message)
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ detail: 'Method not allowed' })
  try {
    const { url, publishableKey, serviceKey } = serverConfig()
    const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const isCron = req.method === 'GET' && Boolean(process.env.CRON_SECRET) && supplied === process.env.CRON_SECRET
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
    if (isCron) {
      const sources = await admin.from('stock_ingestion_sources').select('*').eq('is_active', true).eq('schedule_enabled', true).order('created_at').limit(5)
      if (sources.error) throw new Error(sources.error.message)
      const results = []
      for (const source of (sources.data || []) as StockIngestionSource[]) {
        try { results.push(await runSource(admin, source, 'scheduled', null)) }
        catch (error) { results.push({ sourceId: source.id, status: 'failed', detail: safeStockIngestionError(error) }) }
      }
      return res.status(200).json({ processed: results.length, results })
    }
    if (req.method !== 'POST' || !supplied) return res.status(401).json({ detail: 'Authentication required.' })
    const auth = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${supplied}` } } })
    const user = await auth.auth.getUser(supplied)
    if (user.error || !user.data.user) return res.status(401).json({ detail: 'Invalid or expired session.' })
    const access = await auth.rpc('can_administer_stock_control')
    if (access.error || access.data !== true) return res.status(403).json({ detail: 'Administrator access is required.' })
    const sourceId = String(req.body?.sourceId || '')
    const source = await admin.from('stock_ingestion_sources').select('*').eq('id', sourceId).eq('is_active', true).maybeSingle()
    if (source.error || !source.data) return res.status(404).json({ detail: 'Active stock ingestion source not found.' })
    const result = await runSource(admin, source.data as StockIngestionSource, 'manual', user.data.user.id)
    return res.status(result.status === 'already_running' ? 409 : 200).json(result.status === 'already_running' ? { detail: 'This source is already synchronizing.' } : result)
  } catch (error) {
    return res.status(500).json({ detail: safeStockIngestionError(error) })
  }
}
