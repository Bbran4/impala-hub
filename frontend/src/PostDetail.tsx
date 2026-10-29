import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, CalendarClock, ImagePlus, Lock, Pencil, Trash2, X } from 'lucide-react'
import { api, EDITABLE, fmt, mediaSrc, metric, type Campaign, type HistoryEntry, type Post } from './lib'

type Props = {
  post: Post
  campaigns: Campaign[]
  onBack: () => void
  onEdit: (p: Post) => void
  onReschedule: (p: Post) => void
  onDelete: (id: string) => void
  onSaveCampaign: (postId: string, campaignId: string | null) => Promise<void>
  onOpenImage: (images: Post['media'], index: number) => void
  onError: (e: unknown) => void
  canEdit: boolean
  canDelete: boolean
  canAssignCampaign: boolean
}

const VERBS: Record<string, string> = { created: 'Created', updated: 'Updated', deleted: 'Deleted' }

function describeEntry(h: HistoryEntry): string {
  const parts: string[] = []
  if (h.details.status) parts.push(`status: ${h.details.status.replace(/_/g, ' ')}`)
  if (h.details.changed?.length) parts.push(`changed: ${h.details.changed.join(', ').replace(/_/g, ' ')}`)
  return `${VERBS[h.action] ?? h.action}${parts.length ? ' — ' + parts.join(' · ') : ''}`
}

export default function PostDetail({ post, campaigns, onBack, onEdit, onReschedule, onDelete, onSaveCampaign, onError, canEdit, canDelete, canAssignCampaign }: Props) {
  const [campaignId, setCampaignId] = useState(post.campaign_id || '')
  const [history, setHistory] = useState<HistoryEntry[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  const editable = EDITABLE.includes(post.status)
  const published = post.status === 'published'
  const assignedCampaign = campaigns.find((campaign) => campaign.id === campaignId)
  const campaignLocked = assignedCampaign?.stage === 'done'
  const heading = post.title?.trim() || post.caption?.trim().slice(0, 110) || 'Untitled post'

  useEffect(() => { setCampaignId(post.campaign_id || '') }, [post.id, post.campaign_id])

  useEffect(() => {
    if (lightboxIndex === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxIndex(null)
      if (e.key === 'ArrowLeft' && post.media.length > 1) setLightboxIndex((i) => i === null ? 0 : (i - 1 + post.media.length) % post.media.length)
      if (e.key === 'ArrowRight' && post.media.length > 1) setLightboxIndex((i) => i === null ? 0 : (i + 1) % post.media.length)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightboxIndex, post.media.length])

  useEffect(() => {
    let live = true
    api(`/api/posts/${post.id}/history`).then((h) => { if (live) setHistory(h) }).catch(onError)
    return () => { live = false }
  }, [post.id, post.updated_at])

  async function saveCampaign() {
    setSaving(true)
    try { await onSaveCampaign(post.id, campaignId || null) } finally { setSaving(false) }
  }

  return (
    <div className="detail">
      <button className="text-button" onClick={onBack}><ArrowLeft size={15} /> Back to posts</button>

      <div className="section-head">
        <div>
          <div className="post-meta">
            <span className={`status ${post.status}`}>{post.status.replace(/_/g, ' ')}</span>
            <span>{post.channels.join(' · ') || 'No channel'}</span>
          </div>
          <h2>{heading}</h2>
        </div>
        <div className="row-actions">
          {canEdit && editable && <button className="secondary" onClick={() => onEdit(post)}><Pencil size={15} /> Edit post</button>}
          {canEdit && post.status === 'failed' && <button className="secondary" onClick={() => onReschedule(post)}><CalendarClock size={15} /> Reschedule</button>}
          {canDelete && <button className="icon-button" title="Delete local record (only after it is absent from Facebook)" aria-label="Delete post" onClick={() => onDelete(post.id)}><Trash2 size={16} /></button>}
        </div>
      </div>

      {!editable && (
        <div className="lock-banner">
          <Lock size={16} />
          {published
            ? 'Published posts can only be removed from Impala Hub after they no longer exist on Facebook.'
            : 'This post is scheduled. Only its campaign can be changed.'}
        </div>
      )}

      <div className="detail-card">
        <h3>Content</h3>
        <p className="detail-caption">{post.caption || 'No caption.'}</p>
        <div className="media-grid">
          {post.media.map((m) => (
            <button className="media-thumb detail-media-thumb" key={m.id} type="button" onClick={(e) => { e.stopPropagation(); setLightboxIndex(post.media.findIndex((image) => image.id === m.id)) }} aria-label={'View ' + m.name + ' full size'}><img src={mediaSrc(m)} alt={m.name} /><small>{m.name}</small></button>
          ))}
          {!post.media.length && <div className="media-empty"><ImagePlus size={22} /><span>No images attached</span></div>}
        </div>
      </div>

      <div className="detail-card">
        <h3>Schedule and publication</h3>
        <dl className="detail-grid">
          <div><dt>Scheduled for</dt><dd>{fmt(post.publish_at)}</dd></div>
          <div><dt>Actually published</dt><dd>{fmt(post.published_at, 'Not published')}</dd></div>
          <div><dt>Created</dt><dd>{fmt(post.created_at, '—')}</dd></div>
          <div><dt>Last updated</dt><dd>{fmt(post.updated_at, '—')}</dd></div>
        </dl>
        {post.last_error && <p className="hint">Last error: {post.last_error}</p>}
        {post.provider_ids?.permalink && (
          <p className="hint"><a href={post.provider_ids.permalink} target="_blank" rel="noreferrer">View on Facebook</a></p>
        )}
      </div>

      <div className="detail-card">
        <h3>Performance</h3>
        <dl className="detail-grid">
          <div><dt>Total reach</dt><dd>{metric(post.reach)}</dd></div>
          <div><dt>Views</dt><dd>{metric(post.views ?? post.impressions ?? post.reach)}</dd></div>
          <div><dt>Clicks</dt><dd>{metric(post.clicks)}</dd></div>
          <div><dt>Likes</dt><dd>{metric(post.likes)}</dd></div>
          <div><dt>Comments</dt><dd>{metric(post.comments)}</dd></div>
          <div><dt>Shares</dt><dd>{metric(post.shares)}</dd></div>
        </dl>
        <p className="hint">
          {post.metrics_refreshed_at
            ? `Figures last refreshed ${fmt(post.metrics_refreshed_at)}.`
            : '— means not available. Figures appear after a platform is connected and the post is published.'}
        </p>
      </div>

      {canAssignCampaign && <div className="detail-card campaign-assignment-card">
        <div className="campaign-assignment-heading">
          <div>
            <h3>Campaign</h3>
            <p>Organise this post under a campaign for easier reporting.</p>
          </div>
        </div>
        <div className="campaign-assignment-form">
          <label className="campaign-assignment-field">
            <span>Assign to campaign</span>
            <select aria-label="Assign to campaign" value={campaignId} disabled={campaignLocked} onChange={(e) => setCampaignId(e.target.value)}>
              <option value="">No campaign</option>
              {campaigns.filter((c) => c.stage !== 'done' || c.id === campaignId).map((c) => <option key={c.id} value={c.id}>{c.name}{c.stage === 'done' ? ' (Done)' : ''}</option>)}
            </select>
          </label>
          {campaignLocked && <p className="campaign-assignment-locked">This post is assigned to a completed campaign and cannot be reassigned.</p>}
          <button className="primary campaign-assignment-save" disabled={saving || campaignLocked || campaignId === (post.campaign_id || '')} onClick={() => void saveCampaign()}>
            {saving ? 'Saving...' : 'Save campaign'}
          </button>
        </div>
      </div>}

      <div className="detail-card">
        <h3>History</h3>
        {history === null && <p className="hint">Loading history...</p>}
        {history?.length === 0 && <p className="hint">No history recorded.</p>}
        <ul className="history-list">
          {history?.map((h) => (
            <li key={h.id}><span>{describeEntry(h)}</span><small>{fmt(h.created_at, '')}</small></li>
          ))}
        </ul>
      </div>
      {lightboxIndex !== null && post.media[lightboxIndex] && (
        <div className="overlay feed-image-viewer" role="dialog" aria-modal="true" aria-label="Full-size post image" onMouseDown={(e) => { if (e.target === e.currentTarget) setLightboxIndex(null) }}>
          <div className="feed-image-viewer-panel">
            <button className="icon-button feed-image-viewer-close" aria-label="Close full-size image" onClick={() => setLightboxIndex(null)}><X size={20} /></button>
            {post.media.length > 1 && <button className="feed-image-viewer-nav feed-image-viewer-prev" aria-label="Previous image" onClick={() => setLightboxIndex((i) => i === null ? 0 : (i - 1 + post.media.length) % post.media.length)}><ArrowLeft size={22} /></button>}
            <img src={mediaSrc(post.media[lightboxIndex])} alt={post.media[lightboxIndex].name} />
            {post.media.length > 1 && <button className="feed-image-viewer-nav feed-image-viewer-next" aria-label="Next image" onClick={() => setLightboxIndex((i) => i === null ? 0 : (i + 1) % post.media.length)}><ArrowRight size={22} /></button>}
          </div>
        </div>
      )}
    </div>
  )
}
