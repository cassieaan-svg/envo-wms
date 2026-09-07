import { query, withTransaction } from '../db.js'
import { StockService } from './stockService.js'
import { LotService, ymd } from './lotService.js'
import { sectionFilterSql } from '../constants/sections.js'

// Nested commodity object matching the frontend's `commodities(id,name,category,unit)`
// embedded select, rebuilt with json_build_object (PostgREST replacement).
const COMM4_OBJ = `
  json_build_object('id', c.id, 'name', c.name, 'category', c.category, 'unit', c.unit) as commodities`

// Nested facility object — reports/admin views read row.facilities?.name/.lga.
const FAC_OBJ = `
  json_build_object('id', f.id, 'name', f.name, 'lga', f.lga, 'state', f.state) as facilities`

// Inclusive day bounds for a YYYY-MM-DD date filter (mirrors the old gte/lte).
function dayBounds(date) {
  return [`${date}T00:00:00`, `${date}T23:59:59`]
}

// Category → section map (mirrors the frontend's SECTION_CATEGORIES). The section
// is deterministically implied by the commodity, so we enforce it server-side:
// if a caller omits `section` on a log write, derive it from the commodity's
// category. This guarantees every log row is section-tagged regardless of which
// page recorded it — a store manager's section-filtered Activity Log then never
// silently drops site (SDP/DSD) records that forgot to pass section.
const SECTION_BY_CATEGORY = {
  'Pharmacy drugs': 'pharmacy',
  'Medical supplies': 'pharmacy',
  'RTKs': 'lab',
  'Lab reagents': 'lab',
  'Lab consumables': 'lab',
}

// Resolve a log row's section: use the caller-provided value, else derive it from
// the commodity's category. Runs inside the caller's transaction (exec). Returns
// null only when neither is available (unmapped/blank category).
async function resolveSection(section, commodityId, exec) {
  if (section) return section
  const { rows } = await exec('select category from commodities where id = $1', [commodityId])
  return SECTION_BY_CATEGORY[rows[0]?.category] || null
}

// Enforcement switch for the bin-stock precondition below. OFF by default, and
// deliberately opt-in (=== 'true'), so deploying the Stock Count work cannot start
// refusing consumption as a side effect.
//
// Rollout: a bin whose stock on hand is wrong will refuse consumption once this is
// on — correct behaviour, but it surfaces as "the app won't let me record" at every
// facility whose figures have drifted (57 bins across 48 facilities at last audit).
// Turn it on once those bins have been physically counted through the Stock Count
// screen. Read per call, so flipping it needs a restart but no code change.
const enforceBinStock = () => process.env.ENFORCE_BIN_STOCK === 'true'

// Guard a consumption against the bin's actual stock on hand BEFORE any row is
// written. Returns true when the bin covers the draw (or nothing is being drawn),
// false when it does not and enforcement is off. Throws 409 when it does not and
// enforcement is on — inside the caller's transaction, so a refused consumption
// rolls back and leaves no dispense_log row behind.
//
// This is the invariant the bin card depends on: a bin's stock on hand must always
// equal the sum of its recorded movements. Allowing an overdraft (by clamping the
// decrement at 0) breaks it — the movement is recorded but the stock never moved,
// and the difference reappears as a phantom opening balance. qty 0 is a legitimate
// "nothing consumed today" record and is always allowed.
async function assertBinCovers(exec, soh, qty, commodityId, binLabel) {
  if (qty <= 0 || soh >= qty) return true
  const name = (await exec('select name from commodities where id = $1', [commodityId])).rows[0]?.name || 'this commodity'
  const msg = `Cannot record ${qty} consumed: ${binLabel} holds only ${soh} of ${name}. ` +
    `Record the stock movement into ${binLabel} first (intake or redistribution), then record the consumption.`
  if (!enforceBinStock()) {
    // Log it so the overdrafts are measurable during the transition, then fall
    // through to the old clamped decrement rather than blocking the user.
    console.warn(`[bin-stock] overdraft ALLOWED (ENFORCE_BIN_STOCK is off): ${msg}`)
    return false
  }
  const e = new Error(msg)
  e.status = 409
  throw e
}

// Reasons whose whole value is the explanation. A count correction with no note is
// an unexplained change to stock — exactly the record that made the production data
// unauditable, where one label hid mis-entries, real losses and stock moved to
// another facility alike.
// 'Lost / Stolen' is here because the label alone says nothing actionable — where
// it went, whether it was reported, who investigated. Expired and Damaged are
// self-describing, so they stay optional.
export const REASONS_REQUIRING_NOTES = new Set(['Physical count correction', 'Lost / Stolen', 'Other'])

// Reasons that must name the exact lot being adjusted. Without one, a Decrease
// debits the lot ledger FEFO (soonest expiry first) — a sensible default for a
// generic removal, but wrong for a write-off: "Expired" is a claim about ONE
// specific lot, and letting the ledger choose can retire a different batch than the
// one physically discarded. The stock total stays correct either way; the lot the
// expiry reports are built from does not.
//
// NAMING A LOT IS NOT THE SAME AS HAVING A BATCH NUMBER. Some stock was received
// without one (188 on-hand lots at the time of writing), and it appears in the
// picker as "(no batch)". Demanding a non-empty string would make that stock
// impossible to write off once it expires — it would sit on the expiry report
// forever with no legal way to clear it. So the three values are distinguished:
//
//   'ABC123'  → that batch
//   ''        → the unbatched lot, a deliberate and valid pick, allowed only when
//               the bin actually holds one (otherwise it is just an omission)
//   null/absent → no lot named at all; refused for these reasons
export const REASONS_REQUIRING_BATCH = new Set(['Expired'])

// Does this bin hold stock with no batch number? Decides whether an empty batch is
// a real "(no batch)" selection or a caller that simply left the field out.
async function binHasUnbatchedLot(exec, bin) {
  const { rows } = await exec(
    `select 1 from stock_lot
      where facility_id=$1 and commodity_id=$2 and location_type=$3
        and coalesce(site_name,'') = coalesce($4,'')
        and quantity > 0 and coalesce(trim(batch_number),'') = ''
      limit 1`,
    [bin.facility_id, bin.commodity_id, bin.location_type, bin.site_name || null]
  )
  return rows.length > 0
}

// The bin an edited log row accounts for. dispense_log has no bin column — the
// site is carried in the notes tag, exactly as the bin card reads it, and an
// untagged dispense belongs to the dispensary. Adjustments carry the bin explicitly
// (rows written before that column existed default to the store, which is what they
// were). Intakes are always the store.
function editBin(type, row) {
  const base = { facility_id: row.facility_id, commodity_id: row.commodity_id }
  if (type === 'intake') return { ...base, location_type: 'store', site_name: null }
  if (type === 'adjustment') return { ...base, location_type: row.location_type || 'store', site_name: row.site_name || null }
  const notes = row.notes || ''
  const dsd = /\[DSD:\s*([^\]]+)\]/i.exec(notes)?.[1]?.trim()
  const sdp = /\[SDP:\s*([^\]]+)\]/i.exec(notes)?.[1]?.trim()
  if (dsd) return { ...base, location_type: 'dsd', site_name: dsd }
  if (sdp) return { ...base, location_type: 'sdp', site_name: sdp }
  return { ...base, location_type: 'dispensary', site_name: null }
}

// Human label for a bin, for error messages.
const binLabel = ({ location_type, site_name }) =>
  location_type === 'store' ? 'the main store'
  : location_type === 'dispensary' ? 'the dispensary'
  : `${location_type.toUpperCase()} site "${site_name}"`

// Stock on hand for any bin, whichever of the three tables backs it.
async function binSoh(exec, { facility_id, commodity_id, location_type, site_name }) {
  if (location_type === 'dsd' || location_type === 'sdp') {
    const tbl = location_type === 'dsd' ? 'dsd_stock' : 'sdp_stock'
    const col = location_type === 'dsd' ? 'dsd_site_name' : 'sdp_name'
    const { rows } = await exec(
      `select quantity from ${tbl} where facility_id=$1 and commodity_id=$2
        and lower(btrim(${col}))=lower(btrim($3)) limit 1`, [facility_id, commodity_id, site_name])
    return rows[0]?.quantity ?? 0
  }
  const { rows } = await exec(
    `select quantity from stock where facility_id=$1 and commodity_id=$2 and location_type=$3 limit 1`,
    [facility_id, commodity_id, location_type])
  return rows[0]?.quantity ?? 0
}

// Set a bin to an absolute figure (upsert), for any bin type.
async function setBinSoh(exec, { facility_id, commodity_id, location_type, site_name }, qty) {
  if (location_type === 'dsd' || location_type === 'sdp') {
    const tbl = location_type === 'dsd' ? 'dsd_stock' : 'sdp_stock'
    const col = location_type === 'dsd' ? 'dsd_site_name' : 'sdp_name'
    await exec(
      `insert into ${tbl} (facility_id, ${col}, commodity_id, quantity) values ($1,$2,$3,$4)
       on conflict (facility_id, ${col}, commodity_id) do update set quantity=$4, updated_at=now()`,
      [facility_id, site_name, commodity_id, qty])
    return
  }
  await exec(
    `insert into stock (facility_id, commodity_id, location_type, quantity) values ($1,$2,$3,$4)
     on conflict (facility_id, commodity_id, location_type) do update set quantity=$4, updated_at=now()`,
    [facility_id, commodity_id, location_type, qty])
}

// Overdraft guard for a Decrease adjustment — the same rule as consumption, and the
// one that would have stopped Apapa's repeated count corrections. Returns whether
// the bin covers the draw; throws 409 only when enforcement is on.
async function assertBinCoversAdj(exec, soh, qty, commodityId, label) {
  if (qty <= 0 || soh >= qty) return true
  const name = (await exec('select name from commodities where id = $1', [commodityId])).rows[0]?.name || 'this commodity'
  const msg = `Cannot remove ${qty}: ${label} holds only ${soh} of ${name}. ` +
    `Check whether this correction has already been entered.`
  if (!enforceBinStock()) { console.warn(`[bin-stock] adjustment overdraft ALLOWED (ENFORCE_BIN_STOCK is off): ${msg}`); return false }
  const e = new Error(msg)
  e.status = 409
  throw e
}

// Shared facility/commodity/date-range/section filters for the log history
// queries. Mutates `conds`/`params` in place (params is 1-based for $n). Covers
// both the per-facility per-day "recent entries" view and the multi-facility
// date-range report aggregation.
//   facilityId  — single facility (when the route pinned one)
//   facilityIds — array of facilities (scoped/admin multi-facility); [] = none
//   commodityIds, section, date (single day), from/to (range on dateField)
function applyLogFilters({ conds, params, dateField, facilityId, facilityIds, commodityIds, categories, commodityNames, date, from, to, section }) {
  if (facilityId) { params.push(facilityId); conds.push(`l.facility_id = $${params.length}`) }
  else if (Array.isArray(facilityIds)) { params.push(facilityIds); conds.push(`l.facility_id = any($${params.length})`) }

  if (Array.isArray(commodityIds) && commodityIds.length) { params.push(commodityIds); conds.push(`l.commodity_id = any($${params.length})`) }
  // Section enforcement (server-side): restrict to the caller's commodity categories,
  // joined via commodities c. Robust even where the denormalized l.section is null.
  // Also admits any commodity individually granted to the caller's facility.
  { const secCond = sectionFilterSql('c', categories, commodityNames, params); if (secCond) conds.push(secCond) }
  if (section) { params.push(section); conds.push(`l.section = $${params.length}`) }

  if (date) {
    const [start, end] = dayBounds(date)
    params.push(start, end); conds.push(`l.${dateField} >= $${params.length - 1} and l.${dateField} <= $${params.length}`)
  } else {
    if (from) { params.push(from); conds.push(`l.${dateField} >= $${params.length}`) }
    if (to)   { params.push(to);   conds.push(`l.${dateField} <= $${params.length}`) }
  }
}

// The COMPLETE set of groupings GET /api/dispense/summary will serve — an explicit
// allowlist, not a generic GROUP BY. Every entry exists because a specific view
// needs it, and nothing else is accepted: an arbitrary group_by would put column
// names from the query string into SQL and would let a caller mint expensive
// aggregates we have never measured.
//
//   commodity,month   the original AMC shape (dashboards) — unchanged default
//   commodity         Monitoring: top-commodities table, donut, "commodities consumed"
//   facility          Monitoring: the LGA / facility breakdown (LGA derived client-side)
//   day               Monitoring: the daily trend chart
//   commodity,facility  Monitoring drill: one commodity across facilities
//   commodity,day       Monitoring drill: one commodity's daily series
//
// NOTE on day bucketing: the caller passes the timezone. Monitoring's two charts
// disagree today — the section chart buckets by BROWSER-LOCAL date (localDay), the
// per-commodity chart by UTC (dispensed_at.slice(0,10)). This release preserves
// both exactly rather than changing figures during a performance migration;
// standardising them on Africa/Lagos is a separate follow-up.
const DISPENSE_GROUP_BY = {
  'commodity,month':    { dimensions: ['commodity'], month: true },
  'commodity':          { dimensions: ['commodity'] },
  'facility':           { dimensions: ['facility'] },
  'day':                { dimensions: ['day'], needsDay: true },
  'commodity,facility': { dimensions: ['commodity', 'facility'] },
  'commodity,day':      { dimensions: ['commodity', 'day'], needsDay: true },
  // Interim ("weekly") AMC: every record the app holds for a commodity, plus the
  // date of its FIRST one, so the caller can divide by the weeks that commodity
  // has actually been recorded rather than by a fixed window. The standard AMC
  // averages the two completed months before the current quarter, which leaves
  // anything newer than that quarter with no AMC at all — measured at 48 of 68
  // consuming commodities and 2,663 (facility, commodity) pairs.
  'commodity,lifetime': { dimensions: ['commodity'], lifetime: true },
}

// Records outside this range are excluded from the lifetime aggregate. Not
// hypothetical: dispense_log holds 2 rows dated before 2024 and 11 dated in the
// future, and a single stray early date would otherwise stretch one commodity's
// week span to centuries and drive its AMC to ~0 — silently hiding a stockout.
const LIFETIME_FLOOR = '2024-01-01'

export const DISPENSE_GROUP_BY_KEYS = Object.keys(DISPENSE_GROUP_BY)

// Intake serves the same groupings MINUS the AMC-only ones. 'commodity,month' and
// 'commodity,lifetime' exist to feed average-monthly-consumption; an AMC computed
// from receipts would be meaningless, so they are not offered rather than being
// offered and misused.
export const INTAKE_GROUP_BY_KEYS = DISPENSE_GROUP_BY_KEYS
  .filter(k => !['commodity,month', 'commodity,lifetime'].includes(k))

// Adjustments carry two dimensions the movement logs don't: `adjustment_type`
// (Increase / Decrease) and a free-text `reason`. Every grouping pairs with `type`
// because a positive and a negative adjustment are different events with different
// reasons — netting them, or pooling their reasons, would hide a facility that
// added 5,000 and removed 5,000 on the same commodity.
const ADJUSTMENT_GROUP_BY = {
  'commodity,type': { dimensions: ['commodity', 'type'] },
  'facility,type':  { dimensions: ['facility', 'type'] },
  'day,type':       { dimensions: ['day', 'type'], needsDay: true },
  'reason,type':    { dimensions: ['reason', 'type'] },
  'commodity':      { dimensions: ['commodity'] },
  'facility':       { dimensions: ['facility'] },
}
export const ADJUSTMENT_GROUP_BY_KEYS = Object.keys(ADJUSTMENT_GROUP_BY)

// SQL for each group dimension. Only 'commodity' and 'facility' are ids; 'reason'
// and 'type' are plain text columns, and a blank reason is bucketed explicitly
// rather than becoming a null the caller has to guess at.
const DIMENSION_SQL = {
  commodity: { sql: 'l.commodity_id',      alias: 'commodity_id' },
  facility:  { sql: 'l.facility_id',       alias: 'facility_id' },
  type:      { sql: 'l.adjustment_type',   alias: 'type' },
  reason:    { sql: `coalesce(nullif(trim(l.reason), ''), '(not stated)')`, alias: 'reason' },
}

/**
 * Shared builder behind getDispenseSummary / getIntakeSummary. The two logs differ
 * only in table name and date column — everything else (the group_by allowlist, the
 * scope/section filters, drill-in narrowing, tz day bucketing, the { qty, txn } row
 * shape) is identical, so it lives here once. Keeping them on one code path is what
 * guarantees a "received" figure is scoped and section-filtered exactly like the
 * "consumed" figure it sits beside on the dashboard.
 */
async function logSummary({ table, dateField, specs = DISPENSE_GROUP_BY }, facilityId, options = {}) {
  const {
    from, to, facilityIds, commodityIds, categories, commodityNames, section,
    groupBy = 'commodity,month', commodityId = null, category = null, tz = null,
    adjustmentType = null, reason = null, supplier = null,
  } = options
  if (!facilityId && Array.isArray(facilityIds) && facilityIds.length === 0) return []

  const spec = specs[groupBy]
  if (!spec) throw new Error(`Unsupported group_by: ${groupBy}`)

  const params = []
  const conds = []
  applyLogFilters({ conds, params, dateField, facilityId, facilityIds, commodityIds, categories, commodityNames, from, to, section })

  // Drill-in narrowing: ONE commodity, or ONE category. These are additional
  // filters on top of the caller's scope — they can only narrow it, never widen
  // it (the section `categories` condition above still applies independently).
  if (commodityId) { params.push(commodityId); conds.push(`l.commodity_id = $${params.length}`) }
  if (category) { params.push(category); conds.push(`c.category = $${params.length}`) }

  // Join commodities only when something actually needs it.
  const needCommJoin = (Array.isArray(categories) && categories.length) || !!category

  // Day bucketing happens in a caller-supplied timezone. The date column is
  // timestamptz, so `at time zone $n` yields that zone's wall-clock date. The
  // caller decides the zone precisely because the two Monitoring charts
  // currently disagree (see the note on DISPENSE_GROUP_BY); passing it in
  // reproduces each one exactly instead of silently picking a winner.
  let dayExpr = null
  if (spec.needsDay) {
    if (tz) { params.push(tz); dayExpr = `to_char(l.${dateField} at time zone $${params.length}, 'YYYY-MM-DD')` }
    else dayExpr = `to_char(l.${dateField} at time zone 'UTC', 'YYYY-MM-DD')`
  }

  // Narrow to one adjustment direction (Increase / Decrease) when asked.
  if (adjustmentType) { params.push(adjustmentType); conds.push(`l.adjustment_type = $${params.length}`) }
  // Narrow to ONE reason. Matched against the same normalised expression the
  // `reason` dimension groups by, so the '(not stated)' bucket the UI shows can be
  // drilled into like any other rather than being a label with nothing behind it.
  if (reason) {
    params.push(reason)
    conds.push(`coalesce(nullif(trim(l.reason), ''), '(not stated)') = $${params.length}`)
  }
  // Supplier split — intake only (dispense/adjustment have no supplier_source). Matches
  // the CRRF's Received rule: GHSC-PSM is the real programme delivery, everything else
  // ('other') is any non-GHSC source, baseline included. Free text, so matched not compared.
  if (supplier && table === 'intake_log') {
    if (supplier === 'ghsc')       conds.push(`l.supplier_source ~* 'ghsc|psm'`)
    else if (supplier === 'other') conds.push(`(l.supplier_source is null or l.supplier_source !~* 'ghsc|psm')`)
  }

  const dimSql = d => DIMENSION_SQL[d]?.sql ?? `l.${d}_id`
  const dimAlias = d => DIMENSION_SQL[d]?.alias ?? `${d}_id`
  const selects = spec.dimensions.map(d => (d === 'day' ? `${dayExpr} as day` : `${dimSql(d)} as ${dimAlias(d)}`))
  if (spec.month) selects.push(`to_char(l.${dateField} at time zone 'UTC', 'YYYY-MM') as ym`)
  const groupCols = spec.dimensions.map(d => (d === 'day' ? 'day' : dimSql(d)))
  if (spec.month) groupCols.push('ym')

  // Lifetime: the caller needs the first record's date to know how many weeks
  // this commodity has actually been recorded for. Bound the range so one stray
  // mistyped year can't define the span — a single 2029 row would otherwise
  // stretch it and drive the AMC toward zero, hiding a stockout.
  const aggregates = ['sum(l.quantity)::int as qty', 'count(*)::int as txn']
  if (spec.lifetime) {
    aggregates.push(`min(l.${dateField}) as first_at`, `max(l.${dateField}) as last_at`)
    conds.push(`l.${dateField} >= '${LIFETIME_FLOOR}'::timestamptz`, `l.${dateField} <= now()`)
  }

  let sql = `
      select ${selects.join(', ')},
             ${aggregates.join(',\n             ')}
      from ${table} l
      ${needCommJoin ? 'left join commodities c on c.id = l.commodity_id' : ''}`
  if (conds.length) sql += ` where ${conds.join(' and ')}`
  sql += ` group by ${groupCols.join(', ')}`

  const { rows } = await query(sql, params)
  return rows
}

// Log-edit support (EditModal). Maps the frontend's record _type to its table and
// the metadata columns that edit is allowed to change. Stock reconciliation is NOT
// done here — the client adjusts stock separately (matching the original flow).
const LOG_TABLES = { dispense: 'dispense_log', intake: 'intake_log', adjustment: 'stock_adjustment_log' }
const LOG_EDIT_FIELDS = {
  dispense:   ['quantity', 'dispensed_at', 'notes', 'edited_by'],
  intake:     ['quantity', 'batch_number', 'expiry_date', 'supplier_source', 'condition_on_arrival', 'edited_by'],
  adjustment: ['quantity', 'reason', 'notes', 'batch_number', 'expiry_date', 'edited_by'],
}

export class LogService {
  /** Fetch one log row by type + id (for edit scoping/existence). Null if absent. */
  static async getLogRow(type, id) {
    const table = LOG_TABLES[type]
    if (!table) throw new Error(`Unknown log type: ${type}`)
    const { rows } = await query(`select * from ${table} where id = $1`, [id])
    return rows[0] || null
  }

  /**
   * Update a log row's whitelisted fields, and — for records that credited a
   * specific STORE lot (an intake or an Increase adjustment) — mirror any
   * batch/expiry/quantity change onto the lot ledger so the Monitoring expiry
   * view stays in step. Dispense and Decrease adjustments debit FEFO and carry no
   * lot identity, so their edits stay metadata-only. Runs in one transaction.
   */
  static async updateLog(type, id, fields = {}) {
    const table = LOG_TABLES[type]
    const allowed = LOG_EDIT_FIELDS[type]
    if (!table) throw new Error(`Unknown log type: ${type}`)

    const old = await this.getLogRow(type, id)
    if (!old) return null

    // An edit can change `reason` and `batch_number` independently, so the rule is
    // checked against the row as it WILL be — not as it was. Otherwise a write-off
    // could be relabelled "Expired" after the fact, or have its batch cleared, and
    // skip the check that the create path enforces.
    if (type === 'adjustment') {
      const nextReason = fields.reason !== undefined ? fields.reason : old.reason
      const nextBatch  = fields.batch_number !== undefined ? fields.batch_number : old.batch_number
      const blank = v => !String(v || '').trim()
      // Grandfathered: a row recorded before this rule that ALREADY had no batch is
      // left editable, so long as the edit doesn't touch reason or batch. Blocking it
      // would strand old records — someone fixing a quantity typo on a months-old
      // write-off cannot produce a batch number nobody wrote down.
      const alreadyBlank = blank(old.batch_number) && REASONS_REQUIRING_BATCH.has(old.reason)
      const untouched = fields.reason === undefined && fields.batch_number === undefined
      if (REASONS_REQUIRING_BATCH.has(nextReason) && blank(nextBatch) && !(alreadyBlank && untouched)) {
        const e = new Error(`Batch number is required for "${nextReason}" — name the exact lot being written off, so the right one leaves the expiry report.`)
        e.status = 400
        throw e
      }
    }

    const sets = []
    const params = [id]
    for (const k of allowed) {
      if (fields[k] !== undefined) {
        params.push(k === 'quantity' ? parseInt(fields[k]) : fields[k])
        sets.push(`${k} = $${params.length}`)
      }
    }
    if (!sets.length) throw new Error('No updatable fields provided')

    return await withTransaction(async exec => {
      const { rows } = await exec(`update ${table} set ${sets.join(', ')} where id = $1 returning *`, params)
      const updated = rows[0] || null

      // Move the stock the edited record accounts for, in the SAME transaction.
      //
      // This used to be the client's job (EditModal -> api.stock.update), which wrote
      // the stock figure directly with no movement attached and in a separate request.
      // If that second call clamped at zero, matched the wrong row, or simply failed,
      // the log row changed and the stock did not — and the difference resurfaced as a
      // bin-card opening balance on a bin that had reconciled the day before.
      //
      // Editing a quantity does not need a NEW movement: the edited row IS the
      // movement, so the recorded total moves with it. What must move in step is the
      // stock, by exactly the same delta — that is what keeps opening at 0.
      if (updated && fields.quantity !== undefined) {
        const oldQty = Number(old.quantity) || 0
        const newQty = Number(updated.quantity) || 0
        const diff = newQty - oldQty
        if (diff !== 0) {
          const bin = editBin(type, old)
          // Sign per record type: an intake or an Increase adjustment credits its bin,
          // so more means more stock. A dispense or a Decrease adjustment draws from
          // it, so more means less.
          const credits = type === 'intake' || (type === 'adjustment' && old.adjustment_type === 'Increase')
          const delta = credits ? diff : -diff
          const current = await binSoh(exec, bin)
          const target = current + delta
          if (target < 0) {
            // ALWAYS refuse, whatever ENFORCE_BIN_STOCK says. That flag exists so a
            // live movement can still be recorded when the balance on file disagrees
            // with the shelf — recording what happened matters more than the figure
            // being tidy. An edit is the opposite case: nothing is happening in the
            // real world, someone is correcting the record. Clamping here would set
            // the bin to zero and report success, silently writing off whatever it
            // held — a loss the edit never authorised and that nothing in the UI
            // would show. Better to refuse and name the shortfall.
            const e = new Error(
              `Cannot apply this edit: ${binLabel(bin)} holds ${current}, ` +
              `and the change would take it to ${target}.`)
            e.status = 409
            throw e
          }
          await setBinSoh(exec, bin, target)
        }
      }

      const isStoreCredit = type === 'intake' || (type === 'adjustment' && old.adjustment_type === 'Increase')
      if (updated && isStoreCredit) {
        await this._syncLotsOnEdit(exec, { facility_id: old.facility_id, commodity_id: old.commodity_id }, {
          oldBatch: old.batch_number,   oldExpiry: old.expiry_date, oldQty: old.quantity,
          newBatch: updated.batch_number, newExpiry: updated.expiry_date, newQty: updated.quantity,
        })
      } else if (updated && fields.quantity !== undefined) {
        const bin = editBin(type, old)

        // Put the difference back on the batch the record names, when it names one.
        //
        // reconcile() alone only knows the bin total, so it credits the difference to
        // a lot with no batch and no expiry. Cancelling a consumption of a dated batch
        // therefore returned the stock as UNDATED — which the dispatch path now
        // refuses to move, so correcting one mistake created another. The batch and
        // expiry are recorded on the row being edited, so use them: about a quarter of
        // dispense rows carry them.
        //
        // Sign: this branch is the DEBIT types (a consumption, a Decrease adjustment).
        // Less consumed than recorded means stock comes back, more means it goes out.
        const batch = (old.batch_number || '').trim()
        if (batch) {
          const back = (Number(old.quantity) || 0) - (Number(updated.quantity) || 0)
          if (back > 0) {
            await LotService.credit(exec, bin, { batch, expiry: old.expiry_date, qty: back })
          } else if (back < 0) {
            // Not enforced: if that batch can no longer cover the increase, take what
            // it has and let reconcile settle the rest rather than blocking the edit.
            await LotService.debit(exec, bin, -back, { batch })
          }
        }

        // Safety net, and the whole story when the record names no batch: bring the
        // ledger back to the bin total either way.
        await LotService.reconcile(exec, bin)
      }
      return updated
    })
  }

  /**
   * Mirror an intake/Increase-adjustment edit onto the lot ledger so the Monitoring
   * / expiry views (and the per-batch stock breakdown) stay honest. Three parts:
   *
   *  1. IDENTITY. What changed decides how the corrected label is applied:
   *     - Expiry corrected on a BATCH → a batch has exactly one true expiry, so
   *       relabel EVERY lot of that batch, in the store AND every bin the stock
   *       moved to (dispensary/DSD/SDP), whatever (possibly stale) expiry it holds,
   *       onto the new date. This is self-healing: it fixes the edit even if a past
   *       edit or the seed left the ledger out of sync — the reason a plain expiry
   *       edit used to "not take". Skipped only for an AMBIGUOUS batch (its own
   *       credit records disagree on the expiry), which then falls back to (2)'s
   *       precise move so we never guess.
   *     - Batch renumbered, or an UNBATCHED expiry change → we can't key on the
   *       batch, so move only the record's own contribution: the exact old identity
   *       in the store (clamped to what's on hand, unknown-expiry lots included),
   *       plus the same exact relabel in the other bins.
   *  2. QUANTITY. Apply the (newQty − oldQty) delta to the store's corrected
   *     identity — grow it, or FEFO-trim it (never negative).
   *
   * The aggregate `stock` total is reconciled separately by the client.
   */
  static async _syncLotsOnEdit(exec, key, args) {
    // 1. Best-effort relabel of every bin (incl. store) to the corrected identity,
    //    plus the quantity delta. Fixes the common cases and is all that survives
    //    when the store can't be cleanly rebuilt below.
    await this._relabelAndDelta(exec, key, args)
    // 2. Authoritative pass: rebuild the STORE bin straight from the records so an
    //    edit's batch, expiry AND quantity always surface on Stock Levels — even when
    //    the ledger drifted so far that step 1 had nothing to match (e.g. a batch was
    //    renamed on a record earlier, orphaning its lot). No-op when it can't be
    //    reconciled to the store's authoritative SOH, leaving step 1's result intact.
    await this._rebuildStoreFromRecords(exec, key)
    // 3. Heal orphaned batches across EVERY bin. When a batch was renamed on the
    //    record, the old batch is left in the ledger — in the store AND any site the
    //    stock had moved to (dispensary/DSD/SDP) — and no earlier step can find it,
    //    because they all key off the record's current batch. When the records credit
    //    exactly one identity (the common case), relabel every on-hand lot onto it.
    await this._healOrphanedBins(exec, key)
  }

  // When a commodity's records credit exactly ONE (batch, expiry) — the common case —
  // every on-hand lot, in every bin, must be that identity. Relabel any lot that isn't
  // (an orphaned batch a rename left behind) onto it, preserving each bin's quantity.
  // Skipped when the records carry several identities, where a blanket relabel would
  // guess — those are handled by the exact-move / whole-batch passes above.
  static async _healOrphanedBins(exec, { facility_id, commodity_id }) {
    const p = [facility_id, commodity_id]
    const { rows: recs } = await exec(`
      select coalesce(nullif(btrim(coalesce(batch_number,'')),''),'') batch,
             to_char(expiry_date,'YYYY-MM-DD') exp
        from (
          select batch_number, expiry_date, quantity q from intake_log
            where facility_id=$1 and commodity_id=$2
          union all
          select batch_number, expiry_date, quantity q from stock_adjustment_log
            where facility_id=$1 and commodity_id=$2 and adjustment_type='Increase'
          union all
          select batch_number, expiry_date, -quantity q from stock_adjustment_log
            where facility_id=$1 and commodity_id=$2 and adjustment_type='Decrease'
        ) c group by 1, 2 having sum(q) > 0`, p)
    if (recs.length !== 1) return               // 0 or many identities — not safe to blanket-relabel
    const target = { batch: recs[0].batch || null, exp: recs[0].exp || null }

    const { rows: lots } = await exec(`
      select id, location_type, coalesce(site_name,'') site, section,
             coalesce(nullif(btrim(coalesce(batch_number,'')),''),'') batch,
             to_char(expiry_date,'YYYY-MM-DD') exp, quantity
        from stock_lot where facility_id=$1 and commodity_id=$2 and quantity > 0`, p)
    let healed = false
    for (const l of lots) {
      if ((l.batch || '') === (target.batch || '') && (l.exp || '') === (target.exp || '')) continue
      await exec('update stock_lot set quantity = quantity - $2, updated_at = now() where id = $1', [l.id, l.quantity])
      await LotService.credit(exec, { facility_id, commodity_id, location_type: l.location_type, site_name: l.site || null },
        { batch: target.batch, expiry: target.exp, qty: l.quantity, section: l.section })
      healed = true
    }
    if (healed) await exec(`delete from stock_lot where facility_id=$1 and commodity_id=$2 and quantity <= 0`, p)
  }

  static async _relabelAndDelta(exec, key, { oldBatch, oldExpiry, oldQty, newBatch, newExpiry, newQty }) {
    const oldB = oldBatch || null, newB = newBatch || null
    const oldE = ymd(oldExpiry), newE = ymd(newExpiry)
    const oQ = Math.max(0, Math.round(Number(oldQty)) || 0)
    const nQ = Math.max(0, Math.round(Number(newQty)) || 0)
    const store = { ...key, location_type: 'store', site_name: null }
    const batchChanged = (oldB || '') !== (newB || '')
    const expiryChanged = (oldE || '') !== (newE || '')

    // Move the record's own contribution from the exact old identity to the new one:
    // the store lot (unknown-expiry lots included), then the same exact relabel in
    // the other bins. Used for batch renumbers and unbatched/ambiguous expiry edits.
    const exactMove = async () => {
      if (oQ > 0) {
        const moved = await this._drawForRelabel(exec, store, { batch: oldB, expiry: oldE }, oQ)
        if (moved > 0) await LotService.credit(exec, store, { batch: newB, expiry: newE, qty: moved })
      }
      await this._relabelExactOtherBins(exec, key,
        { fromBatch: oldB, fromExpiry: oldE, toBatch: newB, toExpiry: newE })
    }

    if (batchChanged) {
      await exactMove()
    } else if (newB) {
      // Batched edit: keep the WHOLE batch aligned to the record's current expiry —
      // idempotent and run every time, so it also self-heals a ledger that drifted
      // (e.g. a prior edit whose old value no longer matches, which is why a plain
      // re-save used to do nothing). Ambiguous batches — records disagree on the
      // expiry — fall back to moving only this record's own exact contribution.
      if (await this._batchExpiryAmbiguous(exec, key, newB)) {
        if (expiryChanged) await exactMove()
      } else {
        await this._relabelWholeBatch(exec, key, newB, newE)
      }
    } else if (expiryChanged) {
      await exactMove()   // unbatched — can only match the exact old identity
    }

    const delta = nQ - oQ
    if (delta > 0) await LotService.credit(exec, store, { batch: newB, expiry: newE, qty: delta })
    else if (delta < 0) await LotService.debit(exec, store, -delta, { batch: newB })
  }

  // Draw up to `want` units from `bin` to relabel: first the exact (batch, expiry)
  // lot, then any UNKNOWN-expiry lot (null expiry — the seed placeholder that holds
  // historical stock). Returns how many were actually drawn (<= want, <= on hand).
  // Emptied lots are removed. Deduped by lot id so a lot never double-counts.
  static async _drawForRelabel(exec, bin, { batch, expiry }, want) {
    const base = [bin.facility_id, bin.commodity_id, bin.location_type, bin.site_name || null]
    const { rows: exact } = await exec(
      `select id, quantity from stock_lot
        where facility_id=$1 and commodity_id=$2 and location_type=$3 and coalesce(site_name,'')=coalesce($4,'')
          and coalesce(batch_number,'')=coalesce($5,'')
          and coalesce(expiry_date,'0001-01-01'::date)=coalesce($6::date,'0001-01-01'::date)
          and quantity > 0
        order by id`, [...base, batch, ymd(expiry)])
    const { rows: unknown } = await exec(
      `select id, quantity from stock_lot
        where facility_id=$1 and commodity_id=$2 and location_type=$3 and coalesce(site_name,'')=coalesce($4,'')
          and expiry_date is null and quantity > 0
        order by id`, base)

    const seen = new Set()
    let need = want, drawn = 0
    for (const r of [...exact, ...unknown]) {
      if (need <= 0) break
      if (seen.has(r.id)) continue
      seen.add(r.id)
      const take = Math.min(r.quantity, need)
      if (take <= 0) continue
      await exec('update stock_lot set quantity = quantity - $2, updated_at = now() where id = $1', [r.id, take])
      drawn += take; need -= take
    }
    if (drawn > 0) {
      await exec(
        `delete from stock_lot where facility_id=$1 and commodity_id=$2 and location_type=$3
           and coalesce(site_name,'')=coalesce($4,'') and quantity <= 0`, base)
    }
    return drawn
  }

  // True when a batch's own credit records (intakes + Increase adjustments) carry
  // more than one distinct non-null expiry — the "one true expiry per batch" rule
  // fails, so we must not blindly relabel the whole batch. Mirrors the reconcile
  // script's ambiguity check.
  static async _batchExpiryAmbiguous(exec, { facility_id, commodity_id }, batch) {
    const { rows } = await exec(
      `select count(distinct expiry_date)::int n from (
         select expiry_date from intake_log
           where facility_id=$1 and commodity_id=$2
             and nullif(btrim(coalesce(batch_number,'')),'')=$3 and expiry_date is not null
         union all
         select expiry_date from stock_adjustment_log
           where facility_id=$1 and commodity_id=$2 and adjustment_type='Increase'
             and nullif(btrim(coalesce(batch_number,'')),'')=$3 and expiry_date is not null
       ) c`, [facility_id, commodity_id, batch])
    return (rows[0]?.n || 0) > 1
  }

  // Relabel EVERY lot of (facility, commodity, batch) — any bin, any site, whatever
  // current expiry — onto `toExpiry`, in place: quantity is conserved (units only
  // change their label) and duplicates merge into an existing identical lot. This is
  // the "one true expiry per batch" repair applied at edit time, so a corrected
  // expiry reaches the store and every bin the stock moved to, and it self-heals a
  // ledger a past edit or the seed left out of sync.
  static async _relabelWholeBatch(exec, { facility_id, commodity_id }, batch, toExpiry) {
    const toE = ymd(toExpiry)
    const { rows: lots } = await exec(
      `select id, location_type, site_name, quantity, section from stock_lot
        where facility_id=$1 and commodity_id=$2
          and nullif(btrim(coalesce(batch_number,'')),'')=$3
          and coalesce(expiry_date,'0001-01-01'::date) <> coalesce($4::date,'0001-01-01'::date)
          and quantity > 0`,
      [facility_id, commodity_id, batch, toE])
    for (const lot of lots) {
      const bin = { facility_id, commodity_id, location_type: lot.location_type, site_name: lot.site_name }
      await LotService.credit(exec, bin, { batch, expiry: toE, qty: lot.quantity, section: lot.section })
      await exec('delete from stock_lot where id=$1', [lot.id])
    }
  }

  // Relabel lots carrying the exact (fromBatch, fromExpiry) identity onto
  // (toBatch, toExpiry) in the NON-store bins (the store leg is handled by the
  // caller's _drawForRelabel). Quantity conserved, duplicates merged. Used for batch
  // renumbers and unbatched/ambiguous expiry edits, where we can only touch stock
  // that literally matches the record's old identity. A fully-generic old identity
  // (no batch AND no expiry) is the anonymous unknown pool — unattributable, skipped.
  static async _relabelExactOtherBins(exec, { facility_id, commodity_id }, { fromBatch, fromExpiry, toBatch, toExpiry }) {
    const fromB = fromBatch || null, toB = toBatch || null
    const fromE = ymd(fromExpiry), toE = ymd(toExpiry)
    if (!fromB && !fromE) return
    const { rows: lots } = await exec(
      `select id, location_type, site_name, quantity, section from stock_lot
        where facility_id=$1 and commodity_id=$2 and location_type <> 'store'
          and coalesce(batch_number,'')=coalesce($3,'')
          and coalesce(expiry_date,'0001-01-01'::date)=coalesce($4::date,'0001-01-01'::date)
          and quantity > 0`,
      [facility_id, commodity_id, fromB, fromE])
    for (const lot of lots) {
      const bin = { facility_id, commodity_id, location_type: lot.location_type, site_name: lot.site_name }
      await LotService.credit(exec, bin, { batch: toB, expiry: toE, qty: lot.quantity, section: lot.section })
      await exec('delete from stock_lot where id=$1', [lot.id])
    }
  }

  /**
   * Reconstruct the STORE bin's per-batch ledger straight from the authoritative
   * records, so an activity-log edit's batch / expiry / quantity all surface on Stock
   * Levels — no matter how far the ledger had drifted (a renamed batch, a stale
   * expiry, a pre-fix edit). The store's true composition is:
   *
   *     what the records credited   (intakes + Increase adjustments)
   *   − what the records removed     (Decrease adjustments)
   *   − what now lives in other bins (dispensary / DSD / SDP lots)
   *
   * grouped by (batch, expiry). We rebuild to that ONLY when it reconciles exactly to
   * the store's authoritative SOH (the `stock` aggregate) and no identity goes
   * negative — so it can never invent or drop stock. When it can't reconcile (an
   * untracked outflow, e.g. an old batch-less store dispense), it changes nothing and
   * returns false, leaving the caller's best-effort relabel in place.
   */
  static async _rebuildStoreFromRecords(exec, { facility_id, commodity_id }) {
    const p = [facility_id, commodity_id]
    const { rows: sohRows } = await exec(
      `select quantity from stock where facility_id=$1 and commodity_id=$2 and location_type='store'`, p)
    const soh = sohRows[0]?.quantity || 0

    // Net records by (batch, expiry): credits positive, Decrease adjustments negative.
    const { rows: recs } = await exec(`
      select coalesce(nullif(btrim(coalesce(batch_number,'')),''),'') batch,
             to_char(expiry_date,'YYYY-MM-DD') exp, sum(q)::int qty
        from (
          select batch_number, expiry_date, quantity q from intake_log
            where facility_id=$1 and commodity_id=$2
          union all
          select batch_number, expiry_date, quantity q from stock_adjustment_log
            where facility_id=$1 and commodity_id=$2 and adjustment_type='Increase'
          union all
          select batch_number, expiry_date, -quantity q from stock_adjustment_log
            where facility_id=$1 and commodity_id=$2 and adjustment_type='Decrease'
        ) c group by 1, 2`, p)

    // What currently lives in the non-store bins, by (batch, expiry).
    const { rows: other } = await exec(`
      select coalesce(nullif(btrim(coalesce(batch_number,'')),''),'') batch,
             to_char(expiry_date,'YYYY-MM-DD') exp, sum(quantity)::int qty
        from stock_lot
       where facility_id=$1 and commodity_id=$2 and location_type <> 'store' and quantity > 0
       group by 1, 2`, p)

    // target store = records − other bins, per identity.
    const map = new Map()
    const mkey = (b, e) => `${b}|${e || ''}`
    for (const r of recs)  map.set(mkey(r.batch, r.exp), (map.get(mkey(r.batch, r.exp)) || 0) + r.qty)
    for (const o of other) map.set(mkey(o.batch, o.exp), (map.get(mkey(o.batch, o.exp)) || 0) - o.qty)

    const target = []
    let sum = 0
    for (const [k, qty] of map) {
      if (qty < 0) return false          // other bins hold more of an identity than records credit — inconsistent
      if (qty === 0) continue
      const [batch, exp] = k.split('|')
      target.push({ batch: batch || null, exp: exp || null, qty })
      sum += qty
    }
    if (sum !== soh) return false         // can't reconcile to authoritative SOH — leave the ledger as-is

    // Carry over the section the store lots use (one per commodity) before we drop them.
    const { rows: secRows } = await exec(
      `select distinct section from stock_lot
         where facility_id=$1 and commodity_id=$2 and location_type='store'
           and coalesce(site_name,'')='' and section is not null`, p)
    const section = secRows.length === 1 ? secRows[0].section : null

    await exec(
      `delete from stock_lot where facility_id=$1 and commodity_id=$2
         and location_type='store' and coalesce(site_name,'')=''`, p)
    const bin = { facility_id, commodity_id, location_type: 'store', site_name: null }
    for (const t of target) await LotService.credit(exec, bin, { batch: t.batch, expiry: t.exp, qty: t.qty, section })
    return true
  }

  /**
   * Record a dispense and decrement the matching stock.
   *
   * `dsd_site_name` / `sdp_name` are routing hints (NOT columns — the real
   * dispense_log has neither). When given, the corresponding site stock is
   * decremented and the caller is expected to have encoded the site into
   * `notes` (e.g. "[DSD: name]"), matching the frontend convention. Otherwise
   * the facility store stock is decremented.
   */
  static async recordDispense(dispenseData) {
    const {
      facility_id, commodity_id, quantity, dispensed_by, dispensed_at,
      notes, dsd_site_name, sdp_name, section, location_type,
      batch_number, expiry_date
    } = dispenseData

    // quantity may be 0 (a "nothing consumed today" record), so guard on null/undefined
    // rather than falsiness. A 0 debit is a no-op in the ledger and stock decrement.
    if (!facility_id || !commodity_id || quantity == null || !dispensed_by) {
      throw new Error('Missing required fields: facility_id, commodity_id, quantity, dispensed_by')
    }

    const qty = parseInt(quantity)

    // Log insert + stock decrement commit (or roll back) together.
    return await withTransaction(async exec => {
      const resolvedSection = await resolveSection(section, commodity_id, exec)
      const { rows } = await exec(
        `insert into dispense_log
           (facility_id, commodity_id, quantity, dispensed_by, dispensed_at, notes, section, batch_number, expiry_date)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning *`,
        [facility_id, commodity_id, qty, dispensed_by,
         dispensed_at || new Date().toISOString(), notes || '', resolvedSection,
         batch_number || null, expiry_date || null]
      )
      const dispenseLog = rows[0] || null

      // Decrement the right stock bucket, and debit the matching lot ledger by the
      // same amount — the batch the user chose first, then FEFO for any remainder.
      //
      // Every branch checks the bin can cover `qty` BEFORE writing. Previously the
      // decrements clamped at 0, so consuming from an empty bin still committed the
      // dispense_log row: the bin ended at 0 while the ledger recorded the full
      // issue, and the gap resurfaced later as a bin-card opening balance. Worse,
      // LotService.debit's self-heal reads the bin AFTER the decrement, so a clamped
      // bin made it mint phantom lots to cover the draw. Rejecting up front (409)
      // rolls back the whole transaction — a refused consumption leaves no row.
      // `covers` false means the bin is short AND enforcement is off: fall back to
      // the old clamped decrement so the user isn't blocked during the transition.
      let bin
      if (dsd_site_name) {
        const dsdStock = await StockService.getDsdStockByFacilitySiteCommodity(facility_id, dsd_site_name, commodity_id, exec)
        const covers = await assertBinCovers(exec, dsdStock?.quantity ?? 0, qty, commodity_id, `DSD site "${dsd_site_name}"`)
        if (dsdStock && qty > 0) {
          await exec(`update dsd_stock set quantity = ${covers ? 'quantity - $2' : 'greatest(0, quantity - $2)'}, updated_at = now() where id = $1`, [dsdStock.id, qty])
        }
        bin = { facility_id, commodity_id, location_type: 'dsd', site_name: dsd_site_name }
      } else if (sdp_name) {
        const sdpStock = await StockService.getSdpStockByFacilitySiteCommodity(facility_id, sdp_name, commodity_id, exec)
        const covers = await assertBinCovers(exec, sdpStock?.quantity ?? 0, qty, commodity_id, `SDP site "${sdp_name}"`)
        if (sdpStock && qty > 0) {
          await exec(`update sdp_stock set quantity = ${covers ? 'quantity - $2' : 'greatest(0, quantity - $2)'}, updated_at = now() where id = $1`, [sdpStock.id, qty])
        }
        bin = { facility_id, commodity_id, location_type: 'sdp', site_name: sdp_name }
      } else {
        // Facility consumption deducts the given location (the frontend dispenses
        // from the dispensary); defaults to store when unspecified.
        const loc = location_type || 'store'
        const label = loc === 'store' ? 'the main store' : 'the dispensary'
        const stock = await StockService.getStockByFacilityAndCommodity(facility_id, commodity_id, loc, exec)
        const covers = await assertBinCovers(exec, stock?.quantity ?? 0, qty, commodity_id, label)
        if (stock && qty > 0) {
          // Strict when the precondition passed — closes the check-then-write race.
          // Re-asserting on a null result turns a lost race into the same 409.
          if (covers) {
            const dec = await StockService.decrementStockStrict(stock.id, qty, exec)
            if (!dec) await assertBinCovers(exec, 0, qty, commodity_id, label)
          } else {
            await StockService.decrementStock(stock.id, qty, exec)
          }
        }
        bin = { facility_id, commodity_id, location_type: loc, site_name: null }
      }
      // Enforce (phase 3): a chosen batch must cover qty and not be expired; with
      // no batch, FEFO skips expired lots. Blocks (409) if eligible stock is short.
      // '' and null mean different things and must not be flattened: '' is the lot
      // that HAS no batch number (LotService.debit matches it exactly), null is "no
      // lot named, draw FEFO". `x || null` collapses the first into the second, which
      // silently debits a batched lot when the operator picked "(no batch)".
      await LotService.debit(exec, bin, qty, { batch: batch_number == null ? null : batch_number, enforce: true })

      return dispenseLog
    })
  }

  /**
   * Dispense history for a facility, newest first, with nested commodity.
   * Site filtering uses the notes convention ("[DSD: name]" / "[SDP: name]")
   * since dispense_log has no site column.
   */
  static async getDispenseHistory(facilityId, options = {}) {
    const { dsdSiteName, sdpName, date, from, to, facilityIds, commodityIds, categories, commodityNames, section, limit = 1000, offset = 0 } = options
    if (!facilityId && Array.isArray(facilityIds) && facilityIds.length === 0) return []

    const params = []
    const conds = []
    applyLogFilters({ conds, params, dateField: 'dispensed_at', facilityId, facilityIds, commodityIds, categories, commodityNames, date, from, to, section })

    if (dsdSiteName) { params.push(`%[DSD: ${dsdSiteName}]%`); conds.push(`l.notes like $${params.length}`) }
    else if (sdpName) { params.push(`%[SDP: ${sdpName}]%`); conds.push(`l.notes like $${params.length}`) }

    let sql = `
      select l.*, ${COMM4_OBJ}, ${FAC_OBJ}
      from dispense_log l
      left join commodities c on c.id = l.commodity_id
      left join facilities f on f.id = l.facility_id`
    if (conds.length) sql += ` where ${conds.join(' and ')}`

    params.push(limit, offset)
    sql += ` order by l.dispensed_at desc limit $${params.length - 1} offset $${params.length}`

    const { rows } = await query(sql, params)
    return rows
  }

  /**
   * Consumption summed by commodity + UTC month over a facility set and date
   * window — the AMC aggregate. Returns [{ commodity_id, ym, qty }] (a few dozen
   * rows) instead of every dispense row, so admin dashboards don't ship (and the
   * browser doesn't crunch) tens of thousands of rows. Same filters/rows as
   * getDispenseHistory, just pre-aggregated server-side.
   */
  static async getDispenseSummary(facilityId, options = {}) {
    return logSummary({ table: 'dispense_log', dateField: 'dispensed_at' }, facilityId, options)
  }

  /**
   * Intake summed over a facility set and date window — the receiving-side mirror
   * of getDispenseSummary, powering Monitoring's "Units received" card and its
   * commodity/facility drill-ins. Same groupings, same { qty, txn } row shape, so
   * the two aggregates line up field-for-field and a caller can subtract one from
   * the other. Bucketed on received_at (intake_log's date column).
   */
  static async getIntakeSummary(facilityId, options = {}) {
    return logSummary({ table: 'intake_log', dateField: 'received_at' }, facilityId, options)
  }

  /**
   * Stock adjustments aggregated — the third movement type, alongside consumption
   * (out) and intake (in). An adjustment changes stock WITHOUT a physical movement:
   * count corrections, expiries written off, returns. Same { qty, txn } row shape as
   * the other two, plus `type` (Increase / Decrease) and `reason` dimensions.
   *
   * `adjustmentType` narrows to one direction. Positive and negative adjustments are
   * never netted here — the caller asks for one or gets both broken out — because a
   * net of zero can equally mean nothing happened or that 5,000 units were added and
   * 5,000 removed.
   */
  static async getAdjustmentSummary(facilityId, options = {}) {
    return logSummary(
      { table: 'stock_adjustment_log', dateField: 'adjusted_at', specs: ADJUSTMENT_GROUP_BY },
      facilityId, options
    )
  }


  /**
   * One activity feed across all four logs, ordered by time, with limit/offset.
   *
   * WHY THIS EXISTS. The Activity Log and the weekly/monthly report both show a
   * merged, time-ordered stream of dispenses, intakes, adjustments and transfers.
   * Building that in the browser means fetching each log separately and merging —
   * which cannot be paged. Page 2 of a merged stream is not page 2 of any single
   * log, so "the newest 500 of each, merged, cut to 500" silently drops whatever
   * fell past one source's cap, and a Next button over it would return pages with
   * records missing from the middle. A monthly report currently drains ~23,000 rows
   * over ~24 sequential requests to show one screenful.
   *
   * Doing the merge in SQL makes the ordering total, so limit/offset are exact and
   * the client fetches only what it displays. `total` rides along via a window
   * count so the caller can render "page 2 of 24" without a second query.
   *
   * Row shape is deliberately uniform — the four logs disagree on column names
   * (dispensed_at / received_at / adjusted_at / resolved_at), and normalising here
   * keeps that knowledge in one place instead of in every caller.
   */
  static async getActivityFeed(options = {}) {
    const {
      from, to, facilityId, facilityIds, commodityIds, categories, commodityNames,
      section, types = null, category = null, externalOnly = false,
      limit = 50, offset = 0,
    } = options
    if (!facilityId && Array.isArray(facilityIds) && facilityIds.length === 0) {
      return { rows: [], total: 0 }
    }

    const params = []
    const P = v => { params.push(v); return `$${params.length}` }

    // Bind the shared filters ONCE and reuse the placeholders across all four
    // branches — the same value repeated as four parameters would be four plan
    // entries for one filter.
    const pFrom = from ? P(from) : null
    const pTo   = to   ? P(to)   : null
    const pFid  = facilityId ? P(facilityId) : null
    const pFids = (!facilityId && Array.isArray(facilityIds)) ? P(facilityIds) : null
    const pComms = (Array.isArray(commodityIds) && commodityIds.length) ? P(commodityIds) : null
    const pSection = section ? P(section) : null
    const pCats = (Array.isArray(categories) && categories.length) ? P(categories) : null
    const pNames = (Array.isArray(commodityNames) && commodityNames.length) ? P(commodityNames) : null
    // A single commodity category, on top of (never widening) the section scope.
    const pCat = category ? P(category) : null

    // Section scope: the caller's categories, plus any individually granted
    // commodity. Identical rule to the per-log queries.
    const secCond = pCats
      ? (pNames ? `(c.category = any(${pCats}) or c.name = any(${pNames}))` : `c.category = any(${pCats})`)
      : null

    const branch = ({ table, dateCol, type, statusCol, facilityJoin, extra }) => {
      const w = [`${dateCol} is not null`]
      if (pFrom) w.push(`${dateCol} >= ${pFrom}`)
      if (pTo)   w.push(`${dateCol} <= ${pTo}`)
      if (pComms) w.push(`l.commodity_id = any(${pComms})`)
      if (pSection) w.push(`l.section = ${pSection}`)
      if (secCond) w.push(secCond)
      if (pCat) w.push(`c.category = ${pCat}`)
      w.push(facilityJoin)
      return `
        select l.id, '${type}'::text as type, ${dateCol} as at,
               ${extra.facility_id} as facility_id, ${extra.facility_name} as facility_name,
               l.commodity_id, c.name as commodity_name, c.category, c.unit,
               l.quantity::int as quantity,
               ${statusCol} as status, ${extra.notes} as notes,
               ${extra.sending} as sending_facility_name,
               ${extra.receiving} as receiving_facility_name,
               ${extra.sending_id} as sending_facility_id,
               ${extra.receiving_id} as receiving_facility_id,
               -- Who did it, and the one free-text field each log keeps. The
               -- Activity Log shows these in its details column, so leaving them
               -- out would mean fetching the row again just to render it.
               ${extra.actor} as actor,
               ${extra.supplier} as supplier_source,
               ${extra.reason} as reason
        from ${table} l
        left join commodities c on c.id = l.commodity_id
        ${extra.join}
        where ${w.join(' and ')}`
    }

    const facWhere = pFid ? `l.facility_id = ${pFid}` : pFids ? `l.facility_id = any(${pFids})` : 'true'
    // A transfer belongs to BOTH endpoints, so it is in scope if either is.
    const trWhere = pFid
      ? `(l.sending_facility_id = ${pFid} or l.receiving_facility_id = ${pFid})`
      : pFids
        ? `(l.sending_facility_id = any(${pFids}) or l.receiving_facility_id = any(${pFids}))`
        : 'true'

    const plain = {
      facility_id: 'l.facility_id', facility_name: 'f.name', notes: 'l.notes',
      sending: 'null::text', receiving: 'null::text',
      sending_id: 'null::uuid', receiving_id: 'null::uuid',
      supplier: 'null::text', reason: 'null::text', actor: 'null::text',
      join: 'left join facilities f on f.id = l.facility_id',
    }
    const all = {
      dispense:   branch({ table:'dispense_log',        dateCol:'l.dispensed_at', type:'dispense',   statusCol:`'Dispensed'::text`,      facilityJoin: facWhere, extra: { ...plain, actor:'l.dispensed_by' } }),
      intake:     branch({ table:'intake_log',          dateCol:'l.received_at',  type:'intake',     statusCol:'l.condition_on_arrival', facilityJoin: facWhere, extra: { ...plain, actor:'l.received_by', supplier:'l.supplier_source' } }),
      adjustment: branch({ table:'stock_adjustment_log',dateCol:'l.adjusted_at',  type:'adjustment', statusCol:'l.adjustment_type',      facilityJoin: facWhere, extra: { ...plain, actor:'l.adjusted_by', reason:'l.reason' } }),
      // externalOnly drops internal movements — store→dispensary (same facility)
      // and SDP/DSD dispatches (no receiving facility). Cross-facility admin views
      // exclude them, and doing it here keeps the page count honest: filtering them
      // out in the browser would leave "page 2 of 24" counting rows never shown.
      transfer:   branch({ table:'stock_transfer_log',  dateCol:'l.initiated_at', type:'transfer',   statusCol:'l.status',
        facilityJoin: externalOnly
          ? `(${trWhere}) and l.sending_facility_id is not null and l.receiving_facility_id is not null and l.sending_facility_id <> l.receiving_facility_id`
          : trWhere,
        extra: {
        // A transfer has two facilities; the receiving one is reported as "the"
        // facility, with both names carried so the caller can show direction.
        facility_id: 'coalesce(l.receiving_facility_id, l.sending_facility_id)',
        facility_name: 'coalesce(l.receiving_facility_name, l.sending_facility_name)',
        notes: 'l.notes', sending: 'l.sending_facility_name', receiving: 'l.receiving_facility_name',
        sending_id: 'l.sending_facility_id', receiving_id: 'l.receiving_facility_id',
        supplier: 'null::text', reason: 'null::text', actor: 'l.resolved_by',
        join: '',
      }}),
    }

    const wanted = Array.isArray(types) && types.length
      ? types.filter(t => all[t]).map(t => all[t])
      : Object.values(all)
    if (!wanted.length) return { rows: [], total: 0 }

    const pLimit = P(parseInt(limit) || 50)
    const pOffset = P(parseInt(offset) || 0)
    const sql = `
      with feed as (${wanted.join('\n        union all\n')})
      select *, count(*) over()::int as total
      from feed
      order by at desc
      limit ${pLimit} offset ${pOffset}`

    const { rows } = await query(sql, params)
    return { rows, total: rows.length ? rows[0].total : 0 }
  }

  /**
   * Record an intake and add to the facility store stock (create if absent).
   */
  static async recordIntake(intakeData) {
    const {
      facility_id, commodity_id, quantity, supplier_source, batch_number,
      expiry_date, delivery_note_ref, condition_on_arrival, received_by,
      received_at, notes, section
    } = intakeData

    if (!facility_id || !commodity_id || !quantity || !received_by) {
      throw new Error('Missing required fields: facility_id, commodity_id, quantity, received_by')
    }

    const qty = parseInt(quantity)

    // Log insert + stock increment commit (or roll back) together.
    return await withTransaction(async exec => {
      const resolvedSection = await resolveSection(section, commodity_id, exec)
      const { rows } = await exec(
        `insert into intake_log
           (facility_id, commodity_id, quantity, supplier_source, batch_number, expiry_date,
            delivery_note_ref, condition_on_arrival, received_by, received_at, notes, section)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         returning *`,
        [facility_id, commodity_id, qty, supplier_source || '', batch_number || '',
         expiry_date || null, delivery_note_ref || '', condition_on_arrival || 'Good',
         received_by, received_at || new Date().toISOString(), notes || '', resolvedSection]
      )
      const intakeLog = rows[0] || null

      const existing = await StockService.getStockByFacilityAndCommodity(facility_id, commodity_id, 'store', exec)
      if (existing) {
        await StockService.incrementStock(existing.id, qty, exec)
      } else {
        await StockService.createStock({ facility_id, commodity_id, quantity: qty, location_type: 'store' }, exec)
      }
      // An intake is a new store lot with its recorded batch/expiry.
      await LotService.credit(exec, { facility_id, commodity_id, location_type: 'store', site_name: null },
        { batch: batch_number || null, expiry: expiry_date || null, qty, section: resolvedSection })

      return intakeLog
    })
  }

  /**
   * Intake history for a facility, newest first, with nested commodity.
   */
  static async getIntakeHistory(facilityId, options = {}) {
    const {
      date, from, to, supplier_source, facilityIds, commodityIds, categories, commodityNames, section,
      expiryFrom, expiryTo, hasQuantity, limit = 1000, offset = 0
    } = options
    if (!facilityId && Array.isArray(facilityIds) && facilityIds.length === 0) return []

    const params = []
    const conds = []
    applyLogFilters({ conds, params, dateField: 'received_at', facilityId, facilityIds, commodityIds, categories, commodityNames, date, from, to, section })

    if (supplier_source) { params.push(supplier_source); conds.push(`l.supplier_source = $${params.length}`) }
    // Expiry-tracking filters (Monitoring expiry tab): a non-null expiry_date in
    // range, with remaining stock. The >= comparison already excludes NULLs.
    if (expiryFrom) { params.push(expiryFrom); conds.push(`l.expiry_date >= $${params.length}`) }
    if (expiryTo) { params.push(expiryTo); conds.push(`l.expiry_date <= $${params.length}`) }
    if (hasQuantity) { conds.push(`l.quantity > 0`) }

    let sql = `
      select l.*, ${COMM4_OBJ}, ${FAC_OBJ}
      from intake_log l
      left join commodities c on c.id = l.commodity_id
      left join facilities f on f.id = l.facility_id`
    if (conds.length) sql += ` where ${conds.join(' and ')}`

    params.push(limit, offset)
    sql += ` order by l.received_at desc limit $${params.length - 1} offset $${params.length}`

    const { rows } = await query(sql, params)
    return rows
  }

  /**
   * Commodity ids this facility (or scope) has EVER transacted — any intake or
   * dispense record, however old. Used to tell a real stockout from a commodity
   * the facility simply never handles: current stock and the AMC window both miss
   * something last touched long ago. Ids only, so it stays cheap.
   */
  static async getTransactedCommodityIds(facilityId, { facilityIds } = {}) {
    const params = []
    let cond = 'true'
    if (facilityId) {
      params.push(facilityId); cond = `facility_id = $${params.length}`
    } else if (Array.isArray(facilityIds)) {
      if (!facilityIds.length) return []
      params.push(facilityIds); cond = `facility_id = any($${params.length})`
    }
    // Filter inside each branch so the facility_id index is used, then union
    // (which de-duplicates) rather than scanning a combined set.
    const { rows } = await query(
      `select commodity_id from intake_log   where ${cond} and commodity_id is not null
       union
       select commodity_id from dispense_log where ${cond} and commodity_id is not null`,
      params
    )
    return rows.map(r => r.commodity_id)
  }

  /**
   * Record a stock adjustment and apply it to the facility store stock.
   */
  static async recordAdjustment(adjustmentData) {
    const {
      facility_id, commodity_id, quantity, adjustment_type, reason, adjusted_by,
      reference_number, notes, adjusted_at, expiry_date, batch_number, section,
      location_type = 'store', site_name = null
    } = adjustmentData

    if (!facility_id || !commodity_id || !quantity || !adjustment_type || !reason || !adjusted_by) {
      throw new Error('Missing required fields: facility_id, commodity_id, quantity, adjustment_type, reason, adjusted_by')
    }
    if (!['Increase', 'Decrease'].includes(adjustment_type)) {
      throw new Error('adjustment_type must be "Increase" or "Decrease"')
    }
    if (!['store', 'dispensary', 'dsd', 'sdp'].includes(location_type)) {
      throw new Error("location_type must be 'store', 'dispensary', 'dsd' or 'sdp'")
    }
    if ((location_type === 'dsd' || location_type === 'sdp') && !site_name) {
      throw new Error('site_name is required when adjusting a DSD/SDP bin')
    }
    // Compulsory for reasons that are otherwise unexplainable after the fact.
    // Enforced here, not just in the form, so the API cannot bypass it.
    if (REASONS_REQUIRING_NOTES.has(reason) && !String(notes || '').trim()) {
      const e = new Error(`Notes are required for "${reason}" — record what was counted and why the figure differs.`)
      e.status = 400
      throw e
    }
    if (REASONS_REQUIRING_BATCH.has(reason) && !String(batch_number || '').trim()) {
      // An empty STRING is the "(no batch)" pick — valid, but only if such a lot is
      // really on the shelf. Null/absent means no lot was named at all.
      const picked = batch_number === ''
      const bin = { facility_id, commodity_id, location_type, site_name: site_name || null }
      const ok = picked && await binHasUnbatchedLot(query, bin)
      if (!ok) {
        const e = new Error(picked
          ? `No unbatched stock is on hand in ${binLabel(bin)}, so "(no batch)" is not a valid pick for "${reason}" — choose the batch being written off.`
          : `Batch number is required for "${reason}" — name the exact lot being written off, so the right one leaves the expiry report. Pick "(no batch)" if that lot has none recorded.`)
        e.status = 400
        throw e
      }
    }

    const qty = parseInt(quantity)

    // Log insert + stock adjustment commit (or roll back) together.
    return await withTransaction(async exec => {
      const resolvedSection = await resolveSection(section, commodity_id, exec)
      const { rows } = await exec(
        `insert into stock_adjustment_log
           (facility_id, commodity_id, quantity, adjustment_type, reason, adjusted_by,
            reference_number, notes, adjusted_at, expiry_date, batch_number, section,
            location_type, site_name)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         returning *`,
        [facility_id, commodity_id, qty, adjustment_type, reason, adjusted_by,
         reference_number || '', notes || '', adjusted_at || new Date().toISOString(),
         expiry_date || null, batch_number || '', resolvedSection,
         location_type, site_name || null]
      )
      const adjustmentLog = rows[0] || null

      // Apply to the bin the correction names, not always the store. Correcting a
      // dispensary or site shelf used to move the store instead, so the bin that was
      // actually counted never changed and the store drifted by the same amount.
      const bin = { facility_id, commodity_id, location_type, site_name: site_name || null }
      const current = await binSoh(exec, bin)
      if (adjustment_type === 'Decrease') {
        // Same precondition as consumption: you cannot remove more than the bin
        // holds. This is what stops one shelf being deducted repeatedly (Apapa
        // General: -1766 then -1746 against a bin already down to 39). Behind
        // ENFORCE_BIN_STOCK, so it warns rather than blocks until bins are counted.
        const covers = await assertBinCoversAdj(exec, current, qty, commodity_id, binLabel(bin))
        await setBinSoh(exec, bin, covers ? current - qty : Math.max(0, current - qty))
      } else {
        await setBinSoh(exec, bin, current + qty)
      }
      // Mirror the change on the lot ledger: an increase is a lot with its
      // recorded batch/expiry; a decrease draws FEFO (soonest-expiry first).
      if (adjustment_type === 'Increase') {
        await LotService.credit(exec, bin, { batch: batch_number || null, expiry: expiry_date || null, qty, section: resolvedSection })
      } else {
        // Preserve the difference between '' and null. LotService.debit matches an
        // empty batch to the lot that HAS no batch number; `batch_number || null`
        // would flatten that into "no preference" and draw FEFO across every lot —
        // retiring a batched lot when the operator explicitly picked "(no batch)".
        await LotService.debit(exec, bin, qty, { batch: batch_number == null ? null : batch_number })
      }

      return adjustmentLog
    })
  }

  /**
   * Adjustment history for a facility, newest first, with nested commodity.
   */
  static async getAdjustmentHistory(facilityId, options = {}) {
    const { date, from, to, adjustment_type, reason, facilityIds, commodityIds, categories, commodityNames, section, limit = 1000, offset = 0 } = options
    if (!facilityId && Array.isArray(facilityIds) && facilityIds.length === 0) return []

    const params = []
    const conds = []
    applyLogFilters({ conds, params, dateField: 'adjusted_at', facilityId, facilityIds, commodityIds, categories, commodityNames, date, from, to, section })

    if (adjustment_type) { params.push(adjustment_type); conds.push(`l.adjustment_type = $${params.length}`) }
    if (reason) { params.push(reason); conds.push(`l.reason = $${params.length}`) }

    let sql = `
      select l.*, ${COMM4_OBJ}, ${FAC_OBJ}
      from stock_adjustment_log l
      left join commodities c on c.id = l.commodity_id
      left join facilities f on f.id = l.facility_id`
    if (conds.length) sql += ` where ${conds.join(' and ')}`

    params.push(limit, offset)
    sql += ` order by l.adjusted_at desc limit $${params.length - 1} offset $${params.length}`

    const { rows } = await query(sql, params)
    return rows
  }

}
