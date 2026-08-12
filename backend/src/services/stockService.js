import { query, withTransaction } from '../db.js'
import { LotService, ymd } from './lotService.js'

// Embedded-object SQL fragments. The frontend (and the other services) expect
// stock rows to carry nested `facilities` / `commodities` objects, the same
// shape Supabase's PostgREST embedded selects produced. We rebuild those with
// json_build_object so callers don't have to change.
const COMMODITY_OBJ = `
  json_build_object(
    'id', c.id, 'name', c.name, 'category', c.category,
    'unit', c.unit, 'dispensing_unit', c.dispensing_unit, 'pack_size', c.pack_size
  ) as commodities`

const FACILITY_OBJ = `
  json_build_object('id', f.id, 'name', f.name, 'state', f.state, 'lga', f.lga) as facilities`

export class StockService {
  /**
   * Get stock records for a facility (store + dispensary), with nested
   * facility/commodity details, ordered by commodity name.
   */
  static async getStock(facilityId, options = {}) {
    const { commodityId, locationType, categories = null, limit = 1000, offset = 0 } = options

    const params = [facilityId]
    let sql = `
      select s.id, s.facility_id, s.commodity_id, s.quantity, s.tablet_buffer,
             s.baseline_amc, s.updated_at, s.location_type,
             ${FACILITY_OBJ}, ${COMMODITY_OBJ}
      from stock s
      left join facilities f on f.id = s.facility_id
      left join commodities c on c.id = s.commodity_id
      where s.facility_id = $1`

    if (commodityId) { params.push(commodityId); sql += ` and s.commodity_id = $${params.length}` }
    if (locationType) { params.push(locationType); sql += ` and s.location_type = $${params.length}` }
    // Section enforcement: restrict to the caller's commodity categories.
    if (Array.isArray(categories) && categories.length) { params.push(categories); sql += ` and c.category = any($${params.length})` }

    params.push(limit, offset)
    sql += ` order by c.name nulls last limit $${params.length - 1} offset $${params.length}`

    const { rows } = await query(sql, params)
    return rows
  }

  /**
   * Get stock across a set of facilities (admin/multi-facility view). `facilityIds`
   * null = all facilities (unconstrained — overall/cluster admin); an array = only
   * those facilities; an empty array short-circuits to no rows. Optional
   * `commodityIds` narrows to a commodity-section subset. Paginated via limit/offset.
   * Same row shape as getStock (nested facilities/commodities).
   */
  static async getScopedStock({ facilityIds = null, commodityIds = null, categories = null, limit = 1000, offset = 0 } = {}) {
    if (Array.isArray(facilityIds) && facilityIds.length === 0) return []

    const params = []
    const conds = []
    if (Array.isArray(facilityIds)) { params.push(facilityIds); conds.push(`s.facility_id = any($${params.length})`) }
    if (Array.isArray(commodityIds) && commodityIds.length) { params.push(commodityIds); conds.push(`s.commodity_id = any($${params.length})`) }
    if (Array.isArray(categories) && categories.length) { params.push(categories); conds.push(`c.category = any($${params.length})`) }

    let sql = `
      select s.id, s.facility_id, s.commodity_id, s.quantity, s.tablet_buffer,
             s.baseline_amc, s.updated_at, s.location_type,
             ${FACILITY_OBJ}, ${COMMODITY_OBJ}
      from stock s
      left join facilities f on f.id = s.facility_id
      left join commodities c on c.id = s.commodity_id`
    if (conds.length) sql += ` where ${conds.join(' and ')}`

    params.push(limit, offset)
    sql += ` order by c.name nulls last limit $${params.length - 1} offset $${params.length}`

    const { rows } = await query(sql, params)
    return rows
  }

  /**
   * PER-COMMODITY stock rollup across a scope — one row per commodity instead of
   * one row per (facility, commodity, location). This is what every dashboard /
   * stock-table / alert view actually needs: the raw rows were only ever
   * downloaded so the browser could reduce them to these same numbers
   * (groupStockByComm + the DSD/SDP sum loops), which made the payload scale with
   * the database instead of with what's on screen.
   *
   * Returns, per commodity: store_qty, dispensary_qty (from `stock`), dsd_qty
   * (dsd_stock), sdp_qty (sdp_stock), baseline_amc, and has_stock.
   *
   * Semantics are a deliberate, test-locked reproduction of the client-side path:
   *  - store_qty / dispensary_qty sum `stock.quantity` by location_type, exactly
   *    as groupStockByComm does.
   *  - baseline_amc is a PER-FACILITY figure duplicated across a facility's
   *    store/dispensary rows, so take one value per facility (max, guarding a
   *    duplicate disagreement) and sum across facilities — a multi-facility scope
   *    gets a true scope-wide baseline, not one facility's. Summed as `numeric`
   *    (exact) and converted once at the end; the browser's float accumulation
   *    across hundreds of facilities drifted ~1e-11, below the .toFixed(1) display.
   *  - has_stock mirrors `!!gMap[c.id]` — a `stock` row exists in scope, at ANY
   *    location_type — which the callers use for the "in use here" signal and the
   *    Essential-module catalogue filter.
   *  - a commodity with only DSD/SDP site stock and no `stock` row still appears
   *    (has_stock false), matching the client-side union of the three sources.
   *
   * Scoping mirrors getScopedStock: `facilityIds` null = all (unconstrained),
   * an array = only those, [] = short-circuit to none. `commodityIds` narrows to a
   * section-filtered catalogue; `categories` enforces the caller's section.
   */
  static async getScopedStockSummary({ facilityIds = null, commodityIds = null, categories = null } = {}) {
    if (Array.isArray(facilityIds) && facilityIds.length === 0) return []

    // One parameter list shared by all four branches, so the same filter lands on
    // `stock`, `dsd_stock` and `sdp_stock` identically.
    const params = []
    const facIdx = Array.isArray(facilityIds) ? (params.push(facilityIds), params.length) : null
    const commIdx = (Array.isArray(commodityIds) && commodityIds.length) ? (params.push(commodityIds), params.length) : null
    const catIdx = (Array.isArray(categories) && categories.length) ? (params.push(categories), params.length) : null

    // `t` is the aliased source table in each branch.
    const filt = t => [
      facIdx ? ` and ${t}.facility_id = any($${facIdx})` : '',
      commIdx ? ` and ${t}.commodity_id = any($${commIdx})` : '',
      catIdx ? ` and c.category = any($${catIdx})` : '',
    ].join('')

    const sql = `
      with s as (
        select st.commodity_id,
               sum(st.quantity) filter (where st.location_type = 'store')::int      as store_qty,
               sum(st.quantity) filter (where st.location_type = 'dispensary')::int as dispensary_qty,
               count(*)::int as stock_rows
          from stock st
          join commodities c on c.id = st.commodity_id
         where true${filt('st')}
         group by st.commodity_id
      ),
      b as (
        select commodity_id, sum(fac_amc) as baseline_amc
          from (
            select st.commodity_id, st.facility_id, max(st.baseline_amc) as fac_amc
              from stock st
              join commodities c on c.id = st.commodity_id
             where st.baseline_amc > 0${filt('st')}
             group by st.commodity_id, st.facility_id
          ) per_facility
         group by commodity_id
      ),
      d as (
        select dd.commodity_id, sum(dd.quantity)::int as qty
          from dsd_stock dd
          join commodities c on c.id = dd.commodity_id
         where true${filt('dd')}
         group by dd.commodity_id
      ),
      p as (
        select sp.commodity_id, sum(sp.quantity)::int as qty
          from sdp_stock sp
          join commodities c on c.id = sp.commodity_id
         where true${filt('sp')}
         group by sp.commodity_id
      )
      select c.id                              as commodity_id,
             coalesce(s.store_qty, 0)          as store_qty,
             coalesce(s.dispensary_qty, 0)     as dispensary_qty,
             coalesce(d.qty, 0)                as dsd_qty,
             coalesce(p.qty, 0)                as sdp_qty,
             coalesce(b.baseline_amc, 0)::float8 as baseline_amc,
             coalesce(s.stock_rows, 0) > 0     as has_stock
        from commodities c
        left join s on s.commodity_id = c.id
        left join b on b.commodity_id = c.id
        left join d on d.commodity_id = c.id
        left join p on p.commodity_id = c.id
       where coalesce(s.stock_rows, 0) > 0 or d.qty is not null or p.qty is not null`

    const { rows } = await query(sql, params)
    return rows
  }

  /**
   * The same rollup at (commodity, FACILITY) grain — one row per pair that holds
   * stock anywhere. All Facilities needs this finer grain: it counts reporting
   * sites and per-site stock status per commodity, which a commodity-grain total
   * cannot answer. Today it derives that from the whole 5.58 MB stock array plus
   * two paginated site-stock drains.
   *
   * Columns mirror getScopedStockSummary, with one addition: `other_qty` carries
   * `stock` rows whose location_type is neither store nor dispensary. There are
   * none in the local dataset, but the client folds any such row into its DSD
   * column, so returning it separately means the caller can reproduce the old
   * arithmetic exactly rather than silently dropping units if production differs.
   *
   * `commodityId` narrows to one commodity for the drill-down, which is the only
   * view that needs every facility at once.
   */
  static async getScopedStockByFacility({ facilityIds = null, commodityIds = null, categories = null, commodityId = null } = {}) {
    if (Array.isArray(facilityIds) && facilityIds.length === 0) return []

    const params = []
    const facIdx = Array.isArray(facilityIds) ? (params.push(facilityIds), params.length) : null
    const commIdx = (Array.isArray(commodityIds) && commodityIds.length) ? (params.push(commodityIds), params.length) : null
    const catIdx = (Array.isArray(categories) && categories.length) ? (params.push(categories), params.length) : null
    const oneIdx = commodityId ? (params.push(commodityId), params.length) : null

    const filt = t => [
      facIdx ? ` and ${t}.facility_id = any($${facIdx})` : '',
      commIdx ? ` and ${t}.commodity_id = any($${commIdx})` : '',
      catIdx ? ` and c.category = any($${catIdx})` : '',
      oneIdx ? ` and ${t}.commodity_id = $${oneIdx}` : '',
    ].join('')

    const sql = `
      with s as (
        select st.commodity_id, st.facility_id,
               sum(st.quantity) filter (where st.location_type = 'store')::int      as store_qty,
               sum(st.quantity) filter (where st.location_type = 'dispensary')::int as dispensary_qty,
               sum(st.quantity) filter (where st.location_type not in ('store','dispensary'))::int as other_qty,
               max(st.baseline_amc)                                                 as baseline_amc,
               count(*)::int                                                        as stock_rows
          from stock st
          join commodities c on c.id = st.commodity_id
         where true${filt('st')}
         group by st.commodity_id, st.facility_id
      ),
      d as (
        select dd.commodity_id, dd.facility_id, sum(dd.quantity)::int as qty
          from dsd_stock dd
          join commodities c on c.id = dd.commodity_id
         where true${filt('dd')}
         group by dd.commodity_id, dd.facility_id
      ),
      p as (
        select sp.commodity_id, sp.facility_id, sum(sp.quantity)::int as qty
          from sdp_stock sp
          join commodities c on c.id = sp.commodity_id
         where true${filt('sp')}
         group by sp.commodity_id, sp.facility_id
      ),
      keys as (
        select commodity_id, facility_id from s
        union select commodity_id, facility_id from d
        union select commodity_id, facility_id from p
      )
      select k.commodity_id, k.facility_id,
             coalesce(s.store_qty, 0)            as store_qty,
             coalesce(s.dispensary_qty, 0)       as dispensary_qty,
             coalesce(s.other_qty, 0)            as other_qty,
             coalesce(d.qty, 0)                  as dsd_qty,
             coalesce(p.qty, 0)                  as sdp_qty,
             coalesce(s.baseline_amc, 0)::float8 as baseline_amc,
             coalesce(s.stock_rows, 0) > 0       as has_stock
        from keys k
        left join s on s.commodity_id = k.commodity_id and s.facility_id = k.facility_id
        left join d on d.commodity_id = k.commodity_id and d.facility_id = k.facility_id
        left join p on p.commodity_id = k.commodity_id and p.facility_id = k.facility_id`

    const { rows } = await query(sql, params)
    return rows
  }

  /**
   * On-hand lots (per-batch balances) across a scope, from the AUTHORITATIVE lot
   * ledger (stock_lot) — the same source the dispense picker uses, so an expiry
   * view built on this matches what a store manager can actually dispatch. Unlike
   * the old intake-history estimate, an already-expired batch still on hand shows
   * up (it isn't inferred away), and the per-batch quantities reconcile to the
   * bin totals.
   *
   * Lots of the same (facility, commodity, batch, expiry) are summed across bins
   * (store + dispensary + DSD/SDP) so a commodity reads as one batch, not one row
   * per location. `facilityIds` null = all in scope; [] = none. `categories`
   * enforces the caller's section. `expiryTo` (ISO date) caps the look-ahead;
   * already-expired lots are always included. `includeUnknown` keeps null-expiry
   * lots (they can't be bucketed, but the modal lists them).
   */
  static async getScopedLots({ facilityIds = null, commodityIds = null, categories = null, expiryTo = null, includeUnknown = false } = {}) {
    if (Array.isArray(facilityIds) && facilityIds.length === 0) return []

    const params = []
    const conds = ['l.quantity > 0']
    if (Array.isArray(facilityIds)) { params.push(facilityIds); conds.push(`l.facility_id = any($${params.length})`) }
    if (Array.isArray(commodityIds) && commodityIds.length) { params.push(commodityIds); conds.push(`l.commodity_id = any($${params.length})`) }
    if (Array.isArray(categories) && categories.length) { params.push(categories); conds.push(`c.category = any($${params.length})`) }
    // Expiry window: keep everything already expired (< today) OR expiring on/before
    // the cutoff. null-expiry lots pass only when includeUnknown is set.
    if (expiryTo) {
      params.push(expiryTo)
      conds.push(`(l.expiry_date < current_date or l.expiry_date <= $${params.length}${includeUnknown ? ' or l.expiry_date is null' : ''})`)
    } else if (!includeUnknown) {
      conds.push('l.expiry_date is not null')
    }

    const sql = `
      select l.facility_id, l.commodity_id, l.batch_number, l.expiry_date,
             sum(l.quantity)::int as quantity,
             ${COMMODITY_OBJ}, ${FACILITY_OBJ}
      from stock_lot l
      left join facilities f on f.id = l.facility_id
      left join commodities c on c.id = l.commodity_id
      where ${conds.join(' and ')}
      group by l.facility_id, l.commodity_id, l.batch_number, l.expiry_date,
               c.id, f.id
      order by l.expiry_date asc nulls last`
    const { rows } = await query(sql, params)
    return rows
  }

  /**
   * Get DSD stock for one facility (`facilityId`) or a set (`facilityIds`, for
   * admin/aggregate views), optionally a single site or commodity. Embeds both
   * commodity and facility objects (SiteBreakdownModal reads facilities.name).
   */
  static async getDsdStock(facilityId, options = {}) {
    const { dsdSiteName, commodityId, facilityIds, categories = null, limit = 1000, offset = 0 } = options
    if (!facilityId && Array.isArray(facilityIds) && facilityIds.length === 0) return []

    const params = []
    const conds = []
    if (facilityId) { params.push(facilityId); conds.push(`d.facility_id = $${params.length}`) }
    else if (Array.isArray(facilityIds)) { params.push(facilityIds); conds.push(`d.facility_id = any($${params.length})`) }
    // Site names can drift in case/whitespace between the store dispatch and the
    // DSD account (e.g. "VINZORB Pharmacy" vs "Vinzorb Pharmacy"), so match loosely.
    if (dsdSiteName) { params.push(dsdSiteName); conds.push(`lower(btrim(d.dsd_site_name)) = lower(btrim($${params.length}))`) }
    if (commodityId) { params.push(commodityId); conds.push(`d.commodity_id = $${params.length}`) }
    if (Array.isArray(categories) && categories.length) { params.push(categories); conds.push(`c.category = any($${params.length})`) }

    let sql = `
      select d.id, d.facility_id, d.dsd_site_name, d.commodity_id, d.quantity, d.updated_at,
             ${COMMODITY_OBJ}, ${FACILITY_OBJ}
      from dsd_stock d
      left join commodities c on c.id = d.commodity_id
      left join facilities f on f.id = d.facility_id`
    if (conds.length) sql += ` where ${conds.join(' and ')}`

    params.push(limit, offset)
    sql += ` order by c.name nulls last limit $${params.length - 1} offset $${params.length}`

    const { rows } = await query(sql, params)
    return rows
  }

  /**
   * Get SDP stock for one facility (`facilityId`) or a set (`facilityIds`),
   * optionally a single site or commodity. Embeds commodity + facility objects.
   */
  static async getSdpStock(facilityId, options = {}) {
    const { sdpName, commodityId, facilityIds, categories = null, limit = 1000, offset = 0 } = options
    if (!facilityId && Array.isArray(facilityIds) && facilityIds.length === 0) return []

    const params = []
    const conds = []
    if (facilityId) { params.push(facilityId); conds.push(`sp.facility_id = $${params.length}`) }
    else if (Array.isArray(facilityIds)) { params.push(facilityIds); conds.push(`sp.facility_id = any($${params.length})`) }
    // Match loosely on case/whitespace so a differently-cased site name still resolves.
    if (sdpName) { params.push(sdpName); conds.push(`lower(btrim(sp.sdp_name)) = lower(btrim($${params.length}))`) }
    if (commodityId) { params.push(commodityId); conds.push(`sp.commodity_id = $${params.length}`) }
    if (Array.isArray(categories) && categories.length) { params.push(categories); conds.push(`c.category = any($${params.length})`) }

    let sql = `
      select sp.id, sp.facility_id, sp.sdp_name, sp.commodity_id, sp.quantity, sp.updated_at,
             ${COMMODITY_OBJ}, ${FACILITY_OBJ}
      from sdp_stock sp
      left join commodities c on c.id = sp.commodity_id
      left join facilities f on f.id = sp.facility_id`
    if (conds.length) sql += ` where ${conds.join(' and ')}`

    params.push(limit, offset)
    sql += ` order by c.name nulls last limit $${params.length - 1} offset $${params.length}`

    const { rows } = await query(sql, params)
    return rows
  }

  /**
   * Create a new stock record.
   */
  static async createStock(stockData, exec = query) {
    const { facility_id, commodity_id, quantity, location_type } = stockData

    if (!facility_id || !commodity_id || quantity === undefined || !location_type) {
      throw new Error('Missing required fields: facility_id, commodity_id, quantity, location_type')
    }

    const { rows } = await exec(
      `insert into stock (facility_id, commodity_id, quantity, location_type, updated_at)
       values ($1, $2, $3, $4, now())
       returning *`,
      [facility_id, commodity_id, parseInt(quantity), location_type]
    )
    return rows[0] || null
  }

  /**
   * Update stock quantity (absolute set).
   */
  // Keep the lot ledger consistent with a DIRECT (absolute) quantity set on a bin
  // — a manual admin edit / upsert that carries no batch. An increase goes to an
  // unknown-expiry lot; a decrease draws FEFO. Movement paths do NOT go through
  // here — they call LotService explicitly alongside increment/decrement, so this
  // never double-counts.
  // The on-hand lots of one bin (store / dispensary / a DSD or SDP site), from the
  // lot ledger, soonest-expiry first. Powers the dispense batch picker.
  static async getBinLots({ facility_id, commodity_id, location_type, site_name }) {
    // Re-sync the ledger to the authoritative bin stock before showing it, so the
    // picker's "N left" matches Stock Levels even if the ledger had drifted.
    try {
      await withTransaction(exec => LotService.reconcile(exec,
        { facility_id, commodity_id, location_type, site_name: site_name || null }))
    } catch { /* reconcile is best-effort — never block reading the lots */ }
    const { rows } = await query(
      `select id, batch_number, expiry_date, quantity
         from stock_lot
        where facility_id = $1 and commodity_id = $2 and location_type = $3
          and coalesce(site_name,'') = coalesce($4,'') and quantity > 0
        order by expiry_date asc nulls last, batch_number`,
      [facility_id, commodity_id, location_type, site_name || null]
    )
    return rows
  }

  static async getLotById(lotId) {
    const { rows } = await query('select * from stock_lot where id = $1', [lotId])
    return rows[0] || null
  }

  // Record the batch / expiry of an existing lot. METADATA ONLY — the quantity is
  // never changed, so a bin's total and the sum(lots) invariant are untouched. Used
  // to label the "unknown expiry" lots the seed produced where no receipt carried a
  // usable expiry. If the new identity already exists in the same bin the two lots
  // are merged (quantities added) rather than colliding on the unique index.
  static async relabelLot(lotId, { batch_number = null, expiry_date = null }) {
    return withTransaction(async exec => {
      const { rows: cur } = await exec('select * from stock_lot where id = $1 for update', [lotId])
      const lot = cur[0]
      if (!lot) return null

      const batch = (batch_number ?? '').toString().trim() || null
      const expiry = ymd(expiry_date)

      const { rows: dup } = await exec(
        `select id from stock_lot
          where facility_id=$1 and commodity_id=$2 and location_type=$3
            and coalesce(site_name,'') = coalesce($4,'')
            and coalesce(batch_number,'') = coalesce($5,'')
            and coalesce(expiry_date,'0001-01-01'::date) = coalesce($6::date,'0001-01-01'::date)
            and id <> $7`,
        [lot.facility_id, lot.commodity_id, lot.location_type, lot.site_name, batch, expiry, lotId]
      )
      if (dup[0]) {
        await exec('update stock_lot set quantity = quantity + $2, updated_at = now() where id = $1', [dup[0].id, lot.quantity])
        await exec('delete from stock_lot where id = $1', [lotId])
        const { rows } = await exec('select * from stock_lot where id = $1', [dup[0].id])
        return rows[0] || null
      }
      const { rows } = await exec(
        'update stock_lot set batch_number = $2, expiry_date = $3, updated_at = now() where id = $1 returning *',
        [lotId, batch, expiry]
      )
      return rows[0] || null
    })
  }

  static async _reconcileLots(exec, bin, oldQty, newQty) {
    const delta = Math.round(Number(newQty) || 0) - Math.round(Number(oldQty) || 0)
    if (delta > 0) await LotService.credit(exec, bin, { qty: delta })
    else if (delta < 0) await LotService.debit(exec, bin, -delta)
  }

  static async updateStock(stockId, updateData) {
    const { quantity } = updateData
    if (quantity === undefined) throw new Error('Missing required field: quantity')

    return await withTransaction(async exec => {
      const { rows: cur } = await exec('select facility_id, commodity_id, location_type, quantity from stock where id = $1', [stockId])
      const old = cur[0]
      const { rows } = await exec(
        `update stock set quantity = $2, updated_at = now() where id = $1 returning *`,
        [stockId, parseInt(quantity)]
      )
      if (old) await StockService._reconcileLots(exec,
        { facility_id: old.facility_id, commodity_id: old.commodity_id, location_type: old.location_type, site_name: null },
        old.quantity, quantity)
      return rows[0] || null
    })
  }

  /**
   * Upsert store/dispensary stock by its natural key
   * (facility_id, commodity_id, location_type), setting an absolute quantity.
   * Mirrors the frontend's find-then-insert/update pattern in one atomic
   * statement via the unique constraint on those three columns.
   */
  static async upsertStock(stockData, exec = query) {
    const { facility_id, commodity_id, location_type, quantity } = stockData
    if (!facility_id || !commodity_id || !location_type || quantity === undefined) {
      throw new Error('Missing required fields: facility_id, commodity_id, location_type, quantity')
    }
    const existing = await StockService.getStockByFacilityAndCommodity(facility_id, commodity_id, location_type, exec)
    const { rows } = await exec(
      `insert into stock (facility_id, commodity_id, location_type, quantity, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (facility_id, commodity_id, location_type)
       do update set quantity = excluded.quantity, updated_at = now()
       returning *`,
      [facility_id, commodity_id, location_type, parseInt(quantity)]
    )
    await StockService._reconcileLots(exec,
      { facility_id, commodity_id, location_type, site_name: null }, existing?.quantity || 0, quantity)
    return rows[0] || null
  }

  /**
   * Upsert DSD site stock by (facility_id, dsd_site_name, commodity_id).
   */
  static async upsertDsdStock(stockData, exec = query) {
    const { facility_id, dsd_site_name, commodity_id, quantity } = stockData
    if (!facility_id || !dsd_site_name || !commodity_id || quantity === undefined) {
      throw new Error('Missing required fields: facility_id, dsd_site_name, commodity_id, quantity')
    }
    // Update an existing row for this site even if its casing/whitespace differs,
    // so a re-cased dispatch doesn't fork the site into a duplicate partition.
    const existing = await StockService.getDsdStockByFacilitySiteCommodity(facility_id, dsd_site_name, commodity_id, exec)
    if (existing) return await StockService.updateDsdStock(existing.id, quantity, exec)
    await StockService._reconcileLots(exec,
      { facility_id, commodity_id, location_type: 'dsd', site_name: dsd_site_name }, 0, quantity)
    const { rows } = await exec(
      `insert into dsd_stock (facility_id, dsd_site_name, commodity_id, quantity, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (facility_id, dsd_site_name, commodity_id)
       do update set quantity = excluded.quantity, updated_at = now()
       returning *`,
      [facility_id, dsd_site_name, commodity_id, parseInt(quantity)]
    )
    return rows[0] || null
  }

  /**
   * Upsert SDP site stock by (facility_id, sdp_name, commodity_id).
   */
  static async upsertSdpStock(stockData, exec = query) {
    const { facility_id, sdp_name, commodity_id, quantity } = stockData
    if (!facility_id || !sdp_name || !commodity_id || quantity === undefined) {
      throw new Error('Missing required fields: facility_id, sdp_name, commodity_id, quantity')
    }
    // Update an existing row for this site even if its casing/whitespace differs,
    // so a re-cased dispatch doesn't fork the site into a duplicate partition.
    const existing = await StockService.getSdpStockByFacilitySiteCommodity(facility_id, sdp_name, commodity_id, exec)
    if (existing) return await StockService.updateSdpStock(existing.id, quantity, exec)
    await StockService._reconcileLots(exec,
      { facility_id, commodity_id, location_type: 'sdp', site_name: sdp_name }, 0, quantity)
    const { rows } = await exec(
      `insert into sdp_stock (facility_id, sdp_name, commodity_id, quantity, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (facility_id, sdp_name, commodity_id)
       do update set quantity = excluded.quantity, updated_at = now()
       returning *`,
      [facility_id, sdp_name, commodity_id, parseInt(quantity)]
    )
    return rows[0] || null
  }

  /**
   * Set DSD site stock quantity (absolute) by row id. Returns null if not found.
   */
  static async updateDsdStock(id, quantity, exec = query) {
    if (quantity === undefined) throw new Error('Missing required field: quantity')
    const { rows: cur } = await exec('select facility_id, commodity_id, dsd_site_name, quantity from dsd_stock where id = $1', [id])
    const old = cur[0]
    const { rows } = await exec(
      `update dsd_stock set quantity = $2, updated_at = now() where id = $1 returning *`,
      [id, parseInt(quantity)]
    )
    if (old) await StockService._reconcileLots(exec,
      { facility_id: old.facility_id, commodity_id: old.commodity_id, location_type: 'dsd', site_name: old.dsd_site_name },
      old.quantity, quantity)
    return rows[0] || null
  }

  /**
   * Set SDP site stock quantity (absolute) by row id. Returns null if not found.
   */
  static async updateSdpStock(id, quantity, exec = query) {
    if (quantity === undefined) throw new Error('Missing required field: quantity')
    const { rows: cur } = await exec('select facility_id, commodity_id, sdp_name, quantity from sdp_stock where id = $1', [id])
    const old = cur[0]
    const { rows } = await exec(
      `update sdp_stock set quantity = $2, updated_at = now() where id = $1 returning *`,
      [id, parseInt(quantity)]
    )
    if (old) await StockService._reconcileLots(exec,
      { facility_id: old.facility_id, commodity_id: old.commodity_id, location_type: 'sdp', site_name: old.sdp_name },
      old.quantity, quantity)
    return rows[0] || null
  }

  /**
   * Get stock record by ID with nested facility/commodity details.
   */
  static async getStockById(stockId) {
    const { rows } = await query(
      `select s.id, s.facility_id, s.commodity_id, s.quantity, s.tablet_buffer,
              s.baseline_amc, s.updated_at, s.location_type,
              json_build_object('id', f.id, 'name', f.name) as facilities,
              json_build_object('id', c.id, 'name', c.name, 'category', c.category, 'unit', c.unit) as commodities
       from stock s
       left join facilities f on f.id = s.facility_id
       left join commodities c on c.id = s.commodity_id
       where s.id = $1`,
      [stockId]
    )
    return rows[0] || null
  }

  /**
   * Get stock by facility + commodity (defaults to the store location).
   * Returns null when not found.
   */
  static async getStockByFacilityAndCommodity(facilityId, commodityId, locationType = 'store', exec = query) {
    const { rows } = await exec(
      `select * from stock
       where facility_id = $1 and commodity_id = $2 and location_type = $3
       limit 1`,
      [facilityId, commodityId, locationType]
    )
    return rows[0] || null
  }

  /**
   * Get DSD stock by facility + site + commodity. Returns null when not found.
   */
  static async getDsdStockByFacilitySiteCommodity(facilityId, dsdSiteName, commodityId, exec = query) {
    const { rows } = await exec(
      `select * from dsd_stock
       where facility_id = $1 and lower(btrim(dsd_site_name)) = lower(btrim($2)) and commodity_id = $3
       limit 1`,
      [facilityId, dsdSiteName, commodityId]
    )
    return rows[0] || null
  }

  /**
   * Get SDP stock by facility + site + commodity. Returns null when not found.
   */
  static async getSdpStockByFacilitySiteCommodity(facilityId, sdpName, commodityId, exec = query) {
    const { rows } = await exec(
      `select * from sdp_stock
       where facility_id = $1 and lower(btrim(sdp_name)) = lower(btrim($2)) and commodity_id = $3
       limit 1`,
      [facilityId, sdpName, commodityId]
    )
    return rows[0] || null
  }

  /**
   * Get a DSD stock row by id (for scope checks / existence). Null if not found.
   */
  static async getDsdStockById(id) {
    const { rows } = await query('select * from dsd_stock where id = $1 limit 1', [id])
    return rows[0] || null
  }

  /**
   * Get an SDP stock row by id (for scope checks / existence). Null if not found.
   */
  static async getSdpStockById(id) {
    const { rows } = await query('select * from sdp_stock where id = $1 limit 1', [id])
    return rows[0] || null
  }

  /**
   * Increment stock quantity atomically.
   */
  static async incrementStock(stockId, amount, exec = query) {
    const { rows } = await exec(
      `update stock set quantity = quantity + $2, updated_at = now()
       where id = $1 returning *`,
      [stockId, parseInt(amount)]
    )
    if (!rows[0]) throw new Error('Stock record not found')
    return rows[0]
  }

  /**
   * Decrement stock quantity atomically (never below 0).
   *
   * NOTE: the greatest(0, …) clamp silently absorbs an overdraft — the caller's
   * movement row still records the full amount, so the bin drifts from its ledger
   * and the difference resurfaces later as a bin-card opening balance. Consumption
   * paths must pre-check with assertBinCovers() (or use decrementStockStrict) so the
   * write is rejected instead of quietly clamped.
   */
  static async decrementStock(stockId, amount, exec = query) {
    const { rows } = await exec(
      `update stock set quantity = greatest(0, quantity - $2), updated_at = now()
       where id = $1 returning *`,
      [stockId, parseInt(amount)]
    )
    if (!rows[0]) throw new Error('Stock record not found')
    return rows[0]
  }

  /**
   * Decrement stock, refusing to go negative. Returns null when the row would be
   * overdrawn (no write performed) so the caller can reject the whole transaction
   * rather than clamp and leave a movement the stock never funded.
   */
  static async decrementStockStrict(stockId, amount, exec = query) {
    const { rows } = await exec(
      `update stock set quantity = quantity - $2, updated_at = now()
       where id = $1 and quantity >= $2 returning *`,
      [stockId, parseInt(amount)]
    )
    return rows[0] || null
  }

  /**
   * Check if a commodity exists.
   */
  static async commodityExists(commodityId) {
    const { rows } = await query('select 1 from commodities where id = $1 limit 1', [commodityId])
    return rows.length > 0
  }

  /**
   * Check if a facility exists.
   */
  static async facilityExists(facilityId) {
    const { rows } = await query('select 1 from facilities where id = $1 limit 1', [facilityId])
    return rows.length > 0
  }
}
