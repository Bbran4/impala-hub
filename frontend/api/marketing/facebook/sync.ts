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
    const fields = 'id,message,created_time,permalink_url,attachments{media,type,url},likes.limit(0).summary(true),comments.limit(0).summary(true),shares'
    const response = await fetch(`https://graph.facebook.com/${version}/${connection.page_id}/published_posts?limit=100&fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(pageToken)}`)
    const result = await response.json()
    if (!response.ok) return res.status(502).json({ detail: 'Facebook rejected the sync request.' })
    let imported = 0
    for (const item of result.data || []) {
      const { data: existing } = await admin.from('posts').select('id').contains('provider_ids', { facebook: item.id }).eq('created_by', user.user.id).maybeSingle()
      const values = { title: '', caption: item.message || '', channels: ['facebook'], status: 'published', published_at: item.created_time, provider_ids: { facebook: item.id, ...(item.permalink_url ? { permalink: item.permalink_url } : {}) }, likes: item.likes?.summary?.total_count || 0, comments: item.comments?.summary?.total_count || 0, shares: item.shares?.count || 0, metrics_refreshed_at: new Date().toISOString(), created_by: user.user.id }
      if (existing) await admin.from('posts').update(values).eq('id', existing.id)
      else { await admin.from('posts').insert(values); imported += 1 }
    }
    return res.status(200).json({ status: 'synced', items: imported, fetched: (result.data || []).length })
  } catch { return res.status(502).json({ detail: 'Facebook sync failed.' }) }
}
