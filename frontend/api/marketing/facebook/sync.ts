import crypto from 'node:crypto'
import { facebookMediaId } from './_publishing.ts'
const timedFetch = (url: string) => fetch(url, { signal: AbortSignal.timeout(20_000) })
import { createClient } from '@supabase/supabase-js'

function decrypt(value: string, secret: string) {
  const key = Buffer.from(secret, 'base64')
  const [iv, tag, data] = value.split('.')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ detail: 'Method not allowed' })
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const encryptionKey = process.env.META_TOKEN_ENCRYPTION_KEY
  if (!url || !key || !serviceKey || !encryptionKey) return res.status(503).json({ detail: 'Facebook sync server configuration is incomplete.' })
  const auth = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } })
  const { data: user, error: authError } = await auth.auth.getUser(token)
  if (authError || !user.user) return res.status(401).json({ detail: 'Authentication required.' })
  const { data: canAccess } = await auth.rpc('can_access_workspace', { workspace_name: 'marketing' })
  if (!canAccess) return res.status(403).json({ detail: 'Marketing access required.' })
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: connection } = await admin.from('provider_connections').select('*').eq('provider', 'facebook').eq('is_workspace_connection', true).maybeSingle()
  if (!connection?.page_id || !connection.token_ciphertext) return res.status(409).json({ detail: 'Facebook is not connected.' })
  try {
    const pageToken = decrypt(connection.token_ciphertext, encryptionKey)
    const version = process.env.FACEBOOK_API_VERSION || 'v22.0'
    const fields = 'id,message,created_time,permalink_url,full_picture,attachments{media,subattachments},likes.limit(0).summary(true),comments.limit(0).summary(true),shares'
    const response = await timedFetch(`https://graph.facebook.com/${version}/${connection.page_id}/published_posts?limit=100&fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(pageToken)}`)
    const result = await response.json()
    if (!response.ok) return res.status(502).json({ detail: 'Facebook rejected the sync request.' })
    let imported = 0
    let audience: number | null = null
    try {
      const pageResponse = await timedFetch(`https://graph.facebook.com/${version}/me?fields=id,name,followers_count&access_token=${encodeURIComponent(pageToken)}`)
      const pageData = await pageResponse.json()
      audience = pageData.followers_count ?? pageData.fan_count ?? null
      if (audience != null) await admin.from('provider_connections').update({ followers_count: audience }).eq('id', connection.id)
    } catch { /* Audience is optional. */ }
    let metricsUnavailable = 0
    const metricsErrors: string[] = []
    for (const item of result.data || []) {
      const { data: existing } = await admin.from('posts').select('id').contains('provider_ids', { facebook: item.id }).limit(1).maybeSingle()
      let attachments = (item.attachments?.data || []).flatMap((attachment: any) => [attachment, ...(attachment.subattachments?.data || [])])
      if (attachments.length < 2) {
        try {
          const attachmentResponse = await timedFetch(`https://graph.facebook.com/${version}/${encodeURIComponent(item.id)}/attachments?fields=media,subattachments&access_token=${encodeURIComponent(pageToken)}`)
          const attachmentResult = await attachmentResponse.json()
          attachments = (attachmentResult.data || []).flatMap((attachment: any) => [attachment, ...(attachment.subattachments?.data || [])])
        } catch { /* Keep the attachment data returned by published_posts. */ }
      }
      const media = attachments.flatMap((attachment: any) => {
        const image = attachment.media?.image?.src || attachment.url
        return image ? [{ id: facebookMediaId(item.id, image), name: 'Facebook image', url: image, content_type: 'image/*' }] : []
      })
      if (!media.length && item.full_picture) media.push({ id: `${item.id}-1`, name: 'Facebook image', url: item.full_picture, content_type: 'image/*' })
      const insights: Record<string, number> = {}
      const metricFallbacks: Array<[string, string[]]> = [
        ['views', ['post_media_view', 'post_impressions']],
        ['reach', ['post_total_media_view_unique', 'post_impressions_unique']],
        ['clicks', ['post_clicks']],
      ]
      for (const [target, metricNames] of metricFallbacks) {
        for (const metricName of metricNames) {
          if (insights[target] != null) break
        try {
          const insightResponse = await timedFetch(`https://graph.facebook.com/${version}/${encodeURIComponent(item.id)}/insights?metric=${metricName}&access_token=${encodeURIComponent(pageToken)}`)
          const insightData = await insightResponse.json()
          const value = insightData.data?.[0]?.values?.[0]?.value
          if (!insightResponse.ok || insightData.error || value == null) {
            metricsUnavailable += 1
            if (metricsErrors.length < 3) metricsErrors.push(`${metricName}: ${insightData.error?.message || `HTTP ${insightResponse.status}`}`)
          }
          else insights[target] = typeof value === 'object' ? Object.values(value).reduce<number>((sum, entry) => sum + Number(entry || 0), 0) : Number(value || 0)
        } catch { metricsUnavailable += 1 }
        }
      }
      const values = { caption: item.message || '', channels: ['facebook'], status: 'published', published_at: item.created_time, media, provider_ids: { facebook: item.id, ...(item.permalink_url ? { permalink: item.permalink_url } : {}) }, likes: item.likes?.summary?.total_count || 0, comments: item.comments?.summary?.total_count || 0, shares: item.shares?.count || 0, impressions: insights.views ?? null, reach: insights.reach ?? null, views: insights.views ?? null, clicks: insights.clicks ?? null, metrics_refreshed_at: new Date().toISOString() }
      // Serialize lookup/insert in the database; preserve all local editorial fields.
      const saved = await admin.rpc('sync_facebook_post', { p_values: values, p_actor: user.user.id })
      if (saved.error) return res.status(500).json({ detail: 'Could not save imported Facebook post.' })
      if (!existing) imported += 1

    }
    return res.status(200).json({ status: 'synced', items: imported, fetched: (result.data || []).length, metricsUnavailable, metricsErrors, audience })
  } catch { return res.status(502).json({ detail: 'Facebook sync failed.' }) }
}
