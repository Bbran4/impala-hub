import { useEffect, useState } from 'react'
import { ClipboardList, Plus, Trash2, X } from 'lucide-react'
import { API, supabase, supabaseConfigured } from './lib'
import {
  STOCK_QUERY_STATUSES, archiveStockPartsQuery, createStockDevelopmentStatus, createStockPartsQuery,
  loadStockPartsQueryHistory, loadStockPartsQueryWorkspace, matchesStockQuery, prepareStockQueryPayload,
  stockSupplierUnitCost, updateStockPartsQuery, type StockAccess, type StockHistoryEntry,
  type StockPartsQuery, type StockSupplier,
} from './stockPartsQueries'

type Props = { token: string; setNotice: (message: string) => void; setError: (message: string) => void }

async function legacyRequest<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers || {})
  headers.set('Authorization', `Bearer ${token}`)
  if (init?.body) headers.set('Content-Type', 'application/json')
  let response: Response
  try { response = await fetch(API + path, { ...init, headers }) }
  catch { throw new Error(`Cannot reach the Impala Hub API at ${API}. Start the backend and check VITE_API_URL.`) }
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : body.detail ? JSON.stringify(body.detail) : 'Parts Query request failed')
  return body
}

const blankSupplier = (): StockSupplier => ({ supplier: '', qty: 1, cost: '', msrp: '', notes: '' })

export default function PartsQueries({ token, setNotice, setError }: Props) {
  const [queries, setQueries] = useState<StockPartsQuery[]>([])
  const [salesCodes, setSalesCodes] = useState<any[]>([])
  const [developmentStatuses, setDevelopmentStatuses] = useState<string[]>([])
  const [access, setAccess] = useState<StockAccess>({ canEdit: !supabaseConfigured, isAdmin: !supabaseConfigured })
  const [search, setSearch] = useState('')
  const [developmentFilter, setDevelopmentFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [panel, setPanel] = useState(false)
  const [existingRecord, setExistingRecord] = useState(false)
  const [form, setForm] = useState<any>({})
  const [history, setHistory] = useState<StockHistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try {
      if (supabaseConfigured && supabase) {
        const workspace = await loadStockPartsQueryWorkspace(supabase)
        setQueries(workspace.queries); setDevelopmentStatuses(workspace.statuses); setSalesCodes(workspace.salesCodes); setAccess(workspace.access)
      } else {
        const [rows, statuses, config] = await Promise.all([
          legacyRequest<any[]>(token, '/api/parts-queries'),
          legacyRequest<string[]>(token, '/api/parts-queries/development-statuses'),
          legacyRequest<any>(token, '/api/sales-desk/config'),
        ])
        setQueries(rows.map((row) => ({ ...row, reference: row.id })) as StockPartsQuery[])
        setDevelopmentStatuses(statuses); setSalesCodes(config.sales_codes || [])
      }
      setError('')
    } catch (error) { setError((error as Error).message) }
  }
  useEffect(() => { void load() }, [token])

  const open = async (record?: StockPartsQuery) => {
    if (!record && !access.canEdit) return
    setExistingRecord(Boolean(record))
    setForm(record ? { ...record, suppliers: record.suppliers.map((supplier) => ({ ...supplier })) } : {
      part_number: '', description: '', qty: 1, sales_code_id: '', development_status: developmentStatuses[0] || 'New',
      status: 'In Progress', suppliers: [blankSupplier()],
    })
    setHistory([]); setPanel(true); setError('')
    if (record && supabaseConfigured && supabase) {
      setHistoryLoading(true)
      try { setHistory(await loadStockPartsQueryHistory(supabase, record.id)) }
      catch (error) { setError((error as Error).message) }
      finally { setHistoryLoading(false) }
    }
  }

  const save = async () => {
    setBusy(true)
    try {
      const payload = prepareStockQueryPayload(form)
      if (supabaseConfigured && supabase) {
        if (existingRecord) await updateStockPartsQuery(supabase, form.id, payload)
        else await createStockPartsQuery(supabase, payload)
      } else if (existingRecord) await legacyRequest(token, `/api/parts-queries/${form.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
      else await legacyRequest(token, '/api/parts-queries', { method: 'POST', body: JSON.stringify(payload) })
      setPanel(false); setNotice(existingRecord ? 'Parts Query updated.' : 'Parts Query saved.'); await load()
    } catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }

  const archiveQuery = async (query: StockPartsQuery) => {
    if (!access.canEdit || !window.confirm(`Archive Parts Query ${query.reference}? Its audit history will be retained.`)) return
    try {
      if (supabaseConfigured && supabase) await archiveStockPartsQuery(supabase, query.id)
      else await legacyRequest(token, `/api/parts-queries/${query.id}`, { method: 'DELETE' })
      setNotice(supabaseConfigured ? 'Parts Query archived.' : 'Parts Query deleted.'); await load()
    } catch (error) { setError((error as Error).message) }
  }

  const addDevelopmentStatus = async () => {
    if (!access.isAdmin) return
    const entered = window.prompt('New Development status')?.trim()
    if (!entered) return
    try {
      const result = supabaseConfigured && supabase
        ? await createStockDevelopmentStatus(supabase, entered)
        : await legacyRequest<any>(token, '/api/parts-queries/development-statuses', { method: 'POST', body: JSON.stringify({ name: entered }) })
      const name = typeof result === 'string' ? result : entered
      setDevelopmentStatuses((current) => [...new Set([...current, name])].sort())
      setForm((current: any) => ({ ...current, development_status: name }))
    } catch (error) { setError((error as Error).message) }
  }

  const addSupplier = () => setForm((current: any) => ({ ...current, suppliers: [...(current.suppliers || []), blankSupplier()] }))
  const updateSupplier = (index: number, changes: Partial<StockSupplier>) => setForm((current: any) => ({ ...current, suppliers: current.suppliers.map((supplier: StockSupplier, i: number) => i === index ? { ...supplier, ...changes } : supplier) }))
  const removeSupplier = (index: number) => setForm((current: any) => ({ ...current, suppliers: current.suppliers.filter((_: StockSupplier, i: number) => i !== index) }))
  const visible = queries.filter((query) => matchesStockQuery(query, search) && (!developmentFilter || query.development_status === developmentFilter) && (!statusFilter || query.status === statusFilter))
  const field = (name: string, label: string, type = 'text', required = false) => <label className="editor-field"><span>{label}{required && <b className="required-mark" aria-hidden="true"> *</b>}</span><input disabled={!access.canEdit} type={type} value={form[name] ?? ''} onChange={(event) => setForm({ ...form, [name]: event.target.value })} /></label>

  return <section className="rfq-workspace">
    <div className="sd-session-bar">{access.canEdit && <button className="sd-create-button" aria-label="Create new Parts Query" title="Create new Parts Query" onClick={() => void open()}><Plus size={18} /></button>}<span>{access.canEdit ? 'Smart Stock Control workspace' : 'Smart Stock Control workspace · Read only'}</span><div className="sd-view-tabs"><button className="active">Parts Query</button></div></div>
    <div className="rfq-toolbar buyouts-toolbar"><label className="rfq-search">Search Parts Queries<input placeholder="ID, part number, description, supplier, sales code" value={search} onChange={(event) => setSearch(event.target.value)} /></label><label>Filter by Development Status<select value={developmentFilter} onChange={(event) => setDevelopmentFilter(event.target.value)}><option value="">All development statuses</option>{developmentStatuses.map((status) => <option key={status}>{status}</option>)}</select></label><label>Filter by Status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All statuses</option>{STOCK_QUERY_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label></div>
    <div className="rfq-table-wrap"><table className="rfq-table"><thead><tr><th>ID</th><th>Date/time</th><th>Part Number</th><th>Description</th><th>Sales Code</th><th>Suppliers</th><th>Lowest Cost</th><th>Development Status</th><th>Status</th><th>Actions</th></tr></thead><tbody>{visible.map((query) => { const costs = query.suppliers.map(stockSupplierUnitCost).filter((cost): cost is number => cost !== null); return <tr key={query.id} className="rfq-data-row"><td>{query.reference}</td><td>{new Date(query.created_at).toLocaleString()}</td><td>{query.part_number}</td><td>{query.description}</td><td>{query.sales_code || '—'}</td><td>{query.suppliers.length}</td><td>{costs.length ? Math.min(...costs).toFixed(2) : '—'}</td><td>{query.development_status}</td><td>{query.status}</td><td className="sd-actions-cell"><button className="secondary" onClick={() => void open(query)}>View</button>{access.canEdit && <button className="secondary" onClick={() => void archiveQuery(query)}>Archive</button>}</td></tr> })}{!visible.length && <tr><td colSpan={10}><div className="rfq-empty"><ClipboardList size={28} /><h3>No matching Parts Queries</h3></div></td></tr>}</tbody></table></div>
    {panel && <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setPanel(false) }}><section className="editor" role="dialog" aria-modal="true"><header className="editor-head"><div><span className="eyebrow">{existingRecord ? 'PARTS QUERY' : 'NEW PARTS QUERY'}</span><h2>{existingRecord ? form.reference : 'New Parts Query'}</h2></div><button className="icon-button" aria-label="Close" onClick={() => setPanel(false)}><X size={20} /></button></header><div className="editor-body">
      <p className="hint sd-panel-note">{existingRecord ? new Date(form.created_at).toLocaleString() : 'Date/time and reference will be generated automatically when you save.'}</p>
      <label className="editor-field"><span>Status<b className="required-mark" aria-hidden="true"> *</b></span><select disabled={!access.canEdit} value={form.status || 'In Progress'} onChange={(event) => setForm({ ...form, status: event.target.value })}>{STOCK_QUERY_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label>
      {field('part_number', 'Part Number', 'text', true)}{field('description', 'Description', 'text', true)}{field('qty', 'Requested quantity', 'number', true)}
      <label className="editor-field"><span>Sales Code</span><select disabled={!access.canEdit} value={form.sales_code_id || ''} onChange={(event) => setForm({ ...form, sales_code_id: event.target.value })}><option value="">Unassigned</option>{salesCodes.map((code) => <option key={code.id} value={code.id}>{code.code} · {code.display_name || 'Unassigned consultant'}</option>)}</select></label>
      <div className="supplier-section"><div className="supplier-section-head"><h3>Suppliers</h3><span>Supplier quotes for this Parts Query</span></div>{(form.suppliers || []).map((supplier: StockSupplier, index: number) => { const costs = (form.suppliers || []).map(stockSupplierUnitCost).filter((cost: number | null): cost is number => cost !== null); const unitCost = stockSupplierUnitCost(supplier); const cheapest = unitCost !== null && costs.length > 0 && unitCost === Math.min(...costs); return <div className={`supplier-row ${cheapest ? 'cheapest-supplier' : ''}`} key={supplier.id || index}><label><span>Supplier</span><input disabled={!access.canEdit} value={supplier.supplier} onChange={(event) => updateSupplier(index, { supplier: event.target.value })} /></label><label><span>Qty<b className="required-mark" aria-hidden="true"> *</b></span><input disabled={!access.canEdit} type="number" min="1" value={supplier.qty ?? 1} onChange={(event) => updateSupplier(index, { qty: event.target.value })} /></label><label><span>Cost</span><input disabled={!access.canEdit} type="number" min="0" value={supplier.cost ?? ''} onChange={(event) => updateSupplier(index, { cost: event.target.value })} /></label><label><span>MSRP</span><input disabled={!access.canEdit} type="number" min="0" value={supplier.msrp ?? ''} onChange={(event) => updateSupplier(index, { msrp: event.target.value })} /></label>{access.canEdit && <button className="icon-button" type="button" aria-label="Remove supplier" onClick={() => removeSupplier(index)}><Trash2 size={16} /></button>}</div> })}{access.canEdit && <button className="secondary" type="button" onClick={addSupplier}><Plus size={15} /> Add supplier</button>}</div>
      <label className="editor-field"><span>Development status<b className="required-mark" aria-hidden="true"> *</b></span><div className="inline-form"><select disabled={!access.canEdit} value={form.development_status || ''} onChange={(event) => setForm({ ...form, development_status: event.target.value })}>{developmentStatuses.map((status) => <option key={status}>{status}</option>)}</select>{access.isAdmin && <button className="secondary" type="button" onClick={() => void addDevelopmentStatus()}>Add status</button>}</div></label>
      {existingRecord && <div className="settings-card"><h3>History</h3>{historyLoading ? <p>Loading history…</p> : !history.length ? <p>No history recorded.</p> : <ul className="history-list">{history.slice().reverse().map((entry) => <li key={entry.id}><span><b>{entry.actor_name}</b> · {entry.action.replaceAll('_', ' ')}</span><small>{new Date(entry.created_at).toLocaleString()}</small></li>)}</ul>}</div>}
    </div><footer className="editor-foot"><button className="secondary" onClick={() => setPanel(false)}>Close</button>{access.canEdit && <button className="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : existingRecord ? 'Save changes' : 'Save'}</button>}</footer></section></div>}
  </section>
}
