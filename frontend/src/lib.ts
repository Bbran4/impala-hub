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
export { supabase }
export { supabaseConfigured }
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
    const response = await fetch('/api/marketing/status', { headers: { Authorization: `Bearer ${await currentSupabaseToken()}` } })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.detail || 'Unable to load provider connections.')
    return [
      { provider: 'facebook', ...(result.providers?.facebook || { status: 'not_connected' }) },
      { provider: 'instagram', ...(result.providers?.instagram || { status: 'not_connected' }) },
    ]
  }
  if (path === '/api/sales-desk/auth/logout' && method === 'POST') return null
  if (path === '/api/integrations/sync' && method === 'POST') {
    const token = await currentSupabaseToken()
    const response = await fetch('/api/marketing/facebook/sync', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    const status = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(status.detail || 'Unable to check the Marketing server status.')
    return { facebook: status, instagram: { status: 'not_connected' } }
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
  if (path === '/api/integrations/facebook/pages' && method === 'GET') {
    const response = await fetch('/api/marketing/facebook/pages', { headers: { Authorization: `Bearer ${await currentSupabaseToken()}` } })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.detail || 'Unable to load Facebook Pages.')
    return result
  }
  if (path === '/api/integrations/facebook/check' && method === 'POST') {
    const response = await fetch('/api/marketing/facebook/connection', { method: 'POST', headers: { Authorization: `Bearer ${await currentSupabaseToken()}` } })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.detail || 'Facebook connection check failed.')
    return result
  }
  if (path === '/api/integrations/facebook/disconnect' && method === 'POST') {
    const response = await fetch('/api/marketing/facebook/connection', { method: 'DELETE', headers: { Authorization: `Bearer ${await currentSupabaseToken()}` } })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.detail || 'Facebook disconnect failed.')
    return result
  }
  if (path === '/api/integrations/instagram/oauth-url' && method === 'POST') {
    throw new Error('Instagram OAuth is the next provider migration and is not enabled yet.')
  }
  // Sales Desk RFQ foundation. This deliberately covers the read/create/edit path first;
  // workflow actions and attachments remain on FastAPI until their Supabase equivalents land.
  if (path.startsWith('/api/sales-desk/')) {
    const user = (await client.auth.getUser()).data.user
    if (!user) throw new AuthError('Your session expired or is no longer valid. Sign in again.')
    const profile = await client.from('profiles').select('display_name,active,sales_code').eq('id', user.id).single()
    if (profile.error || !profile.data?.active) throw new Error('Your Impala Hub profile is inactive.')
    const roleRows = await client.from('profile_roles').select('role_id').eq('profile_id', user.id)
    const roleIds = (roleRows.data || []).map((r: any) => r.role_id)
    const role = roleIds.includes('administrator') ? 'administrator' : roleIds.includes('management') ? 'management' : profile.data.sales_code ? 'salesperson' : roleIds.includes('sales') ? 'manager' : 'salesperson'
    const auditRfq = async (rfqId: string, action: string, changes: Record<string, unknown> = {}) => {
      const result = await client.from('sales_desk_rfq_audit').insert({ rfq_id: rfqId, actor_user_id: user.id, action, changes })
      if (result.error) throw new Error(result.error.message)
    }
    if (path === '/api/sales-desk/auth/me' && method === 'GET') return { id: user.id, username: user.email, display_name: profile.data.display_name, role, sales_code: profile.data.sales_code || null, is_active: true }
    if (path === '/api/sales-desk/auth/logout' && method === 'POST') return null
    const attachmentUpload = path.match(/^\/api\/sales-desk\/rfqs\/([^/]+)\/attachments$/)
    if (attachmentUpload && method === 'POST' && options.body && typeof (options.body as FormData).get === 'function') {
      const file = (options.body as FormData).get('file')
      if (!file || typeof (file as File).arrayBuffer !== 'function') throw new Error('Select a file first.')
      const uploadFile = file as File
      if (uploadFile.size > 15 * 1024 * 1024) throw new Error('Maximum attachment size is 15 MB.')
      const pathName = `${user.id}/${attachmentUpload[1]}/${crypto.randomUUID()}-${uploadFile.name}`
      const upload = await client.storage.from('sales-desk-attachments').upload(pathName, uploadFile, { contentType: uploadFile.type || 'application/octet-stream', upsert: false })
      if (upload.error) throw new Error(upload.error.message)
      const row = await client.from('sales_desk_rfq_attachments').insert({ rfq_id: attachmentUpload[1], original_name: uploadFile.name, storage_path: pathName, content_type: uploadFile.type || 'application/octet-stream', size: uploadFile.size, uploaded_by: user.id }).select().single()
      if (row.error) { await client.storage.from('sales-desk-attachments').remove([pathName]); throw new Error(row.error.message) }
      const detail = await client.from('sales_desk_rfqs').select('*,sales_desk_rfq_attachments(*)').eq('id', attachmentUpload[1]).single()
      if (detail.error) throw new Error(detail.error.message)
      return detail.data
    }
    if (path === '/api/sales-desk/auth/users' && method === 'GET') return []
    if (path === '/api/sales-desk/config' && method === 'GET') {
      const [media, statuses, codes] = await Promise.all([
        client.from('sales_desk_media_platforms').select('*').order('sort_order').order('name'),
        client.from('sales_desk_statuses').select('*').order('sort_order').order('name'),
        client.from('sales_desk_sales_codes').select('*').order('code'),
      ])
      for (const result of [media, statuses, codes]) if (result.error) throw new Error(result.error.message)
      const rfqCounts = await client.from('sales_desk_rfqs').select('sales_code_id').is('deleted_at', null)
      if (rfqCounts.error) throw new Error(rfqCounts.error.message)
      const countByCode = new Map<string, number>()
      for (const row of rfqCounts.data || []) if (row.sales_code_id) countByCode.set(row.sales_code_id, (countByCode.get(row.sales_code_id) || 0) + 1)
      const codeValues = (codes.data || []).map((item: any) => item.code)
      const owners = codeValues.length ? await client.rpc('sales_desk_code_owners') : { data: [] as any[], error: null }
      if (owners.error) throw new Error(owners.error.message)
      const ownerByCode = new Map((owners.data || []).map((item: any) => [String(item.sales_code).toUpperCase(), item.display_name]))
      return { media_platforms: (media.data || []).map((item: any) => ({ ...item, is_active: item.is_active !== false })), statuses: (statuses.data || []).map((item: any) => ({ ...item, is_active: item.is_active !== false })), sales_codes: (codes.data || []).map((item: any) => ({ ...item, consultant_name: ownerByCode.get(String(item.code).toUpperCase()) || null, rfq_count: countByCode.get(item.id) || 0 })), can_configure: role === 'administrator' }
    }
    const mediaConfig = path.match(/^\/api\/sales-desk\/config\/media-platforms(?:\/([^/]+))?$/)
    const statusConfig = path.match(/^\/api\/sales-desk\/config\/statuses(?:\/([^/]+))?$/)
    const codeConfig = path.match(/^\/api\/sales-desk\/config\/sales-codes\/([^/]+)$/)
    const configTable = mediaConfig ? 'sales_desk_media_platforms' : statusConfig ? 'sales_desk_statuses' : codeConfig ? 'sales_desk_sales_codes' : ''
    const configId = mediaConfig?.[1] || statusConfig?.[1] || codeConfig?.[1]
    if (configTable && method === 'POST') {
      if (configTable === 'sales_desk_sales_codes') throw new Error('Sales codes are managed from user profiles.')
      const result = await client.from(configTable).insert({ name: body.name, ...(configTable === 'sales_desk_statuses' ? { is_closed: !!body.is_closed } : {}), sort_order: 999 }).select().single()
      if (result.error) throw new Error(result.error.message)
      return result.data
    }
    if (configTable && configId && method === 'PATCH') {
      const result = await client.from(configTable).update(body).eq('id', configId).select().single()
      if (result.error) throw new Error(result.error.message)
      return result.data
    }
    if (configTable && configId && method === 'DELETE') {
      const usedColumn = configTable === 'sales_desk_media_platforms' ? 'media_platform_id' : configTable === 'sales_desk_statuses' ? 'status_id' : 'sales_code_id'
      const used = await client.from('sales_desk_rfqs').select('id', { count: 'exact', head: true }).eq(usedColumn, configId)
      if (used.error) throw new Error(used.error.message)
      if ((used.count || 0) > 0) throw new Error('This option is used by an existing RFQ. Deactivate it instead of deleting it.')
      const result = await client.from(configTable).delete().eq('id', configId)
      if (result.error) throw new Error(result.error.message)
      return { deleted: true }
    }
    const orderConfig = path.match(/^\/api\/sales-desk\/config\/(media-platforms|statuses)\/order$/)
    if (orderConfig && method === 'PUT') {
      const table = orderConfig[1] === 'media-platforms' ? 'sales_desk_media_platforms' : 'sales_desk_statuses'
      for (const [sort_order, id] of (body.ids || []).entries()) {
        const result = await client.from(table).update({ sort_order }).eq('id', id)
        if (result.error) throw new Error(result.error.message)
      }
      return body.ids || []
    }
    const detailMatch = path.match(/^\/api\/sales-desk\/rfqs\/([^/]+)$/)
    if ((path === '/api/sales-desk/rfqs' || path.startsWith('/api/sales-desk/rfqs?')) && method === 'GET' || detailMatch && method === 'GET') {
      const query = client.from('sales_desk_rfqs').select('*,media_platform:sales_desk_media_platforms(name),status:sales_desk_statuses(name,is_closed),sales_code:sales_desk_sales_codes(code)')
      const result = detailMatch ? await query.eq('id', detailMatch[1]).is('deleted_at', null).single() : await query.is('deleted_at', null).order('received_at', { ascending: true }).limit(500)
      if (result.error) throw new Error(result.error.message)
      const normalize = (r: any) => ({ ...r, media_platform: r.media_platform?.name || null, status: r.status?.name || null, status_name: r.status?.name || null, status_is_closed: !!r.status?.is_closed, sales_code: r.sales_code?.code || null })
      if (detailMatch) {
        const history = await client.from('sales_desk_rfq_audit').select('id,action,changes,created_at,actor_user_id').eq('rfq_id', detailMatch[1]).order('id')
        if (history.error) throw new Error(history.error.message)
        const actorIds = [...new Set((history.data || []).map((entry: any) => entry.actor_user_id))]
        const actors = actorIds.length ? await client.from('profiles').select('id,display_name').in('id', actorIds) : { data: [] as any[], error: null }
        if (actors.error) throw new Error(actors.error.message)
        const names = new Map((actors.data || []).map((actor: any) => [actor.id, actor.display_name]))
        const item = normalize(result.data)
        item.audit_history = (history.data || []).map((entry: any) => ({ ...entry, changes: entry.changes || {}, actor_name: names.get(entry.actor_user_id) || entry.actor_user_id }))
        const attachments = await client.from('sales_desk_rfq_attachments').select('id,original_name,storage_path,content_type,size,uploaded_by,created_at').eq('rfq_id', detailMatch[1]).order('created_at')
        if (attachments.error) throw new Error(attachments.error.message)
        const uploaders = [...new Set((attachments.data || []).map((entry: any) => entry.uploaded_by))]
        const uploaderRows = uploaders.length ? await client.from('profiles').select('id,display_name').in('id', uploaders) : { data: [] as any[], error: null }
        if (uploaderRows.error) throw new Error(uploaderRows.error.message)
        const uploaderNames = new Map((uploaderRows.data || []).map((actor: any) => [actor.id, actor.display_name]))
        item.attachments = (attachments.data || []).map((entry: any) => ({ ...entry, uploaded_by_name: uploaderNames.get(entry.uploaded_by) || 'Unknown' }))
        return item
      }
      const items = (result.data || []).map(normalize)
      return { items, total: items.length, limit: 500, offset: 0 }
    }
    if (path === '/api/sales-desk/rfqs' && method === 'POST') {
      if (role !== 'administrator') throw new Error('Only administrators can create RFQs directly.')
      const seq = await client.rpc('next_sales_desk_rfq_number')
      if (seq.error || !seq.data?.[0]) throw new Error(seq.error?.message || 'Unable to allocate an RFQ number.')
      const n = seq.data[0]
      const status = body.status_id || (await client.from('sales_desk_statuses').select('id').ilike('name', 'Unclaimed').eq('is_active', true).single()).data?.id
      const result = await client.from('sales_desk_rfqs').insert({ ...body, rfq_no: n.rfq_no, business_date: n.business_date, daily_number: n.daily_number, status_id: status, created_by: user.id, updated_by: user.id }).select('*,media_platform:sales_desk_media_platforms(name),status:sales_desk_statuses(name,is_closed),sales_code:sales_desk_sales_codes(code)').single()
      if (result.error) throw new Error(result.error.message)
      await auditRfq(result.data.id, 'created', { rfq_no: result.data.rfq_no })
      return { ...result.data, media_platform: result.data.media_platform?.name, status: result.data.status?.name, status_name: result.data.status?.name, status_is_closed: !!result.data.status?.is_closed, sales_code: result.data.sales_code?.code || null }
    }
    if (detailMatch && method === 'PATCH') {
      const before = await client.from('sales_desk_rfqs').select('sales_code_id,sales_desk_sales_codes(code)').eq('id', detailMatch[1]).single()
      if (before.error) throw new Error(before.error.message)
      const result = await client.from('sales_desk_rfqs').update({ ...body, updated_by: user.id }).eq('id', detailMatch[1]).select('*,media_platform:sales_desk_media_platforms(name),status:sales_desk_statuses(name,is_closed),sales_code:sales_desk_sales_codes(code)').single()
      if (result.error) throw new Error(result.error.message)
      if (Object.prototype.hasOwnProperty.call(body, 'sales_code_id')) {
        const previous = before.data.sales_desk_sales_codes?.[0]?.code || null
        const current = result.data.sales_code?.code || null
        await auditRfq(detailMatch[1], current ? (previous ? 'reassigned' : 'assigned') : 'unassigned', { from_sales_code: previous, to_sales_code: current })
      } else {
        await auditRfq(detailMatch[1], 'updated', { changed: Object.keys(body) })
      }
      return { ...result.data, media_platform: result.data.media_platform?.name, status: result.data.status?.name, status_name: result.data.status?.name, status_is_closed: !!result.data.status?.is_closed, sales_code: result.data.sales_code?.code || null }
    }
    if (detailMatch && method === 'DELETE') {
      if (role !== 'administrator' && role !== 'manager') throw new Error('Only managers and administrators can delete RFQs.')
      const result = await client.from('sales_desk_rfqs').update({ deleted_at: new Date().toISOString(), deleted_by: user.id, updated_by: user.id }).eq('id', detailMatch[1]).is('deleted_at', null)
      if (result.error) throw new Error(result.error.message)
      await auditRfq(detailMatch[1], 'deleted', { soft_delete: true })
      return null
    }
    const actionMatch = path.match(/^\/api\/sales-desk\/rfqs\/([^/]+)\/(claim|send-for-approval|convert-to-invoice)$/)
    if (actionMatch && method === 'POST') {
      const id = actionMatch[1]; const action = actionMatch[2]
      const current = await client.from('sales_desk_rfqs').select('*,status:sales_desk_statuses(name,is_closed),sales_code:sales_desk_sales_codes(code)').eq('id', id).single()
      if (current.error) throw new Error(current.error.message)
      if (action === 'claim') {
        if (role !== 'salesperson' || !profile.data.sales_code) throw new Error('Your account is not linked to a sales code.')
        if (current.data.sales_code_id) throw new Error('This RFQ has already been claimed. Refresh the list.')
        const code = await client.from('sales_desk_sales_codes').select('id').eq('code', profile.data.sales_code.toUpperCase()).eq('is_active', true).single()
        if (code.error) throw new Error('Your configured sales code is inactive.')
        const newStatus = await client.from('sales_desk_statuses').select('id').ilike('name', 'New').eq('is_active', true).single()
        const updated = await client.from('sales_desk_rfqs').update({ sales_code_id: code.data.id, claimed_at: new Date().toISOString(), status_id: newStatus.data?.id || current.data.status_id, updated_by: user.id }).eq('id', id).is('sales_code_id', null).select().single()
        if (updated.error) throw new Error(updated.error.message)
        await auditRfq(id, 'claimed', { sales_code: profile.data.sales_code })
      } else if (action === 'send-for-approval') {
        if (!current.data.document_number?.trim()) throw new Error('A document number is required before sending for approval.')
        if (!current.data.status?.is_closed) throw new Error('The RFQ status must be closed before sending for approval.')
        const attachments = await client.from('sales_desk_rfq_attachments').select('id', { count: 'exact', head: true }).eq('rfq_id', id)
        if ((attachments.count || 0) < 1) throw new Error('Add at least one attachment before sending for approval.')
        return { sent: true, notified_admins: 0 }
      } else {
        if (current.data.rfq_type === 'invoice') throw new Error('An invoice cannot be converted to another invoice.')
        if (!current.data.status?.is_closed) throw new Error('Only a closed RFQ can be converted to an invoice.')
        const invoice = await client.rpc('convert_sales_desk_rfq_to_invoice', { source_id: id })
        if (invoice.error) throw new Error(invoice.error.message)
        await auditRfq(id, 'invoice_copy_created', { to_rfq_no: invoice.data.rfq_no })
        await auditRfq(invoice.data.id, 'created_from_quotation', { from_rfq_no: current.data.rfq_no })
        return invoice.data
      }
      const refreshed = await client.from('sales_desk_rfqs').select('*,media_platform:sales_desk_media_platforms(name),status:sales_desk_statuses(name,is_closed),sales_code:sales_desk_sales_codes(code)').eq('id', id).single()
      if (refreshed.error) throw new Error(refreshed.error.message)
      return { ...refreshed.data, media_platform: refreshed.data.media_platform?.name, status: refreshed.data.status?.name, status_name: refreshed.data.status?.name, status_is_closed: !!refreshed.data.status?.is_closed, sales_code: refreshed.data.sales_code?.code || null }
    }
    if (path === '/api/sales-desk/dashboard' && method === 'GET') {
      const all = await client.from('sales_desk_rfqs').select('status_id,sales_code_id,received_at,sales_desk_statuses(name,is_closed),sales_desk_sales_codes(code,display_name)')
      if (all.error) throw new Error(all.error.message)
      const today = new Date().toISOString().slice(0, 10); const rows: any[] = all.data || []
      const [daily, performance] = await Promise.all([
        client.from('sales_desk_daily_sales').select('*').eq('business_date', today).order('gross_sales', { ascending: false }),
        client.from('sales_desk_rfq_performance').select('*').eq('business_date', today).order('sales_person'),
      ])
      if (daily.error) throw new Error(daily.error.message)
      if (performance.error) throw new Error(performance.error.message)
      const performanceRows = (performance.data || []).map((saved: any) => {
        const mine = rows.filter((row) => row.sales_desk_sales_codes?.code === saved.sales_person)
        const named = mine.length ? mine : rows.filter((row) => row.sales_desk_sales_codes?.display_name === saved.sales_person)
        const status = (row: any) => String(row.sales_desk_statuses?.name || '').toLowerCase()
        return { ...saved, in_progress: named.filter((row) => status(row).includes('progress')).length, complete: named.filter((row) => status(row).includes('complete') || status(row).includes('quotation')).length, dropped: named.filter((row) => status(row).includes('drop')).length, scrapped: named.filter((row) => status(row).includes('scrap')).length, irrelevant: named.filter((row) => status(row).includes('irrelevant')).length, total: named.length }
      })
      return { unclaimed: rows.filter((r) => !r.sales_code_id).length, claimed: rows.filter((r) => !!r.sales_code_id).length, received_today: rows.filter((r) => String(r.received_at).slice(0, 10) === today).length, open: rows.filter((r) => !r.sales_desk_statuses?.is_closed).length, daily_sales: daily.data || [], rfq_performance: performanceRows }
    }
    if (path.startsWith('/api/sales-desk/analytics') && method === 'GET') {
      const result = await client.from('sales_desk_rfqs').select('rfq_type,status_id,created_at,sales_desk_statuses(name,is_closed)')
      if (result.error) throw new Error(result.error.message)
      const rows: any[] = result.data || []
      const totals = {
        claimed: rows.filter((r) => !!r.status_id).length,
        scrapped: rows.filter((r) => String(r.sales_desk_statuses?.name || '').toLowerCase().includes('scrap')).length,
        dropped: rows.filter((r) => String(r.sales_desk_statuses?.name || '').toLowerCase().includes('drop')).length,
        completed: rows.filter((r) => !!r.sales_desk_statuses?.is_closed && r.rfq_type === 'quotation').length,
        invoiced: rows.filter((r) => r.rfq_type === 'invoice').length,
      }
      const params = new URLSearchParams(path.split('?')[1] || '')
      const period = params.get('period') || 'year'
      const month = Number(params.get('month') || new Date().getMonth() + 1)
      const year = new Date().getFullYear()
      const filtered = rows.filter((row) => {
        const date = new Date(row.created_at)
        if (Number.isNaN(date.getTime()) || date.getFullYear() !== year) return false
        if (period === 'month') return date.getMonth() + 1 === month
        if (period === 'week') return Math.ceil((date.getDay() + 1 + Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 1).getTime()) / 86400000)) / 7) === Number(params.get('week') || 1)
        return true
      })
      const groups = new Map<string, any>()
      for (const row of filtered) {
        const date = new Date(row.created_at)
        const label = period === 'year' ? date.toLocaleString(undefined, { month: 'short' }) : date.toLocaleDateString()
        const point = groups.get(label) || { label, claimed: 0, scrapped: 0, dropped: 0, completed: 0, invoiced: 0 }
        const name = String(row.sales_desk_statuses?.name || '').toLowerCase()
        if (row.status_id) point.claimed += 1
        if (name.includes('scrap')) point.scrapped += 1
        if (name.includes('drop')) point.dropped += 1
        if (row.sales_desk_statuses?.is_closed && row.rfq_type === 'quotation') point.completed += 1
        if (row.rfq_type === 'invoice') point.invoiced += 1
        groups.set(label, point)
      }
      return { totals, series: [...groups.values()] }
    }
  }
  if (path === '/api/returns-claims' || path.startsWith('/api/returns-claims/')) {
    const match = path.match(/^\/api\/returns-claims\/([^/]+)$/)
    const currentUser = (await client.auth.getUser()).data.user
    if (!currentUser) throw new AuthError('Your session expired or is no longer valid. Sign in again.')
    const allowed = (await client.from('profile_roles').select('role_id').eq('profile_id', currentUser.id)).data || []
    if (!allowed.some((r: any) => ['administrator', 'management', 'returns'].includes(r.role_id))) throw new Error('You do not have access to Returns & Claims.')
    const attachmentMatch = path.match(/^\/api\/returns-claims\/([^/]+)\/attachments$/)
    if (attachmentMatch && method === 'POST' && options.body && typeof (options.body as FormData).get === 'function') {
      const file = (options.body as FormData).get('file') as File | null
      if (!file || typeof file.arrayBuffer !== 'function') throw new Error('Select a file first.')
      if (file.size > 15 * 1024 * 1024) throw new Error('Maximum attachment size is 15 MB.')
      const storagePath = `${currentUser.id}/${attachmentMatch[1]}/${crypto.randomUUID()}-${file.name}`
      const upload = await client.storage.from('returns-claim-attachments').upload(storagePath, file, { contentType: file.type || 'application/octet-stream' })
      if (upload.error) throw new Error(upload.error.message)
      const row = await client.from('returns_claim_attachments').insert({ claim_id: attachmentMatch[1], original_name: file.name, storage_path: storagePath, content_type: file.type || 'application/octet-stream', size: file.size, uploaded_by: currentUser.id }).select().single()
      if (row.error) { await client.storage.from('returns-claim-attachments').remove([storagePath]); throw new Error(row.error.message) }
      return row.data
    }
    if (method === 'GET') {
      const result = match ? await client.from('returns_claims').select('*').is('deleted_at', null).eq('id', match[1]).single() : await client.from('returns_claims').select('*').is('deleted_at', null).order('date', { ascending: false }).order('created_at', { ascending: false })
      if (result.error) throw new Error(result.error.message)
      return match ? result.data : result.data || []
    }
    if (method === 'POST') {
      const result = await client.from('returns_claims').insert({ ...body, created_by: currentUser.id, updated_by: currentUser.id }).select().single()
      if (result.error) throw new Error(result.error.message)
      const audit = await client.from('returns_claims_audit').insert({ claim_id: result.data.id, actor_user_id: currentUser.id, action: 'created', changes: { status: result.data.status } })
      if (audit.error) throw new Error(audit.error.message)
      return result.data
    }
    if (match && method === 'PATCH') {
      const result = await client.from('returns_claims').update({ ...body, updated_by: currentUser.id }).eq('id', match[1]).select().single()
      if (result.error) throw new Error(result.error.message)
      const audit = await client.from('returns_claims_audit').insert({ claim_id: match[1], actor_user_id: currentUser.id, action: 'updated', changes: { changed: Object.keys(body) } })
      if (audit.error) throw new Error(audit.error.message)
      return result.data
    }
    if (match && method === 'DELETE') {
      const result = await client.from('returns_claims').update({ deleted_at: new Date().toISOString(), deleted_by: currentUser.id, updated_by: currentUser.id }).eq('id', match[1]).is('deleted_at', null)
      if (result.error) throw new Error(result.error.message)
      const audit = await client.from('returns_claims_audit').insert({ claim_id: match[1], actor_user_id: currentUser.id, action: 'deleted', changes: {} })
      if (audit.error) throw new Error(audit.error.message)
      return null
    }
  }
  const postMatch = path.match(/^\/api\/posts\/([^/]+)$/)
  const postHistoryMatch = path.match(/^\/api\/posts\/([^/]+)\/history$/)
  if (postHistoryMatch && method === 'GET') {
    const { data, error } = await client.from('audit_log').select('id,action,details,created_at').eq('entity_type', 'post').eq('entity_id', postHistoryMatch[1]).order('id', { ascending: false })
    if (error) throw new Error(error.message)
    return (data || []).map((entry: any) => ({ id: entry.id, action: entry.action, details: entry.details || {}, created_at: entry.created_at }))
  }
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
  const publishMatch = path.match(/^\/api\/posts\/([^/]+)\/publish-now$/)
  if (publishMatch && method === 'POST') {
    const response = await fetch(`/api/marketing/facebook/publish?post_id=${encodeURIComponent(publishMatch[1])}`, { method: 'POST', headers: { Authorization: `Bearer ${await currentSupabaseToken()}` } })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.detail || 'Facebook publishing failed.')
    return result
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
