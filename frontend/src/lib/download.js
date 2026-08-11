// CSV and PDF export helpers. jsPDF is pulled in on demand so the ~150KB only loads when
// someone actually asks for a PDF.

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// Excel opens a bare UTF-8 CSV in the system codepage, which mangles ₦ and the
// dotted names in the facility list — the BOM makes it read the file as UTF-8.
function toCsv(columns, rows) {
  const escape = (value) => {
    if (value == null) return '';
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const lines = [columns.map((c) => escape(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escape(c.value(row))).join(','));
  }
  return `﻿${lines.join('\r\n')}`;
}

export function downloadCsv(filename, columns, rows) {
  triggerDownload(new Blob([toCsv(columns, rows)], { type: 'text/csv;charset=utf-8;' }), filename);
}

export function stamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

// Slugify a name for use in a filename.
export function slug(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

// Generic tabular PDF: a title block, optional key/value meta lines, a table, and an
// optional total row.
export async function downloadPdf({ filename, title, subtitle, meta = [], columns, rows, total }) {
  const [{ jsPDF }, autoTableModule] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  const autoTable = autoTableModule.default;

  const doc = new jsPDF({ orientation: columns.length > 6 ? 'landscape' : 'portrait', unit: 'pt' });
  const marginX = 40;
  let y = 46;

  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(title, marginX, y);

  if (subtitle) {
    y += 16;
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(90);
    doc.text(subtitle, marginX, y);
    doc.setTextColor(0);
  }

  if (meta.length) {
    y += 16;
    doc.setFontSize(9);
    for (const [label, value] of meta) {
      doc.text(`${label}: ${value}`, marginX, y);
      y += 13;
    }
    y -= 13;
  }

  autoTable(doc, {
    startY: y + 14,
    margin: { left: marginX, right: marginX },
    head: [columns.map((c) => c.header)],
    body: rows.map((row) => columns.map((c) => c.value(row) ?? '')),
    styles: { fontSize: 8, cellPadding: 4, overflow: 'linebreak' },
    headStyles: { fillColor: [15, 109, 84], textColor: 255, fontStyle: 'bold' },
    columnStyles: Object.fromEntries(
      columns.map((c, i) => [i, c.align === 'right' ? { halign: 'right' } : {}])
    ),
  });

  if (total) {
    const endY = doc.lastAutoTable.finalY + 18;
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text(`${total.label}: ${total.value}`, marginX, endY);
  }

  // Page numbers, since a full commodity list runs to several pages.
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i += 1) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(120);
    doc.text(
      `Page ${i} of ${pages}`,
      doc.internal.pageSize.getWidth() - marginX,
      doc.internal.pageSize.getHeight() - 20,
      { align: 'right' }
    );
  }

  doc.save(filename);
}
