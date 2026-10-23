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
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ detail: 'Method not allowed' })
  const cronSecret = process.env.CRON_SECRET
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!cronSecret || supplied !== cronSecret) return res.status(401).json({ detail: 'Unauthorized scheduler request.' })
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const encryptionKey = process.env.META_TOKEN_ENCRYPTION_KEY
  if (!url || !serviceKey || !encryptionKey) return res.status(503).json({ detail: 'Scheduled publishing configuration is incomplete.' })
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const now = new Date().toISOString()
  const { data: due, error } = await admin.from('posts').select('*').eq('status', 'scheduled').lte('publish_at', now).limit(25)
  if (error) return res.status(500).json({ detail: 'Could not load scheduled posts.' })
  const results: Array<{ id: string; status: string }> = []
  for (const post of due || []) {
    const claim = await admin.from('posts').update({ status: 'publishing' }).eq('id', post.id).eq('status', 'scheduled').select('id').maybeSingle()
    if (!claim.data) continue
    const { data: connection } = await admin.from('provider_connections').select('*').eq('provider', 'facebook').eq('owner_id', post.created_by).maybeSingle()
    if (!connection?.page_id || !connection.token_ciphertext) {
      await admin.from('posts').update({ status: 'failed', last_error: 'Facebook is not connected for the post owner.' }).eq('id', post.id)
      results.push({ id: post.id, status: 'failed' }); continue
    }
    try {
      const pageToken = decrypt(connection.token_ciphertext, encryptionKey)
      const media = Array.isArray(post.media) ? post.media : []
      const version = process.env.FACEBOOK_API_VERSION || 'v22.0'
      const path = media[0]?.url && media.length === 1 ? `${connection.page_id}/photos` : `${connection.page_id}/feed`
      const params: Record<string, string> = { access_token: pageToken, message: post.caption || post.title || '' }
      if (path.endsWith('/photos')) params.url = media[0].url
      const response = await fetch(`https://graph.facebook.com/${version}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) })
      const result = await response.json()
      if (!response.ok || !result.id) throw new Error('Facebook rejected the scheduled post.')
      await admin.from('posts').update({ status: 'published', published_at: new Date().toISOString(), provider_ids: { ...(post.provider_ids || {}), facebook: result.id }, last_error: null }).eq('id', post.id)
      results.push({ id: post.id, status: 'published' })
    } catch (publishError) {
      await admin.from('posts').update({ status: 'failed', last_error: publishError instanceof Error ? publishError.message : 'Scheduled Facebook publishing failed.' }).eq('id', post.id)
      results.push({ id: post.id, status: 'failed' })
    }
  }
  return res.status(200).json({ processed: results.length, results })
}
