// Pure helpers for report emails (tested in tests/reportMail.test.mjs).

export type ClaimedSheet = { sheet_id: string; title: string; ticket: string }
export type ClaimedDelivery = {
  delivery_id: string; email: string; recipient_name: string | null; app_id: string; app_name: string
  schedule_name: string; subject: string; message: string; is_test: boolean; attempt: number; sheets: ClaimedSheet[]
  kind?: 'report' | 'alert'; attach_excel?: boolean; alert_ticket?: string | null
}
// What bi_render_alert returns: the rows that meet the alert's condition
export type AlertResult = { matched: boolean; rows: (string | number | boolean | null)[][]; measure: string; dimension: string | null; op: string; value: number; label: string; dimension_label: string | null }
export type RenderedSheet = { title: string; png: Buffer; pdf: Buffer }

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// Safe, readable attachment names: "Sales - Overview.pdf"
export function fileName(appName: string, title: string, extension: string) {
  const clean = `${appName} - ${title}`.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
  return `${clean || 'Report'}.${extension}`
}

export function subjectFor(delivery: ClaimedDelivery) {
  const subject = delivery.subject.trim() || `${delivery.app_name}: ${delivery.schedule_name}`
  return (delivery.is_test ? `[Test] ${subject}` : subject).replace(/[\r\n]+/g, ' ').slice(0, 200)
}

// The hub's address for links and for headless Chrome; must be https (or localhost for testing).
export function hubUrl(env: Record<string, string | undefined>) {
  const raw = env.REPORT_HUB_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '')
  const url = raw.replace(/\/+$/, '')
  if (!/^https:\/\/[^/\s]+$/.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) return null
  return url
}

const formatNumber = (value: unknown) => typeof value === 'number' ? value.toLocaleString('en-ZA', { maximumFractionDigits: 2 }) : value === null || value === undefined ? '' : String(value)
const OPS: Record<string, string> = { '>': 'above', '>=': 'at least', '<': 'below', '<=': 'at most', '=': 'equal to', '<>': 'not equal to' }

// The alert's condition in words: "Short by is above 0"
export function alertSentence(alert: AlertResult) {
  return `${alert.label} is ${OPS[alert.op] || alert.op} ${formatNumber(alert.value)}`
}

function alertHtml(alert: AlertResult) {
  const head = alert.dimension ? `<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #dfe6ec">${escapeHtml(alert.dimension_label || alert.dimension)}</th>` : ''
  const rows = alert.rows.slice(0, 200).map((row, i) => `<tr style="background:${i % 2 ? '#f7f9fa' : '#ffffff'}">${row.map((cell, c) =>
    `<td style="padding:6px 10px;border-bottom:1px solid #eef2f5;${c === row.length - 1 ? 'text-align:right;font-weight:bold' : ''}">${escapeHtml(formatNumber(cell))}</td>`).join('')}</tr>`).join('')
  return `<tr><td style="padding:10px 22px 4px"><div style="background:#fff8e8;border:1px solid #f0d58c;border-radius:8px;padding:10px 12px;font-size:14px">
<b>Alert:</b> ${escapeHtml(alertSentence(alert))}${alert.dimension ? ` for ${alert.rows.length}${alert.rows.length >= 200 ? '+' : ''} ${escapeHtml(alert.dimension_label || alert.dimension)} value${alert.rows.length === 1 ? '' : 's'}` : ''}.</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-top:10px;font-size:13px"><tr>${head}<th style="text-align:right;padding:6px 10px;border-bottom:2px solid #dfe6ec">${escapeHtml(alert.label)}</th></tr>${rows}</table></td></tr>`
}

export function emailBody(delivery: ClaimedDelivery, sheets: { title: string; cid: string }[], link: string, sentAt: Date, alert?: AlertResult) {
  const when = sentAt.toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
  const greeting = delivery.recipient_name ? `Hi ${delivery.recipient_name.split(/\s+/)[0]},` : 'Hi,'
  const message = delivery.message.trim()
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1c2f41">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8"><tr><td align="center" style="padding:20px 10px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:1000px;background:#ffffff;border-radius:10px;overflow:hidden">
<tr><td style="background:#16324a;padding:16px 22px;color:#ffffff"><div style="font-size:12px;letter-spacing:1px;color:#e7b94f;font-weight:bold">IMPALA HUB · REPORTING</div>
<div style="font-size:20px;font-weight:bold;margin-top:4px">${escapeHtml(delivery.app_name)}</div><div style="font-size:13px;color:#b8c7d3">${escapeHtml(delivery.schedule_name)} · ${escapeHtml(when)}</div></td></tr>
<tr><td style="padding:18px 22px 6px;font-size:14px;line-height:1.5"><p style="margin:0 0 8px">${escapeHtml(greeting)}</p>
${message ? `<p style="margin:0 0 8px;white-space:pre-line">${escapeHtml(message)}</p>` : ''}
${sheets.length ? `<p style="margin:0 0 4px;color:#526170">${sheets.length === 1 ? 'The sheet is' : 'The sheets are'} below and attached as PDF${delivery.attach_excel ? ', with the data in Excel' : ''}. They show the data you have access to.</p>` : ''}</td></tr>
${alert ? alertHtml(alert) : ''}
${sheets.map((s) => `<tr><td style="padding:14px 22px 4px"><div style="font-size:15px;font-weight:bold;margin-bottom:8px">${escapeHtml(s.title)}</div>
<img src="cid:${s.cid}" alt="${escapeHtml(s.title)}" width="956" style="width:100%;max-width:956px;height:auto;border:1px solid #e1e7ec;border-radius:6px;display:block"></td></tr>`).join('\n')}
<tr><td style="padding:18px 22px 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#1d4668;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:7px;font-weight:bold;font-size:14px">Open in Impala Hub</a>
<p style="font-size:11px;color:#8a969f;margin:16px 0 0">You get this email because a report builder added you to "${escapeHtml(delivery.schedule_name)}". Ask them to change or stop it.</p></td></tr>
</table></td></tr></table></body></html>`
  const text = [greeting, '', message, message ? '' : null, `${delivery.app_name} — ${delivery.schedule_name} (${when})`,
    alert ? `Alert: ${alertSentence(alert)}` : null,
    ...(alert ? alert.rows.slice(0, 50).map((row) => '  ' + row.map(formatNumber).join(': ')) : []),
    sheets.length ? `Attached: ${sheets.map((s) => s.title).join(', ')}` : null, '', `Open in Impala Hub: ${link}`].filter((line) => line !== null).join('\n')
  return { html, text }
}

// Short, safe error text for the send history (no addresses or secrets).
export function errorText(error: unknown, secrets: string[]) {
  let text = error instanceof Error ? error.message : String(error)
  for (const secret of secrets) if (secret && secret.length > 3) text = text.split(secret).join('***')
  return text.replace(/\s+/g, ' ').slice(0, 500) || 'Sending failed'
}
