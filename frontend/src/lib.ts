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
  media_count?: number
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
  details: { actor_name?: string; status?: string; channels?: string[]; changed?: string[] }
}

// Only these statuses can be fully edited. Scheduled and published posts only allow a campaign change.
export const EDITABLE = ['draft', 'awaiting_approval', 'failed']

export const API = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000'
import { supabase, supabaseConfigured } from './supabase'
import { createSalesDeskSessionCache } from './salesDeskSession.ts'
import { loadPostPage, safeMarketingFilename } from './marketingPosts.ts'
import { readMarketingResponse } from './marketingResponse.ts'
import { loadMarketingCampaigns, loadRfqList } from './recordLists.ts'
import { AuthError, readSupabaseToken } from './sessionToken.ts'
export { AuthError } from './sessionToken.ts'
import { claimFileType } from './returnsAttachments'
import { deleteRecordAttachment } from './recordAttachments'
import { supplierWorkflowFields, prepareSupplierWorkflow } from './returnsWorkflow'
export { supabase }
export { supabaseConfigured }
export const KEY_STORAGE = 'impala_session_token'
// Remove tokens persisted by older releases; sessions are tab-scoped.
try { localStorage.removeItem(KEY_STORAGE) } catch { /* Storage may be unavailable. */ }
export const getKey = () => sessionStorage.getItem(KEY_STORAGE) || ''
const currentSupabaseToken = () => readSupabaseToken(supabase)
const salesDeskSession = supabase ? createSalesDeskSessionCache(supabase) : null
supabase?.auth.onAuthStateChange((event, session) => salesDeskSession?.authChanged(event, session))


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
    sessionStorage.removeItem(KEY_STORAGE)
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
      const { data } = await loadMarketingCampaigns(client)
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
    const { error } = await client.rpc('admin_reorder_campaign_types', { p_names: names })
    if (error) throw new Error(error.message)
    return names.map((name: string, position: number) => ({ name, position }))
  }
  if (path === '/api/media' && method === 'POST' && options.body && typeof (options.body as FormData).get === 'function') {
    const file = (options.body as FormData).get('file')
    if (!file || typeof (file as File).arrayBuffer !== 'function') throw new Error('Select a media file first.')
    const user = (await client.auth.getUser()).data.user
    const uploadFile = file as File
    const objectPath = `${user?.id || 'unknown'}/${crypto.randomUUID()}-${safeMarketingFilename(uploadFile.name)}`
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
    const status = await readMarketingResponse(response, 'Facebook refresh')
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
  // Transactional commands own Sales Desk business rules and audit attribution.
  if (path.startsWith('/api/sales-desk/')) {
    const { data: { session } } = await client.auth.getSession()
    const user = session?.user
    if (!user) throw new AuthError('Your session expired or is no longer valid. Sign in again.')
    if (path === '/api/sales-desk/auth/me' && method === 'GET') return salesDeskSession!.get()
    if (path === '/api/sales-desk/auth/logout' && method === 'POST') return null
    const attachmentUpload = path.match(/^\/api\/sales-desk\/rfqs\/([^/]+)\/attachments$/)
    const attachmentDelete = path.match(/^\/api\/sales-desk\/rfqs\/([^/]+)\/attachments\/([^/]+)$/)
    if (attachmentDelete && method === 'DELETE') {
      await deleteRecordAttachment(client, 'rfq', attachmentDelete[1], attachmentDelete[2])
      return null
    }
    if (attachmentUpload && method === 'POST' && options.body && typeof (options.body as FormData).get === 'function') {
      const file = (options.body as FormData).get('file')
      if (!file || typeof (file as File).arrayBuffer !== 'function') throw new Error('Select a file first.')
      const uploadFile = file as File
      if (uploadFile.size > 15 * 1024 * 1024) throw new Error('Maximum attachment size is 15 MB.')
      const pathName = `${user.id}/${attachmentUpload[1]}/${crypto.randomUUID()}-${safeMarketingFilename(uploadFile.name)}`
      const upload = await client.storage.from('sales-desk-attachments').upload(pathName, uploadFile, { contentType: uploadFile.type || 'application/octet-stream', upsert: false })
      if (upload.error) throw new Error(upload.error.message)
      const row = await client.from('sales_desk_rfq_attachments').insert({ rfq_id: attachmentUpload[1], original_name: uploadFile.name, storage_path: pathName, content_type: uploadFile.type || 'application/octet-stream', size: uploadFile.size, uploaded_by: user.id }).select().single()
      if (row.error) { await client.storage.from('sales-desk-attachments').remove([pathName]); throw new Error(row.error.message) }
      const detail = await client.from('sales_desk_rfqs').select('*,attachments:sales_desk_rfq_attachments(*)').eq('id', attachmentUpload[1]).single()
      if (detail.error) throw new Error(detail.error.message)
      return detail.data
    }
    if (path === '/api/sales-desk/auth/users' && method === 'GET') return []
    if (path === '/api/sales-desk/config' && method === 'GET') {
      const result = await client.rpc('sales_desk_configuration')
      if (result.error) throw new Error(result.error.message)
      return result.data
    }
    const mediaConfig = path.match(/^\/api\/sales-desk\/config\/media-platforms(?:\/([^/]+))?$/)
    const statusConfig = path.match(/^\/api\/sales-desk\/config\/statuses(?:\/([^/]+))?$/)
    const codeConfig = path.match(/^\/api\/sales-desk\/config\/sales-codes\/([^/]+)$/)
    const configTable = mediaConfig ? 'sales_desk_media_platforms' : statusConfig ? 'sales_desk_statuses' : codeConfig ? 'sales_desk_sales_codes' : ''
    const configId = mediaConfig?.[1] || statusConfig?.[1] || codeConfig?.[1]
    if (configTable && method === 'POST') {
      if (configTable === 'sales_desk_sales_codes') throw new Error('Sales codes are managed from user profiles.')
      const result = await client.from(configTable).insert({ name: body.name, ...(configTable === 'sales_desk_statuses' ? { is_closed: !!body.is_closed, metric_category: body.metric_category || 'other' } : {}), sort_order: 999 }).select().single()
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
      const result = await client.rpc('reorder_sales_desk_config', { p_kind: orderConfig[1], p_ids: body.ids || [] })
      if (result.error) throw new Error(result.error.message)
      return result.data
    }
    const detailMatch = path.match(/^\/api\/sales-desk\/rfqs\/([^/]+)$/)
    if ((path === '/api/sales-desk/rfqs' || path.startsWith('/api/sales-desk/rfqs?')) && method === 'GET' || detailMatch && method === 'GET') {
      const query = client.from('sales_desk_rfqs').select('*,media_platform:sales_desk_media_platforms(name),status:sales_desk_statuses(name,is_closed),sales_code:sales_desk_sales_codes(code)')
      const result = detailMatch ? await query.eq('id', detailMatch[1]).is('deleted_at', null).single() : await loadRfqList(client)
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
        item.audit_history = (history.data || []).map((entry: any) => ({ ...entry, changes: entry.changes || {}, actor_name: entry.changes?.actor_name || names.get(entry.actor_user_id) || entry.actor_user_id }))
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
      return { items, total: result.count, limit: items.length, offset: 0 }
    }
    if (path === '/api/sales-desk/rfqs' && method === 'POST') {
      const result = await client.rpc('create_sales_desk_rfq', { p_values: body })
      if (result.error) throw new Error(result.error.message)
      return result.data
    }
    if (detailMatch && method === 'PATCH') {
      const result = await client.rpc('update_sales_desk_rfq', { p_id: detailMatch[1], p_values: body })
      if (result.error) throw new Error(result.error.message)
      return result.data
    }
    if (detailMatch && method === 'DELETE') {
      const result = await client.rpc('archive_sales_desk_rfq', { p_id: detailMatch[1] })
      if (result.error) throw new Error(result.error.message)
      return null
    }
    const actionMatch = path.match(/^\/api\/sales-desk\/rfqs\/([^/]+)\/(claim|send-for-approval|convert-to-invoice)$/)
    if (actionMatch && method === 'POST') {
      const id = actionMatch[1]; const action = actionMatch[2]
      if (action === 'claim') {
        const result = await client.rpc('claim_sales_desk_rfq', { p_id: id })
        if (result.error) throw new Error(result.error.message)
        return result.data
      }
      if (action === 'convert-to-invoice') {
        const result = await client.rpc('convert_sales_desk_rfq_to_invoice', { source_id: id }).single()
        if (result.error) throw new Error(result.error.message)
        return result.data
      }
      // Approval decisions/notifications remain a separate roadmap item.
      throw new Error('Approval requests are not enabled yet. No approval request has been sent.')
    }
    if (path === '/api/sales-desk/dashboard' && method === 'GET') {
      const result = await client.rpc('sales_desk_dashboard')
      if (result.error) throw new Error(result.error.message)
      return result.data
    }
    if (path.startsWith('/api/sales-desk/analytics') && method === 'GET') {
      const params = new URLSearchParams(path.split('?')[1] || '')
      const result = await client.rpc('sales_desk_analytics', {
        p_period: params.get('period') || 'year',
        p_year: params.has('year') ? Number(params.get('year')) : null,
        p_month: Number(params.get('month') || 1),
        p_week: Number(params.get('week') || 1),
      })
      if (result.error) throw new Error(result.error.message)
      return result.data
    }
  }
  if (path === '/api/returns-claims' || path.startsWith('/api/returns-claims/')) {
    const match = path.match(/^\/api\/returns-claims\/([^/]+)$/)
    const currentUser = (await client.auth.getUser()).data.user
    if (!currentUser) throw new AuthError('Your session expired or is no longer valid. Sign in again.')
    const allowed = (await client.from('profile_roles').select('role_id').eq('profile_id', currentUser.id)).data || []
    if (!allowed.some((r: any) => ['administrator', 'management', 'returns'].includes(r.role_id))) throw new Error('You do not have access to Returns & Claims.')
    const fields = ['date','company','rfc_book_number','customer','contact_person','contact_number','invoice_number','invoice_date','reason','part_number','description','qty','outcome_request','returned_by','received_by','supplier_received','comments','status','sla_days','status_change_reason', ...supplierWorkflowFields]
    const claimBody = Object.fromEntries(fields.filter(field => body && Object.prototype.hasOwnProperty.call(body, field)).map(field => [field, body[field]]))
    if (body) Object.assign(claimBody, prepareSupplierWorkflow(body))
    const attachmentDelete = path.match(/^\/api\/returns-claims\/([^/]+)\/attachments\/([^/]+)$/)
    if (attachmentDelete && method === 'DELETE') {
      await deleteRecordAttachment(client, 'return', attachmentDelete[1], attachmentDelete[2])
      return null
    }
    const attachmentMatch = path.match(/^\/api\/returns-claims\/([^/]+)\/attachments$/)
    if (attachmentMatch && method === 'POST' && options.body && typeof (options.body as FormData).get === 'function') {
      const file = (options.body as FormData).get('file') as File | null
      if (!file || typeof file.arrayBuffer !== 'function') throw new Error('Select a file first.')
      const contentType = claimFileType(file)
      const count = await client.from('returns_claim_attachments').select('id', { count: 'exact', head: true }).eq('claim_id', attachmentMatch[1])
      if (count.error) throw new Error(count.error.message)
      if ((count.count || 0) >= 10) throw new Error('A claim can have at most 10 attachments.')
      const storagePath = `${currentUser.id}/${attachmentMatch[1]}/${crypto.randomUUID()}-${file.name}`
      const upload = await client.storage.from('returns-claim-attachments').upload(storagePath, file, { contentType })
      if (upload.error) throw new Error(upload.error.message)
      const row = await client.from('returns_claim_attachments').insert({ claim_id: attachmentMatch[1], original_name: file.name, storage_path: storagePath, content_type: contentType, size: file.size, uploaded_by: currentUser.id }).select().single()
      if (row.error) { await client.storage.from('returns-claim-attachments').remove([storagePath]); throw new Error(row.error.message) }
      return row.data
    }
    if (method === 'GET') {
      if (path === '/api/returns-claims') {
        const rows: any[] = []
        for (let offset = 0; ; offset += 500) {
          const page = await client.from('returns_claims').select('*').is('deleted_at', null).order('date', { ascending: false }).order('created_at', { ascending: false }).order('id').range(offset, offset + 499)
          if (page.error) throw new Error(page.error.message)
          rows.push(...(page.data || []))
          if ((page.data || []).length < 500) return rows
        }
      }
      const result = match ? await client.from('returns_claims').select('*').is('deleted_at', null).eq('id', match[1]).single() : await client.from('returns_claims').select('*').is('deleted_at', null).order('date', { ascending: false }).order('created_at', { ascending: false })
      if (result.error) throw new Error(result.error.message)
      if (!match) return result.data || []
      const [attachments, audit] = await Promise.all([
        client.from('returns_claim_attachments').select('id,original_name,storage_path,content_type,size,uploaded_by,created_at').eq('claim_id', match[1]).order('created_at'),
        client.from('returns_claims_audit').select('id,action,changes,actor_user_id,created_at').eq('claim_id', match[1]).order('id', { ascending: false }),
      ])
      if (attachments.error) throw new Error(attachments.error.message)
      if (audit.error) throw new Error(audit.error.message)
      const people = await client.rpc('returns_claim_people', { target_claim_id: match[1] })
      if (people.error) throw new Error(people.error.message)
      const names = new Map((people.data || []).map((person: any) => [person.id, person.display_name]))
      return { ...result.data,
        stored_attachments: (attachments.data || []).map((a: any) => ({ ...a, uploader_name: names.get(a.uploaded_by) || 'Former employee' })),
        audit_history: (audit.data || []).map((a: any) => ({ ...a, actor_name: names.get(a.actor_user_id) || 'Former employee' })),
      }
    }
    if (method === 'POST') {
      const result = await client.from('returns_claims').insert({ ...claimBody, created_by: currentUser.id, updated_by: currentUser.id }).select().single()
      if (result.error) throw new Error(result.error.message)
      return result.data
    }
    if (match && method === 'PATCH') {
      const result = await client.from('returns_claims').update({ ...claimBody, updated_by: currentUser.id, updated_at: new Date().toISOString() }).eq('id', match[1]).select().single()
      if (result.error) throw new Error(result.error.message)
      return result.data
    }
    if (match && method === 'DELETE') {
      const result = await client.from('returns_claims').update({ deleted_at: new Date().toISOString(), deleted_by: currentUser.id, updated_by: currentUser.id }).eq('id', match[1]).is('deleted_at', null).select('id').single()
      if (result.error) throw new Error(result.error.message)
      return null
    }
  }
  const postMatch = path.match(/^\/api\/posts\/([^/]+)$/)
  const postHistoryMatch = path.match(/^\/api\/posts\/([^/?]+)\/history(?:\?.*)?$/)
  if (postHistoryMatch && method === 'GET') {
    const before = new URLSearchParams(path.split('?')[1] || '').get('before')
    let query = client.from('audit_log').select('id,action,details,created_at').eq('entity_type', 'post').eq('entity_id', postHistoryMatch[1]).order('id', { ascending: false }).limit(50)
    if (before) query = query.lt('id', before)
    const { data, error } = await query
    if (error) throw new Error(error.message)
    return (data || []).map((entry: any) => ({ id: entry.id, action: entry.action, details: entry.details || {}, created_at: entry.created_at }))
  }
  if (path === '/api/posts' || path.startsWith('/api/posts?') || postMatch) {
    if (method === 'GET') {
      if (postMatch) {
        const { data, error } = await client.from('posts').select('*').eq('id', postMatch[1]).single()
        if (error) throw new Error(error.message)
        return data
      }
      const params = new URLSearchParams(path.split('?')[1] || '')
      return loadPostPage(client, { month: params.get('month'), campaign: params.get('campaign') || 'all', search: params.get('search') || '', status: params.get('status') || 'all', channel: params.get('channel') || undefined, offset: Number(params.get('offset') || 0), preview: params.get('preview') === 'true', summary: params.get('summary') === 'true' })
    }
    if (method === 'POST') {
      const { data, error } = await client.rpc('save_marketing_post', { p_id: null, p_values: body }).single()
      if (error) throw new Error(error.message)
      return data
    }
    if (method === 'PATCH' && postMatch) {
      const { data, error } = await client.rpc('save_marketing_post', { p_id: postMatch[1], p_values: body }).single()
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
