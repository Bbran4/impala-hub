import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ detail: 'Method not allowed' })
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const appId = process.env.META_APP_ID
  const redirectUri = process.env.FACEBOOK_OAUTH_REDIRECT_URI
  if (!url || !publishableKey || !serviceKey || !appId || !redirectUri) {
    const missing = [!url && 'SUPABASE_URL', !publishableKey && 'SUPABASE_PUBLISHABLE_KEY', !serviceKey && 'SUPABASE_SERVICE_ROLE_KEY', !appId && 'META_APP_ID', !redirectUri && 'FACEBOOK_OAUTH_REDIRECT_URI'].filter(Boolean)
    return res.status(503).json({ detail: `Facebook OAuth server configuration is incomplete. Missing: ${missing.join(', ')}` })
  }
  if (!token) return res.status(401).json({ detail: 'Authentication required.' })
  const authClient = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: user, error: userError } = await authClient.auth.getUser(token)
  if (userError || !user.user) return res.status(401).json({ detail: 'Invalid or expired session.' })
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const [{ data: profile }, { data: administratorRole }] = await Promise.all([
    admin.from('profiles').select('active').eq('id', user.user.id).maybeSingle(),
    admin.from('profile_roles').select('role_id').eq('profile_id', user.user.id).eq('role_id', 'administrator').maybeSingle(),
  ])
  if (!profile?.active || !administratorRole) return res.status(403).json({ detail: 'Administrator access required.' })
  const state = crypto.randomBytes(32).toString('base64url')
  const { error } = await admin.from('oauth_states').insert({ state, provider: 'facebook', owner_id: user.user.id, redirect_uri: redirectUri, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() })
  if (error) return res.status(500).json({ detail: `Could not create Facebook OAuth state. Apply the latest Supabase migration and retry. (${error.code || 'database error'})` })
  const params = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, state, response_type: 'code', scope: 'ads_management,ads_read,business_management,pages_manage_engagement,pages_manage_metadata,pages_manage_posts,pages_messaging,pages_read_engagement,pages_read_user_content,pages_show_list,read_insights,instagram_basic,instagram_content_publish,instagram_manage_comments,instagram_manage_contents,instagram_manage_engagement,instagram_manage_insights,instagram_manage_messages' })
  return res.status(200).json({ url: `https://www.facebook.com/dialog/oauth?${params.toString()}` })
}
