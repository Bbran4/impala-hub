export const supplierWorkflowFields = [
  'supplier_name', 'supplier_response', 'supplier_response_on', 'credit_received_on', 'credit_reference', 'credit_amount',
  'replacement_received_on', 'replacement_reference', 'replacement_qty', 'handover_method', 'handover_status',
  'handover_scheduled_on', 'handover_completed_on', 'handover_contact', 'handover_notes',
]
const dateFields = ['supplier_response_on','credit_received_on','replacement_received_on','handover_scheduled_on','handover_completed_on']

export function prepareSupplierWorkflow(form: Record<string, any>) {
  const result = Object.fromEntries(supplierWorkflowFields.map(field => [field, form[field]]).filter(([, value]) => value !== undefined))
  for (const field of dateFields) if (field in result) result[field] = result[field] || null
  for (const field of ['credit_amount','replacement_qty']) {
    if (field in result) result[field] = result[field] === '' || result[field] == null ? null : Number(result[field])
  }
  if (result.credit_amount != null && (!Number.isFinite(result.credit_amount) || result.credit_amount < 0)) throw new Error('Credit amount must be zero or greater.')
  if (result.replacement_qty != null && (!Number.isInteger(result.replacement_qty) || result.replacement_qty <= 0)) throw new Error('Replacement quantity must be a positive whole number.')
  if (result.credit_received_on && (!String(result.credit_reference || '').trim() || result.credit_amount == null)) throw new Error('Enter a credit reference and amount before marking credit received.')
  if (result.replacement_received_on && (!String(result.replacement_reference || '').trim() || result.replacement_qty == null)) throw new Error('Enter a replacement reference and quantity before marking replacement received.')
  if (result.handover_status === 'Scheduled' && !result.handover_scheduled_on) throw new Error('Enter the scheduled pickup/drop-off date.')
  if (result.handover_status === 'Completed' && !result.handover_completed_on) throw new Error('Enter the completed pickup/drop-off date.')
  if ((result.handover_method || 'Not required') === 'Not required' && (result.handover_status || 'Not required') !== 'Not required') throw new Error('Choose Pickup or Drop-off before tracking a handover.')
  if (result.handover_method && result.handover_method !== 'Not required' && result.handover_status === 'Not required') throw new Error('Choose a pickup/drop-off status.')
  return result
}
