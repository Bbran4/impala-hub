import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareStockLocation, prepareStockThresholds } from '../src/stockConfigurationData.ts'

test('stock location configuration is trimmed and normalized', () => {
  assert.deepEqual(prepareStockLocation({
    name: '  WH-A ', description: ' Main warehouse ', vehicle_name: ' Truck 1 ', supply_branch: 'PTA', color: '#DFF7FF',
  }), {
    name: 'WH-A', description: 'Main warehouse', vehicle_name: 'Truck 1', supply_branch: 'pta', color: '#dff7ff',
  })
})

test('stock locations reject invalid names, branches and colors', () => {
  const valid = { name: 'WH-A', description: '', vehicle_name: '', supply_branch: '', color: '#dff7ff' }
  assert.throws(() => prepareStockLocation({ ...valid, name: ' ' }), /name/i)
  assert.throws(() => prepareStockLocation({ ...valid, supply_branch: 'cape-town' }), /supply branch/i)
  assert.throws(() => prepareStockLocation({ ...valid, color: 'blue' }), /highlight color/i)
})

test('stock thresholds allow a shared boundary and reject invalid ranges', () => {
  assert.deepEqual(prepareStockThresholds('2.5', '10'), { slow_max_avg_sales: 2.5, ab_min_avg_sales: 10 })
  assert.deepEqual(prepareStockThresholds(5, 5), { slow_max_avg_sales: 5, ab_min_avg_sales: 5 })
  assert.throws(() => prepareStockThresholds(-1, 10), /zero or greater/i)
  assert.throws(() => prepareStockThresholds(10, 2), /cannot be lower/i)
  assert.throws(() => prepareStockThresholds('not-a-number', 10), /zero or greater/i)
})
