import type { SupplierWorkflow } from './returnsTypes'
type Props = { form: SupplierWorkflow; onChange: (changes: Partial<SupplierWorkflow>) => void; disabled: boolean }

export default function ReturnSupplierWorkflow({ form, onChange, disabled }: Props) {
  const field = (name: keyof SupplierWorkflow, label: string, type = 'text') => <label className="editor-field">
    <span>{label}</span><input type={type} disabled={disabled} value={form[name] ?? ''}
      min={type === 'number' ? 0 : undefined} step={name === 'credit_amount' ? '0.01' : type === 'number' ? '1' : undefined}
      onChange={event => onChange({ [name]: event.target.value })} />
  </label>
  return <>
    <div className="editor-section">
      <h3>Supplier response</h3>
      {field('supplier_name', 'Supplier')}
      {field('supplier_response_on', 'Response date', 'date')}
      <label className="editor-field"><span>Supplier response / decision</span>
        <textarea disabled={disabled} rows={3} value={form.supplier_response || ''} onChange={event => onChange({ supplier_response: event.target.value })} />
      </label>
    </div>
    <div className="editor-section">
      <h3>Credit received</h3>
      <p className="hint">Enter the received date once the supplier credit is received. A reference and amount are required.</p>
      {field('credit_reference', 'Credit note / reference')}
      {field('credit_amount', 'Credit amount (R)', 'number')}
      {field('credit_received_on', 'Credit received date', 'date')}
    </div>
    <div className="editor-section">
      <h3>Replacement received</h3>
      <p className="hint">Record the replacement delivery reference, quantity and received date.</p>
      {field('replacement_reference', 'Replacement part / delivery reference')}
      {field('replacement_qty', 'Replacement quantity', 'number')}
      {field('replacement_received_on', 'Replacement received date', 'date')}
    </div>
    <div className="editor-section">
      <h3>Pickup / drop-off</h3>
      <label className="editor-field"><span>Method</span><select disabled={disabled} value={form.handover_method || 'Not required'} onChange={event => onChange({ handover_method: event.target.value, handover_status: event.target.value === 'Not required' ? 'Not required' : 'Pending' })}>
        {['Not required','Pickup','Drop-off'].map(value => <option key={value}>{value}</option>)}
      </select></label>
      <label className="editor-field"><span>Handover status</span><select disabled={disabled || (form.handover_method || 'Not required') === 'Not required'} value={form.handover_status || 'Not required'} onChange={event => onChange({ handover_status: event.target.value })}>
        {((form.handover_method || 'Not required') === 'Not required' ? ['Not required'] : ['Pending','Scheduled','Completed']).map(value => <option key={value}>{value}</option>)}
      </select></label>
      {field('handover_scheduled_on', 'Scheduled date', 'date')}
      {field('handover_completed_on', 'Completed date', 'date')}
      {field('handover_contact', 'Responsible person / courier')}
      <label className="editor-field"><span>Pickup / drop-off notes</span><textarea disabled={disabled} rows={3} value={form.handover_notes || ''} onChange={event => onChange({ handover_notes: event.target.value })} /></label>
    </div>
  </>
}
