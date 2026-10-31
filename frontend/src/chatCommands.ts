export type ChatCommand = { id: string; label: string; prefix?: string; enabled: boolean }
export const CHAT_COMMANDS: readonly ChatCommand[] = [
  { id: 'rfq', label: 'RFQ update', prefix: '/IMP', enabled: true },
  { id: 'claims', label: 'Claims', enabled: false },
  { id: 'parts', label: 'Parts query', enabled: false },
]
export function chatInputMode(value: string): 'people' | 'commands' | 'rfq' {
  const input = value.trimStart()
  if (!input.startsWith('/')) return 'people'
  return /^\/IMP(?=\d|\s|$)/i.test(input) ? 'rfq' : 'commands'
}
