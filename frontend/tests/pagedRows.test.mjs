import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadAllRows } from '../src/pagedRows.ts'

for (const size of [0, 500, 501, 1000, 2507]) {
  test(`loads all ${size} records with a smaller server response cap`, async () => {
    const rows = Array.from({ length: size }, (_, id) => ({ id }))
    const requests = []
    const result = await loadAllRows(async (from, to) => {
      requests.push([from, to])
      return { data: rows.slice(from, Math.min(to + 1, from + 137)), count: rows.length, error: null }
    })
    assert.deepEqual(result.data, rows)
    assert.equal(result.count, size)
    assert.equal(requests[0][0], 0)
    if (size > 137) assert.equal(requests[1][0], 137)
  })
}

test('a later-page failure rejects the whole load rather than exposing partial rows', async () => {
  await assert.rejects(loadAllRows(async from => from === 0
    ? { data: [{ id: 1 }], count: 2, error: null }
    : { data: null, count: null, error: { message: 'Connection lost' } }), /Connection lost/)
})

test('missing rows, missing counts and changing totals cannot masquerade as complete results', async () => {
  await assert.rejects(loadAllRows(async () => ({ data: [], count: 1, error: null })), /Some records/)
  await assert.rejects(loadAllRows(async () => ({ data: [], count: null, error: null })), /record count/)
  await assert.rejects(loadAllRows(async from => ({ data: [{ id: from }], count: from === 0 ? 2 : 3, error: null })), /changed while loading/)
})
