// Paging for tables that already hold all their rows client-side.
//
// Deliberately hook-free. These tables render inside conditionals and IIFEs
// (`{tab==='intake' && (...)}`, `{drill ? (() => {...})() : ...}`), so a hook here
// would be a conditional hook and break the rules of hooks. The page number lives
// as ordinary state at the top of the page component and is passed in.
//
// pageSlice() does the arithmetic; <Pagination/> renders the control. Splitting
// them lets the table render the slice and the footer report the range without
// either recomputing the other.

export const PAGE_SIZE = 15

/**
 * Slice `rows` for `page` (0-based) and describe the position.
 * Clamps the page, so shrinking the data (a filter, a shorter period) can never
 * strand the view on an empty page that no longer exists.
 */
export function pageSlice(rows, page = 0, size = PAGE_SIZE) {
  const all = rows || []
  const total = all.length
  const pages = Math.max(1, Math.ceil(total / size))
  const safe = Math.min(Math.max(0, page), pages - 1)
  const start = safe * size
  return {
    slice: all.slice(start, start + size),
    page: safe,
    pages,
    total,
    // 1-based inclusive range for display; 0–0 when there is nothing.
    from: total ? start + 1 : 0,
    to: Math.min(total, start + size),
    // The table's own row numbering has to continue across pages, or row 1 of
    // page 2 reads as the top-ranked item.
    offset: start,
  }
}

export function Pagination({ pager, onPage, unit = 'rows' }) {
  const { page, pages, total, from, to } = pager
  // A single page needs no control, but the count is still worth stating — the
  // whole point of this is that "15" never again hides "of 63".
  const btn = "text-xs px-2.5 py-1 rounded border border-white/10 text-gray-300 hover:text-white hover:border-white/25 disabled:opacity-40 disabled:hover:text-gray-300 disabled:hover:border-white/10"
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-white/8 flex-wrap">
      <span className="text-xs text-gray-500">
        {total === 0 ? `No ${unit}` : <>Showing <span className="text-gray-300">{from.toLocaleString()}–{to.toLocaleString()}</span> of {total.toLocaleString()} {unit}</>}
      </span>
      {pages > 1 && (
        <div className="flex items-center gap-2">
          <button type="button" className={btn} disabled={page === 0} onClick={() => onPage(page - 1)}>‹ Prev</button>
          <span className="text-xs text-gray-500 tabular-nums">Page {page + 1} of {pages}</span>
          <button type="button" className={btn} disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>Next ›</button>
        </div>
      )}
    </div>
  )
}
