// Which report email settings are missing (names only, never values).
export default function handler(req: any, res: any) {
  if (req.method !== 'GET') return res.status(405).json({ detail: 'Method not allowed' })
  const checks: [string, string[]][] = [
    ['SUPABASE_URL', ['SUPABASE_URL', 'VITE_SUPABASE_URL']],
    ['SUPABASE_SERVICE_ROLE_KEY', ['SUPABASE_SERVICE_ROLE_KEY']],
    ['CRON_SECRET', ['CRON_SECRET']],
    ['SMTP_HOST', ['SMTP_HOST']],
    ['REPORT_EMAIL_FROM', ['REPORT_EMAIL_FROM']],
    ['REPORT_HUB_URL', ['REPORT_HUB_URL', 'VERCEL_PROJECT_PRODUCTION_URL']],
  ]
  const missing = checks.filter(([, names]) => !names.some((name) => process.env[name])).map(([label]) => label)
  return res.status(200).json({ configured: missing.length === 0, missing })
}
