import { useEffect, useMemo, useState } from 'react'
import {
  BarChart3, CalendarClock, CheckCircle2, ChevronDown, CircleAlert, ClipboardList, ImagePlus, Users, Heart, MessageCircle, Eye, ExternalLink,
  LayoutDashboard, Megaphone, Plus, Search, Settings, Send, Trash2, Upload, X, Map,
} from 'lucide-react'
import PostDetail from './PostDetail'
import PostBoard from './PostBoard'
import PostCalendar from './PostCalendar'
import MonthNav from './MonthNav'
import SalesDesk from './SalesDesk'
import Buyouts from './Buyouts'
import { API as apiBaseUrl, api, AuthError, EDITABLE, fmt, getKey, inMonth, isFuture, KEY_STORAGE, mediaSrc, metric, startOfMonth, type Media, type Post, type Campaign } from './lib'

const pad = (n: number) => String(n).padStart(2, '0')
const toLocalInput = (value?: string | null) => {
  if (!value) return ''
  const d = new Date(value)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const emptyPost = (): Partial<Post> => ({
  title: '', caption: '', campaign_id: null, channels: ['facebook'],
  whatsapp_recipient_type: 'contact', whatsapp_recipient_id: '', whatsapp_recipient_name: '',
  status: 'draft', publish_at: '', media: [],
})
const NEEDS_ATTENTION = ['awaiting_approval', 'failed']

// Plain-English explanations for the reason codes the backend adds to the redirect after Facebook login.
const OAUTH_REASONS: Record<string, string> = {
  no_pages_selected: 'You did not tick any Page in the Facebook dialog. Click Connect Facebook again and select your Page.',
  no_pages: 'Meta returned no Pages for this account. Check that you have a role on the Page and on the Meta app. If the Page is in a Business Portfolio, set FACEBOOK_REQUEST_BUSINESS_MANAGEMENT=true in backend/.env and restart the API.',
  missing_permissions: 'Not all required permissions were granted. Connect again and accept every permission.',
  page_token_unavailable: 'Meta listed the Page but gave no Page token. You may lack full control of the Page.',
  invalid_state: 'The login session expired. Try again.',
  authorization_cancelled: 'Authorization was cancelled.',
  missing_code: 'Meta did not return an authorization code. Try again.',
  setup: 'Facebook OAuth is not fully configured in backend/.env.',
  meta_request_failed: 'A request to Meta failed. Check META_APP_ID and META_APP_SECRET in backend/.env.',
}

const SALES_ROADMAP_ROWS = [
  ['Sign-in and sessions', 'Authentication', 'Persistent Impala Hub sessions', 'Implemented'],
  ['User accounts', 'Users and roles', 'Administrator, manager, salesperson', 'Implemented'],
  ['Sales-code mapping', 'Not applicable', 'Sales consultant codes', 'Implemented'],
  ['RFQ creation', 'CRM record creation', 'Create RFQ form', 'Implemented'],
  ['RFQ editing', 'Record editing', 'Editable RFQ side panel', 'Implemented'],
  ['RFQ claiming', 'Assignment workflow', 'Claim and assign RFQs', 'Implemented'],
  ['Unclaimed RFQs', 'Work queues', 'Salespeople can view and claim', 'Implemented'],
  ['RFQ statuses', 'Pipeline stages', 'Configurable statuses', 'Implemented; Kanban improvement planned'],
  ['RFQ audit history', 'Chatter/activity history', 'Audit timeline', 'Implemented'],
  ['Attachments', 'Record attachments', 'Protected RFQ attachments', 'Implemented'],
  ['Sales Desk dashboard', 'Not applicable', 'Team RFQ and sales metrics', 'Implemented; drill-downs planned'],
  ['RFQ analytics', 'Not applicable', 'Period-filtered analytics', 'Implemented; funnel improvements planned'],
  ['Search and filtering', 'Advanced search panels', 'Basic filters', 'Partial'],
  ['Notifications', 'Activities/messages', 'Not implemented', 'Missing'],
  ['Bulk operations', 'Mass actions', 'Not implemented', 'Missing'],
  ['Export and reporting', 'List/report exports', 'Partial', 'Partial'],
  ['Evolve DMS/Qlik reconciliation', 'Not applicable', 'Planned integration', 'Planned'],
  ['Personal consultant dashboard', 'Not applicable', 'Planned sales and GP reporting', 'Planned'],
]

const ROADMAP_ROWS = [
  ['Sign-in', 'Odoo authentication', 'Impala Hub session login', 'Implemented'],
  ['Persistent session', 'Yes', 'Persistent session with retry protection', 'Implemented'],
  ['Logout', 'Yes', 'Yes', 'Implemented'],
  ['Facebook connection', 'Social account configuration', 'Meta OAuth, Page selection, diagnostics, disconnect', 'Implemented'],
  ['Instagram connection', 'Social account configuration', 'Meta OAuth for professional accounts', 'Implemented; live connection working'],
  ['WhatsApp', 'Not central', 'Deferred', 'Correctly deferred'],
  ['Feed', 'Account feeds, streams, metrics', 'Network columns, 25 newest posts, metrics', 'Partial'],
  ['Create post', 'New Post workflow', 'Create Post editor', 'Implemented'],
  ['Edit draft posts', 'Yes', 'Yes', 'Implemented'],
  ['Schedule posts', 'Yes', 'Yes', 'Implemented'],
  ['Publish now', 'Yes', 'Facebook workflow', 'Partial'],
  ['Facebook publishing', 'Yes', 'OAuth/Page publishing', 'Implemented'],
  ['Instagram publishing', 'Yes', 'OAuth/API foundation', 'Partial; live publishing verification required'],
  ['Likes, comments, shares', 'Yes', 'Stored/displayed where synced', 'Partial'],
  ['Views, reach, impressions', 'Odoo insights', 'Provider fields and fallbacks', 'Partial; Facebook Views unresolved'],
  ['Clicks', 'Yes', 'Post model and provider paths', 'Partial'],
  ['Post analytics detail', 'Post cards and insights', 'Post details and metrics', 'Partial'],
  ['Campaign creation', 'Yes', 'Yes', 'Implemented'],
  ['Campaign editing', 'Yes', 'Title/objective editing', 'Implemented'],
  ['Campaign deletion', 'Record actions', 'Not exposed as a complete workflow', 'Incomplete'],
  ['Campaign Kanban stages', 'New/In Progress/Done', 'Drag-and-drop Kanban', 'Implemented'],
  ['Post Kanban', 'Yes', 'Board view', 'Implemented'],
  ['Post calendar', 'Yes', 'Calendar view', 'Implemented'],
  ['Post list', 'Yes', 'List view', 'Implemented'],
  ['Post pivot reporting', 'Yes', 'Grouped Pivot-style insights table', 'Implemented'],
  ['Search/filtering', 'Extensive search panels', 'Basic search and filters', 'Partial'],
  ['Social conversations', 'Channels and chats', 'Not implemented', 'Missing'],
  ['Sentiment analysis', 'Visible in Channels', 'Not implemented', 'Missing'],
  ['Notifications', 'Odoo activities/messages', 'Not implemented', 'Missing'],
]
export default function App() {
  const [key, setKey] = useState(getKey())
  const [keyEntry, setKeyEntry] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [page, setPage] = useState('Apps')
  const [posts, setPosts] = useState<Post[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [integrations, setIntegrations] = useState<any[]>([])
  const [facebookPages, setFacebookPages] = useState<Array<{id: string; name: string}>>([])
  const [selectedFacebookPage, setSelectedFacebookPage] = useState('')
  const [filter, setFilter] = useState('all')
  const [campaignFilter, setCampaignFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [editor, setEditor] = useState<Partial<Post> | null>(null)
  const [campaignModal, setCampaignModal] = useState(false)
  const [editingCampaignId, setEditingCampaignId] = useState<string | null>(null)
  const [campaignName, setCampaignName] = useState('')
  const [campaignObjective, setCampaignObjective] = useState('')
  const [campaignStage, setCampaignStage] = useState<'new' | 'in_progress' | 'done'>('new')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [view, setView] = useState<'list' | 'board' | 'calendar' | 'pivot'>('list')
  const [month, setMonth] = useState<Date | null>(() => startOfMonth()) // null = all months (list and board only)

  const patchEditor = (changes: Partial<Post>) => setEditor((e) => (e ? { ...e, ...changes } : e))

  function handleError(e: unknown) {
    const message = (e as Error).message
    if (e instanceof AuthError) {
      localStorage.removeItem(KEY_STORAGE)
      sessionStorage.removeItem(KEY_STORAGE)
      setKey('')
      setKeyEntry('')
    }
    setError(message)
  }

  async function load() {
    if (!getKey()) return
    try {
      const [p, c, i] = await Promise.all([api('/api/posts'), api('/api/campaigns'), api('/api/integrations')])
      setPosts(p); setCampaigns(c); setIntegrations(i); setError('')
    } catch (e) { handleError(e) }
  }
  useEffect(() => {
    if (!key) return
    void load()
    const params = new URLSearchParams(window.location.search)
    const fb = params.get('facebook_oauth')
    const ig = params.get('instagram_oauth')
    const reason = params.get('reason') || 'unknown'
    const detail = params.get('detail')
    if (fb || ig) {
      params.delete('facebook_oauth'); params.delete('instagram_oauth'); params.delete('reason'); params.delete('detail')
      const query = params.toString()
      window.history.replaceState({}, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash)
    }
    if (fb === 'choose_page') {
      setPage('Configuration'); setNotice('Facebook authorized. Choose the Page you want Impala Hub to manage.'); void loadFacebookPages()
    } else if (fb === 'error') {
      setPage('Configuration'); setError(OAUTH_REASONS[reason] ?? `Facebook authorization did not finish (${reason.replaceAll('_', ' ')}).`)
    }
    if (ig === 'connected') {
      setPage('Configuration'); setNotice('Instagram connected.')
    } else if (ig === 'error') {
      setPage('Configuration'); setError(`Instagram authorization did not finish: ${reason.replaceAll('_', ' ')}.${detail ? ' Meta said: ' + detail : ''}`)
    }
  }, [key])

  // Reload any pending Page choices whenever Configuration opens, so a browser refresh does not lose the picker.
  useEffect(() => { if (key && page === 'Configuration') void loadFacebookPages() }, [key, page])

  // Escape closes whichever dialog is open.
  useEffect(() => {
    if (!editor && !campaignModal) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (campaignModal) setCampaignModal(false)
      else setEditor(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editor, campaignModal])

  async function signIn() {
    setError('')
    try {
      const response = await fetch(`${apiBaseUrl}/api/sales-desk/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.detail || 'Sign-in failed')
      localStorage.setItem(KEY_STORAGE, body.access_token)
      setKey(body.access_token); setPassword(''); setPage('Apps'); setNotice('Signed in successfully.')
    } catch (e) { setError((e as Error).message) }
  }

  function connectKey() {
    const trimmed = keyEntry.trim()
    if (!trimmed) return
    sessionStorage.setItem(KEY_STORAGE, trimmed)
    setKey(trimmed); setKeyEntry(''); setError(''); setNotice('API key set for this browser session.')
  }
  function disconnectKey() {
    sessionStorage.removeItem(KEY_STORAGE)
    setKey(''); setKeyEntry(''); setPosts([]); setCampaigns([]); setIntegrations([]); setNotice('')
  }

  const currentMonthPosts = useMemo(() => {
    const now = new Date()
    return posts.filter((p) => {
      const stamp = p.published_at || p.publish_at || p.created_at
      if (!stamp) return false
      const d = new Date(stamp)
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
    })
  }, [posts])

  const visiblePosts = posts.filter(
    (p) =>
      (!month || inMonth(p, month)) &&
      (filter === 'all' || p.status === filter || (filter === 'engagements' && p.status === 'published')) &&
      (campaignFilter === 'all' || p.campaign_id === campaignFilter) &&
      (!search || `${p.title} ${p.caption}`.toLowerCase().includes(search.toLowerCase())),
  )

  // Search and campaign filters only. The calendar picks its own month; the board adds the month below.
  const filteredPosts = posts.filter(
    (p) =>
      (campaignFilter === 'all' || p.campaign_id === campaignFilter) &&
      (!search || `${p.title} ${p.caption}`.toLowerCase().includes(search.toLowerCase())),
  )

  const monthPosts = month ? filteredPosts.filter((p) => inMonth(p, month)) : filteredPosts

  async function patchPost(id: string, changes: Partial<Post>, message: string) {
    try {
      await api(`/api/posts/${id}`, { method: 'PATCH', body: JSON.stringify(changes) })
      setNotice(message); setError('')
      await load()
    } catch (e) { handleError(e) }
  }

  async function syncAll() {
    setBusy(true); setError('')
    try {
      const r = await api('/api/integrations/sync', { method: 'POST' })
      const fb = r.facebook?.status === 'error' ? 'Facebook error' : `Facebook synced`
      const ig = r.instagram?.status === 'synced' ? `Instagram synced (${r.instagram.items} items)` : r.instagram?.status === 'not_connected' ? 'Instagram not connected' : 'Instagram error'
      setNotice(`${fb}; ${ig}.`)
      await load()
    } catch (e) { handleError(e) } finally { setBusy(false) }
  }

  async function loadFacebookPages() {
    try {
      const result = await api('/api/integrations/facebook/pages')
      setFacebookPages(result.pages || [])
      if (result.connected_page_id) setSelectedFacebookPage(result.connected_page_id)
      else if (result.pages?.length) setSelectedFacebookPage(result.pages[0].id)
    } catch (e) { handleError(e) }
  }

  async function connectInstagram() {
    setBusy(true); setError('')
    try {
      const result = await api('/api/integrations/instagram/oauth-url', { method: 'POST' })
      window.location.assign(result.url)
    } catch (e) { handleError(e); setBusy(false) }
  }

  async function checkInstagramConnection() {
    setBusy(true); setError('')
    try {
      const r = await api('/api/integrations/instagram/check', { method: 'POST' })
      setNotice(`Instagram connection verified for ${r.username ? '@' + r.username : r.account_id}.`)
      await load()
    } catch (e) { handleError(e) } finally { setBusy(false) }
  }

  async function disconnectInstagram() {
    if (!window.confirm('Disconnect the Instagram account saved through Connect Instagram?')) return
    setBusy(true); setError('')
    try {
      const r = await api('/api/integrations/instagram/disconnect', { method: 'POST' })
      setNotice(`Instagram disconnected. ${r.posts_removed || 0} post(s) removed from the feed.`)
      await load()
    } catch (e) { handleError(e) } finally { setBusy(false) }
  }

  async function connectFacebook() {
    setBusy(true); setError('')
    try {
      const result = await api('/api/integrations/facebook/oauth-url', { method: 'POST' })
      window.location.assign(result.url)
    } catch (e) { handleError(e); setBusy(false) }
  }

  async function chooseFacebookPage() {
    if (!selectedFacebookPage) return
    setBusy(true); setError('')
    try {
      const result = await api('/api/integrations/facebook/select-page', { method: 'POST', body: JSON.stringify({ page_id: selectedFacebookPage }) })
      setNotice('Connected Facebook Page: ' + result.page_name)
      setFacebookPages([])
      await load()
    } catch (e) { handleError(e) } finally { setBusy(false) }
  }

  async function disconnectFacebook() {
    if (!window.confirm('Disconnect the Facebook Page saved through Connect Facebook?')) return
    setBusy(true); setError('')
    try {
      await api('/api/integrations/facebook/disconnect', { method: 'POST' })
      setNotice('Saved Facebook connection removed. To also revoke Impala Hub at Meta, remove the app under Facebook Settings > Business Integrations.')
      setFacebookPages([])
      await load()
    } catch (e) { handleError(e) } finally { setBusy(false) }
  }

  async function checkFacebookConnection() {
    setBusy(true); setError('')
    try {
      const r = await api('/api/integrations/facebook/check', { method: 'POST' })
      setNotice(`Facebook connection verified for ${r.page_name || r.page_id}.`)
      await load()
    } catch (e) { handleError(e) } finally { setBusy(false) }
  }

  async function savePost(mode: 'draft' | 'schedule' | 'publish-now') {
    if (!editor) return
    setBusy(true); setError('')
    try {
      const status = mode === 'draft' ? 'draft' : mode === 'schedule' ? 'scheduled' : 'draft'
      if (mode === 'schedule' && !isFuture(editor.publish_at)) {
        throw new Error('Choose a future date and time to schedule this post.')
      }
      const payload = {
        title: editor.title ?? '',
        caption: editor.caption ?? '',
        campaign_id: editor.campaign_id || null,
        channels: editor.channels ?? [],
        whatsapp_recipient_type: editor.whatsapp_recipient_type ?? null,
        whatsapp_recipient_id: editor.whatsapp_recipient_id ?? null,
        whatsapp_recipient_name: editor.whatsapp_recipient_name ?? null,
        media: editor.media ?? [],
        status,
        publish_at: editor.publish_at ? new Date(editor.publish_at).toISOString() : null,
      }
      let saved: Post
      if (editor.id) saved = await api(`/api/posts/${editor.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
      else saved = await api('/api/posts', { method: 'POST', body: JSON.stringify(payload) })
      const facebookLive = integrations.some((i) => i.provider === 'facebook' && i.status === 'connected')
      if (mode === 'publish-now') {
        if (!facebookLive) throw new Error('Connect Facebook in Configuration before publishing.')
        await api(`/api/posts/${saved.id}/publish-now`, { method: 'POST' })
        setNotice('Publish requested. Check the post status for the confirmed Facebook result.')
      } else {
        setNotice(
          status === 'scheduled'
            ? (facebookLive ? 'Post scheduled. It will be published to Facebook at the chosen time while the API is running.' : 'Post saved as scheduled. Connect Facebook in Configuration so it can be published.')
          : 'Draft saved.',
        )
      }
      setEditor(null)
      await load()
    } catch (e) { handleError(e) } finally { setBusy(false) }
  }

  async function upload(input: HTMLInputElement) {
    const files = input.files ? Array.from(input.files) : []
    input.value = '' // allow choosing the same file again
    if (!files.length) return
    setBusy(true); setError('')
    try {
      const uploaded: Media[] = []
      for (const file of files) {
        const fd = new FormData()
        fd.append('file', file)
        uploaded.push(await api('/api/media', { method: 'POST', body: fd }))
      }
      // Functional update: keeps anything typed while the upload was running.
      setEditor((e) => (e ? { ...e, media: [...(e.media || []), ...uploaded] } : e))
    } catch (e) { handleError(e) } finally { setBusy(false) }
  }

  async function createCampaign() {
    if (!campaignName.trim()) return
    try {
      const payload = { name: campaignName, objective: campaignObjective, stage: campaignStage }
      await api(editingCampaignId ? `/api/campaigns/${editingCampaignId}` : '/api/campaigns', { method: editingCampaignId ? 'PATCH' : 'POST', body: JSON.stringify(payload) })
      setCampaignName(''); setCampaignObjective(''); setEditingCampaignId(null); setCampaignModal(false); setNotice(editingCampaignId ? 'Campaign updated.' : 'Campaign created.')
      await load()
    } catch (e) { handleError(e) }
  }
  async function moveCampaign(campaignId: string, stage: 'new' | 'in_progress' | 'done') {
    try {
      await api('/api/campaigns/' + campaignId, { method: 'PATCH', body: JSON.stringify({ stage }) })
      setNotice('Campaign moved.')
      await load()
    } catch (e) { handleError(e) }
  }

  function openCampaignEditor(c: Campaign) {
    setEditingCampaignId(c.id); setCampaignName(c.name); setCampaignObjective(c.objective || ''); setCampaignStage(c.stage || 'new'); setCampaignModal(true)
  }

  async function removePost(id: string) {
    if (!confirm('Delete this post?')) return
    try {
      await api(`/api/posts/${id}`, { method: 'DELETE' })
      if (detailId === id) { setDetailId(null); setPage('Posts') }
      await load(); setNotice('Post deleted.')
    } catch (e) { handleError(e) }
  }

  function openPost(id: string) { setDetailId(id); setPage('Post'); setError('') }

  // Failed posts reopen with their existing content and a safe near-future time.
  function reschedulePost(p: Post) {
    const when = new Date(Date.now() + 15 * 60 * 1000)
    setEditor({ ...p, status: 'draft', publish_at: toLocalInput(when.toISOString()) })
    setDetailId(null)
    setPage('Posts')
    setError('')
    setNotice('Review the post and scheduled time, then confirm Schedule post.')
  }

  // Scheduled and published posts cannot be edited, so they open the detail view instead.
  function openEditor(p: Post) {
    if (EDITABLE.includes(p.status)) { setEditor(p); setError('') } else openPost(p.id)
  }

  async function saveCampaign(postId: string, campaignId: string | null) {
    try {
      await api(`/api/posts/${postId}`, { method: 'PATCH', body: JSON.stringify({ campaign_id: campaignId }) })
      setNotice('Campaign updated.'); setError('')
      await load()
    } catch (e) { handleError(e) }
  }

  const selected = posts.find((p) => p.id === detailId)
  const channels = editor?.channels || []
  const canSchedule = isFuture(editor?.publish_at)
  const isSalesDeskPage = page === 'RFQs' || page === 'RFQ Configuration' || page === 'RFQ Roadmap'
  const isStockControlPage = page === 'Buyouts'

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">I</div>
          <div><b>IMPALA HUB</b><small>{isSalesDeskPage ? 'Sales Desk workspace' : isStockControlPage ? 'Smart Stock Control workspace' : 'Marketing workspace'}</small></div>
        </div>
        <button className="nav-item app-home-link" onClick={() => setPage('Apps')}><LayoutDashboard size={18} /> Apps Dashboard</button>
        {page !== 'Apps' && (
          <>
            <div className="nav-label">WORKSPACE</div>
            {(isSalesDeskPage
              ? ([['RFQs', ClipboardList], ['RFQ Configuration', Settings], ['RFQ Roadmap', Map]] as const)
              : isStockControlPage
                ? ([['Parts Query', ClipboardList]] as const)
                : ([['Feed', LayoutDashboard], ['Posts', ClipboardList], ['Campaigns', Megaphone], ['Roadmap', Map], ['Configuration', Settings]] as const)
            ).map(([label, Icon]) => (
              <button
                key={label}
                className={`nav-item ${page === label || (label === 'Posts' && page === 'Post') ? 'active' : ''}`}
                onClick={() => { setPage(label); setFilter('all'); setCampaignFilter('all'); setMonth(startOfMonth()) }}
              >
                <Icon size={18} />{label}
              </button>
            ))}
            <div className="sidebar-bottom">
              <div className="connection-dot" /> <span>Local workspace</span>
              <small>{integrations.some((i) => i.status === 'connected') ? 'Facebook connected' : 'Publishing not connected'}</small>
              {key && <button className="text-button" onClick={() => { void api('/api/sales-desk/auth/logout', { method: 'POST' }).catch(() => undefined); disconnectKey() }}>Log out</button>}
            </div>
          </>
        )}
      </aside>

      <main className="main">
        <header className="topbar">
          <div><div className="eyebrow">IMPALA SPARES / {page === 'Apps' ? 'BUSINESS PLATFORM' : isSalesDeskPage ? 'SALES DESK' : isStockControlPage ? 'SMART STOCK CONTROL' : 'MARKETING'}</div><h1>{page === 'Post' ? 'Post details' : page === 'Apps' ? 'Apps Dashboard' : isStockControlPage ? 'Smart Stock Control' : page}</h1>{isSalesDeskPage && <p className="topbar-subtitle">{page === 'RFQ Configuration' ? 'Manage media platforms, statuses, sales codes and team accounts.' : 'Review incoming enquiries, claim RFQs, and track sales follow-ups.'}</p>}{isStockControlPage && <p className="topbar-subtitle">Manage buyout requests and supplier quotes.</p>}</div>
          {!isSalesDeskPage && !isStockControlPage && page !== 'Apps' && <button className="primary" onClick={() => { setEditor(emptyPost()); setError('') }}>
            <Plus size={17} /> Create post
          </button>}
        </header>

        {notice && (
          <div className="notice"><CheckCircle2 size={17} />{notice}
            <button aria-label="Dismiss message" onClick={() => setNotice('')}><X size={15} /></button>
          </div>
        )}
        {error && (
          <div className="error"><CircleAlert size={17} />{error}
            <button aria-label="Dismiss error" onClick={() => setError('')}><X size={15} /></button>
          </div>
        )}

        {/* Token expiry warning: visible on every screen so nobody misses it. */}
        {key && integrations.filter((i) => i.provider === 'facebook' && i.token_warning).map((i) => (
          <div className="warning" key="fb-token"><CircleAlert size={17} />{i.token_warning}
            {page !== 'Configuration' && <button className="secondary" onClick={() => setPage('Configuration')}>Go to Configuration</button>}
          </div>
        ))}

        {!key && (
          <section className="key-panel">
            <h2>Sign in to Impala Hub</h2>
            <p>Use your employee account to open the App Dashboard. Sessions persist securely across refreshes until they expire or you log out.</p>
            <div className="inline-form">
              <input aria-label="Username" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
              <input type="password" aria-label="Password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void signIn() }} />
              <button className="primary" onClick={() => void signIn()}>Sign in</button>
            </div>
          </section>
        )}

        {page === 'Apps' && (
          <section className="apps-dashboard">
            <div className="apps-intro">
              <span className="eyebrow">YOUR WORKSPACE</span>
              <h2>Welcome to Impala Hub</h2>
              <p>Choose an application to get started. More tools will appear here as they become available.</p>
            </div>
            <div className="apps-section-heading"><div><h2>Your apps</h2><p>One home for Impala's business workflows.</p></div><span>3 available</span></div>
            <div className="app-cards">
              <button className="app-card app-card-available" onClick={() => { setPage('Feed'); setFilter('all'); setCampaignFilter('all'); setMonth(startOfMonth()) }}>
                <div className="app-card-icon"><Megaphone size={25} /></div>
                <div className="app-card-copy"><h3>Marketing</h3><p>Plan campaigns, organise content, and manage social publishing.</p></div>
                <div className="app-card-footer"><span className="app-status-dot" /> Available <span className="app-card-open">Open app <span aria-hidden="true">→</span></span></div>
              </button>
              <button className="app-card app-card-available" onClick={() => { setPage('RFQs'); setError(''); setNotice('') }}>
                <div className="app-card-icon"><ClipboardList size={25} /></div>
                <div className="app-card-copy"><h3>Sales Desk</h3><p>Customer enquiries, RFQs, and sales follow-ups.</p></div>
                <div className="app-card-footer"><span className="app-status-dot" /> Available <span className="app-card-open">Open app <span aria-hidden="true">→</span></span></div>
              </button>
              {[
                { title: 'Returns & Claims', description: 'Track returns, damage claims, and supplier outcomes.' },
                { title: 'Fleet Management', description: 'Fleet visibility and vehicle activity.' },
                { title: 'E-commerce', description: 'Shopify orders, catalogue, and integration health.' },
              ].map((item) => (
                <div className="app-card app-card-disabled" key={item.title} aria-disabled="true">
                  <div className="app-card-icon"><ClipboardList size={25} /></div>
                  <div className="app-card-copy"><h3>{item.title}</h3><p>{item.description}</p></div>
                  <div className="app-card-footer"><span className="app-status-dot app-status-planned" /> Planned <span className="app-card-lock">Coming later</span></div>
                </div>
              ))}
              <button className="app-card app-card-available" onClick={() => { setPage('Buyouts'); setError(''); setNotice('') }}>
                <div className="app-card-icon"><ClipboardList size={25} /></div>
                <div className="app-card-copy"><h3>Smart Stock Control</h3><p>Buyout requests and supplier quotes.</p></div>
                <div className="app-card-footer"><span className="app-status-dot" /> Available <span className="app-card-open">Open app <span aria-hidden="true">→</span></span></div>
              </button>
            </div>
          </section>
        )}

        {isSalesDeskPage && page === 'RFQ Roadmap' ? (
          <section className="roadmap-page">
            <div className="section-head">
              <div><h2>RFQ capability workspace</h2><p>Current Sales Desk coverage, known gaps, and improvement priorities.</p></div>
            </div>
            <div className="roadmap-priorities"><strong>Next priorities</strong><span>RFQ Kanban</span><span>Notifications and SLA reminders</span><span>Bulk actions and exports</span><span>DMS/Qlik reconciliation</span></div>
            <div className="roadmap-table-wrap"><table className="roadmap-table"><thead><tr><th>Capability</th><th>Reference</th><th>Impala Hub</th><th>Status</th></tr></thead><tbody>
              {SALES_ROADMAP_ROWS.map(([capability, reference, impala, status]) => <tr key={capability}><td>{capability}</td><td>{reference}</td><td>{impala}</td><td><span className={'roadmap-status ' + (status.startsWith('Implemented') ? 'complete' : status.startsWith('Missing') ? 'missing' : 'partial')}>{status}</span></td></tr>)}
            </tbody></table></div>
          </section>
        ) : isStockControlPage ? <Buyouts token={key} setNotice={setNotice} setError={setError} /> : isSalesDeskPage ? <SalesDesk page={page} token={key} setNotice={setNotice} setError={setError} /> : null}

        {key && page === 'Roadmap' && (
          <section className="roadmap-page">
            <div className="section-head">
              <div><h2>Odoo parity workspace</h2><p>Current feature coverage, gaps, and next implementation priorities.</p></div>
            </div>
            <div className="roadmap-priorities">
              <strong>Next priorities</strong>
              <span>Facebook Views and boosted metrics</span><span>Instagram boosted metrics and publishing verification</span><span>Campaign deletion</span><span>Notifications and social conversations</span>
            </div>
            <div className="roadmap-table-wrap"><table className="roadmap-table"><thead><tr><th>Capability</th><th>Odoo</th><th>Impala Hub</th><th>Status</th></tr></thead><tbody>
              {ROADMAP_ROWS.map(([capability, odoo, impala, status]) => <tr key={capability}><td>{capability}</td><td>{odoo}</td><td>{impala}</td><td><span className={'roadmap-status ' + (status.startsWith('Implemented') ? 'complete' : status.startsWith('Missing') || status.startsWith('Incomplete') ? 'missing' : 'partial')}>{status}</span></td></tr>)}
            </tbody></table></div>
          </section>
        )}



        {key && page === 'Feed' && (
          <>
            <div className="feed-head">
              <div><h2>Connected social accounts</h2><p>Review Facebook and Instagram activity, engagement and provider health in one feed.</p></div>
              <div className="feed-actions">
                <button className="secondary" disabled={busy} onClick={() => void syncAll()}>Refresh</button>
                <button className="primary" onClick={() => setPage('Configuration')}><Settings size={16} /> Manage accounts</button>
              </div>
            </div>
            <div className="feed-streams feed-network-cards">
              {integrations.filter((i) => (i.provider === 'facebook' || i.provider === 'instagram') && i.status === 'connected').map((i) => {
                const providerPosts = posts.filter((p) => p.channels.includes(i.provider)).sort((a, b) => new Date(b.published_at || b.publish_at || b.created_at || 0).getTime() - new Date(a.published_at || a.publish_at || a.created_at || 0).getTime()).slice(0, 25)
                const engagement = providerPosts.reduce((n, p) => n + (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0) + (p.clicks ?? 0), 0)
                const recent = providerPosts.slice(0, Math.max(1, Math.ceil(providerPosts.length / 2))).reduce((n, p) => n + (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0) + (p.clicks ?? 0), 0)
                const older = providerPosts.slice(Math.max(1, Math.ceil(providerPosts.length / 2))).reduce((n, p) => n + (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0) + (p.clicks ?? 0), 0)
                const change = older ? ((recent - older) / older) * 100 : 0
                return <div className="feed-stream-card" key={i.provider}>
                  <div className="feed-network-head"><div className={`feed-provider-icon ${i.provider}`}>{i.provider === 'facebook' ? 'f' : '◎'}</div><div className="feed-network-title"><strong>{i.account_name || i.page_name || i.label}</strong><a href={i.provider === 'facebook' ? `https://www.facebook.com/${i.page_id || ''}` : `https://www.instagram.com/${i.username || ''}`} target="_blank" rel="noreferrer">Insights <ExternalLink size={11} /></a></div></div>
                  <div className="feed-network-metrics"><span title="Audience Number of followers of your channel"><Users size={15} /><strong>{i.followers_count ?? '—'}</strong></span><span title="Engagement Number of times people engaged with your posts (likes, comments, shares, clicks, and other reported interactions)"><MessageCircle size={15} /><strong>{engagement}</strong><em className={change >= 0 ? 'metric-up' : 'metric-down'}>{change >= 0 ? '+' : ''}{change.toFixed(1)}%</em></span></div>
                </div>
              })}
            </div>
            <div className="feed-summary">
              <div><span>Posts in feed</span><strong>{posts.length}</strong></div>
              <div><span>Likes</span><strong>{posts.reduce((n, p) => n + (p.likes ?? 0), 0)}</strong></div>
              <div><span>Comments</span><strong>{posts.reduce((n, p) => n + (p.comments ?? 0), 0)}</strong></div>
              <div><span>Shares</span><strong>{posts.reduce((n, p) => n + (p.shares ?? 0), 0)}</strong></div>
              <div><span>Views</span><strong>{posts.reduce((n, p) => n + (p.impressions ?? p.reach ?? 0), 0)}</strong></div>
            </div>            <div className="feed-post-columns">
              {integrations.filter((i) => (i.provider === 'facebook' || i.provider === 'instagram') && i.status === 'connected').map((i) => {
                const providerPosts = posts.filter((p) => p.channels.includes(i.provider)).sort((a, b) => new Date(b.published_at || b.publish_at || b.created_at || 0).getTime() - new Date(a.published_at || a.publish_at || a.created_at || 0).getTime()).slice(0, 25)
                return <section className="feed-post-column" key={i.provider}>
                  <h3>{i.account_name || i.page_name || i.label}</h3>
                  <PostList posts={providerPosts} campaigns={campaigns} onEdit={openEditor} onOpen={openPost} onDelete={removePost} card pageName={i.account_name || i.page_name || i.label} pageUrl={i.provider === 'facebook' ? `https://www.facebook.com/${i.page_id || ''}` : `https://www.instagram.com/${i.username || ''}`} />
                </section>
              })}
            </div>

            <div className="section-head">
              <div><h2>Feed</h2><p>Posts from connected social accounts, ordered by publication or schedule date.</p></div>
              <button className="text-button" onClick={() => { setPage('Posts'); setView('list'); setMonth(null); setFilter('all') }}>Open post manager →</button>
            </div>
            
          </>
        )}

        {key && page === 'Posts' && (
          <>
            <div className="toolbar">
              <div className="search">
                <Search size={17} />
                <input aria-label="Search posts" placeholder="Search titles and captions" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <div className="view-toggle" role="group" aria-label="View">
                {(['list', 'board', 'calendar', 'pivot'] as const).map((v) => (
                  <button key={v} className={`secondary ${view === v ? 'active' : ''}`} aria-pressed={view === v} onClick={() => setView(v)}>
                    {v[0].toUpperCase() + v.slice(1)}
                  </button>
                ))}
              </div>
              {view === 'list' && (<select aria-label="Filter by status" value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="all">All posts</option>
                <option value="draft">Drafts</option>
                <option value="awaiting_approval">Awaiting approval</option>
                <option value="scheduled">Scheduled</option>
                <option value="published">Published</option>
                <option value="failed">Failed</option>
                <option value="engagements">Published / engagements</option>
              </select>)}
              <select aria-label="Filter by campaign" value={campaignFilter} onChange={(e) => setCampaignFilter(e.target.value)}>
                <option value="all">All campaigns</option>
                {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {integrations.some((i) => (i.provider === 'facebook' || i.provider === 'instagram') && i.status === 'connected') && (
                <button className="secondary" disabled={busy} onClick={() => void syncAll()}>Refresh</button>
              )}
              <button className="primary" onClick={() => setEditor(emptyPost())}><Plus size={16} /> New post</button>
            </div>
            <MonthNav
              month={view === 'calendar' ? month ?? startOfMonth() : month}
              allowAll={view !== 'calendar'}
              onChange={setMonth}
              count={
                view === 'list' ? visiblePosts.length
                : view === 'board' ? monthPosts.length
                : view === 'pivot' ? filteredPosts.length
                : filteredPosts.filter((p) => (p.published_at || p.publish_at) && inMonth(p, month ?? startOfMonth())).length
              }
            />
            {view === 'list' && (
              <PostList posts={visiblePosts} campaigns={campaigns} onEdit={openEditor} onOpen={openPost} onDelete={removePost} />
            )}
            {view === 'board' && (
              <PostBoard
                posts={monthPosts} campaigns={campaigns} onOpen={openPost} onError={setError}
                onMove={(id, status) => void patchPost(id, { status }, `Post moved to ${status.replace(/_/g, ' ')}.`)}
              />
            )}
            {view === 'pivot' && (
              <PostPivot posts={filteredPosts} campaigns={campaigns} />
            )}
            {view === 'calendar' && (
              <PostCalendar
                posts={filteredPosts} month={month ?? startOfMonth()} onOpen={openPost} onError={setError}
                onChangeDate={(id, iso, message) => void patchPost(id, { publish_at: iso }, message)}
                onCreate={(local) => { setEditor({ ...emptyPost(), publish_at: local }); setError('') }}
              />
            )}
          </>
        )}

        {key && page === 'Campaigns' && (
          <>
            <div className="section-head">
              <div><h2>Campaigns</h2><p>Group related posts under a shared marketing objective.</p></div>
              <button className="primary" onClick={() => { setEditingCampaignId(null); setCampaignName(''); setCampaignObjective(''); setCampaignStage('new'); setCampaignModal(true) }}><Plus size={16} /> New campaign</button>
            </div>
            <div className="campaign-board">
              {([
                ['new', 'New'],
                ['in_progress', 'In Progress'],
                ['done', 'Done'],
              ] as const).map(([stage, label]) => (
                <section className="campaign-column" key={stage} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData('text/campaign-id'); if (id) void moveCampaign(id, stage) }}>
                  <header className="campaign-column-head"><h3>{label}</h3><span>{campaigns.filter((c) => (c.stage || 'new') === stage).length}</span></header>
                  <button className="campaign-quick-add" onClick={() => { setEditingCampaignId(null); setCampaignName(''); setCampaignObjective(''); setCampaignStage(stage); setCampaignModal(true) }}><Plus size={14} /> Quick add</button>
                  {campaigns.filter((c) => (c.stage || 'new') === stage).map((c) => (
                <div className="campaign-card" key={c.id} draggable onDragStart={(e) => e.dataTransfer.setData('text/campaign-id', c.id)}>
                  <div className="campaign-icon"><Megaphone size={20} /></div>
                  <div className="campaign-card-heading"><h3>{c.name}</h3><span className="status-badge">{(c.stage || 'new').replace('_', ' ')}</span></div>
                  <p>{c.objective || 'No objective added yet.'}</p>
                                    <div className="campaign-footer">
                    <button className="text-button" onClick={() => openCampaignEditor(c)}>Edit</button>
                    <button className="text-button" onClick={() => { setPage('Posts'); setSearch(''); setFilter('all'); setCampaignFilter(c.id); setMonth(null) }}>View posts →</button>
                  </div>
                </div>
                  ))}
                </section>
              ))}
              {campaigns.length === 0 && (
                <div className="empty">
                  <Megaphone size={28} /><h3>No campaigns yet</h3>
                  <p>Create a campaign to organise related posts.</p>
                  <button className="secondary" onClick={() => setCampaignModal(true)}>{editingCampaignId ? 'Save changes' : 'Create campaign'}</button>
                </div>
              )}
            </div>
          </>
        )}

        {key && page === 'Post' && (
          selected ? (
            <PostDetail
              post={selected} campaigns={campaigns} onBack={() => setPage('Posts')} onEdit={openEditor}
              onReschedule={reschedulePost} onDelete={removePost} onSaveCampaign={saveCampaign} onError={handleError}
            />
          ) : (
            <div className="empty">
              <ClipboardList size={28} /><h3>Post not found</h3>
              <button className="secondary" onClick={() => setPage('Posts')}>Back to posts</button>
            </div>
          )
        )}

        {key && page === 'Configuration' && (
          <>
            <div className="section-head">
              <div><h2>Connected channels</h2><p>Facebook Page connection health and account identity.</p></div>
            </div>
            <div className="integration-list">
              {integrations.filter((i) => i.provider === 'facebook' || i.provider === 'instagram').map((i) => (
                <div className="integration" key={i.provider}>
                  <div className={`provider-icon ${i.provider}`}>{i.provider === 'facebook' ? 'f' : i.provider === 'instagram' ? '◎' : '◉'}</div>
                  <div className="integration-info">
                    <b>{i.label}</b>
                    <p>{i.note || (i.status === 'connected' ? 'Live Page identity check passed.' : 'Official account connection is not configured.')}</p>
                    {i.provider === 'facebook' && i.page_id && <p><strong>Page ID:</strong> {i.page_id}</p>}
                    {i.provider === 'instagram' && i.account_id && <p><strong>Account ID:</strong> {i.account_id}</p>}
                    {i.provider === 'instagram' && i.username && <p><strong>Username:</strong> @{i.username}</p>}
                    {i.provider === 'instagram' && i.last_checked_at && <p><strong>Last checked:</strong> {new Date(i.last_checked_at).toLocaleString()}</p>}
                    {i.provider === 'instagram' && i.last_success_at && <p><strong>Last successful check:</strong> {new Date(i.last_success_at).toLocaleString()}</p>}
                    {i.provider === 'instagram' && i.token_type && <p><strong>Token type:</strong> {i.token_type}</p>}
                    {i.provider === 'instagram' && i.expires_at && <p><strong>Token expires:</strong> {new Date(i.expires_at * 1000).toLocaleString()}</p>}
                    {i.provider === 'instagram' && i.data_access_expires_at && <p><strong>Data access expires:</strong> {new Date(i.data_access_expires_at * 1000).toLocaleString()}</p>}
                    {i.provider === 'instagram' && i.granted_permissions?.length > 0 && <p><strong>Granted permissions:</strong> {i.granted_permissions.join(', ')}</p>}
                    {i.provider === 'instagram' && i.connection_source && <p><strong>Connection method:</strong> {i.connection_source === 'oauth' ? 'Meta OAuth' : i.connection_source}</p>}
                    {i.provider === 'facebook' && i.last_checked_at && <p><strong>Last checked:</strong> {new Date(i.last_checked_at).toLocaleString()}</p>}
                    {i.provider === 'facebook' && i.last_success_at && <p><strong>Last successful check:</strong> {new Date(i.last_success_at).toLocaleString()}</p>}
                    {i.provider === 'facebook' && i.token_type && <p><strong>Token type:</strong> {i.token_type}</p>}
                    {i.provider === 'facebook' && i.expires_at && <p><strong>Token expires:</strong> {new Date(i.expires_at * 1000).toLocaleString()}</p>}
                    {i.provider === 'facebook' && i.data_access_expires_at && <p><strong>Data access expires:</strong> {new Date(i.data_access_expires_at * 1000).toLocaleString()}</p>}
                    {i.provider === 'facebook' && i.status === 'connected' && !i.expires_at && <p>Page token does not expire. Reconnect when data access expires.</p>}
                    {i.provider === 'facebook' && i.granted_permissions?.length > 0 && <p><strong>Granted permissions:</strong> {i.granted_permissions.join(', ')}</p>}
                    {i.provider === 'facebook' && i.missing_permissions?.length > 0 && <p><strong>Missing permissions:</strong> {i.missing_permissions.join(', ')}</p>}
                    {i.provider === 'facebook' && i.diagnostic_note && <p>{i.diagnostic_note}</p>}
                    {i.provider === 'facebook' && i.token_warning && <p className="token-warning"><strong>Token warning:</strong> {i.token_warning}</p>}
                    {i.provider === 'facebook' && i.connection_source && <p><strong>Connection method:</strong> {i.connection_source === 'oauth' ? 'Meta OAuth' : 'Backend environment token'}</p>}
                  </div>
                  <span className="status-badge">
                    {i.status === 'connected' ? `Connected${i.account_name ? `: ${i.account_name}` : ''}` : i.status === 'warning' ? 'Permission warning' : i.status === 'error' ? 'Connection error' : 'Not connected'}
                  </span>
                  {i.provider === 'facebook'
                    ? <div className="integration-actions">
                        <button className="primary" disabled={busy} onClick={() => void connectFacebook()}>{busy ? 'Working...' : (i.status === 'connected' ? 'Reconnect Facebook' : 'Connect Facebook')}</button>
                        <button className="secondary" disabled={busy || i.status === 'not_connected'} onClick={() => void checkFacebookConnection()}>{busy ? 'Checking...' : 'Check connection'}</button>
                        {i.status !== 'not_connected' && <button className="secondary" disabled={busy} onClick={() => void disconnectFacebook()}>Disconnect</button>}
                        {facebookPages.length > 0 && <div className="facebook-page-picker">
                          <label htmlFor="facebook-page-select">Choose a Facebook Page</label>
                          <select id="facebook-page-select" value={selectedFacebookPage} onChange={(e) => setSelectedFacebookPage(e.target.value)}>
                            {facebookPages.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
                          </select>
                          <button className="secondary" disabled={busy || !selectedFacebookPage} onClick={() => void chooseFacebookPage()}>Use this Page</button>
                        </div>}
                      </div>
                    : <div className="integration-actions">
                         <button className="primary" disabled={busy} onClick={() => void connectInstagram()}>{busy ? 'Working...' : (i.status === 'connected' ? 'Reconnect Instagram' : 'Connect Instagram')}</button>
                         <button className="secondary" disabled={busy || i.status !== 'connected'} onClick={() => void checkInstagramConnection()}>{busy ? 'Checking...' : 'Check connection'}</button>
                         {i.status === 'connected' && <button className="secondary" disabled={busy} onClick={() => void disconnectInstagram()}>Disconnect</button>}
                       </div>}
                </div>
              ))}
            </div>
            <div className="security-note">
              <Settings size={20} />
              <div>
                <b>Connection management</b>
                <p>Connect Facebook to authorize through Meta, then select the Page Impala Hub should manage. Page access tokens are encrypted before being stored by the backend. Keep your Meta app secret and encryption key private in backend/.env.</p>
              </div>
            </div>
          </>
        )}
      </main>

      {editor && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setEditor(null) }}>
          <section className="editor" role="dialog" aria-modal="true" aria-label={editor.id ? 'Edit post' : 'Create post'}>
            <header className="editor-head">
              <div><span className="eyebrow">CONTENT WORKFLOW</span><h2>{editor.id ? 'Edit post' : 'Create post'}</h2></div>
              <button className="icon-button" aria-label="Close editor" onClick={() => setEditor(null)}><X size={20} /></button>
            </header>
            <div className="editor-body">
              <label id="lbl-channels">Channels <span>Choose where this post should appear</span></label>
              <div className="channel-checks" role="group" aria-labelledby="lbl-channels">
                {[['facebook', 'Facebook'], ['instagram', 'Instagram']].map(([v, l]) => (
                  <label className="check-chip" key={v}>
                    <input
                      type="checkbox" checked={channels.includes(v)}
                      onChange={(e) => patchEditor({ channels: e.target.checked ? [...channels, v] : channels.filter((x) => x !== v) })}
                    />{l}
                  </label>
                ))}
              </div>

                             <label htmlFor="post-title">Title</label>
              <input id="post-title" maxLength={160} placeholder="Internal title for this post" value={editor.title || ''} onChange={(e) => patchEditor({ title: e.target.value })} />

              <label htmlFor="post-caption">Caption / message</label>
              <textarea id="post-caption" rows={5} placeholder="Write the post caption here..." value={editor.caption || ''} onChange={(e) => patchEditor({ caption: e.target.value })} />

              <div className="editor-label-row">
                <label id="lbl-images">Images <span>JPG, PNG, WEBP or GIF, max 15 MB each. Instagram needs at least one.</span></label>
                <label className="upload-button">
                  <Upload size={16} /> Add images
                  <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple onChange={(e) => void upload(e.target)} />
                </label>
              </div>
              <div className="media-grid">
                {(editor.media || []).map((m, i) => (
                  <div className="media-thumb" key={m.id || m.url}>
                    <img src={mediaSrc(m)} alt={m.name} />
                    <button aria-label={`Remove ${m.name}`} onClick={() => patchEditor({ media: (editor.media || []).filter((_, j) => i !== j) })}><X size={14} /></button>
                    <small>{m.name}</small>
                  </div>
                ))}
                {!(editor.media || []).length && <div className="media-empty"><ImagePlus size={22} /><span>No images attached</span></div>}
              </div>

              <label htmlFor="post-campaign">Campaign</label>
              <select id="post-campaign" value={editor.campaign_id || ''} onChange={(e) => patchEditor({ campaign_id: e.target.value || null })}>
                <option value="">No campaign</option>
                {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>

              <label htmlFor="post-when">Publication date and time <span>Required to schedule. Leave blank for a draft.</span></label>
              <input id="post-when" type="datetime-local" value={toLocalInput(editor.publish_at)} onChange={(e) => patchEditor({ publish_at: e.target.value })} />
              <p className="hint">Scheduled posts are published to the connected Facebook Page by a background worker while the API is running.</p>
            </div>
            <footer className="editor-foot">
              <button className="secondary" onClick={() => setEditor(null)}>Cancel</button>
              <button className="secondary" disabled={busy} onClick={() => void savePost('draft')}>Save as draft</button>
              <button className="secondary" disabled={busy || !integrations.some((i) => i.provider === 'facebook' && i.status === 'connected')} onClick={() => void savePost('publish-now')} title="Publish this post to the connected Facebook Page now">
                <Send size={15} /> Publish now
              </button>
              <button className="primary" disabled={busy || !canSchedule} title={canSchedule ? '' : 'Choose a future date and time first'} onClick={() => void savePost('schedule')}>
                <Send size={15} />{busy ? 'Saving...' : 'Schedule post'}
              </button>
            </footer>
          </section>
        </div>
      )}

      {campaignModal && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setCampaignModal(false) }}>
          <section className="small-modal" role="dialog" aria-modal="true" aria-label="New campaign">
            <header className="editor-head">
              <h2>{editingCampaignId ? 'Edit campaign' : 'New campaign'}</h2>
              <button className="icon-button" aria-label="Close" onClick={() => setCampaignModal(false)}><X size={20} /></button>
            </header>
            <label htmlFor="campaign-name">Campaign name</label>
            <input id="campaign-name" value={campaignName} onChange={(e) => setCampaignName(e.target.value)} placeholder="e.g. Spring maintenance campaign" />
            <label htmlFor="campaign-objective">Objective</label>
            <textarea id="campaign-objective" value={campaignObjective} onChange={(e) => setCampaignObjective(e.target.value)} placeholder="What should this campaign achieve?" rows={3} />
            <footer className="editor-foot">
              <button className="secondary" onClick={() => setCampaignModal(false)}>Cancel</button>
              <button className="primary" onClick={() => void createCampaign()}>{editingCampaignId ? 'Save changes' : 'Create campaign'}</button>
            </footer>
          </section>
        </div>
      )}
    </div>
  )
}


function PostPivot({ posts, campaigns }: { posts: Post[]; campaigns: Campaign[] }) {
  const rows = campaigns.map((campaign) => {
    const items = posts.filter((p) => p.campaign_id === campaign.id)
    return { label: campaign.name, posts: items.length, likes: items.reduce((n, p) => n + (p.likes ?? 0), 0), comments: items.reduce((n, p) => n + (p.comments ?? 0), 0), shares: items.reduce((n, p) => n + (p.shares ?? 0), 0), clicks: items.reduce((n, p) => n + (p.clicks ?? 0), 0) }
  })
  const unassigned = posts.filter((p) => !p.campaign_id)
  rows.push({ label: 'No campaign', posts: unassigned.length, likes: unassigned.reduce((n, p) => n + (p.likes ?? 0), 0), comments: unassigned.reduce((n, p) => n + (p.comments ?? 0), 0), shares: unassigned.reduce((n, p) => n + (p.shares ?? 0), 0), clicks: unassigned.reduce((n, p) => n + (p.clicks ?? 0), 0) })
  const totals = rows.reduce((a, r) => ({ label: 'Total', posts: a.posts + r.posts, likes: a.likes + r.likes, comments: a.comments + r.comments, shares: a.shares + r.shares, clicks: a.clicks + r.clicks }), { label: 'Total', posts: 0, likes: 0, comments: 0, shares: 0, clicks: 0 })
  return (
    <div className="pivot-wrap">
      <div className="section-head"><div><h2>Post insights</h2><p>Odoo-style grouped reporting for the current filters.</p></div></div>
      <div className="pivot-table-wrap"><table className="pivot-table"><thead><tr><th>Campaign</th><th>Posts</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Clicks</th></tr></thead><tbody>
        {rows.filter((r) => r.posts > 0).map((r) => <tr key={r.label}><td>{r.label}</td><td>{r.posts}</td><td>{r.likes}</td><td>{r.comments}</td><td>{r.shares}</td><td>{r.clicks}</td></tr>)}
        <tr className="pivot-total"><td>{totals.label}</td><td>{totals.posts}</td><td>{totals.likes}</td><td>{totals.comments}</td><td>{totals.shares}</td><td>{totals.clicks}</td></tr>
      </tbody></table></div>
    </div>
  )
}

function PostList({ posts, campaigns, onEdit, onOpen, onDelete, card = false, pageName, pageUrl }: {
  posts: Post[]
  campaigns: Campaign[]
  onEdit: (p: Post) => void
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  card?: boolean
  pageName?: string
  pageUrl?: string
}) {
  if (!posts.length) {
    return (
      <div className="empty">
        <ClipboardList size={28} /><h3>No posts to show</h3>
        <p>Create a draft to get your content calendar started.</p>
      </div>
    )
  }
  return (
    <div className={card ? "post-list feed-post-cards" : "post-list"}>
      {posts.map((p) => {
        const heading = p.title?.trim() || p.caption?.trim().slice(0, 110) || 'Untitled post'
        return (
          <article className={card ? "post-row feed-post-card" : "post-row"} key={p.id}>
            {card ? (
              <>
                <div className="feed-post-top"><a href={p.provider_ids?.permalink || pageUrl || '#'} target="_blank" rel="noreferrer" onClick={(e) => { if (!p.provider_ids?.permalink && !pageUrl) e.preventDefault() }}>{pageName || 'Social page'}</a><time>{fmt(p.published_at || p.publish_at, 'Not posted')}</time></div>
                <p className="feed-card-caption" onClick={() => onOpen(p.id)}>{p.caption || heading}</p>
                <div className="feed-card-images" onClick={() => onOpen(p.id)}>
                  {p.media.slice(0, 2).map((m, index) => <div className="feed-card-image" key={m.id || m.url}><img src={mediaSrc(m)} alt={m.name} />{index === 1 && p.media.length > 2 && <span>+{p.media.length - 2}</span>}</div>)}
                  {!p.media.length && <div className="feed-card-no-image"><ImagePlus size={20} /></div>}
                </div>
                <div className="feed-card-bottom"><span><Heart size={14} /> {metric(p.likes)}</span><span><MessageCircle size={14} /> {metric(p.comments)}</span><span className="feed-card-views"><Eye size={14} /> {metric(p.impressions ?? p.reach)}</span></div>
              </>
            ) : (
              <>
                <div className="post-preview" style={{ cursor: 'pointer' }} onClick={() => onOpen(p.id)}>
                  {p.media?.[0] ? <img src={mediaSrc(p.media[0])} alt="" /> : <ImagePlus size={22} />}
                </div>
                <div className="post-copy" role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => onOpen(p.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(p.id) }}>
                  <div className="post-meta"><span className={`status ${p.status}`}>{p.status.replace(/_/g, ' ')}</span><span>{p.channels.join(' · ') || 'No channel'}</span></div>
                  <b>{heading}</b>
                  <small>{campaigns.find((c) => c.id === p.campaign_id)?.name || 'No campaign'} · {p.published_at ? `Posted ${fmt(p.published_at)}` : fmt(p.publish_at)}</small>
                  {p.status === 'published' && <small>Views {metric(p.impressions ?? p.reach)} · Reach {metric(p.reach)} · Likes {metric(p.likes)} · Comments {metric(p.comments)} · Shares {metric(p.shares)}{p.metrics_refreshed_at ? ` · updated ${fmt(p.metrics_refreshed_at)}` : ''}</small>}
                </div>
                <div className="row-actions"><button className="secondary" onClick={() => onOpen(p.id)}>View</button>{EDITABLE.includes(p.status) && <button className="secondary" onClick={() => onEdit(p)}>Edit</button>}<button className="icon-button" title="Delete local record (only after it is absent from Facebook)" aria-label="Delete post" onClick={() => onDelete(p.id)}><Trash2 size={16} /></button></div>
              </>
            )}
          </article>
        )
      })}
    </div>
  )
}
