// Parses a Central Medical Stores price list into flat rows.
//
// The source document is a single Word table shaped:
//   S/N | MEDICINES DESCRIPTION | UNIT | UNIT PRICE | REMARK
// with category header rows breaking it into sections — those carry a section letter in
// S/N, the category name in the description column, and nothing else:
//   A | TABLETS/ CAPLETS/ CAPSULES |  |  |
// Every data row below a header belongs to that category until the next header.
import { unzipSync, strFromU8 } from 'fflate';
import { readFile } from 'node:fs/promises';

// Word splits a single visible string across many <w:r> runs, so cell text has to be
// rebuilt by concatenating every <w:t> inside the cell rather than reading one.
function cellText(cellXml) {
  const parts = cellXml.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) || [];
  return parts
    .map((part) => part.replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/, '$1'))
    .join('')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTableRows(documentXml) {
  const rowMatches = documentXml.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) || [];
  return rowMatches.map((rowXml) => {
    const cellMatches = rowXml.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || [];
    return cellMatches.map(cellText);
  });
}

function parsePrice(raw) {
  if (!raw) return null;
  // Strip currency symbols, thousands separators and stray footnote marks.
  const cleaned = raw.replace(/[^\d.]/g, '');
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function isHeaderRow(cells) {
  const [sn, description, unit, price] = cells;
  // A category header has a short section marker, a description, and no unit or price.
  return Boolean(description) && !unit && !price && /^[A-Z]$/i.test((sn || '').trim());
}

function isColumnHeaderRow(cells) {
  return /^s\/?n$/i.test((cells[0] || '').trim());
}

export function parsePriceListXml(documentXml) {
  const rows = parseTableRows(documentXml);
  const parsed = [];
  let category = null;

  for (const cells of rows) {
    if (cells.length < 2) continue;
    if (isColumnHeaderRow(cells)) continue;

    if (isHeaderRow(cells)) {
      category = cells[1];
      continue;
    }

    const [sn, description, unit, price, remark] = cells;
    if (!description) continue;

    const unitPrice = parsePrice(price);
    // Rows without a usable price are kept so the admin can see and fix them during
    // review rather than having them silently vanish from the batch.
    parsed.push({
      sourceRow: Number.parseInt((sn || '').replace(/\D/g, ''), 10) || null,
      category,
      description,
      unit: unit || null,
      unitPrice,
      remark: remark || null,
    });
  }

  return parsed;
}

export async function parsePriceListDocx(bufferOrPath) {
  const buffer = Buffer.isBuffer(bufferOrPath) ? bufferOrPath : await readFile(bufferOrPath);
  const files = unzipSync(new Uint8Array(buffer));
  const documentXml = files['word/document.xml'];
  if (!documentXml) throw new Error('not a valid .docx (word/document.xml missing)');
  return parsePriceListXml(strFromU8(documentXml));
}

// CSV fallback for lists that don't arrive as Word documents. Expects the same columns
// in the same order; a row with only a description is treated as a category header.
export function parsePriceListCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const rows = lines.map((line) => {
    const cells = [];
    let current = '';
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') inQuotes = !inQuotes;
      else if (char === ',' && !inQuotes) {
        cells.push(current.trim());
        current = '';
      } else current += char;
    }
    cells.push(current.trim());
    return cells;
  });

  const parsed = [];
  let category = null;
  for (const cells of rows) {
    if (isColumnHeaderRow(cells)) continue;
    if (isHeaderRow(cells)) {
      category = cells[1];
      continue;
    }
    const [sn, description, unit, price, remark] = cells;
    if (!description) continue;
    parsed.push({
      sourceRow: Number.parseInt((sn || '').replace(/\D/g, ''), 10) || null,
      category,
      description,
      unit: unit || null,
      unitPrice: parsePrice(price),
      remark: remark || null,
    });
  }
  return parsed;
}
