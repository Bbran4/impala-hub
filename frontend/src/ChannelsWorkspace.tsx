import { useCallback, useEffect, useMemo, useState } from 'react'
import { FileText, MessageCircle, Paperclip, Plus, Send, UserPlus, Users, X } from 'lucide-react'
import { supabase } from './supabase'

type Props = { setNotice: (message: string) => void; setError: (message: string) => void }
type Channel = { channel_id: string; name: string; description: string; member_count: number; last_message: string | null; last_message_at: string; unread_count: number }
type Conversation = { conversation_id: string; other_user_id: string; other_display_name: string; other_email: string; other_avatar_url: string | null; last_message: string | null; last_message_at: string; unread_count: number }
type Attachment = { id: string; file_name: string; content_type: string; storage_path: string; size_bytes: number }
type Member = { user_id: string; display_name: string; email: string; avatar_url: string | null; is_online: boolean }
type Message = { message_id: string; sender_id: string; sender_name: string; body: string; created_at: string; read_by_recipient?: boolean; attachments: Attachment[] }

export default function ChannelsWorkspace({ setNotice, setError }: Props) {
  const [channels, setChannels] = useState<Channel[]>([])
  const [chats, setChats] = useState<Conversation[]>([])
  const [selected, setSelected] = useState<{ kind: 'channel' | 'chat'; id: string } | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [userId, setUserId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [channelDraft, setChannelDraft] = useState('')
  const [members, setMembers] = useState<Member[]>([])
  const [memberPickerOpen, setMemberPickerOpen] = useState(false)
  const [memberQuery, setMemberQuery] = useState('')
  const [memberResults, setMemberResults] = useState<Member[]>([])

  const loadLists = useCallback(async () => {
    if (!supabase) return
    const [channelResult, chatResult] = await Promise.all([supabase.rpc('chat_list_channels'), supabase.rpc('chat_list_conversations')])
    if (channelResult.error) setError(`Could not load channels: ${channelResult.error.message}`)
    else setChannels((channelResult.data || []) as Channel[])
    if (chatResult.error) setError(`Could not load chats: ${chatResult.error.message}`)
    else setChats((chatResult.data || []) as Conversation[])
  }, [setError])

  useEffect(() => { if (!supabase) return; void supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id || null)); void loadLists() }, [loadLists])

  const selectedTitle = useMemo(() => selected?.kind === 'channel' ? channels.find((item) => item.channel_id === selected.id)?.name : chats.find((item) => item.conversation_id === selected?.id)?.other_display_name, [selected, channels, chats])

  const loadMessages = useCallback(async () => {
    if (!supabase || !selected) return
    const result = selected.kind === 'channel'
      ? await supabase.rpc('chat_list_channel_messages', { target_channel_id: selected.id })
      : await supabase.rpc('chat_list_messages', { target_conversation_id: selected.id })
    if (result.error) setError(`Could not load messages: ${result.error.message}`)
    else setMessages((result.data || []) as Message[])
  }, [selected, setError])

  const loadMembers = useCallback(async () => {
    if (!supabase || selected?.kind !== 'channel') return
    const result = await supabase.rpc('chat_list_channel_members', { target_channel_id: selected.id })
    if (result.error) setError(`Could not load channel members: ${result.error.message}`)
    else setMembers((result.data || []) as Member[])
  }, [selected, setError])

  useEffect(() => { setMessages([]); setMembers([]); void loadMessages(); void loadMembers(); const timer = window.setInterval(() => void loadMessages(), 4000); return () => window.clearInterval(timer) }, [loadMessages, loadMembers])

  useEffect(() => {
    if (!supabase || selected?.kind !== 'channel' || !memberPickerOpen) return
    const query = memberQuery.trim()
    if (!query) { setMemberResults([]); return }
    const client = supabase
    const timer = window.setTimeout(async () => {
      const result = await client.rpc('chat_search_users', { search_text: query })
      if (result.error) setError(`Could not search users: ${result.error.message}`)
      else setMemberResults((result.data || []).filter((user: Member) => !members.some((member) => member.user_id === user.user_id)) as Member[])
    }, 250)
    return () => window.clearTimeout(timer)
  }, [memberQuery, memberPickerOpen, members, selected, setError])

  async function addMember(user: Member) {
    if (!supabase || selected?.kind !== 'channel') return
    const result = await supabase.rpc('chat_add_channel_member', { target_channel_id: selected.id, target_user_id: user.user_id })
    if (result.error) setError(`Could not add channel member: ${result.error.message}`)
    else { await loadMembers(); setMemberQuery(''); setMemberResults([]); setNotice(`${user.display_name || user.email} added to the channel.`) }
  }

  async function leaveChannel() {
    if (!supabase || selected?.kind !== 'channel') return
    if (!window.confirm('Leave this channel?')) return
    const result = await supabase.rpc('chat_leave_channel', { target_channel_id: selected.id })
    if (result.error) setError(`Could not leave channel: ${result.error.message}`)
    else { setSelected(null); setMemberPickerOpen(false); await loadLists(); setNotice('You left the channel.') }
  }

  async function createChannel() {
    if (!supabase || !channelDraft.trim()) return
    const { data, error } = await supabase.rpc('chat_create_channel', { channel_name: channelDraft.trim(), channel_description: '' })
    if (error) setError(`Could not create channel: ${error.message}`)
    else { setChannelDraft(''); await loadLists(); setSelected({ kind: 'channel', id: data }); setNotice('Channel created.') }
  }

  function chooseFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files || [])
    if (selectedFiles.some((file) => file.size > 25 * 1024 * 1024)) { setError('Chat attachments must be 25 MB or smaller.'); return }
    if (files.length + selectedFiles.length > 5) { setError('A chat message can contain no more than 5 attachments.'); return }
    setFiles((current) => [...current, ...selectedFiles]); event.target.value = ''
  }

  async function send() {
    if (!supabase || !selected || !userId || (!draft.trim() && !files.length) || busy) return
    setBusy(true)
    const pendingFiles = files
    const body = draft.trim() || `Attachments: ${pendingFiles.map((file) => file.name).join(', ')}`
    const clientId = crypto.randomUUID()
    const result = selected.kind === 'channel'
      ? await supabase.rpc('chat_send_channel_message', { target_channel_id: selected.id, p_client_message_id: clientId, message_body: body })
      : await supabase.rpc('chat_send_message', { target_conversation_id: selected.id, p_client_message_id: clientId, message_body: body })
    if (result.error) setError(`Could not send message: ${result.error.message}`)
    else {
      for (const file of pendingFiles) {
        const path = `${userId}/${result.data}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
        const upload = await supabase.storage.from('chat-attachments').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false })
        if (upload.error) { setError(`Could not upload ${file.name}: ${upload.error.message}`); continue }
        const saved = await supabase.rpc('chat_add_attachment', { p_direct_message_id: selected.kind === 'chat' ? result.data : null, p_channel_message_id: selected.kind === 'channel' ? result.data : null, p_storage_path: path, p_file_name: file.name, p_content_type: file.type, p_size_bytes: file.size })
        if (saved.error) setError(`Could not save ${file.name}: ${saved.error.message}`)
      }
      setDraft(''); setFiles([]); await loadMessages(); await loadLists()
    }
    setBusy(false)
  }

  return <section className="channels-workspace">
    <aside className="channels-sidebar">
      <div className="channels-sidebar-head"><div><span className="eyebrow">IMPALA HUB</span><h2>Channels</h2></div><Users size={21} /></div>
      <div className="channels-section-title"><span>Channels</span><button className="icon-button" aria-label="Create channel" onClick={() => { const name = window.prompt('Channel name'); if (name) { setChannelDraft(name); void supabase?.rpc('chat_create_channel', { channel_name: name.trim(), channel_description: '' }).then(async ({ data, error }) => { if (error) setError(`Could not create channel: ${error.message}`); else { await loadLists(); setSelected({ kind: 'channel', id: data }); setNotice('Channel created.') } setChannelDraft('') }) } }}><Plus size={16} /></button></div>
      {channels.map((channel) => <button key={channel.channel_id} className={`channel-list-row ${selected?.kind === 'channel' && selected.id === channel.channel_id ? 'active' : ''}`} onClick={() => setSelected({ kind: 'channel', id: channel.channel_id })}><span className="channel-hash">#</span><span><b>{channel.name}</b><small>{channel.last_message || `${channel.member_count} members`}</small></span>{channel.unread_count > 0 && <em>{channel.unread_count}</em>}</button>)}
      <div className="channels-section-title"><span>Direct chats</span></div>
      {chats.map((chat) => <button key={chat.conversation_id} className={`channel-list-row ${selected?.kind === 'chat' && selected.id === chat.conversation_id ? 'active' : ''}`} onClick={() => setSelected({ kind: 'chat', id: chat.conversation_id })}><span className="channel-avatar">{(chat.other_display_name || chat.other_email || '?').slice(0, 1).toUpperCase()}</span><span><b>{chat.other_display_name || chat.other_email}</b><small>{chat.last_message || 'No messages yet'}</small></span>{chat.unread_count > 0 && <em>{chat.unread_count}</em>}</button>)}
    </aside>
    <main className="channels-main">
      {!selected ? <div className="channels-empty"><MessageCircle size={38} /><h2>Select a conversation</h2><p>Choose a channel or direct chat from the sidebar.</p></div> : <>
        <header className="channels-main-head"><div><span className="eyebrow">{selected.kind === 'channel' ? 'CHANNEL' : 'DIRECT CHAT'}</span><h2>{selectedTitle}</h2>{selected.kind === 'channel' && <small>{members.length} member{members.length === 1 ? '' : 's'}</small>}</div>{selected.kind === 'channel' && <div className="channel-head-actions"><button className="secondary" onClick={() => setMemberPickerOpen((open) => !open)}><Users size={15} /> Members</button><button className="secondary" onClick={() => void leaveChannel()}>Leave</button></div>}</header>
        {selected.kind === 'channel' && memberPickerOpen && <div className="channel-member-picker"><div className="channel-member-picker-head"><b>Channel members</b><button className="icon-button" onClick={() => setMemberPickerOpen(false)}><X size={16} /></button></div>{members.map((member) => <div className="channel-member-result" key={member.user_id}><span className={`presence-dot ${member.is_online ? 'online' : ''}`} /><span><b>{member.display_name || member.email}</b><small>{member.email}</small></span></div>)}<b className="channel-add-label">Add people</b><input value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} placeholder="Search by name or email" />{memberResults.map((user) => <button className="channel-member-result" key={user.user_id} onClick={() => void addMember(user)}><span className={`presence-dot ${user.is_online ? 'online' : ''}`} /><span><b>{user.display_name || user.email}</b><small>{user.email}</small></span><UserPlus size={15} /></button>)}{memberQuery && !memberResults.length && <small className="channel-member-empty">No available users found.</small>}</div>}
        <div className="channels-messages">{messages.length ? messages.map((message) => <div className={`channels-message ${message.sender_id === userId ? 'mine' : ''}`} key={message.message_id}><b>{message.sender_name}</b><span>{message.body}</span>{message.attachments?.map((attachment) => <ChannelAttachment key={attachment.id} attachment={attachment} />)}<time>{new Date(message.created_at).toLocaleString()}</time></div>) : <div className="channels-empty"><MessageCircle size={30} /><p>No messages yet.</p></div>}</div>
        <footer className="channels-compose"><label className="icon-button" aria-label="Attach files"><Paperclip size={18} /><input type="file" multiple onChange={chooseFiles} /></label>{files.length > 0 && <div className="chat-file-chips">{files.map((file, index) => <button key={`${file.name}-${index}`} onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>{file.name} ×</button>)}</div>}<textarea rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={`Message ${selectedTitle || 'conversation'}…`} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} /><button className="primary" disabled={busy || (!draft.trim() && !files.length)} onClick={() => void send()}><Send size={16} /> Send</button></footer>
      </>}
    </main>
  </section>
}

function ChannelAttachment({ attachment }: { attachment: Attachment }) {
  const [url, setUrl] = useState('')
  useEffect(() => { if (!supabase) return; void supabase.storage.from('chat-attachments').createSignedUrl(attachment.storage_path, 3600).then(({ data }) => { if (data?.signedUrl) setUrl(data.signedUrl) }) }, [attachment.storage_path])
  if (!url) return <span className="channel-attachment"><FileText size={14} /> {attachment.file_name}</span>
  const download = async () => { const response = await fetch(url); if (!response.ok) return; const blobUrl = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = blobUrl; link.download = attachment.file_name; link.click(); window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000) }
  const isImage = attachment.content_type.toLowerCase().startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(attachment.file_name)
  return <span className="channel-attachment-wrap"><a className="channel-attachment" href={url} target="_blank" rel="noopener noreferrer">{isImage ? <img src={url} alt={attachment.file_name} /> : <><FileText size={14} /> {attachment.file_name}</>}</a><span className="chat-attachment-actions"><a href={url} target="_blank" rel="noopener noreferrer">Open</a><button className="chat-download" onClick={() => void download()}>Download</button></span></span>
}
