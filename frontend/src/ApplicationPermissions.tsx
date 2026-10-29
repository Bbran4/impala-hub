import { useEffect, useMemo, useState } from 'react'
import { ShieldCheck, Users } from 'lucide-react'
import { supabase } from './supabase'

type PermissionUser = { profile_id: string; display_name: string; email: string | null; roles: string[]; accessible_apps: string[] }
type PermissionRole = { role_id: string; label: string; description: string; accessible_apps: string[] }
type PermissionRow = {
  permission_key: string
  group_label: string
  label: string
  effective_enabled: boolean
  override_enabled: boolean | null
  role_granted: boolean
}
type RolePermissionRow = { permission_key: string; group_label: string; label: string; granted: boolean }

const APPLICATIONS = [
  ['marketing', 'Marketing'], ['sales_desk', 'Sales Desk'], ['returns_claims', 'Returns & Claims'],
  ['stock_control', 'Smart Stock Control'], ['fleet_management', 'Fleet Management'],
  ['ecommerce', 'E-commerce'], ['reporting', 'Reporting'],
] as const

type Props = { setNotice: (message: string) => void; setError: (message: string) => void }

export default function ApplicationPermissions({ setNotice, setError }: Props) {
  const [users, setUsers] = useState<PermissionUser[]>([])
  const [roles, setRoles] = useState<PermissionRole[]>([])
  const [principalMode, setPrincipalMode] = useState<'users' | 'roles'>('users')
  const [selectedUserId, setSelectedUserId] = useState('')
  const [selectedRoleId, setSelectedRoleId] = useState('')
  const [appId, setAppId] = useState<string>('marketing')
  const [rows, setRows] = useState<PermissionRow[]>([])
  const [roleRows, setRoleRows] = useState<RolePermissionRow[]>([])
  const [loadingUsers, setLoadingUsers] = useState(true)
  const [loadingPermissions, setLoadingPermissions] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!supabase) return
    void Promise.all([supabase.rpc('admin_list_permission_users'), supabase.rpc('admin_list_permission_roles')]).then(([userResult, roleResult]) => {
      const { data, error } = userResult
      if (error) setError(`Could not load permission users: ${error.message}`)
      else {
        const next = (data || []) as PermissionUser[]
        setUsers(next)
        if (next.length) setSelectedUserId(next[0].profile_id)
      }
      if (roleResult.error) setError(`Could not load permission roles: ${roleResult.error.message}`)
      else {
        const next = (roleResult.data || []) as PermissionRole[]
        setRoles(next)
        if (next.length) setSelectedRoleId(next[0].role_id)
      }
      setLoadingUsers(false)
    })
  }, [setError])

  useEffect(() => {
    if (!supabase || principalMode !== 'users' || !selectedUserId) return
    setLoadingPermissions(true)
    void supabase.rpc('admin_get_user_app_permissions', { p_profile_id: selectedUserId, p_app_id: appId }).then(({ data, error }) => {
      if (error) setError(`Could not load permissions: ${error.message}`)
      else setRows((data || []) as PermissionRow[])
      setLoadingPermissions(false)
    })
  }, [selectedUserId, appId, setError])

  useEffect(() => {
    if (!supabase || principalMode !== 'roles' || !selectedRoleId) return
    setLoadingPermissions(true)
    void supabase.rpc('admin_get_role_app_permissions', { p_role_id: selectedRoleId, p_app_id: appId }).then(({ data, error }) => {
      if (error) setError(`Could not load role permissions: ${error.message}`)
      else setRoleRows((data || []) as RolePermissionRow[])
      setLoadingPermissions(false)
    })
  }, [selectedRoleId, appId, principalMode, setError])

  const selectedUser = users.find((user) => user.profile_id === selectedUserId)
  const selectedRole = roles.find((role) => role.role_id === selectedRoleId)
  const availableApps = principalMode === 'users'
    ? APPLICATIONS.filter(([id]) => selectedUser?.accessible_apps.includes(id))
    : APPLICATIONS.filter(([id]) => selectedRole?.accessible_apps.includes(id))

  useEffect(() => {
    if (availableApps.length && !availableApps.some(([id]) => id === appId)) setAppId(availableApps[0][0])
  }, [availableApps, appId])

  const visibleUsers = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? users.filter((user) => `${user.display_name} ${user.email || ''} ${user.roles.join(' ')}`.toLowerCase().includes(q)) : users
  }, [users, search])
  const grouped = useMemo(() => rows.reduce<Record<string, PermissionRow[]>>((groups, row) => {
    ;(groups[row.group_label] ||= []).push(row)
    return groups
  }, {}), [rows])
  const roleGrouped = useMemo(() => roleRows.reduce<Record<string, RolePermissionRow[]>>((groups, row) => {
    ;(groups[row.group_label] ||= []).push(row)
    return groups
  }, {}), [roleRows])

  async function setOverride(row: PermissionRow, value: 'inherit' | 'allow' | 'deny') {
    if (!supabase || !selectedUserId) return
    const enabled = value === 'inherit' ? null : value === 'allow'
    setSaving(row.permission_key)
    setError('')
    const { error } = await supabase.rpc('admin_set_user_app_permission', {
      p_profile_id: selectedUserId, p_app_id: appId, p_permission_key: row.permission_key, p_enabled: enabled,
    })
    if (error) setError(`Could not update permission: ${error.message}`)
    else {
      setRows((current) => current.map((item) => item.permission_key !== row.permission_key ? item : {
        ...item,
        override_enabled: enabled,
        effective_enabled: enabled === null ? item.role_granted : enabled,
      }))
      setNotice(`${selectedUser?.display_name || selectedUser?.email || 'User'} permissions updated.`)
    }
    setSaving(null)
  }

  return <section className="application-permissions">
    <div className="permission-page-heading">
      <div><span className="eyebrow">ACCESS CONTROL</span><h2>Application permissions</h2><p>Choose a user, then decide what they can do in each application. Inherit uses their role defaults.</p></div>
      <ShieldCheck size={24} />
    </div>
    <div className="permission-mode-tabs" role="tablist" aria-label="Permission principals">
      <button className={principalMode === 'users' ? 'active' : ''} onClick={() => setPrincipalMode('users')}>Users</button>
      <button className={principalMode === 'roles' ? 'active' : ''} onClick={() => setPrincipalMode('roles')}>Roles</button>
    </div>
    <div className="permission-app-tabs" role="tablist" aria-label="Permission applications">
      {(availableApps.length ? availableApps : APPLICATIONS).map(([id, label]) => <button key={id} className={appId === id ? 'active' : ''} onClick={() => setAppId(id)}>{label}</button>)}
    </div>
    <div className="permission-editor">
      <aside className="permission-users">
        <div className="permission-users-head"><h3>{principalMode === 'users' ? 'Users' : 'Roles'}</h3><span><Users size={14} /> {principalMode === 'users' ? users.length : roles.length}</span></div>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search users" aria-label="Search permission users" />
        {loadingUsers ? <div className="app-access-empty">Loading {principalMode}…</div> : principalMode === 'users' ? visibleUsers.map((user) => <button key={user.profile_id} className={selectedUserId === user.profile_id ? 'active' : ''} onClick={() => setSelectedUserId(user.profile_id)}>
          <span className="app-access-avatar">{(user.display_name || user.email || '?').slice(0, 1).toUpperCase()}</span>
          <span><b>{user.display_name || 'Unnamed user'}</b><small>{user.email}</small><em>{user.roles.join(' · ') || 'No role'}</em></span>
        </button>) : roles.filter((role) => `${role.label} ${role.description}`.toLowerCase().includes(search.trim().toLowerCase())).map((role) => <button key={role.role_id} className={selectedRoleId === role.role_id ? 'active' : ''} onClick={() => setSelectedRoleId(role.role_id)}>
          <span className="app-access-avatar">{role.label.slice(0, 1).toUpperCase()}</span>
          <span><b>{role.label}</b><small>{role.description}</small><em>{role.accessible_apps.length} apps</em></span>
        </button>)}
      </aside>
      <div className="permission-detail">
        {principalMode === 'users' && !selectedUser ? <div className="app-access-empty">Select a user to manage permissions.</div> : principalMode === 'roles' && !selectedRole ? <div className="app-access-empty">Select a role to inspect permissions.</div> : <>
          <div className="permission-detail-head"><div><h3>{principalMode === 'users' ? (selectedUser?.display_name || selectedUser?.email) : selectedRole?.label}</h3><p>{principalMode === 'users' ? `${selectedUser?.email} · ${selectedUser?.roles.join(', ') || 'No assigned role'}` : selectedRole?.description}</p></div><span className="status-badge">{APPLICATIONS.find(([id]) => id === appId)?.[1]}</span></div>
          {!availableApps.length ? <div className="app-access-empty">This {principalMode === 'users' ? 'user' : 'role'} has no access to an application yet.</div> : <>
          {loadingPermissions ? <div className="app-access-empty">Loading permissions…</div> : principalMode === 'users' ? Object.entries(grouped).map(([group, groupRows]) => <div className="permission-detail-group" key={group}>
            <h4>{group}</h4>
            {groupRows.map((row) => <div className="permission-detail-row" key={row.permission_key}>
              <div><b>{row.label}</b><small>{row.effective_enabled ? 'Allowed' : 'Not allowed'}{row.override_enabled === null ? ' · inherited from role' : row.override_enabled ? ' · user override' : ' · explicitly denied'}</small></div>
              <select aria-label={`${row.label} permission`} value={row.override_enabled === null ? 'inherit' : row.override_enabled ? 'allow' : 'deny'} disabled={saving === row.permission_key} onChange={(event) => void setOverride(row, event.target.value as 'inherit' | 'allow' | 'deny')}>
                <option value="inherit">Inherit</option><option value="allow">Allow</option><option value="deny">Deny</option>
              </select>
            </div>)}
          </div>) : Object.entries(roleGrouped).map(([group, groupRows]) => <div className="permission-detail-group" key={group}>
            <h4>{group}</h4>
            {groupRows.map((row) => <div className="permission-detail-row" key={row.permission_key}><div><b>{row.label}</b><small>{row.granted ? 'Granted by this role' : 'Not granted by this role'}</small></div><span className={`permission-effective ${row.granted ? 'allowed' : 'denied'}`}>{row.granted ? 'Allow' : 'Deny'}</span></div>)}
          </div>)}
          </>}
        </>}
      </div>
    </div>
  </section>
}
