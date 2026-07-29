import express from 'express';
import multer from 'multer';
import { PriceImportService } from '../services/priceImportService.js';
import { parsePriceListDocx, parsePriceListCsv } from '../lib/priceListParser.js';
import { requireAdmin } from '../middleware/requireAdmin.js';

const router = express.Router();

// Price lists are a few hundred KB at most; keeping them in memory avoids temp files.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.get('/', async (req, res, next) => {
  try {
    return res.json(await PriceImportService.listImports());
  } catch (err) {
    return next(err);
  }
});

// Upload parses into staging only. Prices are not touched until /commit.
router.post('/', requireAdmin, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'a file upload named "file" is required' });

    const name = req.file.originalname || 'upload';
    const lower = name.toLowerCase();

    let rows;
    if (lower.endsWith('.docx')) {
      rows = await parsePriceListDocx(req.file.buffer);
    } else if (lower.endsWith('.csv')) {
      rows = parsePriceListCsv(req.file.buffer.toString('utf8'));
    } else {
      return res.status(400).json({ error: 'unsupported file type — upload a .docx or .csv price list' });
    }

    if (rows.length === 0) {
      return res.status(400).json({ error: 'no price rows found — check the file has the expected table layout' });
    }

    const importRow = await PriceImportService.stage({
      filename: name,
      rows,
      importedBy: req.user.username,
      notes: req.body?.notes || null,
    });

    const staged = await PriceImportService.stagedRows(importRow.id);
    return res.status(201).json({ import: importRow, rows: staged });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const importRow = await PriceImportService.getImport(Number(req.params.id));
    if (!importRow) return res.status(404).json({ error: 'import not found' });

    const rows = await PriceImportService.stagedRows(importRow.id);
    return res.json({ import: importRow, rows });
  } catch (err) {
    return next(err);
  }
});

router.put('/:id/rows/:rowId', requireAdmin, async (req, res, next) => {
  try {
    const row = await PriceImportService.updateStagedRow(Number(req.params.rowId), req.body || {});
    if (!row) return res.status(404).json({ error: 'staged row not found' });
    return res.json(row);
  } catch (err) {
    return next(err);
  }
});

// The source document has no vendor column, so this is the usual way to fill it in.
router.put('/:id/vendor', requireAdmin, async (req, res, next) => {
  try {
    const { vendorId, brandName } = req.body || {};
    if (!vendorId) return res.status(400).json({ error: 'vendorId is required' });

    const updated = await PriceImportService.assignVendorToAll(
      Number(req.params.id),
      Number(vendorId),
      brandName || null
    );
    return res.json({ rowsUpdated: updated });
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ error: 'unknown vendorId' });
    return next(err);
  }
});

router.post('/:id/commit', requireAdmin, async (req, res, next) => {
  try {
    const result = await PriceImportService.commit(Number(req.params.id), {
      committedBy: req.user.username,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

export default router;
