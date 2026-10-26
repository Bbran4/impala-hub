import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchesStockQuery, prepareStockQueryPayload, stockSupplierUnitCost } from '../src/stockPartsQueries.ts'

test('Parts Query payload trims fields and omits blank supplier rows', () => {
  assert.deepEqual(prepareStockQueryPayload({
    part_number: '  ABC-123 ', description: ' Brake pad set ', qty: '4', sales_code_id: '',
    development_status: ' New ', status: 'In Progress',
    suppliers: [
      { supplier: ' Supplier A ', qty: '3', cost: '300', msrp: '', notes: ' quoted ' },
      { supplier: '   ', qty: 1, cost: '', msrp: '', notes: '' },
    ],
  }), {
    part_number: 'ABC-123', description: 'Brake pad set', qty: 4, sales_code_id: null,
    development_status: 'New', status: 'In Progress',
    suppliers: [{ supplier: 'Supplier A', qty: 3, cost: 300, msrp: null, notes: 'quoted' }],
  })
})

test('Parts Query payload rejects invalid parent and supplier values', () => {
  const valid = { part_number: 'P1', description: 'Part', qty: 1, development_status: 'New', status: 'In Progress', suppliers: [] }
  assert.throws(() => prepareStockQueryPayload({ ...valid, part_number: ' ' }), /part number/i)
  assert.throws(() => prepareStockQueryPayload({ ...valid, qty: 1.5 }), /whole number/i)
  assert.throws(() => prepareStockQueryPayload({ ...valid, status: 'Unknown' }), /valid Parts Query status/i)
  assert.throws(() => prepareStockQueryPayload({ ...valid, suppliers: [{ supplier: 'A', qty: 0, cost: 1 }] }), /Quantity for A/i)
  assert.throws(() => prepareStockQueryPayload({ ...valid, suppliers: [{ supplier: 'A', qty: 1, cost: -1 }] }), /cost/i)
})

test('supplier unit cost uses quote quantity and keeps missing cost unknown', () => {
  assert.equal(stockSupplierUnitCost({ cost: 300, qty: 3 }), 100)
  assert.equal(stockSupplierUnitCost({ cost: null, qty: 3 }), null)
  assert.equal(stockSupplierUnitCost({ cost: 300, qty: 0 }), null)
})

test('Parts Query search covers references, sales codes and supplier notes', () => {
  const query = {
    id: 'uuid', reference: 'PQ-20261026-000001', legacy_id: 'PQ-20261026-ABC123', created_at: '2026-10-26T00:00:00Z',
    part_number: '33215', description: 'Brake component', qty: 2, sales_code_id: null, sales_code: 'BB01',
    development_status: 'New', status: 'In Progress', suppliers: [{ supplier: 'Supplier A', qty: 2, cost: 200, msrp: 300, notes: 'UniqueToken' }],
  }
  assert.equal(matchesStockQuery(query, '000001'), true)
  assert.equal(matchesStockQuery(query, 'bb01'), true)
  assert.equal(matchesStockQuery(query, 'uniquetoken'), true)
  assert.equal(matchesStockQuery(query, 'missing'), false)
})
