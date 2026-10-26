import type { SupabaseClient } from '@supabase/supabase-js'

export async function deleteRecordAttachment(supabase: SupabaseClient, kind: 'return' | 'rfq', parentId: string, attachmentId: string) {
  const permission = await supabase.rpc('can_delete_record_attachment', { record_kind: kind, parent_id: parentId })
  if (permission.error) throw new Error(permission.error.message)
  if (!permission.data) throw new Error('You do not have permission to delete this attachment.')
  const table = kind === 'return' ? 'returns_claim_attachments' : 'sales_desk_rfq_attachments'
  const bucket = kind === 'return' ? 'returns-claim-attachments' : 'sales-desk-attachments'
  const parentColumn = kind === 'return' ? 'claim_id' : 'rfq_id'
  const attachment = await supabase.from(table).select('id,storage_path').eq('id', attachmentId).eq(parentColumn, parentId).maybeSingle()
  if (attachment.error) throw new Error(attachment.error.message)
  if (!attachment.data) return
  const removed = await supabase.storage.from(bucket).remove([attachment.data.storage_path])
  if (removed.error) throw new Error(`Could not remove the stored file: ${removed.error.message}`)
  const finished = await supabase.rpc('finish_attachment_deletion', { record_kind: kind, parent_id: parentId, attachment_id: attachmentId })
  if (finished.error) throw new Error(`The file was removed but its database entry needs another deletion attempt: ${finished.error.message}`)
}
