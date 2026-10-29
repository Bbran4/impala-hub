import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

// The publishable key is intended for browser use. Never place a service-role key here.
export const supabaseConfigured = Boolean(url && publishableKey)

export const supabase = supabaseConfigured
  ? createClient(url!, publishableKey!, {
      auth: {
        // Keep authentication in memory. Closing the tab/browser ends the session.
        persistSession: false,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null

export async function checkSupabaseConnection() {
  if (!supabase) return { configured: false, user: null }
  const { data, error } = await supabase.auth.getUser()
  if (error && error.name !== 'AuthSessionMissingError') throw error
  return { configured: true, user: data.user ?? null }
}
