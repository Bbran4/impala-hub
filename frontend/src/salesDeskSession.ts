import type { SupabaseClient } from '@supabase/supabase-js'
import type { SalesDeskUser } from './rfqTypes'
type SessionIdentity = { access_token: string; user: { id: string } }
import { AuthError } from './sessionToken.ts'

// This cache supplies display metadata, never authorization. Every mutation is
// permission-checked in PostgreSQL against the caller's current identity/roles.
export function createSalesDeskSessionCache(client: Pick<SupabaseClient, 'auth' | 'rpc'>) {
  let userId: string | null = null
  let pending: Promise<SalesDeskUser> | null = null
  const clear = () => { userId = null; pending = null }
  const key = (session: SessionIdentity) => {
    let sessionId = ''
    try { sessionId = JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).session_id || '' } catch { /* Test/legacy tokens may not carry session_id. */ }
    return `${session.user.id}:${sessionId}`
  }
  return {
    clear,
    authChanged(event: string, session: SessionIdentity | null) {
      if (event === 'SIGNED_OUT' || event === 'USER_UPDATED' || (event === 'SIGNED_IN' && session && key(session) !== userId)) clear()
    },
    async get() {
      const { data, error } = await client.auth.getSession()
      if (error || !data.session?.user?.id) { clear(); throw new AuthError('Sign in again to open Sales Desk.') }
      const current = key(data.session)
      if (current !== userId || !pending) {
        userId = current
        const request = Promise.resolve(client.rpc('sales_desk_session_context')).then(({ data, error }) => {
          if (error || !data) throw new Error(error?.message || 'Sales Desk access is unavailable.')
          return data as SalesDeskUser
        })
        pending = request
        request.catch(() => { if (pending === request) clear() })
      }
      return pending
    },
  }
}
