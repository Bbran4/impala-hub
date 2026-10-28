import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3, ClipboardList, Megaphone, PackageCheck, Search, Settings,
  ShieldCheck, ShoppingCart, Tags, Truck, Users,
  type LucideIcon,
} from 'lucide-react'
import { supabase } from './supabase'

type AppDefinition = {
  id: string
  label: string
  description: string
  status: 'available' | 'planned'
  icon: LucideIcon
}

type AccessRow = {
  profile_id: string
  display_name: string
  email: string | null
  sales_code: string | null
  direct_access: boolean
  inherited_access: boolean
  can_open: boolean
  access_reason: string | null
}

type CampaignDropTarget = { type: string; edge: 'before' | 'after' }

type Props = {
  integrations: any[]
  facebookPages: Array<{ id: string; name: string }>
  selectedFacebookPage: string
  setSelectedFacebookPage: (value: string) => void
  busy: boolean
  connectFacebook: () => Promise<void>
  chooseFacebookPage: () => Promise<void>
  checkFacebookConnection: () => Promise<void>
  disconnectFacebook: () => Promise<void>
  connectInstagram: () => Promise<void>
  checkInstagramConnection: () => Promise<void>
  disconnectInstagram: () => Promise<void>
  campaignTypes: string[]
  addCampaignType: (name: string) => Promise<boolean>
  deleteCampaignType: (name: string) => Promise<boolean>
  reorderCampaignTypes: (names: string[]) => Promise<boolean>
  setNotice: (message: string) => void
  setError: (message: string) => void
}

const APPS: AppDefinition[] = [
  { id: 'marketing', label: 'Marketing', description: 'Social publishing, campaigns and insights.', status: 'available', icon: Megaphone },
  { id: 'sales_desk', label: 'Sales Desk', description: 'RFQs, assignments and sales follow-up.', status: 'available', icon: ClipboardList },
  { id: 'returns_claims', label: 'Returns & Claims', description: 'Returns, claims and supplier outcomes.', status: 'available', icon: ClipboardList },
  { id: 'stock_control', label: 'Smart Stock Control', description: 'Stock booking, reordering and parts queries.', status: 'available', icon: PackageCheck },
  { id: 'fleet_management', label: 'Fleet Management', description: 'Vehicle and fleet operations.', status: 'planned', icon: Truck },
  { id: 'ecommerce', label: 'E-commerce', description: 'Online sales and catalogue operations.', status: 'planned', icon: ShoppingCart },
  { id: 'reporting', label: 'Reporting', description: 'ERP data, reports and dashboards.', status: 'available', icon: BarChart3 },
]

const ACCESS_REASON_LABELS: Record<string, string> = {
  administrator: 'Administrator',
  management: 'Management',
  sales_manager: 'Sales Manager',
  report_builder: 'Report builder',
  shared_reporting_app: 'Shared dashboard',
}

export default function AdminSettings(props: Props) {
  const [selectedAppId, setSelectedAppId] = useState('marketing')
  const [accessRows, setAccessRows] = useState<AccessRow[]>([])
  const [accessLoading, setAccessLoading] = useState(true)
  const [savingProfileId, setSavingProfileId] = useState<string | null>(null)
  const [accessSearch, setAccessSearch] = useState('')
  const [campaignDraft, setCampaignDraft] = useState('')
  const [draggedCampaignType, setDraggedCampaignType] = useState<string | null>(null)
  const [campaignDropTarget, setCampaignDropTarget] = useState<CampaignDropTarget | null>(null)
  const accessRequest = useRef(0)
  const selectedApp = APPS.find((app) => app.id === selectedAppId) || APPS[0]

  async function loadAccess(appId = selectedAppId) {
    if (!supabase) return
    const requestId = ++accessRequest.current
    setAccessLoading(true)
    const { data, error } = await supabase.rpc('admin_list_app_access', { p_app_id: appId })
    if (requestId !== accessRequest.current) return
    if (error) {
      props.setError(`Could not load application access: ${error.message}`)
      setAccessRows([])
    } else {
      setAccessRows((data || []) as AccessRow[])
    }
    setAccessLoading(false)
  }

  useEffect(() => { void loadAccess(selectedAppId) }, [selectedAppId])

  const visibleRows = useMemo(() => {
    const query = accessSearch.trim().toLocaleLowerCase()
    if (!query) return accessRows
    return accessRows.filter((row) => `${row.display_name} ${row.email || ''} ${row.sales_code || ''}`.toLocaleLowerCase().includes(query))
  }, [accessRows, accessSearch])

  async function setAccess(row: AccessRow, canOpen: boolean) {
    if (!supabase || row.inherited_access) return
    setSavingProfileId(row.profile_id)
    props.setError('')
    const { error } = await supabase.rpc('admin_set_app_access', {
      p_profile_id: row.profile_id,
      p_app_id: selectedAppId,
      p_can_open: canOpen,
    })
    if (error) {
      props.setError(`Could not update application access: ${error.message}`)
    } else {
      props.setNotice(`${row.display_name || row.email || 'Employee'} ${canOpen ? 'can now open' : 'can no longer open'} ${selectedApp.label}.`)
      await loadAccess(selectedAppId)
    }
    setSavingProfileId(null)
  }

  function campaignDropEdge(event: React.DragEvent<HTMLDivElement>): 'before' | 'after' {
    const bounds = event.currentTarget.getBoundingClientRect()
    return event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
  }

  function showCampaignDropTarget(event: React.DragEvent<HTMLDivElement>, target: string) {
    event.preventDefault()
    if (!draggedCampaignType || draggedCampaignType === target) { setCampaignDropTarget(null); return }
    const edge = campaignDropEdge(event)
    setCampaignDropTarget({ type: target, edge })
  }

  function reorderCampaignType(target: string, edge: 'before' | 'after') {
    if (!draggedCampaignType || draggedCampaignType === target) { setCampaignDropTarget(null); return }
    const next = [...props.campaignTypes]
    const from = next.indexOf(draggedCampaignType)
    next.splice(from, 1)
    const targetIndex = next.indexOf(target)
    next.splice(targetIndex + (edge === 'after' ? 1 : 0), 0, draggedCampaignType)
    setDraggedCampaignType(null)
    setCampaignDropTarget(null)
    void props.reorderCampaignTypes(next)
  }

  return (
    <section className="admin-settings">
      <div className="admin-settings-layout">
        <nav className="admin-settings-apps" aria-label="Application settings">
          <div className="admin-settings-menu-head"><Settings size={18} /><div><b>Application settings</b><span>Choose an app to configure.</span></div></div>
          {APPS.map((app) => {
            const Icon = app.icon
            return <button key={app.id} disabled={savingProfileId !== null} className={selectedAppId === app.id ? 'active' : ''} onClick={() => { setSelectedAppId(app.id); setAccessSearch('') }}>
              <Icon size={18} /><span><b>{app.label}</b><small>{app.status === 'planned' ? 'Planned' : 'Available'}</small></span>
            </button>
          })}
        </nav>

        <div className="admin-settings-content">
          <div className="admin-settings-heading">
            <div className="admin-settings-app-icon"><selectedApp.icon size={24} /></div>
            <div><span className="eyebrow">APPLICATION SETTINGS</span><h2>{selectedApp.label}</h2><p>{selectedApp.description}</p></div>
            <span className={`admin-app-status ${selectedApp.status}`}>{selectedApp.status === 'planned' ? 'Planned app' : 'Available'}</span>
          </div>

          {selectedAppId === 'marketing' && <>
            <section className="admin-settings-panel">
              <div className="section-head"><div><h2>Social media channels</h2><p>Connect, verify and disconnect the accounts used by Marketing.</p></div></div>
              <div className="integration-list">
                {props.integrations.filter((item) => item.provider === 'facebook' || item.provider === 'instagram').map((item) => (
                  <div className="integration" key={item.provider}>
                    <div className="integration-main">
                      <div className={`provider-icon ${item.provider}`}>{item.provider === 'facebook' ? 'f' : '◎'}</div>
                      <div className="integration-info">
                        <b>{item.label || (item.provider === 'facebook' ? 'Facebook' : 'Instagram')}</b>
                        <p>{item.note || (item.status === 'connected' ? 'Live account identity check passed.' : 'Official account connection is not configured.')}</p>
                        {item.provider === 'facebook' && item.page_id && <p><strong>Page ID:</strong> {item.page_id}</p>}
                        {item.provider === 'instagram' && item.account_id && <p><strong>Account ID:</strong> {item.account_id}</p>}
                        {item.username && <p><strong>Username:</strong> @{item.username}</p>}
                        {item.last_checked_at && <p><strong>Last checked:</strong> {new Date(item.last_checked_at).toLocaleString()}</p>}
                        {item.last_success_at && <p><strong>Last successful check:</strong> {new Date(item.last_success_at).toLocaleString()}</p>}
                        {item.expires_at && <p><strong>Token expires:</strong> {new Date(item.expires_at * 1000).toLocaleString()}</p>}
                        {item.data_access_expires_at && <p><strong>Data access expires:</strong> {new Date(item.data_access_expires_at * 1000).toLocaleString()}</p>}
                        {item.granted_permissions?.length > 0 && <p><strong>Granted permissions:</strong> {item.granted_permissions.join(', ')}</p>}
                        {item.missing_permissions?.length > 0 && <p><strong>Missing permissions:</strong> {item.missing_permissions.join(', ')}</p>}
                        {item.diagnostic_note && <p>{item.diagnostic_note}</p>}
                        {item.token_warning && <p className="token-warning"><strong>Token warning:</strong> {item.token_warning}</p>}
                        <span className="status-badge">{item.status === 'connected' ? `Connected${item.account_name ? `: ${item.account_name}` : ''}` : item.status === 'warning' ? 'Permission warning' : item.status === 'error' ? 'Connection error' : 'Not connected'}</span>
                      </div>
                    </div>
                    {item.provider === 'facebook' ? <div className="integration-actions">
                      <button className="primary" disabled={props.busy} onClick={() => void props.connectFacebook()}>{props.busy ? 'Working...' : item.status === 'connected' ? 'Reconnect Facebook' : 'Connect Facebook'}</button>
                      <button className="secondary" disabled={props.busy || item.status === 'not_connected'} onClick={() => void props.checkFacebookConnection()}>Check connection</button>
                      {item.status !== 'not_connected' && <button className="secondary" disabled={props.busy} onClick={() => void props.disconnectFacebook()}>Disconnect</button>}
                      {props.facebookPages.length > 0 && <div className="facebook-page-picker">
                        <label htmlFor="settings-facebook-page">Choose a Facebook Page</label>
                        <select id="settings-facebook-page" value={props.selectedFacebookPage} onChange={(event) => props.setSelectedFacebookPage(event.target.value)}>
                          {props.facebookPages.map((page) => <option key={page.id} value={page.id}>{page.name} ({page.id})</option>)}
                        </select>
                        <button className="secondary" disabled={props.busy || !props.selectedFacebookPage} onClick={() => void props.chooseFacebookPage()}>Use this Page</button>
                      </div>}
                    </div> : <div className="integration-actions">
                      <button className="primary" disabled={props.busy} onClick={() => void props.connectInstagram()}>{item.status === 'connected' ? 'Reconnect Instagram' : 'Connect Instagram'}</button>
                      <button className="secondary" disabled={props.busy || item.status !== 'connected'} onClick={() => void props.checkInstagramConnection()}>Check connection</button>
                      {item.status === 'connected' && <button className="secondary" disabled={props.busy} onClick={() => void props.disconnectInstagram()}>Disconnect</button>}
                    </div>}
                  </div>
                ))}
              </div>
            </section>

            <section className="admin-settings-panel">
              <div className="section-head"><div><h2>Campaign types</h2><p>Manage the categories used by campaigns and grouped post insights.</p></div><Tags size={19} /></div>
              <div className="campaign-type-add"><input value={campaignDraft} placeholder="Add campaign type" onChange={(event) => setCampaignDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && campaignDraft.trim()) void props.addCampaignType(campaignDraft.trim()).then((saved) => { if (saved) setCampaignDraft('') }) }} /><button className="primary" disabled={!campaignDraft.trim()} onClick={() => void props.addCampaignType(campaignDraft.trim()).then((saved) => { if (saved) setCampaignDraft('') })}>Add type</button></div>
              <div className="campaign-type-list">{props.campaignTypes.map((type) => {
                const dropEdge = campaignDropTarget?.type === type ? campaignDropTarget.edge : null
                return <div
                  className={`campaign-type-row ${draggedCampaignType === type ? 'dragging' : ''} ${dropEdge ? `drop-${dropEdge}` : ''}`}
                  key={type}
                  draggable
                  onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; setDraggedCampaignType(type); setCampaignDropTarget(null) }}
                  onDragOver={(event) => showCampaignDropTarget(event, type)}
                  onDrop={(event) => { event.preventDefault(); reorderCampaignType(type, campaignDropEdge(event)) }}
                  onDragEnd={() => { setDraggedCampaignType(null); setCampaignDropTarget(null) }}
                ><span>☷ {type}</span><button className="text-button" onClick={() => void props.deleteCampaignType(type)}>Remove</button></div>
              })}</div>
            </section>
          </>}

          <section className="admin-settings-panel app-access-panel">
            <div className="section-head"><div><h2>Who can open this app</h2><p>Grant application access to active employee accounts. Administrators and platform-wide roles are inherited.</p></div><ShieldCheck size={20} /></div>
            <div className="app-access-toolbar"><label><Search size={16} /><input aria-label="Search employees" value={accessSearch} onChange={(event) => setAccessSearch(event.target.value)} placeholder="Search name, email or sales code" /></label><span><Users size={15} /> {accessRows.filter((row) => row.can_open).length} with access</span></div>
            <div className="app-access-list">
              {accessLoading ? <div className="app-access-empty">Loading employee access…</div> : visibleRows.length === 0 ? <div className="app-access-empty">No active employees match this search.</div> : visibleRows.map((row) => (
                <label className={`app-access-row ${row.inherited_access ? 'inherited' : ''}`} key={row.profile_id}>
                  <span className="app-access-avatar">{(row.display_name || row.email || '?').slice(0, 1).toUpperCase()}</span>
                  <span className="app-access-person"><b>{row.display_name || row.email || 'Unnamed employee'}</b><small>{[row.sales_code, row.email].filter(Boolean).join(' · ')}</small></span>
                  {row.inherited_access && <span className="app-access-reason">{ACCESS_REASON_LABELS[row.access_reason || ''] || 'Inherited access'}</span>}
                  {!row.inherited_access && row.direct_access && <span className="app-access-reason direct">App role</span>}
                  <input type="checkbox" checked={row.can_open} disabled={row.inherited_access || savingProfileId === row.profile_id} onChange={(event) => void setAccess(row, event.target.checked)} />
                </label>
              ))}
            </div>
          </section>
        </div>
      </div>
    </section>
  )
}

