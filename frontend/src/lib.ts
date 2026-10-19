export type Media = { id: string; name: string; url: string; content_type?: string; size?: number }
export type Campaign = { id: string; name: string; objective: string; start_date?: string | null; end_date?: string | null }
export type Post = {
  id: string
  title: string
  caption: string
  campaign_id: string | null
  channels: string[]
  facebook_groups: string[]
  whatsapp_recipient_type?: string | null
  whatsapp_recipient_id?: string | null
  whatsapp_recipient_name?: string | null
  status: string
  publish_at?: string | null
  published_at?: string | null
  media: Media[]
  last_error?: string | null
  clicks?: number | null
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
export const KEY_STORAGE = 'impala_api_key'
export const getKey = () => sessionStorage.getItem(KEY_STORAGE) || ''

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
  const res = await fetch(`${API}${path}`, { ...options, headers })
  if (res.status === 401) {
    sessionStorage.removeItem(KEY_STORAGE)
    throw new AuthError('The API key was not accepted. Enter it again.')
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

// Shared helpers used by the post editor, board and calendar views.
export const isFuture = (value?: string | null) => !!value && new Date(value).getTime() > Date.now()
export const headingOf = (post: Pick<Post, 'title' | 'caption'>) =>
  post.title?.trim() || post.caption?.trim().slice(0, 110) || 'Untitled post'
