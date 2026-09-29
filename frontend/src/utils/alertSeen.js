// Tracks which stock/expiry alerts a facility has already been shown, so the nav
// badge behaves like a notification trigger rather than a running tally: it lights
// up when a NEW alert appears, and clears while the Alerts page is open. An alert
// that's still active after being seen (the same low-stock item, still low) does
// not keep lighting the badge — only a genuinely new one does.
//
// Persisted in localStorage per facility, since the badge is read from the nav
// (mounted independently of the Alerts page) and must survive a reload.
const storageKey = (fid) => `envo_alerts_seen_${fid}`

function readSeen(fid) {
  try {
    const raw = localStorage.getItem(storageKey(fid))
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch { return new Set() }
}

// Unseen = currently-active alert keys minus whatever was marked seen the last
// time the Alerts page was open. A key that stopped being active (resolved) is
// simply absent from `keys` next time — nothing to clean up here.
export function unseenAlertKeys(fid, keys) {
  if (!fid) return []
  const seen = readSeen(fid)
  return (keys || []).filter(k => !seen.has(k))
}

// Fired after marking alerts seen, so the nav — a separate component that isn't
// listening to localStorage — knows to recompute its badge right away. Without
// this, the badge only refreshed on the next 'stock' realtime event or a full
// remount, so it kept showing a stale count while the Alerts page was open and
// had already cleared it.
export const ALERTS_SEEN_EVENT = 'envo:alerts-seen'

// Called when the Alerts page loads (or refreshes) its current alert list —
// marks every alert now visible as seen, which is what clears the nav badge.
export function markAlertsSeen(fid, keys) {
  if (!fid) return
  try { localStorage.setItem(storageKey(fid), JSON.stringify(keys || [])) } catch { /* ignore */ }
  try { window.dispatchEvent(new CustomEvent(ALERTS_SEEN_EVENT, { detail: { fid } })) } catch { /* ignore */ }
}
