import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty, Field, Modal, dateOnly, money, qty, unitLabel } from '../components/ui.jsx';
import PriceSection from '../components/PriceSection.jsx';
import { downloadCsv, downloadPdf, stamp } from '../lib/download.js';

const PRICE_LIST_COLUMNS = [
  { header: 'Category', value: (c) => c.category || 'Uncategorised' },
  { header: 'Commodity', value: (c) => c.name },
  { header: 'Unit', value: (c) => c.unit || '' },
  { header: 'Unit price (NGN)', value: (c) => c.current_price ?? '', align: 'right' },
  { header: 'On hand', value: (c) => c.on_hand, align: 'right' },
  { header: 'Intake batches', value: (c) => c.batch_count, align: 'right' },
  { header: 'Nearest expiry', value: (c) => c.nearest_expiry || '' },
  { header: 'Reorder level', value: (c) => c.reorder_level ?? '', align: 'right' },
  { header: 'Max level', value: (c) => c.max_level ?? '', align: 'right' },
];

const BLANK_COMMODITY = { name: '', category: '', unitPrice: '', unit: '', reorderLevel: '', maxLevel: '' };

// Where a commodity sits against its own thresholds. 'untracked' is its own bucket rather
// than being lumped in with 'optimal': a commodity with no reorder level has not been
// judged healthy, nobody has said what healthy would be.
export function stockStatus(c) {
  const onHand = Number(c.on_hand) || 0;
  const reorder = c.reorder_level == null ? null : Number(c.reorder_level);
  const max = c.max_level == null ? null : Number(c.max_level);
  if (onHand === 0) return 'out';
  if (reorder == null && max == null) return 'untracked';
  if (max != null && onHand > max) return 'over';
  if (reorder != null && onHand <= reorder) return 'low';
  return 'optimal';
}

const STATUS_TILES = [
  ['all', 'Commodities tracked', ''],
  ['optimal', 'Optimal stock', 'accent'],
  ['low', 'Low stock', 'warn'],
  ['out', 'Out of stock', 'alert'],
  ['over', 'Overstock', ''],
  // Only commodities that hold stock reach this bucket — an empty shelf is counted as
  // out of stock whether or not levels were ever set for it.
  ['untracked', 'No reorder/max levels', ''],
];

export default function CommoditiesPricesPage({ isAdmin }) {
  const [commodities, setCommodities] = useState([]);
  const [categories, setCategories] = useState([]);
  const [filters, setFilters] = useState({ category: '', search: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  // One modal covers price, stock levels and batches — three buttons per row across 440
  // commodities was mostly chrome.
  const [editTarget, setEditTarget] = useState(null);
  const [historyTarget, setHistoryTarget] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [status, setStatus] = useState('all');
  const [newCommodity, setNewCommodity] = useState(BLANK_COMMODITY);

  async function load() {
    setLoading(true);
    try {
      const [list, cats] = await Promise.all([
        api.commodities.list(filters),
        api.commodities.categories(),
      ]);
      setCommodities(list);
      setCategories(cats);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [filters.category, filters.search]);

  // Rendered as one table with category header rows so the layout mirrors the printed
  // price list the data comes from.
  // Counted over everything the category/search filters returned, so selecting a tile
  // narrows the table without collapsing the other tiles to zero.
  const counts = useMemo(() => {
    const tally = { all: commodities.length, optimal: 0, low: 0, out: 0, over: 0, untracked: 0 };
    for (const item of commodities) tally[stockStatus(item)] += 1;
    return tally;
  }, [commodities]);

  const visible = useMemo(
    () => (status === 'all' ? commodities : commodities.filter((c) => stockStatus(c) === status)),
    [commodities, status]
  );

  const grouped = useMemo(() => {
    const groups = new Map();
    for (const item of visible) {
      const key = item.category || 'Uncategorised';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return [...groups.entries()];
  }, [visible]);

  async function addCommodity(event) {
    event.preventDefault();
    setError(null);
    try {
      await api.commodities.create({
        name: newCommodity.name,
        category: newCommodity.category || null,
        unitPrice: newCommodity.unitPrice === '' ? null : Number(newCommodity.unitPrice),
        unit: newCommodity.unit || null,
        reorderLevel: newCommodity.reorderLevel === '' ? null : Number(newCommodity.reorderLevel),
        maxLevel: newCommodity.maxLevel === '' ? null : Number(newCommodity.maxLevel),
      });
      setNotice(`added ${newCommodity.name}`);
      setNewCommodity(BLANK_COMMODITY);
      setShowAdd(false);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Commodities</h1>
          <p>Unit price by category, with warehouse stock on hand.</p>
        </div>
        {isAdmin && (
          <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={() => setShowAdd(true)}>
            Add commodity
          </button>
        )}
      </div>

      <Banner kind="error" onDismiss={() => setError(null)}>
        {error}
      </Banner>
      <Banner kind="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Banner>

      {/* Each tile is a slice of the list below, so clicking one narrows the table to it
          and clicking it again goes back to everything. */}
      <div className="stat-row">
        {STATUS_TILES.map(([key, label, tone]) => (
          <button
            key={key}
            className={`stat clickable ${counts[key] && tone ? tone : ''} ${status === key ? 'selected' : ''}`}
            aria-pressed={status === key}
            onClick={() => setStatus(status === key && key !== 'all' ? 'all' : key)}
          >
            <div className="label">{label}</div>
            <div className="value">{counts[key]}</div>
          </button>
        ))}
      </div>

      <div className="toolbar">
        <Field label="Search">
          <input
            value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
            placeholder="commodity name…"
          />
        </Field>
        <Field label="Category">
          <select
            value={filters.category}
            onChange={(e) => setFilters({ ...filters, category: e.target.value })}
          >
            <option value="">all categories</option>
            {categories.map((c) => (
              <option key={c.category} value={c.category}>
                {c.category} ({c.commodity_count})
              </option>
            ))}
          </select>
        </Field>
        <button className="btn" onClick={load} disabled={loading}>
          {loading ? 'refreshing…' : 'Refresh'}
        </button>
        {(filters.category || filters.search || status !== 'all') && (
          <button
            className="btn"
            onClick={() => {
              setFilters({ category: '', search: '' });
              setStatus('all');
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>
            {visible.length} commodit{visible.length === 1 ? 'y' : 'ies'}
            {status !== 'all' && ` — ${STATUS_TILES.find(([k]) => k === status)[1].toLowerCase()}`}
          </h2>
          {visible.length > 0 && (
            <div className="row-actions">
              <button
                className="btn small"
                onClick={() =>
                  downloadCsv(`price-list-${stamp()}.csv`, PRICE_LIST_COLUMNS, visible)
                }
              >
                ⭳ CSV
              </button>
              <button
                className="btn small"
                onClick={() =>
                  downloadPdf({
                    filename: `price-list-${stamp()}.pdf`,
                    title: 'Commodity Price List',
                    subtitle: 'EnVo Warehouse — Ministry of Health Central Medical Stores, Uyo',
                    meta: [
                      ['Generated', new Date().toLocaleString()],
                      ['Commodities', String(visible.length)],
                      ...(filters.category ? [['Category', filters.category]] : []),
                    ],
                    columns: PRICE_LIST_COLUMNS,
                    rows: visible,
                  })
                }
              >
                ⭳ PDF
              </button>
            </div>
          )}
        </div>
        {loading ? (
          <Empty>loading…</Empty>
        ) : visible.length === 0 ? (
          <Empty>Nothing matches those filters.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="wrap">Commodity</th>
                  <th>Unit</th>
                  <th className="num">Unit price</th>
                  <th className="num">On hand</th>
                  <th>Intake batch no.</th>
                  <th>Expiry</th>
                  <th className="num">Reorder / max</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {grouped.map(([category, items]) => (
                  <Fragment key={category}>
                    <tr className="category-row">
                      <td colSpan={8}>
                        {category} — {items.length}
                      </td>
                    </tr>
                    {items.map((item) => (
                      <tr key={item.id}>
                        <td className="wrap">{item.name}</td>
                        <td>{unitLabel(item.unit) || '—'}</td>
                        <td className="num">
                          {item.current_price == null ? (
                            <span className="muted">not set</span>
                          ) : (
                            money(item.current_price)
                          )}
                        </td>
                        <td className="num">{qty(item.on_hand)}</td>
                        <td>
                          {item.batch_count === 0 ? (
                            <span className="muted">—</span>
                          ) : (
                            <>
                              {item.nearest_batch_number || (
                                <span className="muted">—</span>
                              )}
                              {item.batch_count > 1 && (
                                <span className="muted"> +{item.batch_count - 1}</span>
                              )}
                            </>
                          )}
                        </td>
                        <td>
                          {item.batch_count === 0 ? (
                            <span className="muted">—</span>
                          ) : (
                            dateOnly(item.nearest_expiry)
                          )}
                        </td>
                        <td className="num muted">
                          {item.reorder_level == null && item.max_level == null
                            ? '—'
                            : `${item.reorder_level == null ? '—' : qty(item.reorder_level)} / ${
                                item.max_level == null ? '—' : qty(item.max_level)
                              }`}
                        </td>
                        <td>
                          <div className="row-actions">
                            <button className="btn small" onClick={() => setEditTarget(item)}>
                              {isAdmin ? 'edit' : 'view'}
                            </button>
                            <button className="btn small" onClick={() => setHistoryTarget(item)}>
                              history
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Shared by the add form and the edit modal, so it must live outside both. */}
      <datalist id="wms-categories">
        {categories.map((c) => (
          <option key={c.category} value={c.category} />
        ))}
      </datalist>

      {editTarget && (
        <CommodityModal
          commodity={editTarget}
          isAdmin={isAdmin}
          onClose={() => setEditTarget(null)}
          onSaved={async (message) => {
            if (message) setNotice(message);
            await load();
          }}
          onError={setError}
        />
      )}

      {historyTarget && (
        <HistoryModal commodity={historyTarget} onClose={() => setHistoryTarget(null)} />
      )}

      {showAdd && (
        <Modal title="Add commodity" onClose={() => setShowAdd(false)}>
          <form onSubmit={addCommodity}>
            <div className="form-grid">
              <Field label="Name *">
                <input
                  value={newCommodity.name}
                  onChange={(e) => setNewCommodity({ ...newCommodity, name: e.target.value })}
                  required
                  autoFocus
                />
              </Field>
              <Field label="Category *">
                <input
                  list="wms-categories"
                  value={newCommodity.category}
                  onChange={(e) => setNewCommodity({ ...newCommodity, category: e.target.value })}
                  required
                  placeholder="pick an existing one or type a new one"
                />
              </Field>
              <Field label="Unit price (₦) *">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={newCommodity.unitPrice}
                  onChange={(e) => setNewCommodity({ ...newCommodity, unitPrice: e.target.value })}
                  required
                />
              </Field>
              <Field label="Unit">
                <input
                  value={newCommodity.unit}
                  onChange={(e) => setNewCommodity({ ...newCommodity, unit: e.target.value })}
                  placeholder="1, vial, bottle…"
                />
              </Field>
              <Field label="Reorder level">
                <input
                  type="number"
                  min="0"
                  value={newCommodity.reorderLevel}
                  onChange={(e) => setNewCommodity({ ...newCommodity, reorderLevel: e.target.value })}
                />
              </Field>
              <Field label="Max level">
                <input
                  type="number"
                  min="0"
                  value={newCommodity.maxLevel}
                  onChange={(e) => setNewCommodity({ ...newCommodity, maxLevel: e.target.value })}
                />
              </Field>
              <button className="btn primary" type="submit">
                Add commodity
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

// The lots a commodity currently sits in, and where new ones are entered. The warehouse
// starts with no batch numbers at all, so this is the way they get recorded.
// One place to change anything about a commodity: its price, its stock thresholds, and its
// lots. Replaces the three separate row buttons, which were mostly chrome across 440 rows.
function CommodityModal({ commodity, isAdmin, onClose, onSaved, onError }) {
  return (
    <Modal
      title={commodity.name}
      subtitle={[commodity.category || 'uncategorised', unitLabel(commodity.unit)].filter(Boolean).join(' · ')}
      onClose={onClose}
    >
      <PriceSection commodity={commodity} isAdmin={isAdmin} onSaved={() => onSaved('price updated')} />

      {isAdmin && (
        <LevelsSection
          commodity={commodity}
          onSaved={(message) => onSaved(message)}
          onError={onError}
        />
      )}

      <BatchesSection commodity={commodity} isAdmin={isAdmin} onSaved={onSaved} />
    </Modal>
  );
}

// Where this commodity has actually gone, newest first. The catalogue could otherwise
// tell you what a thing costs and how much is on the shelf, but not who takes it — the
// question you need answered before adjusting a stock level or a reorder point. Kept
// out of the edit modal: reading where stock went is not editing the commodity.
function HistoryModal({ commodity, onClose }) {
  const [lines, setLines] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const result = await api.monitoring.commodityHistory(commodity.id, { limit: 50 });
        setLines(result.rows);
      } catch (err) {
        setError(err.message);
      }
    })();
  }, [commodity.id]);

  return (
    <Modal
      title={commodity.name}
      subtitle="Dispatch history — every facility this has gone to, newest first"
      onClose={onClose}
    >
      {error ? (
        <Banner kind="error" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      ) : !lines ? (
        <Empty>loading…</Empty>
      ) : lines.length === 0 ? (
        <Empty>This commodity has never left the store.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th className="wrap">Facility</th>
                <th>LGA</th>
                <th className="num">Quantity</th>
                <th className="num">Value</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={`${line.source}-${line.order_ref}-${index}`}>
                  <td className="muted">{dateOnly(line.dispatched_at)}</td>
                  <td className="wrap">{line.facility_name || <span className="muted">—</span>}</td>
                  <td className="muted">{line.lga || '—'}</td>
                  <td className="num">{qty(line.quantity)}</td>
                  <td className="num">{money(line.line_value)}</td>
                  <td className="muted">
                    {line.source === 'request' ? 'request' : 'dispatch'} #{line.order_ref}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function BatchesSection({ commodity, isAdmin, onSaved }) {
  const [batches, setBatches] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ batchNumber: '', expiryDate: '', quantity: '', unitCost: '' });
  // "1" across most of the catalogue is the price list's way of saying "singles" and tells
  // nobody anything, so it starts blank and waits for the real dispensing unit.
  const [savedUnit, setSavedUnit] = useState(unitLabel(commodity.unit) || '');
  const [unit, setUnit] = useState(unitLabel(commodity.unit) || '');

  async function saveUnit() {
    setBusy(true);
    setError(null);
    try {
      await api.commodities.update(commodity.id, { unit: unit.trim() || null });
      setSavedUnit(unit.trim());
      setUnit(unit.trim());
      await onSaved?.(`unit set to "${unit.trim() || 'none'}" for ${commodity.name}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function load() {
    try {
      setBatches(await api.commodities.batches(commodity.id));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, [commodity.id]);

  async function addBatch(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.batches.receive({
        commodityId: commodity.id,
        batchNumber: form.batchNumber.trim(),
        expiryDate: form.expiryDate,
        quantity: Number(form.quantity),
        unitCost: form.unitCost === '' ? null : Number(form.unitCost),
      });
      setForm({ batchNumber: '', expiryDate: '', quantity: '', unitCost: '' });
      await load();
      onSaved?.(`batch added to ${commodity.name}${form.batchNumber.trim() ? ` (${form.batchNumber.trim()})` : ''}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Banner kind="error" onDismiss={() => setError(null)}>
        {error}
      </Banner>

      {isAdmin && (
        <form className="card" onSubmit={addBatch}>
          <h2>Add a batch</h2>

          {/* The unit belongs to the commodity, not the lot, so it saves on its own —
              otherwise you couldn't correct it without inventing a batch. */}
          <div className="form-grid" style={{ marginBottom: 14 }}>
            <Field label="Unit of dispensing">
              <input
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder={savedUnit ? 'edit unit' : 'enter unit'}
              />
            </Field>
            <button className="btn primary" type="button" onClick={saveUnit} disabled={busy || unit.trim() === savedUnit}>
              Save unit
            </button>
          </div>

          <div className="form-grid">
            <Field label="Intake batch number">
              <input
                value={form.batchNumber}
                onChange={(e) => setForm({ ...form, batchNumber: e.target.value })}
                autoFocus
              />
            </Field>
            <Field label="Expiry date *">
              <input
                type="date"
                value={form.expiryDate}
                onChange={(e) => setForm({ ...form, expiryDate: e.target.value })}
                required
              />
            </Field>
            <Field label="Quantity *">
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                required
              />
            </Field>
            <Field label="Unit cost (₦)">
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.unitCost}
                onChange={(e) => setForm({ ...form, unitCost: e.target.value })}
              />
            </Field>
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? 'saving…' : 'Add batch'}
            </button>
          </div>
        </form>
      )}

      <div className="card">
        <h2>Intake batches in stock</h2>
        {batches === null ? (
          <Empty>loading…</Empty>
        ) : batches.length === 0 ? (
          <Empty>No intake batches recorded for this commodity yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Intake batch no.</th>
                  <th>Expiry</th>
                  <th className="num">Received</th>
                  <th className="num">Remaining</th>
                  <th className="num">Unit cost</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td>
                      {isAdmin ? (
                        <BatchNumberCell
                          batch={b}
                          onSaved={async () => {
                            await load();
                            // The commodities list shows the nearest lot's number, so it
                            // has to refresh too or the row behind stays stale.
                            await onSaved?.(`intake batch number updated for ${commodity.name}`);
                          }}
                          onError={setError}
                        />
                      ) : (
                        b.batch_number || <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {dateOnly(b.expiry_date)}
                      {b.is_expired && <span className="badge expired" style={{ marginLeft: 6 }}>expired</span>}
                    </td>
                    <td className="num">{qty(b.quantity_received)}</td>
                    <td className="num">{qty(b.quantity_remaining)}</td>
                    <td className="num">{b.unit_cost == null ? '—' : money(b.unit_cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ marginBottom: 0 }}>
          Dispatch draws from these oldest-expiry-first. Intake batches counted onto the shelf before
          their code was read have none — click the dash to enter one.
        </p>
      </div>
    </>
  );
}

// Click a lot's number to type the real one in. Opening stock arrived from a physical
// count with no codes, so most start blank.
function BatchNumberCell({ batch, onSaved, onError }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(batch.batch_number || '');
  const [busy, setBusy] = useState(false);

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.batches.setNumber(batch.id, { batchNumber: value });
      setEditing(false);
      await onSaved();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <button className="btn small" onClick={() => setEditing(true)} title="set the intake batch number">
        {batch.batch_number || <span className="muted">—</span>}
      </button>
    );
  }

  return (
    <form onSubmit={save} style={{ display: 'flex', gap: 6 }}>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="intake batch number"
        autoFocus
        style={{ width: 140 }}
      />
      <button className="btn small primary" type="submit" disabled={busy}>
        save
      </button>
      <button className="btn small" type="button" onClick={() => { setEditing(false); setValue(batch.batch_number || ''); }}>
        cancel
      </button>
    </form>
  );
}

function LevelsSection({ commodity, onSaved, onError }) {
  const [reorderLevel, setReorderLevel] = useState(commodity.reorder_level ?? '');
  const [maxLevel, setMaxLevel] = useState(commodity.max_level ?? '');
  const [saving, setSaving] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    try {
      await api.commodities.setStockLevels(commodity.id, {
        reorderLevel: reorderLevel === '' ? null : Number(reorderLevel),
        maxLevel: maxLevel === '' ? null : Number(maxLevel),
      });
      onSaved(`updated stock levels for ${commodity.name}`);
    } catch (err) {
      onError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <h2>Stock thresholds</h2>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Reorder level (understock below this)">
            <input type="number" min="0" value={reorderLevel} onChange={(e) => setReorderLevel(e.target.value)} />
          </Field>
          <Field label="Max level (overstock above this)">
            <input type="number" min="0" value={maxLevel} onChange={(e) => setMaxLevel(e.target.value)} />
          </Field>
          <button className="btn primary" type="submit" disabled={saving}>
            {saving ? 'saving…' : 'Save levels'}
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Leave a field blank to switch that alert off. Current on hand: {qty(commodity.on_hand)}.
        </p>
      </form>
    </div>
  );
}
