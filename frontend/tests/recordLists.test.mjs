import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadMarketingCampaigns, loadRfqList } from '../src/recordLists.ts'
import { loadStockBookingWorkspace, loadStockBookingTransfer } from '../src/stockBookingData.ts'

// Model the API's count, filtering, ordering and row cap, rather than returning
// pre-baked pages. This exercises the actual workspace query builders.
function database(tables, cap = 113) {
  return {
    auth: { async getUser() { return { data: { user: { id: 'me' } } } } },
    from(table) {
      let exact = false, from = 0, to = Infinity
      const filters = [], orders = []
      const q = {
        select(_columns, options) { exact = options?.count === 'exact'; return q },
        eq(key, value) { filters.push(row => row[key] === value); return q },
        is(key, value) { return q.eq(key, value) },
        order(key, options) { orders.push([key, options?.ascending !== false]); return q },
        range(a, b) { from = a; to = b; return q },
        limit(n) { to = n - 1; return q },
        async maybeSingle() { const result = await q; return { ...result, data: result.data[0] || null } },
        single() { return q.maybeSingle() },
        then(resolve, reject) {
          const rows = (tables[table] || []).filter(row => filters.every(filter => filter(row))).sort((a, b) => {
            for (const [key, asc] of orders) {
              const compared = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0
              if (compared) return asc ? compared : -compared
            }
            return 0
          })
          return Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + cap)), count: exact ? rows.length : null, error: null }).then(resolve, reject)
        },
      }
      return q
    },
  }
}

const records = Array.from({ length: 1205 }, (_, i) => ({
  id: String(i).padStart(5, '0'), received_at: i, updated_at: Math.floor(i / 3),
  created_by: i % 2 ? 'other' : 'me', deleted_at: null,
}))

test('RFQs include the newest record and every permitted unarchived record beyond 500', async () => {
  const result = await loadRfqList(database({ sales_desk_rfqs: [...records, { ...records[0], id: 'deleted', deleted_at: 'yesterday' }] }))
  assert.equal(result.count, 1205)
  assert.equal(result.data.length, 1205)
  assert.equal(result.data[0].id, '01204')
  assert.equal(result.data.at(-1).id, '00000')
  assert.equal(new Set(result.data.map(row => row.id)).size, 1205)
})

test('Marketing loads all campaign options and preserves tied sort values', async () => {
  const db = database({ posts: records, campaigns: records })
  for (const result of [await loadMarketingCampaigns(db)]) {
    assert.equal(result.count, 1205)
    assert.equal(new Set(result.data.map(row => row.id)).size, 1205)
    assert.deepEqual(result.data.slice(0, 3).map(row => row.id), ['01203', '01204', '01200'])
  }
})

test('Stock Booking and downloaded transfers include all rows beyond the response cap', async () => {
  const stock = records.map(row => ({ ...row, part_number: 'same-part', import_batch_id: 'active', transfer_batch_id: 'transfer' }))
  const db = database({
    stock_import_batches: [{ id: 'active', status: 'active' }], stock_locations: [],
    profile_roles: [{ profile_id: 'me', role_id: 'stock' }],
    stock_booking_items: [...stock, { id: 'old', import_batch_id: 'superseded' }],
    stock_transfer_batches: [{ id: 'transfer', from_location: 'WH', to_location: 'ER', remarks: 'Test' }],
    stock_transfer_items: stock,
  })
  const workspace = await loadStockBookingWorkspace(db)
  assert.equal(workspace.activeBatchId, 'active')
  assert.equal(workspace.items.length, 1205)
  assert.equal(new Set(workspace.items.map(row => row.id)).size, 1205)
  const transfer = await loadStockBookingTransfer(db, 'transfer')
  assert.equal(transfer.items.length, 1205)
  assert.ok(transfer.items.every(row => row.from_location === 'WH' && row.to_location === 'ER'))
})
