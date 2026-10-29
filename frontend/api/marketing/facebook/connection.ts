import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

function decrypt(value: string, secret: string) {
  const key = Buffer.from(secret, 'base64')
  const [iv, tag, data] = value.split('.')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')
}

async function clients(token: string) {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key || !serviceKey || !process.env.META_TOKEN_ENCRYPTION_KEY) throw new Error('Facebook connection server configuration is incomplete.')
  const auth = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } })
  const { data: user, error } = await auth.auth.getUser(token)
  if (error || !user.user) throw new Error('Authentication required.')
  const { data: canManageAccounts, error: roleError } = await auth.rpc('has_marketing_permission', { required_permission: 'feed.manage_accounts' })
  if (roleError) throw new Error('Could not verify Marketing account access.')
  if (!canManageAccounts) throw new Error('Marketing account management permission required.')
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  return { admin }
}

export default async function handler(req: any, res: any) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  try {
    const { admin } = await clients(token)
    const { data: connection, error: loadError } = await admin.from('provider_connections').select('*').eq('provider', 'facebook').eq('is_workspace_connection', true).maybeSingle()
    if (loadError) return res.status(500).json({ detail: 'Could not load the shared Facebook connection.' })
    if (req.method === 'DELETE') {
      const { error: deleteError } = await admin.from('provider_connections').delete().eq('provider', 'facebook').eq('is_workspace_connection', true)
      if (deleteError) return res.status(500).json({ detail: 'Could not disconnect Facebook.' })
      return res.status(200).json({ disconnected: true })
    }
    if (req.method !== 'POST') return res.status(405).json({ detail: 'Method not allowed' })
    if (!connection?.page_id || !connection.token_ciphertext) return res.status(409).json({ detail: 'Facebook is not connected. Connect Facebook first.' })
    const pageToken = decrypt(connection.token_ciphertext, process.env.META_TOKEN_ENCRYPTION_KEY as string)
    const response = await fetch(`https://graph.facebook.com/v22.0/${encodeURIComponent(connection.page_id)}?fields=id,name&access_token=${encodeURIComponent(pageToken)}`)
    const result = await response.json()
    if (!response.ok || !result.id) {
      const { error: saveError } = await admin.from('provider_connections').update({ status: 'error', last_error: 'Facebook rejected the Page token.', last_checked_at: new Date().toISOString() }).eq('id', connection.id)
      if (saveError) return res.status(500).json({ detail: 'Facebook rejected the token and its status could not be saved.' })
      return res.status(502).json({ detail: 'Facebook rejected the saved Page token. Reconnect Facebook.' })
    }
    const { error: saveError } = await admin.from('provider_connections').update({ status: 'connected', page_name: result.name || connection.page_name, account_name: result.name || connection.account_name, last_checked_at: new Date().toISOString(), last_success_at: new Date().toISOString(), last_error: null }).eq('id', connection.id)
    if (saveError) return res.status(500).json({ detail: 'Facebook passed the live check, but the result could not be saved.' })
    return res.status(200).json({ page_id: result.id, page_name: result.name, status: 'connected' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Facebook connection request failed.'
    const status = message === 'Marketing account management permission required.' ? 403 : message === 'Could not verify Marketing account access.' ? 500 : 401
    return res.status(status).json({ detail: message })
  }
}
