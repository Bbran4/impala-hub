import { createClient } from '@supabase/supabase-js'
import { claimPost, publishClaimed } from './_publishing.ts'

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
  try {
    const claimed = await claimPost(admin, post.id, ['draft', 'awaiting_approval', 'failed', 'scheduled'], user.user.id)
    if (!claimed) return res.status(409).json({ detail: 'This post is already published, publishing, or awaiting reconciliation.' })
    const outcome = await publishClaimed(admin, claimed, connection, encryptionKey)
    return res.status(outcome.status === 'published' ? 200 : 502).json(outcome)
  } catch { return res.status(500).json({ detail: 'Could not persist the publishing attempt. Do not retry until its status has been checked.' }) }
}
