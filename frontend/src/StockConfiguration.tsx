import { useCallback, useEffect, useState } from 'react'
import { Pencil, Plus, Trash2, X } from 'lucide-react'
import { supabase } from './supabase'
import {
  createStockDevelopmentStatus,
  deleteStockDevelopmentStatus,
  deleteStockLocation,
  loadStockConfiguration,
  saveStockLocation,
  saveStockThresholds,
  setStockDevelopmentStatusActive,
  setStockLocationActive,
  type StockDevelopmentStatus,
  type StockLocation,
} from './stockConfigurationData'

type Props = { token: string; setNotice: (message: string) => void; setError: (message: string) => void }
const blankLocation = { name: '', description: '', vehicle_name: '', supply_branch: '', color: '#dff7ff' }

export default function StockConfiguration({ setNotice, setError }: Props) {
  const [locations, setLocations] = useState<StockLocation[]>([])
  const [statuses, setStatuses] = useState<StockDevelopmentStatus[]>([])
  const [slowMax, setSlowMax] = useState('2')
  const [abMin, setAbMin] = useState('10')
  const [locationForm, setLocationForm] = useState<Record<string, string>>(blankLocation)
  const [editingLocation, setEditingLocation] = useState<string | null>(null)
  const [newStatus, setNewStatus] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return }
    try {
      const data = await loadStockConfiguration(supabase)
      setLocations(data.locations)
      setStatuses(data.statuses)
      setSlowMax(String(data.settings.slow_max_avg_sales))
      setAbMin(String(data.settings.ab_min_avg_sales))
      setIsAdmin(data.access.isAdmin)
      setError('')
    } catch (error) { setError((error as Error).message) }
    finally { setLoading(false) }
  }, [setError])

  useEffect(() => { void load() }, [load])

  const perform = async (action: () => Promise<unknown>, message: string) => {
    if (saving) return
    setSaving(true); setError('')
    try { await action(); setNotice(message); await load() }
    catch (error) { setError((error as Error).message) }
    finally { setSaving(false) }
  }

  const saveLocation = () => perform(async () => {
    if (!supabase) throw new Error('Supabase is not configured.')
    await saveStockLocation(supabase, editingLocation, locationForm)
    setEditingLocation(null); setLocationForm(blankLocation)
  }, 'Stock location saved successfully.')

  if (loading) return <section className="settings-page"><p>Loading Stock Control configuration…</p></section>
  if (!isAdmin) return <section className="settings-page"><div className="settings-card"><h2>Administrator access required</h2><p>Only administrators can change Smart Stock Control configuration.</p></div></section>

  return <section className="settings-page">
    <div className="section-head"><div><h2>Stock Control configuration</h2><p>Manage shared mover thresholds, locations and Parts Query Development Statuses.</p></div></div>

    <div className="settings-card">
      <h3>Reordering thresholds</h3><p>These shared values replace the browser-only settings previously stored on each computer.</p>
      <div className="inline-form stock-config-form">
        <label>Slow Movers: less than or equal to<input aria-label="Slow mover threshold" type="number" min="0" step="0.1" value={slowMax} onChange={(event) => setSlowMax(event.target.value)} /></label>
        <label>A&amp;B Movers: greater than or equal to<input aria-label="A and B mover threshold" type="number" min="0" step="0.1" value={abMin} onChange={(event) => setAbMin(event.target.value)} /></label>
        <button className="primary" disabled={saving} onClick={() => void perform(async () => { if (!supabase) throw new Error('Supabase is not configured.'); await saveStockThresholds(supabase, slowMax, abMin) }, 'Mover thresholds saved.')}>Save thresholds</button>
      </div>
    </div>

    <div className="settings-card">
      <h3>Locations</h3><p>Inactive locations remain available to historical records but are hidden from new work.</p>
      <div className="inline-form stock-config-form">
        <input aria-label="Location code" placeholder="Location code" value={locationForm.name} onChange={(event) => setLocationForm({ ...locationForm, name: event.target.value })} />
        <input aria-label="Location description" placeholder="Description (optional)" value={locationForm.description} onChange={(event) => setLocationForm({ ...locationForm, description: event.target.value })} />
        <input aria-label="Vehicle location" placeholder="Vehicle location (optional)" value={locationForm.vehicle_name} onChange={(event) => setLocationForm({ ...locationForm, vehicle_name: event.target.value })} />
        <select aria-label="Supply branch" className="stock-config-select" value={locationForm.supply_branch} onChange={(event) => setLocationForm({ ...locationForm, supply_branch: event.target.value })}>
          <option value="">No branch supply mapping</option><option value="er">Highlights Supply ER</option><option value="pta">Highlights Supply PTA</option>
        </select>
        <label className="stock-color-field">Highlight color<input type="color" value={locationForm.color} onChange={(event) => setLocationForm({ ...locationForm, color: event.target.value })} /></label>
        <button className="primary" disabled={saving} onClick={() => void saveLocation()}>{editingLocation ? 'Save changes' : <><Plus size={16} /> Add location</>}</button>
        {editingLocation && <button className="secondary" disabled={saving} onClick={() => { setEditingLocation(null); setLocationForm(blankLocation) }}><X size={16} /> Cancel</button>}
      </div>
      <div className="config-list">{locations.map((location) => <div className={`config-row${location.is_active ? '' : ' stock-config-inactive'}`} key={location.id}>
        <span><b>{location.name}</b>{location.description ? ` — ${location.description}` : ''}{location.vehicle_name ? ` · Vehicle: ${location.vehicle_name}` : ''}<small>{location.is_active ? 'Active' : 'Inactive'}{location.supply_branch ? ` · Supply ${location.supply_branch.toUpperCase()}` : ''}</small></span>
        <div className="stock-config-actions">
          <button className="secondary" disabled={saving} onClick={() => void perform(async () => { if (!supabase) throw new Error('Supabase is not configured.'); await setStockLocationActive(supabase, location.id, !location.is_active) }, `Location ${location.is_active ? 'deactivated' : 'activated'}.`)}>{location.is_active ? 'Deactivate' : 'Activate'}</button>
          <button className="icon-button" aria-label={`Edit ${location.name}`} onClick={() => { setEditingLocation(location.id); setLocationForm({ name: location.name, description: location.description, vehicle_name: location.vehicle_name, supply_branch: location.supply_branch, color: location.color }) }}><Pencil size={16} /></button>
          <button className="icon-button" aria-label={`Delete ${location.name}`} onClick={() => { if (window.confirm(`Delete ${location.name}?`)) void perform(async () => { if (!supabase) throw new Error('Supabase is not configured.'); await deleteStockLocation(supabase, location.id) }, 'Stock location deleted.') }}><Trash2 size={16} /></button>
        </div>
      </div>)}</div>
    </div>

    <div className="settings-card">
      <h3>Parts Query Development Statuses</h3><p>Used statuses can be deactivated but cannot be deleted.</p>
      <div className="inline-form stock-config-form"><input aria-label="New Development Status" placeholder="New Development Status" value={newStatus} onChange={(event) => setNewStatus(event.target.value)} /><button className="primary" disabled={saving} onClick={() => void perform(async () => { if (!supabase) throw new Error('Supabase is not configured.'); await createStockDevelopmentStatus(supabase, newStatus); setNewStatus('') }, 'Development Status added.')}><Plus size={16} /> Add status</button></div>
      <div className="config-list">{statuses.map((status) => <div className={`config-row${status.is_active ? '' : ' stock-config-inactive'}`} key={status.name}><span><b>{status.name}</b><small>{status.is_active ? 'Active' : 'Inactive'}</small></span><div className="stock-config-actions">
        <button className="secondary" disabled={saving} onClick={() => void perform(async () => { if (!supabase) throw new Error('Supabase is not configured.'); await setStockDevelopmentStatusActive(supabase, status.name, !status.is_active) }, `Development Status ${status.is_active ? 'deactivated' : 'activated'}.`)}>{status.is_active ? 'Deactivate' : 'Activate'}</button>
        <button className="icon-button" aria-label={`Delete ${status.name}`} onClick={() => { if (window.confirm(`Delete ${status.name}?`)) void perform(async () => { if (!supabase) throw new Error('Supabase is not configured.'); await deleteStockDevelopmentStatus(supabase, status.name) }, 'Development Status deleted.') }}><Trash2 size={16} /></button>
      </div></div>)}</div>
    </div>
  </section>
}
