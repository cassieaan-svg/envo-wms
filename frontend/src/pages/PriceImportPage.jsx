import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty, Field, dateTime } from '../components/ui.jsx';
import ImportPreviewTable from '../components/ImportPreviewTable.jsx';

export default function PriceImportPage({ isAdmin }) {
  const [imports, setImports] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [active, setActive] = useState(null); // { import, rows }
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  async function loadImports() {
    try {
      const [list, vendorList] = await Promise.all([api.priceListImports.list(), api.vendors.list()]);
      setImports(list);
      setVendors(vendorList);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadImports();
  }, []);

  async function upload(event) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.priceListImports.upload(file);
      setActive(result);
      setNotice(`parsed ${result.rows.length} rows — review, assign a vendor, then commit`);
      setFile(null);
      event.target.reset();
      await loadImports();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function openImport(id) {
    setError(null);
    try {
      setActive(await api.priceListImports.get(id));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Price list import</h1>
          <p>
            Upload a price list, review the staged rows, then commit. Nothing reaches the price
            catalogue until you commit.
          </p>
        </div>
      </div>

      <Banner kind="error" onDismiss={() => setError(null)}>
        {error}
      </Banner>
      <Banner kind="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Banner>

      {isAdmin && (
        <form className="card" onSubmit={upload}>
          <h2>Upload a price list</h2>
          <div className="form-grid">
            <Field label="File (.docx or .csv)">
              <input
                type="file"
                accept=".docx,.csv"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                required
              />
            </Field>
            <button className="btn primary" type="submit" disabled={busy || !file}>
              {busy ? 'parsing…' : 'Upload and stage'}
            </button>
          </div>
          <p className="muted" style={{ margin: '10px 0 0' }}>
            Expects the Central Medical Stores layout: S/N, description, unit, unit price, remark,
            with a lettered row starting each category.
          </p>
        </form>
      )}

      {active && (
        <ImportPreviewTable
          importRow={active.import}
          rows={active.rows}
          vendors={vendors}
          isAdmin={isAdmin}
          onRefresh={async () => setActive(await api.priceListImports.get(active.import.id))}
          onCommitted={async (result) => {
            setNotice(
              `committed ${result.rowsCommitted} rows — ${result.commoditiesCreated} new commodities, ${result.pricesInserted} prices set`
            );
            setActive(await api.priceListImports.get(active.import.id));
            await loadImports();
          }}
          onError={setError}
          onClose={() => setActive(null)}
        />
      )}

      <div className="card">
        <h2>Past imports</h2>
        {imports.length === 0 ? (
          <Empty>No imports yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="wrap">File</th>
                  <th>Uploaded</th>
                  <th>By</th>
                  <th className="num">Rows</th>
                  <th className="num">Included</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {imports.map((row) => (
                  <tr key={row.id}>
                    <td className="wrap">{row.filename}</td>
                    <td>{dateTime(row.imported_at)}</td>
                    <td className="muted">{row.imported_by || '—'}</td>
                    <td className="num">{row.row_count}</td>
                    <td className="num">{row.included_rows}</td>
                    <td>
                      {row.committed_at ? (
                        <span className="badge ok">committed</span>
                      ) : (
                        <span className="badge soon">pending review</span>
                      )}
                    </td>
                    <td>
                      <button className="btn small" onClick={() => openImport(row.id)}>
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
    </>
  );
}
