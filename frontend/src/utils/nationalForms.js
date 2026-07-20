// National LMIS print forms — exact-match reproductions of the government tools
// (Bin Card, Internal RIRV, Transfer & Return, CRRF variants) with the Nigerian
// coat of arms. Opened via the app's Print / Save as PDF buttons. This module is
// dynamically imported so the ~420KB coat-of-arms SVG stays out of the main bundle.
import ncoa from '../assets/ncoa.svg?raw'
import { fmtDate } from './helpers'

const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const dstr = d => (d ? fmtDate(d) : '')
// Movement cells: show the number, blank when zero/empty (paper-form convention).
const q = n => (n === 0 || n == null || n === '') ? '' : Number(n).toLocaleString()
const signed = n => n > 0 ? `+${Number(n).toLocaleString()}` : n < 0 ? Number(n).toLocaleString() : ''
const line = (v = '', w = 90) => `<span class="fill" style="min-width:${w}px">${esc(v)}</span>`

// Shared print stylesheet — ported verbatim from the approved preview.
const CSS = `
  *{ box-sizing:border-box; font-family:Arial,Helvetica,sans-serif; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  body{ margin:0; color:#111; }
  .paper{ padding:10mm 10mm 12mm; }
  .hdr{ display:flex; align-items:center; gap:18px; border-bottom:2px solid #000; padding-bottom:8px; }
  .arms{ width:78px; height:66px; flex:none; display:flex; align-items:center; justify-content:center; }
  .arms svg{ height:64px; width:auto; }
  .ttl{ flex:1; text-align:center; }
  .ftitle{ font-size:16px; font-weight:800; letter-spacing:1px; }
  .fsub-band{ border:1px solid #000; border-top:none; text-align:center; font-weight:700; font-size:12px; padding:3px 4px; }
  .fsub-band u{ font-weight:700; }
  .fields{ margin:12px 0 8px; font-size:11.5px; line-height:2.0; }
  .frow{ display:flex; gap:24px; } .f{ flex:1; }
  .hint{ color:#666; font-size:9.5px; }
  .fill{ display:inline-block; border-bottom:1px solid #000; padding:0 4px; min-height:15px; }
  table{ width:100%; border-collapse:collapse; font-size:10.5px; margin-top:4px; }
  th,td{ border:1px solid #000; padding:4px 6px; text-align:center; }
  th{ background:#e9e9e9; font-size:9.5px; line-height:1.15; font-weight:700; }
  td.l{ text-align:left; } td.n{ text-align:right; font-variant-numeric:tabular-nums; } td.b{ font-weight:700; }
  tbody tr{ height:25px; }
  tr.close td{ background:#e9eef5; font-weight:700; }
  .red{ color:#c0121a; font-weight:700; }
  .foot{ font-size:9px; color:#555; margin-top:8px; text-align:right; }
  .sigs{ display:grid; grid-template-columns:1fr 1fr; gap:6px 24px; margin-top:14px; font-size:10.5px; }
  .sigs.two{ grid-template-columns:1fr 1fr 1fr; }
  .sg{ padding:3px 0; } .lbl{ color:#333; }
  .cert{ margin-top:12px; font-size:10.5px; border-top:1px solid #999; padding-top:8px; line-height:1.9; }
  .cert .cm{ margin-top:4px; }
  .note{ margin-top:12px; font-size:11px; font-weight:700; text-align:center; letter-spacing:1px; }
  .fields.three .frow{ gap:20px; }
  tr.grp td{ background:#f2f2f2; font-weight:700; text-align:left; }
  .crrf th.rep{ background:#dfe7df; } .crrf th.req{ background:#e7dfdf; }
  .crrf tr.keys th{ background:#f5f5f5; font-style:italic; font-weight:400; color:#555; }
  .crrf.sm{ font-size:9px; } .crrf.sm th{ font-size:8px; } .crrf.sm td,.crrf.sm th{ padding:3px 4px; }
  .sub-h{ margin-top:14px; font-size:11.5px; font-weight:700; border-bottom:1px solid #999; padding-bottom:2px; }
  .mini{ font-size:10px; margin-top:4px; } .mini th{ font-size:9px; }
  .ver{ margin-top:8px; font-size:9px; color:#666; text-align:right; }
  .lab-two{ display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:14px; align-items:start; }
  .remark-box{ border:1px solid #000; min-height:96px; margin-top:4px; }
  tr.sec td{ background:#eee; font-weight:700; text-align:left; }
  @page{ size:landscape; margin:8mm; }
`

function armsHeader(title, sub = '') {
  const band = sub ? `<div class="fsub-band">${sub}</div>` : ''
  return `<div class="hdr"><div class="ttl"><div class="ftitle">${esc(title)}</div></div>`
    + `<div class="arms">${ncoa}</div></div>${band}`
}

// Open the form in a new tab that prints itself. Two things keep the APP tab
// responsive: the print() call lives in a script INSIDE the new tab, and the tab
// is opened with rel="noopener" so it gets its OWN renderer process. A synchronous
// window.print() spins a nested event loop that would otherwise freeze every tab
// in the same process — including the app — until the dialog is dismissed.
function openPrint(title, inner) {
  const auto = '<' + 'script>window.addEventListener("load",function(){window.print()});<' + '/script>'
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>`
    + `<style>${CSS}</style></head><body><div class="paper">${inner}</div>${auto}</body></html>`
  const url = URL.createObjectURL(new Blob([doc], { type: 'text/html' }))
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

// ── BIN CARD ──────────────────────────────────────────────────────────────
// Which of MAIN STORE / SUB STORE / DISPENSARY this bin is, for the subtitle.
function binKindLabel(location) {
  if (location === 'store') return 'MAIN STORE'
  if (location === 'dispensary') return 'DISPENSARY'
  return 'SUB STORE'   // DSD / SDP sites
}
const isGhsc = p => /ghsc/i.test(p || '')

export function printBinCard(card, locationLabel) {
  const comm = card?.commodity || {}
  const active = binKindLabel(card?.location)
  const sub = ['MAIN STORE', 'SUB STORE', 'DISPENSARY']
    .map(k => k === active ? `<u>${k}</u>` : k).join(' / ')

  // Opening balance, then movement rows with a monthly close-out band each month.
  const rows = card?.rows || []
  const bodyRows = []
  bodyRows.push(`<tr><td></td><td></td><td class="l">Balance b/f</td><td></td><td></td>`
    + `<td></td><td></td><td></td><td class="n b">${q(card?.openingBalance) || 0}</td><td></td><td></td></tr>`)

  const monthKey = d => { const x = new Date(d); return isNaN(x) ? '' : `${x.getFullYear()}-${x.getMonth()}` }
  const monthName = d => new Date(d).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'Africa/Lagos' }).toUpperCase()
  let curKey = null, mRecv = 0, mIss = 0, mAdj = 0, mBal = null, mDate = null
  const flush = () => {
    if (curKey == null) return
    bodyRows.push(`<tr class="close"><td colspan="2">${esc(monthName(mDate))} CLOSE-OUT</td>`
      + `<td>Monthly summary</td><td></td><td></td>`
      + `<td class="n">${q(mRecv)}</td><td class="n">${q(mIss)}</td><td class="n">${signed(mAdj)}</td>`
      + `<td class="n b">${q(mBal)}</td><td></td><td></td></tr>`)
  }
  for (const r of rows) {
    const k = monthKey(r.date)
    if (k !== curKey) { flush(); curKey = k; mRecv = 0; mIss = 0; mAdj = 0; mDate = r.date }
    mRecv += r.received || 0; mIss += r.issued || 0; mAdj += r.adjustment || 0; mBal = r.balance; mDate = r.date
    const party = String(r.party || '').replace(/^→\s*/, '')   // no arrows on the form
    // A GHSC-PSM receipt is highlighted in red across the whole row.
    const rowTag = isGhsc(party) ? '<tr class="red">' : '<tr>'
    bodyRows.push(rowTag + `<td>${dstr(r.date)}</td><td>${esc(r.ref)}</td><td class="l">${esc(party)}</td>`
      + `<td>${esc(r.batch)}</td><td>${dstr(r.expiry)}</td>`
      + `<td class="n">${q(r.received)}</td><td class="n">${q(r.issued)}</td><td class="n">${signed(r.adjustment)}</td>`
      // Signature is left blank on purpose — it is signed by hand on the printed
      // card, never pre-filled with the recorded staff name.
      + `<td class="n b">${q(r.balance)}</td><td></td><td class="l">${esc(r.remarks)}</td></tr>`)
  }
  flush()

  const inner = armsHeader('BIN CARD', `( ${sub} )`) + `
    <div class="fields">
      <div class="frow"><div class="f">Name of Facility: ${line(card?.facility?.name, 340)}</div></div>
      <div class="frow"><div class="f">Item Description: ${line(comm.name, 240)} <span class="hint">(Name, Strength, Dosage Form)</span></div>
        <div class="f">Product Code: ${line()}</div><div class="f">Card No: ${line()}</div></div>
      <div class="frow"><div class="f">Unit of Measure: ${line(comm.unit)}</div><div class="f">Location / Shelf No: ${line()}</div></div>
    </div>
    <table><thead>
      <tr><th rowspan="2">Date</th><th rowspan="2">Voucher / Ref. No</th><th rowspan="2" style="width:16%">Received From / Issued to</th>
        <th rowspan="2">Batch No.</th><th rowspan="2">Expiry Date</th><th colspan="3">Quantity</th>
        <th rowspan="2">Balance</th><th rowspan="2">Signature</th><th rowspan="2">Remarks</th></tr>
      <tr><th>Received</th><th>Issued</th><th>Losses &amp; Adj.</th></tr></thead>
      <tbody>${bodyRows.join('')}</tbody></table>`
  openPrint(`Bin Card — ${comm.name || ''}`, inner)
}

// ── INTERNAL RIRV ─────────────────────────────────────────────────────────
const rx = (notes, tag) => new RegExp(`\\[${tag}:\\s*([^\\]]+)\\]`, 'i').exec(notes || '')?.[1]?.trim()
// Destination label from a redistribution's notes: DSD/SDP site, else Dispensary.
function moveDest(notes) {
  const dsd = rx(notes, 'DSD'); if (dsd) return `DSD — ${dsd}`
  const sdp = rx(notes, 'SDP'); if (sdp) return `SDP — ${sdp}`
  return 'Dispensary'
}
const sigRow = (role, val = '', date = '') => `<div class="sg"><span class="lbl">${role}</span> ${line(val, 150)} `
  + `<span class="lbl">Signature</span> ${line('', 90)} <span class="lbl">Date</span> ${line(date, 80)}</div>`

// moveRows: the stock_transfer_log rows of ONE redistribution move (same
// destination). ctx: { facilityName, packSize(commodityId)->str, batches(id)->{batch,expiry} }.
export function printRIRV(moveRows, ctx = {}) {
  const rows = moveRows || []
  const first = rows[0] || {}
  const to = moveDest(first.notes)
  const pack = ctx.packSize || (() => '')
  const batches = ctx.batches || {}
  const bal = n => { const m = /balance:(\-?\d+)/.exec(n || ''); return m ? m[1] : '' }
  // Pre-fill the requester / receiver and move date so staff just sign on print.
  const requestedBy = first.initiated_by || ''
  // resolved_by carries both parties as tags on a DSD/SDP move —
  // "[Approved: X] [Received by: Y]" — so split them into their own signature
  // slots instead of dumping the raw string into "Commodities Received by".
  // A store→dispensary move stores a plain name, and that name is the approver.
  const resolvedBy = first.resolved_by || ''
  const approvedBy = rx(resolvedBy, 'Approved') || (resolvedBy.includes('[') ? '' : resolvedBy)
  const receivedBy = rx(resolvedBy, 'Received by') || ''
  const moveDate = dstr(first.resolved_at || first.initiated_at)

  const lineRows = rows.map((r, i) => {
    const b = batches[r.id] || {}
    return '<tr>' + `<td>${i + 1}</td>` + `<td class="l">${esc(r.commodity_name)}</td>`
      + `<td>${esc(pack(r.commodity_id))}</td>` + `<td class="n">${q(bal(r.notes))}</td>`
      + `<td class="n">${q(r.qty_requested)}</td>` + `<td class="n">${q(r.quantity)}</td>`
      + `<td>${esc(b.batch || '')}</td>` + `<td>${dstr(b.expiry) || ''}</td>` + `<td class="l"></td></tr>`
  }).join('')
  // pad to a minimum of rows so the voucher keeps its shape
  const pad = Math.max(0, Math.min(15, 8 - rows.length))
  const blanks = Array.from({ length: pad }, (_, i) => `<tr><td>${rows.length + i + 1}</td>${'<td></td>'.repeat(8)}</tr>`).join('')

  const inner = armsHeader('INTERNAL REQUISITION, ISSUE & RECEIPT VOUCHER') + `
    <div class="fields">
      <div class="frow"><div class="f">Name of Facility: ${line(ctx.facilityName, 260)}</div><div class="f">Facility Code: ${line()}</div><div class="f">Date: ${line(moveDate, 130)}</div></div>
      <div class="frow"><div class="f">From: ${line('Main Store', 200)}</div><div class="f">To: ${line(to, 200)}</div></div>
    </div>
    <table><thead>
      <tr><th rowspan="2">Serial No</th><th rowspan="2" style="width:26%">Item Description and Strength</th><th rowspan="2">Pack Size</th>
        <th>Requisition</th><th colspan="4">To be filled by storekeeper</th></tr>
      <tr><th>Stock Balance</th><th>Qty Required</th><th>Qty Issued</th><th>Batch #</th><th>Expiry Date</th><th>Remarks</th></tr></thead>
      <tbody>${lineRows}${blanks}</tbody></table>
    <div class="sigs">${sigRow('Requisition Prepared by (Full Name):', requestedBy, moveDate)}${sigRow('Requisition Recommended by (Full Name):')}${sigRow('Requisition Approved by (Full Name):', approvedBy, approvedBy ? moveDate : '')}${sigRow('Commodities Issued by (Full Name):')}${sigRow('Commodities Received by (Full Name):', receivedBy, receivedBy ? moveDate : '')}</div>`
  openPrint(`Internal RIRV — ${to}`, inner)
}

// ── TRANSFER & RETURN ─────────────────────────────────────────────────────
// External redistribution/return to ONE receiving facility. moveRows: the
// transfer rows of one move (same source, same receiving facility, same day).
// Batch/expiry are the RECORDED values from the transfer notes.
export function printTransfer(moveRows, ctx = {}) {
  const rows = moveRows || []
  const first = rows[0] || {}
  const from = first.sending_facility_name || ctx.facilityName || ''
  const to = first.receiving_facility_name || ''
  const reason = n => String(n || '').replace(/\[[^\]]*\]/g, '').trim()   // strip [tags] → free note
  const lineRows = rows.map((r, i) => '<tr>' + `<td>${i + 1}</td>` + `<td class="l">${esc(r.commodity_name)}</td>`
    + `<td>${esc(rx(r.notes, 'Batch') || '')}</td>` + `<td>${esc(rx(r.notes, 'Expiry') || '')}</td>`
    + `<td class="n">${q(r.quantity)}</td>` + `<td class="l">${esc(reason(r.notes))}</td></tr>`).join('')
  const pad = Math.max(0, Math.min(10, 6 - rows.length))
  const blanks = Array.from({ length: pad }, (_, i) => `<tr><td>${rows.length + i + 1}</td>${'<td></td>'.repeat(5)}</tr>`).join('')
  const carrier = rx(first.notes, 'Carrier') || ''
  // Every transferring-side name on this form — compiled by, approved by,
  // transfer/return by and transfer approved by — is the one officer the
  // transferring facility recorded when arranging the transfer.
  // Deliberately NOT initiated_by: on a request-driven transfer that is the
  // requester at the RECEIVING facility, which printed the wrong party here.
  const approvedBy = rx(first.notes, 'Approved by') || ''
  // The receiving facility's own name, captured when it accepts the transfer.
  const receivedBy = first.resolved_by || ''
  const moveDate = dstr(first.resolved_at || first.initiated_at)

  const inner = armsHeader('RECORD FOR TRANSFERRING / RETURNING COMMODITIES') + `
    <div class="fields">
      <div class="frow"><div class="f">Name of facility returning/transferring commodities: ${line(from, 300)}</div></div>
      <div class="frow"><div class="f">Sent to: ${line(to, 320)}</div><div class="f">Date: ${line(moveDate, 130)}</div></div>
    </div>
    <table><thead><tr><th>S/No</th><th style="width:34%">Product Description</th><th>Batch No.</th><th>Expiry Date</th><th>Quantity</th><th style="width:26%">Reason for return / transfer</th></tr></thead>
      <tbody>${lineRows}${blanks}</tbody></table>
    <div class="sigs two">${sigRow('Record compiled by:', approvedBy, moveDate)}${sigRow('Record approved by:', approvedBy, moveDate)}${sigRow('Transfer / return by:', approvedBy, moveDate)}</div>
    <div class="cert"><b>Carrier:</b> I certify that the above quantities of transfer/return were received by me except where explained below.
      <div class="cm">Comments: ${line('', 520)}</div>
      <div class="sg">Name of Carrier: ${line(carrier, 160)} Designation: ${line('', 120)} Signature: ${line('', 120)} Date: ${line(moveDate, 80)}</div></div>
    <div class="cert"><b>Receiving Facility:</b> I certify that the above quantities were received by me except where explained below (please explain the condition of items on receipt).
      <div class="cm">Comments: ${line('', 520)}</div>
      <div class="sg">Receiver's name: ${line(receivedBy, 160)} Signature: ${line('', 120)} Date: ${line(moveDate, 80)}</div>
      <div class="sg">Transfer approved by: ${line(approvedBy, 160)} Signature: ${line('', 120)} Date: ${line(moveDate, 80)}</div></div>
    <div class="note">NOTE: TO BE COMPLETED IN TRIPLICATES</div>`
  openPrint(`Transfer & Return — ${to}`, inner)
}

// ── CRRF (Combined Report and Requisition Form) ───────────────────────────
// Driven by a template list (full, ordered, grouped) so every row prints even
// when the facility has none — zeros seeded. `rows` are the template rows the
// page already matched to data: { group } | { sno, name, unit, pack, A, received,
// dispensed, adjPos, adjNeg, losses, E, F, G }.
const z = n => Number(n || 0).toLocaleString()

function crrfFields(ctx = {}) {
  return `
  <div class="fields three">
    <div class="frow"><div class="f">Facility Name: ${line(ctx.facilityName, 200)}</div><div class="f">Reporting Period Start: ${line(ctx.periodStart, 100)}</div><div class="f">Maximum Stock Level: ${line(ctx.maxLevel || '4 Months', 70)}</div></div>
    <div class="frow"><div class="f">Facility Code: ${line()}</div><div class="f">Reporting Period End: ${line(ctx.periodEnd, 100)}</div><div class="f">Minimum Stock Level: ${line(ctx.minLevel || '2 Months', 70)}</div></div>
    <div class="frow"><div class="f">LGA: ${line(ctx.lga, 150)}</div><div class="f">Date Prepared: ${line()}</div></div>
    <div class="frow"><div class="f">State: ${line(ctx.state, 150)}</div></div>
  </div>`
}

// ── CRRF — Pharmacy ARV/OI ───────────────────────────────────────────────
export function printCrrfArv(rows, ctx = {}) {
  let n = 0
  const body = rows.map(r => r.group
    ? `<tr class="grp"><td></td><td class="l" colspan="11">${esc(r.group)}</td></tr>`
    : (n++, '<tr>' + `<td>${n}</td><td class="l">${esc(r.name)}</td><td>${esc(r.unit || '')}</td>`
      + `<td class="n">${z(r.A)}</td><td class="n">${z(r.received)}</td><td class="n">${z(r.dispensed)}</td>`
      + `<td class="n">${z(r.adjPos)}</td><td class="n">${z(r.adjNeg)}</td><td class="n b">${z(r.E)}</td>`
      + `<td class="n">${z(r.F)}</td><td class="n b">${z(r.G)}</td><td class="l"></td></tr>`)).join('')
  const inner = armsHeader('COMBINED REPORT AND REQUISITION FORM (CRRF) - Antiretroviral and OIs') + crrfFields(ctx) + `
    <table class="crrf"><thead>
      <tr><th rowspan="3">S/No</th><th rowspan="3" style="width:22%">Drugs</th><th rowspan="3">Basic Unit</th><th colspan="6" class="rep">REPORT</th><th colspan="2" class="req">REQUISITION</th><th rowspan="3">Remarks</th></tr>
      <tr><th rowspan="2">Beginning Balance</th><th rowspan="2">Qty Received</th><th rowspan="2">Qty Dispensed</th><th colspan="2">Losses &amp; Adjustments</th><th rowspan="2">Ending Balance (Physical Count)</th><th rowspan="2">Max Stock Qty</th><th rowspan="2">Qty to Order</th></tr>
      <tr><th>Positive +</th><th>Negative &#8722;</th></tr>
      <tr class="keys"><th></th><th></th><th></th><th>A</th><th>B</th><th>C</th><th>D (+)</th><th>D (&#8722;)</th><th>E</th><th>F = C&#215;2</th><th>G = F&#8722;E</th><th>H</th></tr></thead>
      <tbody>${body}</tbody></table>
    <div class="sub-h">Comments</div>
    <div class="remark-box"></div>
    <div class="sub-h">Expiry Details / Any other information</div>
    <div class="hint">1. Please provide details (expiry dates) &nbsp;·&nbsp; 2. Any other information</div>
    <table class="mini"><thead><tr><th style="width:6%">S/No</th><th style="width:48%">Description</th><th>Lot No</th><th>Exp date</th><th>Quantity</th></tr></thead>
      <tbody>${[1, 2, 3, 4].map(i => `<tr><td>${i}</td><td></td><td></td><td></td><td></td></tr>`).join('')}</tbody></table>
    ${labOfficers(['Report Prepared by (Full Name &amp; Signature):'], '2017')}`
  openPrint('CRRF — ARVs & OIs', inner)
}

// ── CRRF — Pharmacy Condoms & Lubricants ─────────────────────────────────
export function printCrrfCondom(rows, ctx = {}) {
  let n = 0
  const body = rows.map(r => r.group
    ? `<tr class="grp"><td></td><td class="l" colspan="14">${esc(r.group)}</td></tr>`
    : (n++, '<tr>' + `<td>${n}</td><td class="l">${esc(r.name)}</td><td>${esc(r.pack || '')}</td><td>${esc(r.unit || '')}</td>`
      + `<td class="n">${z(r.A)}</td><td class="n">${z(r.received)}</td><td class="n">${z(r.dispensed)}</td><td class="n">${z(r.distributed)}</td>`
      + `<td class="n">${z(r.adjPos)}</td><td class="n">${z(r.adjNeg)}</td><td class="n">${z(r.losses)}</td><td class="n b">${z(r.E)}</td>`
      + `<td class="n">${z(r.F)}</td><td class="n b">${z(r.G)}</td><td class="l"></td></tr>`)).join('')
  const bimonthly = `
    <div class="sub-h">Bimonthly Summary of Usage</div>
    <table class="mini"><thead><tr><th style="width:30%">Item</th><th>Distributed to Target Group</th><th>Quality Control</th><th>Condom Demonstration</th><th>Advocacy</th><th>TOTAL</th></tr></thead>
      <tbody>${rows.filter(r => !r.group).map(r => `<tr><td class="l">${esc(r.name)}</td><td></td><td></td><td></td><td></td><td></td></tr>`).join('')}</tbody></table>`
  const inner = armsHeader('COMBINED REPORT AND REQUISITION FORM (CRRF) - CONDOM & LUBRICANT', 'Condoms &amp; Lubricants') + crrfFields(ctx) + `
    <table class="crrf sm"><thead>
      <tr><th rowspan="3">Serial No.</th><th rowspan="3" style="width:20%">Item Description</th><th rowspan="3">Pack Size</th><th rowspan="3">Reporting Unit</th>
          <th colspan="8">&nbsp;</th><th colspan="2" class="req">REQUISITION / ISSUE</th><th rowspan="3">Remarks</th></tr>
      <tr><th rowspan="2">Beginning Balance</th><th rowspan="2">Qty Received</th><th rowspan="2">Qty Used</th><th rowspan="2">No. distributed</th><th colspan="2">Adjustments (+/&#8722;)</th><th rowspan="2">Losses</th><th rowspan="2">Physical Count</th><th rowspan="2">Max Stock (Qty)</th><th rowspan="2">Qty to Order</th></tr>
      <tr><th>+</th><th>&#8722;</th></tr>
      <tr class="keys"><th></th><th></th><th></th><th></th><th>A</th><th>B</th><th>C</th><th>D</th><th>E+</th><th>E&#8722;</th><th>F</th><th>G</th><th>H = C&#215;2</th><th>I = H&#8722;G</th><th>J</th></tr></thead>
      <tbody>${body}</tbody></table>
    ${bimonthly}
    ${labExpiryRemarks()}
    ${labOfficers(['Report Prepared by (Full Name &amp; Signature):', 'Requisition Approved by (Full Name &amp; Signature):'], '2017')}`
  openPrint('CRRF — Condoms & Lubricants', inner)
}

// ── CRRF — Lab (shared footer blocks) ─────────────────────────────────────
// Expiry Details + Additional Remarks, side by side (both blank — filled by hand).
const labExpiryRemarks = () => `
  <div class="lab-two">
    <div>
      <div class="sub-h">Expiry Details</div>
      <div class="hint">1. Please provide details (expiry dates) &nbsp;·&nbsp; 2. Any other information</div>
      <table class="mini"><thead><tr><th style="width:46%">Description</th><th>Lot No</th><th>Exp date</th><th>Quantity</th></tr></thead>
        <tbody>${'<tr><td></td><td></td><td></td><td></td></tr>'.repeat(3)}</tbody></table>
    </div>
    <div>
      <div class="sub-h">Additional Remarks</div>
      <div class="remark-box"></div>
    </div>
  </div>`
// Reporting Officers Details — `officers` is the list of role labels, each a blank
// name/phone/date line. Pharmacy forms are Version 2017; lab forms Version 2022.
const labOfficers = (officers, version = '2022') => `
  <div class="sub-h">Reporting Officers Details</div>
  ${officers.map(o => `<div class="sg"><span class="lbl">${o}</span> ${line('', 180)} <span class="lbl">Phone Number</span> ${line('', 120)} <span class="lbl">Date</span> ${line('', 80)}</div>`).join('')}
  <div class="ver">Version ${version}</div>`

// A lab reporting row: Qty Used (C) is the recorded consumption; No. of Tests Done
// (D) is left blank (not captured — filled by hand). Physical Count G = system SOH,
// Max Stock H = C×2, Qty to Order I = H−G. `pack` true adds the CD4 Pack Size col;
// `expiry` true adds the CD4 Expiry Date col.
const labRow = (r, n, { pack, expiry }) => '<tr>'
  + `<td>${n}</td><td class="l">${esc(r.name)}</td>${pack ? `<td>${esc(r.pack || '')}</td>` : ''}<td>${esc(r.unit || '')}</td>`
  + `<td class="n">${z(r.A)}</td><td class="n">${z(r.received)}</td><td class="n">${z(r.dispensed)}</td><td class="n"></td>`
  + `<td class="n">${z(r.adjPos)}</td><td class="n">${z(r.adjNeg)}</td><td class="n">${z(r.losses)}</td><td class="n b">${z(r.E)}</td>`
  + `<td class="n">${z(r.F)}</td><td class="n b">${z(r.G)}</td>${expiry ? '<td></td>' : ''}<td class="l"></td></tr>`

// ── CRRF — Lab CD4 (Laboratory Reagents/Accessories) ──────────────────────
export function printCrrfCd4(rows, ctx = {}) {
  let n = 0
  const body = rows.map(r => r.group
    ? `<tr class="grp"><td></td><td class="l" colspan="15">${esc(r.group)}</td></tr>`
    : (n++, labRow(r, n, { pack: true, expiry: true }))).join('')
  const equipment = `
    <div class="sub-h">Equipment Downtime</div>
    <table class="mini"><thead><tr><th style="width:34%">Equipment downtime</th><th>No of Days</th><th>Serial Number</th><th>Reason for Downtime</th></tr></thead>
      <tbody>${['Cyflow', 'PRESTO', 'Alere Pima', 'Others'].map(e => `<tr><td class="l">${e}</td><td></td><td></td><td></td></tr>`).join('')}</tbody></table>`
  const inner = armsHeader('COMBINED REPORT AND REQUISITION FORM (CRRF) - Laboratory Reagents/Accessories', 'CD4 REAGENTS') + crrfFields(ctx) + `
    <table class="crrf sm"><thead>
      <tr><th rowspan="3">Serial No.</th><th rowspan="3" style="width:22%">Item Description</th><th rowspan="3">Pack Size</th><th rowspan="3">Reporting Unit</th>
          <th colspan="8" class="rep">REPORT</th><th colspan="2" class="req">REQUISITION</th><th rowspan="3">Expiry Date DD/MM/YYYY</th><th rowspan="3">Remarks</th></tr>
      <tr><th rowspan="2">Beginning Balance</th><th rowspan="2">Qty Received</th><th rowspan="2">Qty Used</th><th rowspan="2">No of Tests Done</th><th colspan="2">Adjustments</th><th rowspan="2">Losses</th><th rowspan="2">Physical Count</th><th rowspan="2">Maximum Stock (Qty)</th><th rowspan="2">Qty to Order</th></tr>
      <tr><th>+</th><th>&#8722;</th></tr>
      <tr class="keys"><th></th><th></th><th></th><th></th><th>A</th><th>B</th><th>C</th><th>D</th><th>E+</th><th>E&#8722;</th><th>F</th><th>G</th><th>H = C&#215;2</th><th>I = H&#8722;G</th><th>J</th><th>K</th></tr></thead>
      <tbody>${body}</tbody></table>
    ${equipment}
    ${labExpiryRemarks()}
    ${labOfficers(['Report Prepared by (Full Name &amp; Signature):', 'Report Approved by (Full Name &amp; Signature):'])}`
  openPrint('CRRF — CD4', inner)
}

// ── CRRF — Lab HIV RTKs & DBS ─────────────────────────────────────────────
export function printCrrfRtk(rows, ctx = {}) {
  let n = 0
  const body = rows.map(r => r.group
    ? `<tr class="grp"><td></td><td class="l" colspan="13">${esc(r.group)}</td></tr>`
    : (n++, labRow(r, n, { pack: false, expiry: false }))).join('')
  // Bimonthly Summary of HIV Rapid Test Kits — usage split by purpose (blank).
  const purposeCols = ['HTS', 'PMTCT', 'Clinical Diagnosis', 'Quality Control', 'Training', 'Recruit / Outreach Screening', 'Total']
  const algoRows = [['1st Screening', 'DETERMINE'], ['Confirmatory', 'UNIGOLD'], ['Tie-breaker', 'STAT-PAK']]
  const summary1 = `
    <div class="sub-h">Bimonthly Summary of HIV Rapid Test Kits</div>
    <table class="mini"><thead><tr><th></th><th>Product Name</th>${purposeCols.map(c => `<th>${c}</th>`).join('')}</tr></thead>
      <tbody>${algoRows.map(([step, prod]) => `<tr><td class="l b">${step}</td><td class="l">${prod}</td>${purposeCols.map(() => '<td></td>').join('')}</tr>`).join('')}</tbody></table>`
  // Bimonthly Test Summary of HIV Testing / EID Testing — counts (blank).
  const testRow = t => `<tr><td class="l">${t}</td><td></td></tr>`
  const summary2 = `
    <div class="sub-h">Bimonthly Test Summary of HIV Testing</div>
    <table class="mini" style="max-width:520px"><tbody>
      <tr class="sec"><td colspan="2">HIV TESTING</td></tr>
      ${['Number of people tested', 'Number of people who received counselling &amp; results', 'Number of people tested with positive result'].map(testRow).join('')}
      <tr class="sec"><td colspan="2">EID TESTING</td></tr>
      ${['Number of HIV exposed Babies', 'Number of Infants received EID test'].map(testRow).join('')}
    </tbody></table>`
  const inner = armsHeader('COMBINED REPORT, REQUISITION FORM (CRRF) Report-Rapid Test kits', 'HIV Rapid Test Kit (RTKs), Dried Blood Spot (DBS) Kit and Other RDT') + crrfFields(ctx) + `
    <table class="crrf sm"><thead>
      <tr><th rowspan="3">Serial No.</th><th rowspan="3" style="width:26%">Item Description</th><th rowspan="3">Reporting Unit</th>
          <th colspan="8" class="rep">REPORT</th><th colspan="2" class="req">REQUISITION</th><th rowspan="3">Remarks</th></tr>
      <tr><th rowspan="2">Beginning Balance</th><th rowspan="2">Qty Received</th><th rowspan="2">Qty Used</th><th rowspan="2">No of Tests Done</th><th colspan="2">Adjustments</th><th rowspan="2">Losses</th><th rowspan="2">Physical Count</th><th rowspan="2">Maximum Stock (Qty)</th><th rowspan="2">Qty to Order</th></tr>
      <tr><th>+</th><th>&#8722;</th></tr>
      <tr class="keys"><th></th><th></th><th></th><th>A</th><th>B</th><th>C</th><th>D</th><th>E+</th><th>E&#8722;</th><th>F</th><th>G</th><th>H = C&#215;2</th><th>I = H&#8722;G</th><th>J</th></tr></thead>
      <tbody>${body}</tbody></table>
    ${summary1}
    ${summary2}
    ${labExpiryRemarks()}
    ${labOfficers(['Report Prepared by (Full Name &amp; Signature):', 'Requisition Approved by (Full Name &amp; Signature):'])}`
  openPrint('CRRF — HIV RTKs & DBS', inner)
}
