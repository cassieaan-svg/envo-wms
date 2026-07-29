// Small shared presentational helpers used across the pages.

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

export function qty(value) {
  if (value == null) return '—';
  // Quantities are NUMERIC in Postgres and arrive as strings; trim trailing .00 noise.
  return Number(value).toLocaleString('en-NG', { maximumFractionDigits: 2 });
}

export function dateOnly(value) {
  if (!value) return '—';
  return new Date(value).toISOString().slice(0, 10);
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
