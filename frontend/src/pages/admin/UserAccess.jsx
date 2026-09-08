import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { Card, CardBody, CardHeader, CardTitle } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { toast } from '../../components/ui/Toast'
import { UserConfigPanel } from '../../components/admin/UserConfigPanel'
import { CreateUserModal } from '../../components/admin/CreateUserModal'

const field = 'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-green-500'

const PAGE_SIZE = 50

// User & Access Management.
//
// WHAT THIS SCREEN DOES AND DOES NOT DO. It edits the ACL tables — user_roles
// and user_role_scopes — which are SHADOW-ONLY. scope.js still authorizes every
// operational request from the JWT's raw_user_meta_data, so a role changed here
// does not change what that user can do today. The banner says exactly that,
// because a configuration screen that silently does nothing is worse than none.
//
// The legacy metadata is shown read-only beside the ACL configuration, so the
// difference between "what the system enforces now" and "what it will enforce at
// cutover" is visible rather than implied.

export function UserAccess() {
  const [meta, setMeta] = useState(null)
  const [q, setQ] = useState('')
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState(null)
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    (async () => {
      try {
        setMeta(await api.admin.meta())
      } catch (err) {
        setError(err.status === 403
          ? 'This screen is for system and state administrators.'
          : (err.message || 'Could not load configuration.'))
      } finally { setLoading(false) }
    })()
  }, [])

  // Debounced search — the list query scans users, so a keystroke per request
  // would be wasteful on a 7,500-row table.
  useEffect(() => {
    if (!meta) return
    const t = setTimeout(async () => {
      try {
        const res = await api.admin.users({
          q: q.trim() || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE,
        })
        setRows(res?.data || []); setTotal(res?.total ?? 0)
      } catch (err) { toast(err.message || 'Search failed.', 'red') }
    }, 250)
    return () => clearTimeout(t)
  }, [q, meta, page])

  if (loading) return <LoadingState />
  if (error) return (
    <Card><CardBody><div className="py-8 text-center text-sm text-gray-400">{error}</div></CardBody></Card>
  )

  const scopeLabel = meta.identity.state
    ? `${meta.identity.state} state only`
    : 'All states'

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-medium text-gray-100">User &amp; Access Management</h1>
          <p className="text-sm text-gray-500 mt-1">
            Roles, scope and permissions · {scopeLabel}
          </p>
        </div>
        <Button variant="success" onClick={() => setCreating(true)}>+ Create user</Button>
      </div>

      <ShadowBanner />

      <Card><CardBody>
        <input
          className={field}
          value={q}
          // Reset to the first page with the search itself, not in an effect: a
          // narrower result set can otherwise leave the offset past its end and
          // show an empty table.
          onChange={e => { setQ(e.target.value); setPage(0) }}
          placeholder="Search by email…"
        />
      </CardBody></Card>

      <Card>
        <CardHeader>
          <CardTitle>{total} {total === 1 ? 'user' : 'users'}{q ? ' matching' : ''}</CardTitle>
        </CardHeader>
        <CardBody>
          {!rows.length ? <EmptyState message="No users match that search." /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-gray-500 uppercase">
                  <tr>
                    <th className="pb-2">Email</th>
                    <th className="pb-2 pr-4">ACL role</th>
                    <th className="pb-2 pr-4">Scope</th>
                    <th className="pb-2 pr-4">Module</th>
                    {/* Every column here reports ACL configuration, not the live
                        sign-in metadata — that is shown in the detail panel. */}
                    <th className="pb-2 pr-4">Section</th>
                    <th className="pb-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(u => (
                    <tr key={u.id} className="border-t border-white/5">
                      <td className="py-2.5 text-gray-100">{u.email}</td>
                      <td className="py-2.5 pr-4 text-gray-400">{u.role || <span className="text-amber-400">none</span>}</td>
                      <td className="py-2.5 pr-4 text-gray-400">
                        {u.scope_label
                          ? <>{u.scope_label}<span className="text-gray-600 text-xs ml-1">{u.scope_type}</span></>
                          : <span className="text-gray-600">national</span>}
                      </td>
                      <td className="py-2.5 pr-4 text-gray-400">{u.module || <span className="text-gray-600">all</span>}</td>
                      <td className="py-2.5 pr-4 text-gray-400">
                        {u.acl_section || <span className="text-gray-600">all sections</span>}
                      </td>
                      <td className="py-2.5 text-right">
                        <Button size="sm" onClick={() => setSelected(u.id)}>Configure</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {total > PAGE_SIZE && (
                <div className="flex items-center justify-between gap-3 mt-4">
                  <div className="text-xs text-gray-500">
                    {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={page === 0}
                            onClick={() => setPage(p => Math.max(0, p - 1))}>Previous</Button>
                    <Button size="sm" disabled={(page + 1) * PAGE_SIZE >= total}
                            onClick={() => setPage(p => p + 1)}>Next</Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      {creating && (
        <CreateUserModal
          meta={meta}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            const res = await api.admin.users({ q: q.trim() || undefined, limit: PAGE_SIZE })
            setRows(res?.data || []); setTotal(res?.total ?? 0); setPage(0)
          }}
        />
      )}

      {selected && (
        <UserConfigPanel
          userId={selected}
          meta={meta}
          onClose={() => setSelected(null)}
          onSaved={async () => {
            const res = await api.admin.users({ q: q.trim() || undefined, limit: 50 })
            setRows(res?.data || []); setTotal(res?.total ?? 0)
          }}
        />
      )}
    </div>
  )
}

// Stated once, prominently, on both administration screens.
export function ShadowBanner() {
  return (
    <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3">
      <div className="text-sm text-amber-300 font-medium">Configuration only — not yet enforced</div>
      <div className="text-xs text-amber-200/70 mt-1 leading-relaxed">
        Role, scope and permission changes are staged for the new access model.
        Live access is still decided by each account's existing sign-in metadata,
        so those take effect at cutover, not immediately.
        {' '}<span className="text-amber-200">Creating an account is the exception</span> —
        a new login works straight away.
      </div>
    </div>
  )
}
