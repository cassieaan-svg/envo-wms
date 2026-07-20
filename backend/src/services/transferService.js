import { query, withTransaction } from '../db.js'
import { StockService } from './stockService.js'

// Nested commodity object matching the frontend's `commodities(id,name,category,unit)`
// embedded select, rebuilt with json_build_object (PostgREST replacement).
// stock_transfer_log has two FKs to facilities (sending + receiving), so we do
// NOT embed a `facilities` object — the frontend reads the denormalized
// sending_facility_name / receiving_facility_name text columns instead.
const COMM4_OBJ = `
  json_build_object('id', c.id, 'name', c.name, 'category', c.category, 'unit', c.unit) as commodities`

const DATE_FIELDS = new Set(['initiated_at', 'resolved_at'])

// Columns written by createTransfers (transfer_type is NOT a column — type is
// re-derived from notes; see _deriveTransferType).
const INSERT_COLS = [
  'sending_facility_id', 'sending_facility_name',
  'receiving_facility_id', 'receiving_facility_name',
  'commodity_id', 'commodity_name', 'quantity', 'qty_requested',
  'status', 'notes', 'initiated_by', 'initiated_at', 'section'
]

export class TransferService {
  // ── Reads ──────────────────────────────────────────────────────────────────

  /**
   * Flexible transfer list. All filters optional:
   *   facilityId + direction: 'incoming' (receiving=fid), 'outgoing' (sending=fid),
   *     or 'any'/'all' (either side).
   *   statuses: array of status values (or `status`: single value).
   *   section: pharmacy | lab.
   *   dateField ('initiated_at' | 'resolved_at') + from / to (YYYY-MM-DD).
   *   notesIncludes: substring the notes must contain (e.g. '[Internal:').
   *   limit / offset.
   */
  static async listTransfers(options = {}) {
    const {
      facilityId, facilityIds, direction = 'any', status, statuses, section, categories,
      dateField, from, to, notesIncludes, limit = 1000, offset = 0
    } = options

    const params = []
    const conds = []

    if (facilityId) {
      params.push(facilityId)
      const p = `$${params.length}`
      if (direction === 'incoming') conds.push(`t.receiving_facility_id = ${p}`)
      else if (direction === 'outgoing') conds.push(`t.sending_facility_id = ${p}`)
      else conds.push(`(t.receiving_facility_id = ${p} or t.sending_facility_id = ${p})`)
    } else if (facilityIds && facilityIds.length) {
      // Scope an admin list to a set of facilities (state/lga narrowing): the
      // transfer must have either endpoint inside the allowed set.
      params.push(facilityIds)
      const p = `$${params.length}`
      conds.push(`(t.sending_facility_id = any(${p}) or t.receiving_facility_id = any(${p}))`)
    }

    const statusList = statuses || (status ? [status] : null)
    if (statusList && statusList.length) {
      params.push(statusList)
      conds.push(`t.status = any($${params.length})`)
    }

    if (section) { params.push(section); conds.push(`t.section = $${params.length}`) }
    // Section enforcement: restrict to the caller's commodity categories (joined c).
    if (Array.isArray(categories) && categories.length) { params.push(categories); conds.push(`c.category = any($${params.length})`) }

    if (notesIncludes) { params.push(`%${notesIncludes}%`); conds.push(`t.notes like $${params.length}`) }

    const orderField = DATE_FIELDS.has(dateField) ? dateField : 'initiated_at'
    if (from && DATE_FIELDS.has(dateField)) {
      params.push(`${from}T00:00:00`); conds.push(`t.${orderField} >= $${params.length}`)
    }
    if (to && DATE_FIELDS.has(dateField)) {
      params.push(`${to}T23:59:59`); conds.push(`t.${orderField} <= $${params.length}`)
    }

    let sql = `select t.*, ${COMM4_OBJ}
               from stock_transfer_log t
               left join commodities c on c.id = t.commodity_id`
    if (conds.length) sql += ` where ${conds.join(' and ')}`
    params.push(limit, offset)
    sql += ` order by t.${orderField} desc nulls last limit $${params.length - 1} offset $${params.length}`

    const { rows } = await query(sql, params)
    return rows
  }

  /**
   * Single transfer with nested commodity. Returns null when not found.
   */
  static async getTransferById(transferId) {
    const { rows } = await query(
      `select t.*, ${COMM4_OBJ}
       from stock_transfer_log t
       left join commodities c on c.id = t.commodity_id
       where t.id = $1`,
      [transferId]
    )
    return rows[0] || null
  }

  // ── Create ───────────────────────────────────────────────────────────────

  /**
   * Bulk-create transfer rows. Each line is a (mostly) complete row; the caller
   * sets status/notes (the frontend already encodes the type into notes and the
   * appropriate initial status). NOT NULL name columns are resolved from the
   * line, then looked up, so the insert always satisfies the schema.
   */
  static async createTransfers(lines) {
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new Error('At least one line item required')
    }

    // Resolve commodity names in one query.
    const commodityIds = [...new Set(lines.map(l => l.commodity_id).filter(Boolean))]
    const commodityNames = {}
    if (commodityIds.length) {
      const { rows } = await query('select id, name from commodities where id = any($1)', [commodityIds])
      rows.forEach(r => { commodityNames[r.id] = r.name })
    }

    const params = []
    const valueGroups = []
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (!l.commodity_id || l.quantity === undefined) {
        throw new Error('Each line requires commodity_id and quantity')
      }
      const sendName = l.sending_facility_name ?? (await this._facilityName(l.sending_facility_id))
      const recvName = l.receiving_facility_name ?? (await this._facilityName(l.receiving_facility_id))
      const base = i * INSERT_COLS.length
      params.push(
        l.sending_facility_id || null,
        sendName || null,
        l.receiving_facility_id || null,
        recvName || '',
        l.commodity_id,
        l.commodity_name || commodityNames[l.commodity_id] || '',
        parseInt(l.quantity),
        parseInt(l.qty_requested ?? l.quantity),
        l.status || 'pending',
        l.notes ?? null,
        l.initiated_by || null,
        l.initiated_at || new Date().toISOString(),
        l.section ?? null
      )
      valueGroups.push(`(${INSERT_COLS.map((_, j) => `$${base + j + 1}`).join(',')})`)
    }

    const { rows } = await query(
      `insert into stock_transfer_log (${INSERT_COLS.join(', ')})
       values ${valueGroups.join(', ')}
       returning *`,
      params
    )
    return rows
  }

  // ── Lifecycle transitions (each transactional) ─────────────────────────────

  /**
   * Dispatch an approved/pending external transfer: status → in_transit, set the
   * issued quantity, append dispatch metadata to notes, and decrement the sender
   * store stock.
   */
  static async dispatch(transferId, data) {
    const { approved_by, carrier, expiry, batch, quantity } = data
    const transfer = await this.getTransferById(transferId)
    if (!transfer) return null
    const qty = parseInt(quantity ?? transfer.quantity)

    return withTransaction(async exec => {
      // Guard: never dispatch more than the sender's store actually holds.
      if (transfer.sending_facility_id) {
        const stk = await StockService.getStockByFacilityAndCommodity(
          transfer.sending_facility_id, transfer.commodity_id, 'store', exec)
        if (!stk || stk.quantity < qty) {
          const e = new Error(`Insufficient store stock. Available: ${stk?.quantity || 0}`); e.status = 409; throw e
        }
        await StockService.decrementStock(stk.id, qty, exec)
      }
      const meta = `[Approved by: ${approved_by || ''}] [Carrier: ${carrier || ''}] [Expiry: ${expiry || ''}] [Batch: ${batch || ''}]`
      const newNotes = transfer.notes ? `${transfer.notes} ${meta}` : meta
      const { rows } = await exec(
        `update stock_transfer_log set status = 'in_transit', quantity = $2, notes = $3
         where id = $1 returning *`,
        [transferId, qty, newNotes]
      )
      return rows[0] || null
    })
  }

  /**
   * Admin assigns a source facility to a pending request (no stock movement).
   */
  static async assignSource(transferId, data) {
    const { sending_facility_id, sending_facility_name, quantity, reviewed_by } = data
    const transfer = await this.getTransferById(transferId)
    if (!transfer) return null
    if (!sending_facility_id) throw new Error('sending_facility_id is required')

    const name = sending_facility_name ?? (await this._facilityName(sending_facility_id))
    const note = `[Reviewed by: ${reviewed_by || ''}]`
    const newNotes = transfer.notes ? `${transfer.notes} ${note}` : note
    const { rows } = await query(
      `update stock_transfer_log
       set sending_facility_id = $2, sending_facility_name = $3, quantity = $4, notes = $5
       where id = $1 returning *`,
      [transferId, sending_facility_id, name || '', parseInt(quantity ?? transfer.quantity), newNotes]
    )
    return rows[0] || null
  }

  /**
   * Receiver accepts an in-transit external transfer: credit receiver store
   * stock and mark accepted. NOTE: we deliberately do NOT also write an
   * intake_log row — the transfer_log entry already records this receipt, and an
   * intake row would double-count it (shown as a separate "Intake" in the
   * activity feed, and counted twice in CRRF: once as Quantity Received and
   * again as the external-transfer Adj+). The redistribution-in is reflected via
   * the transfer itself (CRRF counts external transfers as Adj+).
   */
  static async accept(transferId, data) {
    const { received_by } = data
    const transfer = await this.getTransferById(transferId)
    if (!transfer) return null
    if (!transfer.receiving_facility_id) throw new Error('Transfer has no receiving facility')

    return withTransaction(async exec => {
      await this._creditStock(exec, transfer.receiving_facility_id, transfer.commodity_id, transfer.quantity, 'store', transfer.section)

      const { rows } = await exec(
        `update stock_transfer_log set status = 'accepted', resolved_at = now(), resolved_by = $2
         where id = $1 returning *`,
        [transferId, received_by]
      )
      return rows[0] || null
    })
  }

  /**
   * Receiver disputes an in-transit transfer. A dispute is TERMINAL: the dispatch
   * is reversed here — the quantity goes straight back to the sending facility's
   * store — and the row stays 'disputed' for good. It is never flipped to
   * 'accepted' (that used to make a failed delivery render as a completed
   * stock-in for the receiver, contradicting their actual stock). The requesting
   * facility raises a fresh request instead.
   *
   * Optional facilityId guard: the disputing party is either the receiving
   * facility (external transfer) or the sending facility (a DSD/SDP site
   * disputing its parent store's dispatch, where receiving_facility_id is null).
   */
  static async dispute(transferId, data) {
    const { disputed_by, facilityId, dispute_note, qty_accepted } = data
    return withTransaction(async exec => {
      // Lock the row so two disputes can't both reverse the same dispatch.
      const { rows: cur } = await exec(`select * from stock_transfer_log where id = $1 for update`, [transferId])
      const prev = cur[0]
      if (!prev) return null
      if (prev.status === 'disputed') return null       // already disputed — never credit twice
      if (facilityId && prev.receiving_facility_id !== facilityId && prev.sending_facility_id !== facilityId) return null

      // Partial dispute: the receiver keeps `accepted` and sends the rest back.
      // Clamped so the two halves always add up to what was dispatched — a bad
      // or missing value degrades to the old all-or-nothing return.
      const dispatched = prev.quantity || 0
      const accepted = Math.min(Math.max(parseInt(qty_accepted, 10) || 0, 0), dispatched)
      const returned = dispatched - accepted

      const { rows } = await exec(
        `update stock_transfer_log
            set status = 'disputed', resolved_at = now(), resolved_by = $2, dispute_note = $3,
                qty_accepted = $4, qty_returned = $5
          where id = $1 returning *`,
        [transferId, disputed_by || null, dispute_note || 'Disputed by receiver', accepted, returned]
      )
      // Move stock only when it had actually left the sender's store: a dispatch
      // decrements it, a still-pending request never did.
      if (['in_transit', 'dispatched'].includes(prev.status)) {
        if (returned > 0 && prev.sending_facility_id) {
          await this._creditStock(exec, prev.sending_facility_id, prev.commodity_id, returned, 'store', prev.section)
        }
        await this._creditDestination(exec, prev, accepted)
      }
      return rows[0] || null
    })
  }

  /**
   * Credit `qty` to wherever a transfer was headed: a DSD/SDP site's own stock
   * table for a site dispatch (receiving_facility_id is null there, the site
   * lives in the notes tag), otherwise the receiving facility's store.
   */
  static async _creditDestination(exec, transfer, qty) {
    if (!qty || qty <= 0) return
    const isDsd = /\[DSD:/i.test(transfer.notes || '')
    const isSdp = /\[SDP:/i.test(transfer.notes || '')
    if (!isDsd && !isSdp) {
      // Throw rather than return: rolling the transaction back is far better
      // than silently dropping the quantity the receiver said they kept.
      if (!transfer.receiving_facility_id) throw new Error('Transfer has no destination facility to credit')
      await this._creditStock(exec, transfer.receiving_facility_id, transfer.commodity_id, qty, 'store', transfer.section)
      return
    }
    const fid = transfer.sending_facility_id
    const site = this._siteFromNotes(transfer.notes) || transfer.receiving_facility_name
    if (!fid || !site) throw new Error('Could not resolve the destination site name')
    if (isDsd) {
      const existing = await StockService.getDsdStockByFacilitySiteCommodity(fid, site, transfer.commodity_id, exec)
      if (existing) {
        await exec('update dsd_stock set quantity = quantity + $2, updated_at = now() where id = $1', [existing.id, qty])
      } else {
        await exec(`insert into dsd_stock (facility_id, dsd_site_name, commodity_id, quantity, updated_at)
                    values ($1,$2,$3,$4, now())`, [fid, site, transfer.commodity_id, qty])
      }
    } else {
      const existing = await StockService.getSdpStockByFacilitySiteCommodity(fid, site, transfer.commodity_id, exec)
      if (existing) {
        await exec('update sdp_stock set quantity = quantity + $2, updated_at = now() where id = $1', [existing.id, qty])
      } else {
        await exec(`insert into sdp_stock (facility_id, sdp_name, commodity_id, quantity, updated_at)
                    values ($1,$2,$3,$4, now())`, [fid, site, transfer.commodity_id, qty])
      }
    }
  }

  /**
   * Cancel / reject a transfer (no stock movement — used for pending requests
   * and pending_approval requests that never moved stock).
   */
  static async cancel(transferId, data = {}) {
    const { cancelled_by, reason } = data
    const transfer = await this.getTransferById(transferId)
    if (!transfer) return null
    const notes = reason ? `${transfer.notes || ''} [Cancelled: ${reason}]`.trim() : transfer.notes
    const { rows } = await query(
      `update stock_transfer_log
       set status = 'cancelled', resolved_at = now(), resolved_by = $2, notes = $3
       where id = $1 returning *`,
      [transferId, cancelled_by || null, notes]
    )
    return rows[0] || null
  }

  /**
   * Store manager approves an internal (Store → Dispensary) request: move
   * `quantity` from store to dispensary stock and mark accepted.
   */
  static async approveInternal(transferId, data) {
    const { approved_by, quantity } = data
    const transfer = await this.getTransferById(transferId)
    if (!transfer) return null
    const fid = transfer.sending_facility_id
    const qty = parseInt(quantity ?? transfer.quantity)

    return withTransaction(async exec => {
      const storeStk = await StockService.getStockByFacilityAndCommodity(fid, transfer.commodity_id, 'store', exec)
      if (!storeStk || storeStk.quantity < qty) {
        { const e = new Error(`Insufficient store stock. Available: ${storeStk?.quantity || 0}`); e.status = 409; throw e }
      }
      await StockService.decrementStock(storeStk.id, qty, exec)
      await this._creditStock(exec, fid, transfer.commodity_id, qty, 'dispensary', transfer.section)

      const { rows } = await exec(
        `update stock_transfer_log set status = 'accepted', quantity = $2, resolved_at = now(), resolved_by = $3
         where id = $1 returning *`,
        [transferId, qty, approved_by]
      )
      return rows[0] || null
    })
  }

  /**
   * Store manager approves a SDP/DSD request: deduct store stock and mark
   * dispatched (the site user confirms receipt later via receive()).
   */
  static async approveDsd(transferId, data) {
    const { approved_by, quantity } = data
    const transfer = await this.getTransferById(transferId)
    if (!transfer) return null
    const fid = transfer.sending_facility_id
    const qty = parseInt(quantity ?? transfer.quantity)

    return withTransaction(async exec => {
      const storeStk = await StockService.getStockByFacilityAndCommodity(fid, transfer.commodity_id, 'store', exec)
      if (!storeStk || storeStk.quantity < qty) {
        { const e = new Error(`Insufficient store stock. Available: ${storeStk?.quantity || 0}`); e.status = 409; throw e }
      }
      await StockService.decrementStock(storeStk.id, qty, exec)

      const { rows } = await exec(
        `update stock_transfer_log set status = 'dispatched', quantity = $2, resolved_by = $3
         where id = $1 returning *`,
        [transferId, qty, `[Approved: ${approved_by || ''}]`]
      )
      return rows[0] || null
    })
  }

  /**
   * Site user confirms receipt of a dispatched SDP/DSD transfer: credit the
   * site stock bucket (sdp_stock / dsd_stock keyed by the site name parsed from
   * notes) and mark accepted, appending the receiver to resolved_by.
   */
  static async receive(transferId, data) {
    const { received_by } = data
    const transfer = await this.getTransferById(transferId)
    if (!transfer) return null

    const fid = transfer.sending_facility_id
    const isDsd = /\[DSD:/i.test(transfer.notes || '')
    const site = this._siteFromNotes(transfer.notes) || transfer.receiving_facility_name
    if (!site) throw new Error('Could not resolve the destination site name')
    const qty = transfer.quantity

    return withTransaction(async exec => {
      if (isDsd) {
        const existing = await StockService.getDsdStockByFacilitySiteCommodity(fid, site, transfer.commodity_id, exec)
        if (existing) {
          await exec('update dsd_stock set quantity = quantity + $2, updated_at = now() where id = $1', [existing.id, qty])
        } else {
          await exec(`insert into dsd_stock (facility_id, dsd_site_name, commodity_id, quantity, updated_at)
                      values ($1,$2,$3,$4, now())`, [fid, site, transfer.commodity_id, qty])
        }
      } else {
        const existing = await StockService.getSdpStockByFacilitySiteCommodity(fid, site, transfer.commodity_id, exec)
        if (existing) {
          await exec('update sdp_stock set quantity = quantity + $2, updated_at = now() where id = $1', [existing.id, qty])
        } else {
          await exec(`insert into sdp_stock (facility_id, sdp_name, commodity_id, quantity, updated_at)
                      values ($1,$2,$3,$4, now())`, [fid, site, transfer.commodity_id, qty])
        }
      }

      const resolvedBy = `${transfer.resolved_by || ''} [Received by: ${received_by || ''}]`.trim()
      const { rows } = await exec(
        `update stock_transfer_log set status = 'accepted', resolved_at = now(), resolved_by = $2
         where id = $1 returning *`,
        [transferId, resolvedBy]
      )
      return rows[0] || null
    })
  }

  /**
   * Metadata-only update (no stock side-effects). For edit-quantity, dismiss,
   * mark-fulfilled, or notes edits. Only whitelisted fields are written.
   */
  static async updateTransfer(transferId, fields = {}) {
    const allowed = ['status', 'quantity', 'qty_requested', 'notes', 'dispute_note', 'resolved_by', 'resolved_at']
    const sets = []
    const params = [transferId]
    for (const k of allowed) {
      if (fields[k] !== undefined) {
        params.push(k === 'quantity' || k === 'qty_requested' ? parseInt(fields[k]) : fields[k])
        sets.push(`${k} = $${params.length}`)
      }
    }
    if (!sets.length) throw new Error('No updatable fields provided')
    const { rows } = await query(
      `update stock_transfer_log set ${sets.join(', ')} where id = $1 returning *`,
      params
    )
    return rows[0] || null
  }

  /**
   * Hard-delete a transfer row.
   */
  static async deleteTransfer(transferId) {
    const { rowCount } = await query('delete from stock_transfer_log where id = $1', [transferId])
    return rowCount > 0
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Credit (increment-or-create) store/dispensary stock within a transaction. */
  static async _creditStock(exec, facilityId, commodityId, qty, locationType, section) {
    const existing = await StockService.getStockByFacilityAndCommodity(facilityId, commodityId, locationType, exec)
    if (existing) {
      await StockService.incrementStock(existing.id, qty, exec)
    } else {
      await StockService.createStock(
        { facility_id: facilityId, commodity_id: commodityId, quantity: qty, location_type: locationType, section },
        exec
      )
    }
  }

  static async _facilityName(facilityId) {
    if (!facilityId) return null
    const { rows } = await query('select name from facilities where id = $1', [facilityId])
    return rows[0]?.name || null
  }

  static _siteFromNotes(notes) {
    const m = (notes || '').match(/\[(?:SDP|DSD):\s*([^\]]+)\]/i)
    return m ? m[1].trim() : null
  }

  static _deriveTransferType(transfer) {
    const notes = transfer.notes || ''
    if (/\[DSD:/i.test(notes)) return 'dsd'
    if (/\[SDP:/i.test(notes)) return 'sdp'
    if (/\[Internal:/i.test(notes)) return 'internal'
    return 'facility'
  }
}
