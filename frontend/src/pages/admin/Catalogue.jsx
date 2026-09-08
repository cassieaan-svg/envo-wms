import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/appStore'
import { Card, CardBody, CardHeader, CardTitle } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { LoadingState } from '../../components/ui/Loading'
import { toast } from '../../components/ui/Toast'

const field = 'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-green-500'

// Shared catalogue manager.  Root items live in `commodities`; module-specific
// category/SKU/configuration live in `commodity_modules`.
export function Catalogue() {
  const canManage = useAppStore(s => s.isOverallAdmin())
  const [items, setItems] = useState([])
  const [modules, setModules] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [moduleFilter, setModuleFilter] = useState('')
  const [query, setQuery] = useState('')
  const [showAdd, setShowAdd] = useState(false)

  async function load() {
    const [list, mods, cats] = await Promise.all([
      api.commodities.list({ module: moduleFilter || undefined, q: query || undefined }),
      api.commodities.modules(),
      api.commodities.categories(),
    ])
    setItems(list || []); setModules(mods || []); setCategories(cats || [])
  }
  useEffect(() => { (async () => { try { await load() } finally { setLoading(false) } })() }, [moduleFilter])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? items.filter(i => `${i.name} ${i.item_code || ''}`.toLowerCase().includes(q)) : items
  }, [items, query])

  if (loading) return <LoadingState />
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-xl font-medium text-gray-100">Item Catalogue</h1>
        <p className="text-sm text-gray-500 mt-1">Shared catalogue for HIV, Essential, and future modules.</p></div>
      {canManage && <Button variant="success" onClick={() => setShowAdd(true)}>+ Add item</Button>}
    </div>

    <Card><CardBody>
      <div className="flex flex-col sm:flex-row gap-3">
        <input className={field} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search item name or code…" />
        <select className={`${field} sm:w-56`} value={moduleFilter} onChange={e => setModuleFilter(e.target.value)}>
          <option value="">All modules</option>{modules.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
      </div>
    </CardBody></Card>

    <Card><CardHeader><CardTitle>{shown.length} items</CardTitle></CardHeader><CardBody>
      <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="text-left text-xs text-gray-500 uppercase"><tr><th className="pb-2">Item</th><th className="pb-2">Code</th><th className="pb-2">Category</th><th className="pb-2">Type</th><th className="pb-2">Status</th></tr></thead>
        <tbody>{shown.map(i => <tr key={i.id} className="border-t border-white/5"><td className="py-2.5 text-gray-100">{i.name}</td><td className="py-2.5 text-gray-400">{i.item_code || '—'}</td><td className="py-2.5 text-gray-400">{i.category || '—'}</td><td className="py-2.5 text-gray-400">{i.item_type}</td><td className="py-2.5">{i.is_active ? <span className="text-green-400">Active</span> : <span className="text-gray-500">Inactive</span>}</td></tr>)}</tbody>
      </table></div>
    </CardBody></Card>
    {showAdd && <AddItemModal modules={modules} categories={categories} onClose={() => setShowAdd(false)} onSaved={async () => { setShowAdd(false); await load() }} />}
  </div>
}

function AddItemModal({ modules, categories, onClose, onSaved }) {
  const [name, setName] = useState(''); const [code, setCode] = useState('')
  const [type, setType] = useState('commodity'); const [description, setDescription] = useState('')
  const [selected, setSelected] = useState([]); const [categoryByModule, setCategoryByModule] = useState({})
  const [newCategory, setNewCategory] = useState({ module: '', name: '' })
  const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const categoriesFor = module => categories.filter(c => c.module === module && c.is_active)
  const toggle = module => setSelected(s => s.includes(module) ? s.filter(x => x !== module) : [...s, module])

  async function createCategory() {
    if (!newCategory.module || !newCategory.name.trim()) return
    setBusy(true); setError('')
    try {
      const c = await api.commodities.createCategory({ module: newCategory.module, name: newCategory.name.trim() })
      setCategoryByModule(v => ({ ...v, [newCategory.module]: c.id }))
      toast('Category created', 'green'); setNewCategory({ module: '', name: '' })
      categories.push(c)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  async function save() {
    if (!name.trim() || selected.length === 0) { setError('Item name and at least one module are required.'); return }
    setBusy(true); setError('')
    try {
      await api.commodities.create({ name: name.trim(), item_type: type, item_code: code.trim() || undefined, description: description.trim() || undefined,
        memberships: selected.map(module => ({ module, category_id: categoryByModule[module] || undefined })) })
      toast('Item added to catalogue', 'green'); onSaved()
    } catch (err) { setError(err.message || 'Could not add item.') } finally { setBusy(false) }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => !busy && onClose()}><div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-xl bg-gray-900 p-5 shadow-xl" onClick={e => e.stopPropagation()}>
    <h2 className="text-base font-semibold text-gray-100">Add catalogue item</h2>
    <p className="text-sm text-gray-500 mt-1">Select every module where this item should be available.</p>
    {error && <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
    <div className="grid sm:grid-cols-2 gap-3 mt-4"><label><span className="text-sm text-gray-300">Name *</span><input autoFocus className={`${field} mt-1`} value={name} onChange={e => setName(e.target.value)} /></label><label><span className="text-sm text-gray-300">Item code</span><input className={`${field} mt-1`} value={code} onChange={e => setCode(e.target.value)} /></label></div>
    <label className="block mt-3"><span className="text-sm text-gray-300">Item type</span><input className={`${field} mt-1`} value={type} onChange={e => setType(e.target.value)} placeholder="commodity" /></label>
    <label className="block mt-3"><span className="text-sm text-gray-300">Description</span><textarea className={`${field} mt-1`} value={description} onChange={e => setDescription(e.target.value)} rows="2" /></label>
    <div className="mt-4 space-y-2"><span className="text-sm text-gray-300">Module memberships *</span>{modules.map(m => <div key={m.key} className="rounded-lg border border-white/10 p-3"><label className="flex gap-2 items-center text-sm text-gray-100"><input type="checkbox" checked={selected.includes(m.key)} onChange={() => toggle(m.key)} />{m.label}</label>{selected.includes(m.key) && <select className={`${field} mt-2`} value={categoryByModule[m.key] || ''} onChange={e => setCategoryByModule(v => ({ ...v, [m.key]: e.target.value }))}><option value="">No category yet</option>{categoriesFor(m.key).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</div>)}</div>
    <div className="mt-4 border-t border-white/10 pt-3"><div className="text-sm text-gray-300 mb-2">Create a category</div><div className="flex gap-2"><select className={field} value={newCategory.module} onChange={e => setNewCategory(v => ({ ...v, module: e.target.value }))}><option value="">Module…</option>{modules.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}</select><input className={field} placeholder="Category name" value={newCategory.name} onChange={e => setNewCategory(v => ({ ...v, name: e.target.value }))}/><Button type="button" variant="ghost" disabled={busy} onClick={createCategory}>Add</Button></div></div>
    <div className="mt-5 flex justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button type="button" variant="success" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Add item'}</Button></div>
  </div></div>
}
