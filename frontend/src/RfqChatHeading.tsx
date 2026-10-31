import type { RfqChatLink } from './rfqChat'
export default function RfqChatHeading({ message, onOpenRfq }: { message: RfqChatLink; onOpenRfq?: (id: string) => void }) {
  if (!message.rfq_id || !message.rfq_no) return null
  return <button className="rfq-chat-link" disabled={!onOpenRfq} onClick={() => onOpenRfq?.(message.rfq_id!)}>{message.rfq_no} Update</button>
}
