import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, CheckCheck, ChevronDown, FileText, MessageCircle, Minus, Paperclip, Search, Send, X } from 'lucide-react'
import { supabase } from './supabase'

type Conversation = {
  conversation_id: string
  other_user_id: string
  other_display_name: string
  other_email: string
  other_avatar_url: string | null
  other_is_online: boolean
  last_message: string | null
  last_message_at: string
  unread_count: number
}

type UserResult = {
  user_id: string
  display_name: string
  email: string
  avatar_url: string | null
  is_online: boolean
}

type Message = {
  message_id: string
  conversation_id: string
  sender_id: string
  sender_name: string
  body: string
  created_at: string
  read_by_recipient: boolean
  attachments: Attachment[]
}
type Attachment = { id: string; file_name: string; content_type: string; size_bytes: number; storage_path: string; created_at: string }

type DockedChat = { conversationId: string; minimized: boolean }

type Props = {
  enabled: boolean
  openRequest: number
  onError: (message: string) => void
  onOpenChannels?: () => void
}

const personName = (person: { other_display_name?: string; display_name?: string; other_email?: string; email?: string }) =>
  person.other_display_name || person.display_name || person.other_email || person.email || 'Team member'

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?'

const shortTime = (value: string) => new Intl.DateTimeFormat(undefined, {
  hour: '2-digit', minute: '2-digit',
}).format(new Date(value))

export default function ChatDock({ enabled, openRequest, onError, onOpenChannels }: Props) {
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [docked, setDocked] = useState<DockedChat[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<UserResult[]>([])
  const [loading, setLoading] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const dismissedUnread = useRef<Record<string, number>>({})
  const hadLoadError = useRef(false)
  const active = enabled && authenticated

  useEffect(() => {
    if (!enabled || !supabase) { setAuthenticated(false); return }
    let mounted = true
    void supabase.auth.getSession().then(({ data }) => {
      if (mounted) setAuthenticated(Boolean(data.session))
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (mounted) setAuthenticated(Boolean(session))
    })
    return () => { mounted = false; listener.subscription.unsubscribe() }
  }, [enabled])

  const loadConversations = useCallback(async (quiet = false) => {
    if (!active || !supabase) return
    if (!quiet) setLoading(true)
    const { data, error } = await supabase.rpc('chat_list_conversations')
    if (error) {
      hadLoadError.current = true
      if (!quiet) onError(`Could not load chats: ${error.message}`)
      setLoading(false)
      return
    }
    if (hadLoadError.current) { hadLoadError.current = false; onError('') }
    const rows = ((data || []) as Conversation[]).map((row) => ({ ...row, unread_count: Number(row.unread_count || 0) }))
    setConversations(rows)
    setDocked((current) => {
      const next = [...current]
      for (const row of rows) {
        if (row.unread_count === 0) delete dismissedUnread.current[row.conversation_id]
        const dismissedAt = dismissedUnread.current[row.conversation_id] || 0
        const shouldDock = row.unread_count > dismissedAt
        if (shouldDock && !next.some((chat) => chat.conversationId === row.conversation_id)) {
          next.push({ conversationId: row.conversation_id, minimized: true })
        }
      }
      return next
    })
    setLoading(false)
  }, [active, onError])
  const refreshConversations = useCallback(() => { void loadConversations(true) }, [loadConversations])

  useEffect(() => {
    if (!active) {
      setLauncherOpen(false); setConversations([]); setDocked([]); setQuery(''); setResults([])
      dismissedUnread.current = {}
      return
    }
    void loadConversations()
    const timer = window.setInterval(() => void loadConversations(true), 8_000)
    const focus = () => void loadConversations(true)
    window.addEventListener('focus', focus)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', focus) }
  }, [active, loadConversations])

  useEffect(() => {
    if (!active || openRequest < 1) return
    setLauncherOpen(true)
    void loadConversations()
  }, [openRequest, active, loadConversations])

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
      other_is_online: user.is_online,
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
    delete dismissedUnread.current[conversationId]
    setDocked((current) => current.some((chat) => chat.conversationId === conversationId)
      ? current.map((chat) => chat.conversationId === conversationId ? { ...chat, minimized: false } : chat)
      : [...current, { conversationId, minimized: false }])
    setLauncherOpen(false)
  }

  const dockRows = useMemo(() => docked.map((chat) => ({
    ...chat,
    conversation: conversations.find((row) => row.conversation_id === chat.conversationId),
  })).filter((item) => item.conversation), [docked, conversations])

  if (!active) return null

  return <>
    {launcherOpen && <section className="chat-launcher" aria-label="Team chat">
      <header><div><span className="eyebrow">IMPALA HUB</span><h2>Team chat</h2></div><div className="chat-launcher-actions">{onOpenChannels && <button className="secondary" onClick={() => { setLauncherOpen(false); onOpenChannels() }}>Channels</button>}<button className="icon-button" aria-label="Close chat list" onClick={() => setLauncherOpen(false)}><X size={18} /></button></div></header>
      <label className="chat-user-search"><Search size={16} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="@name or email" aria-label="Find a user by name or email" /></label>
      <div className="chat-launcher-list">
        {query.trim() ? results.length ? results.map((user) => <button key={user.user_id} className="chat-person-row" onClick={() => void startChat(user)}>
          <Avatar name={personName(user)} url={user.avatar_url} /><span><b>{personName(user)} <Presence online={user.is_online} /></b><small>{user.email}</small></span><MessageCircle size={16} />
        </button>) : <div className="chat-empty">{loading ? 'Searching…' : 'No users match that name or email.'}</div>
        : conversations.length ? conversations.map((conversation) => <button key={conversation.conversation_id} className="chat-person-row" onClick={() => openExisting(conversation.conversation_id)}>
          <Avatar name={personName(conversation)} url={conversation.other_avatar_url} /><span><b>{personName(conversation)} <Presence online={conversation.other_is_online} /></b><small>{conversation.last_message || conversation.other_email}</small></span>{conversation.unread_count > 0 && <em>{conversation.unread_count > 99 ? '99+' : conversation.unread_count}</em>}
        </button>) : <div className="chat-empty"><MessageCircle size={26} /><b>No chats yet</b><span>Type @ followed by a name or email to start one.</span></div>}
      </div>
    </section>}

    <div className="chat-dock" aria-label="Open chats">
      {dockRows.map(({ conversation, minimized }) => <ChatWindow
        key={conversation!.conversation_id}
        conversation={conversation!}
        minimized={minimized}
        onMinimize={() => setDocked((current) => current.map((chat) => chat.conversationId === conversation!.conversation_id ? { ...chat, minimized: !chat.minimized } : chat))}
        onClose={() => {
          dismissedUnread.current[conversation!.conversation_id] = conversation!.unread_count
          setDocked((current) => current.filter((chat) => chat.conversationId !== conversation!.conversation_id))
        }}
        onChanged={refreshConversations}
        onError={onError}
      />)}
    </div>
  </>
}

function Avatar({ name, url }: { name: string; url?: string | null }) {
  return <span className="chat-avatar">{url ? <img src={url} alt="" /> : initials(name)}</span>
}

function Presence({ online }: { online: boolean }) {
  return <i className={`chat-presence ${online ? 'online' : 'offline'}`} title={online ? 'Online' : 'Offline'} aria-label={online ? 'Online' : 'Offline'} />
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
  const [files, setFiles] = useState<File[]>([])
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const pendingMessageId = useRef<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const loadMessages = useCallback(async (quiet = false) => {
    if (!supabase || minimized) return
    const { data, error } = await supabase.rpc('chat_list_messages', { target_conversation_id: conversation.conversation_id })
    if (error) { if (!quiet) onError(`Could not load messages: ${error.message}`); return }
    setMessages((data || []) as Message[])
    onChanged()
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
    if (!supabase || (!draft.trim() && !files.length) || sending || !currentUserId) return
    setSending(true)
    const pendingFiles = files
    const body = draft.trim() || `Attachments: ${pendingFiles.map((file) => file.name).join(', ')}`
    pendingMessageId.current ||= crypto.randomUUID()
    const { data: messageId, error } = await supabase.rpc('chat_send_message', { target_conversation_id: conversation.conversation_id, p_client_message_id: pendingMessageId.current, message_body: body })
    if (error) onError(`Could not send message: ${error.message}`)
    else {
      for (const file of pendingFiles) {
        const path = `${currentUserId}/${messageId}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
        const upload = await supabase.storage.from('chat-attachments').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false })
        if (upload.error) { onError(`Could not upload ${file.name}: ${upload.error.message}`); continue }
        const saved = await supabase.rpc('chat_add_attachment', { p_direct_message_id: messageId, p_channel_message_id: null, p_storage_path: path, p_file_name: file.name, p_content_type: file.type, p_size_bytes: file.size })
        if (saved.error) onError(`Could not save ${file.name}: ${saved.error.message}`)
      }
      pendingMessageId.current = null; setDraft(''); setFiles([]); await loadMessages(); onChanged()
    }
    setSending(false)
  }

  function chooseFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files || [])
    if (selected.some((file) => file.size > 25 * 1024 * 1024)) { onError('Chat attachments must be 25 MB or smaller.'); return }
    if (files.length + selected.length > 5) { onError('A chat message can contain no more than 5 attachments.'); return }
    setFiles((current) => [...current, ...selected])
    event.target.value = ''
  }

  return <section className={`chat-window ${minimized ? 'minimized' : ''}`}>
    <header onDoubleClick={onMinimize}>
      <Avatar name={personName(conversation)} url={conversation.other_avatar_url} />
      <div><b>{personName(conversation)} <Presence online={conversation.other_is_online} /></b><small>{conversation.other_email}</small></div>
      {conversation.unread_count > 0 && <em>{conversation.unread_count}</em>}
      <button className="icon-button" aria-label={minimized ? 'Restore chat' : 'Minimize chat'} onClick={onMinimize}>{minimized ? <ChevronDown size={16} /> : <Minus size={16} />}</button>
      <button className="icon-button" aria-label="Close chat" onClick={onClose}><X size={16} /></button>
    </header>
    {!minimized && <>
      <div className="chat-messages">
        {messages.length ? messages.map((message) => {
          const mine = message.sender_id === currentUserId
          return <div className={`chat-message ${mine ? 'mine' : 'theirs'}`} key={message.message_id}><span>{message.body}{message.attachments?.length > 0 && <span className="chat-attachments">{message.attachments.map((attachment) => <ChatAttachment key={attachment.id} attachment={attachment} />)}</span>}</span><time>{shortTime(message.created_at)}{mine && <span className="chat-delivery" title={message.read_by_recipient ? 'Read' : 'Sent'}>{message.read_by_recipient ? <CheckCheck size={12} /> : <Check size={12} />}</span>}</time></div>
        }) : <div className="chat-empty"><MessageCircle size={24} /><span>This is the start of your chat with {personName(conversation)}.</span></div>}
        <div ref={bottomRef} />
      </div>
      <footer><div className="chat-compose"><label className="icon-button" aria-label="Attach files" title="Attach files"><Paperclip size={17} /><input type="file" multiple onChange={chooseFiles} /></label>{files.length > 0 && <div className="chat-file-chips">{files.map((file, index) => <button key={`${file.name}-${index}`} onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>{file.name} ×</button>)}</div>}<textarea rows={1} maxLength={4000} value={draft} onChange={(event) => { pendingMessageId.current = null; setDraft(event.target.value) }} placeholder={`Message ${personName(conversation)}…`} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} /><button className="icon-button" disabled={(!draft.trim() && !files.length) || sending} aria-label="Send message" onClick={() => void send()}><Send size={17} /></button></div></footer>
    </>}
  </section>
}

function ChatAttachment({ attachment }: { attachment: Attachment }) {
  const [url, setUrl] = useState('')
  useEffect(() => { if (!supabase) return; void supabase.storage.from('chat-attachments').createSignedUrl(attachment.storage_path, 3600).then(({ data }) => { if (data?.signedUrl) setUrl(data.signedUrl) }) }, [attachment.storage_path])
  if (!url) return <span className="chat-attachment-loading"><FileText size={13} /> {attachment.file_name}</span>
  return <a className="chat-attachment" href={url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>{attachment.content_type.startsWith('image/') ? <img src={url} alt={attachment.file_name} /> : <><FileText size={14} /> {attachment.file_name}</>}</a>
}
