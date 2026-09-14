import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty, Field, Modal, PasswordInput } from '../components/ui.jsx';

// User/role administration. Reachable only by System Administrator and Warehouse Admin
// (users.create) — App.jsx hides the nav tab from anyone else, and every write here still
// goes through the same server-side permission checks as any other route in the app; this
// page adds no authorization logic of its own; see docs/AUTHORIZATION.md.

const ROLE_BADGE = {
  system_administrator: 'soon',   // the most powerful role — the colour that draws the eye
  warehouse_admin: 'ok',
  picker_dispatcher: 'default',
  receiving_clerk: 'default',
};

const BLANK = { username: '', fullName: '', password: '', role: '' };

// Mirrors AdminUsersService.SENSITIVE_PERMISSIONS — not a security boundary (the server
// enforces that), just which actions get an extra "are you sure" before firing.
const SENSITIVE_PERMISSIONS = new Set([
  'permissions.manage',
  'roles.manage',
  'rolePermissions.manage',
  'roles.assignAny',
  'instance.configure',
  'batches.adjust',
  'accounts.recordPayment',
]);

const SOURCE_LABEL = {
  role: (p) => `Granted — Inherited from role: ${p.roleLabel}`,
  'override-grant': () => 'Granted — Direct grant',
  'override-deny': () => 'Denied — Direct deny',
  none: () => 'Not granted',
};

// The backend's own error text is already specific ("that username is already taken", "you
// cannot change your own roles") — this only smooths the one message that reads as an
// internal permission key rather than a sentence.
function friendlyError(err) {
  const msg = err?.message || String(err);
  if (/^permission required: roles\.assignAny/.test(msg)) {
    return "You don't have permission to assign that role — only a System Administrator can.";
  }
  if (/^permission required: roles\.assignOperational/.test(msg)) {
    return "You don't have permission to assign operational roles.";
  }
  if (/^permission required:/.test(msg)) {
    return "You don't have permission to do that.";
  }
  return msg;
}

export default function UsersPage({ currentUser }) {
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [form, setForm] = useState(BLANK);
  const [creating, setCreating] = useState(false);
  const [rolesTarget, setRolesTarget] = useState(null); // the user row shown in the "manage roles" modal
  const [confirmDisable, setConfirmDisable] = useState(null); // the user row pending a disable confirmation
  const [permsTarget, setPermsTarget] = useState(null); // the user row shown in the "manage permissions" modal
  const [permsDetails, setPermsDetails] = useState(null); // that user's effective-permission breakdown
  const [permsLoading, setPermsLoading] = useState(false);
  const [confirmSensitive, setConfirmSensitive] = useState(null); // { user, permission, effect } pending an "are you sure"

  const myPermissions = currentUser?.permissions || [];
  const canAssignAny = myPermissions.includes('roles.assignAny');
  const canAssignOperational = myPermissions.includes('roles.assignOperational');
  // permissions.manage is exclusive to System Administrator in the seeded matrix — Warehouse
  // Admin never sees this button at all, not even to look. Same reasoning as the route gate.
  const canManagePermissions = myPermissions.includes('permissions.manage');

  // Which roles THIS admin may hand out. System Administrator holds both assign
  // permissions and can grant any of the four; Warehouse Admin holds only
  // roles.assignOperational and can grant Picker/Dispatcher or Receiving Clerk.
  const assignableRoles = useMemo(() => {
    if (canAssignAny) return roles;
    if (canAssignOperational) return roles.filter((r) => r.key === 'picker_dispatcher' || r.key === 'receiving_clerk');
    return [];
  }, [roles, canAssignAny, canAssignOperational]);

  async function load() {
    setLoading(true);
    try {
      const [u, r] = await Promise.all([api.admin.listUsers(), api.admin.listRoles()]);
      setUsers(u);
      setRoles(r);
      setError(null);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createUser(event) {
    event.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const user = await api.admin.createUser({
        username: form.username.trim(),
        fullName: form.fullName.trim() || undefined,
        password: form.password,
      });
      // A second, separate call — createUser and role assignment are independent
      // operations server-side (a new account starts with zero roles until one is
      // granted). If the role step fails, the account still exists; say so rather than
      // implying the whole thing failed.
      if (form.role) {
        try {
          await api.admin.assignRole(user.id, form.role);
          setNotice(`Created ${user.username} and assigned ${roleLabel(form.role)}.`);
        } catch (roleErr) {
          setNotice(null);
          setError(`${user.username} was created, but the role could not be assigned: ${friendlyError(roleErr)}`);
        }
      } else {
        setNotice(`Created ${user.username}. Assign a role from "Manage roles" to give them access.`);
      }
      setForm(BLANK);
      await load();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setCreating(false);
    }
  }

  function askDisable(user) {
    setConfirmDisable(user);
  }

  async function disableUser(user) {
    setConfirmDisable(null);
    setError(null);
    try {
      await api.admin.disableUser(user.id);
      setNotice(`Disabled ${user.username}. Their existing session may stay active until it expires or they try to sign in again.`);
      await load();
    } catch (err) {
      setError(friendlyError(err));
    }
  }

  async function enableUser(user) {
    setError(null);
    try {
      await api.admin.enableUser(user.id);
      setNotice(`Re-enabled ${user.username}. They can sign in again.`);
      await load();
    } catch (err) {
      setError(friendlyError(err));
    }
  }

  async function assignRole(user, roleKey) {
    setError(null);
    try {
      await api.admin.assignRole(user.id, roleKey);
      setNotice(`Assigned ${roleLabel(roleKey)} to ${user.username}.`);
      await load();
      // Keep the modal in sync with the fresh role list.
      setRolesTarget((t) => (t && t.id === user.id ? { ...t, roles: [...t.roles, roleKey] } : t));
    } catch (err) {
      setError(friendlyError(err));
    }
  }

  async function removeRole(user, roleKey) {
    setError(null);
    try {
      await api.admin.removeRole(user.id, roleKey);
      setNotice(`Removed ${roleLabel(roleKey)} from ${user.username}.`);
      await load();
      setRolesTarget((t) => (t && t.id === user.id ? { ...t, roles: t.roles.filter((k) => k !== roleKey) } : t));
    } catch (err) {
      setError(friendlyError(err));
    }
  }

  function roleLabel(key) {
    return roles.find((r) => r.key === key)?.label || key;
  }

  async function openPermissions(user) {
    setPermsTarget(user);
    setPermsDetails(null);
    setPermsLoading(true);
    setError(null);
    try {
      setPermsDetails(await api.admin.userPermissions(user.id));
    } catch (err) {
      setError(friendlyError(err));
      setPermsTarget(null);
    } finally {
      setPermsLoading(false);
    }
  }

  // Sensitive keys get a confirm step first; everything else applies immediately.
  function requestSetOverride(user, permission, effect) {
    if (SENSITIVE_PERMISSIONS.has(permission)) {
      setConfirmSensitive({ user, permission, effect });
      return;
    }
    applySetOverride(user, permission, effect);
  }

  async function applySetOverride(user, permission, effect) {
    setConfirmSensitive(null);
    setError(null);
    try {
      await api.admin.setPermissionOverride(user.id, permission, effect);
      setNotice(`${effect === 'grant' ? 'Granted' : 'Denied'} ${permission} for ${user.username}.`);
      setPermsDetails(await api.admin.userPermissions(user.id));
      await load();
    } catch (err) {
      setError(friendlyError(err));
    }
  }

  async function removeOverride(user, permission) {
    setError(null);
    try {
      await api.admin.removePermissionOverride(user.id, permission);
      setNotice(`Removed the direct override for ${permission} on ${user.username} — back to role-based access.`);
      setPermsDetails(await api.admin.userPermissions(user.id));
      await load();
    } catch (err) {
      setError(friendlyError(err));
    }
  }

  // Grouped by the dot-prefix every permission key already carries (batches.*, requests.*,
  // …) — no separate categorisation metadata needed.
  const permsByGroup = useMemo(() => {
    if (!permsDetails) return [];
    const groups = new Map();
    for (const p of permsDetails) {
      const group = p.key.split('.')[0];
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(p);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [permsDetails]);

  const canCreate = form.username.trim() && form.password.length >= 8;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p>Warehouse logins, and the roles that decide what each one can do.</p>
        </div>
        <button className="btn" onClick={load} disabled={loading}>
          {loading ? 'refreshing…' : 'Refresh'}
        </button>
      </div>

      <Banner kind="error" onDismiss={() => setError(null)}>{error}</Banner>
      <Banner kind="success" onDismiss={() => setNotice(null)}>{notice}</Banner>

      <form className="card" onSubmit={createUser}>
        <h2>Add user</h2>
        <div className="form-grid">
          <Field label="Username *">
            <input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              autoComplete="off"
              required
            />
          </Field>
          <Field label="Full name">
            <input
              value={form.fullName}
              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
            />
          </Field>
          <Field label="Password *">
            <PasswordInput
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              autoComplete="new-password"
              required
            />
            <div className="muted" style={{ fontSize: 12 }}>at least 8 characters</div>
          </Field>
          <Field label="Initial role">
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="">no role yet — assign one after creating</option>
              {assignableRoles.map((r) => (
                <option key={r.key} value={r.key}>{r.label}</option>
              ))}
            </select>
          </Field>
          <div className="row-actions">
            <button className="btn primary" type="submit" disabled={!canCreate || creating}>
              {creating ? 'creating…' : 'Create user'}
            </button>
          </div>
        </div>
        {assignableRoles.length === 0 && (
          <p className="muted" style={{ marginBottom: 0 }}>
            You can create users, but you don't hold a role-assignment permission — the new
            account will need a role granted by a System Administrator.
          </p>
        )}
      </form>

      <div className="card">
        <h2>{users.length} user{users.length === 1 ? '' : 's'}</h2>
        {loading ? (
          <Empty>loading…</Empty>
        ) : users.length === 0 ? (
          <Empty>No users yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="wrap">Username</th>
                  <th className="wrap">Full name</th>
                  <th>Status</th>
                  <th className="wrap">Roles</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isSelf = currentUser && u.id === currentUser.id;
                  return (
                    <tr key={u.id}>
                      <td className="wrap">
                        {u.username}
                        {isSelf && <span className="muted"> (you)</span>}
                      </td>
                      <td className="wrap">{u.full_name || '—'}</td>
                      <td>
                        {u.is_active ? (
                          <span className="badge ok">active</span>
                        ) : (
                          <span className="badge inactive">disabled</span>
                        )}
                        {u.is_locally_disabled && (
                          <span className="badge inactive" style={{ marginLeft: 4 }} title="Locked on this warehouse instance only, regardless of the account's normal status">
                            locked here
                          </span>
                        )}
                      </td>
                      <td className="wrap">
                        {u.roles.length === 0 ? (
                          <span className="muted">no role — no access</span>
                        ) : (
                          u.roles.map((key) => (
                            <span key={key} className={`badge ${ROLE_BADGE[key] || 'default'}`} style={{ marginRight: 4 }}>
                              {roleLabel(key)}
                            </span>
                          ))
                        )}
                      </td>
                      <td>
                        <div className="row-actions">
                          <button className="btn small" onClick={() => setRolesTarget(u)}>
                            manage roles
                          </button>
                          {canManagePermissions && (
                            <button className="btn small" onClick={() => openPermissions(u)}>
                              manage permissions
                            </button>
                          )}
                          {u.is_active ? (
                            <button className="btn small danger" onClick={() => askDisable(u)}>
                              disable
                            </button>
                          ) : (
                            <button className="btn small" onClick={() => enableUser(u)}>
                              enable
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {confirmDisable && (
        <Modal
          title={`Disable ${confirmDisable.username}?`}
          onClose={() => setConfirmDisable(null)}
        >
          <p>
            They will not be able to sign in again. Their existing session may stay active
            until it expires or they next try to sign in — this does not end an already-open
            session immediately.
          </p>
          <div className="row-actions">
            <button className="btn danger" onClick={() => disableUser(confirmDisable)}>
              Disable {confirmDisable.username}
            </button>
            <button className="btn" onClick={() => setConfirmDisable(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}

      {rolesTarget && (
        <Modal
          title={`Roles — ${rolesTarget.username}`}
          onClose={() => setRolesTarget(null)}
        >
          {currentUser && rolesTarget.id === currentUser.id ? (
            <p className="muted">
              You cannot change your own roles — this is a deliberate rule, not a bug. Ask
              another administrator.
            </p>
          ) : (
            <>
              <h3 style={{ marginTop: 0 }}>Current roles</h3>
              {rolesTarget.roles.length === 0 ? (
                <p className="muted">No role — this account cannot do anything yet.</p>
              ) : (
                <div className="row-actions" style={{ flexWrap: 'wrap', marginBottom: 14 }}>
                  {rolesTarget.roles.map((key) => (
                    <span key={key} className={`badge ${ROLE_BADGE[key] || 'default'}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {roleLabel(key)}
                      <button
                        type="button"
                        className="btn small"
                        style={{ padding: '0 6px' }}
                        onClick={() => removeRole(rolesTarget, key)}
                        aria-label={`Remove ${roleLabel(key)}`}
                        title={`Remove ${roleLabel(key)}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <h3>Assign a role</h3>
              {assignableRoles.filter((r) => !rolesTarget.roles.includes(r.key)).length === 0 ? (
                <p className="muted">
                  {assignableRoles.length === 0
                    ? "You don't hold a role-assignment permission."
                    : 'Every role you can grant is already assigned.'}
                </p>
              ) : (
                <div className="row-actions" style={{ flexWrap: 'wrap' }}>
                  {assignableRoles
                    .filter((r) => !rolesTarget.roles.includes(r.key))
                    .map((r) => (
                      <button
                        key={r.key}
                        type="button"
                        className="btn small"
                        onClick={() => assignRole(rolesTarget, r.key)}
                      >
                        + {r.label}
                      </button>
                    ))}
                </div>
              )}
            </>
          )}
        </Modal>
      )}

      {permsTarget && (
        <Modal
          title={`Permissions — ${permsTarget.username}`}
          subtitle="Direct overrides are exceptions to role-based access — use sparingly"
          onClose={() => { setPermsTarget(null); setPermsDetails(null); }}
        >
          {currentUser && permsTarget.id === currentUser.id ? (
            <p className="muted">
              You cannot change your own permissions — this is a deliberate rule, not a bug.
              Ask another System Administrator.
            </p>
          ) : permsLoading || !permsDetails ? (
            <Empty>loading…</Empty>
          ) : (
            permsByGroup.map(([group, items]) => (
              <div key={group} style={{ marginBottom: 18 }}>
                <h3 style={{ marginBottom: 8, textTransform: 'capitalize' }}>{group}</h3>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th className="wrap">Permission</th>
                        <th className="wrap">Status</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((p) => (
                        <tr key={p.key}>
                          <td className="wrap">
                            <code>{p.key}</code>
                            <div className="muted" style={{ fontSize: 12 }}>{p.description}</div>
                          </td>
                          <td className="wrap">
                            <span className={`badge ${p.effective ? 'ok' : 'inactive'}`}>
                              {SOURCE_LABEL[p.source](p)}
                            </span>
                          </td>
                          <td>
                            <div className="row-actions" style={{ flexWrap: 'wrap' }}>
                              {p.source !== 'override-grant' && (
                                <button className="btn small" onClick={() => requestSetOverride(permsTarget, p.key, 'grant')}>
                                  grant
                                </button>
                              )}
                              {p.source !== 'override-deny' && (
                                <button className="btn small danger" onClick={() => requestSetOverride(permsTarget, p.key, 'deny')}>
                                  deny
                                </button>
                              )}
                              {p.overrideEffect && (
                                <button className="btn small" onClick={() => removeOverride(permsTarget, p.key)}>
                                  remove override
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}
        </Modal>
      )}

      {confirmSensitive && (
        <Modal
          title="Sensitive permission"
          onClose={() => setConfirmSensitive(null)}
        >
          <p>
            <code>{confirmSensitive.permission}</code> is a sensitive permission. Granting or
            denying it individually may provide significant administrative access, or bypass
            the normal role model, for <strong>{confirmSensitive.user.username}</strong>. Are
            you sure?
          </p>
          <div className="row-actions">
            <button
              className={`btn ${confirmSensitive.effect === 'deny' ? 'danger' : 'primary'}`}
              onClick={() => applySetOverride(confirmSensitive.user, confirmSensitive.permission, confirmSensitive.effect)}
            >
              Yes, {confirmSensitive.effect} it
            </button>
            <button className="btn" onClick={() => setConfirmSensitive(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
