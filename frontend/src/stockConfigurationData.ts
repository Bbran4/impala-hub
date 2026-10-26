import type { SupabaseClient } from '@supabase/supabase-js'
import { loadStockAccess } from './stockPartsQueries.ts'

export type StockLocation = {
  id: string
  name: string
  description: string
  vehicle_name: string
  supply_branch: '' | 'er' | 'pta'
  color: string
  is_active: boolean
}

export type StockSettings = { slow_max_avg_sales: number; ab_min_avg_sales: number }
export type StockDevelopmentStatus = { name: string; sort_order: number; is_active: boolean }

export function prepareStockLocation(form: Record<string, unknown>) {
  const name = String(form.name || '').trim()
  const description = String(form.description || '').trim()
  const vehicleName = String(form.vehicle_name || '').trim()
  const supplyBranch = String(form.supply_branch || '').trim().toLowerCase()
  const color = String(form.color || '').trim().toLowerCase()
  if (!name || name.length > 80) throw new Error('Location name must be between 1 and 80 characters.')
  if (!['', 'er', 'pta'].includes(supplyBranch)) throw new Error('Choose a valid supply branch mapping.')
  if (!/^#[0-9a-f]{6}$/.test(color)) throw new Error('Choose a valid six-digit highlight color.')
  return { name, description, vehicle_name: vehicleName, supply_branch: supplyBranch as '' | 'er' | 'pta', color }
}

export function prepareStockThresholds(slowMax: unknown, abMin: unknown): StockSettings {
  const slow = Number(slowMax)
  const ab = Number(abMin)
  if (!Number.isFinite(slow) || slow < 0) throw new Error('Slow-mover threshold must be zero or greater.')
  if (!Number.isFinite(ab) || ab < 0) throw new Error('A&B-mover threshold must be zero or greater.')
  if (ab < slow) throw new Error('A&B-mover threshold cannot be lower than the slow-mover threshold.')
  return { slow_max_avg_sales: slow, ab_min_avg_sales: ab }
}

export async function loadStockConfiguration(client: SupabaseClient) {
  const [locations, settings, statuses, access] = await Promise.all([
    client.from('stock_locations').select('id,name,description,vehicle_name,supply_branch,color,is_active').order('name'),
    client.from('stock_settings').select('slow_max_avg_sales,ab_min_avg_sales').eq('singleton', true).single(),
    client.from('stock_development_statuses').select('name,sort_order,is_active').order('sort_order').order('name'),
    loadStockAccess(client),
  ])
  for (const result of [locations, settings, statuses]) if (result.error) throw new Error(result.error.message)
  return {
    locations: (locations.data || []) as StockLocation[],
    settings: settings.data as StockSettings,
    statuses: (statuses.data || []) as StockDevelopmentStatus[],
    access,
  }
}

async function rpc<T>(client: SupabaseClient, name: string, params: Record<string, unknown>) {
  const result = await client.rpc(name, params)
  if (result.error) throw new Error(result.error.message)
  return result.data as T
}

export async function saveStockLocation(client: SupabaseClient, locationId: string | null, form: Record<string, unknown>) {
  const value = prepareStockLocation(form)
  return rpc<string>(client, 'save_stock_location', {
    p_location_id: locationId,
    p_name: value.name,
    p_description: value.description,
    p_vehicle_name: value.vehicle_name,
    p_supply_branch: value.supply_branch,
    p_color: value.color,
  })
}

export const setStockLocationActive = (client: SupabaseClient, id: string, active: boolean) =>
  rpc<string>(client, 'set_stock_location_active', { p_location_id: id, p_active: active })
export const deleteStockLocation = (client: SupabaseClient, id: string) =>
  rpc<string>(client, 'delete_stock_location', { p_location_id: id })
export async function saveStockThresholds(client: SupabaseClient, slowMax: unknown, abMin: unknown) {
  const value = prepareStockThresholds(slowMax, abMin)
  return rpc<boolean>(client, 'save_stock_thresholds', { p_slow_max: value.slow_max_avg_sales, p_ab_min: value.ab_min_avg_sales })
}
export const createStockDevelopmentStatus = (client: SupabaseClient, name: string) => {
  const value = name.trim()
  if (!value || value.length > 80) throw new Error('Development Status must be between 1 and 80 characters.')
  return rpc<string>(client, 'create_stock_development_status', { p_name: value })
}
export const setStockDevelopmentStatusActive = (client: SupabaseClient, name: string, active: boolean) =>
  rpc<string>(client, 'set_stock_development_status_active', { p_name: name, p_active: active })
export const deleteStockDevelopmentStatus = (client: SupabaseClient, name: string) =>
  rpc<string>(client, 'delete_stock_development_status', { p_name: name })
