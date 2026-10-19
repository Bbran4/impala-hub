import { useEffect, useMemo, useState } from 'react'
import {
  BarChart3, CalendarClock, CheckCircle2, ChevronDown, CircleAlert, ClipboardList, ImagePlus,
  LayoutDashboard, Megaphone, Plus, Search, Settings, Send, Trash2, Upload, X,
} from 'lucide-react'
import PostDetail from './PostDetail'
import PostBoard from './PostBoard'
import PostCalendar from './PostCalendar'
import MonthNav from './MonthNav'
import { api, AuthError, EDITABLE, fmt, getKey, inMonth, isFuture, KEY_STORAGE, mediaSrc, metric, startOfMonth, type Media, type Post, type Campaign, API } from './lib'

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

export default function App() {
  const [key, setKey] = useState(getKey())
  const [keyEntry, setKeyEntry] = useState('')
  const [sdToken, setSdToken] = useState(() => sessionStorage.getItem('impala_sales_desk_token') || '')
  const [sdUser, setSdUser] = useState<any>(null)
  const [sdUsername, setSdUsername] = useState('')
  const [sdPassword, setSdPassword] = useState('')
  const [sdRfqs, setSdRfqs] = useState<any[]>([])
  const [sdConfig, setSdConfig] = useState<any>({ media_platforms: [], sales_codes: [], statuses: [] })
  const [sdSearch, setSdSearch] = useState('')
  const [sdStatusFilter, setSdStatusFilter] = useState('')
  const [sdSalesCodeFilter, setSdSalesCodeFilter] = useState('')
  const [sdSort, setSdSort] = useState('received_asc')
  const [sdSelectedRfq, setSdSelectedRfq] = useState<any>(null)
  const [sdDashboard, setSdDashboard] = useState<any>({ unclaimed: 0, claimed: 0, received_today: 0, open: 0 })
  const [sdCreateOpen, setSdCreateOpen] = useState(false)
  const [sdDraft, setSdDraft] = useState<any>({ media_platform_id: '', customer_name: '', contact_number: '', email_address: '', query_information: '', remarks: '', document_number: '' })
  const [sdConfigDraft, setSdConfigDraft] = useState<any>({ mediaName: '', mediaSort: 0, salesCode: '', salesName: '', statusName: '', statusSort: 0, statusClosed: false })
  const [sdDetailDraft, setSdDetailDraft] = useState<any>(null)
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
  const [campaignName, setCampaignName] = useState('')
  const [campaignObjective, setCampaignObjective] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [view, setView] = useState<'list' | 'board' | 'calendar'>('list')
  const [month, setMonth] = useState<Date | null>(() => startOfMonth()) // null = all months (list and board only)

  async function sdApi(path: string, init: RequestInit = {}) {
    let response: Response
    try {
      response = await fetch(`${API}${path}`, {
        ...init, headers: { 'Content-Type': 'application/json', ...(sdToken ? { Authorization: `Bearer ${sdToken}` } : {}), ...(init.headers || {}) },
      })
    } catch {
      throw new Error(`Cannot reach the Impala Hub API at ${API}. Start the backend and check VITE_API_URL. Sales Desk sign-in does not depend on Marketing configuration.`)
    }
    const body = response.status === 204 ? null : await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof body?.detail === 'string' ? body.detail : `Sales Desk request failed (${response.status})`)
    return body
  }

  async function sdLogin() {
    setBusy(true); setError('')
    try {
      let response: Response
      try {
        response = await fetch(`${API}/api/sales-desk/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: sdUsername, password: sdPassword }) })
      } catch {
        throw new Error(`Cannot reach the Impala Hub API at ${API}. Start the backend and check VITE_API_URL. Marketing configuration is not required for Sales Desk sign-in.`)
      }
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body?.detail || 'Sign-in failed')
      sessionStorage.setItem('impala_sales_desk_token', body.access_token)
      setSdToken(body.access_token); setSdUser(body.user); setSdPassword('')
      setNotice(`Signed in to Sales Desk as ${body.user.display_name}.`)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  async function sdLogout() {
    try { await sdApi('/api/sales-desk/auth/logout', { method: 'POST' }) } catch {}
    sessionStorage.removeItem('impala_sales_desk_token'); setSdToken(''); setSdUser(null); setSdRfqs([]); setSdSelectedRfq(null)
  }

  async function loadSalesDesk() {
    if (!sdToken) return
    try {
      const [me, cfg, result, dashboard] = await Promise.all([
        sdApi('/api/sales-desk/auth/me'),
        sdApi('/api/sales-desk/config'),
        sdApi('/api/sales-desk/rfqs?limit=500'),
        sdApi('/api/sales-desk/dashboard'),
      ])
      setSdUser(me); setSdConfig(cfg); setSdRfqs(result.items || []); setSdDashboard(dashboard)
    } catch (e) {
      const message = (e as Error).message
      if (message.toLowerCase().includes('session') || message.toLowerCase().includes('sign in')) {
        sessionStorage.removeItem('impala_sales_desk_token'); setSdToken(''); setSdUser(null)
      }
      setError(message)
    }
  }

  async function sdRefresh() {
    const [cfg, result, dashboard] = await Promise.all([
      sdApi('/api/sales-desk/config'),
      sdApi('/api/sales-desk/rfqs?limit=500'),
      sdApi('/api/sales-desk/dashboard'),
    ])
    setSdConfig(cfg); setSdRfqs(result.items || []); setSdDashboard(dashboard)
    if (sdSelectedRfq?.id) {
      const detail = await sdApi(`/api/sales-desk/rfqs/${sdSelectedRfq.id}`)
      setSdSelectedRfq(detail); setSdDetailDraft(detail)
    }
  }

  async function sdCreateRfq() {
    setBusy(true); setError('')
    try {
      const result = await sdApi('/api/sales-desk/rfqs', { method: 'POST', body: JSON.stringify(sdDraft) })
      setSdCreateOpen(false); setSdDraft({ media_platform_id: '', customer_name: '', contact_number: '', email_address: '', query_information: '', remarks: '', document_number: '' })
      setSdSelectedRfq(result); setSdDetailDraft(result); setNotice(`RFQ ${result.rfq_no} created.`)
      await sdRefresh()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  async function sdSaveRfq() {
    if (!sdSelectedRfq || !sdDetailDraft) return
    setBusy(true); setError('')
    try {
      const body = sdUser?.role === 'salesperson'
        ? { remarks: sdDetailDraft.remarks, query_information: sdDetailDraft.query_information, document_number: sdDetailDraft.document_number }
        : { media_platform_id: sdDetailDraft.media_platform_id, customer_name: sdDetailDraft.customer_name, contact_number: sdDetailDraft.contact_number, email_address: sdDetailDraft.email_address, query_information: sdDetailDraft.query_information, remarks: sdDetailDraft.remarks, document_number: sdDetailDraft.document_number, status_id: sdDetailDraft.status_id }
      const result = await sdApi(`/api/sales-desk/rfqs/${sdSelectedRfq.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      setSdSelectedRfq(result); setSdDetailDraft(result); setNotice('RFQ changes saved.')
      await sdRefresh()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  async function sdClaimRfq(rfq: any) {
    setBusy(true); setError('')
    try {
      const result = await sdApi(`/api/sales-desk/rfqs/${rfq.id}/claim`, { method: 'POST' })
      setSdSelectedRfq(result); setSdDetailDraft(result); setNotice(`Claimed ${result.rfq_no} for your sales code.`)
      await sdRefresh()
    } catch (e) { setError((e as Error).message); await loadSalesDesk() } finally { setBusy(false) }
  }

  async function sdAssignRfq(sales_code_id: string) {
    if (!sdSelectedRfq) return
    setBusy(true); setError('')
    try {
      const result = await sdApi(`/api/sales-desk/rfqs/${sdSelectedRfq.id}/assign`, { method: 'POST', body: JSON.stringify({ sales_code_id: sales_code_id || null }) })
      setSdSelectedRfq(result); setSdDetailDraft((draft: any) => draft ? { ...draft, sales_code_id: result.sales_code_id, sales_code: result.sales_code, salesperson_name: result.salesperson_name, claimed_at: result.claimed_at } : result); setNotice('RFQ assignment updated.')
      await sdRefresh()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  async function sdConfigAction(path: string, body: any, method = 'POST') {
    setBusy(true); setError('')
    try {
      await sdApi(path, { method, body: JSON.stringify(body) })
      setNotice('Configuration saved.')
      setSdConfigDraft((d: any) => ({ ...d, mediaName: '', salesCode: '', salesName: '', statusName: '' }))
      await sdRefresh()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const patchEditor = (changes: Partial<Post>) => setEditor((e) => (e ? { ...e, ...changes } : e))

  function handleError(e: unknown) {
    if (e instanceof AuthError) { setKey(''); setKeyEntry('') }
    setError((e as Error).message)
  }

  async function load() {
    if (!getKey()) return
    try {
      const [p, c, i] = await Promise.all([api('/api/posts'), api('/api/campaigns'), api('/api/integrations')])
      setPosts(p); setCampaigns(c); setIntegrations(i); setError('')
    } catch (e) { handleError(e) }
  }
  useEffect(() => {
    if (key) {
      void load()
      const params = new URLSearchParams(window.location.search)
      const oauthResult = params.get('facebook_oauth')
      if (oauthResult === 'choose_page') {
        setPage('Configuration') // the Page picker lives here
        setNotice('Facebook authorized. Choose the Page you want Impala Hub to manage.')
        void loadFacebookPages()
      } else if (oauthResult === 'error') {
        setPage('Configuration')
        const reason = params.get('reason') || 'unknown'
        setError(OAUTH_REASONS[reason] ?? `Facebook authorization did not finish (${reason.replaceAll('_', ' ')}).`)
      }
      if (oauthResult) {
        params.delete('facebook_oauth'); params.delete('reason')
        const query = params.toString()
        window.history.replaceState({}, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash)
      }
    }
  }, [key])

  // Reload any pending Page choices whenever Configuration opens, so a browser refresh does not lose the picker.
  useEffect(() => { if (key && page === 'Configuration') void loadFacebookPages() }, [key, page])
  useEffect(() => { if (isSalesDeskPage && sdToken) void loadSalesDesk() }, [page, sdToken])

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

  async function syncFacebook() {
    setBusy(true); setError('')
    try {
      const r = await api('/api/integrations/facebook/sync', { method: 'POST' })
      setNotice(`Facebook synced: ${r.imported} new ${r.imported === 1 ? 'post' : 'posts'}, ${r.updated} updated.`)
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
      await api('/api/campaigns', { method: 'POST', body: JSON.stringify({ name: campaignName, objective: campaignObjective }) })
      setCampaignName(''); setCampaignObjective(''); setCampaignModal(false); setNotice('Campaign created.')
      await load()
    } catch (e) { handleError(e) }
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
  const isSalesDeskPage = page === 'RFQs' || page === 'RFQ Configuration'
  const filteredRfqs = sdRfqs.filter((r) =>
    (!sdStatusFilter || r.status_id === sdStatusFilter) &&
    (!sdSalesCodeFilter || r.sales_code_id === sdSalesCodeFilter) &&
    (!sdSearch || `${r.rfq_no} ${r.customer_name} ${r.document_number}`.toLowerCase().includes(sdSearch.toLowerCase())),
  ).sort((a, b) => {
    if (sdSort === 'customer') return String(a.customer_name).localeCompare(String(b.customer_name))
    if (sdSort === 'rfq_no') return String(b.rfq_no).localeCompare(String(a.rfq_no))
    if (sdSort === 'received_desc') return String(b.received_at).localeCompare(String(a.received_at))
    const unclaimedOrder = Number(!!a.sales_code) - Number(!!b.sales_code)
    return unclaimedOrder || String(a.received_at).localeCompare(String(b.received_at))
  })

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">I</div>
          <div><b>IMPALA HUB</b><small>{isSalesDeskPage ? 'Sales Desk workspace' : 'Marketing workspace'}</small></div>
        </div>
        <button className="nav-item app-home-link" onClick={() => setPage('Apps')}><LayoutDashboard size={18} /> Apps Dashboard</button>
        {page !== 'Apps' && (
          <>
            <div className="nav-label">WORKSPACE</div>
            {(isSalesDeskPage
              ? ([['RFQs', ClipboardList], ['RFQ Configuration', Settings]] as const)
              : ([['Feed', LayoutDashboard], ['Posts', ClipboardList], ['Campaigns', Megaphone], ['Configuration', Settings]] as const)
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
              {key && <button className="text-button" onClick={disconnectKey}>Change API key</button>}
            </div>
          </>
        )}
      </aside>

      <main className="main">
        <header className="topbar">
          <div><div className="eyebrow">IMPALA SPARES / {page === 'Apps' ? 'BUSINESS PLATFORM' : isSalesDeskPage ? 'SALES DESK' : 'MARKETING'}</div><h1>{page === 'Post' ? 'Post details' : page === 'Apps' ? 'Apps Dashboard' : page}</h1></div>
          {!isSalesDeskPage && page !== 'Apps' && <button className="primary" onClick={() => { setEditor(emptyPost()); setError('') }}>
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
            <h2>Connect to your local API</h2>
            <p>Enter the API key configured in <code>backend/.env</code>. This keeps the local API from accepting unauthorised requests.</p>
            <div className="inline-form">
              <input
                type="password" aria-label="API key" placeholder="API key" value={keyEntry}
                onChange={(e) => setKeyEntry(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') connectKey() }}
              />
              <button className="primary" onClick={connectKey}>Connect</button>
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
            <div className="apps-section-heading"><div><h2>Your apps</h2><p>One home for Impala's business workflows.</p></div><span>2 available</span></div>
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
                { title: 'Smart Stock Control', description: 'Stock levels, replenishment, and branch transfers.' },
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
            </div>
          </section>
        )}

        {isSalesDeskPage && (
          <section className="rfq-workspace">
            <div className="apps-intro">
              <span className="eyebrow">SALES DESK</span>
              <h2>{page === 'RFQ Configuration' ? 'RFQ Configuration' : 'Request for Quotations'}</h2>
              <p>{page === 'RFQ Configuration'
                ? 'Manage media platforms, salesperson sales codes, and RFQ statuses.'
                : 'Review incoming enquiries, claim RFQs, and track sales follow-ups.'}</p>
            </div>
            {!sdToken ? (
              <div className="rfq-empty-card">
                <h3>Sign in to Sales Desk</h3>
                <p>Use your individual Sales Desk account. Marketing API credentials are not used for Sales Desk access.</p>
                <div className="sd-login-form">
                  <label>Username<input autoComplete="username" value={sdUsername} onChange={(e) => setSdUsername(e.target.value)} /></label>
                  <label>Password<input type="password" autoComplete="current-password" value={sdPassword} onChange={(e) => setSdPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void sdLogin() }} /></label>
                  <button className="primary" disabled={busy || !sdUsername.trim() || !sdPassword} onClick={() => void sdLogin()}>{busy ? 'Signing in…' : 'Sign in'}</button>
                </div>
              </div>
            ) : (
              <>
                <div className="sd-session-bar"><span>Signed in as <b>{sdUser?.display_name || sdUsername}</b>{sdUser?.role ? ` · ${sdUser.role}` : ''}</span><button className="secondary" onClick={() => void sdLogout()}>Sign out</button></div>
                {page === 'RFQs' ? (
                  <>
                    <div className="sd-metrics">
                      {[['Unclaimed', sdDashboard.unclaimed], ['Claimed', sdDashboard.claimed], ['Received today', sdDashboard.received_today], ['Open RFQs', sdDashboard.open]].map(([label, value]: any) => (
                        <div className="sd-metric" key={label}><span>{label}</span><strong>{value}</strong></div>
                      ))}
                    </div>
                    <div className="rfq-toolbar">
                      <label>Filter by status<select value={sdStatusFilter} onChange={(e) => setSdStatusFilter(e.target.value)}><option value="">All statuses</option>{sdConfig.statuses.filter((s: any) => s.is_active).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
                      <label>Filter by sales code<select value={sdSalesCodeFilter} onChange={(e) => setSdSalesCodeFilter(e.target.value)} disabled={sdUser?.role === 'salesperson'}><option value="">All salespeople</option>{sdConfig.sales_codes.filter((s: any) => s.is_active).map((s: any) => <option key={s.id} value={s.id}>{s.code} · {s.display_name}</option>)}</select></label>
                      <label className="rfq-search">Search RFQs<input placeholder="RFQ number, customer, document number" value={sdSearch} onChange={(e) => setSdSearch(e.target.value)} /></label>
                      <label>Sort by<select value={sdSort} onChange={(e) => setSdSort(e.target.value)}><option value="received_asc">Oldest received</option><option value="received_desc">Newest received</option><option value="customer">Customer name</option><option value="rfq_no">RFQ number</option></select></label>
                      {['administrator', 'manager'].includes(sdUser?.role) && <button className="primary" onClick={() => { setSdDraft({ media_platform_id: sdConfig.media_platforms.find((m: any) => m.is_active)?.id || '', customer_name: '', contact_number: '', email_address: '', query_information: '', remarks: '', document_number: '' }); setSdCreateOpen(!sdCreateOpen) }}><Plus size={16}/> New RFQ</button>}
                    </div>
                    {sdCreateOpen && (
                      <div className="rfq-empty-card sd-form-card">
                        <h3>Create RFQ</h3>
                        <div className="sd-form-grid">
                          <label>Media platform<select value={sdDraft.media_platform_id} onChange={(e) => setSdDraft({ ...sdDraft, media_platform_id: e.target.value })}><option value="">Choose platform</option>{sdConfig.media_platforms.filter((m: any) => m.is_active).map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
                          <label>Customer name<input value={sdDraft.customer_name} onChange={(e) => setSdDraft({ ...sdDraft, customer_name: e.target.value })}/></label>
                          <label>Contact number<input value={sdDraft.contact_number} onChange={(e) => setSdDraft({ ...sdDraft, contact_number: e.target.value })}/></label>
                          <label>Email address<input type="email" value={sdDraft.email_address} onChange={(e) => setSdDraft({ ...sdDraft, email_address: e.target.value })}/></label>
                          <label>Document number<input value={sdDraft.document_number} onChange={(e) => setSdDraft({ ...sdDraft, document_number: e.target.value })}/></label>
                          <label className="sd-wide">Query information<textarea rows={3} value={sdDraft.query_information} onChange={(e) => setSdDraft({ ...sdDraft, query_information: e.target.value })}/></label>
                          <label className="sd-wide">Remarks<textarea rows={2} value={sdDraft.remarks} onChange={(e) => setSdDraft({ ...sdDraft, remarks: e.target.value })}/></label>
                        </div>
                        <div className="sd-actions"><button className="primary" disabled={busy || !sdDraft.media_platform_id || !sdDraft.customer_name.trim()} onClick={() => void sdCreateRfq()}>{busy ? 'Saving…' : 'Create RFQ'}</button><button className="secondary" onClick={() => setSdCreateOpen(false)}>Cancel</button></div>
                      </div>
                    )}
                    <div className="rfq-table-wrap"><table className="rfq-table">
                      <thead><tr><th>RFQ No.</th><th>Received</th><th>Customer</th><th>Media platform</th><th>Sales code</th><th>Status</th><th>Actions</th></tr></thead>
                      <tbody>{filteredRfqs.length ? filteredRfqs.map((r: any) => <tr key={r.id} className="rfq-data-row"><td>{r.rfq_no}</td><td>{r.received_at ? new Date(r.received_at).toLocaleString() : '—'}</td><td>{r.customer_name}</td><td>{r.media_platform || '—'}</td><td>{r.sales_code || 'Unclaimed'}</td><td>{r.status}</td><td className="sd-actions-cell"><button className="secondary" onClick={() => void sdApi(`/api/sales-desk/rfqs/${r.id}`).then((detail) => { setSdSelectedRfq(detail); setSdDetailDraft(detail) }).catch((e) => setError(e.message))}>View</button>{sdUser?.role === 'salesperson' && !r.sales_code && <button className="primary" disabled={busy} onClick={() => void sdClaimRfq(r)}>Claim</button>}</td></tr>) : <tr><td colSpan={7}><div className="rfq-empty"><ClipboardList size={28}/><h3>{sdRfqs.length ? 'No matching RFQs' : 'No RFQs yet'}</h3><p>Incoming enquiries and manually captured RFQs will appear here.</p></div></td></tr>}</tbody>
                    </table></div>
                    {sdSelectedRfq && sdDetailDraft && (
                      <div className="rfq-empty-card sd-form-card">
                        <div className="sd-detail-heading"><div><span className="eyebrow">RFQ DETAIL</span><h3>{sdSelectedRfq.rfq_no} · {sdSelectedRfq.customer_name}</h3></div><button className="secondary" onClick={() => { setSdSelectedRfq(null); setSdDetailDraft(null) }}>Close details</button></div>
                        <div className="sd-form-grid">
                          <label>Customer name<input disabled={sdUser?.role === 'salesperson'} value={sdDetailDraft.customer_name || ''} onChange={(e) => setSdDetailDraft({ ...sdDetailDraft, customer_name: e.target.value })}/></label>
                          <label>Media platform<select disabled={sdUser?.role === 'salesperson'} value={sdDetailDraft.media_platform_id || ''} onChange={(e) => setSdDetailDraft({ ...sdDetailDraft, media_platform_id: e.target.value })}>{sdConfig.media_platforms.filter((m: any) => m.is_active || m.id === sdDetailDraft.media_platform_id).map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
                          <label>Contact number<input disabled={sdUser?.role === 'salesperson'} value={sdDetailDraft.contact_number || ''} onChange={(e) => setSdDetailDraft({ ...sdDetailDraft, contact_number: e.target.value })}/></label>
                          <label>Email address<input disabled={sdUser?.role === 'salesperson'} value={sdDetailDraft.email_address || ''} onChange={(e) => setSdDetailDraft({ ...sdDetailDraft, email_address: e.target.value })}/></label>
                          <label>Document number<input value={sdDetailDraft.document_number || ''} onChange={(e) => setSdDetailDraft({ ...sdDetailDraft, document_number: e.target.value })}/></label>
                          <label>Status<select disabled={sdUser?.role === 'salesperson'} value={sdDetailDraft.status_id || ''} onChange={(e) => setSdDetailDraft({ ...sdDetailDraft, status_id: e.target.value })}>{sdConfig.statuses.filter((s: any) => s.is_active || s.id === sdDetailDraft.status_id).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
                          <label className="sd-wide">Query information<textarea rows={3} value={sdDetailDraft.query_information || ''} onChange={(e) => setSdDetailDraft({ ...sdDetailDraft, query_information: e.target.value })}/></label>
                          <label className="sd-wide">Remarks<textarea rows={2} value={sdDetailDraft.remarks || ''} onChange={(e) => setSdDetailDraft({ ...sdDetailDraft, remarks: e.target.value })}/></label>
                        </div>
                        <p><b>Received:</b> {sdSelectedRfq.received_at ? new Date(sdSelectedRfq.received_at).toLocaleString() : '—'} · <b>Claimed:</b> {sdSelectedRfq.claimed_at ? new Date(sdSelectedRfq.claimed_at).toLocaleString() : 'Not claimed'} · <b>Salesperson:</b> {sdSelectedRfq.salesperson_name || sdSelectedRfq.sales_code || 'Unclaimed'}</p>
                        {sdUser?.role === 'administrator' && <label>Assign sales code<select value={sdSelectedRfq.sales_code_id || ''} onChange={(e) => void sdAssignRfq(e.target.value)}><option value="">Unassigned</option>{sdConfig.sales_codes.filter((s: any) => s.is_active).map((s: any) => <option key={s.id} value={s.id}>{s.code} · {s.display_name}</option>)}</select></label>}
                        <div className="sd-actions"><button className="primary" disabled={busy} onClick={() => void sdSaveRfq()}>{busy ? 'Saving…' : 'Save changes'}</button>{sdUser?.role === 'salesperson' && !sdSelectedRfq.sales_code && <button className="primary" disabled={busy} onClick={() => void sdClaimRfq(sdSelectedRfq)}>Claim this RFQ</button>}</div>
                        {sdSelectedRfq.audit_history?.length > 0 && <div className="sd-history"><h4>History</h4>{sdSelectedRfq.audit_history.slice().reverse().map((h: any, i: number) => <p key={i}><b>{h.action}</b> · {new Date(h.created_at).toLocaleString()} · {JSON.stringify(h.changes)}</p>)}</div>}
                      </div>
                    )}
                  </>
                ) : (
                  sdUser?.role !== 'administrator' ? <div className="rfq-empty-card"><Settings size={26}/><h3>Administrator access required</h3><p>Only administrators can manage Sales Desk configuration.</p></div> : (
                    <div className="sd-config-layout">
                      <div className="rfq-empty-card sd-form-card">
                        <h3>Media platforms</h3><p>Add enquiry sources and deactivate old options without removing historical RFQs.</p>
                        <div className="sd-config-add"><input placeholder="New platform name" value={sdConfigDraft.mediaName} onChange={(e) => setSdConfigDraft({ ...sdConfigDraft, mediaName: e.target.value })}/><button className="primary" disabled={busy || !sdConfigDraft.mediaName.trim()} onClick={() => void sdConfigAction('/api/sales-desk/config/media-platforms', { name: sdConfigDraft.mediaName, sort_order: Number(sdConfigDraft.mediaSort || 0) })}>Add</button></div>
                        {sdConfig.media_platforms.map((m: any) => <div className="sd-config-row" key={m.id}><div><b>{m.name}</b><small>Order {m.sort_order} · {m.is_active ? 'Active' : 'Inactive'}</small></div><div className="sd-actions"><button className="secondary" onClick={() => void sdConfigAction(`/api/sales-desk/config/media-platforms/${m.id}`, { sort_order: Math.max(0, Number(m.sort_order) - 1) }, 'PATCH')}>↑</button><button className="secondary" onClick={() => void sdConfigAction(`/api/sales-desk/config/media-platforms/${m.id}`, { sort_order: Number(m.sort_order) + 1 }, 'PATCH')}>↓</button><button className="secondary" onClick={() => void sdConfigAction(`/api/sales-desk/config/media-platforms/${m.id}`, { is_active: !m.is_active }, 'PATCH')}>{m.is_active ? 'Deactivate' : 'Activate'}</button><button className="secondary" onClick={() => { const name = window.prompt('Rename media platform', m.name); if (name?.trim()) void sdConfigAction(`/api/sales-desk/config/media-platforms/${m.id}`, { name }, 'PATCH') }}>Rename</button></div></div>)}
                      </div>
                      <div className="rfq-empty-card sd-form-card">
                        <h3>Sales codes</h3><p>Salesperson accounts are linked to these configured codes.</p>
                        <div className="sd-config-add"><input placeholder="Code (e.g. SP01)" value={sdConfigDraft.salesCode} onChange={(e) => setSdConfigDraft({ ...sdConfigDraft, salesCode: e.target.value })}/><input placeholder="Display name" value={sdConfigDraft.salesName} onChange={(e) => setSdConfigDraft({ ...sdConfigDraft, salesName: e.target.value })}/><button className="primary" disabled={busy || !sdConfigDraft.salesCode.trim() || !sdConfigDraft.salesName.trim()} onClick={() => void sdConfigAction('/api/sales-desk/config/sales-codes', { code: sdConfigDraft.salesCode, display_name: sdConfigDraft.salesName })}>Add</button></div>
                        {sdConfig.sales_codes.map((s: any) => <div className="sd-config-row" key={s.id}><div><b>{s.code} · {s.display_name}</b><small>{s.is_active ? 'Active' : 'Inactive'}</small></div><div className="sd-actions"><button className="secondary" onClick={() => { const name = window.prompt('Sales code display name', s.display_name); if (name?.trim()) void sdConfigAction(`/api/sales-desk/config/sales-codes/${s.id}`, { display_name: name }, 'PATCH') }}>Edit name</button><button className="secondary" onClick={() => void sdConfigAction(`/api/sales-desk/config/sales-codes/${s.id}`, { is_active: !s.is_active }, 'PATCH')}>{s.is_active ? 'Deactivate' : 'Activate'}</button></div></div>)}
                      </div>
                      <div className="rfq-empty-card sd-form-card">
                        <h3>RFQ statuses</h3><p>Mark terminal statuses as closed so dashboard open totals stay meaningful.</p>
                        <div className="sd-config-add"><input placeholder="New status name" value={sdConfigDraft.statusName} onChange={(e) => setSdConfigDraft({ ...sdConfigDraft, statusName: e.target.value })}/><label className="sd-inline-check"><input type="checkbox" checked={sdConfigDraft.statusClosed} onChange={(e) => setSdConfigDraft({ ...sdConfigDraft, statusClosed: e.target.checked })}/> Closed status</label><button className="primary" disabled={busy || !sdConfigDraft.statusName.trim()} onClick={() => void sdConfigAction('/api/sales-desk/config/statuses', { name: sdConfigDraft.statusName, sort_order: Number(sdConfig.statuses.length), is_closed: sdConfigDraft.statusClosed })}>Add</button></div>
                        {sdConfig.statuses.map((s: any) => <div className="sd-config-row" key={s.id}><div><b>{s.name}</b><small>Order {s.sort_order} · {s.is_closed ? 'Closed' : 'Open'} · {s.is_active ? 'Active' : 'Inactive'}</small></div><div className="sd-actions"><button className="secondary" onClick={() => void sdConfigAction(`/api/sales-desk/config/statuses/${s.id}`, { sort_order: Math.max(0, Number(s.sort_order) - 1) }, 'PATCH')}>↑</button><button className="secondary" onClick={() => void sdConfigAction(`/api/sales-desk/config/statuses/${s.id}`, { sort_order: Number(s.sort_order) + 1 }, 'PATCH')}>↓</button><button className="secondary" onClick={() => void sdConfigAction(`/api/sales-desk/config/statuses/${s.id}`, { is_active: !s.is_active }, 'PATCH')}>{s.is_active ? 'Deactivate' : 'Activate'}</button><button className="secondary" onClick={() => { const name = window.prompt('Rename status', s.name); if (name?.trim()) void sdConfigAction(`/api/sales-desk/config/statuses/${s.id}`, { name }, 'PATCH') }}>Rename</button><button className="secondary" onClick={() => void sdConfigAction(`/api/sales-desk/config/statuses/${s.id}`, { is_closed: !s.is_closed }, 'PATCH')}>{s.is_closed ? 'Mark open' : 'Mark closed'}</button></div></div>)}
                      </div>
                    </div>
                  )
                )}
              </>
            )}
          </section>
        )}

        {key && page === 'Feed' && (
          <>
            <div className="welcome">
              <div>
                <span className="pill">MONTHLY OVERVIEW</span>
                <h2>Make every post count.</h2>
                <p>Plan, organise and track Impala Spares' social content in one place.</p>
              </div>
              <button className="secondary" onClick={() => setPage('Campaigns')}>View campaigns <ChevronDown size={15} /></button>
            </div>
            <div className="stats">
              {[
                { label: 'Published Posts', value: currentMonthPosts.filter((p) => p.status === 'published').length, filter: 'published', icon: CheckCircle2 },
                { label: 'Scheduled', value: currentMonthPosts.filter((p) => p.status === 'scheduled').length, filter: 'scheduled', icon: CalendarClock },
                { label: 'Needs Attention', value: currentMonthPosts.filter((p) => NEEDS_ATTENTION.includes(p.status)).length, filter: 'awaiting_approval', icon: CircleAlert },
                { label: 'Facebook engagements', value: currentMonthPosts.filter((p) => p.status === 'published' && p.channels.includes('facebook')).reduce((sum, p) => sum + (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0), 0), filter: 'engagements', icon: BarChart3 },
              ].map((s) => (
                <button
                  className="stat-card" key={s.label}
                  onClick={() => { setPage('Posts'); setView('list'); setFilter(s.filter); setCampaignFilter('all'); setSearch(''); setMonth(startOfMonth()) }}
                >
                  <div className="stat-top"><span>{s.label}</span><s.icon size={18} /></div>
                  <strong>{s.value}</strong>
                  <small>{s.filter === 'engagements' ? 'Facebook-sourced · this month' : 'This month'}</small>
                </button>
              ))}
            </div>
            <div className="section-head">
              <div><h2>Recent posts</h2><p>Your latest drafts and scheduled content</p></div>
              <button className="text-button" onClick={() => { setMonth(null); setFilter('all'); setPage('Posts') }}>View all posts →</button>
            </div>
            <PostList posts={posts.slice(0, 5)} campaigns={campaigns} onEdit={openEditor} onOpen={openPost} onDelete={removePost} />
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
                {(['list', 'board', 'calendar'] as const).map((v) => (
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
              {integrations.some((i) => i.provider === 'facebook' && i.status === 'connected') && (
                <button className="secondary" disabled={busy} onClick={() => void syncFacebook()}>Sync from Facebook</button>
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
              <button className="primary" onClick={() => setCampaignModal(true)}><Plus size={16} /> New campaign</button>
            </div>
            <div className="campaign-grid">
              {campaigns.map((c) => (
                <div className="campaign-card" key={c.id}>
                  <div className="campaign-icon"><Megaphone size={20} /></div>
                  <h3>{c.name}</h3>
                  <p>{c.objective || 'No objective added yet.'}</p>
                  <div className="campaign-footer">
                    <span>{posts.filter((p) => p.campaign_id === c.id).length} posts</span>
                    <button className="text-button" onClick={() => { setPage('Posts'); setSearch(''); setFilter('all'); setCampaignFilter(c.id); setMonth(null) }}>View posts →</button>
                  </div>
                </div>
              ))}
              {campaigns.length === 0 && (
                <div className="empty">
                  <Megaphone size={28} /><h3>No campaigns yet</h3>
                  <p>Create a campaign to organise related posts.</p>
                  <button className="secondary" onClick={() => setCampaignModal(true)}>Create campaign</button>
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
              {integrations.map((i) => (
                <div className="integration" key={i.provider}>
                  <div className={`provider-icon ${i.provider}`}>{i.provider === 'facebook' ? 'f' : i.provider === 'instagram' ? '◎' : '◉'}</div>
                  <div className="integration-info">
                    <b>{i.label}</b>
                    <p>{i.note || (i.status === 'connected' ? 'Live Page identity check passed.' : 'Official account connection is not configured.')}</p>
                    {i.provider === 'facebook' && i.page_id && <p><strong>Page ID:</strong> {i.page_id}</p>}
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
                        {i.connection_source === 'oauth' && <button className="secondary" disabled={busy} onClick={() => void disconnectFacebook()}>Disconnect</button>}
                        {facebookPages.length > 0 && <div className="facebook-page-picker">
                          <label htmlFor="facebook-page-select">Choose a Facebook Page</label>
                          <select id="facebook-page-select" value={selectedFacebookPage} onChange={(e) => setSelectedFacebookPage(e.target.value)}>
                            {facebookPages.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
                          </select>
                          <button className="secondary" disabled={busy || !selectedFacebookPage} onClick={() => void chooseFacebookPage()}>Use this Page</button>
                        </div>}
                      </div>
                    : <button className="secondary" disabled>{'Connect later'}</button>}
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
                {[['facebook', 'Facebook'], ['instagram', 'Instagram'], ['whatsapp', 'WhatsApp']].map(([v, l]) => (
                  <label className="check-chip" key={v}>
                    <input
                      type="checkbox" checked={channels.includes(v)}
                      onChange={(e) => patchEditor({ channels: e.target.checked ? [...channels, v] : channels.filter((x) => x !== v) })}
                    />{l}
                  </label>
                ))}
              </div>

 
              {channels.includes('whatsapp') && (
                <>
                  <label id="lbl-wa">WhatsApp destination</label>
                  <div className="two-col" role="group" aria-labelledby="lbl-wa">
                    <select
                      aria-label="WhatsApp destination type" value={editor.whatsapp_recipient_type || 'contact'}
                      onChange={(e) => patchEditor({ whatsapp_recipient_type: e.target.value, whatsapp_recipient_id: '', whatsapp_recipient_name: '' })}
                    >
                      <option value="contact">Contact</option>
                      <option value="group">Group (subject to API eligibility)</option>
                    </select>
                    <select
                      aria-label="WhatsApp destination" value={editor.whatsapp_recipient_name || ''}
                      onChange={(e) => patchEditor({ whatsapp_recipient_name: e.target.value, whatsapp_recipient_id: e.target.value })}
                    >
                      <option value="">Select {editor.whatsapp_recipient_type || 'contact'}</option>
                      {(editor.whatsapp_recipient_type === 'group'
                        ? ['Sample fleet updates group', 'Sample customer promotions group']
                        : ['Sample customer contact', 'Sample workshop contact']
                      ).map((n) => <option key={n}>{n}</option>)}
                    </select>
                  </div>
                  <p className="hint">Sample destinations only. WhatsApp support is not built yet.</p>
                </>
              )}

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
              <h2>New campaign</h2>
              <button className="icon-button" aria-label="Close" onClick={() => setCampaignModal(false)}><X size={20} /></button>
            </header>
            <label htmlFor="campaign-name">Campaign name</label>
            <input id="campaign-name" value={campaignName} onChange={(e) => setCampaignName(e.target.value)} placeholder="e.g. Spring maintenance campaign" />
            <label htmlFor="campaign-objective">Objective</label>
            <textarea id="campaign-objective" value={campaignObjective} onChange={(e) => setCampaignObjective(e.target.value)} placeholder="What should this campaign achieve?" rows={3} />
            <footer className="editor-foot">
              <button className="secondary" onClick={() => setCampaignModal(false)}>Cancel</button>
              <button className="primary" onClick={() => void createCampaign()}>Create campaign</button>
            </footer>
          </section>
        </div>
      )}
    </div>
  )
}

function PostList({ posts, campaigns, onEdit, onOpen, onDelete }: {
  posts: Post[]
  campaigns: Campaign[]
  onEdit: (p: Post) => void
  onOpen: (id: string) => void
  onDelete: (id: string) => void
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
    <div className="post-list">
      {posts.map((p) => {
        const heading = p.title?.trim() || p.caption?.trim().slice(0, 110) || 'Untitled post'
        return (
          <article className="post-row" key={p.id}>
            <div className="post-preview" style={{ cursor: 'pointer' }} onClick={() => onOpen(p.id)}>
              {p.media?.[0] ? <img src={mediaSrc(p.media[0])} alt="" /> : <ImagePlus size={22} />}
            </div>
            <div
              className="post-copy" role="button" tabIndex={0} style={{ cursor: 'pointer' }}
              onClick={() => onOpen(p.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(p.id) }}
            >
              <div className="post-meta">
                <span className={`status ${p.status}`}>{p.status.replace(/_/g, ' ')}</span>
                <span>{p.channels.join(' · ') || 'No channel'}</span>
              </div>
              <b>{heading}</b>
              <small>
                {campaigns.find((c) => c.id === p.campaign_id)?.name || 'No campaign'} ·{' '}
                {p.published_at ? `Posted ${fmt(p.published_at)}` : fmt(p.publish_at)}
              </small>
              {p.status === 'published' && (
                <small>
                  Reach {metric(p.reach)} · Impressions {metric(p.impressions)} · Likes {metric(p.likes)} · Comments {metric(p.comments)} · Shares {metric(p.shares)}
                  {p.metrics_refreshed_at ? ` · updated ${fmt(p.metrics_refreshed_at)}` : ''}
                </small>
              )}
            </div>
            <div className="row-actions">
              <button className="secondary" onClick={() => onOpen(p.id)}>View</button>
              {EDITABLE.includes(p.status) && <button className="secondary" onClick={() => onEdit(p)}>Edit</button>}
              <button className="icon-button" title="Delete local record (only after it is absent from Facebook)" aria-label="Delete post" onClick={() => onDelete(p.id)}><Trash2 size={16} /></button>
            </div>
          </article>
        )
      })}
    </div>
  )
}
