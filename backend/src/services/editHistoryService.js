import { query } from '../db.js'

// Audit trail for edits to dispense / intake / adjustment log records.
// Append-only: one row per edit, read back by record_id.
export class EditHistoryService {
  /**
   * History for a single log record, newest first.
   */
  static async getByRecord(recordId) {
    const { rows } = await query(
      `select * from edit_history where record_id = $1 order by created_at desc`,
      [recordId]
    )
    return rows
  }

  /**
   * Append an audit entry.
   */
  static async createEntry(data) {
    const {
      record_id, record_type, facility_id, commodity_id,
      old_quantity, new_quantity, quantity_diff, edited_by, note
    } = data

    if (!record_id || !record_type) {
      throw new Error('record_id and record_type are required')
    }

    const { rows } = await query(
      `insert into edit_history
         (record_id, record_type, facility_id, commodity_id,
          old_quantity, new_quantity, quantity_diff, edited_by, note, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       returning *`,
      [record_id, record_type, facility_id || null, commodity_id || null,
       old_quantity ?? null, new_quantity ?? null, quantity_diff ?? null,
       edited_by || null, note || null]
    )
    return rows[0] || null
  }
}
