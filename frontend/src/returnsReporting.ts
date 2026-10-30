import type { Claim, ClaimForm, ClaimValues } from './returnsTypes'
type StatusValues = Pick<ClaimValues, 'status'> & Partial<ClaimValues>
type TimingValues = Pick<ClaimForm, 'date' | 'status'> & Partial<Pick<ClaimForm, 'closed_at' | 'updated_at' | 'sla_days'>>
export const CLAIM_STATUSES = ['Waiting for Info from Customer','Waiting for Reply from Supplier','In Progress','Completed','Awaiting Pickup/dropoff at supplier','Rejected']
export const isClosedClaim = (status: string) => status === 'Completed' || status === 'Rejected'
const normalizedReason = (value: unknown) => String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
export function allowedClaimStatuses(previous?: string) {
  if (!previous) return CLAIM_STATUSES.filter(status => !isClosedClaim(status))
  return isClosedClaim(previous) ? [previous, 'In Progress'] : CLAIM_STATUSES
}
export function validateClaimStatus(previous: StatusValues | null, next: StatusValues) {
  if (!CLAIM_STATUSES.includes(next.status)) throw new Error('Choose a valid claim status.')
  if (!previous && isClosedClaim(next.status)) throw new Error('Create the claim in an open status first.')
  const changed = previous?.status !== next.status
  if (changed && previous && isClosedClaim(previous.status) && next.status !== 'In Progress') throw new Error('Reopen the claim to In Progress before changing to another status.')
  if (changed && (next.status === 'Rejected' || (previous && isClosedClaim(previous.status))) && (!normalizedReason(next.status_change_reason) || normalizedReason(next.status_change_reason) === normalizedReason(previous?.status_change_reason))) throw new Error('Enter a new reason for rejecting or reopening the claim.')
  if (changed && next.status === 'Waiting for Reply from Supplier' && !String(next.supplier_name || '').trim()) throw new Error('Enter the supplier before waiting for a reply.')
  if (changed && next.status === 'Awaiting Pickup/dropoff at supplier' && (!['Pickup','Drop-off'].includes(next.handover_method || '') || !['Pending','Scheduled'].includes(next.handover_status || ''))) throw new Error('Choose a pending or scheduled pickup/drop-off.')
  const receiptChanged = previous && (['outcome_request','credit_received_on','replacement_received_on','handover_method','handover_status'] as const).some(field => (previous[field] || null) !== (next[field] || null))
  if (next.status === 'Completed' && (changed || receiptChanged)) {
    if (!['Credit','Replacement Part'].includes(next.outcome_request || '')) throw new Error('Choose the requested outcome before completing the claim.')
    if (next.outcome_request === 'Credit' && !next.credit_received_on) throw new Error('Record credit receipt before completing the claim.')
    if (next.outcome_request === 'Replacement Part' && !next.replacement_received_on) throw new Error('Record replacement receipt before completing the claim.')
    if (next.handover_method && next.handover_method !== 'Not required' && next.handover_status !== 'Completed') throw new Error('Complete the pickup/drop-off before completing the claim.')
  }
  const sla = Number(next.sla_days ?? 7)
  if (!Number.isInteger(sla) || sla < 1 || sla > 365) throw new Error('SLA must be between 1 and 365 calendar days.')
}

export function johannesburgDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const part = (type: string) => parts.find(value => value.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}
const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000)
const dayString = (day: number) => new Date(day * 86400000).toISOString().slice(0, 10)
export function claimTiming(row: TimingValues, today = johannesburgDate()) {
  const start = dayNumber(row.date)
  const closed = isClosedClaim(row.status)
  const closedStamp = row.closed_at || row.updated_at
  const end = closed && closedStamp ? dayNumber(johannesburgDate(new Date(closedStamp))) : dayNumber(today)
  const dueDay = start + Number(row.sla_days ?? 7)
  const lateDays = Math.max(0, end - dueDay)
  const remaining = dueDay - dayNumber(today)
  const overdue = !closed && remaining < 0
  const dueSoon = !closed && remaining >= 0 && remaining <= 2
  return { age_days: Math.max(0, end - start), due_on: dayString(dueDay), overdue, due_soon: dueSoon, late_days: lateDays,
    label: closed ? (lateDays ? 'Closed late' : 'Closed') : overdue ? 'Overdue' : dueSoon ? (remaining === 0 ? 'Due today' : 'Due soon') : 'On track',
    tone: closed ? 'closed' : overdue ? 'overdue' : dueSoon ? 'soon' : 'on-track' }
}
export function matchesClaimDates(row: TimingValues, from: string, to: string, sla: string, today: string) {
  if (from && row.date < from || to && row.date > to) return false
  const timing = claimTiming(row, today)
  return sla === 'overdue' ? timing.overdue : sla === 'due-soon' ? timing.due_soon : sla === 'open' ? !isClosedClaim(row.status) : true
}
export function summarizeClaims(rows: (TimingValues & Partial<Pick<Claim, 'credit_received_on' | 'credit_amount'>>)[], today: string) {
  const timings = rows.map(row => claimTiming(row, today))
  return { total: rows.length, open: rows.filter(row => !isClosedClaim(row.status)).length,
    overdue: timings.filter(value => value.overdue).length, dueSoon: timings.filter(value => value.due_soon).length,
    completed: rows.filter(row => row.status === 'Completed').length, rejected: rows.filter(row => row.status === 'Rejected').length,
    averageAge: rows.length ? Math.round(timings.reduce((total, value) => total + value.age_days, 0) / rows.length * 10) / 10 : 0,
    creditReceived: rows.reduce((total, row) => total + (row.credit_received_on ? Number(row.credit_amount || 0) : 0), 0) }
}
export function claimReportRows(rows: Claim[], today: string) {
  return rows.map(row => { const timing = claimTiming(row, today); return {
    Reference: row.claim_no || row.id, Date: row.date, Company: row.company, 'RFC book': row.rfc_book_number, Customer: row.customer,
    'Contact person': row.contact_person, 'Contact number': row.contact_number, Invoice: row.invoice_number, 'Invoice date': row.invoice_date,
    Reason: row.reason, 'Part number': row.part_number, Description: row.description, Quantity: Number(row.qty), Status: row.status,
    'Age (calendar days)': timing.age_days, 'SLA (calendar days)': Number(row.sla_days ?? 7), 'Due date': timing.due_on, 'SLA indicator': timing.label,
    'Closed at (UTC)': row.closed_at || '', Outcome: row.outcome_request || '', Supplier: row.supplier_name || '', 'Supplier response': row.supplier_response || '',
    'Response date': row.supplier_response_on || '', 'Credit reference': row.credit_reference || '', 'Credit amount (R)': row.credit_amount == null ? '' : Number(row.credit_amount),
    'Credit received': row.credit_received_on || '', 'Replacement reference': row.replacement_reference || '', 'Replacement quantity': row.replacement_qty == null ? '' : Number(row.replacement_qty),
    'Replacement received': row.replacement_received_on || '', 'Handover method': row.handover_method || '', 'Handover status': row.handover_status || '',
    'Handover scheduled': row.handover_scheduled_on || '', 'Handover completed': row.handover_completed_on || '', 'Handover contact': row.handover_contact || '',
    'Handover notes': row.handover_notes || '', Comments: row.comments || '' }
  })
}
export function csvCell(value: unknown) {
  let text = String(value ?? '')
  if (typeof value === 'string' && (/^\s*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))) text = `'${text}`
  return `"${text.replaceAll('"','""')}"`
}
export function claimsCsv(rows: Record<string, string | number | null | undefined>[]) {
  if (!rows.length) throw new Error('No claims match the selected filters.')
  const headers = Object.keys(rows[0])
  return '\uFEFF' + [headers.map(csvCell).join(','), ...rows.map(row => headers.map(header => csvCell(row[header])).join(','))].join('\r\n')
}
