// Small shared presentational helpers used across the pages.
import { useState } from 'react';

// A password box with a show/hide control. Worth having on a shared warehouse PC: the
// keyboards are poor, and a mistyped password that you cannot see just reads as "wrong
// password". It always starts masked, and re-masks whenever the field is remounted.
//
// The browser's own eye icon is suppressed in CSS so there are not two of them side by
// side — this one is styled with the app and works the same in every browser.
export function PasswordInput({ value, onChange, ...rest }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="password-input">
      <input type={shown ? 'text' : 'password'} value={value} onChange={onChange} {...rest} />
      <button
        type="button"
        className="reveal"
        onClick={() => setShown(!shown)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        title={shown ? 'Hide password' : 'Show password'}
        // Skipped in tab order: it sits between the password box and the submit button,
        // and tabbing onto it on the way to signing in would be a nuisance.
        tabIndex={-1}
      >
        {shown ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" />
            <circle cx="8" cy="8" r="1.8" />
            <path d="M2 14L14 2" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" />
            <circle cx="8" cy="8" r="1.8" />
          </svg>
        )}
      </button>
    </div>
  );
}

export function Banner({ kind = 'error', children, onDismiss }) {
  if (!children) return null;
  return (
    <div className={`banner ${kind}`}>
      {children}
      {onDismiss && (
        <button className="btn small" style={{ marginLeft: 10 }} onClick={onDismiss}>
          dismiss
        </button>
      )}
    </div>
  );
}

export function Modal({ title, subtitle, onClose, children }) {
  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>{title}</h2>
          {subtitle && <span className="muted">{subtitle}</span>}
          <button className="btn small" onClick={onClose}>
            close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Stops Enter in a text field from submitting the form.
//
// Put this on forms whose submit is irreversible — dispatching stock, fulfilling a
// request. Typing a quantity and reflexively hitting Enter would otherwise send the whole
// order out of the building. Enter still submits from the button itself, so keyboard users
// aren't stranded; only implicit submission from an input is blocked.
export function blockEnterSubmit(event) {
  if (event.key !== 'Enter') return;
  if (event.target.tagName === 'TEXTAREA') return;
  if (event.target.tagName === 'BUTTON' || event.target.type === 'submit') return;
  event.preventDefault();
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

export function Field({ label, children }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

const naira = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 2 });

export function money(value) {
  if (value == null || value === '') return '—';
  return naira.format(Number(value));
}

// Most of the catalogue carries unit "1" — the price list's way of saying "sold as
// singles" — which renders as a baffling "10 1" next to a quantity. Numeric units say
// nothing, so they're dropped; named ones (amp, vials, 100ml) are kept.
export function unitLabel(unit) {
  if (!unit) return '';
  return Number.isNaN(Number(unit)) ? unit : '';
}

// A quantity with its unit appended, when the unit is worth showing.
export function qtyWithUnit(value, unit) {
  const label = unitLabel(unit);
  return label ? `${qty(value)} ${label}` : qty(value);
}

export function qty(value) {
  if (value == null) return '—';
  // Quantities are NUMERIC in Postgres and arrive as strings; trim trailing .00 noise.
  return Number(value).toLocaleString('en-NG', { maximumFractionDigits: 2 });
}

export function dateOnly(value) {
  if (!value) return '—';
  // Plain 'YYYY-MM-DD' from a Postgres DATE needs no parsing — and must not get any, or a
  // timezone conversion shifts it a day. Timestamps still go through Date.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });
}

// Shared expiry styling so batches read the same way on the batches page and the
// alerts page.
export function ExpiryBadge({ daysToExpiry, isExpired }) {
  const days = Number(daysToExpiry);
  if (isExpired || days < 0) return <span className="badge expired">expired</span>;
  if (days <= 30) return <span className="badge expired">{days}d left</span>;
  if (days <= 90) return <span className="badge soon">{days}d left</span>;
  return <span className="badge ok">{days}d left</span>;
}
