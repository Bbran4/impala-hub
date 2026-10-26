import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkStockImportRows, prepareStockImportSource } from '../src/stockImportPipeline.ts'

test('stock imports are split into bounded sequential chunks', () => {
  const rows = Array.from({ length: 1201 }, (_, index) => index + 1)
  const chunks = chunkStockImportRows(rows, 500)
  assert.deepEqual(chunks.map((chunk) => chunk.length), [500, 500, 201])
  assert.equal(chunks[0][0], 1)
  assert.equal(chunks[2][200], 1201)
})

test('empty imports produce no upload calls and chunk limits are enforced', () => {
  assert.deepEqual(chunkStockImportRows([], 500), [])
  assert.throws(() => chunkStockImportRows([1], 0), /between 1 and 2,000/i)
  assert.throws(() => chunkStockImportRows([1], 2001), /between 1 and 2,000/i)
  assert.throws(() => chunkStockImportRows([1], 1.5), /between 1 and 2,000/i)
})

test('stock import source identity requires a file name and SHA-256 checksum', () => {
  assert.deepEqual(prepareStockImportSource('manual_csv', ' stock.csv ', 'A'.repeat(64)), {
    source_type: 'manual_csv', source_name: 'stock.csv', source_checksum: 'a'.repeat(64),
  })
  assert.throws(() => prepareStockImportSource('manual_csv', ' ', 'a'.repeat(64)), /between 1 and 255/i)
  assert.throws(() => prepareStockImportSource('manual_csv', 'stock.csv', 'not-a-checksum'), /SHA-256/i)
})
