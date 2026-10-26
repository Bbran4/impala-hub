import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deleteRecordAttachment } from '../src/recordAttachments.ts'

function fakeClient({ allowed = true, storageError = null, finishError = null, found = true } = {}) {
  const calls = []
  const query = { select() { return this }, eq(column, value) { calls.push([column, value]); return this },
    async maybeSingle() { return { data: found ? { id: 'attachment', storage_path: 'actor/parent/file.pdf' } : null, error: null } } }
  const client = {
    async rpc(name, args) { calls.push([name, args]); return name === 'can_delete_record_attachment' ? { data: allowed, error: null } : { error: finishError } },
    from(table) { calls.push(['table', table]); return query },
    storage: { from(bucket) { calls.push(['bucket', bucket]); return { async remove(paths) { calls.push(['remove', paths]); return { error: storageError } } } } },
  }
  return { client, calls }
}
test('denied deletion never reads or removes attachments', async () => {
  const { client, calls } = fakeClient({ allowed: false })
  await assert.rejects(() => deleteRecordAttachment(client, 'return', 'parent', 'attachment'), /permission/)
  assert.equal(calls.length, 1)
})
test('Storage failure leaves metadata finalization untouched', async () => {
  const { client, calls } = fakeClient({ storageError: { message: 'Storage unavailable' } })
  await assert.rejects(() => deleteRecordAttachment(client, 'return', 'parent', 'attachment'), /stored file/)
  assert.equal(calls.some(([name]) => name === 'finish_attachment_deletion'), false)
})
test('both workspaces scope deletions to the parent and remove files before metadata', async () => {
  for (const [kind, column, bucket] of [['return', 'claim_id', 'returns-claim-attachments'], ['rfq', 'rfq_id', 'sales-desk-attachments']]) {
    const { client, calls } = fakeClient()
    await deleteRecordAttachment(client, kind, 'parent', 'attachment')
    assert.ok(calls.some(([name, value]) => name === column && value === 'parent'))
    assert.ok(calls.some(([name, value]) => name === 'bucket' && value === bucket))
    assert.ok(calls.findIndex(([name]) => name === 'remove') < calls.findIndex(([name]) => name === 'finish_attachment_deletion'))
  }
})
test('a finalization failure tells the user to retry', async () => {
  const { client } = fakeClient({ finishError: { message: 'Connection interrupted' } })
  await assert.rejects(() => deleteRecordAttachment(client, 'rfq', 'parent', 'attachment'), /another deletion attempt/)
})
test('an already removed metadata row is safe to retry', async () => {
  const { client, calls } = fakeClient({ found: false })
  await deleteRecordAttachment(client, 'return', 'parent', 'attachment')
  assert.equal(calls.some(([name]) => name === 'remove'), false)
})
