import { useEffect, useMemo, useState } from 'react'
import { Download, PackageCheck, Search } from 'lucide-react'
import { API } from './lib'

type Item = { id: string; franchise: string; part_number: string; description: string; unit_size: string; supply_er: number; on_picking_slip_er: number; qoh_er: number; max_er: number; supply_pta: number; on_picking_slip_pta: number; qoh_pta: number; max_pta: number; qoh_wh: number; max_wh: number }
type Location = { id: string; name: string; description?: string }
type Props = { token: string; setNotice: (message: string) => void; setError: (message: string) => void }

async function request<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers || {})
  headers.set('Authorization', `Bearer ${token}`)
  if (init?.body) headers.set('Content-Type', 'application/json')
  const response = await fetch(API + path, { ...init, headers })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'Stock Booking request failed')
  return body
}

export default function StockBooking({ token, setNotice, setError }: Props) {
  const [items, setItems] = useState<Item[]>([])
  const [locations, setLocations] = useState<Location[]>([])
  const [fromLocation, setFromLocation] = useState('')
  const [toLocation, setToLocation] = useState('')
  const [comments, setComments] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Record<string, { er: number; pta: number }>>({})
  const [busy, setBusy] = useState(false)
  const load = async () => { try { const [stock, configuredLocations] = await Promise.all([request<Item[]>(token, '/api/stock-booking/items'), request<Location[]>(token, '/api/stock-booking/locations')]); setItems(stock); setLocations(configuredLocations); setFromLocation(current => current || configuredLocations[0]?.name || ''); setToLocation(current => current || configuredLocations[1]?.name || ''); setError('') } catch (e) { setError((e as Error).message) } }
  useEffect(() => { void load() }, [token])
  const visible = useMemo(() => { const q = search.trim().toLowerCase(); return items.filter(i => !q || `${i.part_number} ${i.description}`.toLowerCase().includes(q)) }, [items, search])
  const setQty = (id: string, branch: 'er' | 'pta', value: string) => setSelected(prev => ({ ...prev, [id]: { er: prev[id]?.er || 0, pta: prev[id]?.pta || 0, [branch]: Math.max(0, Number(value) || 0) } }))
  const exportRows = async () => {
    if (!fromLocation || !toLocation || fromLocation === toLocation) { setError('Choose two different From and To locations before exporting.'); return }
    const rows = items.flatMap(item => {
      const qty = selected[item.id] || { er: 0, pta: 0 }
      return [qty.er ? { part_number: item.part_number, franchise: item.franchise || 'East Rand', from_location: fromLocation, to_location: toLocation, transfer_qty: qty.er, remarks: comments } : null, qty.pta ? { part_number: item.part_number, franchise: item.franchise || 'Pretoria', from_location: fromLocation, to_location: toLocation, transfer_qty: qty.pta, remarks: comments } : null].filter(Boolean)
    })
    if (!rows.length) { setError('Enter at least one East Rand or Pretoria booking quantity.'); return }
    setBusy(true); setError('')
    try {
      const response = await fetch(API + '/api/stock-booking/export', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(rows) })
      if (!response.ok) throw new Error('Could not export the Stock Booking file.')
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'LocationTransfer.csv'; link.click(); URL.revokeObjectURL(url); setNotice('Stock Booking export downloaded.')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="rfq-workspace">
    <div className="sd-session-bar"><PackageCheck size={18} /><span>Smart Stock Control workspace</span><div className="sd-view-tabs"><button className="active">Stock Booking</button></div></div>
    <div className="rfq-toolbar buyouts-toolbar"><label className="rfq-search"><Search size={15} />Search stock<input placeholder="Part number or description" value={search} onChange={e => setSearch(e.target.value)} /></label><label>From<select value={fromLocation} onChange={e => setFromLocation(e.target.value)}><option value="">Select location</option>{locations.map(location => <option key={location.id} value={location.name}>{location.name}{location.description ? ` — ${location.description}` : ''}</option>)}</select></label><label>To<select value={toLocation} onChange={e => setToLocation(e.target.value)}><option value="">Select location</option>{locations.filter(location => location.name !== fromLocation).map(location => <option key={location.id} value={location.name}>{location.name}{location.description ? ` — ${location.description}` : ''}</option>)}</select></label><label className="stock-comments-field">Comments<input value={comments} onChange={e => setComments(e.target.value)} placeholder="Applied to every exported line" /></label><button className="primary" disabled={busy} onClick={() => void exportRows()}><Download size={16} /> Export picking list</button></div>
    <div className="rfq-table-wrap"><table className="rfq-table stock-booking-table"><thead><tr><th>Franchise</th><th>Part No</th><th>Description</th><th>Unit size</th><th>Supply ER</th><th>On picking slip ER</th><th>QOH ER / Max ER</th><th>Supply PTA</th><th>On picking slip PTA</th><th>QOH PTA / Max PTA</th><th>QOH WH / Max WH</th><th>Book ER</th><th>Book PTA</th></tr></thead><tbody>{visible.map(item => { const qty = selected[item.id] || { er: 0, pta: 0 }; return <tr className="rfq-data-row" key={item.id}><td>{item.franchise || '—'}</td><td>{item.part_number}</td><td>{item.description}</td><td>{item.unit_size || '—'}</td><td>{item.supply_er}</td><td>{item.on_picking_slip_er}</td><td>{item.qoh_er} / {item.max_er}</td><td>{item.supply_pta}</td><td>{item.on_picking_slip_pta}</td><td>{item.qoh_pta} / {item.max_pta}</td><td>{item.qoh_wh} / {item.max_wh}</td><td><input className="stock-booking-qty" type="number" min="0" max={item.qoh_wh} value={qty.er || ''} onChange={e => setQty(item.id, 'er', e.target.value)} /></td><td><input className="stock-booking-qty" type="number" min="0" max={item.qoh_wh} value={qty.pta || ''} onChange={e => setQty(item.id, 'pta', e.target.value)} /></td></tr> })}{!visible.length && <tr><td colSpan={13}><div className="rfq-empty"><PackageCheck size={28} /><h3>No stock items available</h3><p>Load the Qlik/Google Sheets stock list to begin booking.</p></div></td></tr>}</tbody></table></div>
  </section>
}
