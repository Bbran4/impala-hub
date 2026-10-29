// Sends due report emails. Called every few minutes by Supabase (pg_cron + pg_net) with the
// CRON_SECRET. Claims one delivery at a time, draws each sheet in headless Chrome as the recipient
// (via a short-lived render ticket), and emails a picture plus a PDF per sheet over SMTP.
import { createClient } from '@supabase/supabase-js'
import nodemailer from 'nodemailer'
import type { Browser } from 'puppeteer-core'
import { emailBody, errorText, fileName, hubUrl, subjectFor, type ClaimedDelivery, type RenderedSheet } from './_reportMail.js'

const BUDGET_MS = 240_000 // stop claiming new work after this (functions may run 300 s)
const PER_DELIVERY_MS = 60_000

async function launch(): Promise<Browser> {
  const puppeteer = (await import('puppeteer-core')).default
  if (process.env.REPORT_CHROME_PATH) return puppeteer.launch({ executablePath: process.env.REPORT_CHROME_PATH, headless: true, args: ['--no-sandbox'] })
  const chromium = (await import('@sparticuz/chromium')).default
  return puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true })
}

async function renderSheet(browser: Browser, base: string, ticket: string): Promise<{ png: Buffer; pdf: Buffer }> {
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 })
    await page.emulateMediaType('screen')
    await page.goto(`${base}/#report-print=${ticket}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForFunction(() => document.body.dataset.reportReady === '1' || Boolean(document.body.dataset.reportError), { timeout: 45_000 })
    const failure = await page.evaluate(() => document.body.dataset.reportError || '')
    if (failure) throw new Error(`The sheet could not be drawn: ${failure}`)
    const box = await page.evaluate(() => { const r = document.querySelector('.bi-print')!.getBoundingClientRect(); return { width: Math.ceil(r.width), height: Math.ceil(r.height) } })
    const png = Buffer.from(await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: box.width, height: box.height } }))
    const pdf = Buffer.from(await page.pdf({ width: `${box.width}px`, height: `${box.height + 2}px`, printBackground: true, pageRanges: '1' }))
    return { png, pdf }
  } finally {
    await page.close().catch(() => undefined)
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ detail: 'Method not allowed' })
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
          browser ??= await launch()
          const rendered: RenderedSheet[] = []
          for (const sheet of delivery.sheets) rendered.push({ title: sheet.title, ...(await renderSheet(browser, base, sheet.ticket)) })
          const images = rendered.map((sheet, i) => ({ title: sheet.title, cid: `sheet${i + 1}@impala-hub` }))
          const { html, text } = emailBody(delivery, images, `${base}/`, new Date())
          await transport.sendMail({
            from, to: delivery.email, subject: subjectFor(delivery), html, text,
            attachments: [
              ...rendered.map((sheet, i) => ({ filename: fileName(delivery.app_name, sheet.title, 'png'), content: sheet.png, cid: images[i].cid, contentDisposition: 'inline' as const })),
              ...rendered.map((sheet) => ({ filename: fileName(delivery.app_name, sheet.title, 'pdf'), content: sheet.pdf, contentType: 'application/pdf' })),
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
