import { useEffect, useState } from 'react'
import { ClipboardList, Plus, X } from 'lucide-react'
import { API } from './lib'

type Props = { token: string; setNotice: (m: string) => void; setError: (m: string) => void }
type Query = { id: string; created_at: string; part_number: string; description: string; qty: number; supplier: string; cost: number | null; msrp: number | null; development_status: string; status: string }
const STATUSES = ['In Progress', 'Submitted', 'Cancelled']

async function request<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers || {}); headers.set('Authorization', `Bearer ${token}`)
  if (init?.body) headers.set('Content-Type', 'application/json')
  let response: Response
  try { response = await fetch(API + path, { ...init, headers }) } catch { throw new Error(`Cannot reach the Impala Hub API at ${API}. Start the backend and check VITE_API_URL.`) }
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.detail || 'Parts Query request failed')
  return body
}

export default function Buyouts({ token, setNotice, setError }: Props) {
  const [queries, setQueries] = useState<Query[]>([])
  const [developmentStatuses, setDevelopmentStatuses] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [developmentFilter, setDevelopmentFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [panel, setPanel] = useState(false)
  const [readOnly, setReadOnly] = useState(false)
  const [form, setForm] = useState<any>({})
  const [busy, setBusy] = useState(false)
  const load = async () => {
    try {
      const [q, statuses] = await Promise.all([request<Query[]>(token, '/api/parts-queries'), request<string[]>(token, '/api/parts-queries/development-statuses')])
      setQueries(q); setDevelopmentStatuses(statuses); setError('')
    } catch (e) { setError((e as Error).message) }
  }
  useEffect(() => { void load() }, [token])
  const open = (record?: Query) => {
    setForm(record ? { ...record } : { part_number: '', description: '', qty: 1, supplier: '', cost: '', msrp: '', development_status: developmentStatuses[0] || 'New', status: 'In Progress' })
    setReadOnly(Boolean(record)); setPanel(true); setError('')
  }
  const save = async () => {
    setBusy(true)
    try {
      await request(token, '/api/parts-queries', { method: 'POST', body: JSON.stringify({ ...form, qty: Number(form.qty), cost: form.cost === '' ? null : Number(form.cost), msrp: form.msrp === '' ? null : Number(form.msrp) }) })
      setPanel(false); setNotice('Parts Query saved.'); await load()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const addDevelopmentStatus = async () => {
    const name = window.prompt('New Development status')
    if (!name?.trim()) return
    try { await request(token, '/api/parts-queries/development-statuses', { method: 'POST', body: JSON.stringify({ name }) }); setDevelopmentStatuses([...developmentStatuses, name.trim()].sort()); setForm({ ...form, development_status: name.trim() }) } catch (e) { setError((e as Error).message) }
  }
  const query = search.trim().toLowerCase()
  const visible = queries.filter(q => (!query || [q.id, q.part_number, q.description, q.supplier].join(' ').toLowerCase().includes(query)) && (!developmentFilter || q.development_status === developmentFilter) && (!statusFilter || q.status === statusFilter))
  const field = (name: string, label: string, type = 'text') => <label className="editor-field"><span>{label}</span><input type={type} value={form[name] ?? ''} onChange={e => setForm({ ...form, [name]: e.target.value })} /></label>
  return <section className="rfq-workspace">
    <div className="sd-session-bar"><span>Smart Stock Control workspace</span><div className="sd-view-tabs"><button className="active">Parts Query</button></div></div>
    <div className="rfq-toolbar buyouts-toolbar">
      <label className="rfq-search">Search Parts Queries<input placeholder="ID, part number, description, supplier" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <label>Filter by Development Status<select value={developmentFilter} onChange={e => setDevelopmentFilter(e.target.value)}><option value="">All development statuses</option>{developmentStatuses.map(s => <option key={s}>{s}</option>)}</select></label>
      <label>Filter by Status<select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="">All statuses</option>{STATUSES.map(s => <option key={s}>{s}</option>)}</select></label>
      <button className="primary" onClick={() => open()}><Plus size={16} /> New Parts Query</button>
    </div>
    <div className="rfq-table-wrap"><table className="rfq-table"><thead><tr><th>ID</th><th>Date/time</th><th>Part Number</th><th>Description</th><th>Qty</th><th>Supplier</th><th>Cost</th><th>MSRP</th><th>Development Status</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      {visible.map(q => <tr key={q.id} className="rfq-data-row"><td>{q.id}</td><td>{new Date(q.created_at).toLocaleString()}</td><td>{q.part_number}</td><td>{q.description}</td><td>{q.qty}</td><td>{q.supplier || '—'}</td><td>{q.cost == null ? '—' : q.cost.toFixed(2)}</td><td>{q.msrp == null ? '—' : q.msrp.toFixed(2)}</td><td>{q.development_status}</td><td>{q.status}</td><td className="sd-actions-cell"><button className="secondary" onClick={() => open(q)}>View</button></td></tr>)}
      {!visible.length && <tr><td colSpan={11}><div className="rfq-empty"><ClipboardList size={28} /><h3>{search || developmentFilter || statusFilter ? 'No matching Parts Queries' : 'No Parts Queries yet'}</h3><p>{search || developmentFilter || statusFilter ? 'Adjust the search or filters.' : 'Create the first Parts Query.'}</p></div></td></tr>}
    </tbody></table></div>
    {panel && <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setPanel(false) }}><section className="editor" role="dialog" aria-modal="true" aria-label={readOnly ? 'Parts Query details' : 'New Parts Query'}>
      <header className="editor-head"><div><span className="eyebrow">{readOnly ? 'PARTS QUERY' : 'NEW PARTS QUERY'}</span><h2>{readOnly ? form.id : 'New Parts Query'}</h2></div><button className="icon-button" aria-label="Close" onClick={() => setPanel(false)}><X size={20} /></button></header>
      <div className="editor-body"><p className="hint sd-panel-note">{readOnly ? new Date(form.created_at).toLocaleString() : 'Date/time will be generated automatically when you save.'}</p>
        <label className="editor-field"><span>Status</span><select disabled={readOnly} value={form.status || 'In Progress'} onChange={e => setForm({ ...form, status: e.target.value })}>{STATUSES.map(s => <option key={s}>{s}</option>)}</select></label>
        <label className="editor-field"><span>Development status</span><div className="inline-form"><select disabled={readOnly} value={form.development_status || ''} onChange={e => setForm({ ...form, development_status: e.target.value })}>{developmentStatuses.map(s => <option key={s}>{s}</option>)}</select>{!readOnly && <button className="secondary" type="button" onClick={() => void addDevelopmentStatus()}>Add status</button>}</div></label>
        {field('part_number', 'Part Number')}{field('description', 'Description')}{field('qty', 'Qty', 'number')}{field('supplier', 'Supplier')}{field('cost', 'Cost', 'number')}{field('msrp', 'MSRP', 'number')}
      </div><footer className="editor-foot"><button className="secondary" onClick={() => setPanel(false)}>{readOnly ? 'Close' : 'Cancel'}</button>{!readOnly && <button className="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>}</footer>
    </section></div>}
  </section>
}
