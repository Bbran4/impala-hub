export type { Media, Campaign, Post, HistoryEntry } from './marketingTypes'
import type { Media, Post } from './marketingTypes'
import { API } from './serviceTransport'
export { API, KEY_STORAGE, getKey, AuthError } from './serviceTransport'
export { supabase, supabaseConfigured } from './supabase'
// Only these statuses can be fully edited. Scheduled and published posts only allow a campaign change.
export const EDITABLE = ['draft', 'awaiting_approval', 'failed']

export const mediaSrc = (m: Media) => (m.url.startsWith('http') ? m.url : `${API}${m.url}`)
export const metric = (v?: number | null) => (v == null ? '—' : String(v))
export const fmt = (v?: string | null, empty = 'Not scheduled') => (v ? new Date(v).toLocaleString() : empty)

export const isFuture = (v?: string | null) => !!v && new Date(v) > new Date()
export const headingOf = (p: Post) => p.title?.trim() || p.caption?.trim().slice(0, 110) || 'Untitled post'

// ---- month filtering, shared by the list, board and calendar views
// A post belongs to the month of when it was published, else when it is planned, else when it was created.
export const postStamp = (p: Post) => p.published_at || p.publish_at || p.created_at || null
export const startOfMonth = (d: Date = new Date()) => new Date(d.getFullYear(), d.getMonth(), 1)
export const inMonth = (p: Post, month: Date) => {
  const stamp = postStamp(p)
  if (!stamp) return false
  const d = new Date(stamp)
  return d.getFullYear() === month.getFullYear() && d.getMonth() === month.getMonth()
}
