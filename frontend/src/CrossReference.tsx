import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, FileSpreadsheet, Search, Upload, X } from 'lucide-react'
import { supabase, supabaseConfigured } from './lib'
import {
  fmtMeasure, matchLabel, prepareImport, readPartsFile, templateWorkbook, xrefGetPart, xrefImport, xrefSearch, xrefSummary,
  type XrefHit, type XrefImportOutcome, type XrefPart, type XrefPrepared, type XrefSearchResult, type XrefSummary,
} from './crossReferenceLogic'
import './crossreference.css'

type Props = { setNotice: (m: string) => void; setError: (m: string) => void }

export default function CrossReference({ setNotice, setError }: Props) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<XrefSearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [summary, setSummary] = useState<XrefSummary | null>(null)
  const [openSku, setOpenSku] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const seq = useRef(0)
  const input = useRef<HTMLInputElement>(null)

  const loadSummary = useCallback(async () => {
    if (!supabase) return
    try { setSummary(await xrefSummary(supabase)) } catch (e) { setError((e as Error).message) }
  }, [setError])
  useEffect(() => { void loadSummary() }, [loadSummary])

  // search as you type (a short pause first); only the latest search is shown
  useEffect(() => {
    const q = query.trim()
    if (!supabase || q.length < 2) { setResult(null); setSearching(false); return }
    const mine = ++seq.current
    setSearching(true)
    const timer = window.setTimeout(async () => {
      try {
        const r = await xrefSearch(supabase!, q)
        if (mine === seq.current) setResult(r)
      } catch (e) { if (mine === seq.current) setError((e as Error).message) }
      finally { if (mine === seq.current) setSearching(false) }
    }, 300)
    return () => window.clearTimeout(timer)
  }, [query, refresh, setError])

  const searchFor = (value: string) => { setOpenSku(null); setQuery(value); input.current?.focus() }

  if (!supabaseConfigured || !supabase) {
    return <div className="rfq-empty-card"><h3>Cross Reference</h3><p>Cross Reference needs the Supabase connection.</p></div>
  }

  const q = query.trim()
  return (
    <div className="xr-workspace">
      <div className="xr-search-card">
        <label className="xr-search" htmlFor="xr-query">
          <Search size={18} />
          <input id="xr-query" ref={input} autoFocus autoComplete="off" spellCheck={false} value={query}
                 placeholder="OE number, cross reference number, our part number or description"
                 onChange={(e) => setQuery(e.target.value)} />
          {query && <button type="button" className="icon-button" aria-label="Clear search" onClick={() => searchFor('')}><X size={16} /></button>}
        </label>
        <div className="xr-search-meta">
          <span>{summary ? `${summary.parts.toLocaleString()} parts · ${summary.brands.toLocaleString()} brands · ${summary.numbers.toLocaleString()} OE and cross ref numbers` : ' '}</span>
          {summary?.can_import && <button className="secondary" onClick={() => setImportOpen(true)}><Upload size={15} /> Import parts</button>}
        </div>
      </div>

      {q.length < 2 ? (
        <div className="rfq-empty"><Search size={28} /><h3>Search for a part</h3>
          <p>Type an OE number, another brand's number, our part number or words from the description. Spaces, dashes and slashes in numbers don't matter, and part of a number is enough.</p></div>
      ) : !result ? (
        <p className="xr-status">Searching…</p>
      ) : (
        <>
          {result.more && <p className="xr-note">Many parts match "{result.query}". Type more of the number or description to narrow it down.</p>}
          <ResultTable title="Matches" count={result.direct_total} hits={result.direct} onOpen={setOpenSku} busy={searching}
                       empty={`No parts match "${result.query}".`} />
          {result.linked_skipped ? (
            <p className="xr-note">Parts linked through shared numbers are shown once the search matches fewer parts.</p>
          ) : result.linked.length > 0 && (
            <ResultTable title="Linked parts" subtitle="Share an OE or cross reference number with a match" count={result.linked_total}
                         hits={result.linked} onOpen={setOpenSku} busy={searching} />
          )}
        </>
      )}

      {openSku && <PartPanel sku={openSku} onClose={() => setOpenSku(null)} onSearch={searchFor} setError={setError} />}
      {importOpen && summary?.can_import && (
        <ImportPanel summary={summary} onClose={() => setImportOpen(false)} setNotice={setNotice} setError={setError}
                     onImported={() => { void loadSummary(); setRefresh((n) => n + 1) }} />
      )}
    </div>
  )
}

function ResultTable({ title, subtitle, count, hits, onOpen, empty, busy }: {
  title: string; subtitle?: string; count: number; hits: XrefHit[]; onOpen: (sku: string) => void; empty?: string; busy: boolean
}) {
  return (
    <section className={`xr-results${busy ? ' busy' : ''}`}>
      <header><h3>{title}</h3>{subtitle && <small>{subtitle}</small>}<span>{count > hits.length ? `Showing ${hits.length} of ${count.toLocaleString()}` : `${count} part${count === 1 ? '' : 's'}`}</span></header>
      <div className="rfq-table-wrap"><table className="rfq-table xr-table">
        <thead><tr><th>Part number / SKU</th><th>Brand</th><th>Description</th></tr></thead>
        <tbody>{hits.length ? hits.map((h) => (
          <tr key={h.sku} className="rfq-data-row xr-row" tabIndex={0} onClick={() => onOpen(h.sku)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(h.sku) } }}>
            <td className="xr-sku">{h.sku}</td>
            <td>{h.brand || '—'}</td>
            <td><div>{h.description || h.title || '—'}</div><small className="xr-why">{matchLabel(h)}</small></td>
          </tr>
        )) : <tr><td colSpan={3}><div className="rfq-empty"><h3>Nothing found</h3><p>{empty}</p></div></td></tr>}</tbody>
      </table></div>
    </section>
  )
}

function PartPanel({ sku, onClose, onSearch, setError }: { sku: string; onClose: () => void; onSearch: (v: string) => void; setError: (m: string) => void }) {
  const [part, setPart] = useState<XrefPart | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    setPart(undefined)
    xrefGetPart(supabase!, sku).then((p) => { if (live) setPart(p) }).catch((e) => { if (live) { setError((e as Error).message); onClose() } })
    return () => { live = false }
  }, [sku, setError, onClose])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const size = part ? [part.package_length_cm, part.package_width_cm, part.package_height_cm] : []
  const hasSize = size.some((v) => v != null)
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <section className="editor xr-panel" role="dialog" aria-modal="true" aria-label={`Part ${sku}`}>
        <header className="editor-head">
          <div><span className="eyebrow">{part?.brand ? part.brand.toUpperCase() : 'PART'}</span><h2>{part?.sku || sku}</h2></div>
          <button className="icon-button" aria-label="Close" onClick={onClose}><X size={20} /></button>
        </header>
        <div className="editor-body">
          {part === undefined ? <p className="hint">Loading…</p> : part === null ? <p className="hint">This part is no longer in the cross reference.</p> : (
            <>
              {part.title && <p className="xr-title">{part.title}</p>}
              {part.description && <p className="xr-description">{part.description}</p>}
              <dl className="xr-facts">
                <div><dt>Brand</dt><dd>{part.brand || '—'}</dd></div>
                <div><dt>Warranty</dt><dd>{part.warranty || '—'}</dd></div>
              </dl>

              <NumberList title="OE numbers" numbers={part.oe_numbers} onSearch={onSearch} />
              <NumberList title="Cross reference numbers" numbers={part.cross_numbers} onSearch={onSearch} />

              {part.specs.length > 0 && (
                <div className="xr-block"><h4>Specifications</h4>
                  <table className="xr-specs"><tbody>{part.specs.map((s, i) => (
                    <tr key={i}><th>{s.label || '—'}</th><td>{s.value}</td></tr>
                  ))}</tbody></table>
                </div>
              )}

              {(hasSize || part.package_weight_kg != null) && (
                <div className="xr-block"><h4>Packaging</h4>
                  <dl className="xr-facts">
                    {hasSize && <div><dt>Size (L × W × H)</dt><dd>{size.map((v) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 3 }))).join(' × ')} cm</dd></div>}
                    <div><dt>Weight</dt><dd>{fmtMeasure(part.package_weight_kg, 'kg') || '—'}</dd></div>
                  </dl>
                </div>
              )}

              {part.brand_description && <div className="xr-block"><h4>About {part.brand || 'the brand'}</h4><p className="xr-brand">{part.brand_description}</p></div>}
              <p className="hint">Imported {part.updated_at ? new Date(part.updated_at).toLocaleString() : ''}{part.updated_by ? ` by ${part.updated_by}` : ''}.</p>
            </>
          )}
        </div>
        <footer className="editor-foot"><button className="secondary" onClick={onClose}>Close</button></footer>
      </section>
    </div>
  )
}

function NumberList({ title, numbers, onSearch }: { title: string; numbers: string[]; onSearch: (v: string) => void }) {
  return (
    <div className="xr-block"><h4>{title} <small>{numbers.length}</small></h4>
      {numbers.length ? <div className="xr-chips">{numbers.map((n) => (
        <button key={n} type="button" className="xr-chip" title={`Search ${n}`} onClick={() => onSearch(n)}>{n}</button>
      ))}</div> : <p className="hint">None listed.</p>}
    </div>
  )
}

function ImportPanel({ summary, onClose, onImported, setNotice, setError }: {
  summary: XrefSummary; onClose: () => void; onImported: () => void; setNotice: (m: string) => void; setError: (m: string) => void
}) {
  const [fileName, setFileName] = useState('')
  const [prepared, setPrepared] = useState<XrefPrepared | null>(null)
  const [reading, setReading] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [outcome, setOutcome] = useState<XrefImportOutcome | null>(null)
  const busy = reading || (progress != null && !outcome)

  async function choose(file: File | undefined) {
    if (!file) return
    setFileName(file.name); setPrepared(null); setOutcome(null); setProgress(null); setReading(true); setError('')
    try {
      const sheet = await readPartsFile(file)
      setPrepared(prepareImport(sheet.headers, sheet.rows, sheet.sourceRows))
    } catch (e) { setError((e as Error).message); setFileName('') }
    finally { setReading(false) }
  }
  async function run() {
    if (!prepared?.rows.length) return
    setProgress({ done: 0, total: prepared.rows.length }); setError('')
    try {
      const r = await xrefImport(supabase!, prepared.rows, fileName, (done, total) => setProgress({ done, total }))
      setOutcome(r)
      setNotice(`Imported ${fileName}: ${r.created} new, ${r.replaced} replaced${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}.`)
      onImported()
    } catch (e) { setError((e as Error).message); setProgress(null) }
  }
  async function downloadTemplate() {
    try {
      const url = URL.createObjectURL(await templateWorkbook())
      const a = document.createElement('a'); a.href = url; a.download = 'Cross reference template.xlsx'; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) { setError((e as Error).message) }
  }

  const mapped = prepared?.columns.filter((c) => c.field && c.field !== 'spec') || []
  const skipped = [...(prepared?.errors || []), ...(outcome?.skipped || [])]
  return (
    <div className="overlay">
      <section className="editor xr-panel" role="dialog" aria-modal="true" aria-label="Import parts">
        <header className="editor-head">
          <div><span className="eyebrow">CROSS REFERENCE</span><h2>Import parts</h2></div>
          <button className="icon-button" aria-label="Close" disabled={busy} onClick={onClose}><X size={20} /></button>
        </header>
        <div className="editor-body">
          <p className="sd-panel-note">Each row replaces that part number completely. Parts that are not in the file stay as they are.</p>
          <div className="xr-file-row">
            <label className="primary xr-file"><FileSpreadsheet size={15} /> {fileName ? 'Choose another file' : 'Choose file'}
              <input type="file" accept=".xlsx,.csv" disabled={busy} onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = '' }} /></label>
            <button className="secondary" type="button" onClick={() => void downloadTemplate()}><Download size={15} /> Template</button>
          </div>
          {reading && <p className="hint">Reading {fileName}…</p>}

          {prepared && (
            <>
              <div className="xr-block"><h4>{fileName}</h4>
                <dl className="xr-facts">
                  <div><dt>Parts to import</dt><dd>{prepared.rows.length.toLocaleString()}</dd></div>
                  <div><dt>Rows skipped</dt><dd>{prepared.errors.length}</dd></div>
                  <div><dt>Columns used</dt><dd>{mapped.length} + {prepared.specColumns} extra info</dd></div>
                </dl>
              </div>
              {prepared.rows.length > 0 && (
                <div className="xr-block"><h4>First rows</h4>
                  <div className="rfq-table-wrap"><table className="rfq-table xr-preview">
                    <thead><tr><th>Part number</th><th>Brand</th><th>Description</th><th>OE</th><th>Cross ref</th><th>Specs</th></tr></thead>
                    <tbody>{prepared.rows.slice(0, 5).map((r) => (
                      <tr key={r.sku}><td className="xr-sku">{r.sku}</td><td>{r.brand || '—'}</td><td>{r.description || r.title || '—'}</td>
                        <td>{r.oe_numbers.length}</td><td>{r.cross_numbers.length}</td><td>{r.specs.length}</td></tr>
                    ))}</tbody>
                  </table></div>
                </div>
              )}
              {prepared.warnings.length > 0 && (
                <div className="xr-block"><h4>Check</h4><ul className="xr-issues warn">{prepared.warnings.slice(0, 50).map((w, i) => (
                  <li key={i}>{w.row ? <b>Row {w.row}{w.sku ? ` · ${w.sku}` : ''}: </b> : null}{w.message}</li>
                ))}{prepared.warnings.length > 50 && <li>…and {prepared.warnings.length - 50} more</li>}</ul></div>
              )}
            </>
          )}

          {progress && (
            <div className="xr-block"><h4>{outcome ? 'Done' : 'Importing…'}</h4>
              <div className="xr-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
                <span style={{ width: `${progress.total ? (100 * progress.done) / progress.total : 100}%` }} /></div>
              {outcome && <p className="xr-done">{outcome.created.toLocaleString()} new parts, {outcome.replaced.toLocaleString()} replaced, {skipped.length} skipped.</p>}
            </div>
          )}
          {skipped.length > 0 && (
            <div className="xr-block"><h4>Skipped rows</h4><ul className="xr-issues">{skipped.slice(0, 100).map((w, i) => (
              <li key={i}>{w.row ? <b>Row {w.row}{w.sku ? ` · ${w.sku}` : ''}: </b> : null}{w.message}</li>
            ))}{skipped.length > 100 && <li>…and {skipped.length - 100} more</li>}</ul></div>
          )}

          {summary.imports.length > 0 && (
            <div className="xr-block"><h4>Recent imports</h4><ul className="xr-history">{summary.imports.map((i) => (
              <li key={i.id}><b>{i.file_name || 'Import'}</b><small>{new Date(i.at).toLocaleString()}{i.by ? ` · ${i.by}` : ''} · {i.created} new, {i.replaced} replaced{i.skipped ? `, ${i.skipped} skipped` : ''}{i.finished ? '' : ' · not finished'}</small></li>
            ))}</ul></div>
          )}
        </div>
        <footer className="editor-foot">
          <button className="secondary" disabled={busy} onClick={onClose}>{outcome ? 'Close' : 'Cancel'}</button>
          {!outcome && <button className="primary" disabled={busy || !prepared?.rows.length} onClick={() => void run()}>
            {progress ? `Importing ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}…` : `Import ${prepared?.rows.length ? prepared.rows.length.toLocaleString() + ' parts' : ''}`}</button>}
        </footer>
      </section>
    </div>
  )
}
