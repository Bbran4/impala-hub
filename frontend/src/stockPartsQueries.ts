import type { SupabaseClient } from '@supabase/supabase-js'

export const STOCK_QUERY_STATUSES = ['In Progress', 'Submitted', 'Cancelled'] as const

export type StockSupplier = {
  id?: string
  supplier: string
  qty: number | string
  cost: number | string | null
  msrp: number | string | null
  notes: string
}

export type StockPartsQuery = {
  id: string
  reference: string
  legacy_id?: string | null
  created_at: string
  part_number: string
  description: string
  qty: number
  sales_code_id?: string | null
  sales_code?: string | null
  development_status: string
  status: string
  suppliers: StockSupplier[]
}

export type StockQueryPayload = {
  part_number: string
  description: string
  qty: number
  sales_code_id: string | null
  development_status: string
  status: string
  suppliers: Array<{
    id?: string
    supplier: string
    qty: number
    cost: number | null
    msrp: number | null
    notes: string
  }>
}

export type StockAccess = { canEdit: boolean; isAdmin: boolean }
export type StockHistoryEntry = { id: number; action: string; changes: Record<string, unknown>; created_at: string; actor_user_id: string; actor_name: string }

function optionalMoney(value: unknown, label: string) {
  if (value === '' || value == null) return null
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`${label} must be zero or greater.`)
  return amount
}

export function prepareStockQueryPayload(form: Record<string, any>): StockQueryPayload {
  const partNumber = String(form.part_number || '').trim()
  const description = String(form.description || '').trim()
  const developmentStatus = String(form.development_status || '').trim()
  const qty = Number(form.qty)
  const status = String(form.status || '')
  if (!partNumber) throw new Error('Enter a part number.')
  if (!description) throw new Error('Enter a description.')
  if (!Number.isInteger(qty) || qty < 1 || qty > 1000000) throw new Error('Quantity must be a whole number between 1 and 1,000,000.')
  if (!developmentStatus) throw new Error('Choose a Development Status.')
  if (!STOCK_QUERY_STATUSES.includes(status as (typeof STOCK_QUERY_STATUSES)[number])) throw new Error('Choose a valid Parts Query status.')

  const suppliers = (Array.isArray(form.suppliers) ? form.suppliers : [])
    .filter((supplier: StockSupplier) => String(supplier.supplier || '').trim())
    .map((supplier: StockSupplier) => {
      const supplierQty = Number(supplier.qty)
      if (!Number.isInteger(supplierQty) || supplierQty < 1 || supplierQty > 1000000) throw new Error(`Quantity for ${String(supplier.supplier).trim()} must be a whole number between 1 and 1,000,000.`)
      return {
        ...(supplier.id ? { id: supplier.id } : {}),
        supplier: String(supplier.supplier).trim(),
        qty: supplierQty,
        cost: optionalMoney(supplier.cost, 'Supplier cost'),
        msrp: optionalMoney(supplier.msrp, 'Supplier MSRP'),
        notes: String(supplier.notes || '').trim(),
      }
    })

  return {
    part_number: partNumber,
    description,
    qty,
    sales_code_id: form.sales_code_id || null,
    development_status: developmentStatus,
    status,
    suppliers,
  }
}

export function stockSupplierUnitCost(supplier: Pick<StockSupplier, 'cost' | 'qty'>) {
  if (supplier.cost === '' || supplier.cost == null) return null
  const cost = Number(supplier.cost)
  const qty = Number(supplier.qty)
  return Number.isFinite(cost) && Number.isFinite(qty) && qty > 0 ? cost / qty : null
}

export function matchesStockQuery(query: StockPartsQuery, search: string) {
  const needle = search.trim().toLowerCase()
  if (!needle) return true
  return [query.reference, query.legacy_id || '', query.part_number, query.description, query.sales_code || '', query.development_status, query.status,
    ...query.suppliers.flatMap((supplier) => [supplier.supplier, supplier.notes])].join(' ').toLowerCase().includes(needle)
}

export async function loadStockAccess(client: SupabaseClient): Promise<StockAccess> {
  const user = (await client.auth.getUser()).data.user
  if (!user) throw new Error('Your session has expired. Sign in again.')
  const roles = await client.from('profile_roles').select('role_id').eq('profile_id', user.id)
  if (roles.error) throw new Error(roles.error.message)
  const roleIds = (roles.data || []).map((row: any) => row.role_id)
  return { isAdmin: roleIds.includes('administrator'), canEdit: roleIds.includes('administrator') || roleIds.includes('stock') }
}

export async function loadStockPartsQueryWorkspace(client: SupabaseClient) {
  const [queries, statuses, salesCodes, access] = await Promise.all([
    client.from('stock_parts_queries').select('id,reference,legacy_id,created_at,part_number,description,qty,sales_code_id,development_status,status,sales_code:sales_desk_sales_codes(code),suppliers:stock_parts_query_suppliers(id,supplier,qty,cost,msrp,notes,created_at)').is('deleted_at', null).order('created_at', { ascending: false }),
    client.from('stock_development_statuses').select('name').eq('is_active', true).order('sort_order').order('name'),
    client.from('sales_desk_sales_codes').select('id,code,display_name,is_active').eq('is_active', true).order('code'),
    loadStockAccess(client),
  ])
  for (const result of [queries, statuses, salesCodes]) if (result.error) throw new Error(result.error.message)
  const normalized = (queries.data || []).map((row: any) => ({
    ...row,
    sales_code: Array.isArray(row.sales_code) ? row.sales_code[0]?.code || null : row.sales_code?.code || null,
    suppliers: [...(row.suppliers || [])].sort((a: any, b: any) => String(a.created_at || '').localeCompare(String(b.created_at || ''))),
  })) as StockPartsQuery[]
  return { queries: normalized, statuses: (statuses.data || []).map((row: any) => row.name as string), salesCodes: salesCodes.data || [], access }
}

export async function createStockPartsQuery(client: SupabaseClient, form: Record<string, any>) {
  const payload = prepareStockQueryPayload(form)
  const result = await client.rpc('create_stock_parts_query', {
    p_part_number: payload.part_number,
    p_description: payload.description,
    p_qty: payload.qty,
    p_sales_code_id: payload.sales_code_id,
    p_development_status: payload.development_status,
    p_status: payload.status,
    p_suppliers: payload.suppliers,
  })
  if (result.error) throw new Error(result.error.message)
  return result.data as string
}

export async function updateStockPartsQuery(client: SupabaseClient, queryId: string, form: Record<string, any>) {
  const payload = prepareStockQueryPayload(form)
  const result = await client.rpc('update_stock_parts_query', {
    p_query_id: queryId,
    p_part_number: payload.part_number,
    p_description: payload.description,
    p_qty: payload.qty,
    p_sales_code_id: payload.sales_code_id,
    p_development_status: payload.development_status,
    p_status: payload.status,
    p_suppliers: payload.suppliers,
  })
  if (result.error) throw new Error(result.error.message)
  return result.data as string
}

export async function archiveStockPartsQuery(client: SupabaseClient, queryId: string) {
  const result = await client.rpc('archive_stock_parts_query', { p_query_id: queryId })
  if (result.error) throw new Error(result.error.message)
}

export async function createStockDevelopmentStatus(client: SupabaseClient, name: string) {
  const result = await client.from('stock_development_statuses').insert({ name: name.trim(), sort_order: 999 }).select('name').single()
  if (result.error) throw new Error(result.error.message)
  return result.data.name as string
}

export async function loadStockPartsQueryHistory(client: SupabaseClient, queryId: string) {
  const result = await client.rpc('stock_parts_query_history', { target_query_id: queryId })
  if (result.error) throw new Error(result.error.message)
  return (result.data || []) as StockHistoryEntry[]
}
