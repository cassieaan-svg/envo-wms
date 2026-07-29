import { query } from '../db.js';

export class VendorService {
  static async list({ includeInactive = false } = {}) {
    const { rows } = await query(
      `SELECT id, name, contact_name, contact_phone, contact_email, is_active, created_at
         FROM vendors
        WHERE ($1 OR is_active)
        ORDER BY name`,
      [includeInactive]
    );
    return rows;
  }

  static async create({ name, contactName, contactPhone, contactEmail }) {
    const { rows } = await query(
      `INSERT INTO vendors (name, contact_name, contact_phone, contact_email)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, contact_name, contact_phone, contact_email, is_active, created_at`,
      [name, contactName || null, contactPhone || null, contactEmail || null]
    );
    return rows[0];
  }

  static async update(id, { name, contactName, contactPhone, contactEmail, isActive }) {
    // COALESCE lets callers send a partial body without clobbering existing values.
    const { rows } = await query(
      `UPDATE vendors
          SET name = COALESCE($2, name),
              contact_name = COALESCE($3, contact_name),
              contact_phone = COALESCE($4, contact_phone),
              contact_email = COALESCE($5, contact_email),
              is_active = COALESCE($6, is_active)
        WHERE id = $1
        RETURNING id, name, contact_name, contact_phone, contact_email, is_active, created_at`,
      [id, name ?? null, contactName ?? null, contactPhone ?? null, contactEmail ?? null, isActive ?? null]
    );
    return rows[0] || null;
  }

  // Soft delete — price history and batches reference vendors, so rows are never removed.
  static async deactivate(id) {
    const { rows } = await query(
      'UPDATE vendors SET is_active = FALSE WHERE id = $1 RETURNING id, name, is_active',
      [id]
    );
    return rows[0] || null;
  }
}
