import { useEffect, useMemo, useState } from 'react'
import {
  BarChart3, CalendarClock, CheckCircle2, ChevronDown, CircleAlert, ClipboardList, ImagePlus,
  LayoutDashboard, Megaphone, Plus, Search, Settings, Send, Trash2, Upload, X,
} from 'lucide-react'
import PostDetail from './PostDetail'
import PostBoard from './PostBoard'
import PostCalendar from './PostCalendar'
import MonthNav from './MonthNav'
import { api, AuthError, EDITABLE, fmt, getKey, inMonth, isFuture, KEY_STORAGE, mediaSrc, metric, startOfMonth, type Media, type Post, type Campaign } from './lib'

const SAMPLE_FB_GROUPS = [
  'sample:Impala Spares Community',
  'sample:Truck & Trailer Parts Network',
  'sample:South African Transport Industry',
]
const groupLabel = (g: string) => (g.startsWith('sample:') ? `${g.slice(7)} (sample)` : g)
const pad = (n: number) => String(n).padStart(2, '0')
const toLocalInput = (value?: string | null) => {
  if (!value) return ''
  const d = new Date(value)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const emptyPost = (): Partial<Post> => ({
  title: '', caption: '', campaign_id: null, channels: ['facebook'], facebook_groups: [],
  whatsapp_recipient_type: 'contact', whatsapp_recipient_id: '', whatsapp_recipient_name: '',
  status: 'draft', publish_at: '', media: [],
})
const NEEDS_ATTENTION = ['awaiting_approval', 'failed']

export default function App() {
  const [key, setKey] = useState(getKey())
  const [keyEntry, setKeyEntry] = useState('')
  const [page, setPage] = useState('Feed')
  const [posts, setPosts] = useState<Post[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [integrations, setIntegrations] = useState<any[]>([])
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
  useEffect(() => { if (key) void load() }, [key])

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
      const stamp = p.publish_at || p.created_at
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

  async function savePost(mode: 'draft' | 'approval' | 'schedule') {
    if (!editor) return
    setBusy(true); setError('')
    try {
      const status = mode === 'draft' ? 'draft' : mode === 'approval' ? 'awaiting_approval' : 'scheduled'
      if (status === 'scheduled' && !isFuture(editor.publish_at)) {
        throw new Error('Choose a future date and time to schedule this post. Publishing immediately is not available until Meta is connected.')
      }
      const payload = {
        title: editor.title ?? '',
        caption: editor.caption ?? '',
        campaign_id: editor.campaign_id || null,
        channels: editor.channels ?? [],
        facebook_groups: editor.facebook_groups ?? [],
        whatsapp_recipient_type: editor.whatsapp_recipient_type ?? null,
        whatsapp_recipient_id: editor.whatsapp_recipient_id ?? null,
        whatsapp_recipient_name: editor.whatsapp_recipient_name ?? null,
        media: editor.media ?? [],
        status,
        publish_at: editor.publish_at ? new Date(editor.publish_at).toISOString() : null,
      }
      if (editor.id) await api(`/api/posts/${editor.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
      else await api('/api/posts', { method: 'POST', body: JSON.stringify(payload) })
      setNotice(
        status === 'scheduled' ? 'Post saved as scheduled. Automatic publishing is not enabled yet.'
        : status === 'awaiting_approval' ? 'Post sent for approval.'
        : 'Draft saved.',
      )
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

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">I</div>
          <div><b>IMPALA HUB</b><small>Marketing workspace</small></div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        {([['Feed', LayoutDashboard], ['Posts', ClipboardList], ['Campaigns', Megaphone], ['Configuration', Settings]] as const).map(
          ([label, Icon]) => (
            <button
              key={label}
              className={`nav-item ${page === label || (label === 'Posts' && page === 'Post') ? 'active' : ''}`}
              onClick={() => { setPage(label); setFilter('all'); setCampaignFilter('all'); setMonth(startOfMonth()) }}
            >
              <Icon size={18} />{label}
            </button>
          ),
        )}
        <div className="sidebar-bottom">
          <div className="connection-dot" /> <span>Local workspace</span>
          <small>{integrations.some((i) => i.status === 'connected') ? 'Facebook connected' : 'Publishing not connected'}</small>
          {key && <button className="text-button" onClick={disconnectKey}>Change API key</button>}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div><div className="eyebrow">IMPALA SPARES / MARKETING</div><h1>{page === 'Post' ? 'Post details' : page}</h1></div>
          <button className="primary" onClick={() => { setEditor(emptyPost()); setError('') }}>
            <Plus size={17} /> Create post
          </button>
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
                { label: 'Engagements', value: '—', filter: 'engagements', icon: BarChart3 },
              ].map((s) => (
                <button
                  className="stat-card" key={s.label}
                  onClick={() => { setPage('Posts'); setView('list'); setFilter(s.filter); setCampaignFilter('all'); setSearch(''); setMonth(startOfMonth()) }}
                >
                  <div className="stat-top"><span>{s.label}</span><s.icon size={18} /></div>
                  <strong>{s.value}</strong>
                  <small>{s.filter === 'engagements' ? 'Available after account connection' : 'This month'}</small>
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
              onDelete={removePost} onSaveCampaign={saveCampaign} onError={handleError}
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
              <div><h2>Connected channels</h2><p>Account connections will be enabled after the Meta developer app is configured.</p></div>
            </div>
            <div className="integration-list">
              {integrations.map((i) => (
                <div className="integration" key={i.provider}>
                  <div className={`provider-icon ${i.provider}`}>{i.provider === 'facebook' ? 'f' : i.provider === 'instagram' ? '◎' : '◉'}</div>
                  <div className="integration-info">
                    <b>{i.label}</b>
                    <p>{i.note || (i.status === 'connected' ? 'Scheduled posts are published to this Page automatically.' : 'Publishing and insights permissions will be requested through the official connection flow.')}</p>
                  </div>
                  <span className="status-badge">
                    {i.status === 'connected' ? `Connected${i.account_name ? `: ${i.account_name}` : ''}` : i.status === 'error' ? 'Connection error' : 'Not connected'}
                  </span>
                  <button className="secondary" disabled>{i.status === 'connected' ? 'Connected' : 'Connect later'}</button>
                </div>
              ))}
            </div>
            <div className="security-note">
              <Settings size={20} />
              <div>
                <b>Connection setup required</b>
                <p>We will use Meta's OAuth flow. Access tokens will stay on the server, never in browser storage. Live publishing stays disabled until the integration is configured and verified.</p>
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

              {channels.includes('facebook') && (
                <>
                  <label id="lbl-groups">Additional Facebook groups <span>Choose up to 3. Sample groups only until Facebook is connected.</span></label>
                  <div className="group-checks" role="group" aria-labelledby="lbl-groups">
                    {SAMPLE_FB_GROUPS.map((g) => {
                      const selected = editor.facebook_groups || []
                      return (
                        <label key={g}>
                          <input
                            type="checkbox" checked={selected.includes(g)}
                            disabled={!selected.includes(g) && selected.length >= 3}
                            onChange={(e) => patchEditor({ facebook_groups: e.target.checked ? [...selected, g] : selected.filter((x) => x !== g) })}
                          />{groupLabel(g)}
                        </label>
                      )
                    })}
                  </div>
                </>
              )}

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
              <p className="hint">Scheduling stores the date and time. A background publishing worker will be enabled once the real channel integrations are configured.</p>
            </div>
            <footer className="editor-foot">
              <button className="secondary" onClick={() => setEditor(null)}>Cancel</button>
              <button className="secondary" disabled={busy} onClick={() => void savePost('draft')}>Save as draft</button>
              <button className="secondary" disabled={busy} onClick={() => void savePost('approval')}>Send for approval</button>
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
                  Clicks {metric(p.clicks)} · Likes {metric(p.likes)} · Comments {metric(p.comments)} · Shares {metric(p.shares)}
                  {p.metrics_refreshed_at ? ` · updated ${fmt(p.metrics_refreshed_at)}` : ''}
                </small>
              )}
            </div>
            <div className="row-actions">
              <button className="secondary" onClick={() => onOpen(p.id)}>View</button>
              {EDITABLE.includes(p.status) && <button className="secondary" onClick={() => onEdit(p)}>Edit</button>}
              {p.status !== 'published' && (
                <button className="icon-button" title="Delete post" aria-label="Delete post" onClick={() => onDelete(p.id)}><Trash2 size={16} /></button>
              )}
            </div>
          </article>
        )
      })}
    </div>
  )
}
