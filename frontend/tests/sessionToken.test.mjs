import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AuthError, readSupabaseToken } from '../src/sessionToken.ts'

test('every authenticated request reads the current session including a refreshed token', async () => {
  let token = 'first'
  let calls = 0
  const client = { auth: { async getSession() { calls++; return { data: { session: { access_token: token } }, error: null } } } }
  assert.equal(await readSupabaseToken(client), 'first')
  token = 'refreshed'
  assert.equal(await readSupabaseToken(client), 'refreshed')
  assert.equal(calls, 2)
})

test('missing or invalid sessions fail without consulting browser storage', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Must not read persisted token') } })
  try {
    await assert.rejects(readSupabaseToken({ auth: { async getSession() { return { data: { session: null }, error: null } } } }), AuthError)
    await assert.rejects(readSupabaseToken({ auth: { async getSession() { return { data: { session: { access_token: 'stale' } }, error: { message: 'expired' } } } } }), AuthError)
    await assert.rejects(readSupabaseToken(null), AuthError)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete globalThis.localStorage
  }
})
