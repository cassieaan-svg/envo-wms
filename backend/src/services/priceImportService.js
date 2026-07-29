import { query, withTransaction } from '../db.js';

export class PriceImportService {
  // Staging insert is one transaction: either the whole file lands for review or none
  // of it does. Nothing touches commodity_prices at this point.
  static async stage({ filename, rows, importedBy, notes }) {
    return withTransaction(async (client) => {
      const importResult = await client.query(
        `INSERT INTO price_list_imports (filename, imported_by, row_count, notes)
         VALUES ($1, $2, $3, $4)
         RETURNING id, filename, imported_by, imported_at, row_count, notes`,
        [filename, importedBy ?? null, rows.length, notes ?? null]
      );
      const importRow = importResult.rows[0];

      for (const row of rows) {
        // Try to match an existing commodity by name so re-importing an updated list
        // updates prices instead of creating duplicates.
        const match = await client.query(
          'SELECT id FROM commodities WHERE lower(name) = lower($1) LIMIT 1',
          [row.description]
        );

        await client.query(
          `INSERT INTO price_import_staging
             (import_id, source_row, category, description, unit, unit_price, remark, commodity_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            importRow.id,
            row.sourceRow ?? null,
            row.category ?? null,
            row.description,
            row.unit ?? null,
            row.unitPrice ?? null,
            row.remark ?? null,
            match.rows[0]?.id ?? null,
          ]
        );
      }

      return importRow;
    });
  }

  static async getImport(importId) {
    const { rows } = await query(
      `SELECT id, filename, imported_by, imported_at, row_count, notes, committed_at
         FROM price_list_imports WHERE id = $1`,
      [importId]
    );
    return rows[0] || null;
  }

  static async listImports() {
    const { rows } = await query(
      `SELECT i.id, i.filename, i.imported_by, i.imported_at, i.row_count, i.notes, i.committed_at,
              COUNT(s.id) FILTER (WHERE NOT s.is_excluded)::int AS included_rows
         FROM price_list_imports i
         LEFT JOIN price_import_staging s ON s.import_id = i.id
        GROUP BY i.id
        ORDER BY i.imported_at DESC`
    );
    return rows;
  }

  static async stagedRows(importId) {
    const { rows } = await query(
      `SELECT s.id,
              s.source_row,
              s.category,
              s.description,
              s.unit,
              s.unit_price,
              s.remark,
              s.vendor_id,
              v.name AS vendor_name,
              s.brand_name,
              s.commodity_id,
              c.name AS matched_commodity_name,
              s.is_excluded
         FROM price_import_staging s
         LEFT JOIN vendors v ON v.id = s.vendor_id
         LEFT JOIN commodities c ON c.id = s.commodity_id
        WHERE s.import_id = $1
        ORDER BY s.id`,
      [importId]
    );
    return rows;
  }

  // Built from only the keys the caller actually sent, so an explicit null clears a field
  // (clearing a vendor, blanking an unpriced row) while an omitted key leaves it alone.
  static async updateStagedRow(rowId, patch) {
    const columns = {
      unitPrice: 'unit_price',
      vendorId: 'vendor_id',
      brandName: 'brand_name',
      description: 'description',
      category: 'category',
      unit: 'unit',
      isExcluded: 'is_excluded',
    };

    const assignments = [];
    const params = [rowId];
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(patch, key)) continue;
      params.push(patch[key]);
      assignments.push(`${column} = $${params.length}`);
    }

    if (assignments.length === 0) {
      const err = new Error('no updatable fields supplied');
      err.status = 400;
      throw err;
    }

    const { rows } = await query(
      `UPDATE price_import_staging
          SET ${assignments.join(', ')}
        WHERE id = $1
        RETURNING id, description, category, unit, unit_price, vendor_id, brand_name, is_excluded`,
      params
    );
    return rows[0] || null;
  }

  // The source price list has no vendor column, so this sets one vendor across every
  // still-included row of a batch.
  static async assignVendorToAll(importId, vendorId, brandName = null) {
    const { rowCount } = await query(
      `UPDATE price_import_staging
          SET vendor_id = $2,
              brand_name = COALESCE($3, brand_name)
        WHERE import_id = $1 AND NOT is_excluded`,
      [importId, vendorId, brandName]
    );
    return rowCount;
  }

  // Commit is all-or-nothing: creates any missing commodities, then versions each price
  // (old current row flipped to false, new row inserted).
  static async commit(importId, { committedBy }) {
    return withTransaction(async (client) => {
      const importResult = await client.query(
        'SELECT id, committed_at FROM price_list_imports WHERE id = $1 FOR UPDATE',
        [importId]
      );
      const importRow = importResult.rows[0];
      if (!importRow) {
        const err = new Error('import not found');
        err.status = 404;
        throw err;
      }
      if (importRow.committed_at) {
        const err = new Error('this import has already been committed');
        err.status = 409;
        throw err;
      }

      const staged = await client.query(
        `SELECT id, description, category, unit, unit_price, vendor_id, brand_name, commodity_id
           FROM price_import_staging
          WHERE import_id = $1 AND NOT is_excluded
          ORDER BY id`,
        [importId]
      );

      if (staged.rows.length === 0) {
        const err = new Error('nothing to commit — every staged row is excluded');
        err.status = 400;
        throw err;
      }

      const missingVendor = staged.rows.filter((r) => !r.vendor_id);
      if (missingVendor.length > 0) {
        const err = new Error(
          `${missingVendor.length} row(s) have no vendor assigned; assign a vendor or exclude them before committing`
        );
        err.status = 400;
        throw err;
      }

      const missingPrice = staged.rows.filter((r) => r.unit_price == null);
      if (missingPrice.length > 0) {
        const err = new Error(
          `${missingPrice.length} row(s) have no unit price; fix or exclude them before committing`
        );
        err.status = 400;
        throw err;
      }

      let commoditiesCreated = 0;
      let pricesInserted = 0;

      for (const row of staged.rows) {
        let commodityId = row.commodity_id;

        if (!commodityId) {
          const existing = await client.query(
            'SELECT id FROM commodities WHERE lower(name) = lower($1) LIMIT 1',
            [row.description]
          );

          if (existing.rows[0]) {
            commodityId = existing.rows[0].id;
          } else {
            const created = await client.query(
              `INSERT INTO commodities (name, category, unit) VALUES ($1, $2, $3) RETURNING id`,
              [row.description, row.category, row.unit]
            );
            commodityId = created.rows[0].id;
            commoditiesCreated += 1;
          }
        }

        await client.query(
          `UPDATE commodity_prices
              SET is_current = FALSE
            WHERE commodity_id = $1
              AND vendor_id = $2
              AND brand_name IS NOT DISTINCT FROM $3
              AND is_current`,
          [commodityId, row.vendor_id, row.brand_name]
        );

        await client.query(
          `INSERT INTO commodity_prices
             (commodity_id, vendor_id, brand_name, unit_price, is_current, created_by)
           VALUES ($1, $2, $3, $4, TRUE, $5)`,
          [commodityId, row.vendor_id, row.brand_name, row.unit_price, committedBy ?? null]
        );
        pricesInserted += 1;

        if (!row.commodity_id) {
          await client.query('UPDATE price_import_staging SET commodity_id = $2 WHERE id = $1', [
            row.id,
            commodityId,
          ]);
        }
      }

      await client.query('UPDATE price_list_imports SET committed_at = now() WHERE id = $1', [importId]);

      return { importId, rowsCommitted: staged.rows.length, commoditiesCreated, pricesInserted };
    });
  }
}
