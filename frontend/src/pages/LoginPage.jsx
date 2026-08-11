import { useState } from 'react';
import { auth } from '../lib/api.js';
import { Banner, Field, PasswordInput } from '../components/ui.jsx';

export default function LoginPage({ onSignedIn }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await auth.login(username.trim(), password));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>
          EnVo <span style={{ color: 'var(--accent)' }}>Warehouse</span>
        </h1>
        <p className="sub">Central Medical Stores warehouse management</p>

        <Banner kind="error">{error}</Banner>

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
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
