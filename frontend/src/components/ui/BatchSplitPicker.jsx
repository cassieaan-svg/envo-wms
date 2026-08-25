import { BatchSelect } from './BatchSelect'

// Batch selection for an issue that may be split across several lots.
//
// Starts as a SINGLE picker, because most issues come from one lot and a list of
// one row with a quantity box is needless ceremony. "+ Add batch" switches to the
// split view, which is the same shape the external dispatch uses.
//
// The allocation line is the point of the component: the totals rule (picked
// quantities must equal the issued quantity) is enforced on submit and again on the
// server, but discovering it through a red toast after filling the form in is a poor
// way to learn it. Here the remainder is visible while you type.
//
// Props:
//   facilityId / commodityId / locationType — which bin's lots to offer
//   issuedQty   — the quantity being issued, for the allocation check
//   single      — the single-pick value ({ key, batch_number, ... } | null)
//   onSingle    — setter for the single pick
//   split       — [{ id, selected, qty }] rows; empty = single-pick mode
//   onSplit     — setter for the rows
//   onLotsLoaded— passthrough so callers can keep their expiry warning working
export function BatchSplitPicker({
  facilityId, commodityId, locationType = 'store', issuedQty,
  single, onSingle, split, onSplit, onLotsLoaded, selectKey,
}) {
  const rows = split || []
  const issued = parseInt(issuedQty) || 0
  const allocated = rows.reduce((s, r) => s + (parseInt(r.qty) || 0), 0)
  const remaining = issued - allocated

  const setRow = (i, patch) => {
    const copy = [...rows]
    copy[i] = { ...copy[i], ...patch }
    onSplit(copy)
  }
  const addRow = () => onSplit([
    ...rows,
    // First "+ Add batch" carries the single pick over and pre-fills the full issued
    // quantity, so the common "one lot after all" case needs no retyping. Later rows
    // pre-fill whatever is still unallocated.
    rows.length
      ? { id: Date.now(), selected: null, qty: Math.max(0, remaining) }
      : { id: Date.now(), selected: single || null, qty: issued || 0 },
  ])

  const tone = !rows.length ? null
    : remaining === 0 ? { cls: 'text-green-400', text: `All ${issued.toLocaleString()} allocated` }
    : remaining > 0   ? { cls: 'text-amber-400', text: `${allocated.toLocaleString()} of ${issued.toLocaleString()} — ${remaining.toLocaleString()} still to allocate` }
                      : { cls: 'text-red-400',   text: `${allocated.toLocaleString()} allocated — ${Math.abs(remaining).toLocaleString()} over the ${issued.toLocaleString()} being issued` }

  return (
    <div>
      <label className="block text-xs text-gray-500 uppercase tracking-widest mb-1.5">
        {rows.length ? 'Batches issued' : 'Batch issued'}
      </label>

      {!rows.length ? (
        <BatchSelect key={selectKey} facilityId={facilityId} commodityId={commodityId}
          locationType={locationType} value={single?.key} onSelect={onSingle} onLotsLoaded={onLotsLoaded} />
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={r.id} className="flex gap-2 items-center">
              <div className="flex-1 min-w-0">
                <BatchSelect facilityId={facilityId} commodityId={commodityId} locationType={locationType}
                  value={r.selected?.key || null}
                  onSelect={opt => setRow(i, { selected: opt })}
                  onLotsLoaded={onLotsLoaded} />
              </div>
              <input type="number" min="0" value={r.qty} aria-label="Quantity from this batch"
                onChange={e => setRow(i, { qty: e.target.value })}
                className="w-20 shrink-0 bg-white/5 border border-white/10 rounded-lg px-2 py-2 text-sm text-gray-100 text-right focus:outline-none focus:border-blue-500" />
              <button type="button" onClick={() => onSplit(rows.filter((_, idx) => idx !== i))}
                title="Remove this batch" aria-label="Remove this batch"
                className="shrink-0 w-7 h-7 rounded text-gray-500 hover:text-red-400 hover:bg-white/5 leading-none">✕</button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 mt-1.5 flex-wrap">
        <button type="button" onClick={addRow} className="text-xs text-blue-400 hover:text-blue-300">+ Add batch</button>
        {tone
          ? <span className={`text-xs ${tone.cls}`}>{tone.text}</span>
          : <span className="text-xs text-gray-500">Leave empty to draw the soonest-expiring stock automatically</span>}
      </div>
    </div>
  )
}
