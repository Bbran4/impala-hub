import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

function decrypt(value: string, secret: string) {
  const key = Buffer.from(secret, 'base64')
  const [ivText, tagText, dataText] = value.split('.')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64'))
  decipher.setAuthTag(Buffer.from(tagText, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64')), decipher.final()]).toString('utf8')
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ detail: 'Method not allowed' })
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const { page_id } = req.body || {}
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const encryptionKey = process.env.META_TOKEN_ENCRYPTION_KEY
  if (!url || !key || !serviceKey || !encryptionKey) return res.status(503).json({ detail: 'Facebook connection storage is not configured in Vercel.' })
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: user, error: authError } = await client.auth.getUser(token)
  if (authError || !user.user) return res.status(401).json({ detail: 'Authentication required.' })
  if (!page_id) return res.status(400).json({ detail: 'Choose a Facebook Page.' })
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const [{ data: profile }, { data: administratorRole }] = await Promise.all([
    admin.from('profiles').select('active').eq('id', user.user.id).maybeSingle(),
    admin.from('profile_roles').select('role_id').eq('profile_id', user.user.id).eq('role_id', 'administrator').maybeSingle(),
  ])
  if (!profile?.active || !administratorRole) return res.status(403).json({ detail: 'Administrator access required.' })
  const { data: choices } = await admin.from('oauth_page_choices').select('pages').eq('owner_id', user.user.id).gt('expires_at', new Date().toISOString()).maybeSingle()
  const page = (choices?.pages || []).find((item: any) => item.id === String(page_id))
  if (!page) return res.status(400).json({ detail: 'That Facebook Page selection has expired. Connect Facebook again.' })
  try {
    const pageToken = decrypt(page.token, encryptionKey)
    const now = new Date().toISOString()
    const connection = { page_id: page.id, page_name: page.name, account_name: page.name, token_ciphertext: page.token, scopes: page.tasks || [], status: 'connected', last_checked_at: now, last_success_at: now, last_error: null, is_workspace_connection: true }
    const { data: shared } = await admin.from('provider_connections').select('id').eq('provider', 'facebook').eq('is_workspace_connection', true).maybeSingle()
    let error
    if (shared?.id) {
      error = (await admin.from('provider_connections').update(connection).eq('id', shared.id)).error
    } else {
      const { data: owned } = await admin.from('provider_connections').select('id').eq('provider', 'facebook').eq('owner_id', user.user.id).maybeSingle()
      if (owned?.id) error = (await admin.from('provider_connections').update(connection).eq('id', owned.id)).error
      else error = (await admin.from('provider_connections').insert({ ...connection, provider: 'facebook', owner_id: user.user.id })).error
    }
    if (error) return res.status(500).json({ detail: 'Could not save the Facebook Page connection.' })
    await admin.from('oauth_page_choices').delete().eq('owner_id', user.user.id)
    void pageToken
    return res.status(200).json({ provider: 'facebook', status: 'connected', page_id: page.id, page_name: page.name })
  } catch { return res.status(500).json({ detail: 'Could not protect the Facebook Page token.' }) }
}
