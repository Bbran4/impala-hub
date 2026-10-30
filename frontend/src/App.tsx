import { authService } from './authService'
import { postsService, type PostPatch } from './postsService'
import { campaignsService } from './campaignsService'
import { integrationsService, type Integration } from './integrationsService'
import type { PostSummary } from './marketingPosts.ts'
import { POST_PAGE_SIZE } from './marketingPosts.ts'
import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft, ArrowRight, BarChart3, CalendarClock, CheckCircle2, ChevronDown, CircleAlert, ClipboardList, ImagePlus, Users, Heart, MessageCircle, Eye, ExternalLink,
  LayoutDashboard, Megaphone, Plus, Search, Settings, Send, Trash2, Upload, X, Map, PackageCheck,
  Database, ServerCog, History, ShieldCheck, BookOpen, Network, CloudDownload, Gauge, BookMarked,
} from 'lucide-react'
import PostDetail from './PostDetail'
import PostBoard from './PostBoard'
import PostCalendar from './PostCalendar'
import MonthNav from './MonthNav'
import SalesDesk from './SalesDesk'
import PartsQueries from './PartsQueries'
import StockBooking from './StockBookingSupabase'
import StockControlConfig from './StockControlConfig'
import StockReordering from './StockReorderingSupabase'
import StockImport from './StockImport'
import ReturnsClaims from './ReturnsClaims'
import AdminSettings from './AdminSettings'
import ChatDock from './ChatDock'
import ChannelsWorkspace from './ChannelsWorkspace'
import NotificationCentre, { type NotificationChannel, type UserNotification } from './NotificationCentre'
import Reporting, { REPORTING_PAGES } from './Reporting'
import { API as apiBaseUrl, AuthError, EDITABLE, fmt, getKey, inMonth, isFuture, KEY_STORAGE, mediaSrc, metric, startOfMonth, type Media, type Post, type Campaign } from './lib'
import { supabase, supabaseConfigured } from './supabase'
import { ALL_MARKETING_PERMISSIONS, type MarketingPermission } from './marketingPermissions'

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
const qrImageSource = (value: string) => value.startsWith('data:') ? value : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(value)}`
const roadmapBucket = (status: string) => status.startsWith('Implemented') ? 'Implemented' : status.startsWith('Partial') ? 'Partial' : status.startsWith('Deferred') ? 'Deferred' : status.startsWith('Retired') ? 'Retired' : status.startsWith('Missing') ? 'Missing' : 'Planned'

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
  ['Send for approval', 'Approval handoff', 'Prerequisite checks exist; notification and decision queue are not connected', 'Partial'],
  ['Sales Desk dashboard', 'Not applicable', 'Team RFQ and sales metrics', 'Implemented; drill-downs planned'],
  ['Sales-code dashboard membership', 'Not applicable', 'Dashboard demonstration rows are not yet linked to active profiles', 'Deferred until live sales data'],
  ['Workspace permissions', 'Role-based application access', 'Salespeople currently see Sales Desk only; Supabase workspace permission contract added', 'Partial; enforce on every workspace backend'],
  ['RFQ analytics', 'Not applicable', 'Period-filtered analytics', 'Implemented; funnel improvements planned'],
  ['Search and filtering', 'Advanced search panels', 'Server-side campaign-aware search, month/status filters and paged results', 'Implemented; saved filters planned'],
  ['Notifications', 'Activities/messages', 'Shared bell, unread state, app channels and RFQ In Progress links', 'Implemented foundation; additional Sales Desk events planned'],
  ['Bulk operations', 'Mass actions', 'Not implemented', 'Missing'],
  ['Export and reporting', 'List/report exports', 'CSV/XLSX/print RFQ export is not implemented', 'Missing'],
  ['Evolve DMS/Qlik reconciliation', 'Not applicable', 'External data integration is intentionally postponed', 'Deferred'],
  ['Personal consultant dashboard', 'Not applicable', 'Requires live sales and GP data', 'Deferred'],
]

const ROADMAP_ROWS = [
  ['Sign-in', 'Odoo authentication', 'Impala Hub session login', 'Implemented'],
  ['Persistent session', 'Yes', 'Persistent session with retry protection', 'Implemented'],
  ['Logout', 'Yes', 'Yes', 'Implemented'],
  ['Facebook connection', 'Social account configuration', 'Meta OAuth, Page selection, diagnostics, disconnect', 'Implemented'],
  ['Instagram connection', 'Social account configuration', 'Schema and UI foundation only; Supabase OAuth is disabled', 'Deferred'],
  ['WhatsApp', 'Not central', 'Deferred', 'Correctly deferred'],
  ['Search', 'Search panels', 'Paged literal search across titles, captions and campaign names', 'Implemented; wildcard syntax planned'],
  ['Feed', 'Account feeds, streams, metrics', 'Network columns, 25 newest posts, metrics', 'Implemented; provider availability applies'],
  ['Create post', 'New Post workflow', 'Create Post editor', 'Implemented'],
  ['Edit draft posts', 'Yes', 'Yes', 'Implemented'],
  ['Schedule posts', 'Yes', 'Yes', 'Implemented'],
  ['Publish now', 'Yes', 'Facebook workflow', 'Partial'],
  ['Facebook publishing', 'Yes', 'OAuth/Page publishing', 'Implemented'],
  ['Instagram publishing', 'Yes', 'Not enabled on the Supabase deployment', 'Deferred'],
  ['Likes, comments, shares', 'Yes', 'Stored/displayed where synced, including reactions and saves', 'Implemented; provider coverage varies'],
  ['Views and reach', 'Odoo insights', 'Facebook post views, reach and provider fallbacks', 'Implemented; provider availability applies'],
  ['Impressions', 'Odoo insights', 'Provider fields exist but live coverage is not verified', 'Partial'],
  ['Clicks', 'Yes', 'Post model, Facebook and Instagram provider paths', 'Implemented; provider availability applies'],
  ['Post analytics detail', 'Post cards and insights', 'Post detail performance metrics', 'Implemented; provider availability applies'],
  ['Campaign creation', 'Yes', 'Yes', 'Implemented'],
  ['Campaign editing', 'Yes', 'Title/objective editing', 'Implemented'],
  ['Campaign deletion', 'Record actions', 'Delete empty campaigns with a safety guard', 'Implemented'],
  ['Campaign Kanban stages', 'New/In Progress/Done', 'Drag-and-drop Kanban', 'Implemented'],
  ['Post Kanban', 'Yes', 'Board view', 'Implemented'],
  ['Post calendar', 'Yes', 'Calendar view', 'Implemented'],
  ['Post list', 'Yes', 'List view', 'Implemented'],
  ['Post pivot reporting', 'Yes', 'Grouped Pivot-style insights table', 'Implemented'],
  ['Search/filtering', 'Extensive search panels', 'Basic search and filters', 'Partial'],
  ['Social conversations', 'Channels and chats', 'Not implemented', 'Missing'],
  ['Sentiment analysis', 'Visible in Channels', 'Not implemented', 'Missing'],
  ['Notifications', 'Odoo activities/messages', 'Shared notification centre and Marketing channel; Marketing event producers are not connected', 'Partial'],
]
export default function App() {
  const [key, setKey] = useState(getKey())
  const [keyEntry, setKeyEntry] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [mfaFactorId, setMfaFactorId] = useState('')
  const [mfaChallengeId, setMfaChallengeId] = useState('')
  const [mfaQr, setMfaQr] = useState('')
  const [mfaSecret, setMfaSecret] = useState('')
  const [mfaSetupFactorId, setMfaSetupFactorId] = useState('')
  const [mfaSetupChallengeId, setMfaSetupChallengeId] = useState('')
  const [mfaEnabled, setMfaEnabled] = useState(false)
  const [roadmapFilter, setRoadmapFilter] = useState('all')
  const [page, setPage] = useState('Apps')
  const [posts, setPosts] = useState<Post[]>([])
  const [postTotal, setPostTotal] = useState(0)
  const [postPage, setPostPage] = useState(0)
  const [postSummary, setPostSummary] = useState<PostSummary[]>([])
  const [postsLoading, setPostsLoading] = useState(false)
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const postLoadSequence = useRef(0)
  const [selectedPost, setSelectedPost] = useState<Post | null>(null)
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [campaignPostCounts, setCampaignPostCounts] = useState<Record<string, number>>({})
  const [integrations, setIntegrations] = useState<Integration[]>([])
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
  const [campaignType, setCampaignType] = useState('Tips')
  const [campaignTypes, setCampaignTypes] = useState<string[]>([])
  // Retained while old Configuration links age out; Admin Settings owns the visible controls.
  const [newCampaignType, setNewCampaignType] = useState('')
  const [draggedCampaignType, setDraggedCampaignType] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [imageViewer, setImageViewer] = useState<{ images: Post['media']; index: number } | null>(null)
  const [view, setView] = useState<'list' | 'board' | 'calendar' | 'pivot'>('list')
  const [month, setMonth] = useState<Date | null>(() => startOfMonth()) // null = all months (list and board only)
  const [profile, setProfile] = useState({ first_name: '', surname: '', email: '', avatar_url: '', sales_code: '' })
  const [profileBusy, setProfileBusy] = useState(false)
  const [isAdministrator, setIsAdministrator] = useState(false)
  const [assignedRoles, setAssignedRoles] = useState<string[]>([])
  const [profileLoaded, setProfileLoaded] = useState(false)
  const [marketingPermissions, setMarketingPermissions] = useState<MarketingPermission[]>([])
  const [notificationRfqId, setNotificationRfqId] = useState<string | null>(null)
  const [chatOpenRequest, setChatOpenRequest] = useState(0)
  const canAccessMarketing = isAdministrator || assignedRoles.includes('marketing') || assignedRoles.includes('management')
  const canMarketing = (permission: MarketingPermission) => isAdministrator || marketingPermissions.includes(permission)
  const canAccessSalesDesk = isAdministrator || assignedRoles.includes('sales') || assignedRoles.includes('sales_manager') || assignedRoles.includes('management')
  const canAccessReturns = isAdministrator || assignedRoles.includes('returns') || assignedRoles.includes('management')
  const canAccessStock = isAdministrator || assignedRoles.includes('stock') || assignedRoles.includes('management')
  const [reportingAccess, setReportingAccess] = useState({ admin: false, builder: false, catalogue: false, apps: 0 })
  const canAccessReporting = isAdministrator || assignedRoles.includes('reporting') || assignedRoles.includes('management') || assignedRoles.includes('report_builder') || reportingAccess.apps > 0
  const notificationChannels: NotificationChannel[] = [
    ...(canAccessMarketing ? ['marketing' as const] : []),
    ...(canAccessSalesDesk ? ['sales_desk' as const] : []),
    ...(canAccessReturns ? ['returns_claims' as const] : []),
    ...(canAccessStock ? ['stock_control' as const] : []),
    ...(canAccessReporting ? ['reporting' as const] : []),
  ]

  useEffect(() => {
    if (!supabaseConfigured || !supabase) return
    localStorage.removeItem(KEY_STORAGE)
    let mounted = true
    void supabase.auth.getSession().then(({ data }) => {
      if (mounted && !data.session) { sessionStorage.removeItem(KEY_STORAGE); setKey('') }
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return
      if (!session) { sessionStorage.removeItem(KEY_STORAGE); setKey('') }
    })
    return () => { mounted = false; listener.subscription.unsubscribe() }
  }, [])

  const patchEditor = (changes: Partial<Post>) => setEditor((e) => (e ? { ...e, ...changes } : e))

  async function loadProfile() {
    if (!supabase) return
    const user = (await supabase.auth.getUser()).data.user
    if (!user) { setProfileLoaded(true); return }
    const { data } = await supabase.from('profiles').select('first_name,surname,email,avatar_url,sales_code').eq('id', user.id).maybeSingle()
    const roles = await supabase.from('profile_roles').select('role_id').eq('profile_id', user.id)
    setIsAdministrator((roles.data || []).some((role: { role_id: string }) => role.role_id === 'administrator'))
    const roleIds = (roles.data || []).map((role: { role_id: string }) => role.role_id)
    setAssignedRoles(roleIds)
    const permissions = await supabase.rpc('my_marketing_permissions')
    setMarketingPermissions((permissions.data || []) as MarketingPermission[])
    const factors = await supabase.auth.mfa.listFactors()
    setMfaEnabled(Boolean(factors.data?.all?.some((factor) => factor.factor_type === 'totp' && factor.status === 'verified')))
    void supabase.rpc('bi_my_access').then(({ data }) => { if (data) setReportingAccess(data) })
    setProfile({ first_name: data?.first_name || user.user_metadata?.first_name || '', surname: data?.surname || user.user_metadata?.surname || '', email: user.email || data?.email || '', avatar_url: data?.avatar_url || '', sales_code: data?.sales_code || '' })
    setProfileLoaded(true)
  }

  async function saveProfile() {
    if (!supabase) return
    setProfileBusy(true); setError('')
    try {
      const user = (await supabase.auth.getUser()).data.user
      if (!user) throw new Error('Your session has expired. Sign in again.')
      const salesCode = profile.sales_code.trim().toUpperCase()
      const { error: updateError } = await supabase.from('profiles').update({ first_name: profile.first_name.trim(), surname: profile.surname.trim(), display_name: `${profile.first_name.trim()} ${profile.surname.trim()}`.trim(), avatar_url: profile.avatar_url || null, sales_code: salesCode || null }).eq('id', user.id)
      if (updateError) throw new Error(updateError.message)
      setNotice('Profile saved.')
    } catch (e) { handleError(e) } finally { setProfileBusy(false) }
  }

  async function uploadAvatar(file: File) {
    if (!supabase) return
    const user = (await supabase.auth.getUser()).data.user
    if (!user) return
    setProfileBusy(true); setError('')
    try {
      const path = `${user.id}/avatar-${Date.now()}-${file.name}`
      const { error: uploadError } = await supabase.storage.from('profile-avatars').upload(path, file, { upsert: false, contentType: file.type })
      if (uploadError) throw new Error(uploadError.message)
      const { data } = supabase.storage.from('profile-avatars').getPublicUrl(path)
      setProfile((current) => ({ ...current, avatar_url: data.publicUrl }))
      setNotice('Profile picture uploaded. Click Save profile to keep it.')
    } catch (e) { handleError(e) } finally { setProfileBusy(false) }
  }

  async function sendPasswordReset() {
    if (!supabase || !profile.email) return
    setProfileBusy(true); setError('')
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(profile.email, { redirectTo: window.location.origin })
      if (resetError) throw new Error(resetError.message)
      setNotice('A password reset link was sent to your email address.')
    } catch (e) { handleError(e) } finally { setProfileBusy(false) }
  }

  async function startMfaEnrollment() {
    if (!supabase) return
    setProfileBusy(true); setError('')
    try {
      const existing = await supabase.auth.mfa.listFactors()
      const current = existing.data?.all?.find((factor) => factor.factor_type === 'totp')
      if (current?.status === 'verified') { setMfaEnabled(true); setNotice('Authenticator-app MFA is already enabled for this account.'); return }
      if (current?.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: current.id })
      const { data, error: enrollError } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Impala Hub' })
      if (enrollError) throw new Error(enrollError.message)
      setMfaSetupFactorId(data.id); setMfaQr(data.totp?.qr_code || ''); setMfaSecret(data.totp?.secret || ''); setNotice('Scan the QR code with Google Authenticator, then enter the six-digit code.')
    } catch (e) { handleError(e) } finally { setProfileBusy(false) }
  }

  async function verifyMfaEnrollment() {
    if (!supabase || !mfaSetupFactorId) return
    setProfileBusy(true); setError('')
    try {
      const challenge = await supabase.auth.mfa.challenge({ factorId: mfaSetupFactorId })
      if (challenge.error) throw new Error(challenge.error.message)
      setMfaSetupChallengeId(challenge.data.id)
      const { error: verifyError } = await supabase.auth.mfa.verify({ factorId: mfaSetupFactorId, challengeId: challenge.data.id, code: mfaCode.trim() })
      if (verifyError) throw new Error(verifyError.message)
      setMfaCode(''); setMfaQr(''); setMfaSecret(''); setMfaSetupFactorId(''); setMfaSetupChallengeId(''); setMfaEnabled(true); setNotice('Authenticator-app MFA is enabled for your account.')
    } catch (e) { handleError(e) } finally { setProfileBusy(false) }
  }

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
    const sequence = ++postLoadSequence.current
    setPostsLoading(true)
    try {
      const canReadPosts = canMarketing('feed.view') || canMarketing('posts.view')
      const canReadCampaigns = canMarketing('campaigns.view')
      const canUseCampaignOptions = canReadPosts || canMarketing('feed.assign_campaign') || canMarketing('posts.assign_campaign') || canMarketing('campaigns.assign_campaign')
      const [p, c, counts, i, ct] = await Promise.all([
        canReadPosts && page === 'Feed' && supabase ? Promise.all(['facebook','instagram'].map(channel => postsService.list({ channel, limit: 25, preview: true }))).then(pages => ({ items: [...new globalThis.Map<string,Post>(pages.flatMap(p => p.items).map(p => [p.id,p] as [string,Post])).values()], total: pages.reduce((sum,p) => sum+p.items.length,0), summary: [] }))
          : canReadPosts && page === 'Posts' ? postsService.list({ month: (view === 'calendar' ? month ?? startOfMonth() : month) ? `${(month ?? startOfMonth()).getFullYear()}-${String((month ?? startOfMonth()).getMonth()+1).padStart(2,'0')}-01` : '', campaign: campaignFilter, search: debouncedSearch, status: view === 'list' ? filter : 'all', offset: postPage*POST_PAGE_SIZE, summary: view === 'pivot', preview: view === 'list' || view === 'board' }) : Promise.resolve({ items: [], total: 0, summary: [] }),
        canReadCampaigns ? campaignsService.list() : canUseCampaignOptions && supabase ? campaignsService.options() : Promise.resolve([]),
        canReadCampaigns && supabase ? campaignsService.postCounts() : Promise.resolve([]),
        integrationsService.list(), campaignsService.types(),
      ])
      if (sequence !== postLoadSequence.current) return
      const result = Array.isArray(p) ? { items: p, total: p.length, summary: [] } : p
      if (page === 'Posts' && postPage > 0 && postPage*POST_PAGE_SIZE >= result.total) { setPostPage(Math.max(0,Math.ceil(result.total/POST_PAGE_SIZE)-1)); return }
      setPosts(result.items); setPostTotal(result.total); setPostSummary(result.summary || []); setCampaigns(c as Campaign[]); setCampaignPostCounts(Object.fromEntries((counts as Array<{ campaign_id: string; post_count: number }>).map((row) => [row.campaign_id, row.post_count]))); setIntegrations(i); setCampaignTypes(ct.map((item: { name: string }) => item.name)); setError('')
    } catch (e) { if (sequence === postLoadSequence.current) handleError(e) } finally { if (sequence === postLoadSequence.current) setPostsLoading(false) }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => { setDebouncedSearch(search); setPostPage(0) }, 250)
    return () => window.clearTimeout(timer)
  }, [search])
  useEffect(() => {
    let live = true
    setSelectedPost(null)
    if (detailId) postsService.detail(detailId).then(post => { if(live) setSelectedPost(post) }).catch(error => { if(live) handleError(error) })
    return () => { live = false }
  }, [detailId, posts])
  useEffect(() => {
    if (!key) return
    void loadProfile()
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
      setPage('Marketing Accounts'); setNotice('Facebook authorized. Choose the Page you want Impala Hub to manage.'); void loadFacebookPages()
    } else if (fb === 'error') {
      setPage('Marketing Accounts'); setError(OAUTH_REASONS[reason] ?? `Facebook authorization did not finish (${reason.replaceAll('_', ' ')}).`)
    }
    if (ig === 'connected') {
      setPage('Marketing Accounts'); setNotice('Instagram connected.')
    } else if (ig === 'error') {
      setPage('Marketing Accounts'); setError(`Instagram authorization did not finish: ${reason.replaceAll('_', ' ')}.${detail ? ' Meta said: ' + detail : ''}`)
    }
  }, [key])

  useEffect(() => {
    if (key && canAccessMarketing) void load()
  }, [key, canAccessMarketing, marketingPermissions, page, view, month, campaignFilter, debouncedSearch, filter, postPage])

  useEffect(() => {
    const marketingPages = ['Feed', 'Posts', 'Post', 'Campaigns', 'Marketing Accounts', 'Roadmap']
    const salesPages = ['RFQs', 'RFQ Roadmap']
    const stockPages = ['Parts Query', 'Stock Booking', 'Stock Reordering', 'Stock Data Import', 'Stock Control Configuration', 'Stock Control Roadmap']
    const returnsPages = ['Returns & Claims', 'Returns & Claims Roadmap']
    const adminPages = ['Admin Settings', 'Configuration', 'Stock Data Import', 'Stock Control Configuration']
    if (profileLoaded && page === 'Configuration' && isAdministrator) { setPage('Admin Settings'); return }
    const marketingPageDenied = (page === 'Feed' && !canMarketing('feed.view'))
      || ((page === 'Posts' || page === 'Post') && !canMarketing('posts.view'))
      || (page === 'Campaigns' && !canMarketing('campaigns.view'))
      || (page === 'Marketing Accounts' && !canMarketing('feed.manage_accounts'))
    if ((profileLoaded && adminPages.includes(page) && !isAdministrator) || (marketingPages.includes(page) && (!canAccessMarketing || marketingPageDenied)) || (salesPages.includes(page) && !canAccessSalesDesk)
      || (stockPages.includes(page) && !canAccessStock) || (returnsPages.includes(page) && !canAccessReturns)) setPage('Apps')
  }, [page, profileLoaded, isAdministrator, canAccessMarketing, canAccessSalesDesk, canAccessStock, canAccessReturns, marketingPermissions])

  // Reload pending Page choices whenever Marketing settings opens, so a refresh does not lose the picker.
  useEffect(() => { if (key && ((page === 'Admin Settings' && isAdministrator) || (page === 'Marketing Accounts' && canMarketing('feed.manage_accounts')))) void loadFacebookPages() }, [key, page, isAdministrator, marketingPermissions])

  // Escape closes whichever dialog is open.
  useEffect(() => {
    if (!editor && !campaignModal && !imageViewer) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (imageViewer) setImageViewer(null)
      else if (campaignModal) setCampaignModal(false)
      else setEditor(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editor, campaignModal, imageViewer])

  async function signIn() {
    setError('')
    if (supabaseConfigured && supabase) {
      const { data, error: authError } = await supabase.auth.signInWithPassword({ email: username.trim(), password })
      if (authError) {
        setError(authError.message)
        return
      }
      if (!data.session) {
        setError('Supabase did not create a session. Confirm the user email before signing in.')
        return
      }
      const assurance = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (assurance.data?.currentLevel === 'aal1' && assurance.data?.nextLevel === 'aal2') {
        const factors = await supabase.auth.mfa.listFactors()
        const factor = factors.data?.all?.find((item) => item.factor_type === 'totp' && item.status === 'verified')
        if (!factor) { await supabase.auth.signOut(); setError('Your account requires MFA, but no verified authenticator factor is available. Contact an administrator.'); return }
        const challenge = await supabase.auth.mfa.challenge({ factorId: factor.id })
        if (challenge.error) { await supabase.auth.signOut(); setError(challenge.error.message); return }
        setMfaFactorId(factor.id); setMfaChallengeId(challenge.data.id); setNotice('Enter the six-digit code from Google Authenticator.'); return
      }
      sessionStorage.setItem(KEY_STORAGE, data.session.access_token)
      setKey(data.session.access_token)
      setPassword('')
      setPage('Apps')
      setNotice('Signed in with Supabase. Workspace data migration is the next step.')
      return
    }
    try {
      const response = await fetch(`${apiBaseUrl}/api/sales-desk/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.detail || 'Sign-in failed')
      sessionStorage.setItem(KEY_STORAGE, body.access_token)
      setKey(body.access_token); setPassword(''); setPage('Apps'); setNotice('Signed in successfully.')
    } catch (e) { setError((e as Error).message) }
  }

  async function verifyMfaLogin() {
    if (!supabase || !mfaFactorId || !mfaChallengeId) return
    setError('')
    const { error: verifyError } = await supabase.auth.mfa.verify({ factorId: mfaFactorId, challengeId: mfaChallengeId, code: mfaCode.trim() })
    if (verifyError) { setError(verifyError.message); return }
    const session = (await supabase.auth.getSession()).data.session
    if (session) sessionStorage.setItem(KEY_STORAGE, session.access_token)
    setMfaCode(''); setMfaFactorId(''); setMfaChallengeId(''); setPassword(''); setPage('Apps'); setNotice('Signed in with MFA.')
    setKey(session?.access_token || '')
  }

  function connectKey() {
    const trimmed = keyEntry.trim()
    if (!trimmed) return
    sessionStorage.setItem(KEY_STORAGE, trimmed)
    setKey(trimmed); setKeyEntry(''); setError(''); setNotice('API key set for this browser session.')
  }
  async function disconnectKey() {
    await authService.signOut()
    localStorage.removeItem(KEY_STORAGE)
    sessionStorage.removeItem(KEY_STORAGE)
    setKey(''); setKeyEntry(''); setPosts([]); setCampaigns([]); setIntegrations([]); setNotice('')
    window.location.reload()
  }

  // Filtering and totals come from the same database query, not this loaded page.
  const visiblePosts = posts
  const filteredPosts = posts
  const monthPosts = posts

  async function patchPost(id: string, changes: PostPatch, message: string) {
    try {
      await postsService.update(id, changes)
      setNotice(message); setError('')
      await load()
    } catch (e) { handleError(e) }
  }

  async function syncAll() {
    setBusy(true); setError('')
    try {
      const r = await integrationsService.sync()
      const fb = r.facebook?.status === 'error' ? `Facebook error: ${r.facebook.detail || 'unknown error'}` : r.facebook?.status === 'not_connected' ? 'Facebook not connected' : `Facebook synced (${r.facebook.items || 0} new, ${r.facebook.fetched || 0} checked${r.facebook.metricsUnavailable ? `; metrics unavailable for ${r.facebook.metricsUnavailable}${r.facebook.metricsErrors?.[0] ? `: ${r.facebook.metricsErrors[0]}` : ''}` : ''})`
      const ig = r.instagram?.status === 'synced' ? `Instagram synced (${r.instagram.items} items)` : r.instagram?.status === 'not_connected' ? 'Instagram not connected' : `Instagram error: ${r.instagram?.detail || 'unknown error'}`
      if (r.facebook?.syncedAt) setIntegrations(items => items.map(item => item.provider === 'facebook' ? { ...item, last_synced_at: r.facebook.syncedAt } : item))
      setNotice(`${fb}; ${ig}.${r.facebook?.mediaUnavailable ? ` ${r.facebook.mediaUnavailable} image previews could not be copied; temporary image URLs were not saved.` : ''}`)
      if (r.facebook?.audience != null) setIntegrations((items) => items.map((item) => item.provider === 'facebook' ? { ...item, followers_count: r.facebook.audience } : item))
      if (r.facebook?.status === 'synced') setMonth(null)
      await load()
    } catch (e) { handleError(e) } finally { setBusy(false) }
  }

  async function loadFacebookPages() {
    try {
      const result = await integrationsService.facebookPages()
      setFacebookPages(result.pages || [])
      if (result.connected_page_id) setSelectedFacebookPage(result.connected_page_id)
      else if (result.pages?.length) setSelectedFacebookPage(result.pages[0].id)
    } catch (e) { handleError(e) }
  }

  async function connectInstagram() {
    setBusy(true); setError('')
    try {
      const result = await integrationsService.connectInstagram()
      window.location.assign(result.url)
    } catch (e) { handleError(e); setBusy(false) }
  }

  async function checkInstagramConnection() {
    setBusy(true); setError('')
    try {
      const r = await integrationsService.checkInstagram()
      setNotice(`Instagram connection verified for ${r.username ? '@' + r.username : r.account_id}.`)
      await load()
    } catch (e) { handleError(e) } finally { setBusy(false) }
  }

  async function disconnectInstagram() {
    if (!window.confirm('Disconnect the Instagram account saved through Connect Instagram?')) return
    setBusy(true); setError('')
    try {
      const r = await integrationsService.disconnectInstagram()
      setNotice(`Instagram disconnected. ${r.posts_removed || 0} post(s) removed from the feed.`)
      await load()
    } catch (e) { handleError(e) } finally { setBusy(false) }
  }

  async function connectFacebook() {
    setBusy(true); setError('')
    try {
      const result = await integrationsService.connectFacebook()
      window.location.assign(result.url)
    } catch (e) { handleError(e); setBusy(false) }
  }

  async function chooseFacebookPage() {
    if (!selectedFacebookPage) return
    setBusy(true); setError('')
    try {
      const result = await integrationsService.selectFacebookPage(selectedFacebookPage)
      setNotice('Connected Facebook Page: ' + result.page_name)
      setIntegrations((items) => items.map((item) => item.provider === 'facebook' ? { ...item, status: 'connected', account_name: result.page_name, page_name: result.page_name, page_id: result.page_id, diagnostic_note: 'Facebook Page connection saved.' } : item))
      setFacebookPages([])
      await load()
    } catch (e) { handleError(e) } finally { setBusy(false) }
  }

  async function disconnectFacebook() {
    if (!window.confirm('Disconnect the Facebook Page saved through Connect Facebook?')) return
    setBusy(true); setError('')
    try {
      await integrationsService.disconnectFacebook()
      setNotice('Saved Facebook connection removed. To also revoke Impala Hub at Meta, remove the app under Facebook Settings > Business Integrations.')
      setFacebookPages([])
      await load()
    } catch (e) { handleError(e) } finally { setBusy(false) }
  }

  async function checkFacebookConnection() {
    setBusy(true); setError('')
    try {
      const r = await integrationsService.checkFacebook()
      setNotice(`Facebook connection verified for ${r.page_name || r.page_id}.`)
      await load()
    } catch (e) { handleError(e) } finally { setBusy(false) }
  }

  async function savePost(mode: 'draft' | 'schedule' | 'publish-now') {
    if (!editor) return
    const permission = `${page === 'Feed' ? 'feed' : 'posts'}.${editor.id ? 'edit' : 'create'}` as MarketingPermission
    if (!canMarketing(permission)) { setError('You do not have permission to save this post.'); return }
    setBusy(true); setError('')
    try {
      const status = mode === 'schedule' ? 'scheduled' as const : 'draft' as const
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
      if (editor.id) saved = await postsService.update(editor.id, payload)
      else saved = await postsService.create(payload)
      const facebookLive = integrations.some((i) => i.provider === 'facebook' && i.status === 'connected')
      if (mode === 'publish-now') {
        if (!facebookLive) throw new Error('Connect Facebook in Settings before publishing.')
        await postsService.publish(saved.id)
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
        uploaded.push(await postsService.upload(file))
      }
      // Functional update: keeps anything typed while the upload was running.
      setEditor((e) => (e ? { ...e, media: [...(e.media || []), ...uploaded] } : e))
    } catch (e) { handleError(e) } finally { setBusy(false) }
  }

  async function createCampaign() {
    if (!(editingCampaignId ? canMarketing('campaigns.edit') : canMarketing('campaigns.create'))) { setError('You do not have permission to save this campaign.'); return }
    if (!campaignName.trim()) return
    try {
      const payload = { name: campaignName, objective: campaignObjective, stage: campaignStage, campaign_type: campaignType }
      await (editingCampaignId ? campaignsService.update(editingCampaignId, payload) : campaignsService.create(payload))
      setCampaignName(''); setCampaignObjective(''); setEditingCampaignId(null); setCampaignModal(false); setNotice(editingCampaignId ? 'Campaign updated.' : 'Campaign created.')
      await load()
    } catch (e) { handleError(e) }
  }
  async function moveCampaign(campaignId: string, stage: 'new' | 'in_progress' | 'done') {
    if (!canMarketing('campaigns.change_status')) { setError('You do not have permission to change campaign status.'); return }
    try {
      await campaignsService.update(campaignId, { stage })
      setNotice('Campaign moved.')
      await load()
    } catch (e) { handleError(e) }
  }

  function openCampaignEditor(c: Campaign) {
    setEditingCampaignId(c.id); setCampaignName(c.name); setCampaignObjective(c.objective || ''); setCampaignStage(c.stage || 'new'); setCampaignType(c.campaign_type || campaignTypes[0] || 'Tips'); setCampaignModal(true)
  }
  async function removeCampaign(c: Campaign) {
    if (!canMarketing('campaigns.delete')) { setError('You do not have permission to delete campaigns.'); return }
    if ((campaignPostCounts[c.id] || 0) > 0) { setError('Campaigns can only be deleted when they contain no posts.'); return }
    if (!window.confirm(`Delete campaign "${c.name}"?`)) return
    try {
      await campaignsService.remove(c.id)
      setNotice('Campaign deleted.')
      await load()
    } catch (e) { handleError(e) }
  }

  async function removePost(id: string) {
    const allowed = page === 'Feed' ? canMarketing('feed.delete') : canMarketing('posts.delete')
    if (!allowed) { setError('You do not have permission to delete this post.'); return }
    if (!confirm('Delete this post?')) return
    try {
      await postsService.remove(id)
      if (detailId === id) { setDetailId(null); setPage('Posts') }
      await load(); setNotice('Post deleted.')
    } catch (e) { handleError(e) }
  }

  function openPost(id: string) { setDetailId(id); setError(''); if (page !== 'Feed') setPage('Post') }

  // Failed posts reopen with their existing content and a safe near-future time.
  function reschedulePost(p: Post) {
    const allowed = page === 'Feed' ? canMarketing('feed.edit') : canMarketing('posts.edit')
    if (!allowed) { setError('You do not have permission to reschedule this post.'); return }
    const when = new Date(Date.now() + 15 * 60 * 1000)
    setEditor({ ...p, status: 'draft', publish_at: toLocalInput(when.toISOString()) })
    setDetailId(null)
    if (page !== 'Feed') setPage('Posts')
    setError('')
    setNotice('Review the post and scheduled time, then confirm Schedule post.')
  }

  // Scheduled and published posts cannot be edited, so they open the detail view instead.
  async function openEditor(p: Post) {
    const allowed = page === 'Feed' ? canMarketing('feed.edit') : canMarketing('posts.edit')
    if (!allowed) { setError('You do not have permission to edit this post.'); return }
    if (EDITABLE.includes(p.status)) {
      try { const full = await postsService.detail(p.id); setEditor(full); setError('') } catch(e) { handleError(e) }
    } else openPost(p.id)
  }

  async function saveCampaign(postId: string, campaignId: string | null) {
    const allowed = page === 'Feed' ? canMarketing('feed.assign_campaign') : canMarketing('posts.assign_campaign')
    if (!allowed) { setError('You do not have permission to assign this post to a campaign.'); return }
    try {
      await postsService.update(postId, { campaign_id: campaignId })
      setNotice('Campaign updated.'); setError(''); if (detailId === postId) setSelectedPost(await postsService.detail(postId))
      await load()
    } catch (e) { handleError(e) }
  }

  useEffect(() => {
    const locked = page === 'Feed' && Boolean(detailId)
    if (!locked) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [page, detailId])

  const selected = selectedPost
  const lastMarketingUpdate = integrations.find(item => item.provider === 'facebook')?.last_synced_at
  const marketingRefresh = <div className="marketing-refresh"><button className="secondary" disabled={busy} onClick={() => void syncAll()}>Refresh</button><span className="marketing-last-update" title="Last successful Facebook refresh, in Johannesburg time">Last update: {lastMarketingUpdate ? <time dateTime={lastMarketingUpdate}>{new Intl.DateTimeFormat('en-ZA', { timeZone: 'Africa/Johannesburg', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(lastMarketingUpdate))} SAST</time> : 'Not recorded yet'}</span></div>
  const channels = editor?.channels || []
  const canSchedule = isFuture(editor?.publish_at)

  function openNotificationTarget(notification: UserNotification) {
    setError('')
    setNotice('')
    if (notification.channel === 'sales_desk' && canAccessSalesDesk) {
      setNotificationRfqId(notification.target_record_id)
      setPage('RFQs')
      return
    }
    if (notification.channel === 'marketing' && canAccessMarketing) {
      if (notification.target_record_id) setDetailId(notification.target_record_id)
      setPage(notification.target_page === 'Post' && notification.target_record_id ? 'Post' : notification.target_page || 'Feed')
      return
    }
    if (notification.channel === 'returns_claims' && canAccessReturns) {
      setPage('Returns & Claims')
      return
    }
    if (notification.channel === 'stock_control' && canAccessStock) {
      setPage(notification.target_page || 'Stock Booking')
      return
    }
    if (notification.channel === 'reporting' && canAccessReporting) {
      const meta = notification.metadata || {}
      if (typeof meta.app_id === 'string') {
        const detail = { app: meta.app_id, sheet: typeof meta.sheet_id === 'string' ? meta.sheet_id : null, object: typeof meta.object_id === 'string' ? meta.object_id : null }
        try { sessionStorage.setItem('bi-open-app', detail.app); if (detail.sheet) sessionStorage.setItem('bi-open-sheet', detail.sheet); if (detail.object) sessionStorage.setItem('bi-open-object', detail.object) } catch { /* storage unavailable */ }
        window.dispatchEvent(new CustomEvent('bi-open', { detail }))
      }
      setPage(notification.target_page || 'Dashboards')
      return
    }
    if (notification.channel === 'system') {
      setPage(notification.target_page || 'Apps')
      return
    }
    setPage('Apps')
    setError('You do not have access to the application linked to this notification.')
  }
  const RETURNS_ROADMAP_ROWS = [['Record workflow','Editable side-panel records','Create, update and delete claims with RC date/sequence references','Implemented'],['Customer and invoice search','Record investigation','Substring search across claim fields, including customer and invoice','Implemented'],['Outcome handling','Unknown until decided','Validated status transitions, rejection/reopen reasons and receipt checks','Implemented'],['Attachments','Evidence files','New-tab images, PDF previews, downloads and audited permanent deletion','Implemented'],['Supplier outcomes','Credit and replacement tracking','Supplier response, dated credit/replacement receipts and pickup/drop-off tracking','Implemented'],['Ageing and SLA','Claim ageing reports','7-day calendar SLA, 2-day warning, date-range/overdue filters and closure age','Implemented'],['Exports and audit','Traceable reporting','Filtered CSV/XLSX reports, summary breakdowns and named audit history','Implemented'],['Wildcard syntax','Advanced search','Literal substring search exists; * and ? pattern semantics are not implemented','Planned'],['Hosted verification','Production readiness','Signed URL, preview, concurrency and role smoke tests','Planned']]
const STOCK_ROADMAP_ROWS = [['Parts Query','Multi-supplier records','Supabase CRUD, atomic supplier replacement, archival and named history','Implemented'],['Supplier comparison','Cost and MSRP','Cheapest unit-cost comparison','Implemented'],['Sales-code mapping','Sales ownership','Active Sales Desk codes','Implemented'],['Stock Booking','Branch stock transfers','Active Supabase snapshot, persisted transfers and Evolve export','Implemented'],['Stock Reordering','Inventory planning','Active Supabase snapshot, shared mover rules, supply metrics and filters','Implemented'],['Shared configuration','Locations, thresholds and statuses','Supabase-backed settings with audited administrator controls','Implemented'],['Versioned imports','Safe snapshot replacement','Chunked staging, validation, audit and transactional activation','Implemented'],['Supply calculation','Inventory rules','Max - QOH - On Picking Slip with ER/PT sorting','Implemented'],['Picking-list export','Evolve transfer format','Franchise, locations, bins, quantity, comments and timestamped filename','Implemented'],['CSV/XLSX import','Administrator upload','Mapping, preview validation, hashing, staging and activation','Implemented'],['Google Sheets ingestion','Private inventory feed','Removed from the deployed application; database history retained but disabled','Retired'],['Qlik/ODBC adapter','ERP inventory feed','Real external stock data is intentionally postponed','Deferred'],['Historical SQLite reconciliation','Legacy data','Reconcile legacy records only when production data work resumes','Deferred'],['Supplier response workflow','Quote lifecycle','Track quote requests and responses','Planned'],['Approval workflow','Quote approval','Approve supplier selections','Planned'],['Supplier history','Supplier intelligence','Reuse supplier performance and pricing history','Planned'],['Reorder recommendations','Inventory action','Turn approved queries into stock actions','Planned'],['Search','Parts and suppliers','Substring search across parts, descriptions, suppliers, alternatives and sales codes','Implemented']]

const isSalesDeskPage = page === 'RFQs' || page === 'RFQ Roadmap'
  const isStockControlPage = page === 'Parts Query' || page === 'Stock Booking' || page === 'Stock Reordering' || page === 'Stock Data Import' || page === 'Stock Control Configuration' || page === 'Stock Control Roadmap'
  const isReturnsClaimsPage = page === 'Returns & Claims' || page === 'Returns & Claims Roadmap'
  const isReportingPage = (REPORTING_PAGES as readonly string[]).includes(page)
  const isAdminSettingsPage = page === 'Admin Settings'
  const isChannelsPage = page === 'Channels'
  const isPlatformPage = page === 'Apps' || page === 'Account' || isAdminSettingsPage || isChannelsPage

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">I</div>
          <div><b>IMPALA HUB</b>{!isPlatformPage && <small>{isSalesDeskPage ? 'Sales Desk workspace' : isStockControlPage ? 'Smart Stock Control workspace' : isReturnsClaimsPage ? 'Returns & Claims workspace' : isReportingPage ? 'Reporting workspace' : 'Marketing workspace'}</small>}</div>
        </div>
        <button className={`nav-item app-home-link ${page === 'Apps' ? 'active' : ''}`} onClick={() => setPage('Apps')}><LayoutDashboard size={18} /> Apps Dashboard</button>
        {isPlatformPage && (
          <div className="sidebar-bottom">
            {key && <div className="communication-buttons"><button className="communication-button" aria-label="Open chat" title="Chat" onClick={() => setChatOpenRequest((value) => value + 1)}><MessageCircle size={17} /></button><NotificationCentre enabled channels={notificationChannels} onNavigate={openNotificationTarget} onError={setError} />{isAdministrator && <button className="communication-button" aria-label="Open settings" title="Settings" onClick={() => setPage('Admin Settings')}><Settings size={17} /></button>}</div>}
            <div className="connection-dot" /> <span>Local workspace</span>
          <button className="account-link" onClick={() => { setPage('Account'); void loadProfile() }}><span className="account-full">{profile.sales_code ? `${profile.sales_code} - ` : ''}{profile.first_name || profile.email || 'My account'}{integrations.some((i) => i.status === 'connected') ? ' · Connected' : ''}</span><span className="account-mobile">{profile.sales_code || profile.first_name || 'Account'}</span></button>
            {key && <button className="text-button" onClick={() => { void disconnectKey() }}>Log out</button>}
          </div>
        )}
        {!isPlatformPage && (
          <>
            <div className="nav-label">WORKSPACE</div>
            {(isSalesDeskPage
              ? ([['RFQs', ClipboardList], ['RFQ Roadmap', Map]] as const)
              : isStockControlPage
              ? ([['Stock Booking', PackageCheck], ['Stock Reordering', PackageCheck], ['Parts Query', ClipboardList], ...(isAdministrator ? [['Stock Data Import', Upload] as const, ['Stock Control Configuration', Settings] as const] : []), ['Stock Control Roadmap', Map]] as const)
                : isReturnsClaimsPage
                  ? ([['Returns & Claims', ClipboardList], ['Returns & Claims Roadmap', Map]] as const)
                : isReportingPage
                  ? ([['Dashboards', LayoutDashboard], ...(isAdministrator || reportingAccess.catalogue ? [['Data', Database] as const, ['Data Model', Network] as const] : []), ...(isAdministrator ? [['Data Connections', CloudDownload] as const, ['Data Loads', ServerCog] as const, ['Run History', History] as const, ['Audit Log', ShieldCheck] as const] : []), ...(isAdministrator || reportingAccess.catalogue || reportingAccess.builder ? [['Data Quality', Gauge] as const] : []), ...(isAdministrator || reportingAccess.builder ? [['Usage', Users] as const, ['Master Items', BookMarked] as const] : []), ['Function Reference', BookOpen], ['Reporting Roadmap', Map]] as const)
                : ([
                    ...(canMarketing('feed.view') ? [['Feed', LayoutDashboard] as const] : []),
                    ...(canMarketing('posts.view') ? [['Posts', ClipboardList] as const] : []),
                    ...(canMarketing('campaigns.view') ? [['Campaigns', Megaphone] as const] : []),
                    ['Roadmap', Map] as const,
                  ] as const)
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
              {key && <div className="communication-buttons"><button className="communication-button" aria-label="Open chat" title="Chat" onClick={() => setChatOpenRequest((value) => value + 1)}><MessageCircle size={17} /></button><NotificationCentre enabled channels={notificationChannels} onNavigate={openNotificationTarget} onError={setError} />{isAdministrator && <button className="communication-button" aria-label="Open settings" title="Settings" onClick={() => setPage('Admin Settings')}><Settings size={17} /></button>}</div>}
              <div className="connection-dot" /> <span>Local workspace</span>
              <button className="account-link" onClick={() => { setPage('Account'); void loadProfile() }}><span className="account-full">{profile.sales_code ? `${profile.sales_code} - ` : ''}{profile.first_name || profile.email || 'My account'}{integrations.some((i) => i.status === 'connected') ? ' · Connected' : ''}</span><span className="account-mobile">{profile.sales_code || profile.first_name || 'Account'}</span></button>
              {key && <button className="text-button" onClick={() => { void disconnectKey() }}>Log out</button>}
            </div>
          </>
        )}
      </aside>

      <main className="main">
        <header className="topbar">
          <div><div className="eyebrow">{page === 'Account' || isAdminSettingsPage ? 'IMPALA HUB' : `IMPALA SPARES / ${page === 'Apps' ? 'BUSINESS PLATFORM' : isSalesDeskPage ? 'SALES DESK' : isStockControlPage ? 'SMART STOCK CONTROL' : isReturnsClaimsPage ? 'RETURNS & CLAIMS' : isReportingPage ? 'REPORTING' : 'MARKETING'}`}</div><h1>{page === 'Post' ? 'Post details' : page === 'Apps' ? 'Apps Dashboard' : isAdminSettingsPage ? 'Settings' : isStockControlPage ? 'Smart Stock Control' : isReturnsClaimsPage ? 'Returns & Claims' : isReportingPage ? 'Reporting' : page}</h1>{isAdminSettingsPage && <p className="topbar-subtitle">Manage application access and shared configuration.</p>}{isSalesDeskPage && <p className="topbar-subtitle">Review incoming enquiries, claim RFQs, and track sales follow-ups.</p>}{page === 'Stock Booking' && <p className="topbar-subtitle">Compare branch stock and prepare Evolve location transfers.</p>}{page === 'Parts Query' && <p className="topbar-subtitle">Manage parts queries and supplier quotes.</p>}</div>
          {!isSalesDeskPage && !isStockControlPage && !isReturnsClaimsPage && !isReportingPage && !isAdminSettingsPage && page !== 'Apps' && page !== 'Account' && page !== 'Marketing Accounts' && page !== 'Campaigns' && page !== 'Roadmap' && ((page === 'Feed' && canMarketing('feed.create')) || ((page === 'Posts' || page === 'Post') && canMarketing('posts.create'))) && <button className="primary" onClick={() => { setEditor(emptyPost()); setError('') }}>
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
            {!isAdminSettingsPage && isAdministrator && <button className="secondary" onClick={() => setPage('Admin Settings')}>Go to Settings</button>}
          </div>
        ))}

        {!key && (
          <section className="key-panel">
            <h2>Sign in to Impala Hub</h2>
            <p>Use your employee account to open the App Dashboard. Sessions persist securely across refreshes until they expire or you log out.</p>
            {mfaChallengeId ? <div className="mfa-form"><p className="hint">Enter the six-digit code from Google Authenticator to finish signing in.</p><input inputMode="numeric" autoFocus aria-label="MFA verification code" placeholder="Verification code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void verifyMfaLogin() }} /><button className="primary" disabled={!mfaCode.trim()} onClick={() => void verifyMfaLogin()}>Verify code</button></div> : <div className="inline-form">
              <input aria-label="Email" type={supabaseConfigured ? 'email' : 'text'} placeholder={supabaseConfigured ? 'Email address' : 'Username'} value={username} onChange={(e) => setUsername(e.target.value)} />
              <input type="password" aria-label="Password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void signIn() }} />
              <button className="primary" onClick={() => void signIn()}>Sign in</button>
              {supabaseConfigured && <p className="hint">Authentication is provided by Supabase. Marketing and Sales Desk data migration is still in progress.</p>}
            </div>}
          </section>
        )}

        {page === 'Account' && key && (
          <section className="account-page">
            <div className="section-head"><div><span className="eyebrow">YOUR ACCOUNT</span><h2>Profile and security</h2><p>Manage your personal details and sign-in security.</p></div></div>
            <div className="account-card">
              <div className="avatar-panel">
                {profile.avatar_url ? <img src={profile.avatar_url} alt="Profile" className="profile-avatar" /> : <div className="profile-avatar profile-avatar-empty">{(profile.first_name || profile.email || '?').slice(0, 1).toUpperCase()}</div>}
                <label className="secondary avatar-upload">Change picture<input type="file" accept="image/png,image/jpeg,image/webp" disabled={profileBusy} onChange={(e) => { const file = e.target.files?.[0]; if (file) void uploadAvatar(file); e.target.value = '' }} /></label>
              </div>
              <div className="account-fields">
                <label>First name<input value={profile.first_name} onChange={(e) => setProfile({ ...profile, first_name: e.target.value })} /></label>
                <label>Surname<input value={profile.surname} onChange={(e) => setProfile({ ...profile, surname: e.target.value })} /></label>
              <label>Sales code<input value={profile.sales_code} placeholder="e.g. BB01" onChange={(e) => setProfile({ ...profile, sales_code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} /></label>
                <label>Email address<input value={profile.email} disabled /></label>
                <div className="password-reset"><div><b>Password</b><p>Your password is changed through a secure email link.</p></div><button className="secondary" disabled={profileBusy} onClick={() => void sendPasswordReset()}>Send reset link</button></div>
                <div className="mfa-settings"><div><b>Authenticator-app two-factor authentication</b><p>{mfaEnabled ? 'Enabled. Login requires a six-digit Google Authenticator code.' : 'Scan the QR code with Google Authenticator, then enter its six-digit code.'}</p></div>{mfaSetupFactorId ? <div className="mfa-enrolment"><img className="mfa-qr" alt="Authenticator setup QR code" src={qrImageSource(mfaQr)} /><small>Manual setup key: <code>{mfaSecret}</code></small><div className="mfa-inline"><input inputMode="numeric" aria-label="Authenticator verification code" placeholder="Six-digit code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} /><button className="secondary" disabled={profileBusy || !mfaCode.trim()} onClick={() => void verifyMfaEnrollment()}>Enable MFA</button></div></div> : <button className="secondary" disabled={profileBusy || mfaEnabled} onClick={() => void startMfaEnrollment()}>{mfaEnabled ? 'MFA enabled' : 'Set up MFA'}</button>}</div>
                <div className="account-actions"><button className="primary" disabled={profileBusy} onClick={() => void saveProfile()}>Save profile</button></div>
              </div>
            </div>
          </section>
        )}

        {page === 'Apps' && key && (
          <section className="apps-dashboard">
            <div className="apps-intro">
              <span className="eyebrow">YOUR WORKSPACE</span>
              <h2>Welcome to Impala Hub</h2>
              <p>Choose an application to get started. More tools will appear here as they become available.</p>
            </div>
            <div className="apps-section-heading"><div><h2>Your apps</h2><p>One home for Impala's business workflows.</p></div><span>{[canAccessMarketing, canAccessSalesDesk, canAccessReturns, canAccessStock, canAccessReporting].filter(Boolean).length} available</span></div>
            <div className="app-cards">
              {canAccessMarketing && <button className="app-card app-card-available" onClick={() => { setPage(canMarketing('feed.view') ? 'Feed' : canMarketing('posts.view') ? 'Posts' : canMarketing('campaigns.view') ? 'Campaigns' : 'Roadmap'); setFilter('all'); setCampaignFilter('all'); setMonth(startOfMonth()) }}>
                <div className="app-card-icon"><Megaphone size={25} /></div>
                <div className="app-card-copy"><h3>Marketing</h3><p>Plan campaigns, organise content, and manage social publishing.</p></div>
                <div className="app-card-footer"><span className="app-status-dot" /> Available <span className="app-card-open">Open app <span aria-hidden="true">→</span></span></div>
              </button>}
              {canAccessSalesDesk && <button className="app-card app-card-available" onClick={() => { setPage('RFQs'); setError(''); setNotice('') }}>
                <div className="app-card-icon"><ClipboardList size={25} /></div>
                <div className="app-card-copy"><h3>Sales Desk</h3><p>Customer enquiries, RFQs, and sales follow-ups.</p></div>
                <div className="app-card-footer"><span className="app-status-dot" /> Available <span className="app-card-open">Open app <span aria-hidden="true">→</span></span></div>
              </button>}
              {[
                { title: 'Fleet Management', description: 'Fleet visibility and vehicle activity.' },
                { title: 'E-commerce', description: 'Shopify orders, catalogue, and integration health.' },
              ].map((item) => (
                <div className="app-card app-card-disabled" key={item.title} aria-disabled="true">
                  <div className="app-card-icon"><ClipboardList size={25} /></div>
                  <div className="app-card-copy"><h3>{item.title}</h3><p>{item.description}</p></div>
                  <div className="app-card-footer"><span className="app-status-dot app-status-planned" /> Planned <span className="app-card-lock">Coming later</span></div>
                </div>
              ))}
              {canAccessReturns && <button className="app-card app-card-available" onClick={() => { setPage('Returns & Claims'); setError(''); setNotice('') }}>
                <div className="app-card-icon"><ClipboardList size={25} /></div>
                <div className="app-card-copy"><h3>Returns &amp; Claims</h3><p>Track returns, damage claims, and supplier outcomes.</p></div>
                <div className="app-card-footer"><span className="app-status-dot" /> Available <span className="app-card-open">Open app <span aria-hidden="true">→</span></span></div>
              </button>}
              {canAccessStock && <button className="app-card app-card-available" onClick={() => { setPage('Stock Booking'); setError(''); setNotice('') }}>
                <div className="app-card-icon"><ClipboardList size={25} /></div>
                <div className="app-card-copy"><h3>Smart Stock Control</h3><p>Compare stock, book branch transfers, and manage Parts Queries.</p></div>
                <div className="app-card-footer"><span className="app-status-dot" /> Available <span className="app-card-open">Open app <span aria-hidden="true">→</span></span></div>
              </button>}
              {canAccessReporting && <button className="app-card app-card-available" onClick={() => { setPage('Dashboards'); setError(''); setNotice('') }}>
                <div className="app-card-icon"><BarChart3 size={25} /></div>
                <div className="app-card-copy"><h3>Reporting</h3><p>ERP data, reports and dashboards, replacing Qlik Sense.</p></div>
                <div className="app-card-footer"><span className="app-status-dot" /> Available <span className="app-card-open">Open app <span aria-hidden="true">→</span></span></div>
              </button>}
            </div>
          </section>
        )}

        {page === 'Channels' && key && <ChannelsWorkspace setNotice={setNotice} setError={setError} />}

        {key && isAdminSettingsPage && isAdministrator && (
          <AdminSettings
            salesDeskConfiguration={<SalesDesk page="App Settings" embedded token={key} setNotice={setNotice} setError={setError} />}
            integrations={integrations}
            facebookPages={facebookPages}
            selectedFacebookPage={selectedFacebookPage}
            setSelectedFacebookPage={setSelectedFacebookPage}
            busy={busy}
            connectFacebook={connectFacebook}
            chooseFacebookPage={chooseFacebookPage}
            checkFacebookConnection={checkFacebookConnection}
            disconnectFacebook={disconnectFacebook}
            connectInstagram={connectInstagram}
            checkInstagramConnection={checkInstagramConnection}
            disconnectInstagram={disconnectInstagram}
            campaignTypes={campaignTypes}
            addCampaignType={async (name) => {
              try { await campaignsService.addType(name); await load(); setNotice('Campaign type added.'); return true }
              catch (e) { handleError(e); return false }
            }}
            deleteCampaignType={async (name) => {
              try { await campaignsService.removeType(name); await load(); setNotice('Campaign type removed.'); return true }
              catch (e) { handleError(e); return false }
            }}
            reorderCampaignTypes={async (names) => {
              try { await campaignsService.reorderTypes(names); await load(); setNotice('Campaign types reordered.'); return true }
              catch (e) { handleError(e); return false }
            }}
            setNotice={setNotice}
            setError={setError}
          />
        )}

        {key && isReportingPage && (canAccessReporting ? <Reporting page={page} isAdministrator={isAdministrator} canBuild={isAdministrator || reportingAccess.builder} setNotice={setNotice} setError={setError} /> : <section className="rfq-workspace"><div className="rfq-empty-card"><h3>No access to Reporting</h3><p>Ask an administrator for the Reporting role.</p></div></section>)}

        {isSalesDeskPage && page === 'RFQ Roadmap' ? (
          <section className="roadmap-page">
            <div className="section-head">
              <div><h2>RFQ capability workspace</h2><p>Current Sales Desk coverage, known gaps, and improvement priorities.</p></div>
            </div>
            <div className="roadmap-priorities"><strong>Next priorities</strong><span>RFQ approval review queue</span><span>Expand notifications to assignment, overdue work and SLA reminders</span><span>Bulk actions and exports</span><span>Granular server-side permissions</span></div>
            <div className="roadmap-filter-bar"><label>Show status<select value={roadmapFilter} onChange={(event) => setRoadmapFilter(event.target.value)}><option value="all">All statuses</option><option>Implemented</option><option>Partial</option><option>Planned</option><option>Deferred</option><option>Missing</option><option>Retired</option></select></label></div>
            <div className="roadmap-table-wrap"><table className="roadmap-table"><thead><tr><th>Capability</th><th>Reference</th><th>Impala Hub</th><th>Status</th></tr></thead><tbody>
              {SALES_ROADMAP_ROWS.filter(([, , , status]) => roadmapFilter === 'all' || roadmapBucket(status) === roadmapFilter).map(([capability, reference, impala, status]) => <tr key={capability}><td>{capability}</td><td>{reference}</td><td>{impala}</td><td><span className={'roadmap-status ' + (roadmapBucket(status) === 'Implemented' ? 'complete' : roadmapBucket(status) === 'Missing' ? 'missing' : 'partial')}>{status}</span></td></tr>)}
            </tbody></table></div>
          </section>
        ) : page === 'Returns & Claims Roadmap' || page === 'Stock Control Roadmap' ? (
          <section className="roadmap-page">
            <div className="section-head"><div><h2>{page === 'Returns & Claims Roadmap' ? 'Returns & Claims roadmap' : 'Smart Stock Control roadmap'}</h2><p>Current workspace coverage, known gaps, and implementation priorities.</p></div></div>
            <div className="roadmap-priorities">{page === 'Returns & Claims Roadmap' ? <><strong>Next priorities</strong><span>Hosted attachment and role smoke tests</span><span>True wildcard-pattern search</span><span>Production workflow verification</span></> : <><strong>Next priorities</strong><span>Verify manual imports and transfers in production</span><span>Supplier response workflow</span><span>Approval workflow</span><span>Supplier history and recommendations</span></>}</div>
            <div className="roadmap-filter-bar"><label>Show status<select value={roadmapFilter} onChange={(event) => setRoadmapFilter(event.target.value)}><option value="all">All statuses</option><option>Implemented</option><option>Partial</option><option>Planned</option><option>Deferred</option><option>Missing</option><option>Retired</option></select></label></div>
            <div className="roadmap-table-wrap"><table className="roadmap-table"><thead><tr><th>Capability</th><th>Reference</th><th>Impala Hub</th><th>Status</th></tr></thead><tbody>
              {(page === 'Returns & Claims Roadmap' ? RETURNS_ROADMAP_ROWS : STOCK_ROADMAP_ROWS).filter(([, , , status]) => roadmapFilter === 'all' || roadmapBucket(status) === roadmapFilter).map(([capability, reference, impala, status]) => <tr key={capability}><td>{capability}</td><td>{reference}</td><td>{impala}</td><td><span className={'roadmap-status ' + (roadmapBucket(status) === 'Implemented' ? 'complete' : roadmapBucket(status) === 'Missing' ? 'missing' : 'partial')}>{status}</span></td></tr>)}
            </tbody></table></div>
          </section>
        ) : isReturnsClaimsPage && page === 'Returns & Claims' ? <ReturnsClaims token={key} setNotice={setNotice} setError={setError} /> : isStockControlPage && page === 'Stock Booking' ? <StockBooking token={key} setNotice={setNotice} setError={setError} /> : isStockControlPage && page === 'Stock Reordering' ? <StockReordering token={key} setNotice={setNotice} setError={setError} /> : isStockControlPage && page === 'Stock Data Import' ? <StockImport token={key} setNotice={setNotice} setError={setError} /> : isStockControlPage && page === 'Stock Control Configuration' ? <StockControlConfig token={key} setNotice={setNotice} setError={setError} /> : isStockControlPage && page === 'Parts Query' ? <PartsQueries token={key} setNotice={setNotice} setError={setError} /> : isSalesDeskPage ? <SalesDesk page={page} token={key} setNotice={setNotice} setError={setError} openRfqId={notificationRfqId} onOpenRfqHandled={() => setNotificationRfqId(null)} /> : null}

        {key && page === 'Roadmap' && (
          <section className="roadmap-page">
            <div className="section-head">
              <div><h2>Odoo parity workspace</h2><p>Current feature coverage, gaps, and next implementation priorities.</p></div>
            </div>
            <div className="roadmap-priorities">
              <strong>Next priorities</strong>
              <span>Saved filters and bulk post actions</span><span>Notifications and social conversations</span><span>Sentiment analysis and reporting</span><span>Instagram integration remains deferred</span>
            </div>
            <div className="roadmap-filter-bar"><label>Show status<select value={roadmapFilter} onChange={(event) => setRoadmapFilter(event.target.value)}><option value="all">All statuses</option><option>Implemented</option><option>Partial</option><option>Planned</option><option>Deferred</option><option>Missing</option><option>Retired</option></select></label></div>
            <div className="roadmap-table-wrap"><table className="roadmap-table"><thead><tr><th>Capability</th><th>Odoo</th><th>Impala Hub</th><th>Status</th></tr></thead><tbody>
              {ROADMAP_ROWS.filter(([, , , status]) => roadmapFilter === 'all' || roadmapBucket(status) === roadmapFilter).map(([capability, odoo, impala, status]) => <tr key={capability}><td>{capability}</td><td>{odoo}</td><td>{impala}</td><td><span className={'roadmap-status ' + (roadmapBucket(status) === 'Implemented' ? 'complete' : roadmapBucket(status) === 'Missing' ? 'missing' : 'partial')}>{status}</span></td></tr>)}
            </tbody></table></div>
          </section>
        )}



        {key && page === 'Feed' && (
          <>
            <div className="feed-head">
              <div><h2>Connected social accounts</h2><p>Review Facebook and Instagram activity, engagement and provider health in one feed.</p></div>
              <div className="feed-actions">
                {marketingRefresh}
                {canMarketing('feed.manage_accounts') && <button className="primary" onClick={() => setPage(isAdministrator ? 'Admin Settings' : 'Marketing Accounts')}><Settings size={16} /> Manage accounts</button>}
              </div>
            </div>
            <div className="feed-streams feed-network-cards">
              {integrations.filter((i) => (i.provider === 'facebook' || i.provider === 'instagram') && i.status === 'connected').map((i) => {
                const providerPosts = posts.filter((p) => p.channels.includes(i.provider)).sort((a, b) => new Date(b.published_at || b.publish_at || b.created_at || 0).getTime() - new Date(a.published_at || a.publish_at || a.created_at || 0).getTime()).slice(0, 25)
                const engagement = providerPosts.reduce((n, p) => n + (p.likes ?? 0) + (p.reactions ?? 0) + (p.saves ?? 0) + (p.comments ?? 0) + (p.shares ?? 0) + (p.clicks ?? 0), 0)
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
              <div><span>Views</span><strong>{posts.reduce((n, p) => n + (p.views ?? p.impressions ?? p.reach ?? 0), 0)}</strong></div>
            </div>            <div className="feed-post-columns">
              {integrations.filter((i) => (i.provider === 'facebook' || i.provider === 'instagram') && i.status === 'connected').map((i) => {
                const providerPosts = posts.filter((p) => p.channels.includes(i.provider)).sort((a, b) => new Date(b.published_at || b.publish_at || b.created_at || 0).getTime() - new Date(a.published_at || a.publish_at || a.created_at || 0).getTime()).slice(0, 25)
                return <section className="feed-post-column" key={i.provider}>
                  <h3>{i.account_name || i.page_name || i.label}</h3>
                  <PostList posts={providerPosts} campaigns={campaigns} onEdit={openEditor} onOpen={openPost} onDelete={removePost} canEdit={canMarketing('feed.edit')} canDelete={canMarketing('feed.delete')} card pageName={i.account_name || i.page_name || i.label} pageUrl={i.provider === 'facebook' ? `https://www.facebook.com/${i.page_id || ''}` : `https://www.instagram.com/${i.username || ''}`} />
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
                <input aria-label="Search posts" placeholder="Search titles, captions and campaigns" maxLength={200} value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <div className="view-toggle" role="group" aria-label="View">
                {(['list', 'board', 'calendar', 'pivot'] as const).map((v) => (
                  <button key={v} className={`secondary ${view === v ? 'active' : ''}`} aria-pressed={view === v} onClick={() => { setPostPage(0); setView(v) }}>
                    {v[0].toUpperCase() + v.slice(1)}
                  </button>
                ))}
              </div>
              {view === 'list' && (<select aria-label="Filter by status" value={filter} onChange={(e) => { setPostPage(0); setFilter(e.target.value) }}>
                <option value="all">All posts</option>
                <option value="draft">Drafts</option>
                <option value="awaiting_approval">Awaiting approval</option>
                <option value="scheduled">Scheduled</option>
                <option value="published">Published</option>
                <option value="failed">Failed</option>
                <option value="engagements">Published / engagements</option>
              </select>)}
              <select aria-label="Filter by campaign" value={campaignFilter} onChange={(e) => { setPostPage(0); setCampaignFilter(e.target.value) }}>
                <option value="all">All campaigns</option><option value="none">No campaign</option>
                {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {integrations.some((i) => (i.provider === 'facebook' || i.provider === 'instagram') && i.status === 'connected') && marketingRefresh}
              {canMarketing('posts.create') && <button className="primary" onClick={() => setEditor(emptyPost())}><Plus size={16} /> New post</button>}
            </div>
            <MonthNav
              month={view === 'calendar' ? month ?? startOfMonth() : month}
              allowAll={view !== 'calendar'}
              onChange={(value) => { setPostPage(0); setMonth(value) }}
              count={postTotal}
            />
            <div className="section-head" aria-live="polite"><span>{postsLoading ? 'Loading posts...' : view === 'pivot' ? `${postTotal} matching posts` : `Showing ${postTotal ? postPage*POST_PAGE_SIZE+1 : 0} to ${Math.min(postPage*POST_PAGE_SIZE+posts.length,postTotal)} of ${postTotal} posts`}</span>{view !== 'pivot' && <div className="row-actions"><button className="secondary" disabled={postsLoading || postPage===0} onClick={() => setPostPage(p=>p-1)}>Previous</button><button className="secondary" disabled={postsLoading || (postPage+1)*POST_PAGE_SIZE>=postTotal} onClick={() => setPostPage(p=>p+1)}>Next</button></div>}</div>
            {view === 'list' && (
              <PostList posts={visiblePosts} campaigns={campaigns} onEdit={openEditor} onOpen={openPost} onDelete={removePost} canEdit={canMarketing('posts.edit')} canDelete={canMarketing('posts.delete')} />
            )}
            {view === 'board' && (
              <PostBoard
                posts={monthPosts} campaigns={campaigns} onOpen={openPost} onError={setError}
                canEdit={canMarketing('posts.edit')}
                onMove={(id, status) => void patchPost(id, { status }, `Post moved to ${status.replace(/_/g, ' ')}.`)}
              />
            )}
            {view === 'pivot' && (
              <PostPivot summary={postSummary} campaignTypes={campaignTypes} />
            )}
            {view === 'calendar' && (
              <PostCalendar
                posts={filteredPosts} month={month ?? startOfMonth()} onOpen={(id) => { setDetailId(id); setError('') }} onError={setError}
                canCreate={canMarketing('posts.create')} canEdit={canMarketing('posts.edit')}
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
              {canMarketing('campaigns.create') && <button className="primary" onClick={() => { setEditingCampaignId(null); setCampaignName(''); setCampaignObjective(''); setCampaignStage('new'); setCampaignType(campaignTypes[0] || 'Tips'); setCampaignModal(true) }}><Plus size={16} /> New campaign</button>}
            </div>
            <div className="campaign-board">
              {([
                ['new', 'New'],
                ['in_progress', 'In Progress'],
                ['done', 'Done'],
              ] as const).map(([stage, label]) => (
                <section className="campaign-column" key={stage} onDragOver={(e) => { if (canMarketing('campaigns.change_status')) e.preventDefault() }} onDrop={(e) => { if (!canMarketing('campaigns.change_status')) return; e.preventDefault(); const id = e.dataTransfer.getData('text/campaign-id'); if (id) void moveCampaign(id, stage) }}>
                  <header className="campaign-column-head"><h3>{label}</h3><span>{campaigns.filter((c) => (c.stage || 'new') === stage).length}</span></header>
                  {canMarketing('campaigns.create') && (stage === 'new' || canMarketing('campaigns.change_status')) && <button className="campaign-quick-add" onClick={() => { setEditingCampaignId(null); setCampaignName(''); setCampaignObjective(''); setCampaignStage(stage); setCampaignType(campaignTypes[0] || 'Tips'); setCampaignModal(true) }}><Plus size={14} /> Quick add</button>}
                  {campaigns.filter((c) => (c.stage || 'new') === stage).map((c) => (
                <div className="campaign-card" key={c.id} draggable={canMarketing('campaigns.change_status')} onDragStart={(e) => { if (canMarketing('campaigns.change_status')) e.dataTransfer.setData('text/campaign-id', c.id) }}>
                  <div className="campaign-icon"><Megaphone size={20} /></div>
                  <div className="campaign-card-heading"><h3>{c.name}</h3><span className="status-badge">{(c.stage || 'new').replace('_', ' ')}</span></div>
                  <p>{c.objective || 'No objective added yet.'}</p>
                                    <div className="campaign-footer">
                    {canMarketing('campaigns.edit') && <button className="text-button" onClick={() => openCampaignEditor(c)}>Edit</button>}
                    {canMarketing('posts.view') && <button className="text-button" onClick={() => { setPage('Posts'); setSearch(''); setFilter('all'); setCampaignFilter(c.id); setMonth(null) }}>View posts →</button>}{canMarketing('campaigns.delete') && (campaignPostCounts[c.id] || 0) === 0 && <button className="text-button danger" onClick={() => void removeCampaign(c)}>Delete</button>}
                  </div>
                </div>
                  ))}
                </section>
              ))}
              {campaigns.length === 0 && (
                <div className="empty">
                  <Megaphone size={28} /><h3>No campaigns yet</h3>
                  <p>Create a campaign to organise related posts.</p>
                  {canMarketing('campaigns.create') && <button className="secondary" onClick={() => setCampaignModal(true)}>{editingCampaignId ? 'Save changes' : 'Create campaign'}</button>}
                </div>
              )}
            </div>
          </>
        )}

        {key && page === 'Post' && (
          selected ? (
            <PostDetail
              post={selected} campaigns={campaigns} onBack={() => setPage('Posts')} onEdit={openEditor}
              onReschedule={reschedulePost} onDelete={removePost} onSaveCampaign={saveCampaign} onOpenImage={(images, index) => setImageViewer({ images, index })} onError={handleError}
              canEdit={canMarketing('posts.edit')} canDelete={canMarketing('posts.delete')} canAssignCampaign={canMarketing('posts.assign_campaign')}
            />
          ) : (
            <div className="empty">
              <ClipboardList size={28} /><h3>Post not found</h3>
              <button className="secondary" onClick={() => setPage('Posts')}>Back to posts</button>
            </div>
          )
        )}

        {key && (page === 'Configuration' || page === 'Marketing Accounts') && (
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
                    {i.provider === 'instagram' && !!i.granted_permissions?.length && <p><strong>Granted permissions:</strong> {i.granted_permissions?.join(', ')}</p>}
                    {i.provider === 'instagram' && i.connection_source && <p><strong>Connection method:</strong> {i.connection_source === 'oauth' ? 'Meta OAuth' : i.connection_source}</p>}
                    {i.provider === 'facebook' && i.last_checked_at && <p><strong>Last checked:</strong> {new Date(i.last_checked_at).toLocaleString()}</p>}
                    {i.provider === 'facebook' && i.last_success_at && <p><strong>Last successful check:</strong> {new Date(i.last_success_at).toLocaleString()}</p>}
                    {i.provider === 'facebook' && i.token_type && <p><strong>Token type:</strong> {i.token_type}</p>}
                    {i.provider === 'facebook' && i.expires_at && <p><strong>Token expires:</strong> {new Date(i.expires_at * 1000).toLocaleString()}</p>}
                    {i.provider === 'facebook' && i.data_access_expires_at && <p><strong>Data access expires:</strong> {new Date(i.data_access_expires_at * 1000).toLocaleString()}</p>}
                    {i.provider === 'facebook' && i.status === 'connected' && !i.expires_at && <p>Page token does not expire. Reconnect when data access expires.</p>}
                    {i.provider === 'facebook' && !!i.granted_permissions?.length && <p><strong>Granted permissions:</strong> {i.granted_permissions?.join(', ')}</p>}
                    {i.provider === 'facebook' && !!i.missing_permissions?.length && <p><strong>Missing permissions:</strong> {i.missing_permissions?.join(', ')}</p>}
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
            {isAdministrator && <CampaignTypeConfiguration
              types={campaignTypes}
              draft={newCampaignType}
              onDraftChange={setNewCampaignType}
              dragged={draggedCampaignType}
              onDragStart={setDraggedCampaignType}
              onAdd={async () => {
                if (!newCampaignType.trim()) return
                try { await campaignsService.addType(newCampaignType); setNewCampaignType(''); await load() } catch (e) { handleError(e) }
              }}
              onDelete={async (name) => {
                try { await campaignsService.removeType(name); await load() } catch (e) { handleError(e) }
              }}
              onReorder={async (names) => {
                try { await campaignsService.reorderTypes(names); await load() } catch (e) { handleError(e) }
              }}
            />}
            <div className="security-note">
              <Settings size={20} />
              <div>
                <b>Connection management</b>
                <p>Connect Facebook to authorize through Meta, then select the Page Impala Hub should manage. Page access tokens are encrypted before being stored by the backend. Keep your Meta app secret and encryption key private in backend/.env.</p>
              </div>
            </div>
          </>
        )}
              {key && (page === 'Feed' || (page === 'Posts' && view === 'calendar')) && detailId && selected && (
          <div className="overlay feed-post-modal" role="dialog" aria-modal="true" onMouseDown={(e) => { if (e.target === e.currentTarget) setDetailId(null) }}>
            <div className="feed-post-modal-panel">
              <button className="icon-button feed-post-modal-close" aria-label="Close post details" onClick={() => setDetailId(null)}><X size={20} /></button>
              <PostDetail
                post={selected} campaigns={campaigns} onBack={() => setDetailId(null)} onEdit={openEditor}
                onReschedule={reschedulePost} onDelete={removePost} onSaveCampaign={saveCampaign} onOpenImage={(images, index) => setImageViewer({ images, index })} onError={handleError}
                canEdit={page === 'Feed' ? canMarketing('feed.edit') : canMarketing('posts.edit')} canDelete={page === 'Feed' ? canMarketing('feed.delete') : canMarketing('posts.delete')} canAssignCampaign={page === 'Feed' ? canMarketing('feed.assign_campaign') : canMarketing('posts.assign_campaign')}
              />
            </div>
          </div>
        )}
        {imageViewer && imageViewer.images[imageViewer.index] && (
          <div className="overlay feed-image-viewer" role="dialog" aria-modal="true" aria-label="Full-size post image" onMouseDown={(e) => { if (e.target === e.currentTarget) setImageViewer(null) }}>
            <div className="feed-image-viewer-panel">
              <button className="icon-button feed-image-viewer-close" aria-label="Close full-size image" onClick={() => setImageViewer(null)}><X size={20} /></button>
              {imageViewer.images.length > 1 && <button className="feed-image-viewer-nav feed-image-viewer-prev" aria-label="Previous image" onClick={() => setImageViewer((v) => v ? { ...v, index: (v.index - 1 + v.images.length) % v.images.length } : v)}><ArrowLeft size={22} /></button>}
              <img src={mediaSrc(imageViewer.images[imageViewer.index])} alt={imageViewer.images[imageViewer.index].name} />
              {imageViewer.images.length > 1 && <button className="feed-image-viewer-nav feed-image-viewer-next" aria-label="Next image" onClick={() => setImageViewer((v) => v ? { ...v, index: (v.index + 1) % v.images.length } : v)}><ArrowRight size={22} /></button>}
            </div>
          </div>
        )}
</main>
      <ChatDock enabled={Boolean(key)} openRequest={chatOpenRequest} onError={setError} onOpenChannels={() => setPage('Channels')} />

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
              <select id="post-campaign" value={editor.campaign_id || ''} disabled={!(page === 'Feed' ? canMarketing('feed.assign_campaign') : canMarketing('posts.assign_campaign'))} onChange={(e) => patchEditor({ campaign_id: e.target.value || null })}>
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
            <label htmlFor="campaign-type">Campaign type</label>
            <select id="campaign-type" value={campaignType} onChange={(e) => setCampaignType(e.target.value)}>{campaignTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select>
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


function CampaignTypeConfiguration({ types, draft, onDraftChange, dragged, onDragStart, onAdd, onDelete, onReorder }: { types: string[]; draft: string; onDraftChange: (v: string) => void; dragged: string | null; onDragStart: (v: string | null) => void; onAdd: () => void; onDelete: (name: string) => void; onReorder: (names: string[]) => void }) {
  function drop(target: string) {
    if (!dragged || dragged === target) return
    const next = [...types]
    const from = next.indexOf(dragged); const to = next.indexOf(target)
    next.splice(from, 1); next.splice(to, 0, dragged)
    onDragStart(null); onReorder(next)
  }
  return <div className="detail-card campaign-type-config">
    <div className="section-head"><div><h2>Campaign types</h2><p>Manage the categories used by campaigns and grouped post insights.</p></div></div>
    <div className="campaign-type-add"><input value={draft} placeholder="Add campaign type" onChange={(e) => onDraftChange(e.target.value)} /><button className="primary" onClick={onAdd}>Add type</button></div>
    <div className="campaign-type-list">{types.map((type) => <div className="campaign-type-row" key={type} draggable onDragStart={() => onDragStart(type)} onDragOver={(e) => e.preventDefault()} onDrop={() => drop(type)}><span>☷ {type}</span><button className="icon-button" aria-label={'Remove ' + type} onClick={() => onDelete(type)}><Trash2 size={15} /></button></div>)}</div>
  </div>
}

function PostPivot({ summary, campaignTypes }: { summary: PostSummary[]; campaignTypes: string[] }) {
  const [selectedType, setSelectedType] = useState('all')
  const rows = summary.filter(row => selectedType === 'all' || row.campaign_type === selectedType)
  const totals = rows.reduce((a, r) => ({ label: 'Total', posts: a.posts + Number(r.posts), likes: a.likes + Number(r.likes), comments: a.comments + Number(r.comments), shares: a.shares + Number(r.shares), clicks: a.clicks + Number(r.clicks) }), { label: 'Total', posts: 0, likes: 0, comments: 0, shares: 0, clicks: 0 })
  return (
    <div className="pivot-wrap">
      <div className="section-head"><div><h2>Post insights</h2><p>Grouped reporting for the current filters.</p></div><select aria-label="Campaign type" value={selectedType} onChange={(e) => setSelectedType(e.target.value)}><option value="all">All campaign types</option>{campaignTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></div>
      <div className="pivot-table-wrap"><table className="pivot-table"><thead><tr><th>Campaign</th><th>Posts</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Clicks</th></tr></thead><tbody>
        {rows.filter((r) => r.posts > 0).map((r) => <tr key={r.label}><td>{r.label}</td><td>{r.posts}</td><td>{r.likes}</td><td>{r.comments}</td><td>{r.shares}</td><td>{r.clicks}</td></tr>)}
        <tr className="pivot-total"><td>{totals.label}</td><td>{totals.posts}</td><td>{totals.likes}</td><td>{totals.comments}</td><td>{totals.shares}</td><td>{totals.clicks}</td></tr>
      </tbody></table></div>
    </div>
  )
}

function PostList({ posts, campaigns, onEdit, onOpen, onDelete, canEdit, canDelete, card = false, pageName, pageUrl }: {
  posts: Post[]
  campaigns: Campaign[]
  onEdit: (p: Post) => void
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  canEdit: boolean
  canDelete: boolean
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
                  {p.media.slice(0, 2).map((m, index) => <div className="feed-card-image" key={m.id || m.url} onClick={() => onOpen(p.id)}><img src={mediaSrc(m)} alt={m.name} />{index === 1 && p.media.length > 2 && <span>+{p.media.length - 2}</span>}</div>)}
                  {!p.media.length && <div className="feed-card-no-image"><ImagePlus size={20} /></div>}
                </div>
                <div className="feed-card-bottom"><span><Heart size={14} /> {metric(p.likes)}</span><span><MessageCircle size={14} /> {metric(p.comments)}</span><span className="feed-card-views"><Eye size={14} /> {metric(p.views ?? p.impressions ?? p.reach)}</span></div>
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
                  {p.status === 'published' && <small>Views {metric(p.views ?? p.impressions ?? p.reach)} · Reach {metric(p.reach)} · Likes {metric(p.likes)} · Comments {metric(p.comments)} · Shares {metric(p.shares)}{p.metrics_refreshed_at ? ` · updated ${fmt(p.metrics_refreshed_at)}` : ''}</small>}
                </div>
                <div className="row-actions"><button className="secondary" onClick={() => onOpen(p.id)}>View</button>{canEdit && EDITABLE.includes(p.status) && <button className="secondary" onClick={() => onEdit(p)}>Edit</button>}{canDelete && <button className="icon-button" title="Delete local record (only after it is absent from Facebook)" aria-label="Delete post" onClick={() => onDelete(p.id)}><Trash2 size={16} /></button>}</div>
              </>
            )}
          </article>
        )
      })}
    </div>
  )
}
