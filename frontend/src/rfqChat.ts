export type RfqChatLink = { rfq_id?: string | null; rfq_no?: string | null }
export function parseRfqCommand(value: string): { rfqNo: string; body: string } | null {
  const match = /^\/(IMP\d{8,}(?:INV)?)\s+([\s\S]+)$/i.exec(value.trim())
  if (!match || !match[2].trim() || match[2].trim().length > 4000) return null
  return { rfqNo: match[1].toUpperCase(), body: match[2].trim() }
}
