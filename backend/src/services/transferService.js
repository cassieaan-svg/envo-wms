import { query, withTransaction } from '../db.js'
import { StockService } from './stockService.js'
import { LotService, splitLots, ymd } from './lotService.js'
import { sectionFilterSql } from '../constants/sections.js'

// Nested commodity object matching the frontend's `commodities(id,name,category,unit)`
// embedded select, rebuilt with json_build_object (PostgREST replacement).
// stock_transfer_log has two FKs to facilities (sending + receiving), so we do
// NOT embed a `facilities` object — the frontend reads the denormalized
// sending_facility_name / receiving_facility_name text columns instead.
const COMM4_OBJ = `
  json_build_object('id', c.id, 'name', c.name, 'category', c.category, 'unit', c.unit) as commodities`

const DATE_FIELDS = new Set(['initiated_at', 'resolved_at'])

// Groupings GET /api/transfers/summary will serve — an explicit allowlist, not a
// generic GROUP BY, matching DISPENSE_GROUP_BY's rationale. The keys are a subset
// of the dispense/intake ones so Monitoring can request the same shape from all
// three aggregates; 'facility' here means the RECEIVING facility.
const TRANSFER_IN_GROUP_BY = {
  'commodity':          { dimensions: ['commodity'] },
  'facility':           { dimensions: ['facility'] },
  'day':                { dimensions: ['day'], needsDay: true },
  'commodity,facility': { dimensions: ['commodity', 'facility'] },
  'commodity,day':      { dimensions: ['commodity', 'day'], needsDay: true },
}

export const TRANSFER_IN_GROUP_BY_KEYS = Object.keys(TRANSFER_IN_GROUP_BY)

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
   *   commodityIds: restrict to these commodities.
   *   limit / offset.
   */
  static async listTransfers(options = {}) {
    const {
      facilityId, facilityIds, direction = 'any', status, statuses, section, categories, commodityNames,
      dateField, from, to, notesIncludes, commodityIds, limit = 1000, offset = 0
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
      // Scope an admin list to a set of facilities (state/lga narrowing). `direction`
      // is honoured here as well as on the single-facility path: without it an
      // "incoming" list would also return the scope's OUTGOING transfers, which for
      // an admin whose scope contains both endpoints is every internal movement
      // twice over. Default stays 'any', so existing callers are unaffected.
      params.push(facilityIds)
      const p = `$${params.length}`
      if (direction === 'incoming') conds.push(`t.receiving_facility_id = any(${p})`)
      else if (direction === 'outgoing') conds.push(`t.sending_facility_id = any(${p})`)
      else conds.push(`(t.sending_facility_id = any(${p}) or t.receiving_facility_id = any(${p}))`)
    }

    if (Array.isArray(commodityIds) && commodityIds.length) {
      params.push(commodityIds)
      conds.push(`t.commodity_id = any($${params.length})`)
    }

    const statusList = statuses || (status ? [status] : null)
    if (statusList && statusList.length) {
      params.push(statusList)
      conds.push(`t.status = any($${params.length})`)
    }

    if (section) { params.push(section); conds.push(`t.section = $${params.length}`) }
    // Section enforcement: the caller's commodity categories (joined c), plus any
    // commodity individually granted to their facility.
    { const secCond = sectionFilterSql('c', categories, commodityNames, params); if (secCond) conds.push(secCond) }

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
   * Transfers RECEIVED by a facility set, aggregated — the inter-facility half of
   * "what came in", sitting beside the supplier-receipt half (LogService
   * .getIntakeSummary) on Monitoring. Deliberately returns the SAME row shape
   * ({ commodity_id | facility_id | day, qty, txn }) and accepts the same group_by
   * keys, so the dashboard treats the two identically.
   *
   * Three modelling decisions, all of which make this count STOCK THAT ACTUALLY
   * LANDED rather than movements that were merely started:
   *   status = 'accepted'  — the only status where the receiving facility's stock
   *     was credited. pending / in_transit / dispatched haven't arrived, cancelled
   *     and disputed never did. Counting them would inflate a facility's intake
   *     with stock it cannot put on a shelf.
   *   qty = coalesce(qty_accepted, quantity) — a partial acceptance credits only
   *     what was accepted; qty_accepted is null on older rows, which predate the
   *     column and accepted in full.
   *   date = resolved_at — when it landed, not when it was raised (initiated_at).
   *     A transfer raised in June and accepted in July is July's intake, which is
   *     the month whose stock it changed.
   *
   * `direction` picks which side is scoped and reported:
   *   'in'  (default) — stock ARRIVING; scoped and grouped on receiving_facility_id
   *   'out'           — stock LEAVING;  scoped and grouped on sending_facility_id
   * Both exclude internal self-transfers, which are neither an arrival nor a
   * departure. `facilityIds` / `facilityId` scope whichever side `direction` names.
   */
  static async getTransferSummary(facilityId, options = {}) {
    const {
      from, to, facilityIds, commodityIds, categories, commodityNames, section,
      groupBy = 'commodity', commodityId = null, category = null, tz = null,
      direction = 'in',
    } = options
    if (!facilityId && Array.isArray(facilityIds) && facilityIds.length === 0) return []

    const spec = TRANSFER_IN_GROUP_BY[groupBy]
    if (!spec) throw new Error(`Unsupported group_by: ${groupBy}`)
    if (direction !== 'in' && direction !== 'out') throw new Error(`Unsupported direction: ${direction}`)

    // The facility column this direction is about. Everything else — scoping, the
    // 'facility' group dimension — keys off it, so 'out' is the exact mirror of 'in'.
    const facCol = direction === 'out' ? 't.sending_facility_id' : 't.receiving_facility_id'

    const params = []
    const conds = [
      `t.status = 'accepted'`,
      't.resolved_at is not null',
      // Count only movements BETWEEN TWO REAL, DIFFERENT FACILITIES. Two kinds of
      // internal distribution otherwise slip in, and neither is stock entering or
      // leaving a facility — in both, it stays put and only changes sub-location:
      //
      //   '[Internal: Store→Dispensary]' — sending_facility_id = receiving_facility_id.
      //       ~922 rows / 111,579 units in a 30-day window.
      //   '[SDP: Main Lab]' — receiving_facility_id IS NULL, with the sub-unit's name
      //       in receiving_facility_name. A service delivery point is a site inside
      //       the sending facility, not a facility row. 1,891 rows / 129,615 units.
      //
      // Requiring both ids to be present AND different excludes both, and makes the
      // two directions symmetric: every counted row has a real sender and a real
      // receiver, so an unscoped total is identical whichever way it is measured.
      't.sending_facility_id is not null',
      't.receiving_facility_id is not null',
      't.sending_facility_id <> t.receiving_facility_id',
    ]

    if (facilityId) { params.push(facilityId); conds.push(`${facCol} = $${params.length}`) }
    else if (Array.isArray(facilityIds)) { params.push(facilityIds); conds.push(`${facCol} = any($${params.length})`) }

    if (Array.isArray(commodityIds) && commodityIds.length) { params.push(commodityIds); conds.push(`t.commodity_id = any($${params.length})`) }
    { const secCond = sectionFilterSql('c', categories, commodityNames, params); if (secCond) conds.push(secCond) }
    if (section) { params.push(section); conds.push(`t.section = $${params.length}`) }
    if (from) { params.push(from); conds.push(`t.resolved_at >= $${params.length}`) }
    if (to)   { params.push(to);   conds.push(`t.resolved_at <= $${params.length}`) }

    // Drill-in narrowing: ONE commodity, or ONE category. Narrows only — the
    // section condition above still applies independently.
    if (commodityId) { params.push(commodityId); conds.push(`t.commodity_id = $${params.length}`) }
    if (category) { params.push(category); conds.push(`c.category = $${params.length}`) }

    let dayExpr = null
    if (spec.needsDay) {
      if (tz) { params.push(tz); dayExpr = `to_char(t.resolved_at at time zone $${params.length}, 'YYYY-MM-DD')` }
      else dayExpr = `to_char(t.resolved_at at time zone 'UTC', 'YYYY-MM-DD')`
    }

    // The 'facility' dimension is whichever side `direction` reports, aliased to
    // facility_id so the row is drop-in compatible with the intake/dispense aggregates.
    const col = d => (d === 'facility' ? facCol : `t.${d}_id`)
    const selects = spec.dimensions.map(d => (d === 'day' ? `${dayExpr} as day` : `${col(d)} as ${d}_id`))
    const groupCols = spec.dimensions.map(d => (d === 'day' ? 'day' : col(d)))

    let sql = `
      select ${selects.join(', ')},
             sum(coalesce(t.qty_accepted, t.quantity))::int as qty,
             count(*)::int as txn
      from stock_transfer_log t
      left join commodities c on c.id = t.commodity_id
      where ${conds.join(' and ')}
      group by ${groupCols.join(', ')}`

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
  /**
   * Fill in a missing batch number / expiry date on the lots of one bin that match
   * `batch` ('' selects the unbatched lot; null matches every lot in the bin).
   *
   * Only ever FILLS: `coalesce` and the null/'' guards mean an existing value is
   * never overwritten. This runs on the dispatch path, where the operator is
   * correcting a gap that blocks the transfer — it must not become a way to silently
   * rewrite the expiry of stock that already had one.
   */
  static async fillLotGaps(exec, bin, batch, { expiry, batch: newBatch } = {}) {
    if (!expiry && !newBatch) return
    const params = [bin.facility_id, bin.commodity_id, bin.location_type, bin.site_name || null]
    const sets = []
    if (expiry)   { params.push(expiry);   sets.push(`expiry_date = coalesce(expiry_date, $${params.length}::date)`) }
    if (newBatch) { params.push(newBatch); sets.push(`batch_number = case when batch_number is null or btrim(batch_number) = '' then $${params.length} else batch_number end`) }

    let where = `facility_id=$1 and commodity_id=$2 and location_type=$3
                   and coalesce(site_name,'') = coalesce($4,'') and quantity > 0`
    if (batch !== null && batch !== undefined) {
      params.push(batch)
      where += ` and coalesce(batch_number,'') = coalesce($${params.length},'')`
    }
    await exec(`update stock_lot set ${sets.join(', ')}, updated_at = now() where ${where}`, params)
  }

  static async dispatch(transferId, data) {
    const { approved_by, carrier, expiry, batch, quantity, lots } = data
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

      // Draw the lots. If the caller supplied an explicit `lots` array (user-picked
      // batches and per-batch quantities), debit each batch exactly (enforced) and
      // fail the whole transaction if any batch is short. Otherwise fall back to
      // the existing FEFO debit.
      let drawn = []
      if (transfer.sending_facility_id) {
        const bin = { facility_id: transfer.sending_facility_id, commodity_id: transfer.commodity_id, location_type: 'store', site_name: null }
        if (Array.isArray(lots) && lots.length) {
          // Ensure caller-supplied lots sum to the dispatched qty.
          const total = lots.reduce((s, l) => s + (parseInt(l.quantity) || 0), 0)
          if (total !== qty) {
            const e = new Error(`Supplied lots total ${total} does not match requested quantity ${qty}`); e.status = 400; throw e
          }
          for (const l of lots) {
            const take = Math.round(l.quantity || 0)
            if (take <= 0) continue

            // Identify the picked lot by its CURRENT batch number. '' is meaningful
            // here — it selects the unbatched lot — whereas null means "no batch
            // constraint" and would draw FEFO across the whole bin. Only a genuinely
            // absent field may become null.
            let pickBatch = l.batch === undefined || l.batch === null ? null : String(l.batch)

            // Fill a gap the dispatcher supplied. Stock is required to carry a batch
            // and an expiry; when the picked lot is missing one, the form collects it
            // and it is written back to the ledger here, so the correction persists
            // instead of living only in this transfer's note.
            if (l.set_expiry || l.set_batch) {
              await this.fillLotGaps(exec, bin, pickBatch, { expiry: l.set_expiry, batch: l.set_batch })
              // The lot now answers to its new batch number, so debit by that.
              if (l.set_batch) pickBatch = String(l.set_batch)
            }

            // Debit exactly from the named batch; enforce=true makes this fail
            // when the chosen batch cannot cover the requested amount.
            const res = await LotService.debit(exec, bin, take, { batch: pickBatch, enforce: true })
            drawn = drawn.concat(res.drawn)
          }
        } else {
          ;({ drawn } = await LotService.debit(exec, { facility_id: transfer.sending_facility_id, commodity_id: transfer.commodity_id, location_type: 'store', site_name: null }, qty, { enforce: true }))
        }
      }
      // Batch and expiry for the paper-form note. The dispatch screen no longer has
      // inputs for either — the batch comes from the picker and the expiry from the
      // lot it belongs to — so when the caller omits them, derive them from the lots
      // actually drawn. Without this the FEFO path would record "[Expiry: ] [Batch: ]"
      // even though the exact lots are known here.
      //
      // Expiry is the EARLIEST across the drawn lots: the consignment as a whole is
      // only good until its soonest-expiring component.
      const drawnBatches = [...new Set(drawn.map(d => d.batch).filter(Boolean))]
      const drawnExpiry = drawn.map(d => d.expiry).filter(Boolean).sort()[0] || null

      // Every commodity is meant to carry an expiry date, so stock with none must not
      // move: dispatching it would put an undated consignment on the receiver's shelf
      // and record "[Expiry: ]" as the only trace. Refuse, and name the batch so the
      // lot can be corrected. Throwing inside withTransaction rolls back the stock
      // decrement and the lot debits, so a blocked dispatch changes nothing.
      //
      // Only when the caller supplied no expiry of its own — an explicit value from
      // some other caller is still honoured.
      if (!expiry) {
        const undated = drawn.filter(d => !d.expiry)
        if (undated.length) {
          // Name the batches when they have names. Falling back to a placeholder
          // produced "batch (no batch number) has no expiry date recorded", which
          // says batch twice and reads like a bug rather than an instruction.
          const names = [...new Set(undated.map(d => d.batch).filter(Boolean))]
          const e = new Error(
            (names.length
              ? `Cannot dispatch: batch ${names.join(', ')} has no expiry date recorded. `
              : 'Cannot dispatch: the stock drawn has no expiry date recorded. ') +
            'Record the expiry date against it, then dispatch.')
          e.status = 409
          throw e
        }
      }

      const metaBatch = batch || drawnBatches.join(', ') || ''
      // ymd, not the raw value: a date drawn from the lot ledger arrives as a
      // timestamp, so the note read "[Expiry: 2027-06-29T23:00:00.000Z]" where every
      // older record shows a plain date. It also read a day early — the timestamp is
      // UTC midnight, which is the previous evening in Lagos — so the note and the
      // lots stored alongside it disagreed by a day on the same consignment.
      const metaExpiry = ymd(expiry || drawnExpiry) || ''

      const meta = `[Approved by: ${approved_by || ''}] [Carrier: ${carrier || ''}] [Expiry: ${metaExpiry}] [Batch: ${metaBatch}]`
      const newNotes = transfer.notes ? `${transfer.notes} ${meta}` : meta
      const { rows } = await exec(
        `update stock_transfer_log set status = 'in_transit', quantity = $2, notes = $3, lots = $4
         where id = $1 returning *`,
        [transferId, qty, newNotes, JSON.stringify(drawn)]
      )
      return rows[0] || null
    })
  }

  /**
   * Admin assigns a source facility to a pending request (no stock movement).
   */
  /**
   * Assign ONE source facility to several pending requests at once.
   *
   * The admin's real workflow is "these twenty lab requests all come from the State
   * Office Store", not twenty passes through a single-row form. Quantities stay
   * per-request, because reviewing them is the part of the job that must not be lost
   * in a bulk action.
   *
   * ALL-OR-NOTHING. Each row is re-checked inside the transaction with FOR UPDATE and
   * must still be unassigned; if any has been taken by another admin, or cancelled by
   * the requester, since the list was loaded, nothing is written and the caller is told
   * which one. A half-assigned batch is the worst outcome here — the admin cannot tell
   * from the screen which of the twenty went through.
   *
   * Callers MUST have already checked write access per row (routes use mayWriteTransfer);
   * this only re-checks the state that can change underneath them.
   */
  static async assignSourceBulk({ items, sendingFacilityId, sendingFacilityName, reviewedBy }) {
    if (!Array.isArray(items) || items.length === 0) {
      const e = new Error('Select at least one request'); e.status = 400; throw e
    }
    if (!sendingFacilityId) {
      const e = new Error('sending_facility_id is required'); e.status = 400; throw e
    }
    const name = sendingFacilityName ?? (await this._facilityName(sendingFacilityId))

    return withTransaction(async exec => {
      const assigned = []
      for (const item of items) {
        const qty = parseInt(item.quantity)
        if (!(qty > 0)) {
          const e = new Error(`Quantity for request ${item.id} must be at least 1`); e.status = 400; throw e
        }
        // Locked so two admins cannot assign the same request to different sources.
        const { rows } = await exec(
          'select id, sending_facility_id, status, quantity, notes from stock_transfer_log where id = $1 for update',
          [item.id]
        )
        const row = rows[0]
        if (!row) { const e = new Error(`Request ${item.id} no longer exists`); e.status = 409; throw e }
        if (row.sending_facility_id) {
          const e = new Error('One of the selected requests has already been assigned to a source — refresh and try again')
          e.status = 409; throw e
        }
        if (row.status !== 'pending') {
          const e = new Error(`One of the selected requests is no longer pending (it is ${row.status}) — refresh and try again`)
          e.status = 409; throw e
        }

        const note = `[Reviewed by: ${reviewedBy || ''}]`
        const newNotes = row.notes ? `${row.notes} ${note}` : note
        const { rows: upd } = await exec(
          `update stock_transfer_log
              set sending_facility_id = $2, sending_facility_name = $3, quantity = $4, notes = $5
            where id = $1 returning *`,
          [item.id, sendingFacilityId, name || '', qty, newNotes]
        )
        assigned.push(upd[0])
      }
      return assigned
    })
  }

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
      // Claim the transfer FIRST, and only credit if this call is the one that moved
      // it off its previous status. Crediting first and setting the status after made
      // accept non-idempotent: a second call — a retried request, an impatient second
      // click — credited the stock and the lots again while the status update was a
      // harmless no-op, so nothing looked wrong afterwards. The receiver's stock ended
      // at exactly double the amount received, with the lot ledger doubled to match,
      // which is why the two agreed with each other and disagreed with the records
      // (Ikpe Annang: one accepted transfer of 15, stock 30, records 15).
      //
      // `and status <> 'accepted'` makes the claim atomic: concurrent calls contend on
      // the same row, and only one gets a row back.
      const { rows } = await exec(
        `update stock_transfer_log set status = 'accepted', resolved_at = now(), resolved_by = $2
         where id = $1 and status <> 'accepted' returning *`,
        [transferId, received_by]
      )
      if (!rows[0]) return transfer      // already accepted — credit nothing, report the existing row

      await this._creditStock(exec, transfer.receiving_facility_id, transfer.commodity_id, transfer.quantity, 'store', transfer.section)
      // Credit the receiver's store lots with exactly the batch/expiry lots the
      // sender dispatched (fall back to the transfer's recorded batch/expiry, then
      // to a single unknown lot, so the totals always reconcile).
      await this._creditLotsFromTransfer(exec, transfer,
        { facility_id: transfer.receiving_facility_id, commodity_id: transfer.commodity_id, location_type: 'store', site_name: null },
        transfer.quantity)

      return rows[0]
    })
  }

  // Credit `bin` with the lots a transfer carried (transfer.lots). Falls back to
  // the batch/expiry recorded in the transfer notes, then to a single unknown lot,
  // so the credited units always equal `qty` and the invariant holds.
  static async _creditLotsFromTransfer(exec, transfer, bin, qty) {
    let lots = Array.isArray(transfer.lots) ? transfer.lots : null
    if (!lots || !lots.length) {
      const batch = this._rxNote(transfer.notes, 'Batch')
      const expiry = this._rxNote(transfer.notes, 'Expiry')
      lots = [{ batch: batch || null, expiry: expiry || null, qty }]
    }
    await LotService.creditMany(exec, bin, lots, transfer.section)
  }

  static _rxNote(notes, tag) {
    return new RegExp(`\\[${tag}:\\s*([^\\]]+)\\]`, 'i').exec(notes || '')?.[1]?.trim() || null
  }

  /**
   * Receiver disputes an in-transit transfer. A dispute is TERMINAL — there is no
   * "restore" step and the requesting facility raises a fresh request for
   * anything it still needs.
   *
   * A dispute may be PARTIAL, in which case it splits into two rows, because the
   * two halves are genuinely different events:
   *   - what the receiver kept  → the original row, status 'accepted', quantity
   *     cut to that amount. A real handover: it lands in the receiver's stock,
   *     their bin card and the printable Transfer & Return form.
   *   - what was sent back      → a new row, status 'disputed', quantity =
   *     returned. Never counted as stock that reached the receiver, and not
   *     printable, because no handover happened for it.
   * Rejecting everything (accepted = 0) leaves the single original row disputed.
   *
   * Nothing is ever flipped to 'accepted' without the stock to match: that used
   * to make a failed delivery render as a completed stock-in for the receiver,
   * contradicting their actual stock.
   *
   * Optional facilityId guard: the disputing party is either the receiving
   * facility (external transfer) or the sending facility (a DSD/SDP site
   * disputing its parent store's dispatch, where receiving_facility_id is null).
   */
  static async dispute(transferId, data) {
    const { disputed_by, facilityId, dispute_note, qty_accepted, received_by } = data
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
      const note = dispute_note || 'Disputed by receiver'
      // Stock only moves back if it had actually left the sender's store: a
      // dispatch decrements it, a still-pending request never did.
      const moved = ['in_transit', 'dispatched'].includes(prev.status)
      // The lots drawn at dispatch travel on the transfer; split them the same way
      // as the quantity so the accepted lots reach the destination and the returned
      // lots go back to the sender — batch/expiry intact on both sides.
      const dispatchedLots = (Array.isArray(prev.lots) && prev.lots.length)
        ? prev.lots
        : [{ batch: this._rxNote(prev.notes, 'Batch'), expiry: this._rxNote(prev.notes, 'Expiry'), qty: dispatched }]
      const { kept: keptLots, rest: returnedLots } = splitLots(dispatchedLots, accepted)

      let result
      if (accepted > 0) {
        // What the receiver kept is a genuine handover, so it must end up as a
        // real 'accepted' row: the bin card and the activity log only count
        // status='accepted' (and read `quantity`), so leaving the whole thing
        // 'disputed' would credit the receiver's stock while their bin card
        // showed nothing. The original row becomes that accepted record, cut
        // down to the kept quantity, and stays printable.
        const { rows } = await exec(
          `update stock_transfer_log
              set status = 'accepted', quantity = $2, resolved_at = now(), resolved_by = $3,
                  dispute_note = $4, qty_accepted = $2, qty_returned = $5
            where id = $1 returning *`,
          [transferId, accepted, received_by || disputed_by || null, note, returned]
        )
        result = rows[0]
        if (moved) await this._creditDestination(exec, prev, accepted, keptLots)

        // The rejected remainder becomes its own terminal 'disputed' row: it
        // never counts as stock that reached the receiver, and it is not
        // printable — nothing was handed over for it.
        if (returned > 0) {
          await exec(
            `insert into stock_transfer_log
               (sending_facility_id, sending_facility_name, receiving_facility_id, receiving_facility_name,
                commodity_id, commodity_name, quantity, qty_requested, status, initiated_by, initiated_at,
                resolved_at, resolved_by, dispute_note, notes, section, qty_accepted, qty_returned)
             values ($1,$2,$3,$4,$5,$6,$7,$7,'disputed',$8,$9, now(), $10, $11, $12, $13, 0, $7)`,
            [prev.sending_facility_id, prev.sending_facility_name, prev.receiving_facility_id,
             prev.receiving_facility_name, prev.commodity_id, prev.commodity_name, returned,
             prev.initiated_by, prev.initiated_at, disputed_by || null, note, prev.notes, prev.section]
          )
        }
      } else {
        // Nothing kept — the whole dispatch is disputed, one terminal row.
        const { rows } = await exec(
          `update stock_transfer_log
              set status = 'disputed', resolved_at = now(), resolved_by = $2, dispute_note = $3,
                  qty_accepted = 0, qty_returned = $4
            where id = $1 returning *`,
          [transferId, disputed_by || null, note, returned]
        )
        result = rows[0]
      }

      if (moved && returned > 0 && prev.sending_facility_id) {
        await this._creditStock(exec, prev.sending_facility_id, prev.commodity_id, returned, 'store', prev.section)
        await LotService.creditMany(exec,
          { facility_id: prev.sending_facility_id, commodity_id: prev.commodity_id, location_type: 'store', site_name: null },
          returnedLots, prev.section)
      }
      return result || null
    })
  }

  /**
   * Credit `qty` to wherever a transfer was headed: a DSD/SDP site's own stock
   * table for a site dispatch (receiving_facility_id is null there, the site
   * lives in the notes tag), otherwise the receiving facility's store.
   */
  static async _creditDestination(exec, transfer, qty, lots = null) {
    if (!qty || qty <= 0) return
    const isDsd = /\[DSD:/i.test(transfer.notes || '')
    const isSdp = /\[SDP:/i.test(transfer.notes || '')
    if (!isDsd && !isSdp) {
      // Throw rather than return: rolling the transaction back is far better
      // than silently dropping the quantity the receiver said they kept.
      if (!transfer.receiving_facility_id) throw new Error('Transfer has no destination facility to credit')
      await this._creditStock(exec, transfer.receiving_facility_id, transfer.commodity_id, qty, 'store', transfer.section)
      if (lots) await LotService.creditMany(exec,
        { facility_id: transfer.receiving_facility_id, commodity_id: transfer.commodity_id, location_type: 'store', site_name: null }, lots, transfer.section)
      return
    }
    const fid = transfer.sending_facility_id
    const site = this._siteFromNotes(transfer.notes) || transfer.receiving_facility_name
    if (!fid || !site) throw new Error('Could not resolve the destination site name')
    if (lots) await LotService.creditMany(exec,
      { facility_id: fid, commodity_id: transfer.commodity_id, location_type: isDsd ? 'dsd' : 'sdp', site_name: site }, lots, transfer.section)
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
    const { approved_by, quantity, batch_number, lots } = data
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
      // Move the same qty store→dispensary on the lot ledger, so the dispensary
      // inherits the store's batch/expiry. The store manager may name the batch
      // they are issuing; without one it draws FEFO. Enforced either way, so an
      // expired or short batch is refused rather than silently spilling.
      const from = { facility_id: fid, commodity_id: transfer.commodity_id, location_type: 'store', site_name: null }
      const to   = { facility_id: fid, commodity_id: transfer.commodity_id, location_type: 'dispensary', site_name: null }
      const picks = Array.isArray(lots) ? lots.filter(l => parseInt(l?.quantity) > 0) : null
      if (picks && picks.length) {
        // Multi-batch issue, mirroring dispatch: the store manager splits the issue
        // across several lots. Totals must match exactly, or the dispensary would be
        // credited a different amount than the store was debited.
        const total = picks.reduce((s2, l) => s2 + parseInt(l.quantity), 0)
        if (total !== qty) {
          const e = new Error(`Supplied batches total ${total} but ${qty} is being issued`); e.status = 400; throw e
        }
        for (const l of picks) {
          // batch '' names the UNBATCHED lot; null/undefined would mean FEFO.
          await LotService.move(exec, from, to, parseInt(l.quantity),
            { batch: l.batch == null ? null : l.batch, enforce: true }, transfer.section)
        }
      } else {
        await LotService.move(exec, from, to, qty,
          { batch: batch_number == null ? null : batch_number, enforce: true }, transfer.section)
      }

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
    const { approved_by, quantity, batch_number, lots } = data
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
      // Draw the lots from the store now; the site is credited with them when the
      // site user confirms receipt (receive()). The store manager may name the
      // batch being issued; without one it draws FEFO. Enforced either way.
      const from = { facility_id: fid, commodity_id: transfer.commodity_id, location_type: 'store', site_name: null }
      const picks = Array.isArray(lots) ? lots.filter(l => parseInt(l?.quantity) > 0) : null
      let drawn = []
      if (picks && picks.length) {
        // Multi-batch issue, mirroring dispatch and approveInternal. Totals must
        // match exactly or the site would be credited a different amount on receipt
        // than the store was debited here.
        const total = picks.reduce((s2, l) => s2 + parseInt(l.quantity), 0)
        if (total !== qty) {
          const e = new Error(`Supplied batches total ${total} but ${qty} is being issued`); e.status = 400; throw e
        }
        for (const l of picks) {
          // batch '' names the UNBATCHED lot; null/undefined would mean FEFO.
          const res = await LotService.debit(exec, from, parseInt(l.quantity),
            { batch: l.batch == null ? null : l.batch, enforce: true })
          drawn = drawn.concat(res.drawn)
        }
      } else {
        ;({ drawn } = await LotService.debit(exec, from, qty,
          { batch: batch_number == null ? null : batch_number, enforce: true }))
      }

      const { rows } = await exec(
        `update stock_transfer_log set status = 'dispatched', quantity = $2, resolved_by = $3, lots = $4
         where id = $1 returning *`,
        [transferId, qty, `[Approved: ${approved_by || ''}]`, JSON.stringify(drawn)]
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
      // Claim first, credit second — same reason as accept() above. Receiving twice
      // used to add the quantity to the site bin twice.
      const resolvedBy = `${transfer.resolved_by || ''} [Received by: ${received_by || ''}]`.trim()
      const { rows } = await exec(
        `update stock_transfer_log set status = 'accepted', resolved_at = now(), resolved_by = $2
         where id = $1 and status <> 'accepted' returning *`,
        [transferId, resolvedBy]
      )
      if (!rows[0]) return transfer      // already received — credit nothing

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
      // Credit the site's lot ledger with the lots drawn from the store at approve.
      await this._creditLotsFromTransfer(exec, transfer,
        { facility_id: fid, commodity_id: transfer.commodity_id, location_type: isDsd ? 'dsd' : 'sdp', site_name: site }, qty)

      return rows[0]
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
