import { useEffect, useMemo, useState } from 'react'
import { BarChart3, CalendarClock, CheckCircle2, ChevronDown, CircleAlert, ClipboardList, ImagePlus, LayoutDashboard, Megaphone, Plus, Search, Settings, Send, Trash2, Upload, X } from 'lucide-react'

type Media = { id: string; name: string; url: string; content_type?: string; size?: number }
type Campaign = { id: string; name: string; objective: string; start_date?: string | null; end_date?: string | null }
type Post = { id: string; created_at?: string; updated_at?: string; caption: string; campaign_id: string | null; channels: string[]; facebook_groups: string[]; whatsapp_recipient_type?: string | null; whatsapp_recipient_id?: string | null; whatsapp_recipient_name?: string | null; status: string; publish_at?: string | null; media: Media[]; last_error?: string | null }
const API = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000'
const getKey = () => sessionStorage.getItem('impala_api_key') || ''
async function api(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers || {})
  headers.set('Authorization', `Bearer ${getKey()}`)
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const res = await fetch(`${API}${path}`, { ...options, headers })
  if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.detail || `Request failed (${res.status})`) }
  return res.status === 204 ? null : res.json()
}
const emptyPost = (): Partial<Post> => ({ caption: '', campaign_id: null, channels: ['facebook'], facebook_groups: [], whatsapp_recipient_type: 'contact', whatsapp_recipient_id: '', whatsapp_recipient_name: '', status: 'draft', publish_at: '', media: [] })
const fmt = (v?: string | null) => v ? new Date(v).toLocaleString() : 'Not scheduled'
const toLocalInput = (value?: string | null) => { if (!value) return ''; const d = new Date(value); const pad = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` }

export default function App() {
  const [key, setKey] = useState(getKey())
  const [keyEntry, setKeyEntry] = useState(getKey())
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

  async function load() {
    if (!getKey()) return
    try { const [p,c,i] = await Promise.all([api('/api/posts'), api('/api/campaigns'), api('/api/integrations')]); setPosts(p); setCampaigns(c); setIntegrations(i); setError('') }
    catch (e) { setError((e as Error).message) }
  }
  useEffect(() => { if (key) void load() }, [key])
  function connectKey() { sessionStorage.setItem('impala_api_key', keyEntry); setKey(keyEntry); setNotice('API key set for this browser session.'); }
  const currentMonthPosts = useMemo(() => posts.filter(p => { const d = new Date(p.publish_at || p.created_at || ''); return !!(p.publish_at || p.created_at) && d.getMonth() === new Date().getMonth() && d.getFullYear() === new Date().getFullYear() }), [posts])
  const visiblePosts = posts.filter(p => (filter === 'all' || p.status === filter || (filter === 'engagements' && p.status === 'published')) && (campaignFilter === 'all' || p.campaign_id === campaignFilter) && (!search || p.caption.toLowerCase().includes(search.toLowerCase())))
  async function savePost(mode: 'draft' | 'publish') {
    if (!editor) return
    setBusy(true); setError('')
    try {
      const payload: any = { ...emptyPost(), ...editor }
      payload.status = mode === 'draft' ? 'draft' : (payload.publish_at && new Date(payload.publish_at) > new Date() ? 'scheduled' : 'needs_attention')
      // Publishing is intentionally blocked until a real Meta connection is configured.
      if (mode === 'publish' && payload.status !== 'scheduled') throw new Error('Publishing is not connected yet. Your post was not sent. Connect the Meta publishing integration before publishing now, or schedule it for later.')
      if (payload.publish_at) payload.publish_at = new Date(payload.publish_at).toISOString(); else payload.publish_at = null
      const saved = editor.id ? await api(`/api/posts/${editor.id}`, { method: 'PATCH', body: JSON.stringify(payload) }) : await api('/api/posts', { method: 'POST', body: JSON.stringify(payload) })
      setNotice(payload.status === 'scheduled' ? 'Post saved as scheduled. Automatic publishing is not enabled yet.' : 'Draft saved.'); setEditor(null); await load()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function upload(files: FileList | null) {
    if (!files || !editor) return
    setBusy(true); setError('')
    try { const uploaded: Media[] = []; for (const file of Array.from(files)) { const fd = new FormData(); fd.append('file', file); uploaded.push(await api('/api/media', { method: 'POST', body: fd })) } setEditor({ ...editor, media: [...(editor.media || []), ...uploaded] }) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function createCampaign() {
    if (!campaignName.trim()) return
    try { await api('/api/campaigns', { method: 'POST', body: JSON.stringify({ name: campaignName, objective: campaignObjective }) }); setCampaignName(''); setCampaignObjective(''); setCampaignModal(false); setNotice('Campaign created.'); await load() }
    catch (e) { setError((e as Error).message) }
  }
  async function removePost(id: string) { if (!confirm('Delete this post?')) return; try { await api(`/api/posts/${id}`, { method: 'DELETE' }); await load(); setNotice('Post deleted.') } catch(e) { setError((e as Error).message) } }

  return <div className="shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark">I</div><div><b>IMPALA HUB</b><small>Marketing workspace</small></div></div>
      <div className="nav-label">WORKSPACE</div>{[['Feed',LayoutDashboard],['Posts',ClipboardList],['Campaigns',Megaphone],['Configuration',Settings]].map(([label,Icon]: any) => <button key={label} className={`nav-item ${page===label?'active':''}`} onClick={()=>{setPage(label);setFilter('all');setCampaignFilter('all')}}><Icon size={18}/>{label}</button>)}
      <div className="sidebar-bottom"><div className="connection-dot"/> <span>Local workspace</span><small>Publishing not connected</small></div>
    </aside>
    <main className="main"><header className="topbar"><div><div className="eyebrow">IMPALA SPARES / MARKETING</div><h1>{page}</h1></div><button className="primary" onClick={()=>{setEditor(emptyPost());setError('')}}><Plus size={17}/> Create post</button></header>
      {notice && <div className="notice"><CheckCircle2 size={17}/>{notice}<button onClick={()=>setNotice('')}><X size={15}/></button></div>}{error && <div className="error"><CircleAlert size={17}/>{error}<button onClick={()=>setError('')}><X size={15}/></button></div>}
      {!key && <section className="key-panel"><h2>Connect to your local API</h2><p>Enter the API key configured in <code>backend/.env</code>. This keeps the local API from accepting unauthorised requests.</p><div className="inline-form"><input type="password" placeholder="API key" value={keyEntry} onChange={e=>setKeyEntry(e.target.value)}/><button className="primary" onClick={connectKey}>Connect</button></div></section>}
      {key && page==='Feed' && <><div className="welcome"><div><span className="pill">MONTHLY OVERVIEW</span><h2>Make every post count.</h2><p>Plan, organise and track Impala Spares' social content in one place.</p></div><button className="secondary" onClick={()=>setPage('Campaigns')}>View campaigns <ChevronDown size={15}/></button></div>
        <div className="stats">{[{label:'Published Posts',value:currentMonthPosts.filter(p=>p.status==='published').length,filter:'published',icon:CheckCircle2},{label:'Scheduled',value:currentMonthPosts.filter(p=>p.status==='scheduled').length,filter:'scheduled',icon:CalendarClock},{label:'Needs Attention',value:currentMonthPosts.filter(p=>p.status==='needs_attention').length,filter:'needs_attention',icon:CircleAlert},{label:'Engagements',value:'—',filter:'engagements',icon:BarChart3}].map(s=><button className="stat-card" key={s.label} onClick={()=>{setPage('Posts');setFilter(s.filter);setCampaignFilter('all');setSearch('')}}><div className="stat-top"><span>{s.label}</span><s.icon size={18}/></div><strong>{s.value}</strong><small>{s.filter==='engagements'?'Available after account connection':'This month'}</small></button>)}</div>
        <div className="section-head"><div><h2>Recent posts</h2><p>Your latest drafts and scheduled content</p></div><button className="text-button" onClick={()=>setPage('Posts')}>View all posts →</button></div><PostList posts={posts.slice(0,5)} campaigns={campaigns} onEdit={p=>setEditor(p)} onDelete={removePost}/></>}
      {key && page==='Posts' && <><div className="toolbar"><div className="search"><Search size={17}/><input placeholder="Search captions" value={search} onChange={e=>setSearch(e.target.value)}/></div><select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All posts</option><option value="draft">Drafts</option><option value="scheduled">Scheduled</option><option value="published">Published</option><option value="needs_attention">Needs attention</option><option value="engagements">Published / engagements</option></select><select value={campaignFilter} onChange={e=>setCampaignFilter(e.target.value)}><option value="all">All campaigns</option>{campaigns.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select><button className="primary" onClick={()=>setEditor(emptyPost())}><Plus size={16}/> New post</button></div><PostList posts={visiblePosts} campaigns={campaigns} onEdit={p=>setEditor(p)} onDelete={removePost}/></>}
      {key && page==='Campaigns' && <><div className="section-head"><div><h2>Campaigns</h2><p>Group related posts under a shared marketing objective.</p></div><button className="primary" onClick={()=>setCampaignModal(true)}><Plus size={16}/> New campaign</button></div><div className="campaign-grid">{campaigns.map(c=><div className="campaign-card" key={c.id}><div className="campaign-icon"><Megaphone size={20}/></div><h3>{c.name}</h3><p>{c.objective || 'No objective added yet.'}</p><div className="campaign-footer"><span>{posts.filter(p=>p.campaign_id===c.id).length} posts</span><button className="text-button" onClick={()=>{setPage('Posts');setSearch('');setFilter('all');setCampaignFilter(c.id)}}>View posts →</button></div></div>)}{campaigns.length===0&&<div className="empty"><Megaphone size={28}/><h3>No campaigns yet</h3><p>Create a campaign to organise related posts.</p><button className="secondary" onClick={()=>setCampaignModal(true)}>Create campaign</button></div>}</div></>}
      {key && page==='Configuration' && <><div className="section-head"><div><h2>Connected channels</h2><p>Account connections will be enabled after the Meta developer app is configured.</p></div></div><div className="integration-list">{integrations.map(i=><div className="integration" key={i.provider}><div className={`provider-icon ${i.provider}`}>{i.provider==='facebook'?'f':i.provider==='instagram'?'◎':'◉'}</div><div className="integration-info"><b>{i.label}</b><p>{i.note || 'Publishing and insights permissions will be requested through the official connection flow.'}</p></div><span className="status-badge">Not connected</span><button className="secondary" disabled>Connect later</button></div>)}</div><div className="security-note"><Settings size={20}/><div><b>Connection setup required</b><p>We will use Meta's OAuth flow. Access tokens will stay on the server, never in browser storage. Live publishing stays disabled until the integration is configured and verified.</p></div></div><div className="section-head"><div><h2>Channels</h2><p>Facebook, Instagram and WhatsApp destinations are configured per post.</p></div></div></>}
    </main>
    {editor && <div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setEditor(null)}}><section className="editor"><header className="editor-head"><div><span className="eyebrow">CONTENT WORKFLOW</span><h2>{editor.id?'Edit post':'Create post'}</h2></div><button className="icon-button" onClick={()=>setEditor(null)}><X size={20}/></button></header><div className="editor-body"><label>Channels <span>Choose where this post should appear</span></label><div className="channel-checks">{[['facebook','Facebook'],['instagram','Instagram'],['whatsapp','WhatsApp']].map(([v,l])=><label className="check-chip" key={v}><input type="checkbox" checked={(editor.channels||[]).includes(v)} onChange={e=>setEditor({...editor,channels:e.target.checked?[...(editor.channels||[]),v]: (editor.channels||[]).filter(x=>x!==v)})}/>{l}</label>)}</div>
        {(editor.channels||[]).includes('facebook')&&<><label>Additional Facebook groups <span>Choose up to 3</span></label><div className="group-checks">{['Impala Spares Community','Truck & Trailer Parts Network','South African Transport Industry'].map(g=><label key={g}><input type="checkbox" checked={(editor.facebook_groups||[]).includes(g)} disabled={!(editor.facebook_groups||[]).includes(g)&&(editor.facebook_groups||[]).length>=3} onChange={e=>setEditor({...editor,facebook_groups:e.target.checked?[...(editor.facebook_groups||[]),g]:(editor.facebook_groups||[]).filter(x=>x!==g)})}/>{g}</label>)}</div></>}
        {(editor.channels||[]).includes('whatsapp')&&<><label>WhatsApp destination</label><div className="two-col"><select value={editor.whatsapp_recipient_type||'contact'} onChange={e=>setEditor({...editor,whatsapp_recipient_type:e.target.value,whatsapp_recipient_id:'',whatsapp_recipient_name:''})}><option value="contact">Contact</option><option value="group">Group (subject to API eligibility)</option></select><select value={editor.whatsapp_recipient_name||''} onChange={e=>setEditor({...editor,whatsapp_recipient_name:e.target.value,whatsapp_recipient_id:e.target.value})}><option value="">Select {editor.whatsapp_recipient_type||'contact'}</option>{(editor.whatsapp_recipient_type==='group'?['Sample fleet updates group','Sample customer promotions group']:['Sample customer contact','Sample workshop contact']).map(n=><option key={n}>{n}</option>)}</select></div><p className="hint">Sample destinations only. Real contacts and supported groups will load after WhatsApp is connected.</p></>}
        <label>Caption / message</label><textarea rows={5} placeholder="Write the post caption here..." value={editor.caption||''} onChange={e=>setEditor({...editor,caption:e.target.value})}/><div className="editor-label-row"><label>Images <span>JPG, PNG, WEBP or GIF, max 15 MB each</span></label><label className="upload-button"><Upload size={16}/> Add images<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple onChange={e=>void upload(e.target.files)}/></label></div><div className="media-grid">{(editor.media||[]).map((m,i)=><div className="media-thumb" key={m.id||m.url}><img src={m.url.startsWith('http')?m.url:`${API}${m.url}`} alt={m.name}/><button onClick={()=>setEditor({...editor,media:(editor.media||[]).filter((_,j)=>i!==j)})}><X size={14}/></button><small>{m.name}</small></div>)}{!(editor.media||[]).length&&<div className="media-empty"><ImagePlus size={22}/><span>No images attached</span></div>}</div>
        <label>Campaign</label><select value={editor.campaign_id||''} onChange={e=>setEditor({...editor,campaign_id:e.target.value||null})}><option value="">No campaign</option>{campaigns.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <label>Publication date and time <span>Leave blank for a draft or publish now when integration is active</span></label><input type="datetime-local" value={toLocalInput(editor.publish_at)} onChange={e=>setEditor({...editor,publish_at:e.target.value})}/><p className="hint">Scheduling stores the date and time. A background publishing worker will be enabled once the real channel integrations are configured.</p>
      </div><footer className="editor-foot"><button className="secondary" onClick={()=>setEditor(null)}>Cancel</button><button className="secondary" disabled={busy} onClick={()=>void savePost('draft')}>Save as draft</button><button className="primary" disabled={busy} onClick={()=>void savePost('publish')}><Send size={15}/>{busy?'Saving...':editor.publish_at&&new Date(editor.publish_at)>new Date()?'Schedule post':'Publish'}</button></footer></section></div>}
    {campaignModal&&<div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setCampaignModal(false)}}><section className="small-modal"><header className="editor-head"><h2>New campaign</h2><button className="icon-button" onClick={()=>setCampaignModal(false)}><X size={20}/></button></header><label>Campaign name</label><input value={campaignName} onChange={e=>setCampaignName(e.target.value)} placeholder="e.g. Spring maintenance campaign"/><label>Objective</label><textarea value={campaignObjective} onChange={e=>setCampaignObjective(e.target.value)} placeholder="What should this campaign achieve?" rows={3}/><footer className="editor-foot"><button className="secondary" onClick={()=>setCampaignModal(false)}>Cancel</button><button className="primary" onClick={()=>void createCampaign()}>Create campaign</button></footer></section></div>}
  </div>
}
function PostList({posts,campaigns,onEdit,onDelete}:{posts:Post[],campaigns:Campaign[],onEdit:(p:Post)=>void,onDelete:(id:string)=>void}) {
  if(!posts.length)return <div className="empty"><ClipboardList size={28}/><h3>No posts to show</h3><p>Create a draft to get your content calendar started.</p></div>
  return <div className="post-list">{posts.map(p=><article className="post-row" key={p.id}><div className="post-preview">{p.media?.[0]?<img src={p.media[0].url.startsWith('http')?p.media[0].url:`${API}${p.media[0].url}`} alt=""/>:<ImagePlus size={22}/>}</div><div className="post-copy"><div className="post-meta"><span className={`status ${p.status}`}>{p.status.replace('_',' ')}</span><span>{p.channels.join(' · ')||'No channel'}</span></div><b>{p.caption?.trim().slice(0,110)||'Untitled post'}{(p.caption?.length||0)>110?'…':''}</b><small>{campaigns.find(c=>c.id===p.campaign_id)?.name||'No campaign'} · {fmt(p.publish_at)}</small></div><div className="row-actions"><button className="secondary" onClick={()=>onEdit(p)}>Edit</button><button className="icon-button" title="Delete post" onClick={()=>onDelete(p.id)}><Trash2 size={16}/></button></div></article>)}</div>
}
