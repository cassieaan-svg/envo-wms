import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty, Field, Modal, blockEnterSubmit, money, qty, dateTime } from '../components/ui.jsx';
import DayHistory from '../components/DayHistory.jsx';
import { downloadCsv, downloadPdf, slug, stamp } from '../lib/download.js';
import { printDrfVoucher } from '../lib/drfVoucher.js';

const STATUS_LABEL = { pending: 'Pending', picking: 'Picking', dispatched: 'Dispatched', rejected: 'Rejected' };
// Reuses the shared badge palette rather than a private set of chip classes.
const STATUS_BADGE = { pending: 'soon', picking: 'default', dispatched: 'ok', rejected: 'inactive' };

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

  const counts = useMemo(
    () => ({
      open: rows.filter((r) => r.status === 'pending' || r.status === 'picking').length,
      dispatched: rows.filter((r) => r.status === 'dispatched').length,
      all: rows.length,
    }),
    [rows]
  );

  const shown = useMemo(() => {
    if (filter === 'open') return rows.filter((r) => r.status === 'pending' || r.status === 'picking');
    if (filter === 'all') return rows;
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
  const [receivedBy, setReceivedBy] = useState(request.received_by || '');
  // Issue quantity per line, editable while picking (defaults to the requested amount);
  // clamped to [0, requested] on submit. Only meaningful before dispatch.
  const [issue, setIssue] = useState(() =>
    Object.fromEntries(request.items.map((i) => [i.id, String(i.qty_dispatched ?? i.quantity)])));
  const [rejectReason, setRejectReason] = useState('');
  const clampIssue = (i) => Math.max(0, Math.min(Number(issue[i.id] ?? i.quantity) || 0, Number(i.quantity)));

  const canDispatch = (request.picked_by || pickedBy.trim()) && carrierName.trim() && carrierPhone.trim();

  function isCompleteNigerianNumber(s) {
    const d = (s || '').toString().replace(/\D/g, '');
    if (d.startsWith('234') && d.length === 13) return true;
    if (d.startsWith('0') && d.length === 11) return true;
    return false;
  }

  const phoneValid = isCompleteNigerianNumber(carrierPhone);

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
        <button className="btn small" onClick={() => printDrfVoucher(request)}>
          ⎙ DRF Voucher
        </button>
      </div>

      <CustodyTrail request={request} />

      {request.notes && <Banner kind="warn">{request.notes}</Banner>}

      {request.status === 'pending' && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            onAct(
              () => api.requests.markPicking(request.id, { pickedBy: pickedBy.trim() }),
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
            onAct(
              () =>
                api.requests.fulfil(request.id, {
                  pickedBy: pickedBy.trim(),
                  carrierName: carrierName.trim(),
                  carrierPhone: carrierPhone.trim(),
                  items: request.items.map((i) => ({ itemId: i.id, qty: clampIssue(i) })),
                }),
              'Dispatched — EnVo notified.'
            );
          }}
        >
          <h2>Hand over to carrier</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Set the quantity actually issued for each line (defaults to requested; can't exceed it).
            What's on hand is the hard cap — a line short of stock issues what's available.
          </p>
          <div className="table-wrap" style={{ marginBottom: 12 }}>
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
          <div className="form-grid">
            {/* Removed duplicate 'Picked by' field here; use 'Start picking' above instead */}
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
              () => api.requests.reject(request.id, { reason: rejectReason.trim() }),
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

      {request.status === 'dispatched' && !request.received_by && (
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

      {request.status === 'dispatched' && (
        <p className="muted" style={{ marginBottom: 0 }}>
          Dispatched {dateTime(request.dispatched_at)}
          {request.dispatched_by ? ` by ${request.dispatched_by}` : ''}.
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
      {lastDelivered && (
        <div className="muted" style={{ fontSize: 12 }}>
          last synced {dateTime(lastDelivered)}
        </div>
      )}
    </div>
  );
}
