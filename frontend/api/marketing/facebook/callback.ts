import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

function encrypt(value: string, secret: string) {
  const key = Buffer.from(secret, 'base64')
  if (key.length !== 32) throw new Error('META_TOKEN_ENCRYPTION_KEY must decode to 32 bytes.')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ciphertext.toString('base64')}`
}

export default async function handler(req: any, res: any) {
  const frontend = process.env.FRONTEND_URL || 'https://impala-hub-marketing.vercel.app'
  const redirect = (reason: string) => res.redirect(`${frontend}/?facebook_oauth=error&reason=${encodeURIComponent(reason)}`)
  const { code, state, error } = req.query || {}
  if (error) return redirect('authorization_cancelled')
  if (!code || !state) return redirect('missing_code')
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const appId = process.env.META_APP_ID
  const appSecret = process.env.META_APP_SECRET
  const redirectUri = process.env.FACEBOOK_OAUTH_REDIRECT_URI
  const encryptionKey = process.env.META_TOKEN_ENCRYPTION_KEY
  if (!url || !serviceKey || !appId || !appSecret || !redirectUri || !encryptionKey) return redirect('server_configuration')
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: stateRow } = await admin.from('oauth_states').select('owner_id').eq('state', state).eq('provider', 'facebook').gt('expires_at', new Date().toISOString()).maybeSingle()
  if (!stateRow) return redirect('invalid_state')
  await admin.from('oauth_states').delete().eq('state', state)
  try {
    const tokenUrl = new URL('https://graph.facebook.com/v22.0/oauth/access_token')
    tokenUrl.search = new URLSearchParams({ client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code: String(code) }).toString()
    const tokenResponse = await fetch(tokenUrl)
    const tokenData = await tokenResponse.json()
    if (!tokenResponse.ok || !tokenData.access_token) return redirect('token_exchange_failed')
    const pagesResponse = await fetch(`https://graph.facebook.com/v22.0/me/accounts?fields=id,name,access_token,tasks&access_token=${encodeURIComponent(tokenData.access_token)}`)
    const pagesData = await pagesResponse.json()
    const pages = (pagesData.data || []).filter((page: any) => page.id && page.name && page.access_token).map((page: any) => ({ id: page.id, name: page.name, tasks: page.tasks || [], token: encrypt(page.access_token, encryptionKey) }))
    if (!pages.length) return redirect('page_token_unavailable')
    await admin.from('oauth_page_choices').upsert({ owner_id: stateRow.owner_id, provider: 'facebook', pages, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() })
    return res.redirect(`${frontend}/?facebook_oauth=choose_page`)
  } catch { return redirect('oauth_failed') }
}
