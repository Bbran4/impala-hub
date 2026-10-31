import { CHAT_COMMANDS } from './chatCommands'
export default function ChatCommandPicker({ onSelect }: { onSelect: (prefix: string) => void }) {
  return <section className="chat-command-picker" aria-label="Available chat commands">
    <h3>Commands</h3>
    <ul>{CHAT_COMMANDS.map(command => <li key={command.id}>
      <button type="button" disabled={!command.enabled} onClick={() => { if (command.enabled && command.prefix) onSelect(command.prefix) }}>
        <span><b>{command.label}</b>{command.prefix && <code>{command.prefix}</code>}</span>
        <small>{command.enabled ? 'Available' : 'Not available yet'}</small>
      </button>
    </li>)}</ul>
  </section>
}
