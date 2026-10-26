import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareSupplierWorkflow } from '../src/returnsWorkflow.ts'

test('an undecided supplier workflow can be saved without receipt details', () => {
  assert.deepEqual(prepareSupplierWorkflow({ credit_amount: '', replacement_qty: '', credit_received_on: '' }), { credit_amount: null, replacement_qty: null, credit_received_on: null })
})
test('credit receipt requires reference and amount; zero-value credit is permitted', () => {
  assert.throws(() => prepareSupplierWorkflow({ credit_received_on: '2026-10-26' }))
  assert.throws(() => prepareSupplierWorkflow({ credit_received_on: '2026-10-26', credit_reference: 'CN1', credit_amount: -1 }))
  assert.equal(prepareSupplierWorkflow({ credit_received_on: '2026-10-26', credit_reference: 'CN1', credit_amount: '0' }).credit_amount, 0)
})
test('replacement receipt requires reference and a whole positive quantity', () => {
  assert.throws(() => prepareSupplierWorkflow({ replacement_received_on: '2026-10-26', replacement_qty: '1' }))
  for (const replacement_qty of [-1, 0, 1.5, 'bad']) assert.throws(() => prepareSupplierWorkflow({ replacement_qty }))
  assert.equal(prepareSupplierWorkflow({ replacement_received_on: '2026-10-26', replacement_reference: 'DN1', replacement_qty: '2' }).replacement_qty, 2)
})
test('handover scheduling and completion require their respective dates and method', () => {
  assert.throws(() => prepareSupplierWorkflow({ handover_method: 'Pickup', handover_status: 'Scheduled' }))
  assert.throws(() => prepareSupplierWorkflow({ handover_method: 'Drop-off', handover_status: 'Completed' }))
  assert.throws(() => prepareSupplierWorkflow({ handover_method: 'Not required', handover_status: 'Pending' }))
  assert.doesNotThrow(() => prepareSupplierWorkflow({ handover_method: 'Pickup', handover_status: 'Scheduled', handover_scheduled_on: '2026-10-27' }))
  assert.doesNotThrow(() => prepareSupplierWorkflow({ handover_method: 'Drop-off', handover_status: 'Completed', handover_completed_on: '2026-10-27' }))
})
test('workflow payload excludes IDs and display-only fields', () => {
  assert.deepEqual(prepareSupplierWorkflow({ id: 'uuid', claim_no: 'RC2026102601', stored_attachments: [], supplier_name: 'Supplier' }), { supplier_name: 'Supplier' })
})
