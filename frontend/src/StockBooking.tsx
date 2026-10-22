import { useEffect, useMemo, useState } from 'react'
import { Download, PackageCheck, Search } from 'lucide-react'
import { API } from './lib'

type Item = { id: string; franchise: string; part_number: string; description: string; unit_size: string; supply_er: number; on_picking_slip_er: number; qoh_er: number; max_er: number; supply_pta: number; on_picking_slip_pta: number; qoh_pta: number; max_pta: number; qoh_wh: number; max_wh: number; bin_pta: string; bin_er: string; bin_wh: string }
type Location = { id: string; name: string; description?: string; vehicle_name?: string; supply_branch?: '' | 'er' | 'pta'; color?: string }
type Props = { token: string; setNotice: (message: string) => void; setError: (message: string) => void }
const TEMP_FRANCHISES: Record<string, string> = { abc001: 'hadidas', xyz998: 'mike', '33215': 'generic', 'hp0-15-6': 'generic', zzzahx: 'pumba' }

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
  const [supplySort, setSupplySort] = useState<'none' | 'er' | 'pta'>('none')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const load = async () => { try { const [stock, configuredLocations] = await Promise.all([request<Item[]>(token, '/api/stock-booking/items'), request<Location[]>(token, '/api/stock-booking/locations')]); setItems(stock); setLocations(configuredLocations); const warehouse = configuredLocations.find(location => location.name === '10' || location.description?.toLowerCase().includes('warehouse')); const vehicle = configuredLocations.find(location => ['erbakkie', 'ptabakkie'].includes((location.vehicle_name || '').toLowerCase().replaceAll(' ', '')))?.vehicle_name || ''; setFromLocation(current => current || warehouse?.name || ''); setToLocation(current => current || vehicle); setError('') } catch (e) { setError((e as Error).message) } }
  useEffect(() => { void load() }, [token])
  const supplyEr = (item: Item) => Math.max(0, item.max_er - item.qoh_er - item.on_picking_slip_er)
  const supplyPta = (item: Item) => Math.max(0, item.max_pta - item.qoh_pta - item.on_picking_slip_pta)
  const visible = useMemo(() => { const q = search.trim().toLowerCase(); return items.filter(i => (!q || `${i.part_number} ${i.description}`.toLowerCase().includes(q)) && (supplySort === 'none' || (supplySort === 'er' ? supplyEr(i) > 0 : supplyPta(i) > 0))).sort((a, b) => supplySort === 'er' ? supplyEr(b) - supplyEr(a) : supplySort === 'pta' ? supplyPta(b) - supplyPta(a) : a.part_number.localeCompare(b.part_number)) }, [items, search, supplySort])
  const locationOptions = locations.flatMap(location => [{ value: location.name, label: `${location.name}${location.description ? ` — ${location.description}` : ''}`, supply_branch: location.supply_branch || '', color: location.color }, ...(location.vehicle_name ? [{ value: location.vehicle_name, label: `${location.vehicle_name} (vehicle for ${location.name})`, supply_branch: location.supply_branch || '', color: location.color }] : [])])
  const fromLocationOptions = locationOptions.filter(location => location.value === '10' || location.label.toLowerCase().includes('10 — warehouse'))
  const toLocationOptions = locationOptions.filter(location => ['erbakkie', 'ptabakkie'].includes(location.value.toLowerCase().replaceAll(' ', '')))
  const selectedDestination = locationOptions.find(location => location.value === toLocation)
  const selectedSource = locationOptions.find(location => location.value === fromLocation)
  useEffect(() => { if (selectedDestination?.supply_branch === 'er') setSupplySort('er'); else if (selectedDestination?.supply_branch === 'pta') setSupplySort('pta') }, [selectedDestination?.supply_branch])
  const warehouseSelected = selectedSource?.value.toLowerCase().includes('wh') || selectedSource?.value.toLowerCase().includes('warehouse') || selectedSource?.label.toLowerCase().includes('warehouse')
  const binFor = (location: string, item: Item) => { const selected = locationOptions.find(option => option.value === location); const value = [location, selected?.label || ''].join(' ').toLowerCase(); if (value.includes('pta') || value.includes('pretoria')) return item.bin_pta; if (value.includes('er') || value.includes('east')) return item.bin_er; if (value.includes('wh') || value.includes('warehouse')) return item.bin_wh; return '' }
  const setQty = (id: string, value: string) => setSelected(prev => ({ ...prev, [id]: Math.max(0, Number(value) || 0) }))
  const exportRows = async () => {
    if (!fromLocation || !toLocation || fromLocation === toLocation) { setError('Choose two different From and To locations before exporting.'); return }
    const rows = items.flatMap(item => {
      const qty = selected[item.id] || 0
      return qty ? [{ part_number: item.part_number, franchise: item.franchise || TEMP_FRANCHISES[item.part_number] || toLocation, from_location: fromLocation, from_bin_location: binFor(fromLocation, item), to_location: toLocation, to_bin_location: binFor(toLocation, item), transfer_qty: qty, remarks: comments }] : []
    })
    if (!rows.length) { setError('Enter at least one East Rand or Pretoria booking quantity.'); return }
    setBusy(true); setError('')
    try {
      const response = await fetch(API + '/api/stock-booking/export', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(rows) })
      if (!response.ok) throw new Error('Could not export the Stock Booking file.')
      const now = new Date(); const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`; const time = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`; const branch = selectedDestination?.supply_branch === 'pta' ? 'PT' : 'ER'; const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${date}${branch}${time}.csv`; link.click(); URL.revokeObjectURL(url); setSelected({}); setNotice('Stock Booking export downloaded.')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="rfq-workspace">
    <div className="sd-session-bar"><PackageCheck size={18} /><span>Smart Stock Control workspace</span><div className="sd-view-tabs"><button className="active">Stock Booking</button></div></div>
    <div className="rfq-toolbar buyouts-toolbar"><label className="rfq-search"><Search size={15} />Search stock<input placeholder="Part number or description" value={search} onChange={e => setSearch(e.target.value)} /></label><label>From<select value={fromLocation} onChange={e => setFromLocation(e.target.value)}><option value="">Select location</option>{fromLocationOptions.map(location => <option key={location.value} value={location.value}>{location.label}</option>)}</select></label><label>To<select value={toLocation} onChange={e => { setToLocation(e.target.value); setSelected({}) }}><option value="">Select vehicle</option>{toLocationOptions.map(location => <option key={location.value} value={location.value}>{location.label}</option>)}</select></label><div className="stock-sort-actions"><span>Order by supply</span><button className={supplySort === 'er' ? 'secondary active' : 'secondary'} onClick={() => setSupplySort(supplySort === 'er' ? 'none' : 'er')}>ER Supply ↓</button><button className={supplySort === 'pta' ? 'secondary active' : 'secondary'} onClick={() => setSupplySort(supplySort === 'pta' ? 'none' : 'pta')}>PT Supply ↓</button></div><label className="stock-comments-field">Comments<input value={comments} onChange={e => setComments(e.target.value)} placeholder="Applied to every exported line" /></label><button className="primary" disabled={busy} onClick={() => void exportRows()}><Download size={16} /> Export picking list</button></div>
    <div className="rfq-table-wrap"><table className="rfq-table stock-booking-table"><thead><tr><th>Franchise</th><th>Part No</th><th>Description</th><th>Unit size</th><th className={selectedDestination?.supply_branch === 'er' ? 'stock-supply-highlight' : ''} style={selectedDestination?.supply_branch === 'er' ? { backgroundColor: selectedDestination.color } : undefined}>Supply ER</th><th>On picking slip ER</th><th>QOH ER / Max ER</th><th className={selectedDestination?.supply_branch === 'pta' ? 'stock-supply-highlight' : ''} style={selectedDestination?.supply_branch === 'pta' ? { backgroundColor: selectedDestination.color } : undefined}>Supply PTA</th><th>On picking slip PTA</th><th>QOH PTA / Max PTA</th><th style={warehouseSelected ? { backgroundColor: selectedSource?.color } : undefined}>QOH WH / Max WH</th><th>Book</th></tr></thead><tbody>{visible.map(item => { const qty = selected[item.id] || 0; const noWarehouseStock = item.qoh_wh <= 0; const erShort = item.qoh_wh < item.qoh_er; const ptaShort = item.qoh_wh < item.qoh_pta; return <tr className={`rfq-data-row ${noWarehouseStock ? 'stock-row-no-warehouse' : ''}`} key={item.id}><td>{item.franchise || TEMP_FRANCHISES[item.part_number] || '—'}</td><td>{item.part_number}</td><td>{item.description}</td><td>{item.unit_size || '—'}</td><td className={selectedDestination?.supply_branch === 'er' ? 'stock-supply-highlight' : ''} style={selectedDestination?.supply_branch === 'er' ? { backgroundColor: selectedDestination.color } : undefined}>{supplyEr(item)}</td><td className={item.on_picking_slip_er > 0 ? 'stock-cell-picking-slip' : ''}>{item.on_picking_slip_er}</td><td className={erShort ? 'stock-cell-short' : ''}>{item.qoh_er} / {item.max_er}</td><td className={selectedDestination?.supply_branch === 'pta' ? 'stock-supply-highlight' : ''} style={selectedDestination?.supply_branch === 'pta' ? { backgroundColor: selectedDestination.color } : undefined}>{supplyPta(item)}</td><td className={item.on_picking_slip_pta > 0 ? 'stock-cell-picking-slip' : ''}>{item.on_picking_slip_pta}</td><td className={ptaShort ? 'stock-cell-short' : ''}>{item.qoh_pta} / {item.max_pta}</td><td className={warehouseSelected ? '' : ''} style={warehouseSelected ? { backgroundColor: selectedSource?.color } : undefined}>{item.qoh_wh} / {item.max_wh}</td><td><input className="stock-booking-qty" type="number" min="0" max={item.qoh_wh} value={qty || ''} onChange={e => setQty(item.id, e.target.value)} /></td></tr> })}{!visible.length && <tr><td colSpan={12}><div className="rfq-empty"><PackageCheck size={28} /><h3>No stock items available</h3><p>Load the Qlik/Google Sheets stock list to begin booking.</p></div></td></tr>}</tbody></table></div>
  </section>
}
