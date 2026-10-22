import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ClipboardList, Download, Eye, GripVertical, Paperclip, Plus, Settings, Trash2, X } from 'lucide-react'
import { API } from './lib'
import './salesdesk.css'

const FILE_ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.pdf,.doc,.docx,.xls,.xlsx'
const pad = (n: number) => String(n).padStart(2, '0')
const toLocalInput = (value?: string | null) => {
  if (!value) return ''
  const d = new Date(value)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const toIso = (local: string) => new Date(local).toISOString()
const fmtDate = (v?: string | null, empty = '—') => (v ? new Date(v).toLocaleString() : empty)
const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const formatRand = (value: number) => 'R' + value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const TEMP_MONTHLY_GROSS_SALES = 792436.44
const TEMP_MONTHLY_GP_PERCENT = 25.33
const GP_COLORS = [
  ['red', 'Red'], ['grey', 'Grey'], ['light-blue', 'Light blue'], ['dark-blue', 'Dark blue'],
  ['green', 'Green'], ['orange', 'Orange'], ['purple', 'Purple'], ['teal', 'Teal'],
  ['yellow', 'Yellow'], ['pink', 'Pink'], ['navy', 'Navy'], ['brown', 'Brown'],
] as const

const TEMP_DAILY_SALES = [
  { name: 'Brenton', total: 0, credits: 0, gross: 0, gp: 0 },
  { name: 'Charles', total: 24722.13, credits: 0, gross: 24722.13, gp: 23.83 },
  { name: 'Fredrik', total: 56186.21, credits: 0, gross: 56186.21, gp: 9.09 },
  { name: 'Ian', total: 7200, credits: 0, gross: 7200, gp: 24.58 },
  { name: 'Jan', total: 14250, credits: -6490, gross: 7760, gp: 50.66 },
  { name: 'Miguel', total: 825, credits: 0, gross: 825, gp: 30.67 },
]

function describeDetail(detail: unknown, status: number): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) return detail.map((d: any) => d?.msg || 'Invalid value').join('; ')
  return `Sales Desk request failed (${status})`
}

type Req = (path: string, init?: RequestInit) => Promise<any>
type Props = { page: string; token: string; setNotice: (m: string) => void; setError: (m: string) => void }

// ---------------------------------------------------------------------------------------------
// Drag-and-drop list used for media platforms and statuses.
function Sortable<T extends { id: string }>({ items, onReorder, children }: {
  items: T[]
  onReorder: (ids: string[]) => void
  children: (item: T) => ReactNode
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const reset = () => { setDragId(null); setOverId(null) }
  function drop(targetId: string) {
    if (dragId && dragId !== targetId) {
      const ids = items.map((i) => i.id)
      ids.splice(ids.indexOf(dragId), 1)
      ids.splice(ids.indexOf(targetId), 0, dragId)
      onReorder(ids)
    }
    reset()
  }
  return (
    <>
      {items.map((item) => (
        <div
          key={item.id}
          className={`sd-sortable ${overId === item.id && dragId !== item.id ? 'over' : ''} ${dragId === item.id ? 'dragging' : ''}`}
          draggable
          onDragStart={(e) => { setDragId(item.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', item.id) }}
          onDragOver={(e) => { e.preventDefault(); setOverId(item.id) }}
          onDrop={(e) => { e.preventDefault(); drop(item.id) }}
          onDragEnd={reset}
        >
          <span className="sd-grip" title="Drag to reorder" aria-hidden="true"><GripVertical size={16} /></span>
          <div className="sd-sortable-body">{children(item)}</div>
        </div>
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------------------------
type Form = {
  media_platform_id: string; customer_name: string; contact_number: string; email_address: string
  query_information: string; received_at: string; claimed_at: string; sales_code_id: string
  status_id: string; remarks: string; document_number: string
}
const formFrom = (r: any): Form => ({
  media_platform_id: r?.media_platform_id || '', customer_name: r?.customer_name || '',
  contact_number: r?.contact_number || '', email_address: r?.email_address || '',
  query_information: r?.query_information || '', received_at: toLocalInput(r?.received_at),
  claimed_at: toLocalInput(r?.claimed_at), sales_code_id: r?.sales_code_id || '',
  status_id: r?.status_id || '', remarks: r?.remarks || '', document_number: r?.document_number || '',
})
const SALESPERSON_KEYS: (keyof Form)[] = ['customer_name', 'contact_number', 'email_address', 'query_information', 'received_at', 'claimed_at', 'remarks', 'document_number']
const CHANGE_LABELS: Record<string, string> = {
  media_platform: 'Media platform', customer_name: 'Customer', contact_number: 'Contact number', email_address: 'Email',
  query_information: 'Query', remarks: 'Remarks', status: 'Status', document_number: 'Document number',
  received_at: 'Received', claimed_at: 'Claimed',
}
const shorten = (v: unknown) => {
  const text = v == null || v === '' ? '—' : String(v)
  return text.length > 60 ? text.slice(0, 57) + '…' : text
}
function describeHistory(h: any): string {
  const c = h.changes || {}
  switch (h.action) {
    case 'created': return `Created ${c.rfq_no || ''}${c.sales_code ? ` for ${c.sales_code}` : ''}`
    case 'claimed': return `Claimed by ${c.sales_code}`
    case 'assigned': case 'reassigned': case 'unassigned':
      return `${h.action[0].toUpperCase() + h.action.slice(1)}: ${shorten(c.from_sales_code)} → ${shorten(c.to_sales_code)}`
    case 'converted_to_invoice': return `Converted to invoice: ${c.from_rfq_no} → ${c.to_rfq_no}`
    case 'attachment_added': return `Attachment added: ${c.file}`
    case 'updated':
      return Object.entries(c).map(([k, v]: [string, any]) => {
        const stamp = k === 'received_at' || k === 'claimed_at'
        const show = (x: unknown) => (stamp && x ? fmtDate(String(x)) : shorten(x))
        return `${CHANGE_LABELS[k] || k}: ${show(v.from)} → ${show(v.to)}`
      }).join(' · ')
    default: return h.action
  }
}

// ---------------------------------------------------------------------------------------------
// The RFQ side panel. Used for both "New RFQ" and viewing/editing an existing RFQ.
function RfqPanel({ mode, rfqId, config, user, token, request, onClose, onChanged, setNotice, setError }: {
  mode: 'create' | 'edit'; rfqId?: string; config: any; user: any; token: string; request: Req
  onClose: () => void; onChanged: () => Promise<void>; setNotice: (m: string) => void; setError: (m: string) => void
}) {
  const isSales = user?.role === 'salesperson'
  const [rfq, setRfq] = useState<any>(null)
  const [initial, setInitial] = useState<Form>(() => ({ ...formFrom(null), received_at: toLocalInput(new Date().toISOString()) }))
  const [form, setForm] = useState<Form>(initial)
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(mode === 'edit')

  const load = useCallback(async () => {
    if (mode !== 'edit' || !rfqId) return
    try {
      const detail = await request(`/api/sales-desk/rfqs/${rfqId}`)
      setRfq(detail); const f = formFrom(detail); setInitial(f); setForm(f)
    } catch (e) { setError((e as Error).message); onClose() } finally { setLoading(false) }
  }, [mode, rfqId, request, setError, onClose])
  useEffect(() => { void load() }, [load])

  // New RFQ: default to the first active media platform.
  useEffect(() => {
    if (mode !== 'create') return
    const first = config.media_platforms.find((m: any) => m.is_active)?.id || ''
    setInitial((i) => ({ ...i, media_platform_id: first })); setForm((f) => ({ ...f, media_platform_id: f.media_platform_id || first }))
  }, [mode, config.media_platforms])

  const ownRfq = !!rfq && (!isSales || (!!rfq.sales_code && rfq.sales_code.toLowerCase() === (user.sales_code || '').toLowerCase()))
  const readOnly = mode === 'edit' && !ownRfq // a consultant looking at an unclaimed RFQ
  const lockedForSales = isSales // media platform, sales code and status are never editable by consultants
  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || files.length > 0

  const requestClose = useCallback(() => {
    if (dirty && !window.confirm('Discard your unsaved changes?')) return
    onClose()
  }, [dirty, onClose])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestClose])

  const set = (changes: Partial<Form>) => setForm((f) => ({ ...f, ...changes }))
  const newStatusId = config.statuses.find((s: any) => s.name.toLowerCase() === 'new' && s.is_active)?.id
  const unclaimedId = config.statuses.find((s: any) => s.name.toLowerCase() === 'unclaimed')?.id
  function chooseSalesCode(id: string) {
    const changes: Partial<Form> = { sales_code_id: id }
    if (!id) changes.claimed_at = '' // no code, no claimed date
    if (id && (!form.status_id || form.status_id === unclaimedId) && newStatusId) changes.status_id = newStatusId
    set(changes)
  }

  async function uploadAll(id: string, list: File[]) {
    let latest: any = null; const failed: string[] = []
    for (const file of list) {
      const fd = new FormData(); fd.append('file', file)
      try { latest = await request(`/api/sales-desk/rfqs/${id}/attachments`, { method: 'POST', body: fd }) }
      catch (e) { failed.push(`${file.name}: ${(e as Error).message}`) }
    }
    return { latest, failed }
  }

  async function save() {
    setBusy(true); setError('')
    try {
      if (!form.customer_name.trim()) throw new Error('Enter the customer name.')
      if (!form.received_at) throw new Error('Enter the received date.')
      if (mode === 'create') {
        if (!form.media_platform_id) throw new Error('Choose a media platform.')
        const body: any = {
          media_platform_id: form.media_platform_id, customer_name: form.customer_name, contact_number: form.contact_number,
          email_address: form.email_address, query_information: form.query_information, remarks: form.remarks,
          document_number: form.document_number, received_at: toIso(form.received_at),
        }
        if (form.status_id) body.status_id = form.status_id
        if (form.sales_code_id) body.sales_code_id = form.sales_code_id
        if (form.claimed_at) body.claimed_at = toIso(form.claimed_at)
        const created = await request('/api/sales-desk/rfqs', { method: 'POST', body: JSON.stringify(body) })
        const { failed } = await uploadAll(created.id, files)
        await onChanged()
        if (failed.length) setError(`RFQ ${created.rfq_no} was created, but some files were not attached: ${failed.join('; ')}`)
        setNotice(`RFQ ${created.rfq_no} created.`)
        onClose()
        return
      }
      // Edit: send only what changed, so an untouched sales code or claimed date is never rewritten.
      const body: any = {}
      for (const key of Object.keys(form) as (keyof Form)[]) {
        if (form[key] === initial[key]) continue
        if (isSales && !SALESPERSON_KEYS.includes(key)) continue
        if (key === 'received_at') body[key] = toIso(form[key])
        else if (key === 'claimed_at') body[key] = form[key] ? toIso(form[key]) : null
        else if (key === 'sales_code_id') body[key] = form[key] || null
        else body[key] = form[key]
      }
      if (!Object.keys(body).length) { setNotice('There are no changes to save.'); return }
      const updated = await request(`/api/sales-desk/rfqs/${rfqId}`, { method: 'PATCH', body: JSON.stringify(body) })
      setRfq(updated); const f = formFrom(updated); setInitial(f); setForm(f)
      setNotice('RFQ changes saved.')
      await onChanged()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  async function addAttachments(input: HTMLInputElement) {
    const list = input.files ? Array.from(input.files) : []
    input.value = ''
    if (!list.length) return
    if (mode === 'create') { setFiles((f) => [...f, ...list]); return }
    setBusy(true); setError('')
    try {
      const { latest, failed } = await uploadAll(rfqId!, list)
      if (latest) setRfq(latest)
      if (failed.length) setError(failed.join('; ')); else setNotice(`${list.length} attachment${list.length === 1 ? '' : 's'} added.`)
      await onChanged()
    } finally { setBusy(false) }
  }

  async function openAttachment(att: any, inline: boolean) {
    const viewer = inline ? window.open('about:blank', '_blank') : null // opened first so the browser allows it
    try {
      const res = await fetch(`${API}/api/sales-desk/rfqs/${rfqId}/attachments/${att.id}?inline=${inline}`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `Could not open the file (${res.status})`)
      const url = URL.createObjectURL(await res.blob())
      if (viewer) viewer.location.href = url
      else { const a = document.createElement('a'); a.href = url; a.download = att.original_name; document.body.appendChild(a); a.click(); a.remove() }
      setTimeout(() => URL.revokeObjectURL(url), 120000)
    } catch (e) { viewer?.close(); setError((e as Error).message) }
  }

  async function claim() {
    setBusy(true); setError('')
    try {
      const updated = await request(`/api/sales-desk/rfqs/${rfqId}/claim`, { method: 'POST' })
      setRfq(updated); const f = formFrom(updated); setInitial(f); setForm(f)
      setNotice(`Claimed ${updated.rfq_no} for your sales code.`)
      await onChanged()
    } catch (e) { setError((e as Error).message); await onChanged(); await load() } finally { setBusy(false) }
  }

  const codeLabel = (c: any) => `${c.code} · ${c.consultant_name || c.display_name}`
  const mediaChoices = config.media_platforms.filter((m: any) => m.is_active || m.id === form.media_platform_id)
  const statusChoices = config.statuses.filter((s: any) => s.is_active || s.id === form.status_id)
  const codeChoices = config.sales_codes.filter((c: any) => c.is_active || c.id === form.sales_code_id)
  const disabled = readOnly || busy

  return (
    <div className="overlay">
      <section className="editor" role="dialog" aria-modal="true" aria-label={mode === 'create' ? 'New RFQ' : 'RFQ details'}>
        <header className="editor-head">
          <div>
            <span className="eyebrow">{mode === 'create' ? 'NEW RFQ' : rfq?.rfq_type === 'invoice' ? 'INVOICE' : 'QUOTE'}</span>
            <h2>{mode === 'create' ? 'New RFQ' : rfq?.rfq_no || 'RFQ details'}</h2>
          </div>
          <button className="icon-button" aria-label="Close" onClick={requestClose}><X size={20} /></button>
        </header>
        {loading ? <div className="editor-body"><p className="hint">Loading…</p></div> : (
          <div className="editor-body">
            {mode === 'edit' && <p className="hint sd-panel-note">The RFQ number is generated automatically and cannot be changed.{rfq?.original_rfq_no ? ` Originally quote ${rfq.original_rfq_no}.` : ''}</p>}
            {readOnly && <p className="hint sd-panel-note">This RFQ is unclaimed. Claim it to edit it.</p>}

            <label htmlFor="rfq-media">Media platform</label>
            <select id="rfq-media" disabled={disabled || lockedForSales} value={form.media_platform_id} onChange={(e) => set({ media_platform_id: e.target.value })}>
              <option value="">Choose platform</option>
              {mediaChoices.map((m: any) => <option key={m.id} value={m.id}>{m.name}{m.is_active ? '' : ' (inactive)'}</option>)}
            </select>

            <label htmlFor="rfq-customer">Customer name</label>
            <input id="rfq-customer" disabled={disabled} maxLength={200} value={form.customer_name} onChange={(e) => set({ customer_name: e.target.value })} />

            <label htmlFor="rfq-contact">Customer contact</label>
            <input id="rfq-contact" disabled={disabled} maxLength={80} value={form.contact_number} onChange={(e) => set({ contact_number: e.target.value })} />

            <label htmlFor="rfq-email">Email</label>
            <input id="rfq-email" type="email" disabled={disabled} maxLength={254} value={form.email_address} onChange={(e) => set({ email_address: e.target.value })} />

            <label htmlFor="rfq-query">Query</label>
            <textarea id="rfq-query" rows={4} disabled={disabled} value={form.query_information} onChange={(e) => set({ query_information: e.target.value })} />

            <label htmlFor="rfq-received">Received date <span>Editable</span></label>
            <input id="rfq-received" type="datetime-local" disabled={disabled} value={form.received_at} onChange={(e) => set({ received_at: e.target.value })} />

            <label htmlFor="rfq-code">Sales code <span>{lockedForSales ? 'Only a manager or administrator can change this.' : 'Saved with the rest of the form when you press Save.'}</span></label>
            <select id="rfq-code" disabled={disabled || lockedForSales} value={form.sales_code_id} onChange={(e) => chooseSalesCode(e.target.value)}>
              <option value="">Unassigned</option>
              {codeChoices.map((c: any) => <option key={c.id} value={c.id}>{codeLabel(c)}{c.is_active ? '' : ' (inactive)'}</option>)}
            </select>

            <label htmlFor="rfq-claimed">Claimed date <span>{form.sales_code_id ? 'Editable. Leave blank on a new assignment to use the time of saving.' : 'Choose a sales code first.'}</span></label>
            <input id="rfq-claimed" type="datetime-local" disabled={disabled || !form.sales_code_id} value={form.claimed_at} onChange={(e) => set({ claimed_at: e.target.value })} />

            <label htmlFor="rfq-status">Status</label>
            <select id="rfq-status" disabled={disabled || lockedForSales} value={form.status_id} onChange={(e) => set({ status_id: e.target.value })}>
              {mode === 'create' && <option value="">Automatic ({form.sales_code_id ? 'New' : 'Unclaimed'})</option>}
              {statusChoices.map((s: any) => <option key={s.id} value={s.id}>{s.name}{s.is_active ? '' : ' (inactive)'}</option>)}
            </select>

            <label htmlFor="rfq-remarks">Remarks</label>
            <textarea id="rfq-remarks" rows={3} disabled={disabled} value={form.remarks} onChange={(e) => set({ remarks: e.target.value })} />

            <label htmlFor="rfq-doc">Document number</label>
            <input id="rfq-doc" disabled={disabled} maxLength={120} value={form.document_number} onChange={(e) => set({ document_number: e.target.value })} />

            <div className="editor-label-row">
              <label id="lbl-attach">Attachments <span>Images, PDF, Word or Excel, up to 15 MB each. Once added, attachments cannot be removed.</span></label>
              {!readOnly && (
                <label className="upload-button">
                  <Paperclip size={16} /> Add files
                  <input type="file" multiple accept={FILE_ACCEPT} disabled={busy} onChange={(e) => void addAttachments(e.target)} />
                </label>
              )}
            </div>
            <ul className="sd-attachments">
              {mode === 'create' && files.map((f, i) => (
                <li key={f.name + i}>
                  <span className="sd-file-name">{f.name}</span><small>{fmtSize(f.size)} · will be attached when you save</small>
                  <button className="icon-button" aria-label={`Remove ${f.name} before saving`} onClick={() => setFiles((list) => list.filter((_, j) => j !== i))}><X size={14} /></button>
                </li>
              ))}
              {(rfq?.attachments || []).map((a: any) => (
                <li key={a.id}>
                  <span className="sd-file-name">{a.original_name}</span>
                  <small>{fmtSize(a.size)} · {a.uploaded_by_name || 'Unknown'} · {fmtDate(a.created_at)}</small>
                  {(a.content_type.startsWith('image/') || a.content_type === 'application/pdf') && (
                    <button className="secondary" onClick={() => void openAttachment(a, true)}><Eye size={14} /> View</button>
                  )}
                  <button className="secondary" onClick={() => void openAttachment(a, false)}><Download size={14} /> Download</button>
                </li>
              ))}
              {!files.length && !(rfq?.attachments || []).length && <li className="sd-no-files">No attachments</li>}
            </ul>

            {mode === 'edit' && rfq?.audit_history?.length > 0 && (
              <div className="sd-history">
                <h4>History</h4>
                {rfq.audit_history.slice().reverse().map((h: any, i: number) => (
                  <p key={i}><b>{fmtDate(h.created_at)}</b> · {describeHistory(h)}</p>
                ))}
              </div>
            )}
          </div>
        )}
        <footer className="editor-foot">
          <button className="secondary" onClick={requestClose}>{readOnly ? 'Close' : 'Cancel'}</button>
          {readOnly && isSales && <button className="primary" disabled={busy} onClick={() => void claim()}>Claim this RFQ</button>}
          {!readOnly && <button className="primary" disabled={busy || loading || (mode === 'edit' && !dirty)} onClick={() => void save()}>{busy ? 'Saving…' : mode === 'create' ? 'Create RFQ' : 'Save changes'}</button>}
        </footer>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
export default function SalesDesk({ page, token, setNotice, setError }: Props) {
  const [user, setUser] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [rfqs, setRfqs] = useState<any[]>([])
  const [config, setConfig] = useState<any>({ media_platforms: [], sales_codes: [], statuses: [] })
  const [dashboard, setDashboard] = useState<any>({ unclaimed: 0, claimed: 0, received_today: 0, open: 0 })
  const [analytics, setAnalytics] = useState<any>({ totals: {}, series: [] })
  const [analyticsPeriod, setAnalyticsPeriod] = useState<'year' | 'month' | 'week'>('year')
  const [analyticsMonth, setAnalyticsMonth] = useState(new Date().getMonth() + 1)
  const [analyticsWeek, setAnalyticsWeek] = useState(1)
  const [view, setView] = useState<'dashboard' | 'rfqs' | 'analytics'>('dashboard')
  const [users, setUsers] = useState<any[]>([])
  const [panel, setPanel] = useState<{ mode: 'create' | 'edit'; id?: string } | null>(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [codeFilter, setCodeFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('received_asc')
  const [newMedia, setNewMedia] = useState('')
  const [newStatus, setNewStatus] = useState({ name: '', closed: false })
  const [newUser, setNewUser] = useState({ display_name: '', username: '', password: '', role: 'salesperson' })
  const [gpMilestones, setGpMilestones] = useState<number[]>(() => { try { return JSON.parse(localStorage.getItem('sales_desk_gp_milestones') || '[4,9.5,15]') } catch { return [4, 9.5, 15] } })
  const [newMilestone, setNewMilestone] = useState('')
  const [gpPercentMilestones, setGpPercentMilestones] = useState<number[]>(() => { try { return JSON.parse(localStorage.getItem('sales_desk_gp_percent_milestones') || '[4,9.5,15]') } catch { return [4, 9.5, 15] } })
  const [gpPercentColors, setGpPercentColors] = useState<Record<string, string>>(() => { try { return JSON.parse(localStorage.getItem('sales_desk_gp_percent_colors') || '{}') } catch { return {} } })
  const [newGpPercent, setNewGpPercent] = useState('')
  const [milestoneColors, setMilestoneColors] = useState<Record<string, string>>(() => { try { return JSON.parse(localStorage.getItem('sales_desk_gp_milestone_colors') || '{}') } catch { return {} } })

  const closePanel = useCallback(() => setPanel(null), [])
  useEffect(() => { localStorage.setItem('sales_desk_gp_milestones', JSON.stringify(gpMilestones)) }, [gpMilestones])
  useEffect(() => { localStorage.setItem('sales_desk_gp_percent_milestones', JSON.stringify(gpPercentMilestones)) }, [gpPercentMilestones])
  useEffect(() => { localStorage.setItem('sales_desk_gp_percent_colors', JSON.stringify(gpPercentColors)) }, [gpPercentColors])
  useEffect(() => { localStorage.setItem('sales_desk_gp_milestone_colors', JSON.stringify(milestoneColors)) }, [milestoneColors])
  const request: Req = useCallback(async (path, init = {}) => {
    const headers = new Headers(init.headers || {})
    if (token) headers.set('Authorization', `Bearer ${token}`)
    if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
    let res: Response
    try { res = await fetch(`${API}${path}`, { ...init, headers }) }
    catch { throw new Error(`Cannot reach the Impala Hub API at ${API}. Start the backend and check VITE_API_URL.`) }
    const body = res.status === 204 ? null : await res.json().catch(() => ({}))
    if (res.status === 401 && token) { throw new Error('Your Impala Hub session has expired. Please sign in again.') }
    if (!res.ok) throw new Error(describeDetail(body?.detail, res.status))
    return body
  }, [token])

  const load = useCallback(async () => {
    if (!token) return
    try {
      const [me, cfg, list, dash, analyticsResult] = await Promise.all([
        request('/api/sales-desk/auth/me'), request('/api/sales-desk/config'),
        request('/api/sales-desk/rfqs?limit=500'), request('/api/sales-desk/dashboard'),
        request('/api/sales-desk/analytics?period=' + analyticsPeriod + '&month=' + analyticsMonth + '&week=' + analyticsWeek),
      ])
      setUser(me); setConfig(cfg); setRfqs(list.items || []); setDashboard(dash); setAnalytics(analyticsResult)
      if (me.role === 'administrator') setUsers(await request('/api/sales-desk/auth/users'))
    } catch (e) { setError((e as Error).message) }
  }, [token, request, setError, analyticsPeriod, analyticsMonth, analyticsWeek])
  useEffect(() => { void load() }, [load, page])

  async function act(work: () => Promise<unknown>, success?: string) {
    setBusy(true); setError('')
    try { await work(); if (success) setNotice(success); await load() }
    catch (e) { setError((e as Error).message); await load() }
    finally { setBusy(false) }
  }

  const convert = (r: any) => {
    if (!window.confirm(`Create an invoice copy of ${r.rfq_no}? The original quote will remain unchanged and the new invoice will be numbered ${r.rfq_no}INV.`)) return
    void act(() => request(`/api/sales-desk/rfqs/${r.id}/convert-to-invoice`, { method: 'POST' }), `Invoice ${r.rfq_no}INV created. The original quote was kept.`)
  }
  const claim = (r: any) => void act(() => request(`/api/sales-desk/rfqs/${r.id}/claim`, { method: 'POST' }), `Claimed ${r.rfq_no} for your sales code.`)

  async function reorder(kind: 'media-platforms' | 'statuses', key: 'media_platforms' | 'statuses', ids: string[]) {
    const byId = new Map<string, any>(config[key].map((o: any) => [o.id, o]))
    setConfig((c: any) => ({ ...c, [key]: ids.map((id) => byId.get(id)).filter(Boolean) })) // show the new order immediately
    try { await request(`/api/sales-desk/config/${kind}/order`, { method: 'PUT', body: JSON.stringify({ ids }) }); setNotice('Order saved.') }
    catch (e) { setError((e as Error).message) }
    await load()
  }
  const removeOption = (kind: 'media-platforms' | 'statuses', o: any, label: string) => {
    if (!window.confirm(`Delete the ${label} "${o.name}"? This cannot be undone.`)) return
    void act(() => request(`/api/sales-desk/config/${kind}/${o.id}`, { method: 'DELETE' }), `${label[0].toUpperCase() + label.slice(1)} deleted.`)
  }
  const patchOption = (path: string, body: object, success = 'Configuration saved.') =>
    act(() => request(path, { method: 'PATCH', body: JSON.stringify(body) }), success)

  const isStaff = user?.role === 'administrator' || user?.role === 'manager'
  const isAdmin = user?.role === 'administrator'
  const rows = rfqs.filter((r) =>
    (!statusFilter || r.status_id === statusFilter) && (!codeFilter || r.sales_code_id === codeFilter) &&
    (!typeFilter || r.rfq_type === typeFilter) &&
    (!search || `${r.rfq_no} ${r.original_rfq_no || ''} ${r.customer_name} ${r.document_number}`.toLowerCase().includes(search.toLowerCase())),
  ).sort((a, b) => {
    if (sort === 'customer') return String(a.customer_name).localeCompare(String(b.customer_name))
    if (sort === 'rfq_no') return String(b.rfq_no).localeCompare(String(a.rfq_no))
    if (sort === 'received_desc') return String(b.received_at).localeCompare(String(a.received_at))
    return (Number(!!a.sales_code) - Number(!!b.sales_code)) || String(a.received_at).localeCompare(String(b.received_at))
  })
  const monthlySales = TEMP_MONTHLY_GROSS_SALES
  const sortedMilestones = [...gpMilestones].sort((a, b) => a - b)
  const reachedMilestone = sortedMilestones.filter((point) => monthlySales >= point).pop()
  const progressColor = reachedMilestone ? (milestoneColors[String(reachedMilestone)] || (reachedMilestone === sortedMilestones[sortedMilestones.length - 1] ? 'dark-blue' : 'grey')) : 'red'
  const sortedGpPercentMilestones = [...gpPercentMilestones].sort((a, b) => a - b)
  const reachedGpPercent = sortedGpPercentMilestones.filter((point) => TEMP_MONTHLY_GP_PERCENT >= point).pop()
  const gpPercentColor = reachedGpPercent ? (gpPercentColors[String(reachedGpPercent)] || 'dark-blue') : 'red'
  const canConvert = (r: any) => r.rfq_type === 'quotation' && r.status_is_closed && (isStaff || (user?.role === 'salesperson' && r.sales_code && r.sales_code === user.sales_code))

  return (
    <section className="rfq-workspace">
      <>
          <div className="sd-session-bar">
            {page === 'RFQs' && view === 'rfqs' && <button type="button" className="sd-create-button" aria-label="Create new RFQ" title="Create new RFQ" onClick={() => { setView('rfqs'); setPanel({ mode: 'create' }) }}><Plus size={18} /></button>}
            <span>Signed in as <b>{user?.display_name || 'Impala Hub user'}</b>{user?.role ? ` · ${user.role}` : ''}{user?.sales_code ? ` · sales code ${user.sales_code}` : ''}</span>
            {page === 'RFQs' && <div className="sd-view-tabs"><button className={view === 'dashboard' ? 'active' : ''} onClick={() => setView('dashboard')}>Dashboard</button><button className={view === 'rfqs' ? 'active' : ''} onClick={() => setView('rfqs')}>RFQs</button><button className={view === 'analytics' ? 'active' : ''} onClick={() => setView('analytics')}>Analytics</button></div>}
          </div>

          {page === 'RFQs' && view === 'dashboard' ? (
            <div className="sd-dashboard">
              <div className="sd-dashboard-grid">
                <div className="sd-metric"><span>Unclaimed</span><strong>{dashboard.unclaimed}</strong></div>
                <div className="sd-metric"><span>Claimed</span><strong>{dashboard.claimed}</strong></div>
                <div className="sd-metric"><span>Received today</span><strong>{dashboard.received_today}</strong></div>
                <div className="sd-metric"><span>Open RFQs</span><strong>{dashboard.open}</strong></div>
              </div>
              <div className="sd-dashboard-card sd-gp-card">
                <div className="sd-dashboard-card-head"><div><h3>Monthly sales GP%</h3><p>Sales GP performance against configured milestones.</p></div><strong>R{monthlySales.toLocaleString()} <em className={`sd-gp-percent-text ${gpPercentColor}`}>@ {TEMP_MONTHLY_GP_PERCENT.toFixed(2)}%</em></strong></div>
                <div className="sd-gp-progress"><div className={`sd-gp-fill ${progressColor}`} style={{ width: Math.min(100, monthlySales / Math.max(...gpMilestones, 1) * 100) + '%' }} />{[...gpMilestones].sort((a, b) => a - b).map((point, index, points) => <span key={point} className={`${milestoneColors[String(point)] || (index === points.length - 1 ? 'dark-blue' : index === 0 ? 'grey' : 'light-blue')}${index === points.length - 1 ? ' final' : ''}`} style={{ left: (point / Math.max(...points, 1) * 100) + '%' }} title={'R' + point.toLocaleString()}>{'R' + point.toLocaleString()}</span>)}</div>
                <div className="sd-gp-scale"><span>R0</span><span>R{Math.max(...gpMilestones, 0).toLocaleString()}</span></div>
              </div>
              <div className="sd-dashboard-card"><div className="sd-dashboard-card-head"><div><h3>Daily sales</h3><p>Sales performance for the current business day.</p></div></div><div className="rfq-table-wrap"><table className="rfq-table"><thead><tr><th>Sales Person</th><th>Total sales</th><th>Total credits</th><th>Gross sales</th><th>GP %</th></tr></thead><tbody>{[...TEMP_DAILY_SALES].sort((a, b) => b.gross - a.gross).map((row) => <tr className="rfq-data-row" key={row.name}><td>{row.name}</td><td>{formatRand(row.total)}</td><td>{formatRand(row.credits)}</td><td className={row.gross === Math.max(...TEMP_DAILY_SALES.map((item) => item.gross)) ? 'sd-highlight-value' : ''}>{formatRand(row.gross)}</td><td className={row.gp === Math.max(...TEMP_DAILY_SALES.map((item) => item.gp)) ? 'sd-highlight-value' : ''}>{row.gp.toFixed(2)}%</td></tr>)}</tbody></table></div></div>
              <div className="sd-dashboard-card"><div className="sd-dashboard-card-head"><div><h3>RFQ performance</h3><p>Lifecycle workload by sales person.</p></div></div><div className="rfq-table-wrap"><table className="rfq-table"><thead><tr><th>Sales Person</th><th>In progress</th><th>Complete</th><th>Dropped</th><th>Scrapped</th><th>Irrelevant</th><th>Total</th><th>Bonus points</th><th>Response time</th><th>Score</th></tr></thead><tbody>{config.sales_codes.filter((code: any) => code.is_active).map((code: any) => { const mine = rfqs.filter((r: any) => r.sales_code_id === code.id); const count = (term: string) => mine.filter((r: any) => String(r.status_name || '').toLowerCase().includes(term)).length; return <tr className="rfq-data-row" key={code.id}><td>{code.consultant_name || code.display_name || code.code}</td><td>{count('progress')}</td><td>{count('complete')}</td><td>{count('drop')}</td><td>{count('scrap')}</td><td>{count('irrelevant')}</td><td>{mine.length}</td><td>—</td><td>—</td><td>—</td></tr> })}</tbody></table></div></div>
              
            </div>
          ) : page === 'RFQs' && view === 'analytics' ? (
            <div className="sd-analytics">
              <div className="sd-analytics-toolbar">
                <label>Period<select value={analyticsPeriod} onChange={(e) => setAnalyticsPeriod(e.target.value as 'year' | 'month' | 'week')}><option value="year">Year</option><option value="month">Month</option><option value="week">Week</option></select></label>
                <label>Month<select value={analyticsMonth} onChange={(e) => setAnalyticsMonth(Number(e.target.value))}>{Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{new Date(2000, i, 1).toLocaleString(undefined, { month: 'long' })}</option>)}</select></label>
                <label>Week<input type="number" min="1" max="53" value={analyticsWeek} onChange={(e) => setAnalyticsWeek(Number(e.target.value) || 1)} /></label>
              </div>
              <div className="sd-dashboard-grid">{(['claimed', 'scrapped', 'dropped', 'completed', 'invoiced'] as const).map((key) => <div className="sd-metric" key={key}><span>{key[0].toUpperCase() + key.slice(1)}</span><strong>{analytics.totals?.[key] || 0}</strong></div>)}</div>
              <div className="sd-chart"><h3>RFQ lifecycle by period</h3>{(analytics.series || []).map((point: any) => <div className="sd-chart-row" key={point.label}><b>{point.label}</b><div className="sd-chart-bars">{(['claimed', 'scrapped', 'dropped', 'completed', 'invoiced'] as const).map((key) => <span className={key} key={key} style={{ width: Math.max(2, ((point[key] || 0) / Math.max(1, ...((analytics.series || []).map((p: any) => Math.max(p.claimed || 0, p.scrapped || 0, p.dropped || 0, p.completed || 0, p.invoiced || 0))))) * 100) + '%' }}>{point[key] || 0}</span>)}</div></div>)}{!analytics.series?.length && <p className="hint">No RFQ data for this period.</p>}</div>
            </div>
          ) : page === 'RFQs' ? (
            <>
              <div className="sd-metrics">
                {([['Unclaimed', dashboard.unclaimed], ['Claimed', dashboard.claimed], ['Received today', dashboard.received_today], ['Open RFQs', dashboard.open]] as [string, number][]).map(([label, value]) => (
                  <div className="sd-metric" key={label}><span>{label}</span><strong>{value}</strong></div>
                ))}
              </div>
              <div className="rfq-toolbar">
                <label>Filter by status<select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="">All statuses</option>{config.statuses.filter((s: any) => s.is_active).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
                <label>Filter by sales code<select value={codeFilter} onChange={(e) => setCodeFilter(e.target.value)} disabled={user?.role === 'salesperson'}><option value="">All salespeople</option>{config.sales_codes.map((s: any) => <option key={s.id} value={s.id}>{s.code} · {s.consultant_name || s.display_name}</option>)}</select></label>
                <label>Type<select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}><option value="">Quotes and invoices</option><option value="quotation">Quotes</option><option value="invoice">Invoices</option></select></label>
                <label className="rfq-search">Search RFQs<input placeholder="RFQ number, customer, document number" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
                <label>Sort by<select value={sort} onChange={(e) => setSort(e.target.value)}><option value="received_asc">Oldest received</option><option value="received_desc">Newest received</option><option value="customer">Customer name</option><option value="rfq_no">RFQ number</option></select></label>
                
              </div>
              <div className="rfq-table-wrap"><table className="rfq-table">
                <thead><tr><th>RFQ No.</th><th>Type</th><th>Received</th><th>Customer</th><th>Media platform</th><th>Sales code</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>{rows.length ? rows.map((r: any) => (
                  <tr key={r.id} className="rfq-data-row">
                    <td>{r.rfq_no}{r.attachment_count > 0 && <span className="sd-clip" title={`${r.attachment_count} attachment(s)`}><Paperclip size={12} /></span>}</td>
                    <td><span className={`sd-type ${r.rfq_type}`}>{r.rfq_type === 'invoice' ? 'Invoice' : 'Quote'}</span></td>
                    <td>{fmtDate(r.received_at)}</td><td>{r.customer_name}</td><td>{r.media_platform || '—'}</td>
                    <td>{r.sales_code || 'Unclaimed'}</td><td>{r.status}</td>
                    <td className="sd-actions-cell">
                      <button className="secondary" onClick={() => setPanel({ mode: 'edit', id: r.id })}>View</button>
                      {canConvert(r) && <button className="secondary" disabled={busy} onClick={() => convert(r)}>Convert to invoice</button>}
                      {user?.role === 'salesperson' && !r.sales_code && <button className="primary" disabled={busy} onClick={() => claim(r)}>Claim</button>}
                    </td>
                  </tr>
                )) : <tr><td colSpan={8}><div className="rfq-empty"><ClipboardList size={28} /><h3>{rfqs.length ? 'No matching RFQs' : 'No RFQs yet'}</h3><p>Incoming enquiries and manually captured RFQs will appear here.</p></div></td></tr>}</tbody>
              </table></div>
            </>
          ) : !isStaff ? (
            <div className="rfq-empty-card"><Settings size={26} /><h3>Manager or administrator access required</h3><p>Only managers and administrators can open Sales Desk configuration.</p></div>
          ) : (
            <div className="sd-config-layout">
              {isAdmin && (
                <div className="rfq-empty-card sd-form-card">
                  <h3>Media platforms</h3><p>Drag to set the order. A platform linked to an RFQ can be deactivated but not deleted.</p>
                  <div className="sd-config-add">
                    <input placeholder="New platform name" value={newMedia} onChange={(e) => setNewMedia(e.target.value)} />
                    <button className="primary" disabled={busy || !newMedia.trim()} onClick={() => void act(async () => { await request('/api/sales-desk/config/media-platforms', { method: 'POST', body: JSON.stringify({ name: newMedia }) }); setNewMedia('') }, 'Media platform added.')}>Add</button>
                  </div>
                  <Sortable items={config.media_platforms} onReorder={(ids) => void reorder('media-platforms', 'media_platforms', ids)}>
                    {(m: any) => (<>
                      <div className="sd-option-text"><b>{m.name}</b><small>{m.is_active ? 'Active' : 'Inactive'} · {m.rfq_count} RFQ{m.rfq_count === 1 ? '' : 's'}</small></div>
                      <div className="sd-actions">
                        <button className="secondary" onClick={() => void patchOption(`/api/sales-desk/config/media-platforms/${m.id}`, { is_active: !m.is_active })}>{m.is_active ? 'Deactivate' : 'Activate'}</button>
                        <button className="secondary" onClick={() => { const name = window.prompt('Rename media platform', m.name); if (name?.trim()) void patchOption(`/api/sales-desk/config/media-platforms/${m.id}`, { name }) }}>Rename</button>
                        {m.rfq_count === 0 && <button className="icon-button" aria-label={`Delete ${m.name}`} title="Delete" onClick={() => removeOption('media-platforms', m, 'media platform')}><Trash2 size={16} /></button>}
                      </div>
                    </>)}
                  </Sortable>
                </div>
              )}
              {isAdmin && (
                <div className="rfq-empty-card sd-form-card">
                  <h3>RFQ statuses</h3><p>Drag to set the order. Closed statuses leave the open total and allow conversion to an invoice.</p>
                  <div className="sd-config-add">
                    <input placeholder="New status name" value={newStatus.name} onChange={(e) => setNewStatus({ ...newStatus, name: e.target.value })} />
                    <label className="sd-inline-check"><input type="checkbox" checked={newStatus.closed} onChange={(e) => setNewStatus({ ...newStatus, closed: e.target.checked })} /> Closed status</label>
                    <button className="primary" disabled={busy || !newStatus.name.trim()} onClick={() => void act(async () => { await request('/api/sales-desk/config/statuses', { method: 'POST', body: JSON.stringify({ name: newStatus.name, is_closed: newStatus.closed }) }); setNewStatus({ name: '', closed: false }) }, 'Status added.')}>Add</button>
                  </div>
                  <Sortable items={config.statuses} onReorder={(ids) => void reorder('statuses', 'statuses', ids)}>
                    {(s: any) => (<>
                      <div className="sd-option-text"><b>{s.name}</b><small>{s.is_closed ? 'Closed' : 'Open'} · {s.is_active ? 'Active' : 'Inactive'} · {s.rfq_count} RFQ{s.rfq_count === 1 ? '' : 's'}</small></div>
                      <div className="sd-actions">
                        <button className="secondary" onClick={() => void patchOption(`/api/sales-desk/config/statuses/${s.id}`, { is_closed: !s.is_closed })}>{s.is_closed ? 'Mark open' : 'Mark closed'}</button>
                        <button className="secondary" onClick={() => void patchOption(`/api/sales-desk/config/statuses/${s.id}`, { is_active: !s.is_active })}>{s.is_active ? 'Deactivate' : 'Activate'}</button>
                        <button className="secondary" onClick={() => { const name = window.prompt('Rename status', s.name); if (name?.trim()) void patchOption(`/api/sales-desk/config/statuses/${s.id}`, { name }) }}>Rename</button>
                        {s.rfq_count === 0 && s.name.toLowerCase() !== 'unclaimed' && <button className="icon-button" aria-label={`Delete ${s.name}`} title="Delete" onClick={() => removeOption('statuses', s, 'status')}><Trash2 size={16} /></button>}
                      </div>
                    </>)}
                  </Sortable>
                </div>
              )}
              {isAdmin && (
                <div className="rfq-empty-card sd-form-card">
                  <h3>Monthly GP% milestones</h3><p>The largest marker defines the progress bar total. Values are whole rand amounts and can be edited.</p>
                  <div className="sd-config-add"><input type="number" min="1" step="1" placeholder="Add milestone amount" value={newMilestone} onChange={(e) => setNewMilestone(e.target.value)} /><button className="primary" disabled={!newMilestone || Number(newMilestone) < 0} onClick={() => { const value = Number(newMilestone); if (Number.isInteger(value) && value > 0) { setGpMilestones((items) => [...items, value]); setNewMilestone('') } }}>Add</button></div>
                  <div className="sd-milestone-list">{[...gpMilestones].sort((a, b) => a - b).map((value) => <div className="sd-config-row" key={value}><div><b>R{value.toLocaleString()}</b><small>{value === Math.min(...gpMilestones) ? 'Lowest milestone' : value === Math.max(...gpMilestones) ? 'Progress total' : 'Intermediate milestone'}</small></div><div className="sd-actions"><div className="sd-color-grid" role="group" aria-label={'Color for R' + value.toLocaleString()}>{GP_COLORS.map(([color, label]) => <button type="button" key={color} className={`sd-color-swatch ${color} ${(milestoneColors[String(value)] || (value === Math.max(...gpMilestones) ? 'dark-blue' : value === Math.min(...gpMilestones) ? 'grey' : 'light-blue')) === color ? 'selected' : ''}`} title={label} aria-label={label} onClick={() => setMilestoneColors((colors) => ({ ...colors, [String(value)]: color }))} />)}</div><button className="secondary" onClick={() => { const next = window.prompt('Edit milestone amount', String(value)); const parsed = Number(next); if (next !== null && Number.isInteger(parsed) && parsed > 0) setGpMilestones((items) => items.map((item) => item === value ? parsed : item)) }}>Edit</button><button className="icon-button" aria-label={'Remove R' + value.toLocaleString() + ' milestone'} onClick={() => setGpMilestones((items) => items.filter((item) => item !== value))}><Trash2 size={16} /></button></div></div>)}</div>
                </div>
              )}
              {isAdmin && (
                <div className="rfq-empty-card sd-form-card">
                  <h3>GP% milestones</h3><p>Set the GP% thresholds that control the color of the monthly GP% text.</p>
                  <div className="sd-config-add"><input type="number" min="0" step="0.01" placeholder="Add GP% milestone" value={newGpPercent} onChange={(e) => setNewGpPercent(e.target.value)} /><button className="primary" disabled={!newGpPercent || Number(newGpPercent) < 0} onClick={() => { const value = Number(newGpPercent); if (value >= 0) { setGpPercentMilestones((items) => [...items, value]); setNewGpPercent('') } }}>Add</button></div>
                  <div className="sd-milestone-list">{sortedGpPercentMilestones.map((value) => <div className="sd-config-row" key={value}><div><b>{value}%</b><small>GP% threshold</small></div><div className="sd-actions"><div className="sd-color-grid" role="group" aria-label={'Color for GP ' + value + '%'}>{GP_COLORS.map(([color, label]) => <button type="button" key={color} className={`sd-color-swatch ${color} ${(gpPercentColors[String(value)] || 'dark-blue') === color ? 'selected' : ''}`} title={label} aria-label={label} onClick={() => setGpPercentColors((colors) => ({ ...colors, [String(value)]: color }))} />)}</div><button className="secondary" onClick={() => { const next = window.prompt('Edit GP% milestone', String(value)); const parsed = Number(next); if (next !== null && parsed >= 0) setGpPercentMilestones((items) => items.map((item) => item === value ? parsed : item)) }}>Edit</button><button className="icon-button" aria-label={'Remove GP ' + value + '% milestone'} onClick={() => setGpPercentMilestones((items) => items.filter((item) => item !== value))}><Trash2 size={16} /></button></div></div>)}</div>
                </div>
              )}
              <div className="rfq-empty-card sd-form-card">
                <h3>Sales codes</h3><p>Codes are created automatically when a consultant account is created (first letter of name, first letter of surname, then 01, 02…). You can only switch them active or inactive.</p>
                {config.sales_codes.length === 0 && <p className="hint">No sales codes yet. Create a salesperson account to generate one.</p>}
                {config.sales_codes.map((c: any) => (
                  <div className="sd-config-row" key={c.id}>
                    <div><b>{c.code} · {c.consultant_name || c.display_name}</b><small>{c.rfq_count} RFQ{c.rfq_count === 1 ? '' : 's'}</small></div>
                    <label className="sd-inline-check">Status
                      <select value={c.is_active ? 'active' : 'inactive'} onChange={(e) => void patchOption(`/api/sales-desk/config/sales-codes/${c.id}`, { is_active: e.target.value === 'active' })}>
                        <option value="active">Active</option><option value="inactive">Inactive</option>
                      </select>
                    </label>
                  </div>
                ))}
              </div>
              {isAdmin && (
                <div className="rfq-empty-card sd-form-card">
                  <h3>Team accounts</h3><p>Create an account for each person. A salesperson's sales code is generated from their full name.</p>
                  <div className="sd-form-grid">
                    <label>Full name (first name and surname)<input value={newUser.display_name} onChange={(e) => setNewUser({ ...newUser, display_name: e.target.value })} /></label>
                    <label>Username<input autoComplete="off" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} /></label>
                    <label>Temporary password (14+ characters)<input type="password" autoComplete="new-password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} /></label>
                    <label>Role<select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}><option value="salesperson">Salesperson</option><option value="manager">Manager</option><option value="administrator">Administrator</option></select></label>
                  </div>
                  <div className="sd-actions"><button className="primary" disabled={busy || !newUser.display_name.trim() || newUser.username.trim().length < 3 || newUser.password.length < 14}
                    onClick={() => void act(async () => {
                      const created = await request('/api/sales-desk/auth/users', { method: 'POST', body: JSON.stringify(newUser) })
                      setNewUser({ display_name: '', username: '', password: '', role: 'salesperson' })
                      setNotice(`Account created for ${created.display_name}${created.sales_code ? `. Sales code ${created.sales_code} assigned.` : '.'}`)
                    })}>Create account</button></div>
                  {users.map((u: any) => (
                    <div className="sd-config-row" key={u.id}><div><b>{u.display_name}</b><small>{u.username} · {u.role}{u.sales_code ? ` · ${u.sales_code}` : ''}</small></div></div>
                  ))}
                </div>
              )}
            </div>
          )}
      </>

      {panel && token && (
        <RfqPanel
          key={`${panel.mode}-${panel.id || 'new'}`} mode={panel.mode} rfqId={panel.id} config={config} user={user || { role: 'salesperson' }}
          token={token} request={request} onClose={closePanel} onChanged={load} setNotice={setNotice} setError={setError}
        />
      )}
    </section>
  )
}
