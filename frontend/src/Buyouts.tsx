import { useEffect, useState } from 'react'
import { ClipboardList, Plus, X } from 'lucide-react'
import { API } from './lib'

type Props = { token: string; setNotice: (m: string) => void; setError: (m: string) => void }
type RequestRecord = { id: string; part_number: string; part_description: string; qty: number; created_at: string }
type QuoteRecord = { id: string; supplier: string; brand: string; cost: number; msrp: number; notes: string; created_at: string }

async function request<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers || {})
  headers.set('Authorization', `Bearer ${token}`)
  if (init?.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  let response: Response
  try { response = await fetch(API + path, { ...init, headers }) } catch { throw new Error(`Cannot reach the Impala Hub API at ${API}. Start the backend and check VITE_API_URL.`) }
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.detail || 'Buyouts request failed')
  return body
}

export default function Buyouts({ token, setNotice, setError }: Props) {
  const [view, setView] = useState<'requests' | 'quotes'>('requests')
  const [requests, setRequests] = useState<RequestRecord[]>([])
  const [quotes, setQuotes] = useState<QuoteRecord[]>([])
  const [panel, setPanel] = useState<'request' | 'quote' | null>(null)
  const [form, setForm] = useState<Record<string, string | number>>({})
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('')
  const [readOnly, setReadOnly] = useState(false)

  const load = async () => {
    try {
      const [r, q] = await Promise.all([request<RequestRecord[]>(token, '/api/buyouts/requests'), request<QuoteRecord[]>(token, '/api/buyouts/quotes')])
      setRequests(r); setQuotes(q); setError('')
    } catch (e) { setError((e as Error).message) }
  }
  useEffect(() => { void load() }, [token])
  const open = (kind: 'request' | 'quote', record?: RequestRecord | QuoteRecord) => {
    setForm(record ? { ...record } : kind === 'request' ? { part_number: '', part_description: '', qty: 1 } : { supplier: '', brand: '', cost: '', msrp: '', notes: '' })
    setReadOnly(Boolean(record)); setPanel(kind); setError('')
  }
  const save = async () => {
    if (!panel || busy) return
    setBusy(true)
    try {
      await request(token, `/api/buyouts/${panel === 'request' ? 'requests' : 'quotes'}`, {
        method: 'POST',
        body: JSON.stringify(panel === 'request'
          ? { ...form, qty: Number(form.qty) }
          : { ...form, cost: Number(form.cost), msrp: Number(form.msrp) }),
      })
      setPanel(null); setNotice(panel === 'request' ? 'Buyout request saved.' : 'Supplier quote saved.'); await load()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const query = search.trim().toLowerCase()
  const visibleRequests = requests.filter(r => !query || [r.id, r.part_number, r.part_description].join(' ').toLowerCase().includes(query) && (!filter || r.part_number === filter))
  const visibleQuotes = quotes.filter(q => !query || [q.id, q.supplier, q.brand, q.notes].join(' ').toLowerCase().includes(query) && (!filter || q.supplier === filter))
  const field = (name: string, label: string, type = 'text') => (
    <label className="editor-field"><span>{label}</span><input type={type} value={form[name] ?? ''} onChange={e => setForm({ ...form, [name]: e.target.value })} /></label>
  )
  return <section className="rfq-workspace">
    <div className="sd-session-bar">
      <span>Smart Stock Control workspace</span>
      <div className="sd-view-tabs">
        <button className={view === 'requests' ? 'active' : ''} onClick={() => setView('requests')}>Buyout Requests</button>
        <button className={view === 'quotes' ? 'active' : ''} onClick={() => setView('quotes')}>Supplier Quotes</button>
      </div>
    </div>
    <div className="rfq-toolbar buyouts-toolbar">
      <label className="rfq-search">Search {view === 'requests' ? 'buyout requests' : 'supplier quotes'}<input placeholder={view === 'requests' ? 'ID, part number, description' : 'ID, supplier, brand, notes'} value={search} onChange={e => setSearch(e.target.value)} /></label>
      <label>Filter by {view === 'requests' ? 'part number' : 'supplier'}<select value={filter} onChange={e => setFilter(e.target.value)}><option value="">All</option>{(view === 'requests' ? Array.from(new Set(requests.map(r => r.part_number))) : Array.from(new Set(quotes.map(q => q.supplier)))).map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <button className="primary" onClick={() => open(view === 'requests' ? 'request' : 'quote')}><Plus size={16} /> New {view === 'requests' ? 'Buyout Request' : 'Supplier Quote'}</button>
    </div>
    <div className="rfq-table-wrap"><table className="rfq-table"><thead>{view === 'requests' ? <tr><th>ID</th><th>Part Number</th><th>Part Description</th><th>Qty</th><th>Actions</th></tr> : <tr><th>ID</th><th>Supplier</th><th>Brand</th><th>Cost</th><th>MSRP</th><th>Notes</th><th>Actions</th></tr>}</thead><tbody>
      {view === 'requests' ? visibleRequests.map(r => <tr key={r.id} className="rfq-data-row"><td>{r.id}</td><td>{r.part_number}</td><td>{r.part_description}</td><td>{r.qty}</td><td className="sd-actions-cell"><button className="secondary" onClick={() => open('request', r)}>View</button></td></tr>) : visibleQuotes.map(q => <tr key={q.id} className="rfq-data-row"><td>{q.id}</td><td>{q.supplier}</td><td>{q.brand}</td><td>{q.cost.toFixed(2)}</td><td>{q.msrp.toFixed(2)}</td><td>{q.notes || '—'}</td><td className="sd-actions-cell"><button className="secondary" onClick={() => open('quote', q)}>View</button></td></tr>)}
      {((view === 'requests' && !visibleRequests.length) || (view === 'quotes' && !visibleQuotes.length)) && <tr><td colSpan={view === 'requests' ? 5 : 7}><div className="rfq-empty"><ClipboardList size={28} /><h3>{search || filter ? 'No matching records' : 'No records yet'}</h3><p>{search || filter ? 'Adjust the search or filter.' : 'Create the first record with the New button.'}</p></div></td></tr>}
    </tbody></table></div>
    {panel && <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setPanel(null) }}>
      <section className="editor" role="dialog" aria-modal="true" aria-label={panel === 'request' ? 'New Buyout Request' : 'New Supplier Quote'}>
        <header className="editor-head"><div><span className="eyebrow">{readOnly ? 'RECORD' : 'NEW RECORD'}</span><h2>{readOnly ? form.id : panel === 'request' ? 'New Buyout Request' : 'New Supplier Quote'}</h2></div><button className="icon-button" aria-label="Close" onClick={() => setPanel(null)}><X size={20} /></button></header>
        <div className="editor-body"><p className="hint sd-panel-note">{readOnly ? 'This record is read-only.' : 'The record ID is generated automatically when you save.'}</p>{panel === 'request' ? <>{field('part_number', 'Part Number')}{field('part_description', 'Part Description')}{field('qty', 'Qty', 'number')}</> : <>{field('supplier', 'Supplier')}{field('brand', 'Brand')}{field('cost', 'Cost', 'number')}{field('msrp', 'MSRP', 'number')}<label className="editor-field"><span>Notes</span><textarea rows={7} value={form.notes ?? ''} onChange={e => setForm({ ...form, notes: e.target.value })} /></label></>}</div>
        <footer className="editor-foot"><button className="secondary" onClick={() => setPanel(null)}>{readOnly ? 'Close' : 'Cancel'}</button>{!readOnly && <button className="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>}</footer>
      </section>
    </div>}
  </section>
}
