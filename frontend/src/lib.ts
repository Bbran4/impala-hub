export type Media = { id: string; name: string; url: string; content_type?: string; size?: number }
export type Campaign = { id: string; name: string; objective: string; start_date?: string | null; end_date?: string | null }
export type Post = {
  id: string
  title: string
  caption: string
  campaign_id: string | null
  channels: string[]
  whatsapp_recipient_type?: string | null
  whatsapp_recipient_id?: string | null
  whatsapp_recipient_name?: string | null
  status: string
  publish_at?: string | null
  published_at?: string | null
  media: Media[]
  last_error?: string | null
  provider_ids?: Record<string, string>
  clicks?: number | null
  reach?: number | null
  impressions?: number | null
  likes?: number | null
  comments?: number | null
  shares?: number | null
  metrics_refreshed_at?: string | null
  created_at?: string
  updated_at?: string
}
export type HistoryEntry = {
  id: number
  action: string
  created_at: string
  details: { status?: string; channels?: string[]; changed?: string[] }
}

// Only these statuses can be fully edited. Scheduled and published posts only allow a campaign change.
export const EDITABLE = ['draft', 'awaiting_approval', 'failed']

export const API = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000'
export const KEY_STORAGE = 'impala_session_token'
export const getKey = () => localStorage.getItem(KEY_STORAGE) || ''

export class AuthError extends Error {}

function describeError(detail: unknown, status: number): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        const field = Array.isArray(d.loc) ? d.loc.filter((p: unknown) => p !== 'body').join('.') : ''
        return field ? `${field}: ${d.msg}` : d.msg
      })
      .join('; ')
  }
  return `Request failed (${status})`
}

export async function api(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers || {})
  headers.set('Authorization', `Bearer ${getKey()}`)
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  let res: Response
  try {
    res = await fetch(`${API}${path}`, { ...options, headers })
  } catch {
    throw new Error(`Cannot reach the Impala Hub API at ${API}. Start the backend and confirm that http://127.0.0.1:8000/api/health opens. If the frontend is on another port or host, check backend CORS settings and VITE_API_URL.`)
  }
  if (res.status === 401) {
    localStorage.removeItem(KEY_STORAGE)
    throw new AuthError('Your session expired or is no longer valid. Sign in again.')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(describeError(body.detail, res.status))
  }
  return res.status === 204 ? null : res.json()
}

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
