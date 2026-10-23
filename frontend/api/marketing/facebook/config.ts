export default function handler(req: any, res: any) {
  if (req.method !== 'GET') return res.status(405).json({ detail: 'Method not allowed' })
  const required = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'META_APP_ID', 'META_APP_SECRET', 'META_TOKEN_ENCRYPTION_KEY', 'FACEBOOK_OAUTH_REDIRECT_URI']
  const aliases: Record<string, string[]> = {
    SUPABASE_URL: ['SUPABASE_URL', 'VITE_SUPABASE_URL'],
    SUPABASE_PUBLISHABLE_KEY: ['SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY'],
  }
  const missing = required.filter((name) => !(aliases[name] || [name]).some((candidate) => process.env[candidate]))
  return res.status(200).json({ configured: missing.length === 0, missing })
}
