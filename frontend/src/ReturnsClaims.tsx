import { useEffect, useState } from "react";
import { ClipboardList, Download, Eye, Plus, Trash2, X } from "lucide-react";
import { API, api, supabase, supabaseConfigured } from "./lib";
import { CLAIM_FILE_ACCEPT, validateClaimFiles } from './returnsAttachments';
import './returnsclaims.css';
import ReturnSupplierWorkflow from './ReturnSupplierWorkflow';
import { allowedClaimStatuses, validateClaimStatus, johannesburgDate, claimTiming, matchesClaimDates, summarizeClaims, claimReportRows, claimsCsv } from './returnsReporting';
const companies = ["Warehouse", "Eastrand", "Pretoria"],
  reasons = ["Core", "Goods Damaged", "Incorrect Goods Supplied", "Claim"],
  outcomes = ["Credit", "Replacement Part"],
  statuses = [
    "Waiting for Info from Customer",
    "Waiting for Reply from Supplier",
    "In Progress",
    "Completed",
    "Awaiting Pickup/dropoff at supplier",
    "Rejected",
  ];
type Props = {
  token: string;
  setNotice: (m: string) => void;
  setError: (m: string) => void;
};
async function req<T>(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (supabaseConfigured) return api(path, init) as Promise<T>;
  const h = new Headers(init?.headers || {});
  h.set("Authorization", `Bearer ${token}`);
  if (init?.body && !(init.body instanceof FormData))
    h.set("Content-Type", "application/json");
  let r;
  try {
    r = await fetch(API + path, { ...init, headers: h });
  } catch {
    throw new Error(`Cannot reach the Impala Hub API at ${API}.`);
  }
  const b = await r.json().catch(() => ({}));
  if (!r.ok)
    throw new Error(
      typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail || b),
    );
  return b;
}
export default function ReturnsClaims({ token, setNotice, setError }: Props) {
  const [rows, setRows] = useState<any[]>([]),
    [panel, setPanel] = useState(false),
    [readOnly, setReadOnly] = useState(false),
    [form, setForm] = useState<any>({}),
    [search, setSearch] = useState(""),
    [statusFilter, setStatusFilter] = useState(""),
    [outcomeFilter, setOutcomeFilter] = useState(""),
    [companyFilter, setCompanyFilter] = useState(""),
    [reasonFilter, setReasonFilter] = useState(""),
    [dateFrom, setDateFrom] = useState(''),
    [dateTo, setDateTo] = useState(''),
    [slaFilter, setSlaFilter] = useState(''),
    [today, setToday] = useState(johannesburgDate()),
    [originalRecord, setOriginalRecord] = useState<Record<string, any> | null>(null),
    [exporting, setExporting] = useState(false),
    [busy, setBusy] = useState(false),
    [detailLoading, setDetailLoading] = useState(false),
    [preview, setPreview] = useState<{ url: string; name: string; type: string } | null>(null);
  const statusReasonRequired = Boolean(originalRecord && form.status !== originalRecord.status &&
    (form.status === 'Rejected' || ['Completed','Rejected'].includes(originalRecord.status)));
  const blank = () => ({
    date: johannesburgDate(),
    company: "Warehouse",
    rfc_book_number: "",
    customer: "",
    contact_person: "",
    contact_number: "",
    invoice_number: "",
    invoice_date: johannesburgDate(),
    reason: "Core",
    part_number: "",
    description: "",
    qty: 1,
    outcome_request: null,
    returned_by: "",
    received_by: "",
    supplier_received: "No",
    comments: "",
    status: "In Progress",
    handover_method: 'Not required',
    handover_status: 'Not required',
    sla_days: 7,
    status_change_reason: '',
  });
  const load = async () => {
    try {
      setRows(await req<any[]>(token, "/api/returns-claims"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, [token]);
  useEffect(() => {
    const timer = window.setInterval(() => setToday(johannesburgDate()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  const open = async (row?: any) => {
    setReadOnly(false);
    setPreview(null);
    setForm(row ? { ...row } : blank());
    setOriginalRecord(row || null);
    setPanel(true);
    if (row?.id && supabaseConfigured) {
      setDetailLoading(true);
      try {
        const loaded = await req<any>(token, `/api/returns-claims/${row.id}`);
        setForm(loaded);
        setOriginalRecord(loaded);
      } catch (e) {
        setError((e as Error).message);
        setPanel(false);
      } finally {
        setDetailLoading(false);
      }
    } else setForm(row ? { ...row } : blank());
  };
  const openStored = async (a: any, download = false) => {
    if (!supabase || !a.storage_path) return;
    const imageWindow = !download && a.content_type?.startsWith('image/') ? window.open('about:blank', '_blank') : null;
    if (imageWindow) imageWindow.opener = null;
    try {
      const result = await supabase.storage.from('returns-claim-attachments').createSignedUrl(a.storage_path, 300, download ? { download: a.original_name } : undefined);
      if (result.error || !result.data?.signedUrl) throw new Error(result.error?.message || 'Unable to open attachment.');
      if (imageWindow) {
        imageWindow.location.href = result.data.signedUrl;
      } else if (!download && a.content_type?.startsWith('image/')) {
        throw new Error('Allow pop-ups for this site to open images in a new tab.');
      } else if (!download) {
        setPreview({ url: result.data.signedUrl, name: a.original_name, type: a.content_type });
      } else {
        const response = await fetch(result.data.signedUrl);
        if (!response.ok) throw new Error('Unable to download attachment.');
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a');
        link.href = url; link.download = a.original_name;
        document.body.appendChild(link); link.click(); link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) {
      imageWindow?.close();
      setError((e as Error).message);
    }
  };
  const deleteStored = async (attachment: any) => {
    if (!window.confirm(`Permanently delete ${attachment.original_name}? This removes the file and its database entry. The audit history is retained.`)) return;
    setBusy(true);
    try {
      await req(token, `/api/returns-claims/${form.id}/attachments/${attachment.id}`, { method: 'DELETE' });
      const updated = await req<any>(token, `/api/returns-claims/${form.id}`);
      setForm((current: any) => ({ ...current, stored_attachments: updated.stored_attachments, audit_history: updated.audit_history }));
      setPreview(null);
      setNotice('Attachment permanently deleted.');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const addFiles = async (selected: File[]) => {
    try {
      validateClaimFiles(selected, (form.stored_attachments || []).length + (form.attachments || []).length);
      const items = await Promise.all(selected.map(async file => {
        if (supabaseConfigured) return { name: file.name, size: file.size, type: file.type, file };
        const data_url = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Could not read file.'));
          reader.readAsDataURL(file);
        });
        return { name: file.name, size: file.size, type: file.type, data_url };
      }));
      setForm((current: any) => ({ ...current, attachments: [...(current.attachments || []), ...items] }));
    } catch (e) { setError((e as Error).message); }
  };
  const save = async () => {
    setBusy(true);
    try {
      const editing = Boolean(form.id);
      const files = (form.attachments || [])
        .filter((a: any) => a.file)
        .map((a: any) => a.file);
      const body = { ...form };
      if (supabaseConfigured) {
        validateClaimStatus(originalRecord, form);
        body.sla_days = Number(form.sla_days ?? 7);
        delete body.attachments;
        delete body.stored_attachments;
        delete body.audit_history;
        validateClaimFiles(files, (form.stored_attachments || []).length);
      }
      const saved: any = await req(
        token,
        editing ? `/api/returns-claims/${form.id}` : "/api/returns-claims",
        { method: editing ? "PATCH" : "POST", body: JSON.stringify(body) },
      );
      if (supabaseConfigured) {
        setOriginalRecord(saved);
        // Retain the saved ID and remove each successful file, making retries safe.
        setForm((current: any) => ({ ...current, id: saved.id, claim_no: saved.claim_no }));
        for (const file of files) {
          const fd = new FormData();
          fd.append("file", file);
          const attachment: any = await req(token, `/api/returns-claims/${saved.id}/attachments`, {
            method: "POST",
            body: fd,
          });
          setForm((current: any) => ({ ...current,
            stored_attachments: [...(current.stored_attachments || []), attachment],
            attachments: (current.attachments || []).filter((item: any) => item.file !== file),
          }));
        }
      }
      setPanel(false);
      setNotice("Returns & Claims record saved.");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const del = async (row: any) => {
    if (!confirm(`Delete ${row.claim_no || row.id}?`)) return;
    try {
      await req(token, `/api/returns-claims/${row.id}`, { method: "DELETE" });
      await load();
      setNotice("Record deleted.");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const q = search.toLowerCase();
  const visible = rows.filter(
    (r) =>
      (!q || Object.values(r).join(" ").toLowerCase().includes(q)) &&
      (!statusFilter || r.status === statusFilter) &&
      (!outcomeFilter ||
        (outcomeFilter === "__unknown"
          ? !r.outcome_request
          : r.outcome_request === outcomeFilter)) &&
      (!companyFilter || r.company === companyFilter) &&
      (!reasonFilter || r.reason === reasonFilter) &&
      !(dateFrom && dateTo && dateFrom > dateTo) &&
      matchesClaimDates(r, dateFrom, dateTo, slaFilter, today),
  );
  const reportSummary = summarizeClaims(visible, today);
  const filterDescription = `Claim date: ${dateFrom || 'Any'} to ${dateTo || 'Any'}; status: ${statusFilter || 'Any'}; outcome: ${outcomeFilter || 'Any'}; company: ${companyFilter || 'Any'}; reason: ${reasonFilter || 'Any'}; SLA: ${slaFilter || 'Any'}; search: ${search || 'None'}`;
  const exportReport = async (format: 'csv' | 'xlsx') => {
    setExporting(true);
    try {
      let blob: Blob;
      if (format === 'csv') blob = new Blob([claimsCsv(claimReportRows(visible, today))], { type: 'text/csv;charset=utf-8' });
      else {
        const { createClaimsWorkbook } = await import('./returnsExport');
        const bytes = await createClaimsWorkbook(visible, today, filterDescription);
        blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = `returns-claims-${today}.${format}`;
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`Exported ${visible.length} matching claims.`);
    } catch (e) { setError((e as Error).message); }
    finally { setExporting(false); }
  };
  const field = (n: string, l: string, type = "text", required = false) => (
    <label className="editor-field">
      <span>
        {l}
        {required && <b className="required-mark"> *</b>}
      </span>
      <input
        disabled={readOnly}
        type={type}
        value={form[n] ?? ""}
        onChange={(e) => setForm({ ...form, [n]: e.target.value })}
      />
    </label>
  );
  return (
    <section className="rfq-workspace">
      <div className="sd-session-bar">
        <button
          className="sd-create-button"
          aria-label="Create new Returns & Claims record"
          title="Create new record"
          onClick={() => open()}
        >
          <Plus size={18} />
        </button>
        <span>Returns & Claims workspace</span>
        <div className="sd-view-tabs">
          <button className="active">Returns & Claims</button>
        </div>
      </div>
      <div className="returns-report-summary" aria-label="Filtered claim report">
        <span><b>{reportSummary.total}</b> matching claims</span><span><b>{reportSummary.open}</b> open</span>
        <span><b>{reportSummary.overdue}</b> overdue</span><span><b>{reportSummary.dueSoon}</b> due within 2 days</span>
        <span><b>{reportSummary.completed}</b> completed</span><span><b>{reportSummary.rejected}</b> rejected</span>
        <span><b>{reportSummary.averageAge}</b> average age (days)</span><span><b>R{reportSummary.creditReceived.toFixed(2)}</b> credits received</span>
        <button className="secondary" disabled={exporting || !visible.length} onClick={() => void exportReport('csv')}><Download size={14} /> CSV</button>
        <button className="secondary" disabled={exporting || !visible.length} onClick={() => void exportReport('xlsx')}><Download size={14} /> XLSX report</button>
        <details className="claim-report-breakdown"><summary>Report breakdown</summary>
          <h4>By status</h4>{statuses.map(status => <span key={status}>{status}: <b>{visible.filter(row => row.status === status).length}</b> </span>)}
          <h4>By company</h4>{companies.map(company => <span key={company}>{company}: <b>{visible.filter(row => row.company === company).length}</b> </span>)}
        </details>
      </div>
      <div className="rfq-toolbar returns-claims-toolbar">
        <label>Claim date from<input type="date" value={dateFrom} max={dateTo || undefined} onChange={event => setDateFrom(event.target.value)} /></label>
        <label>Claim date to<input type="date" value={dateTo} min={dateFrom || undefined} onChange={event => setDateTo(event.target.value)} /></label>
        <label>SLA filter<select value={slaFilter} onChange={event => setSlaFilter(event.target.value)}>
          <option value="">All claims</option><option value="open">Open claims</option><option value="overdue">Overdue</option><option value="due-soon">Due within 2 days (including today)</option>
        </select></label>
        <button className="secondary" onClick={() => { setDateFrom(''); setDateTo(''); setSlaFilter(''); setSearch(''); setStatusFilter(''); setOutcomeFilter(''); setCompanyFilter(''); setReasonFilter(''); }}>Clear filters</button>
        <label className="rfq-search">
          Search Returns & Claims
          <input
            placeholder="RFC, customer, invoice, part number"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label>
          Filter by Status
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All statuses</option>
            {statuses.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Filter by Outcome Request
          <select
            value={outcomeFilter}
            onChange={(e) => setOutcomeFilter(e.target.value)}
          >
            <option value="">All outcomes</option>
            <option value="__unknown">Unknown</option>
            {outcomes.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Filter by Company
          <select
            value={companyFilter}
            onChange={(e) => setCompanyFilter(e.target.value)}
          >
            <option value="">All companies</option>
            {companies.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Filter by Reason for RFC
          <select
            value={reasonFilter}
            onChange={(e) => setReasonFilter(e.target.value)}
          >
            <option value="">All reasons</option>
            {reasons.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
      </div>
      {dateFrom && dateTo && dateFrom > dateTo && <p role="alert">The start date must be on or before the end date.</p>}
      <div className="rfq-table-wrap">
        <table className="rfq-table">
          <thead>
            <tr>
              <th>Reference</th>
              <th>Date</th>
              <th>Company</th>
              <th>RFC Book</th>
              <th>Customer</th>
              <th>Part Number</th>
              <th>Qty</th>
              <th>Status</th>
              <th>Age / SLA</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr className="rfq-data-row" key={r.id}>
                <td>{r.claim_no || r.id}</td>
                <td>{r.date}</td>
                <td>{r.company}</td>
                <td>{r.rfc_book_number}</td>
                <td>{r.customer}</td>
                <td>{r.part_number}</td>
                <td>{r.qty}</td>
                <td>{r.status}</td>
                <td><span className={`claim-sla ${claimTiming(r, today).tone}`}>{claimTiming(r, today).label}</span><small className="claim-sla-detail">{claimTiming(r, today).age_days} days old · due {claimTiming(r, today).due_on}</small></td>
                <td className="sd-actions-cell">
                  <button className="secondary" onClick={() => open(r)}>
                    View
                  </button>
                  <button className="secondary" onClick={() => void del(r)}>
                    <Trash2 size={14} /> Delete
                  </button>
                </td>
              </tr>
            ))}
            {!visible.length && (
              <tr>
                <td colSpan={10}>
                  <div className="rfq-empty">
                    <ClipboardList size={28} />
                    <h3>No records found</h3>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {panel && (
        <div
          className="overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPanel(false);
          }}
        >
          <section className="editor" role="dialog" aria-modal="true">
            <header className="editor-head">
              <div>
                <span className="eyebrow">
                  {form.id ? "RETURNS & CLAIMS" : "NEW RETURNS & CLAIMS"}
                </span>
                <h2>{form.claim_no || form.id || "New Record"}</h2>
              </div>
              <button className="icon-button" onClick={() => setPanel(false)}>
                <X size={20} />
              </button>
            </header>
            <div className="editor-body">
              <div className="editor-section">
                <h3>Return Details</h3>
                {field("date", "Date", "date", true)}
                <label className="editor-field">
                  <span>
                    Company<b className="required-mark"> *</b>
                  </span>
                  <select
                    disabled={readOnly}
                    value={form.company}
                    onChange={(e) =>
                      setForm({ ...form, company: e.target.value })
                    }
                  >
                    {companies.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </label>
                {field("rfc_book_number", "RFC Book Number", "text", true)}
                {field("customer", "Customer", "text", true)}
                {field("contact_person", "Contact Person", "text", true)}
                {field("contact_number", "Contact Number", "text", true)}
                {field("invoice_number", "Invoice Number", "text", true)}
                {field("invoice_date", "Invoice Date", "date", true)}
                <label className="editor-field">
                  <span>
                    Reason for RFC<b className="required-mark"> *</b>
                  </span>
                  <select
                    disabled={readOnly}
                    value={form.reason}
                    onChange={(e) =>
                      setForm({ ...form, reason: e.target.value })
                    }
                  >
                    {reasons.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </label>
                {field("part_number", "Part Number", "text", true)}
                {field("description", "Description", "text", true)}
                {field("qty", "Qty", "number", true)}
              </div>
              <div className="editor-section">
                <h3>Attachments</h3>
                <p className="hint">Up to 10 files per claim, 15 MB each. JPEG, PNG, GIF, WebP, PDF, Word and Excel.</p>
                <label className="editor-field">
                  <span>Add attachments</span>
                  <input
                    type="file"
                    multiple
                    accept={CLAIM_FILE_ACCEPT}
                    disabled={busy || detailLoading}
                    onChange={(e) => {
                      const files = Array.from(e.target.files || []);
                      void addFiles(files);
                      e.target.value = '';
                    }}
                  />
                </label>
                {(form.stored_attachments || []).map((a: any) => (
                  <div className="attachment-row" key={a.id}>
                    <span>{a.original_name}</span>
                    <small>{Math.round(a.size / 1024)} KB · {a.uploader_name || 'Employee'} · {new Date(a.created_at).toLocaleString()}</small>
                    {(a.content_type?.startsWith('image/') || a.content_type === 'application/pdf') && <button type="button" className="secondary" onClick={() => void openStored(a)}><Eye size={14} /> Preview</button>}
                    <button type="button" className="secondary" onClick={() => void openStored(a, true)}><Download size={14} /> Download</button>
                    <button type="button" className="secondary" disabled={busy || detailLoading} onClick={() => void deleteStored(a)}><Trash2 size={14} /> Delete</button>
                  </div>
                ))}
                {preview && <div className="claim-attachment-preview">
                  <div><b>{preview.name}</b><button type="button" className="secondary" onClick={() => setPreview(null)}>Close preview</button></div>
                  {preview.type === 'application/pdf' ? <iframe title={`Preview of ${preview.name}`} src={preview.url} /> : <img src={preview.url} alt={preview.name} />}
                  <p className="hint">If the preview expires or your browser cannot display it, reopen it or use Download.</p>
                </div>}
                {(form.attachments || []).map((a: any, i: number) => (
                  <div className="attachment-row" key={a.name + i}>
                    {a.data_url ? <a href={a.data_url} download={a.name}>{a.name}</a> : <span>{a.name}</span>}
                    <small>
                      {a.size
                        ? `${Math.round(a.size / 1024)} KB · pending upload`
                        : ""}
                    </small>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        setForm({
                          ...form,
                          attachments: form.attachments.filter(
                            (_: any, j: number) => j !== i,
                          ),
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              <div className="editor-section">
                <h3>Outcome</h3>
                <label className="editor-field">
                  <span>Outcome Request</span>
                  <select
                    disabled={readOnly}
                    value={form.outcome_request || ""}
                    onChange={(e) =>
                      setForm({ ...form, outcome_request: e.target.value })
                    }
                  >
                    <option value="">Unknown / not decided</option>
                    {outcomes.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </label>
                {field("returned_by", "Returned by")}
                {field("received_by", "Received By")}
                <label className="editor-field">
                  <span>Credit/Replacement Received from Supplier {supabaseConfigured && '(tracked below)'}</span>
                  <input
                    disabled={readOnly || supabaseConfigured}
                    type="checkbox"
                    checked={!!form.credit_received_on || !!form.replacement_received_on || form.supplier_received === "Yes"}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        supplier_received: e.target.checked ? "Yes" : "No",
                      })
                    }
                  />
                </label>
                <label className="editor-field">
                  <span>Comments</span>
                  <textarea
                    disabled={readOnly}
                    rows={5}
                    value={form.comments}
                    onChange={(e) =>
                      setForm({ ...form, comments: e.target.value })
                    }
                  />
                </label>
                <label className="editor-field">
                  <span>
                    Status<b className="required-mark"> *</b>
                  </span>
                  <select
                    disabled={readOnly}
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value, status_change_reason: '' })}
                  >
                    {(supabaseConfigured ? allowedClaimStatuses(originalRecord?.status) : statuses).map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </label>
                {supabaseConfigured && <>
                  <label className="editor-field"><span>Reason for rejection / reopening{statusReasonRequired && <b className="required-mark"> *</b>}</span><textarea disabled={busy || detailLoading || !statusReasonRequired} value={form.status_change_reason || ''} onChange={event => setForm({ ...form, status_change_reason: event.target.value })} /></label>
                  <label className="editor-field"><span>SLA target (calendar days)</span><input type="number" min="1" max="365" disabled={busy || detailLoading} value={form.sla_days ?? 7} onChange={event => setForm({ ...form, sla_days: event.target.value })} /></label>
                  {form.date && <p><b>{claimTiming(form, today).label}</b> · {claimTiming(form, today).age_days} calendar days old · due {claimTiming(form, today).due_on}</p>}
                  <p className="hint">Default: 7 calendar days from the claim date. Warning in the final 2 days. Closed-claim age stops at closure. Reopen closed claims to In Progress and record a reason.</p>
                </>}
              </div>
              {supabaseConfigured && <ReturnSupplierWorkflow form={form} disabled={busy || detailLoading || readOnly} onChange={changes => setForm((current: any) => ({ ...current, ...changes }))} />}
              {form.id && <div className="editor-section sd-history">
                <h3>Record history</h3>
                {detailLoading ? <p>Loading history…</p> : !(form.audit_history || []).length ? <p>No history recorded.</p> : form.audit_history.map((h: any) => <p key={h.id}>
                  <b>{new Date(h.created_at).toLocaleString()}</b> · {h.actor_name || 'Former employee'} · {h.action.replaceAll('_', ' ')}
                  {h.changes?.file && <span> · {h.changes.file}</span>}
                  {h.changes?.changed?.length > 0 && <span> · Fields: {h.changes.changed.map((field: string) => field.replaceAll('_', ' ')).join(', ')}</span>}
                  {h.action === 'supplier_workflow_updated' && <span> · {Object.entries(h.changes || {}).map(([field, change]: [string, any]) => `${field.replaceAll('_', ' ')}: ${change.from ?? '—'} → ${change.to ?? '—'}`).join('; ')}</span>}
                  {(h.action === 'status_changed' || h.action === 'sla_changed') && <span> · {h.changes.from} → {h.changes.to}{h.changes.reason ? ` · ${h.changes.reason}` : ''}</span>}
                </p>)}
              </div>}
            </div>
            <footer className="editor-foot">
              <button className="secondary" onClick={() => setPanel(false)}>
                {readOnly ? "Close" : "Cancel"}
              </button>
              <button
                className="primary"
                disabled={busy || detailLoading}
                onClick={() => void save()}
              >
                {busy ? "Saving…" : form.id ? "Save changes" : "Save"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
