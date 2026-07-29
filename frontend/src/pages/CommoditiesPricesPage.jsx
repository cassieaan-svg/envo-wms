import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty, Field, Modal, money, qty } from '../components/ui.jsx';
import PriceHistoryModal from '../components/PriceHistoryModal.jsx';

const BLANK_COMMODITY = { name: '', category: '', unit: '', reorderLevel: '', maxLevel: '' };

export default function CommoditiesPricesPage({ isAdmin }) {
  const [commodities, setCommodities] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [categories, setCategories] = useState([]);
  const [filters, setFilters] = useState({ category: '', search: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [priceTarget, setPriceTarget] = useState(null);
  const [levelTarget, setLevelTarget] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newCommodity, setNewCommodity] = useState(BLANK_COMMODITY);

  async function load() {
    setLoading(true);
    try {
      const [list, vendorList, cats] = await Promise.all([
        api.commodities.list(filters),
        api.vendors.list(),
        api.commodities.categories(),
      ]);
      setCommodities(list);
      setVendors(vendorList);
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
  const grouped = useMemo(() => {
    const groups = new Map();
    for (const item of commodities) {
      const key = item.category || 'Uncategorised';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return [...groups.entries()];
  }, [commodities]);

  async function addCommodity(event) {
    event.preventDefault();
    setError(null);
    try {
      await api.commodities.create({
        name: newCommodity.name,
        category: newCommodity.category || null,
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
          <h1>Commodities &amp; prices</h1>
          <p>Current price per vendor and brand, with warehouse stock on hand.</p>
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
      </div>

      <div className="card">
        <h2>
          {commodities.length} commodit{commodities.length === 1 ? 'y' : 'ies'}
        </h2>
        {loading ? (
          <Empty>loading…</Empty>
        ) : commodities.length === 0 ? (
          <Empty>Nothing matches those filters.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="wrap">Commodity</th>
                  <th>Unit</th>
                  <th className="num">On hand</th>
                  <th className="num">Reorder / max</th>
                  <th className="wrap">Current price(s)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {grouped.map(([category, items]) => (
                  <Fragment key={category}>
                    <tr className="category-row">
                      <td colSpan={6}>
                        {category} — {items.length}
                      </td>
                    </tr>
                    {items.map((item) => (
                      <tr key={item.id}>
                        <td className="wrap">{item.name}</td>
                        <td>{item.unit || '—'}</td>
                        <td className="num">{qty(item.on_hand)}</td>
                        <td className="num muted">
                          {item.reorder_level == null && item.max_level == null
                            ? '—'
                            : `${item.reorder_level == null ? '—' : qty(item.reorder_level)} / ${
                                item.max_level == null ? '—' : qty(item.max_level)
                              }`}
                        </td>
                        <td className="wrap">
                          {item.current_prices.length === 0 ? (
                            <span className="muted">no price set</span>
                          ) : (
                            item.current_prices.map((p) => (
                              <div key={p.priceId}>
                                {money(p.unitPrice)}{' '}
                                <span className="muted">
                                  · {p.vendorName}
                                  {p.brandName ? ` · ${p.brandName}` : ''}
                                </span>
                              </div>
                            ))
                          )}
                        </td>
                        <td>
                          <div className="row-actions">
                            <button className="btn small" onClick={() => setPriceTarget(item)}>
                              prices
                            </button>
                            {isAdmin && (
                              <button
                                className="btn small"
                                onClick={() =>
                                  setLevelTarget({
                                    ...item,
                                    reorderLevel: item.reorder_level ?? '',
                                    maxLevel: item.max_level ?? '',
                                  })
                                }
                              >
                                levels
                              </button>
                            )}
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

      {priceTarget && (
        <PriceHistoryModal
          commodity={priceTarget}
          vendors={vendors}
          isAdmin={isAdmin}
          onClose={() => setPriceTarget(null)}
          onSaved={load}
        />
      )}

      {levelTarget && (
        <StockLevelModal
          commodity={levelTarget}
          onClose={() => setLevelTarget(null)}
          onSaved={async (message) => {
            setNotice(message);
            setLevelTarget(null);
            await load();
          }}
          onError={setError}
        />
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
              <Field label="Category">
                <input
                  list="wms-categories"
                  value={newCommodity.category}
                  onChange={(e) => setNewCommodity({ ...newCommodity, category: e.target.value })}
                />
                <datalist id="wms-categories">
                  {categories.map((c) => (
                    <option key={c.category} value={c.category} />
                  ))}
                </datalist>
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

function StockLevelModal({ commodity, onClose, onSaved, onError }) {
  const [reorderLevel, setReorderLevel] = useState(commodity.reorderLevel);
  const [maxLevel, setMaxLevel] = useState(commodity.maxLevel);
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
    <Modal title="Stock thresholds" subtitle={commodity.name} onClose={onClose}>
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
    </Modal>
  );
}
