// Prints the official "Combined Requisition/Receipt/Issue Voucher" (Essential Drug
// Revolving Fund) for a fulfilled/queued request, filled from its data. Opens a print
// window so it never disturbs the app; the layout is self-contained HTML + CSS.

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Split a numeric into naira / kobo for the two-column money cells.
function nk(v) {
  if (v == null || v === '') return { n: '', k: '' };
  const [n, k] = Number(v).toFixed(2).split('.');
  return { n: Number(n).toLocaleString('en-NG'), k };
}

function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB');
}

// A labelled value with an underline, for the header fields.
const line = (label, value) =>
  `<div class="fld"><span class="lbl">${esc(label)}</span><span class="val">${esc(value)}</span></div>`;

const ROW_COUNT = 14;   // the paper form has 14 numbered lines

export function buildDrfVoucherHtml(request) {
  // Once dispatched, a line the warehouse removed (issued 0) isn't part of the voucher —
  // the facility re-requests it later. Before dispatch (qty_dispatched null) every
  // requested line still shows, so the pick list is complete.
  const items = (request.items || []).filter(
    (i) => i.qty_dispatched == null || Number(i.qty_dispatched) > 0);
  const rowsHtml = [];
  for (let i = 0; i < Math.max(items.length, ROW_COUNT); i += 1) {
    const it = items[i];
    const no = String(i + 1).padStart(2, '0');
    if (it) {
      const rate = nk(it.unit_price);
      const total = nk(it.line_total);
      rowsHtml.push(`<tr>
        <td class="c">${no}</td>
        <td></td>
        <td class="wrap">${esc(it.commodity_name)}</td>
        <td class="c">${esc(it.unit || '')}</td>
        <td class="r">${esc(it.quantity)}</td>
        <td class="r">${esc(it.qty_dispatched ?? '')}</td>
        <td></td><td></td>
        <td class="r">${rate.n}</td><td class="c">${rate.k}</td>
        <td class="r">${total.n}</td><td class="c">${total.k}</td>
        <td></td><td></td><td></td>
      </tr>`);
    } else {
      rowsHtml.push(`<tr class="blank">
        <td class="c">${no}</td>
        <td></td><td></td><td></td><td></td><td></td><td></td><td></td>
        <td></td><td></td><td></td><td></td><td></td><td></td><td></td>
      </tr>`);
    }
  }

  const facility = [request.facility_name, [request.lga, request.state].filter(Boolean).join(', ')]
    .filter(Boolean).join(' — ');
  const grand = nk(request.total_amount);

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>DRF Voucher #${esc(request.id)}</title>
<style>
  @page { size: A4 landscape; margin: 8mm; }
  * { box-sizing: border-box; }
  body { font-family: "Times New Roman", Georgia, serif; color:#000; font-size:10px; margin:0; }
  .sheet { width:100%; }
  .head { text-align:center; line-height:1.25; }
  .head .ministry { font-size:13px; font-weight:bold; letter-spacing:.5px; }
  .head .fund { font-size:11px; font-weight:bold; }
  .head .title { font-size:12px; font-weight:bold; text-decoration:underline; margin-top:2px; }
  .vno { float:right; border:1px solid #000; padding:2px 8px; font-weight:bold; color:#b00; }
  .fld { display:flex; gap:4px; align-items:flex-end; margin:2px 0; }
  .fld .lbl { white-space:nowrap; }
  .fld .val { flex:1; border-bottom:1px solid #000; min-height:12px; padding:0 3px; font-weight:bold; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:0; border:1px solid #000; margin-top:6px; }
  .box { border:1px solid #000; padding:4px 6px; }
  .box h4 { margin:0 0 3px; font-size:9px; text-transform:uppercase; border-bottom:1px solid #000; padding-bottom:2px; }
  .sig { display:flex; gap:8px; margin-top:3px; }
  .sig .fld { flex:1; }
  table { width:100%; border-collapse:collapse; margin-top:6px; }
  th, td { border:1px solid #000; padding:2px 3px; font-size:9px; vertical-align:top; }
  th { text-align:center; font-weight:bold; }
  td.c { text-align:center; } td.r { text-align:right; } td.wrap { text-align:left; }
  tr.blank td { height:16px; }
  .num { font-size:8px; color:#333; }
  .foot { margin-top:6px; font-size:8px; font-style:italic; text-align:center; }
  @media screen { body { background:#f2f2f2; padding:10px; } .sheet { background:#fff; padding:10mm; max-width:1100px; margin:0 auto; box-shadow:0 1px 6px rgba(0,0,0,.2); } }
</style></head>
<body onload="window.focus(); window.print();">
<div class="sheet">
  <div class="vno">No. ${esc(request.id)}</div>
  <div class="head">
    <div class="ministry">MINISTRY OF HEALTH, AKWA IBOM STATE</div>
    <div class="fund">ESSENTIAL DRUG REVOLVING FUND (DRF)</div>
    <div class="title">COMBINED REQUISITION / RECEIPT / ISSUE VOUCHER</div>
  </div>

  <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-top:6px;">
    <div>
      ${line('Institution', 'Central Medical Stores, Uyo')}
      ${line('From', 'Central Medical Stores, Uyo')}
      ${line('To', facility)}
      ${line('Please Supply to', request.facility_name || '')}
      <div style="display:flex; gap:8px;">${line('Job No.', '')}${line('Purpose', 'Essential commodities resupply')}</div>
    </div>
    <div class="box">
      <h4>To be completed by Requisitioning Officer</h4>
      <div style="display:flex; gap:8px;">${line('Requisition No.', '')}${line('Date', '')}</div>
      ${line('Requisition authorised by', '')}
      <div class="sig">${line('Signed', '')}${line('Designation', '')}</div>
    </div>
  </div>

  <div class="grid" style="grid-template-columns:1fr 1fr 1fr;">
    <div class="box">
      <h4>To be completed by Issuing Store Keeper</h4>
      <div class="sig">${line('Issued by', '')}${line('Date', '')}</div>
      <div class="sig">${line('Designation', '')}${line('Signed', '')}</div>
    </div>
    <div class="box">
      <h4>To be completed by Officer keeping Stores Ledger</h4>
      <div class="fld"><span class="lbl">Entered at page(s)</span><span class="val"></span></div>
      <div class="sig">${line('Date', '')}${line('Signed', '')}</div>
    </div>
    <div class="box">
      <h4>To be completed by Receiving Store Keeper</h4>
      <div class="sig">${line('Received by', request.received_by || '')}${line('Date', fmtDate(request.received_at))}</div>
      <div class="fld"><span class="lbl">Signed</span><span class="val"></span></div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th rowspan="2">Item<br>No.</th>
        <th rowspan="2">Part No.<br>(if any)</th>
        <th colspan="3">REQUISITIONS</th>
        <th colspan="3">ISSUES</th>
        <th colspan="2">Rate</th>
        <th colspan="2">Total</th>
        <th colspan="2">RECEIPTS</th>
        <th rowspan="2">Remarks</th>
      </tr>
      <tr>
        <th>Description</th><th>Unit</th><th>Quantity<br>Required</th>
        <th>Quantity</th><th>Ledger<br>Page No.</th><th>Stock<br>Balance</th>
        <th>&#8358;</th><th>k</th>
        <th>&#8358;</th><th>k</th>
        <th>Quantity</th><th>Ledger<br>Page No.</th>
      </tr>
      <tr class="num">
        <th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th><th>7</th><th>8</th>
        <th>9</th><th></th><th>10</th><th></th><th>11</th><th>12</th><th>13</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml.join('\n')}
      <tr>
        <td colspan="10" class="r" style="font-weight:bold;">TOTAL</td>
        <td class="r" style="font-weight:bold;">${grand.n}</td><td class="c" style="font-weight:bold;">${grand.k}</td>
        <td></td><td></td><td></td>
      </tr>
    </tbody>
  </table>

  <div class="foot">Unauthorised signatory / user institution will be liable for prosecution in accordance with the laws of the land.</div>
</div>
</body></html>`;

  return html;
}

export function printDrfVoucher(request) {
  const w = window.open('', '_blank', 'width=1100,height=800');
  if (!w) return;
  w.document.open();
  w.document.write(buildDrfVoucherHtml(request));
  w.document.close();
}
