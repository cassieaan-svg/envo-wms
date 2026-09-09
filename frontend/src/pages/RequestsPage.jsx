import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty, Field, Modal, blockEnterSubmit, money, qty, dateTime } from '../components/ui.jsx';
import DayHistory from '../components/DayHistory.jsx';
import { downloadCsv, downloadPdf, slug, stamp } from '../lib/download.js';
import { printDrfVoucher } from '../lib/drfVoucher.js';
import { isValidNgPhone } from '../lib/phone.js';
import { withTxn } from '../lib/txn';

const STATUS_LABEL = { pending: 'Pending', picking: 'Picking', dispatched: 'Dispatched', received: 'Received', rejected: 'Rejected', cancelled: 'Cancelled' };
// Reuses the shared badge palette rather than a private set of chip classes.
const STATUS_BADGE = { pending: 'soon', picking: 'default', dispatched: 'ok', received: 'ok', rejected: 'inactive', cancelled: 'inactive' };

// The day's requests — matched on the day they arrived or the day they shipped, since
// both are that day's work.
const REQUEST_DAY_COLUMNS = [
  { header: 'Raised', value: (r) => dateTime(r.created_at), muted: true },
  { header: 'Request', value: (r) => r.envo_request_id || `#${r.id}` },
  { header: 'Facility', value: (r) => r.facility_name || '', wrap: true },
  { header: 'LGA', value: (r) => r.lga || '', muted: true },
  { header: 'Status', value: (r) => STATUS_LABEL[r.status] || r.status },
  { header: 'Lines', value: (r) => r.line_count, align: 'right' },
  { header: 'Quantity', value: (r) => qty(r.total_quantity), align: 'right' },
  { header: 'Value', value: (r) => money(r.total_amount), align: 'right' },
  { header: 'Dispatched', value: (r) => (r.dispatched_at ? dateTime(r.dispatched_at) : ''), muted: true },
];

const QUEUE_COLUMNS = [
  { header: 'Request', value: (r) => `#${r.id}` },
  { header: 'Facility', value: (r) => r.facility_name || '' },
  { header: 'LGA', value: (r) => r.lga || '' },
  { header: 'Requested by', value: (r) => r.requested_by || '' },
  { header: 'Requester phone', value: (r) => r.requester_phone || '' },
  { header: 'Status', value: (r) => STATUS_LABEL[r.status] || r.status },
  { header: 'Picked by', value: (r) => r.picked_by || '' },
  { header: 'Carried by', value: (r) => r.carrier_name || '' },
  { header: 'Carrier phone', value: (r) => r.carrier_phone || '' },
  { header: 'Received by', value: (r) => r.received_by || '' },
  { header: 'Lines', value: (r) => r.line_count, align: 'right' },
  { header: 'Units', value: (r) => r.total_quantity, align: 'right' },
  { header: 'Total (NGN)', value: (r) => r.total_amount, align: 'right' },
  { header: 'Received', value: (r) => r.created_at },
];

const PICK_COLUMNS = [
  { header: 'Commodity', value: (i) => i.commodity_name },
  { header: 'Category', value: (i) => i.category || '' },
  { header: 'Quantity', value: (i) => i.quantity, align: 'right' },
  { header: 'Unit price (NGN)', value: (i) => i.unit_price, align: 'right' },
  { header: 'Line total (NGN)', value: (i) => i.line_total, align: 'right' },
];

// Facility requests raised from EnVo's Essential Commodities module. The warehouse works
// the queue: open a request, take the pick list, then fulfil (dispatch) it.
export default function RequestsPage() {
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('open'); // open = pending + picking
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sync, setSync] = useState(null);

  async function load() {
    setLoading(true);
    try {
      setRows(await api.requests.list());
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
    // Best effort: the queue marker must never break the page it sits on.
    api.sync.status().then(setSync).catch(() => setSync(null));
  }

  useEffect(() => {
    load();
  }, []);

  // 'received' is a real status now (previously dispatched requests stayed 'dispatched'
  // forever, with received_by/received_at bolted on as side-facts). Folded into the same
  // "Dispatched" tab rather than given its own — it's still the "already shipped" bucket,
  // whether or not the facility has since signed for it.
  const counts = useMemo(
    () => ({
      open: rows.filter((r) => r.status === 'pending' || r.status === 'picking').length,
      dispatched: rows.filter((r) => r.status === 'dispatched' || r.status === 'received').length,
      all: rows.length,
    }),
    [rows]
  );

  const shown = useMemo(() => {
    if (filter === 'open') return rows.filter((r) => r.status === 'pending' || r.status === 'picking');
    if (filter === 'all') return rows;
    if (filter === 'dispatched') return rows.filter((r) => r.status === 'dispatched' || r.status === 'received');
    return rows.filter((r) => r.status === filter);
  }, [rows, filter]);

  async function open(id) {
    setError(null);
    try {
      setDetail(await api.requests.get(id));
    } catch (err) {
      setError(err.message);
    }
  }

  async function act(fn, okMsg) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setDetail(await fn());
      setNotice(okMsg);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Requests</h1>
          <p>Facility requests from the Essential Commodities module.</p>
        </div>
        <SyncMarker sync={sync} />
      </div>

      <Banner kind="error" onDismiss={() => setError(null)}>
        {error}
      </Banner>
      <Banner kind="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Banner>

      <div className="toolbar">
        <Field label="Show">
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="open">Open ({counts.open})</option>
            <option value="dispatched">Dispatched ({counts.dispatched})</option>
            <option value="all">All ({counts.all})</option>
          </select>
        </Field>
        <button className="btn" onClick={load} disabled={loading}>
          {loading ? 'refreshing…' : 'Refresh'}
        </button>
        {filter !== 'open' && (
          <button className="btn" onClick={() => setFilter('open')}>
            Clear filters
          </button>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>
            {shown.length} request{shown.length === 1 ? '' : 's'}
          </h2>
          {shown.length > 0 && (
            <button
              className="btn small"
              onClick={() => downloadCsv(`requests-${filter}-${stamp()}.csv`, QUEUE_COLUMNS, shown)}
            >
              ⭳ CSV
            </button>
          )}
        </div>

        {loading ? (
          <Empty>loading…</Empty>
        ) : shown.length === 0 ? (
          <Empty>No requests {filter === 'open' ? 'in the queue' : 'to show'}.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="wrap">Facility</th>
                  <th className="wrap">Requested by</th>
                  <th>Status</th>
                  <th>Scheme</th>
                  <th className="num">Lines</th>
                  <th className="num">Units</th>
                  <th className="num">Total</th>
                  <th>Received</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td className="wrap">
                      {r.facility_name || <span className="muted">unmatched facility</span>}
                      <div className="muted">{[r.lga, r.state].filter(Boolean).join(', ')}</div>
                    </td>
                    <td className="wrap">
                      {r.requested_by || <span className="muted">—</span>}
                      {r.requester_phone && <div className="muted">{r.requester_phone}</div>}
                    </td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[r.status] || 'inactive'}`}>
                        {STATUS_LABEL[r.status] || r.status}
                      </span>
                    </td>
                    <td>
                      {/* The fund the facility raised it against. */}
                      {r.scheme || <span className="muted">—</span>}
                    </td>
                    <td className="num">{r.line_count}</td>
                    <td className="num">{qty(r.total_quantity)}</td>
                    <td className="num">{money(r.total_amount)}</td>
                    <td className="muted">{dateTime(r.created_at)}</td>
                    <td>
                      <button className="btn small" onClick={() => open(r.id)}>
                        open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {detail && (
        <RequestDetailModal
          request={detail}
          busy={busy}
          onClose={() => setDetail(null)}
          onAct={act}
        />
      )}

      <DayHistory kind="request" noun="Request" columns={REQUEST_DAY_COLUMNS} />
    </>
  );
}

// Who handled the request at each stage. Blank stages are shown as pending rather than
// hidden, so it's obvious what the order is still waiting on.
/**
 * The transitions this request has been through, and whether Cloud has been told.
 *
 * The custody trail beside it answers "who handled this". This answers "what has the system
 * done, and does anyone outside the warehouse know yet". During an outage that second half
 * is the useful part: the dispatch is real, the facility simply has not been told, and a
 * storekeeper who can see that will not go looking for a problem that is not there.
 */
function StatusTrail({ events }) {
  if (!events?.length) return null;

  const LABEL = { picking: 'Picking started', rejected: 'Rejected',
                  cancelled: 'Cancelled', dispatched: 'Dispatched' };
  const pending = events.filter((e) => !e.synced_at).length;

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-head">
        <h2>Status history</h2>
        {pending > 0 && (
          <span className="badge soon">{pending} not yet sent to EnVo</span>
        )}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>When</th><th>What</th><th>By</th><th>Note</th><th>EnVo</th></tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.uid}>
                <td className="muted">{dateTime(e.occurred_at)}</td>
                <td>{LABEL[e.status] || e.status}</td>
                <td>{e.actor || <span className="muted">—</span>}</td>
                <td className="wrap">{e.note || <span className="muted">—</span>}</td>
                <td>
                  {e.synced_at
                    ? <span className="muted" title={dateTime(e.synced_at)}>sent</span>
                    : <span className="badge soon">held</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pending > 0 && (
        <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
          Held updates reach EnVo on their own once the connection is back. The dispatch itself
          is already recorded here — nothing is waiting on it.
        </p>
      )}
    </div>
  );
}

function CustodyTrail({ request }) {
  const stages = [
    { role: 'Requested by', name: request.requested_by, phone: request.requester_phone, at: request.created_at },
    { role: 'Picked by', name: request.picked_by, at: request.picked_at },
    { role: 'Carried by', name: request.carrier_name, phone: request.carrier_phone, at: request.dispatched_at },
    { role: 'Received by', name: request.received_by, at: request.received_at },
  ];

  return (
    <div className="custody">
      {stages.map((s) => (
        <div className="custody-stage" key={s.role}>
          <div className="custody-role">{s.role}</div>
          {s.name ? (
            <>
              <div className="custody-name">{s.name}</div>
              {s.phone && <div className="muted">{s.phone}</div>}
              {s.at && <div className="muted">{dateTime(s.at)}</div>}
            </>
          ) : (
            <div className="muted">not yet</div>
          )}
        </div>
      ))}
    </div>
  );
}

function RequestDetailModal({ request, busy, onClose, onAct }) {
  const base = `pick-list-${request.id}-${slug(request.facility_name || 'facility')}`;
  const where = [request.lga, request.state].filter(Boolean).join(', ');

  const [pickedBy, setPickedBy] = useState(request.picked_by || '');
  const [carrierName, setCarrierName] = useState(request.carrier_name || '');
  const [carrierPhone, setCarrierPhone] = useState(request.carrier_phone || '');
  // Who released the stock. Remembered locally, like the payment and direct-dispatch
  // forms, so the same officer isn't retyping their name on every handover.
  const [dispatchedBy, setDispatchedBy] = useState(
    () => request.dispatched_by || localStorage.getItem('wms_dispatched_by') || ''
  );
  const [receivedBy, setReceivedBy] = useState(request.received_by || '');
  // Issue quantity per line, editable while picking (defaults to the requested amount);
  // clamped to [0, requested] on submit. Only meaningful before dispatch.
  const [issue, setIssue] = useState(() =>
    Object.fromEntries(request.items.map((i) => [i.id, String(i.qty_dispatched ?? i.quantity)])));
  const [rejectReason, setRejectReason] = useState('');
  const [printing, setPrinting] = useState(false);
  const [prints, setPrints] = useState([]);

  // A request only has a dispatch order once it has shipped. Before that the voucher is a
  // pick list and there is nothing to record a copy against.
  const orderId = request.dispatch_order_id || null;

  useEffect(() => {
    if (!orderId) { setPrints([]); return; }
    api.dispatchOrders.prints(orderId).then(setPrints).catch(() => setPrints([]));
  }, [orderId]);

  async function printVoucher() {
    setPrinting(true);
    let label = null;
    if (orderId) {
      try {
        const record = await api.dispatchOrders.print(orderId, {});
        label = record.label;
        setPrints((p) => [...p, record]);
      } catch {
        // Recording the copy failed. Print anyway — refusing to produce a waybill because an
        // audit row could not be written would stop stock leaving over bookkeeping.
        label = null;
      }
    }
    printDrfVoucher(request, { printLabel: label });
    setPrinting(false);
  }
  // Schemes are loaded only to turn the key into a label. The fund is the FACILITY's
  // choice and is not editable here — the store fills the request from that fund or
  // rejects it, so there is deliberately no control to change it.
  const [schemes, setSchemes] = useState([]);
  useEffect(() => {
    let off = false;
    api.schemes.list().then((r) => { if (!off) setSchemes(r || []); }).catch(() => {});
    return () => { off = true; };
  }, []);
  const requestScheme = schemes.find((x) => x.key === request.scheme);
  const schemeLabel = requestScheme?.label || request.scheme || '—';
  const clampIssue = (i) => Math.max(0, Math.min(Number(issue[i.id] ?? i.quantity) || 0, Number(i.quantity)));

  const canDispatch =
    (request.picked_by || pickedBy.trim()) && carrierName.trim() && carrierPhone.trim()
    && dispatchedBy.trim();

  const phoneValid = isValidNgPhone(carrierPhone);

  function pdf() {
    return downloadPdf({
      filename: `${base}.pdf`,
      title: `Pick List — Request #${request.id}`,
      subtitle: 'EnVo Warehouse — Ministry of Health Central Medical Stores, Uyo',
      meta: [
        ['Facility', request.facility_name || 'Unmatched facility'],
        ['LGA / State', where || '—'],
        ['Requested', dateTime(request.created_at)],
        ['Status', STATUS_LABEL[request.status] || request.status],
        ['Scheme', request.scheme || '—'],
        ['Requested by', [request.requested_by, request.requester_phone].filter(Boolean).join(' · ') || '—'],
        ['Picked by', request.picked_by || '—'],
        ['Carried by', [request.carrier_name, request.carrier_phone].filter(Boolean).join(' · ') || '—'],
        ['Received by', request.received_by || '—'],
        ...(request.notes ? [['Notes', request.notes]] : []),
      ],
      columns: PICK_COLUMNS,
      rows: request.items,
      total: { label: 'Request total', value: money(request.total_amount) },
    });
  }

  return (
    <Modal
      title={`Request #${request.id} · ${request.facility_name || 'Unmatched facility'}`}
      subtitle={`${STATUS_LABEL[request.status] || request.status}${where ? ` · ${where}` : ''}`}
      onClose={onClose}
    >
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <button className="btn small" onClick={() => downloadCsv(`${base}.csv`, PICK_COLUMNS, request.items)}>
          ⭳ CSV
        </button>
        <button className="btn small" onClick={pdf}>
          ⭳ PDF
        </button>
        <button className="btn small" onClick={printVoucher} disabled={printing}>
          {printing ? 'preparing…'
            : prints.length === 0 ? '⎙ DRF Voucher'
            : `⎙ Reprint (#${prints.length})`}
        </button>
      </div>

      <CustodyTrail request={request} />

      <StatusTrail events={request.statusEvents} />

      {prints.length > 1 && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
          <strong>{prints.length} copies of this waybill taken.</strong>{' '}
          {prints.map((p, i) => (
            <span key={p.uid || i}>
              {i > 0 && ' · '}{p.label}{p.printed_by ? ` — ${p.printed_by}` : ''}
            </span>
          ))}
        </div>
      )}

      {request.notes && <Banner kind="warn">{request.notes}</Banner>}

      {(request.status === 'pending' || request.status === 'picking') && (
        <div className="card" onKeyDown={blockEnterSubmit}>
          <h2>Quantities to issue</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Set the quantity actually issued for each line (defaults to requested; can't exceed it).
            What's on hand is the hard cap — a line short of stock issues what's available. Adjust
            these before picking and up until the stock is handed to the carrier.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="wrap">Commodity</th>
                  <th className="num">Requested</th>
                  <th className="num">Issue qty</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {request.items.map((i) => {
                  const removed = Number(issue[i.id] ?? i.quantity) <= 0;
                  return (
                    <tr key={i.id} style={removed ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
                      <td className="wrap">{i.commodity_name}</td>
                      <td className="num">{qty(i.quantity)}</td>
                      <td className="num">
                        <input
                          type="number" min="0" max={i.quantity} step="1"
                          value={issue[i.id] ?? ''}
                          onChange={(e) => setIssue((s) => ({ ...s, [i.id]: e.target.value }))}
                          style={{ width: 90, textAlign: 'right' }}
                        />
                      </td>
                      <td className="c">
                        {removed ? (
                          <button type="button" className="btn small" onClick={() => setIssue((s) => ({ ...s, [i.id]: String(i.quantity) }))}>
                            Restore
                          </button>
                        ) : (
                          <button type="button" className="btn small" onClick={() => setIssue((s) => ({ ...s, [i.id]: '0' }))}>
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {request.status === 'pending' && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            onAct(
              () =>
                withTxn(`picking:${request.id}`, (clientTxnId) =>
                  api.requests.markPicking(request.id, { pickedBy: pickedBy.trim(), clientTxnId })),
              `Picking started by ${pickedBy.trim()}.`
            );
          }}
        >
          <h2>Start picking</h2>
          <div className="form-grid">
            <Field label="Picked by *">
              <input
                value={pickedBy}
                onChange={(e) => setPickedBy(e.target.value)}
                placeholder="store officer's name"
                required
              />
            </Field>
            <button className="btn" type="submit" disabled={busy || !pickedBy.trim()}>
              Mark picking
            </button>
          </div>
        </form>
      )}

      {(request.status === 'pending' || request.status === 'picking') && (
        <form
          className="card"
          onKeyDown={blockEnterSubmit}
          onSubmit={(e) => {
            e.preventDefault();
            // Remembered here rather than through onAct, which takes only (fn, okMsg).
            localStorage.setItem('wms_dispatched_by', dispatchedBy.trim());
            onAct(
              () =>
                withTxn(`fulfil:${request.id}`, (clientTxnId) =>
                  api.requests.fulfil(request.id, {
                    pickedBy: pickedBy.trim(),
                    carrierName: carrierName.trim(),
                    carrierPhone: carrierPhone.trim(),
                    dispatchedBy: dispatchedBy.trim(),
                    items: request.items.map((i) => ({ itemId: i.id, qty: clampIssue(i) })),
                    clientTxnId,
                  })),
              'Dispatched — EnVo notified.'
            );
          }}
        >
          <h2>Hand over to carrier</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Issue quantities are set in “Quantities to issue” above. Naming the carrier releases
            that stock.
          </p>
          <div className="form-grid">
            <Field label="Scheme">
              {/* Read-only: the facility raised this request against this fund, and it is
                  filled from that fund or rejected. */}
              <div>
                <strong>{schemeLabel}</strong>
                {requestScheme?.creates_debt && (
                  <div className="muted">Billed to the facility.</div>
                )}
              </div>
            </Field>
            <Field label="Dispatched by *">
              <input
                value={dispatchedBy}
                onChange={(e) => setDispatchedBy(e.target.value)}
                placeholder="who is releasing the stock"
                required
              />
            </Field>
            <Field label="Carrier name *">
              <input
                value={carrierName}
                onChange={(e) => setCarrierName(e.target.value)}
                placeholder="driver or collector"
                required
              />
            </Field>
            <Field label="Carrier phone *">
              <input
                value={carrierPhone}
                onChange={(e) => setCarrierPhone(e.target.value)}
                placeholder="08000000000"
                required
              />
              {!phoneValid && carrierPhone.trim() && (
                <div className="muted" style={{ color: '#b0413e' }}>
                  Enter a complete Nigerian number, e.g. 08012345678 or +2348012345678
                </div>
              )}
            </Field>
            <button className="btn primary" type="submit" disabled={busy || !canDispatch || !phoneValid}>
              {busy ? 'dispatching…' : 'Fulfil & dispatch'}
            </button>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            Stock isn&apos;t released without a named carrier — this is the handover record.
          </p>
        </form>
      )}

      {(request.status === 'pending' || request.status === 'picking') && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            onAct(
              () =>
                withTxn(`reject:${request.id}`, (clientTxnId) =>
                  api.requests.reject(request.id, { reason: rejectReason.trim(), clientTxnId })),
              'Request rejected — the facility will be notified to re-request.'
            );
          }}
        >
          <h2>Reject request</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Use this when nothing can be filled. No stock moves; EnVo cancels the request and the
            facility re-requests once CMS confirms stock.
          </p>
          <div className="form-grid">
            <Field label="Reason *">
              <input
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="e.g. out of stock"
                required
              />
            </Field>
            <button className="btn danger" type="submit" disabled={busy || !rejectReason.trim()}>
              Reject request
            </button>
          </div>
        </form>
      )}

      {request.status === 'dispatched' && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            onAct(
              () => api.requests.recordReceipt(request.id, { receivedBy: receivedBy.trim() }),
              `Receipt recorded for ${receivedBy.trim()}.`
            );
          }}
        >
          <h2>Record receipt</h2>
          <div className="form-grid">
            <Field label="Received by *">
              <input
                value={receivedBy}
                onChange={(e) => setReceivedBy(e.target.value)}
                placeholder="who signed for it at the facility"
                required
              />
            </Field>
            <button className="btn" type="submit" disabled={busy || !receivedBy.trim()}>
              Record receipt
            </button>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            Fills in automatically when the facility confirms delivery in EnVo — use this if
            the signed waybill comes back first.
          </p>
        </form>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="wrap">Commodity</th>
              <th>Category</th>
              <th className="num">Qty</th>
              <th className="num">Unit price</th>
              <th className="num">Line total</th>
            </tr>
          </thead>
          <tbody>
            {request.items.map((i) => (
              <tr key={i.id}>
                <td className="wrap">{i.commodity_name}</td>
                <td className="muted">{i.category || '—'}</td>
                <td className="num">{qty(i.quantity)}</td>
                <td className="num">{money(i.unit_price)}</td>
                <td className="num">{money(i.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="total-bar">
        <span className="label">Request total</span>
        <span className="amount">{money(request.total_amount)}</span>
      </div>

      {(request.status === 'dispatched' || request.status === 'received') && (
        <p className="muted" style={{ marginBottom: 0 }}>
          Dispatched {dateTime(request.dispatched_at)}
          {request.dispatched_by ? ` by ${request.dispatched_by}` : ''}.
          {request.status === 'received' && (
            <>
              {' '}Received {dateTime(request.received_at)}
              {request.received_by ? ` by ${request.received_by}` : ''}.
            </>
          )}
        </p>
      )}
    </Modal>
  );
}

// Requests reach EnVo through the outbox, so when the store is offline the queue grows
// rather than the updates being lost. Staff need to see that difference: a backlog is
// normal and self-healing, but they should know the facility hasn't been told yet.
function SyncMarker({ sync }) {
  if (!sync) return null;

  const pending = Number(sync.pending) || 0;
  const lastDelivered = sync.last_delivered_at;
  // Present only on a CMS instance. On Cloud these are undefined and the extra lines simply
  // do not render, so one component serves both roles.
  const isCms = sync.role?.role === 'cms';
  const pendingTxns = Number(sync.pendingTransactions) || 0;
  const pendingStatus = Number(sync.pendingStatusEvents) || 0;
  const stale = sync.masterData?.staleness;

  return (
    <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
      <div className="muted" style={{ fontSize: 12 }}>
        {pending > 0 ? (
          <>
            <span className="badge soon">{pending} waiting to reach EnVo</span>
            {sync.oldest_pending_at && <> · oldest {dateTime(sync.oldest_pending_at)}</>}
          </>
        ) : (
          <>EnVo is up to date</>
        )}
      </div>

      {/* On CMS the question staff actually ask during an outage is not "does EnVo know?"
          but "is my work safe?". A backlog here is normal and self-healing — the stock has
          already moved locally and the record is committed — so it is stated plainly rather
          than as a warning. */}
      {isCms && (
        <div className="muted" style={{ fontSize: 12 }}>
          {pendingTxns > 0 || pendingStatus > 0 ? (
            <>
              <span className="badge soon">
                {[pendingTxns > 0 && `${pendingTxns} transaction(s)`,
                  pendingStatus > 0 && `${pendingStatus} status update(s)`]
                  .filter(Boolean).join(' and ')} held for Cloud
              </span>
              {' '}· recorded here and safe
            </>
          ) : (
            <>Cloud has everything this warehouse has done</>
          )}
        </div>
      )}

      {/* Stale master data is the one thing that does change what the warehouse may do. */}
      {isCms && stale && stale.level !== 'fresh' && (
        <div style={{ fontSize: 12 }}>
          <span className={`badge ${stale.level === 'blocked' ? 'alert' : 'soon'}`}>
            {stale.level === 'blocked' ? 'Priced dispatch paused' : 'Master data ageing'}
          </span>
          {' '}
          <span className="muted">{stale.message}</span>
        </div>
      )}

      {lastDelivered && (
        <div className="muted" style={{ fontSize: 12 }}>
          last synced {dateTime(lastDelivered)}
        </div>
      )}
    </div>
  );
}
