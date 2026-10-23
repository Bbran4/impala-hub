import crypto from 'node:crypto'
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
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: connection } = await admin.from('provider_connections').select('*').eq('provider', 'facebook').eq('owner_id', user.user.id).maybeSingle()
  if (!connection?.page_id || !connection.token_ciphertext) return res.status(409).json({ detail: 'Facebook is not connected.' })
  try {
    const pageToken = decrypt(connection.token_ciphertext, encryptionKey)
    const version = process.env.FACEBOOK_API_VERSION || 'v22.0'
    const fields = 'id,message,created_time,permalink_url,attachments{media,type,url,subattachments{data{media,type,url}}},likes.limit(0).summary(true),comments.limit(0).summary(true),shares'
    const response = await fetch(`https://graph.facebook.com/${version}/${connection.page_id}/published_posts?limit=100&fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(pageToken)}`)
    const result = await response.json()
    if (!response.ok) return res.status(502).json({ detail: 'Facebook rejected the sync request.' })
    let imported = 0
    let metricsUnavailable = 0
    for (const item of result.data || []) {
      const { data: existing } = await admin.from('posts').select('id').contains('provider_ids', { facebook: item.id }).eq('created_by', user.user.id).maybeSingle()
      let attachments = (item.attachments?.data || []).flatMap((attachment: any) => [attachment, ...(attachment.subattachments?.data || [])])
      if (attachments.length < 2) {
        try {
          const attachmentResponse = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(item.id)}/attachments?fields=media,type,url,subattachments{data{media,type,url}}&access_token=${encodeURIComponent(pageToken)}`)
          const attachmentResult = await attachmentResponse.json()
          attachments = (attachmentResult.data || []).flatMap((attachment: any) => [attachment, ...(attachment.subattachments?.data || [])])
        } catch { /* Keep the attachment data returned by published_posts. */ }
      }
      const media = attachments.flatMap((attachment: any) => {
        const image = attachment.media?.image?.src || attachment.url
        return image ? [{ id: `${item.id}-${Math.random().toString(36).slice(2)}`, name: 'Facebook image', url: image, content_type: 'image/*' }] : []
      })
      let insights: Record<string, number> = {}
      try {
        const insightResponse = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(item.id)}/insights?period=lifetime&metric=post_impressions,post_impressions_unique,post_video_views,post_clicks,post_clicks_by_type&access_token=${encodeURIComponent(pageToken)}`)
        const insightData = await insightResponse.json()
        if (!insightResponse.ok || insightData.error) metricsUnavailable += 1
        for (const metric of insightData.data || []) {
          const value = metric.values?.[0]?.value
          if (typeof value === 'object' && value !== null) insights[metric.name] = Object.values(value).reduce((sum: number, entry) => sum + Number(entry || 0), 0)
          else insights[metric.name] = Number(value || 0)
        }
      } catch { metricsUnavailable += 1 }
      const values = { title: '', caption: item.message || '', campaign_id: null, channels: ['facebook'], status: 'published', published_at: item.created_time, media, provider_ids: { facebook: item.id, ...(item.permalink_url ? { permalink: item.permalink_url } : {}) }, likes: item.likes?.summary?.total_count || 0, comments: item.comments?.summary?.total_count || 0, shares: item.shares?.count || 0, impressions: insights.post_impressions ?? null, reach: insights.post_impressions_unique ?? null, views: insights.post_video_views ?? null, clicks: insights.post_clicks ?? insights.post_clicks_by_type ?? null, metrics_refreshed_at: new Date().toISOString(), created_by: user.user.id }
      if (existing) {
        const { error: updateError } = await admin.from('posts').update(values).eq('id', existing.id)
        if (updateError) return res.status(500).json({ detail: `Could not update imported Facebook post (${updateError.code || 'database error'}).` })
      } else {
        const { error: insertError } = await admin.from('posts').insert(values)
        if (insertError) return res.status(500).json({ detail: `Could not save imported Facebook post (${insertError.code || 'database error'}).` })
        imported += 1
      }
    }
    return res.status(200).json({ status: 'synced', items: imported, fetched: (result.data || []).length, metricsUnavailable })
  } catch { return res.status(502).json({ detail: 'Facebook sync failed.' }) }
}
