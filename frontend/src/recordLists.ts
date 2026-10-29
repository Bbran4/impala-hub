import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAllRows } from './pagedRows.ts'

export function loadMarketingCampaigns(client: SupabaseClient) {
  return loadAllRows((from, to) => client.from('campaigns').select('*', { count: 'exact' })
    .order('updated_at', { ascending: false }).order('id').range(from, to))
}

export function loadRfqList(client: SupabaseClient) {
  return loadAllRows((from, to) => client.from('sales_desk_rfqs')
    .select('*,media_platform:sales_desk_media_platforms(name),status:sales_desk_statuses(name,is_closed),sales_code:sales_desk_sales_codes(code)', { count: 'exact' })
    .is('deleted_at', null).order('received_at', { ascending: false }).order('id').range(from, to))
}
