import { useEffect, useState } from 'react';
import { auth } from '../lib/api.js';
import { Banner, Field, PasswordInput } from '../components/ui.jsx';
import { describeServer } from '../lib/cmsServer.js';
import { probeServer } from '../lib/connection.js';

export default function LoginPage({ onSignedIn }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // The warehouse server this device talks to. Checked BEFORE anyone types a password: if
  // the server is unreachable, "wrong username or password" would be a lie and would send a
  // storekeeper hunting for the wrong problem.
  const server = describeServer();
  const [probe, setProbe] = useState({ state: 'checking' });

  async function check() {
    setProbe({ state: 'checking' });
    const r = await probeServer();
    setProbe(r.serverUp
      ? { state: 'up', instance: r.health?.instanceId, role: r.health?.role }
      : { state: 'down', reason: r.error });
  }

  useEffect(() => { check(); }, [server.url]);

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
        <p className="sub">Central Medical Store</p>

        <Banner kind="error">{error}</Banner>

        {/* Status only — there is deliberately no way to edit the server address from here.
            The app always talks to whichever server served it, which is correct on every
            device that was set up by browsing to the CMS machine. Exposing an editable
            address to warehouse staff can only ever make a working device stop working, and
            the person who could fix it is not the person holding the device. If the CMS
            machine's address really does change, the fix is on the server (a fixed IP or a
            DHCP reservation), not on twenty tablets.

            The address is still shown when the probe FAILS, because then it is diagnostic. */}
        <div
          className="muted"
          style={{
            fontSize: 12, marginBottom: 14,
            padding: down ? '8px 10px' : '2px 0',
            border: down ? '1px solid var(--border)' : '1px solid transparent',
            borderRadius: 6,
          }}
        >
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
              {probe.state === 'up' && <>Connected</>}
              {down && (
                <>
                  <strong>Warehouse server unavailable.</strong> Check that the CMS server is
                  running, and that this device is on the warehouse network.
                  {' '}Server: <strong>{server.label}</strong>
                  {probe.reason ? <> ({probe.reason})</> : null}
                </>
              )}
            </span>
          </div>
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
