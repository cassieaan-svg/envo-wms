import { useEffect, useState } from 'react';
import { auth } from '../lib/api.js';
import { Banner, Field, PasswordInput } from '../components/ui.jsx';
import { describeServer, isValidServerUrl, setConfiguredServer, clearConfiguredServer } from '../lib/cmsServer.js';
import { probeServer } from '../lib/connection.js';

export default function LoginPage({ onSignedIn }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // The warehouse server this device talks to. Checked BEFORE anyone types a password: if
  // the server is unreachable, "wrong username or password" would be a lie and would send a
  // storekeeper hunting for the wrong problem.
  const [server, setServer] = useState(() => describeServer());
  const [probe, setProbe] = useState({ state: 'checking' });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => describeServer().url || '');

  async function check() {
    setProbe({ state: 'checking' });
    const r = await probeServer();
    setProbe(r.serverUp
      ? { state: 'up', instance: r.health?.instanceId, role: r.health?.role }
      : { state: 'down', reason: r.error });
  }

  useEffect(() => { check(); }, [server.url]);

  function saveServer(event) {
    event.preventDefault();
    if (draft.trim() && !isValidServerUrl(draft)) {
      setError('That does not look like an address. Try something like 192.168.1.20:5100');
      return;
    }
    setError(null);
    if (draft.trim()) setConfiguredServer(draft);
    else clearConfiguredServer();
    setServer(describeServer());
    setEditing(false);
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await auth.login(username.trim(), password));
    } catch (err) {
      // `offline` is set by the API layer when the request never reached a server at all.
      setError(err.offline
        ? 'Warehouse server unavailable. Check that the CMS server is running and that this '
          + 'device is on the warehouse network.'
        : err.message);
      if (err.offline) check();
    } finally {
      setBusy(false);
    }
  }

  const down = probe.state === 'down';

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>
          CMS <span style={{ color: 'var(--accent)' }}>Warehouse</span>
        </h1>
        <p className="sub">Central Medical Store — stock, dispatch and requests</p>

        <Banner kind="error">{error}</Banner>

        {/* The server line is always visible, not hidden behind a settings screen. It is the
            first thing to check when nothing works, and the person checking it is usually
            not the person who set it up. */}
        <div
          className="muted"
          style={{
            fontSize: 12, marginBottom: 14, padding: '8px 10px',
            border: '1px solid var(--border)', borderRadius: 6,
          }}
        >
          {editing ? (
            <>
              <label htmlFor="cms-server" style={{ display: 'block', marginBottom: 4 }}>
                Warehouse server address
              </label>
              <input
                id="cms-server"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="192.168.1.20:5100"
                style={{ width: '100%', marginBottom: 6 }}
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" className="btn small" onClick={saveServer}>Save</button>
                <button
                  type="button" className="btn small"
                  onClick={() => { setDraft(server.url || ''); setEditing(false); setError(null); }}
                >
                  Cancel
                </button>
              </div>
              <div style={{ marginTop: 6 }}>
                Leave empty to use the server that provided this page.
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                aria-hidden="true"
                style={{
                  width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                  background: probe.state === 'up' ? 'var(--ok, #16a34a)'
                    : down ? 'var(--danger, #dc2626)' : 'var(--border)',
                }}
              />
              <span style={{ flex: 1 }}>
                {probe.state === 'checking' && <>Checking the warehouse server…</>}
                {probe.state === 'up' && (
                  <>Connected to the warehouse server <strong>{server.label}</strong></>
                )}
                {down && (
                  <>
                    <strong>Warehouse server unavailable.</strong> Check that the CMS server is
                    running, and that this device is on the warehouse network.
                    {probe.reason ? <> ({probe.reason})</> : null}
                  </>
                )}
              </span>
              <button type="button" className="btn small" onClick={() => setEditing(true)}>
                change
              </button>
            </div>
          )}
        </div>

        <Field label="Username">
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
        </Field>
        <Field label="Password">
          <PasswordInput
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </Field>
        {/* Sign-in stays enabled even when the probe says the server is down: the probe can
            be wrong (a slow network, a blocked /health) and blocking the button would leave
            someone stuck with no way to try. */}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
