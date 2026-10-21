import { useEffect, useState } from 'react'
import { ClipboardList, Plus, X } from 'lucide-react'
import { API } from './lib'

type Props = { token: string; setNotice: (m: string) => void; setError: (m: string) => void }
type RequestRecord = { id: string; part_number: string; part_description: string; qty: number; created_at: string }
type QuoteRecord = { id: string; supplier: string; brand: string; cost: number; msrp: number; notes: string; created_at: string }

async function request<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(API + path, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers || {}) } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.detail || 'Buyouts request failed')
  return body
}

export default function Buyouts({ token, setNotice, setError }: Props) {
  const [view, setView] = useState<'requests' | 'quotes'>('requests')
  const [requests, setRequests] = useState<RequestRecord[]>([])
  const [quotes, setQuotes] = useState<QuoteRecord[]>([])
  const [panel, setPanel] = useState<'request' | 'quote' | null>(null)
  const [form, setForm] = useState<any>({})
  const load = async () => {
    try {
      const [r, q] = await Promise.all([request<RequestRecord[]>(token, '/api/buyouts/requests'), request<QuoteRecord[]>(token, '/api/buyouts/quotes')])
      setRequests(r); setQuotes(q); setError('')
    } catch (e) { setError((e as Error).message) }
  }
  useEffect(() => { void load() }, [token])
  const open = (kind: 'request' | 'quote') => { setForm(kind === 'request' ? { part_number: '', part_description: '', qty: 1 } : { supplier: '', brand: '', cost: '', msrp: '', notes: '' }); setPanel(kind); setError('') }
  const save = async () => {
    try {
      const kind = panel
      if (!kind) return
      await request(token, `/api/buyouts/${kind === 'request' ? 'requests' : 'quotes'}`, { method: 'POST', body: JSON.stringify(kind === 'request' ? { ...form, qty: Number(form.qty) } : { ...form, cost: Number(form.cost), msrp: Number(form.msrp) }) })
      setPanel(null); setNotice(kind === 'request' ? 'Buyout request saved.' : 'Supplier quote saved.'); await load()
    } catch (e) { setError((e as Error).message) }
  }
  const field = (name: string, label: string, type = 'text') => <label className="form-field"><span>{label}</span><input type={type} value={form[name] ?? ''} onChange={e => setForm({ ...form, [name]: e.target.value })} /></label>
  return <section className="salesdesk-page">
    <div className="section-head"><div><span className="pill">SMART STOCK CONTROL</span><h2>Buyouts</h2><p>Manage buyout requests and supplier quotes.</p></div><button className="primary" onClick={() => open(view === 'requests' ? 'request' : 'quote')}><Plus size={17} /> New</button></div>
    <div className="sd-tabs"><button className={view === 'requests' ? 'active' : ''} onClick={() => setView('requests')}><ClipboardList size={16} /> Buyout Requests</button><button className={view === 'quotes' ? 'active' : ''} onClick={() => setView('quotes')}><ClipboardList size={16} /> Supplier Quotes</button></div>
    <div className="sd-table-wrap"><table className="sd-table"><thead>{view === 'requests' ? <tr><th>ID</th><th>Part Number</th><th>Part Description</th><th>Qty</th></tr> : <tr><th>ID</th><th>Supplier</th><th>Brand</th><th>Cost</th><th>MSRP</th><th>Notes</th></tr>}</thead><tbody>{view === 'requests' ? requests.map(r => <tr key={r.id}><td>{r.id}</td><td>{r.part_number}</td><td>{r.part_description}</td><td>{r.qty}</td></tr>) : quotes.map(q => <tr key={q.id}><td>{q.id}</td><td>{q.supplier}</td><td>{q.brand}</td><td>{q.cost.toFixed(2)}</td><td>{q.msrp.toFixed(2)}</td><td>{q.notes || '—'}</td></tr>)}</tbody></table>{((view === 'requests' && !requests.length) || (view === 'quotes' && !quotes.length)) && <div className="empty-state">No records yet. Create the first one.</div>}</div>
    {panel && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setPanel(null) }}><aside className="side-panel"><div className="side-panel-head"><div><span className="pill">NEW RECORD</span><h3>{panel === 'request' ? 'New Buyout Request' : 'New Supplier Quote'}</h3></div><button className="icon-button" onClick={() => setPanel(null)}><X size={18} /></button></div><div className="form-stack">{panel === 'request' ? <>{field('part_number', 'Part Number')}{field('part_description', 'Part Description')}{field('qty', 'Qty', 'number')}</> : <>{field('supplier', 'Supplier')}{field('brand', 'Brand')}{field('cost', 'Cost', 'number')}{field('msrp', 'MSRP', 'number')}<label className="form-field"><span>Notes</span><textarea rows={6} value={form.notes ?? ''} onChange={e => setForm({ ...form, notes: e.target.value })} /></label></>}<button className="primary" onClick={() => void save()}>Save</button></div></aside></div>}
  </section>
}
