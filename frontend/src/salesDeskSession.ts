import { AuthError } from './sessionToken.ts'

// This cache supplies display metadata, never authorization. Every mutation is
// permission-checked in PostgreSQL against the caller's current identity/roles.
export function createSalesDeskSessionCache(client: any) {
  let userId: string | null = null
  let pending: Promise<any> | null = null
  const clear = () => { userId = null; pending = null }
  const key = (session: any) => {
    let sessionId = ''
    try { sessionId = JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).session_id || '' } catch { /* Test/legacy tokens may not carry session_id. */ }
    return `${session.user.id}:${sessionId}`
  }
  return {
    clear,
    authChanged(event: string, session: any) {
      if (event === 'SIGNED_OUT' || event === 'USER_UPDATED' || (event === 'SIGNED_IN' && session && key(session) !== userId)) clear()
    },
    async get() {
      const { data, error } = await client.auth.getSession()
      if (error || !data.session?.user?.id) { clear(); throw new AuthError('Sign in again to open Sales Desk.') }
      const current = key(data.session)
      if (current !== userId || !pending) {
        userId = current
        const request = Promise.resolve(client.rpc('sales_desk_session_context')).then(({ data, error }: any) => {
          if (error || !data) throw new Error(error?.message || 'Sales Desk access is unavailable.')
          return data
        })
        pending = request
        request.catch(() => { if (pending === request) clear() })
      }
      return pending
    },
  }
}
