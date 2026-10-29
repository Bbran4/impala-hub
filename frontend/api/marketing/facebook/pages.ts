import { createClient } from '@supabase/supabase-js'

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') return res.status(405).json({ detail: 'Method not allowed' })
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key || !serviceKey) return res.status(503).json({ detail: 'Facebook connection storage is not configured in Vercel.' })
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } })
  const { data: user, error: authError } = await client.auth.getUser(token)
  if (authError || !user.user) return res.status(401).json({ detail: 'Authentication required.' })
  const { data: canManageAccounts, error: roleError } = await client.rpc('has_marketing_permission', { required_permission: 'feed.manage_accounts' })
  if (roleError) return res.status(500).json({ detail: 'Could not verify Marketing account access.' })
  if (!canManageAccounts) return res.status(403).json({ detail: 'Marketing account management permission required.' })
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await admin.from('oauth_page_choices').select('pages,expires_at').eq('owner_id', user.user.id).gt('expires_at', new Date().toISOString()).maybeSingle()
  if (error) return res.status(500).json({ detail: 'Could not load the available Facebook Pages.' })
  const pages = (data?.pages || []).map((page: any) => ({ id: page.id, name: page.name, tasks: page.tasks || [] }))
  return res.status(200).json({ pages })
}
