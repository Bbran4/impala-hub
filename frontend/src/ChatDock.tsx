import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, MessageCircle, Minus, Search, Send, X } from 'lucide-react'
import { supabase } from './supabase'

type Conversation = {
  conversation_id: string
  other_user_id: string
  other_display_name: string
  other_email: string
  other_avatar_url: string | null
  last_message: string | null
  last_message_at: string
  unread_count: number
}

type UserResult = {
  user_id: string
  display_name: string
  email: string
  avatar_url: string | null
}

type Message = {
  message_id: string
  conversation_id: string
  sender_id: string
  sender_name: string
  body: string
  created_at: string
}

type DockedChat = { conversationId: string; minimized: boolean }

type Props = {
  enabled: boolean
  openRequest: number
  onError: (message: string) => void
}

const personName = (person: { other_display_name?: string; display_name?: string; other_email?: string; email?: string }) =>
  person.other_display_name || person.display_name || person.other_email || person.email || 'Team member'

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?'

const shortTime = (value: string) => new Intl.DateTimeFormat(undefined, {
  hour: '2-digit', minute: '2-digit',
}).format(new Date(value))

export default function ChatDock({ enabled, openRequest, onError }: Props) {
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [docked, setDocked] = useState<DockedChat[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<UserResult[]>([])
  const [loading, setLoading] = useState(false)
  const bootstrapped = useRef(false)
  const unreadSeen = useRef<Record<string, number>>({})

  const loadConversations = useCallback(async (quiet = false) => {
    if (!enabled || !supabase) return
    if (!quiet) setLoading(true)
    const { data, error } = await supabase.rpc('chat_list_conversations')
    if (error) {
      if (!quiet) onError(`Could not load chats: ${error.message}`)
      setLoading(false)
      return
    }
    const rows = ((data || []) as Conversation[]).map((row) => ({ ...row, unread_count: Number(row.unread_count || 0) }))
    setConversations(rows)
    setDocked((current) => {
      const next = [...current]
      for (const row of rows) {
        const previousUnread = unreadSeen.current[row.conversation_id] || 0
        const shouldOpen = row.unread_count > 0 && (!bootstrapped.current || row.unread_count > previousUnread)
        if (shouldOpen && !next.some((chat) => chat.conversationId === row.conversation_id)) {
          next.push({ conversationId: row.conversation_id, minimized: false })
        }
      }
      return next
    })
    unreadSeen.current = Object.fromEntries(rows.map((row) => [row.conversation_id, row.unread_count]))
    bootstrapped.current = true
    setLoading(false)
  }, [enabled, onError])
  const refreshConversations = useCallback(() => { void loadConversations(true) }, [loadConversations])

  useEffect(() => {
    if (!enabled) {
      setLauncherOpen(false); setConversations([]); setDocked([]); setQuery(''); setResults([])
      bootstrapped.current = false; unreadSeen.current = {}
      return
    }
    void loadConversations(true)
    const timer = window.setInterval(() => void loadConversations(true), 8_000)
    const focus = () => void loadConversations(true)
    window.addEventListener('focus', focus)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', focus) }
  }, [enabled, loadConversations])

  useEffect(() => {
    if (!enabled || openRequest < 1) return
    setLauncherOpen(true)
    void loadConversations()
  }, [openRequest, enabled, loadConversations])

  useEffect(() => {
    if (!supabase || !launcherOpen) return
    const clean = query.trim()
    if (!clean) { setResults([]); return }
    const timer = window.setTimeout(async () => {
      const { data, error } = await supabase!.rpc('chat_search_users', { search_text: clean })
      if (error) onError(`Could not search users: ${error.message}`)
      else setResults((data || []) as UserResult[])
    }, 250)
    return () => window.clearTimeout(timer)
  }, [query, launcherOpen, onError])

  async function startChat(user: UserResult) {
    if (!supabase) return
    setLoading(true)
    const { data: conversationId, error } = await supabase.rpc('chat_open_direct', { other_user_id: user.user_id })
    if (error || !conversationId) {
      onError(`Could not open chat: ${error?.message || 'No conversation was returned.'}`)
      setLoading(false)
      return
    }
    await loadConversations(true)
    setConversations((current) => current.some((row) => row.conversation_id === conversationId) ? current : [{
      conversation_id: conversationId,
      other_user_id: user.user_id,
      other_display_name: user.display_name,
      other_email: user.email,
      other_avatar_url: user.avatar_url,
      last_message: null,
      last_message_at: new Date().toISOString(),
      unread_count: 0,
    }, ...current])
    setDocked((current) => current.some((chat) => chat.conversationId === conversationId)
      ? current.map((chat) => chat.conversationId === conversationId ? { ...chat, minimized: false } : chat)
      : [...current, { conversationId, minimized: false }])
    setLauncherOpen(false); setQuery(''); setResults([]); setLoading(false)
  }

  function openExisting(conversationId: string) {
    setDocked((current) => current.some((chat) => chat.conversationId === conversationId)
      ? current.map((chat) => chat.conversationId === conversationId ? { ...chat, minimized: false } : chat)
      : [...current, { conversationId, minimized: false }])
    setLauncherOpen(false)
  }

  const dockRows = useMemo(() => docked.map((chat) => ({
    ...chat,
    conversation: conversations.find((row) => row.conversation_id === chat.conversationId),
  })).filter((item) => item.conversation), [docked, conversations])

  if (!enabled) return null

  return <>
    {launcherOpen && <section className="chat-launcher" aria-label="Team chat">
      <header><div><span className="eyebrow">IMPALA HUB</span><h2>Team chat</h2></div><button className="icon-button" aria-label="Close chat list" onClick={() => setLauncherOpen(false)}><X size={18} /></button></header>
      <label className="chat-user-search"><Search size={16} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="@name or email" aria-label="Find a user by name or email" /></label>
      <div className="chat-launcher-list">
        {query.trim() ? results.length ? results.map((user) => <button key={user.user_id} className="chat-person-row" onClick={() => void startChat(user)}>
          <Avatar name={personName(user)} url={user.avatar_url} /><span><b>{personName(user)}</b><small>{user.email}</small></span><MessageCircle size={16} />
        </button>) : <div className="chat-empty">{loading ? 'Searching…' : 'No users match that name or email.'}</div>
        : conversations.length ? conversations.map((conversation) => <button key={conversation.conversation_id} className="chat-person-row" onClick={() => openExisting(conversation.conversation_id)}>
          <Avatar name={personName(conversation)} url={conversation.other_avatar_url} /><span><b>{personName(conversation)}</b><small>{conversation.last_message || conversation.other_email}</small></span>{conversation.unread_count > 0 && <em>{conversation.unread_count > 99 ? '99+' : conversation.unread_count}</em>}
        </button>) : <div className="chat-empty"><MessageCircle size={26} /><b>No chats yet</b><span>Type @ followed by a name or email to start one.</span></div>}
      </div>
    </section>}

    <div className="chat-dock" aria-label="Open chats">
      {dockRows.map(({ conversation, minimized }) => <ChatWindow
        key={conversation!.conversation_id}
        conversation={conversation!}
        minimized={minimized}
        onMinimize={() => setDocked((current) => current.map((chat) => chat.conversationId === conversation!.conversation_id ? { ...chat, minimized: !chat.minimized } : chat))}
        onClose={() => setDocked((current) => current.filter((chat) => chat.conversationId !== conversation!.conversation_id))}
        onChanged={refreshConversations}
        onError={onError}
      />)}
    </div>
  </>
}

function Avatar({ name, url }: { name: string; url?: string | null }) {
  return <span className="chat-avatar">{url ? <img src={url} alt="" /> : initials(name)}</span>
}

function ChatWindow({ conversation, minimized, onMinimize, onClose, onChanged, onError }: {
  conversation: Conversation
  minimized: boolean
  onMinimize: () => void
  onClose: () => void
  onChanged: () => void
  onError: (message: string) => void
}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const pendingMessageId = useRef<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const loadMessages = useCallback(async (quiet = false) => {
    if (!supabase || minimized) return
    const { data, error } = await supabase.rpc('chat_list_messages', { target_conversation_id: conversation.conversation_id })
    if (error) { if (!quiet) onError(`Could not load messages: ${error.message}`); return }
    setMessages((data || []) as Message[])
    if (document.visibilityState === 'visible' && document.hasFocus()) {
      await supabase.rpc('chat_mark_read', { target_conversation_id: conversation.conversation_id })
      onChanged()
    }
  }, [conversation.conversation_id, minimized, onChanged, onError])

  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getUser().then(({ data }) => setCurrentUserId(data.user?.id || null))
  }, [])

  useEffect(() => {
    if (minimized) return
    void loadMessages()
    const timer = window.setInterval(() => void loadMessages(true), 3_000)
    return () => window.clearInterval(timer)
  }, [minimized, loadMessages])

  useEffect(() => { if (!minimized) bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, minimized])

  async function send() {
    if (!supabase || !draft.trim() || sending) return
    setSending(true)
    const body = draft.trim()
    pendingMessageId.current ||= crypto.randomUUID()
    const { error } = await supabase.rpc('chat_send_message', { target_conversation_id: conversation.conversation_id, p_client_message_id: pendingMessageId.current, message_body: body })
    if (error) onError(`Could not send message: ${error.message}`)
    else { pendingMessageId.current = null; setDraft(''); await loadMessages(); onChanged() }
    setSending(false)
  }

  return <section className={`chat-window ${minimized ? 'minimized' : ''}`}>
    <header onDoubleClick={onMinimize}>
      <Avatar name={personName(conversation)} url={conversation.other_avatar_url} />
      <div><b>{personName(conversation)}</b><small>{conversation.other_email}</small></div>
      {conversation.unread_count > 0 && <em>{conversation.unread_count}</em>}
      <button className="icon-button" aria-label={minimized ? 'Restore chat' : 'Minimize chat'} onClick={onMinimize}>{minimized ? <ChevronDown size={16} /> : <Minus size={16} />}</button>
      <button className="icon-button" aria-label="Close chat" onClick={onClose}><X size={16} /></button>
    </header>
    {!minimized && <>
      <div className="chat-messages">
        {messages.length ? messages.map((message) => {
          const mine = message.sender_id === currentUserId
          return <div className={`chat-message ${mine ? 'mine' : 'theirs'}`} key={message.message_id}><span>{message.body}</span><time>{shortTime(message.created_at)}</time></div>
        }) : <div className="chat-empty"><MessageCircle size={24} /><span>This is the start of your chat with {personName(conversation)}.</span></div>}
        <div ref={bottomRef} />
      </div>
      <footer><textarea rows={1} maxLength={4000} value={draft} onChange={(event) => { pendingMessageId.current = null; setDraft(event.target.value) }} placeholder={`Message ${personName(conversation)}…`} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} /><button className="icon-button" disabled={!draft.trim() || sending} aria-label="Send message" onClick={() => void send()}><Send size={17} /></button></footer>
    </>}
  </section>
}
