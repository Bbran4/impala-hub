// Report emails (one function: the Hobby plan allows 12 per deployment).
//   GET ?status=1          which settings are missing (names only, never values; no login needed)
//   GET/POST + CRON_SECRET  sends due report emails.
// Sends due report emails. Called every few minutes by Supabase (pg_cron + pg_net) with the
// CRON_SECRET. Claims one delivery at a time, draws each sheet in headless Chrome as the recipient
// (via a short-lived render ticket), and emails a picture plus a PDF per sheet over SMTP.
import { createClient } from '@supabase/supabase-js'
import nodemailer from 'nodemailer'
import type { Browser } from 'puppeteer-core'
import { emailBody, errorText, fileName, hubUrl, subjectFor, type AlertResult, type ClaimedDelivery, type RenderedSheet } from './_reportMail.js'
import { workbookBuffer, type ExcelTable } from './_excel.js'

const BUDGET_MS = 240_000 // stop claiming new work after this (functions may run 300 s)
const PER_DELIVERY_MS = 60_000

async function launch(): Promise<Browser> {
  const puppeteer = (await import('puppeteer-core')).default
  if (process.env.REPORT_CHROME_PATH) return puppeteer.launch({ executablePath: process.env.REPORT_CHROME_PATH, headless: true, args: ['--no-sandbox'] })
  const chromium = (await import('@sparticuz/chromium')).default
  return puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true })
}

async function renderSheet(browser: Browser, base: string, ticket: string, excel: boolean): Promise<{ png: Buffer; pdf: Buffer; tables: ExcelTable[] }> {
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 })
    await page.emulateMediaType('screen')
    await page.goto(`${base}/#report-print=${ticket}${excel ? '&excel=1' : ''}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForFunction(() => document.body.dataset.reportReady === '1' || Boolean(document.body.dataset.reportError), { timeout: 45_000 })
    const failure = await page.evaluate(() => document.body.dataset.reportError || '')
    if (failure) throw new Error(`The sheet could not be drawn: ${failure}`)
    const box = await page.evaluate(() => { const r = document.querySelector('.bi-print')!.getBoundingClientRect(); return { width: Math.ceil(r.width), height: Math.ceil(r.height) } })
    const png = Buffer.from(await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: box.width, height: box.height } }))
    const pdf = Buffer.from(await page.pdf({ width: `${box.width}px`, height: `${box.height + 2}px`, printBackground: true, pageRanges: '1' }))
    let tables: ExcelTable[] = []
    if (excel) {
      await page.waitForFunction(() => document.body.dataset.excelReady === '1', { timeout: 45_000 })
      tables = (await page.evaluate(() => (window as unknown as { __reportTables?: ExcelTable[] }).__reportTables || [])) as ExcelTable[]
    }
    return { png, pdf, tables }
  } finally {
    await page.close().catch(() => undefined)
  }
}

// Which report email settings are missing (names only, never values).
export function missingSettings(env: Record<string, string | undefined>) {
  const checks: [string, string[]][] = [
    ['SUPABASE_URL', ['SUPABASE_URL', 'VITE_SUPABASE_URL']],
    ['SUPABASE_SERVICE_ROLE_KEY', ['SUPABASE_SERVICE_ROLE_KEY']],
    ['CRON_SECRET', ['CRON_SECRET']],
    ['SMTP_HOST', ['SMTP_HOST']],
    ['REPORT_EMAIL_FROM', ['REPORT_EMAIL_FROM']],
    ['REPORT_HUB_URL', ['REPORT_HUB_URL', 'VERCEL_PROJECT_PRODUCTION_URL']],
  ]
  return checks.filter(([, names]) => !names.some((name) => env[name])).map(([label]) => label)
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ detail: 'Method not allowed' })
  const query = req.query || Object.fromEntries(new URL(req.url || '/', 'http://x').searchParams)
  if (req.method === 'GET' && query.status) {
    const missing = missingSettings(process.env)
    return res.status(200).json({ configured: missing.length === 0, missing })
  }
  const cronSecret = process.env.CRON_SECRET
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!cronSecret || supplied !== cronSecret) return res.status(401).json({ detail: 'Unauthorized scheduler request.' })
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const base = hubUrl(process.env)
  const from = process.env.REPORT_EMAIL_FROM
  const smtpHost = process.env.SMTP_HOST
  if (!url || !serviceKey || !base || !from || !smtpHost) return res.status(503).json({ detail: 'Report email configuration is incomplete.' })

  const started = Date.now()
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const port = Number(process.env.SMTP_PORT || 587)
  const transport = nodemailer.createTransport({
    host: smtpHost, port, secure: port === 465, requireTLS: port !== 465 && process.env.SMTP_REQUIRE_TLS !== 'false',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' } : undefined,
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  })
  const secrets = [serviceKey, cronSecret, process.env.SMTP_PASSWORD || '']
  const results: { delivery: string; status: string }[] = []
  let browser: Browser | null = null
  try {
    while (Date.now() - started < BUDGET_MS - PER_DELIVERY_MS) {
      const { data, error } = await admin.rpc('bi_report_claim', { p_limit: 1 })
      if (error) throw new Error(`Could not claim report emails: ${error.message}`)
      const claimed = (data || []) as ClaimedDelivery[]
      if (!claimed.length) break
      for (const delivery of claimed) {
        try {
          // alerts: check the condition as the recipient first; nothing to send when it is not met
          let alert: AlertResult | undefined
          if (delivery.kind === 'alert' && delivery.alert_ticket) {
            const { data: checked, error: alertError } = await admin.rpc('bi_render_alert', { p_ticket: delivery.alert_ticket })
            if (alertError) throw new Error(`Could not check the alert: ${alertError.message}`)
            alert = checked as AlertResult
            if (!alert.matched) {
              await admin.rpc('bi_report_finish', { p_delivery: delivery.delivery_id, p_status: 'not_needed' })
              results.push({ delivery: delivery.delivery_id, status: 'not_needed' })
              continue
            }
          }
          const rendered: (RenderedSheet & { tables: ExcelTable[] })[] = []
          if (delivery.sheets.length) {
            browser ??= await launch()
            for (const sheet of delivery.sheets) rendered.push({ title: sheet.title, ...(await renderSheet(browser, base, sheet.ticket, Boolean(delivery.attach_excel))) })
          }
          const images = rendered.map((sheet, i) => ({ title: sheet.title, cid: `sheet${i + 1}@impala-hub` }))
          const { html, text } = emailBody(delivery, images, `${base}/`, new Date(), alert)
          // Excel: every chart of every sheet (one tab each), plus the alert's rows
          const excelTables: ExcelTable[] = [
            ...(alert ? [{ title: 'Alert', headers: [...(alert.dimension ? [alert.dimension_label || alert.dimension] : []), alert.label], formats: [], rows: alert.rows }] : []),
            ...rendered.flatMap((sheet) => sheet.tables.map((table) => ({ ...table, title: rendered.length > 1 ? `${sheet.title} - ${table.title}` : table.title }))),
          ]
          const excel = delivery.attach_excel && excelTables.length ? Buffer.from(await workbookBuffer(excelTables)) : null
          await transport.sendMail({
            from, to: delivery.email, subject: subjectFor(delivery), html, text,
            attachments: [
              ...rendered.map((sheet, i) => ({ filename: fileName(delivery.app_name, sheet.title, 'png'), content: sheet.png, cid: images[i].cid, contentDisposition: 'inline' as const })),
              ...rendered.map((sheet) => ({ filename: fileName(delivery.app_name, sheet.title, 'pdf'), content: sheet.pdf, contentType: 'application/pdf' })),
              ...(excel ? [{ filename: fileName(delivery.app_name, delivery.schedule_name, 'xlsx'), content: excel, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }] : []),
            ],
          })
          await admin.rpc('bi_report_finish', { p_delivery: delivery.delivery_id, p_status: 'sent' })
          results.push({ delivery: delivery.delivery_id, status: 'sent' })
        } catch (sendError) {
          const message = errorText(sendError, secrets)
          // a recipient address the server refuses will not work on a retry either
          const final = /\b(550|551|553|554)\b|No recipients defined/i.test(message)
          await admin.rpc('bi_report_finish', { p_delivery: delivery.delivery_id, p_status: final ? 'failed' : 'retry', p_error: message })
          results.push({ delivery: delivery.delivery_id, status: final ? 'failed' : 'retry' })
          if (browser && /Target closed|Protocol error|browser has disconnected/i.test(message)) { await browser.close().catch(() => undefined); browser = null }
        }
      }
    }
  } catch (error) {
    return res.status(500).json({ detail: errorText(error, secrets), processed: results.length, results })
  } finally {
    if (browser) await browser.close().catch(() => undefined)
    transport.close()
  }
  return res.status(200).json({ processed: results.length, results })
}
