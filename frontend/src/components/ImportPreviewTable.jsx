import { Fragment, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty, Field, money } from './ui.jsx';

// Staged rows for one import. Rows can be repriced, vendor-assigned or excluded before
// the batch is committed. The source price list has no vendor column, so "apply vendor to
// all rows" is the normal first step.
export default function ImportPreviewTable({
  importRow,
  rows,
  vendors,
  isAdmin,
  onRefresh,
  onCommitted,
  onError,
  onClose,
}) {
  const [bulkVendor, setBulkVendor] = useState('');
  const [bulkBrand, setBulkBrand] = useState('');
  const [busy, setBusy] = useState(false);
  const [onlyProblems, setOnlyProblems] = useState(false);

  const committed = Boolean(importRow.committed_at);

  const stats = useMemo(() => {
    const included = rows.filter((r) => !r.is_excluded);
    return {
      included: included.length,
      excluded: rows.length - included.length,
      missingVendor: included.filter((r) => !r.vendor_id).length,
      missingPrice: included.filter((r) => r.unit_price == null).length,
      newCommodities: included.filter((r) => !r.commodity_id).length,
    };
  }, [rows]);

  const visible = useMemo(
    () =>
      onlyProblems
        ? rows.filter((r) => !r.is_excluded && (r.unit_price == null || !r.vendor_id))
        : rows,
    [rows, onlyProblems]
  );

  const grouped = useMemo(() => {
    const groups = new Map();
    for (const row of visible) {
      const key = row.category || 'Uncategorised';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return [...groups.entries()];
  }, [visible]);

  async function guard(fn) {
    setBusy(true);
    try {
      await fn();
      await onRefresh();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const applyVendor = () =>
    guard(() =>
      api.priceListImports.assignVendor(importRow.id, {
        vendorId: Number(bulkVendor),
        brandName: bulkBrand || null,
      })
    );

  const updateRow = (row, patch) => guard(() => api.priceListImports.updateRow(importRow.id, row.id, patch));

  async function commit() {
    const message =
      `Commit ${stats.included} rows?\n\n` +
      `· ${stats.newCommodities} new commodities will be created\n` +
      `· ${stats.included} prices will be set as current\n\n` +
      'Existing current prices for these vendor/brand combinations become history.';
    if (!window.confirm(message)) return;

    setBusy(true);
    try {
      onCommitted(await api.priceListImports.commit(importRow.id));
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const blockers = stats.missingVendor + stats.missingPrice;

  return (
    <div className="card">
      <div className="modal-head">
        <h2>{importRow.filename}</h2>
        <span className="muted">
          {committed ? 'committed' : 'staged for review'} · {rows.length} parsed rows
        </span>
        <button className="btn small" onClick={onClose}>
          close
        </button>
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="label">Included</div>
          <div className="value">{stats.included}</div>
        </div>
        <div className="stat">
          <div className="label">Excluded</div>
          <div className="value">{stats.excluded}</div>
        </div>
        <div className={`stat ${stats.missingVendor ? 'alert' : ''}`}>
          <div className="label">No vendor</div>
          <div className="value">{stats.missingVendor}</div>
        </div>
        <div className={`stat ${stats.missingPrice ? 'warn' : ''}`}>
          <div className="label">No price</div>
          <div className="value">{stats.missingPrice}</div>
        </div>
        <div className="stat">
          <div className="label">New commodities</div>
          <div className="value">{stats.newCommodities}</div>
        </div>
      </div>

      {committed ? (
        <Banner kind="success">
          This import was committed. The rows below are kept as an audit trail.
        </Banner>
      ) : (
        blockers > 0 && (
          <Banner kind="warn">
            {blockers} row(s) still need a vendor or a price. Fix or exclude them before committing.
          </Banner>
        )
      )}

      {isAdmin && !committed && (
        <div className="toolbar">
          <Field label="Apply vendor to all included rows">
            <select value={bulkVendor} onChange={(e) => setBulkVendor(e.target.value)}>
              <option value="">select vendor…</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Brand (optional)">
            <input value={bulkBrand} onChange={(e) => setBulkBrand(e.target.value)} placeholder="generic" />
          </Field>
          <button className="btn" onClick={applyVendor} disabled={busy || !bulkVendor}>
            Apply to all
          </button>
          <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={onlyProblems}
              onChange={(e) => setOnlyProblems(e.target.checked)}
              style={{ width: 'auto' }}
            />
            only rows needing attention
          </label>
          <button
            className="btn primary"
            style={{ marginLeft: 'auto' }}
            onClick={commit}
            disabled={busy || blockers > 0 || stats.included === 0}
          >
            {busy ? 'working…' : `Commit ${stats.included} rows`}
          </button>
        </div>
      )}

      {visible.length === 0 ? (
        <Empty>{onlyProblems ? 'Every included row has a vendor and a price.' : 'No staged rows.'}</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>S/N</th>
                <th className="wrap">Description</th>
                <th>Unit</th>
                <th className="num">Price</th>
                <th>Vendor</th>
                <th>Brand</th>
                <th>Match</th>
                {isAdmin && !committed && <th />}
              </tr>
            </thead>
            <tbody>
              {grouped.map(([category, items]) => (
                <Fragment key={category}>
                  <tr className="category-row">
                    <td colSpan={isAdmin && !committed ? 8 : 7}>
                      {category} — {items.length}
                    </td>
                  </tr>
                  {items.map((row) => (
                    <tr key={row.id} style={row.is_excluded ? { opacity: 0.45 } : undefined}>
                      <td className="muted">{row.source_row ?? '—'}</td>
                      <td className="wrap">{row.description}</td>
                      <td>{row.unit || '—'}</td>
                      <td className="num">
                        {isAdmin && !committed ? (
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            defaultValue={row.unit_price ?? ''}
                            style={{ width: 100, textAlign: 'right' }}
                            onBlur={(e) => {
                              const next = e.target.value === '' ? null : Number(e.target.value);
                              if (next !== (row.unit_price == null ? null : Number(row.unit_price))) {
                                updateRow(row, { unitPrice: next });
                              }
                            }}
                          />
                        ) : (
                          money(row.unit_price)
                        )}
                      </td>
                      <td>
                        {isAdmin && !committed ? (
                          <select
                            value={row.vendor_id ?? ''}
                            style={{ width: 150 }}
                            onChange={(e) =>
                              updateRow(row, { vendorId: e.target.value ? Number(e.target.value) : null })
                            }
                          >
                            <option value="">— none —</option>
                            {vendors.map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          row.vendor_name || <span className="muted">none</span>
                        )}
                      </td>
                      <td>{row.brand_name || <span className="muted">generic</span>}</td>
                      <td>
                        {row.commodity_id ? (
                          <span className="badge default">existing</span>
                        ) : (
                          <span className="badge manual">new</span>
                        )}
                      </td>
                      {isAdmin && !committed && (
                        <td>
                          <button
                            className={`btn small ${row.is_excluded ? '' : 'danger'}`}
                            onClick={() => updateRow(row, { isExcluded: !row.is_excluded })}
                            disabled={busy}
                          >
                            {row.is_excluded ? 'include' : 'exclude'}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
