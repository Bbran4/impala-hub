import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readMarketingResponse } from '../src/marketingResponse.ts'

test('Facebook refresh explains plain-text Vercel crashes and includes the request reference', async () => {
  await assert.rejects(readMarketingResponse(new Response('A server error has occurred\nFUNCTION_INVOCATION_FAILED', { status: 500, headers: { 'x-vercel-id': 'incident-123' } }), 'Facebook refresh'), /Facebook refresh failed \(HTTP 500\).*failed to start.*incident-123/)
})
test('Facebook refresh retains actionable database errors and rejects invalid success responses', async () => {
  await assert.rejects(readMarketingResponse(new Response(JSON.stringify({ detail: 'Apply migration 0093' }), { status: 503 }), 'Facebook refresh'), /Apply migration 0093/)
  await assert.rejects(readMarketingResponse(new Response('<html>Deployment</html>'), 'Facebook refresh'), /invalid response/)
  assert.equal((await readMarketingResponse(new Response('{"status":"synced"}'), 'Facebook refresh')).status, 'synced')
})
