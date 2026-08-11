import { useState } from 'react';
import { auth } from '../lib/api.js';
import { Banner, Field, Modal, PasswordInput } from './ui.jsx';

export default function ChangePasswordModal({ onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError(null);

    if (next !== confirm) return setError('the new passwords do not match');
    if (next.length < 8) return setError('new password must be at least 8 characters');

    setBusy(true);
    try {
      await auth.changePassword(current, next);
      setDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Change password" onClose={onClose}>
      <Banner kind="error" onDismiss={() => setError(null)}>
        {error}
      </Banner>

      {done ? (
        <>
          <Banner kind="success">Password changed. It applies the next time you sign in.</Banner>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </>
      ) : (
        <form onSubmit={submit}>
          <Field label="Current password">
            <PasswordInput
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
              autoFocus
              autoComplete="current-password"
            />
          </Field>
          <Field label="New password">
            <PasswordInput
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
            />
          </Field>
          <Field label="Confirm new password">
            <PasswordInput
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
            />
          </Field>
          <p className="muted">At least 8 characters, and different from your current one.</p>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'saving…' : 'Change password'}
          </button>
        </form>
      )}
    </Modal>
  );
}
