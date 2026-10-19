import { ChevronLeft, ChevronRight } from 'lucide-react'
import { startOfMonth } from './lib'

type Props = {
  month: Date | null // null = all months
  count: number
  allowAll: boolean // the calendar always shows one month
  onChange: (month: Date | null) => void
}

export default function MonthNav({ month, count, allowAll, onChange }: Props) {
  const shift = (n: number) => {
    const base = month ?? startOfMonth()
    onChange(new Date(base.getFullYear(), base.getMonth() + n, 1))
  }
  const label = month ? month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : 'All months'
  return (
    <div className="month-nav" role="group" aria-label="Month">
      <button className="icon-button" aria-label="Previous month" onClick={() => shift(-1)}><ChevronLeft size={18} /></button>
      <h3 aria-live="polite">{label}</h3>
      <button className="icon-button" aria-label="Next month" onClick={() => shift(1)}><ChevronRight size={18} /></button>
      <button className="secondary" onClick={() => onChange(startOfMonth())}>This month</button>
      {allowAll && (
        <button className={`secondary ${month === null ? 'active' : ''}`} aria-pressed={month === null} onClick={() => onChange(null)}>
          All months
        </button>
      )}
      <span className="hint">{count} {count === 1 ? 'post' : 'posts'}</span>
    </div>
  )
}
