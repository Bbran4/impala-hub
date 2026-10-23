export type Media = { id: string; name: string; url: string; content_type?: string; size?: number }
export type Campaign = { id: string; name: string; objective: string; campaign_type: string; stage: 'new' | 'in_progress' | 'done'; start_date?: string | null; end_date?: string | null }
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
  reactions?: number | null
  saves?: number | null
  views?: number | null
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
import { supabase, supabaseConfigured } from './supabase'
export const KEY_STORAGE = 'impala_session_token'
export const getKey = () => localStorage.getItem(KEY_STORAGE) || ''
async function currentSupabaseToken() {
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    if (data.session?.access_token) {
      localStorage.setItem(KEY_STORAGE, data.session.access_token)
      return data.session.access_token
    }
  }
  return getKey()
}

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
  if (supabaseConfigured && supabase) return supabaseApi(path, options)
  const headers = new Headers(options.headers || {})
  headers.set('Authorization', `Bearer ${getKey()}`)
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  let res: Response | undefined
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      res = await fetch(`${API}${path}`, { ...options, headers })
      break
    } catch {
      if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)))
    }
  }
  if (!res) {
    throw new Error(`Cannot reach the Impala Hub API at ${API}. The request was retried three times. Confirm that http://127.0.0.1:8000/api/health opens and that the backend is not restarting.`)
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

async function supabaseApi(path: string, options: RequestInit) {
  const client = supabase
  if (!client) throw new Error('Supabase is not configured.')
  const method = (options.method || 'GET').toUpperCase()
  const body = options.body && typeof options.body === 'string' ? JSON.parse(options.body) : undefined
  const campaignMatch = path.match(/^\/api\/campaigns\/([^/]+)$/)
  if (path === '/api/campaigns' || campaignMatch) {
    const query = client.from('campaigns')
    if (method === 'GET') {
      const { data, error } = await query.select('*').order('updated_at', { ascending: false })
      if (error) throw new Error(error.message)
      return data || []
    }
    if (method === 'POST') {
      const { data, error } = await query.insert({ ...body, owner_id: (await client.auth.getUser()).data.user?.id }).select().single()
      if (error) throw new Error(error.message)
      return data
    }
    if (method === 'PATCH' && campaignMatch) {
      const { data, error } = await query.update(body).eq('id', campaignMatch[1]).select().single()
      if (error) throw new Error(error.message)
      return data
    }
    if (method === 'DELETE' && campaignMatch) {
      const { error } = await query.delete().eq('id', campaignMatch[1])
      if (error) throw new Error(error.message)
      return null
    }
  }
  if (path === '/api/campaign-types') {
    if (method === 'GET') {
      const { data, error } = await client.from('campaign_types').select('name,position').order('position')
      if (error) throw new Error(error.message)
      return data || []
    }
    if (method === 'POST') {
      const { data, error } = await client.from('campaign_types').insert({ name: body.name, position: 999 }).select().single()
      if (error) throw new Error(error.message)
      return data
    }
  }
  if (path === '/api/campaign-types/order' && method === 'PUT') {
    const names = Array.isArray(body?.names) ? body.names : []
    for (const [position, name] of names.entries()) {
      const { error } = await client.from('campaign_types').update({ position }).eq('name', name)
      if (error) throw new Error(error.message)
    }
    return names.map((name: string, position: number) => ({ name, position }))
  }
  if (path === '/api/media' && method === 'POST' && options.body && typeof (options.body as FormData).get === 'function') {
    const file = (options.body as FormData).get('file')
    if (!file || typeof (file as File).arrayBuffer !== 'function') throw new Error('Select a media file first.')
    const user = (await client.auth.getUser()).data.user
    const uploadFile = file as File
    const objectPath = `${user?.id || 'unknown'}/${crypto.randomUUID()}-${uploadFile.name}`
    const { error } = await client.storage.from('marketing-media').upload(objectPath, uploadFile, { contentType: uploadFile.type || undefined, upsert: false })
    if (error) throw new Error(error.message)
    const { data } = client.storage.from('marketing-media').getPublicUrl(objectPath)
    return { id: objectPath, name: uploadFile.name, url: data.publicUrl, content_type: uploadFile.type, size: uploadFile.size }
  }
  const typeDelete = path.match(/^\/api\/campaign-types\/(.+)$/)
  if (typeDelete && method === 'DELETE') {
    const { error } = await client.from('campaign_types').delete().eq('name', decodeURIComponent(typeDelete[1]))
    if (error) throw new Error(error.message)
    return null
  }
  if (path === '/api/integrations' && method === 'GET') {
    return [{ provider: 'facebook', status: 'not_connected' }, { provider: 'instagram', status: 'not_connected' }]
  }
  if (path === '/api/sales-desk/auth/logout' && method === 'POST') return null
  if (path === '/api/integrations/sync' && method === 'POST') {
    const token = await currentSupabaseToken()
    const response = await fetch('/api/marketing/status', { headers: { Authorization: `Bearer ${token}` } })
    const status = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(status.detail || 'Unable to check the Marketing server status.')
    const providerStatus = status.publishing ? 'connected' : 'not_connected'
    return [
      { provider: 'facebook', status: providerStatus, diagnostic_note: status.message },
      { provider: 'instagram', status: providerStatus, diagnostic_note: status.message },
    ]
  }
  if (path === '/api/integrations/facebook/oauth-url' && method === 'POST') {
    const response = await fetch('/api/marketing/facebook/oauth-url', { method: 'POST', headers: { Authorization: `Bearer ${await currentSupabaseToken()}` } })
    const raw = await response.text()
    let result: { detail?: string } = {}
    try { result = JSON.parse(raw) } catch { /* Vercel may return an HTML deployment error page. */ }
    if (!response.ok) throw new Error(result.detail || `Facebook authorization endpoint failed (${response.status}).${raw ? ` ${raw.slice(0, 160)}` : ''}`)
    if (!result || typeof (result as { url?: unknown }).url !== 'string') throw new Error('Facebook authorization endpoint returned no authorization URL.')
    return result
  }
  if (path === '/api/integrations/facebook/select-page' && method === 'POST') {
    const response = await fetch('/api/marketing/facebook/select-page', { method: 'POST', headers: { Authorization: `Bearer ${await currentSupabaseToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.detail || 'Unable to save the Facebook Page connection.')
    return result
  }
  if (path === '/api/integrations/instagram/oauth-url' && method === 'POST') {
    throw new Error('Instagram OAuth is the next provider migration and is not enabled yet.')
  }
  const postMatch = path.match(/^\/api\/posts\/([^/]+)$/)
  if (path === '/api/posts' || postMatch) {
    if (method === 'GET') {
      const { data, error } = await client.from('posts').select('*').order('updated_at', { ascending: false })
      if (error) throw new Error(error.message)
      return data || []
    }
    if (method === 'POST') {
      const user = (await client.auth.getUser()).data.user
      const { data, error } = await client.from('posts').insert({ ...body, created_by: user?.id }).select().single()
      if (error) throw new Error(error.message)
      return data
    }
    if (method === 'PATCH' && postMatch) {
      const { data, error } = await client.from('posts').update(body).eq('id', postMatch[1]).select().single()
      if (error) throw new Error(error.message)
      return data
    }
    if (method === 'DELETE' && postMatch) {
      const { error } = await client.from('posts').delete().eq('id', postMatch[1])
      if (error) throw new Error(error.message)
      return null
    }
  }
  throw new Error('This Marketing action is not migrated to Supabase yet.')
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
