import type { PostWriteStatus } from './marketingTypes'
import { useState } from 'react'
import { EDITABLE, fmt, headingOf, isFuture, mediaSrc, type Campaign, type Post } from './lib'

const COLUMNS: [string, string][] = [
  ['draft', 'Draft'],
  ['awaiting_approval', 'Awaiting approval'],
  ['scheduled', 'Scheduled'],
  ['published', 'Published'],
  ['failed', 'Failed'],
]
// Clients can only move posts into these. Published and failed are set by the future publishing worker.
const DROP_TARGETS = ['draft', 'awaiting_approval', 'scheduled']
const LABELS = Object.fromEntries(COLUMNS)

type Props = {
  posts: Post[]
  campaigns: Campaign[]
  onOpen: (id: string) => void
  onMove: (id: string, status: PostWriteStatus) => void
  onError: (message: string) => void
  canEdit: boolean
}

export default function PostBoard({ posts, campaigns, onOpen, onMove, onError, canEdit }: Props) {
  const [over, setOver] = useState<string | null>(null)

  function move(post: Post, target: string) {
    if (target !== 'draft' && target !== 'awaiting_approval' && target !== 'scheduled') return
    if (post.status === target) return
    if (!EDITABLE.includes(post.status)) return onError(`A ${post.status} post cannot be moved.`)
    if (target === 'scheduled' && !isFuture(post.publish_at)) {
      return onError('Give this post a future publication date first (Edit post), then move it to Scheduled.')
    }
    onMove(post.id, target)
  }

  return (
    <div className="board">
      {COLUMNS.map(([status, label]) => {
        const items = posts.filter((p) => p.status === status)
        const droppable = DROP_TARGETS.includes(status)
        return (
          <section
            key={status}
            className={`board-col ${over === status ? 'over' : ''}`}
            aria-label={`${label} column`}
            onDragOver={(e) => { if (canEdit && droppable) { e.preventDefault(); setOver(status) } }}
            onDragLeave={() => setOver((o) => (o === status ? null : o))}
            onDrop={(e) => {
              e.preventDefault(); setOver(null)
              const post = posts.find((p) => p.id === e.dataTransfer.getData('text/plain'))
              if (canEdit && post && droppable) move(post, status)
            }}
          >
            <header><b>{label}</b><span>{items.length}</span></header>
            {items.map((p) => {
              const editable = EDITABLE.includes(p.status)
              return (
                <article
                  key={p.id} className="board-card" data-status={p.status} draggable={canEdit && editable}
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', p.id)}
                >
                  <button className="board-title" onClick={() => onOpen(p.id)}>
                    {p.media[0] && <img src={mediaSrc(p.media[0])} alt="" />}
                    <span>{headingOf(p)}</span>
                  </button>
                  <small>{p.channels.join(' · ') || 'No channel'}</small>
                  <small>{p.published_at ? `Posted ${fmt(p.published_at)}` : fmt(p.publish_at)}</small>
                  <small>{campaigns.find((c) => c.id === p.campaign_id)?.name || 'No campaign'}</small>
                  {canEdit && editable && (
                    <select aria-label={`Move ${headingOf(p)}`} value="" onChange={(e) => move(p, e.target.value)}>
                      <option value="">Move to…</option>
                      {DROP_TARGETS.filter((t) => t !== p.status).map((t) => <option key={t} value={t}>{LABELS[t]}</option>)}
                    </select>
                  )}
                </article>
              )
            })}
            {!items.length && <p className="hint">Nothing here</p>}
          </section>
        )
      })}
    </div>
  )
}
