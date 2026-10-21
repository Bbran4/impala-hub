import { useEffect, useState } from 'react'
import { ArrowLeft, CalendarClock, ImagePlus, Lock, Pencil, Trash2 } from 'lucide-react'
import { api, EDITABLE, fmt, mediaSrc, metric, type Campaign, type HistoryEntry, type Post } from './lib'

type Props = {
  post: Post
  campaigns: Campaign[]
  onBack: () => void
  onEdit: (p: Post) => void
  onReschedule: (p: Post) => void
  onDelete: (id: string) => void
  onSaveCampaign: (postId: string, campaignId: string | null) => Promise<void>
  onError: (e: unknown) => void
}

const VERBS: Record<string, string> = { created: 'Created', updated: 'Updated', deleted: 'Deleted' }

function describeEntry(h: HistoryEntry): string {
  const parts: string[] = []
  if (h.details.status) parts.push(`status: ${h.details.status.replace(/_/g, ' ')}`)
  if (h.details.changed?.length) parts.push(`changed: ${h.details.changed.join(', ').replace(/_/g, ' ')}`)
  return `${VERBS[h.action] ?? h.action}${parts.length ? ' — ' + parts.join(' · ') : ''}`
}

export default function PostDetail({ post, campaigns, onBack, onEdit, onReschedule, onDelete, onSaveCampaign, onError }: Props) {
  const [campaignId, setCampaignId] = useState(post.campaign_id || '')
  const [history, setHistory] = useState<HistoryEntry[] | null>(null)
  const [saving, setSaving] = useState(false)

  const editable = EDITABLE.includes(post.status)
  const published = post.status === 'published'
  const heading = post.title?.trim() || post.caption?.trim().slice(0, 110) || 'Untitled post'

  useEffect(() => { setCampaignId(post.campaign_id || '') }, [post.id, post.campaign_id])

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
          {editable && <button className="secondary" onClick={() => onEdit(post)}><Pencil size={15} /> Edit post</button>}
          {post.status === 'failed' && <button className="secondary" onClick={() => onReschedule(post)}><CalendarClock size={15} /> Reschedule</button>}
          <button className="icon-button" title="Delete local record (only after it is absent from Facebook)" aria-label="Delete post" onClick={() => onDelete(post.id)}><Trash2 size={16} /></button>
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
            <div className="media-thumb" key={m.id}><img src={mediaSrc(m)} alt={m.name} /><small>{m.name}</small></div>
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
          <div><dt>Organic reach</dt><dd>{metric(post.reach)}</dd></div>
          <div><dt>Organic impressions</dt><dd>{metric(post.impressions)}</dd></div>
          <div><dt>Views</dt><dd>{metric(post.impressions ?? post.reach)}</dd></div>
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

      <div className="detail-card">
        <h3>Campaign</h3>
        <div className="inline-form">
          <select aria-label="Campaign" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            <option value="">No campaign</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button className="primary" disabled={saving || campaignId === (post.campaign_id || '')} onClick={() => void saveCampaign()}>
            {saving ? 'Saving...' : 'Save campaign'}
          </button>
        </div>
      </div>

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
    </div>
  )
}
