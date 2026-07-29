import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Banner, Empty, Field } from '../components/ui.jsx';

const BLANK = { name: '', contactName: '', contactPhone: '', contactEmail: '' };

export default function VendorsPage({ isAdmin }) {
  const [vendors, setVendors] = useState([]);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      setVendors(await api.vendors.list({ includeInactive }));
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [includeInactive]);

  function startEdit(vendor) {
    setEditingId(vendor.id);
    setForm({
      name: vendor.name || '',
      contactName: vendor.contact_name || '',
      contactPhone: vendor.contact_phone || '',
      contactEmail: vendor.contact_email || '',
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
        await api.vendors.update(editingId, form);
        setNotice(`updated ${form.name}`);
      } else {
        await api.vendors.create(form);
        setNotice(`added ${form.name}`);
      }
      cancelEdit();
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function deactivate(vendor) {
    if (!window.confirm(`Deactivate ${vendor.name}? Its price history and batches stay intact.`)) return;
    setError(null);
    try {
      await api.vendors.deactivate(vendor.id);
      setNotice(`deactivated ${vendor.name}`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function reactivate(vendor) {
    setError(null);
    try {
      await api.vendors.update(vendor.id, { isActive: true });
      setNotice(`reactivated ${vendor.name}`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Vendors</h1>
          <p>Suppliers that commodities are priced and received against.</p>
        </div>
        <label className="muted" style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            style={{ width: 'auto' }}
          />
          show inactive
        </label>
      </div>

      <Banner kind="error" onDismiss={() => setError(null)}>
        {error}
      </Banner>
      <Banner kind="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Banner>

      {isAdmin && (
        <form className="card" onSubmit={submit}>
          <h2>{editingId ? 'Edit vendor' : 'Add vendor'}</h2>
          <div className="form-grid">
            <Field label="Name *">
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </Field>
            <Field label="Contact name">
              <input
                value={form.contactName}
                onChange={(e) => setForm({ ...form, contactName: e.target.value })}
              />
            </Field>
            <Field label="Phone">
              <input
                value={form.contactPhone}
                onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
              />
            </Field>
            <Field label="Email">
              <input
                type="email"
                value={form.contactEmail}
                onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
              />
            </Field>
            <div className="row-actions">
              <button className="btn primary" type="submit">
                {editingId ? 'Save changes' : 'Add vendor'}
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
        <h2>{vendors.length} vendor{vendors.length === 1 ? '' : 's'}</h2>
        {loading ? (
          <Empty>loading…</Empty>
        ) : vendors.length === 0 ? (
          <Empty>No vendors yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="wrap">Name</th>
                  <th>Contact</th>
                  <th>Phone</th>
                  <th>Email</th>
                  <th>Status</th>
                  {isAdmin && <th />}
                </tr>
              </thead>
              <tbody>
                {vendors.map((vendor) => (
                  <tr key={vendor.id}>
                    <td className="wrap">{vendor.name}</td>
                    <td>{vendor.contact_name || '—'}</td>
                    <td>{vendor.contact_phone || '—'}</td>
                    <td>{vendor.contact_email || '—'}</td>
                    <td>
                      {vendor.is_active ? (
                        <span className="badge ok">active</span>
                      ) : (
                        <span className="badge inactive">inactive</span>
                      )}
                    </td>
                    {isAdmin && (
                      <td>
                        <div className="row-actions">
                          <button className="btn small" onClick={() => startEdit(vendor)}>
                            edit
                          </button>
                          {vendor.is_active ? (
                            <button className="btn small danger" onClick={() => deactivate(vendor)}>
                              deactivate
                            </button>
                          ) : (
                            <button className="btn small" onClick={() => reactivate(vendor)}>
                              reactivate
                            </button>
                          )}
                        </div>
                      </td>
                    )}
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
