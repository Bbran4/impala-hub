export class AuthError extends Error {}

type SessionClient = { auth: { getSession(): PromiseLike<{
  data: { session: { access_token: string } | null }; error: { message: string } | null
}> } }

// Read the current in-memory session for every request, including refreshed tokens.
// Never fall back to a token left in browser storage after logout/session expiry.
export async function readSupabaseToken(client: SessionClient | null) {
  if (!client) throw new AuthError('Supabase is not configured.')
  const { data, error } = await client.auth.getSession()
  if (error || !data.session?.access_token) throw new AuthError('Your session expired or is no longer valid. Sign in again.')
  return data.session.access_token
}
