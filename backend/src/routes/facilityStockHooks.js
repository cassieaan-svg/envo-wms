import express from 'express'
import { query } from '../db.js'

const router = express.Router()

// AMC definitions mirror frontend/src/utils/helpers.js. Kept in step deliberately: the
// warehouse must see the same AMC and MOS a facility sees in EnVo, or the two apps end up
// disagreeing about whether a site is understocked.
const AMC_WINDOW_MONTHS = 2
const QUARTER_MONTHS = 3

function quarterStart(from) {
  const m = Math.floor(from.getMonth() / QUARTER_MONTHS) * QUARTER_MONTHS
  return new Date(from.getFullYear(), m, 1)
}

function monthFloor(ym) {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, (m || 1) - 1, 1)
}

// A facility may override the default quarterly window with an explicit set of months
// (not necessarily contiguous). The divisor is then the number of months chosen.
function resolveAmcWindow(months, from = new Date()) {
  const picked = Array.isArray(months) ? [...new Set(months.filter(Boolean))].sort() : []
  if (picked.length) {
    const start = monthFloor(picked[0])
    const last = monthFloor(picked[picked.length - 1])
    return {
      start,
      end: new Date(last.getFullYear(), last.getMonth() + 1, 1),
      monthSet: picked,
      months: picked.length,
      custom: true,
      // The chosen months themselves, which for a non-contiguous set is not the same as
      // every month between start and end.
      monthsUsed: picked,
    }
  }
  const end = quarterStart(from)
  const start = new Date(end.getFullYear(), end.getMonth() - AMC_WINDOW_MONTHS, 1)
  return {
    start,
    end,
    monthSet: null,
    months: AMC_WINDOW_MONTHS,
    custom: false,
    monthsUsed: monthsBetween(start, end),
  }
}

// The calendar months a window actually averages, as 'YYYY-MM'. `end` is exclusive, so a
// May 1 → Jul 1 window yields ['2026-05', '2026-06'].
function monthsBetween(start, end) {
  const out = []
  const cur = new Date(start.getFullYear(), start.getMonth(), 1)
  while (cur < end) {
    out.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`)
    cur.setMonth(cur.getMonth() + 1)
  }
  return out
}

// The window bounds are local-midnight Dates; toISOString would shift them a day back in
// any positive-offset zone (WAT included), so the label is built from local parts.
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function stockStatus(qty, amc) {
  if (!qty || qty <= 0) return 'out'
  if (!amc || amc <= 0) return 'unknown'
  const mos = qty / amc
  if (mos < 2) return 'low'
  if (mos > 4) return 'over'
  return 'ok'
}

// Service-to-service: the WMS reads a facility's Essential Commodities position so the
// warehouse can see what a site already holds and how fast it is moving. Mounted under
// /hooks with serviceAuth (outside the user-JWT layer). The WMS identifies the facility by
// the code it stores as envo_facility_id (EnVo's facilities.code).
//
// GET /hooks/facilities/:code/stock
//   -> { facilityId, facilityName, asOf, amcWindow:{ from, to, months, custom },
//        items:[{ commodityId, name, unit, quantityOnHand, amc, mos, status }] }
// where commodityId is the WMS commodity id (wms_commodity_id), so the warehouse can map
// each line back to its own catalogue.
router.get('/:code/stock', async (req, res) => {
  try {
    const { rows: f } = await query('select id, name from facilities where code = $1', [req.params.code])
    const facility = f[0]
    if (!facility) return res.status(404).json({ error: 'facility not found' })

    const { rows: settings } = await query(
      'select months from facility_amc_settings where facility_id = $1',
      [facility.id]
    )
    const amcWin = resolveAmcWindow(settings[0]?.months)

    // Consumption is aggregated in its own CTE and left-joined, so a commodity that was
    // never dispensed in the window still returns a row (amc 0) instead of dropping out.
    const { rows } = await query(
      `with dispensed as (
         select d.commodity_id,
                sum(d.quantity)::numeric as total
           from dispense_log d
          where d.facility_id = $1
            and d.dispensed_at >= $2
            and d.dispensed_at <  $3
            and ($4::text[] is null or to_char(d.dispensed_at, 'YYYY-MM') = any($4))
          group by d.commodity_id
       )
       select c.wms_commodity_id as "commodityId",
              c.name,
              c.unit,
              sum(s.quantity)::int as "quantityOnHand",
              max(s.baseline_amc)::numeric as baseline_amc,
              coalesce(max(dp.total), 0)::numeric as dispensed_total
         from stock s
         join commodities c on c.id = s.commodity_id
         left join dispensed dp on dp.commodity_id = s.commodity_id
        where s.facility_id = $1
          and c.module = 'essential'
        group by c.wms_commodity_id, c.name, c.unit
       having sum(s.quantity) > 0
        order by c.name`,
      [facility.id, amcWin.start, amcWin.end, amcWin.monthSet]
    )

    const items = rows.map((r) => {
      const computed = amcWin.months > 0 ? Number(r.dispensed_total) / amcWin.months : 0
      // Fall back to the stored baseline when nothing moved in the window, so a site with
      // no dispensing history doesn't read as "unknown" indefinitely.
      const amc = computed > 0 ? computed : Number(r.baseline_amc || 0)
      const qty = Number(r.quantityOnHand)
      return {
        commodityId: r.commodityId,
        name: r.name,
        unit: r.unit,
        quantityOnHand: qty,
        amc: amc > 0 ? +amc.toFixed(1) : 0,
        mos: amc > 0 ? +(qty / amc).toFixed(1) : null,
        status: stockStatus(qty, amc),
      }
    })

    res.json({
      facilityId: req.params.code,
      facilityName: facility.name,
      asOf: new Date().toISOString(),
      amcWindow: {
        from: ymd(amcWin.start),
        to: ymd(amcWin.end),
        months: amcWin.months,
        monthsUsed: amcWin.monthsUsed,
        custom: amcWin.custom,
      },
      items,
    })
  } catch (err) {
    console.error('facility stock hook error:', err)
    res.status(500).json({ error: err.message })
  }
})

export default router
