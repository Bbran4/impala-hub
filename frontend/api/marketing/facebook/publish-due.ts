import { createClient } from '@supabase/supabase-js'
import { claimPost, publishClaimed } from './_publishing.ts'

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
  try {
    const now = new Date().toISOString()
    const recovered = await admin.from('posts').update({ status: 'publish_unknown', last_error: 'Interrupted publication. Check Facebook and reconcile before retrying.' }).eq('status', 'publishing').lt('publish_started_at', new Date(Date.now() - 10 * 60_000).toISOString())
    if (recovered.error) throw recovered.error
    const { data: due, error } = await admin.from('posts').select('id').eq('status', 'scheduled').lte('publish_at', now).order('publish_at').order('id').limit(25)
    if (error) throw error
    const connection = await admin.from('provider_connections').select('*').eq('provider', 'facebook').eq('is_workspace_connection', true).maybeSingle()
    if (connection.error) throw connection.error
    const results = []
    for (const candidate of due || []) {
      const post = await claimPost(admin, candidate.id, ['scheduled'], undefined, now)
      if (post) results.push(await publishClaimed(admin, post, connection.data, encryptionKey))
    }
    return res.status(200).json({ processed: results.length, results })
  } catch { return res.status(500).json({ detail: 'Scheduled publication could not be completed. Check post statuses before retrying.' }) }
}
