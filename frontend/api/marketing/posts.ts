import { loadMarketingPosts } from '../../src/recordLists.js'
import { createClient } from '@supabase/supabase-js'

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') return res.status(405).json({ detail: 'Method not allowed' })
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key || !serviceKey) return res.status(503).json({ detail: 'Post read server configuration is incomplete.' })
  const auth = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } })
  const { data: user, error: authError } = await auth.auth.getUser(token)
  if (authError || !user.user) return res.status(401).json({ detail: 'Authentication required.' })
  const checks = await Promise.all([
    auth.rpc('has_marketing_permission', { required_permission: 'feed.view' }),
    auth.rpc('has_marketing_permission', { required_permission: 'posts.view' }),
  ])
  if (checks.some((check) => check.error)) return res.status(500).json({ detail: 'Could not verify Marketing post access.' })
  if (!checks.some((check) => check.data === true)) return res.status(403).json({ detail: 'Feed or Posts view permission required.' })
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  try {
    const { data } = await loadMarketingPosts(admin, user.user.id)
    return res.status(200).json(data)
  } catch { return res.status(500).json({ detail: 'Could not load the complete post list. Please reload.' }) }
}
