import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty, Field, Modal, dateTime, qty } from '../components/ui.jsx';

const BLANK = { name: '', state: '', lga: '', envoFacilityId: '' };

export default function FacilitiesPage({ isAdmin }) {
  const [facilities, setFacilities] = useState([]);
  const [stateFilter, setStateFilter] = useState('');
  const [form, setForm] = useState(BLANK);
  const [editingId, setEditingId] = useState(null);
  const [assignFor, setAssignFor] = useState(null);
  const [stockFor, setStockFor] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      setFacilities(await api.facilities.list({ state: stateFilter }));
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [stateFilter]);

  // Derived from the loaded rows rather than a dedicated endpoint — the facility list is
  // small enough that a separate round trip isn't worth it.
  const [allStates, setAllStates] = useState([]);
  useEffect(() => {
    if (!stateFilter) setAllStates([...new Set(facilities.map((f) => f.state))].sort());
  }, [facilities, stateFilter]);

  function startEdit(facility) {
    setEditingId(facility.id);
    setForm({
      name: facility.name || '',
      state: facility.state || '',
      lga: facility.lga || '',
      envoFacilityId: facility.envo_facility_id || '',
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(BLANK);
  }

  async function submit(event) {
    event.preventDefault();
    setError(null);
    try {
      if (editingId) {
        await api.facilities.update(editingId, form);
        setNotice(`updated ${form.name}`);
      } else {
        await api.facilities.create(form);
        setNotice(`added ${form.name}`);
      }
      cancelEdit();
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Facilities</h1>
          <p>Sites the central store supplies. Dispatch orders and stock views hang off these.</p>
        </div>
      </div>

      <Banner kind="error" onDismiss={() => setError(null)}>
        {error}
      </Banner>
      <Banner kind="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Banner>

      <div className="toolbar">
        <Field label="State">
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
            <option value="">all states</option>
            {allStates.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {isAdmin && (
        <form className="card" onSubmit={submit}>
          <h2>{editingId ? 'Edit facility' : 'Add facility'}</h2>
          <div className="form-grid">
            <Field label="Name *">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </Field>
            <Field label="State *">
              <input value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} required />
            </Field>
            <Field label="LGA">
              <input value={form.lga} onChange={(e) => setForm({ ...form, lga: e.target.value })} />
            </Field>
            <Field label="EnVo facility ID">
              <input
                value={form.envoFacilityId}
                onChange={(e) => setForm({ ...form, envoFacilityId: e.target.value })}
                placeholder="for the EnVo stock lookup"
              />
            </Field>
            <div className="row-actions">
              <button className="btn primary" type="submit">
                {editingId ? 'Save changes' : 'Add facility'}
              </button>
              {editingId && (
                <button className="btn" type="button" onClick={cancelEdit}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        </form>
      )}

      <div className="card">
        <h2>
          {facilities.length} facilit{facilities.length === 1 ? 'y' : 'ies'}
        </h2>
        {loading ? (
          <Empty>loading…</Empty>
        ) : facilities.length === 0 ? (
          <Empty>No facilities yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="wrap">Name</th>
                  <th>State</th>
                  <th>LGA</th>
                  <th>EnVo ID</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {facilities.map((facility) => (
                  <tr key={facility.id}>
                    <td className="wrap">{facility.name}</td>
                    <td>{facility.state}</td>
                    <td>{facility.lga || '—'}</td>
                    <td className="muted">{facility.envo_facility_id || '—'}</td>
                    <td>
                      <div className="row-actions">
                        <button className="btn small" onClick={() => setAssignFor(facility)}>
                          commodities
                        </button>
                        <button className="btn small" onClick={() => setStockFor(facility)}>
                          EnVo stock
                        </button>
                        {isAdmin && (
                          <button className="btn small" onClick={() => startEdit(facility)}>
                            edit
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {assignFor && (
        <AssignmentModal
          facility={assignFor}
          isAdmin={isAdmin}
          onClose={() => setAssignFor(null)}
          onError={setError}
        />
      )}

      {stockFor && <StockModal facility={stockFor} onClose={() => setStockFor(null)} />}
    </>
  );
}

function AssignmentModal({ facility, isAdmin, onClose, onError }) {
  const [assigned, setAssigned] = useState([]);
  const [commodities, setCommodities] = useState([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [assignedRows, all] = await Promise.all([
        api.facilities.commodities(facility.id),
        api.commodities.list(),
      ]);
      setAssigned(assignedRows);
      setCommodities(all);
    } catch (err) {
      onError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, [facility.id]);

  const assignedIds = useMemo(() => new Set(assigned.map((a) => a.commodity_id)), [assigned]);
  const available = useMemo(
    () =>
      commodities
        .filter((c) => !assignedIds.has(c.id))
        .filter((c) => !search || c.name.toLowerCase().includes(search.toLowerCase()))
        .slice(0, 100),
    [commodities, assignedIds, search]
  );

  async function guard(fn) {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Assigned commodities"
      subtitle={`${facility.name} · this is a default list, not a restriction`}
      onClose={onClose}
    >
      <div className="card">
        <h2>Assigned ({assigned.length})</h2>
        {assigned.length === 0 ? (
          <Empty>Nothing assigned yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="wrap">Commodity</th>
                  <th>Category</th>
                  <th>Source</th>
                  {isAdmin && <th />}
                </tr>
              </thead>
              <tbody>
                {assigned.map((row) => (
                  <tr key={row.id}>
                    <td className="wrap">{row.name}</td>
                    <td className="muted">{row.category || '—'}</td>
                    <td>
                      {row.is_default ? (
                        <span className="badge default">standard</span>
                      ) : (
                        <span className="badge manual">added</span>
                      )}
                    </td>
                    {isAdmin && (
                      <td>
                        <button
                          className="btn small danger"
                          disabled={busy}
                          onClick={() =>
                            guard(() => api.facilities.removeCommodity(facility.id, row.commodity_id))
                          }
                        >
                          remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {isAdmin && (
        <div className="card">
          <h2>Available to add</h2>
          <Field label="Search">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="commodity name…" />
          </Field>
          {available.length === 0 ? (
            <Empty>Nothing left to add.</Empty>
          ) : (
            <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
              <table>
                <tbody>
                  {available.map((c) => (
                    <tr key={c.id}>
                      <td className="wrap">{c.name}</td>
                      <td className="muted">{c.category || '—'}</td>
                      <td>
                        <button
                          className="btn small"
                          disabled={busy}
                          onClick={() =>
                            guard(() =>
                              api.facilities.addCommodity(facility.id, { commodityId: c.id, isDefault: false })
                            )
                          }
                        >
                          add
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function StockModal({ facility, onClose }) {
  const [stock, setStock] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.facilities
      .stock(facility.id)
      .then(setStock)
      .catch((err) => setError(err.message));
  }, [facility.id]);

  return (
    <Modal title="Facility stock from EnVo" subtitle={facility.name} onClose={onClose}>
      <Banner kind="error">{error}</Banner>

      {!stock && !error ? (
        <Empty>loading…</Empty>
      ) : (
        stock && (
          <>
            {stock.isMockData && (
              <Banner kind="warn">
                Placeholder data — the live EnVo stock API is not wired in yet.
              </Banner>
            )}
            <p className="muted">As of {dateTime(stock.asOf)}</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="wrap">Commodity</th>
                    <th className="num">On hand</th>
                    <th>Unit</th>
                  </tr>
                </thead>
                <tbody>
                  {stock.items.map((item) => (
                    <tr key={item.commodityId}>
                      <td className="wrap">{item.name}</td>
                      <td className="num">{qty(item.quantityOnHand)}</td>
                      <td>{item.unit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      )}
    </Modal>
  );
}
