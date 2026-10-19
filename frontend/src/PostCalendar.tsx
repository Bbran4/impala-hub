import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { headingOf, type Post } from './lib'

// Only drafts and posts awaiting approval can change date. Scheduled and published posts are locked.
const MOVABLE = ['draft', 'awaiting_approval']
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const postDate = (p: Post) => p.published_at || p.publish_at || null

type Props = {
  posts: Post[]
  onOpen: (id: string) => void
  onChangeDate: (id: string, isoDate: string, message: string) => void
  onCreate: (localDateTime: string) => void
  onError: (message: string) => void
}

export default function PostCalendar({ posts, onOpen, onChangeDate, onCreate, onError }: Props) {
  const [month, setMonth] = useState(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1) })
  const [over, setOver] = useState<string | null>(null)
  const todayKey = dayKey(new Date())

  const byDay = useMemo(() => {
    const map = new Map<string, Post[]>()
    for (const p of posts) {
      const stamp = postDate(p)
      if (!stamp) continue
      const key = dayKey(new Date(stamp))
      map.set(key, [...(map.get(key) || []), p])
    }
    return map
  }, [posts])
  const unscheduled = posts.filter((p) => !postDate(p) && MOVABLE.includes(p.status))

  // Monday-first grid covering the whole month.
  const offset = (month.getDay() + 6) % 7
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const cells = Array.from({ length: Math.ceil((offset + daysInMonth) / 7) * 7 }, (_, i) => {
    const day = i - offset + 1
    return day < 1 || day > daysInMonth ? null : new Date(month.getFullYear(), month.getMonth(), day)
  })

  function drop(day: Date, postId: string) {
    const post = posts.find((p) => p.id === postId)
    if (!post) return
    if (!MOVABLE.includes(post.status)) return onError(`A ${post.status} post cannot be moved to another date.`)
    const old = post.publish_at ? new Date(post.publish_at) : null  // keep the planned time of day, default 09:00
    const target = new Date(day.getFullYear(), day.getMonth(), day.getDate(), old ? old.getHours() : 9, old ? old.getMinutes() : 0)
    onChangeDate(post.id, target.toISOString(), `Planned date set to ${target.toLocaleDateString()}.`)
  }

  const shift = (n: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1))

  return (
    <div className="cal">
      <div className="cal-head">
        <button className="icon-button" aria-label="Previous month" onClick={() => shift(-1)}><ChevronLeft size={18} /></button>
        <h3>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h3>
        <button className="icon-button" aria-label="Next month" onClick={() => shift(1)}><ChevronRight size={18} /></button>
        <button className="secondary" onClick={() => { const n = new Date(); setMonth(new Date(n.getFullYear(), n.getMonth(), 1)) }}>Today</button>
      </div>

      {unscheduled.length > 0 && (
        <div className="cal-tray">
          <b>Unscheduled</b>
          {unscheduled.map((p) => (
            <button key={p.id} className="cal-chip" data-status={p.status} draggable
              onDragStart={(e) => e.dataTransfer.setData('text/plain', p.id)} onClick={() => onOpen(p.id)}>
              {headingOf(p)}
            </button>
          ))}
          <small>Drag onto a day to plan it.</small>
        </div>
      )}

      <div className="cal-grid">
        {WEEKDAYS.map((d) => <div key={d} className="cal-weekday">{d}</div>)}
        {cells.map((day, i) => {
          if (!day) return <div key={i} className="cal-cell blank" />
          const key = dayKey(day)
          const past = key < todayKey
          const items = byDay.get(key) || []
          return (
            <div
              key={key}
              className={`cal-cell ${key === todayKey ? 'today' : ''} ${over === key ? 'over' : ''} ${past ? 'past' : ''}`}
              onDragOver={(e) => { if (!past) { e.preventDefault(); setOver(key) } }}
              onDragLeave={() => setOver((o) => (o === key ? null : o))}
              onDrop={(e) => { e.preventDefault(); setOver(null); drop(day, e.dataTransfer.getData('text/plain')) }}
            >
              <div className="cal-day">
                <span>{day.getDate()}</span>
                {!past && (
                  <button className="icon-button" aria-label={`New post on ${day.toLocaleDateString()}`}
                    onClick={() => onCreate(`${key}T09:00`)}><Plus size={14} /></button>
                )}
              </div>
              {items.slice(0, 3).map((p) => (
                <button key={p.id} className="cal-chip" data-status={p.status} draggable={MOVABLE.includes(p.status)}
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', p.id)} onClick={() => onOpen(p.id)}
                  title={`${headingOf(p)} (${p.status.replace(/_/g, ' ')})`}>
                  {headingOf(p)}
                </button>
              ))}
              {items.length > 3 && <small className="hint">+{items.length - 3} more</small>}
            </div>
          )
        })}
      </div>
      <p className="hint">Colour shows status. Only drafts and posts awaiting approval can be dragged to a new date.</p>
    </div>
  )
}
