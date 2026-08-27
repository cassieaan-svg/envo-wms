import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { STATE, classifyConnection, probeServer } from '../lib/connection.js';
import { applyPendingUpdate, onUpdateAvailable } from '../lib/pwa.js';

// One line telling the warehouse what it needs to know, in operational language.
//
// Three states, and the difference between them matters more than any of them individually:
//
//   Connected      nothing to say — the bar stays out of the way
//   Waiting        the internet is down; work is being recorded and held. NORMAL.
//   Unavailable    the CMS server cannot be reached; nothing can be recorded. NOT normal.
//
// The middle state is the one people get wrong. It looks like a failure and is not: the
// warehouse is working exactly as designed, and the only thing outstanding is telling Cloud.
// So it is worded as reassurance rather than as a warning, and the bar never uses the word
// "offline" on its own — which would blur it into the third state, where the app really has
// stopped working.

const POLL_MS = 20_000;

export default function ConnectionBar() {
  const [conn, setConn] = useState({ state: STATE.CHECKING });
  const [updateReady, setUpdateReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    onUpdateAvailable(() => setUpdateReady(true));
  }, []);

  useEffect(() => {
    let alive = true;

    async function poll() {
      const probe = await probeServer();
      if (!alive) return;

      if (!probe.serverUp) {
        setConn(classifyConnection({ serverUp: false, error: probe.error }));
        return;
      }
      // Only ask about Cloud once the server is known to be up. Asking first would report a
      // Cloud problem when the real problem is that nothing is reachable at all.
      let sync = null;
      try { sync = await api.sync.status(); } catch { /* the bar must never break the page */ }
      if (!alive) return;
      setConn(classifyConnection({ serverUp: true, sync }));
    }

    poll();
    const t = setInterval(poll, POLL_MS);
    const onFocus = () => poll();
    window.addEventListener('focus', onFocus);
    return () => { alive = false; clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, []);

  if (updateReady) {
    return (
      <div className="conn-bar soon">
        <strong>A new version is ready.</strong> It will be used next time the app starts, or
        update now — anything you are part-way through will be lost.
        <button className="btn small" onClick={applyPendingUpdate} style={{ marginLeft: 8 }}>
          Update now
        </button>
      </div>
    );
  }

  // Connected and up to date is the normal state and says nothing at all. A bar that is
  // always there is a bar nobody reads.
  if (conn.state === STATE.CONNECTED || conn.state === STATE.CHECKING) return null;
  if (conn.state === STATE.HOLDING && dismissed) return null;

  const unavailable = conn.state === STATE.UNAVAILABLE;

  return (
    <div className={`conn-bar ${unavailable ? 'alert' : 'soon'}`} role={unavailable ? 'alert' : 'status'}>
      <strong>{conn.short}.</strong> {conn.detail}
      {!unavailable && (
        <button className="btn small" onClick={() => setDismissed(true)} style={{ marginLeft: 8 }}>
          dismiss
        </button>
      )}
    </div>
  );
}
