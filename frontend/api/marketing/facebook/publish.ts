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
  if (!url || !key || !serviceKey || !encryptionKey) return res.status(503).json({ detail: 'Facebook publishing server configuration is incomplete.' })
  const auth = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } })
  const { data: user, error: authError } = await auth.auth.getUser(token)
  if (authError || !user.user) return res.status(401).json({ detail: 'Authentication required.' })
  const permissionChecks = await Promise.all([
    auth.rpc('has_marketing_permission', { required_permission: 'feed.create' }),
    auth.rpc('has_marketing_permission', { required_permission: 'feed.edit' }),
    auth.rpc('has_marketing_permission', { required_permission: 'posts.create' }),
    auth.rpc('has_marketing_permission', { required_permission: 'posts.edit' }),
  ])
  if (permissionChecks.some((check) => check.error)) return res.status(500).json({ detail: 'Could not verify Marketing publishing access.' })
  if (!permissionChecks.some((check) => check.data === true)) return res.status(403).json({ detail: 'Create or edit post permission required.' })
  const postId = String(req.query?.post_id || '')
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const [{ data: post }, { data: connection }] = await Promise.all([
    admin.from('posts').select('*').eq('id', postId).eq('created_by', user.user.id).maybeSingle(),
    admin.from('provider_connections').select('*').eq('provider', 'facebook').eq('is_workspace_connection', true).maybeSingle(),
  ])
  if (!post) return res.status(404).json({ detail: 'Post not found.' })
  if (!connection?.page_id || !connection.token_ciphertext) return res.status(409).json({ detail: 'Facebook is not connected. Connect Facebook first.' })
  const pageToken = decrypt(connection.token_ciphertext, encryptionKey)
  const message = post.caption || post.title || ''
  const media = Array.isArray(post.media) ? post.media : []
  const version = process.env.FACEBOOK_API_VERSION || 'v22.0'
  let graphPath = `${connection.page_id}/feed`
  const params: Record<string, string> = { access_token: pageToken, message }
  if (media[0]?.url && media.length === 1) { graphPath = `${connection.page_id}/photos`; params.url = media[0].url }
  const response = await fetch(`https://graph.facebook.com/${version}/${graphPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) })
  const result = await response.json()
  if (!response.ok || !result.id) {
    await admin.from('posts').update({ status: 'failed', last_error: 'Facebook rejected this post.' }).eq('id', post.id)
    return res.status(502).json({ detail: 'Facebook rejected this post. Check the Page connection and content.' })
  }
  const providerIds = { ...(post.provider_ids || {}), facebook: result.id }
  await admin.from('posts').update({ status: 'published', published_at: new Date().toISOString(), provider_ids: providerIds, last_error: null }).eq('id', post.id)
  return res.status(200).json({ id: post.id, status: 'published', facebook_post_id: result.id })
}
