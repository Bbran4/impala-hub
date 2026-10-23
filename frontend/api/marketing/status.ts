import { createClient } from '@supabase/supabase-js'

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') return res.status(405).json({ detail: 'Method not allowed' })
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) return res.status(503).json({ detail: 'Supabase server configuration is incomplete.' })
  if (!token) return res.status(401).json({ detail: 'Authentication required.' })
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return res.status(401).json({ detail: 'Invalid or expired session.' })
  return res.status(200).json({
    authenticated: true,
    providers: {
      facebook: Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET),
      instagram: Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET),
    },
    publishing: false,
    message: 'Server boundary is ready. Provider OAuth and publishing are not enabled yet.',
  })
}
