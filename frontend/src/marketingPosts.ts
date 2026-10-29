import type { SupabaseClient } from '@supabase/supabase-js'
export const POST_PAGE_SIZE = 50
export type PostFilters = { month?: string | null; campaign?: string; search?: string; status?: string; channel?: string; offset?: number; limit?: number; preview?: boolean; summary?: boolean }
export async function loadPostPage(client: SupabaseClient, filters: PostFilters = {}) {
  const { data, error } = await client.rpc('marketing_post_page', {
    p_month: filters.month || null, p_campaign: filters.campaign && !['all','none'].includes(filters.campaign) ? filters.campaign : null,
    p_unassigned: filters.campaign === 'none', p_search: (filters.search || '').trim(),
    p_status: !filters.status || filters.status === 'all' ? null : filters.status === 'engagements' ? 'published' : filters.status,
    p_channel: filters.channel || null, p_offset: filters.offset || 0, p_limit: filters.limit || POST_PAGE_SIZE,
    p_preview: !!filters.preview, p_summary: !!filters.summary,
  })
  if (error) throw new Error(error.message)
  return data as { items: any[]; total: number; offset: number; limit: number; summary: any[] }
}

export function safeMarketingFilename(name: string) {
  const base = name.normalize('NFKC').split(/[\\/]/).pop() || 'image'
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0,100) || 'image'
}
