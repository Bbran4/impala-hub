import type { SupabaseClient } from '@supabase/supabase-js'
import type { UserNotification } from './NotificationCentre'
type Client = Pick<SupabaseClient, 'rpc'>
export type NotificationTarget = { status: 'ready'; notification: UserNotification } | { status: 'missing' | 'unavailable' }
export async function dismissNotification(client: Client, id: string): Promise<void> {
  const { error } = await client.rpc('delete_user_notification', { p_id: id })
  if (error) throw new Error(error.message)
}
export async function resolveNotification(client: Client, id: string): Promise<NotificationTarget> {
  const { data, error } = await client.rpc('open_user_notification', { p_id: id })
  if (error) throw new Error(error.message)
  if (data?.status === 'ready' && data.notification?.id === id) return data as NotificationTarget
  if (data?.status === 'missing' || data?.status === 'unavailable') return { status: data.status }
  throw new Error('The notification could not be checked. Please try again.')
}
