import { toast } from '../components/ui/Toast'

// Download rows as a CSV file. Prepends a UTF-8 BOM so Excel renders special
// characters (—, →, accents) correctly instead of mojibake.
export function exportCsv(filename, headers, rows) {
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const csv = [headers, ...rows].map(r => r.map(esc).join(',')).join('\r\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }))
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
  toast('CSV exported', 'green')
}

// Build a printable HTML table and open the browser print dialog — from there
// the user can Print or "Save as PDF". Matches the app's existing print-to-PDF
// pattern (CRRF / Transfers / AllFacilities). `rightCols` is a Set of column
// indexes to right-align (numbers).
export function exportPdf(title, subtitle, headers, rows, rightCols = new Set()) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  const thead = `<tr>${headers.map((h, i) => `<th class="${rightCols.has(i) ? 'r' : ''}">${esc(h)}</th>`).join('')}</tr>`
  const tbody = rows.map(r => `<tr>${r.map((c, i) => `<td class="${rightCols.has(i) ? 'r' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')
  const styles = `
    *{font-family:Arial,Helvetica,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    h1{font-size:16px;margin:0 0 4px;} .sub{font-size:12px;color:#444;margin:0 0 2px;}
    .meta{font-size:10px;color:#888;margin:0 0 12px;}
    table{width:100%;border-collapse:collapse;font-size:11px;}
    th,td{border:1px solid #ccc;padding:5px 7px;text-align:left;}
    th{background:#f0f0f0;} td.r,th.r{text-align:right;} tr:nth-child(even) td{background:#fafafa;}
    @page{size:landscape;margin:12mm;}`
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${styles}</style></head>`
    + `<body><h1>${esc(title)}</h1>${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}`
    + `<p class="meta">Generated ${esc(new Date().toLocaleString('en-GB'))}</p>`
    + `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table></body></html>`
  const url = URL.createObjectURL(new Blob([doc], { type: 'text/html' }))
  const win = window.open(url, '_blank')
  if (win) {
    win.onload = () => { win.focus(); win.print(); URL.revokeObjectURL(url); win.onafterprint = () => win.close() }
  } else {
    URL.revokeObjectURL(url)
    toast('Allow pop-ups to print / export PDF', 'red')
  }
}
