import { query } from '../db.js'

const WMS_API_URL = process.env.WMS_API_URL || 'http://localhost:5100'
const SERVICE_TOKEN = process.env.SERVICE_TOKEN
const svcHeaders = { 'Content-Type': 'application/json', 'x-service-token': SERVICE_TOKEN || '' }

/**
 * What facilities owe the central medical store, READ from the WMS.
 *
 * EnVo deliberately does not compute this. The WMS owns prices, the dispatch and the
 * payments, so it is the single source of truth for money — if both systems derived a
 * balance, a facility would see one figure on its screen and the store would quote
 * another, with nothing to say which is right.
 *
 * The WMS keys facilities by the code EnVo sends on a request (facilities.code), so the
 * result is mapped back onto EnVo facility ids here.
 */
export class FacilityDebtService {
  /**
   * Balances for a set of EnVo facility ids (null = every facility in scope).
   * Returns [] rather than throwing if the warehouse is unreachable: an unavailable
   * balance must not take down the page it appears on — the caller shows it as unknown.
   */
  static async forFacilities(facilityIds = null) {
    const { rows: facs } = facilityIds === null
      ? await query('select id, code, name from facilities where code is not null')
      : facilityIds.length === 0
        ? { rows: [] }
        : await query('select id, code, name from facilities where code is not null and id = any($1)', [facilityIds])
    if (!facs.length) return []

    const byCode = new Map(facs.map(f => [f.code, f]))
    const url = new URL(`${WMS_API_URL}/inbound/balances`)
    // Only ask for the codes in scope; the WMS answers for every mapped facility if the
    // parameter is omitted, which would leak balances outside an admin's jurisdiction.
    url.searchParams.set('envoFacilityIds', facs.map(f => f.code).join(','))

    let rows
    try {
      const res = await fetch(url, { headers: svcHeaders })
      if (!res.ok) throw new Error(`WMS /inbound/balances -> ${res.status}`)
      rows = await res.json()
    } catch (err) {
      console.error('Could not read balances from the WMS:', err.message)
      const e = new Error('The central store could not be reached for balances')
      e.status = 503
      throw e
    }

    return rows
      .map(r => {
        const f = byCode.get(r.envo_facility_id)
        if (!f) return null   // a WMS facility EnVo doesn't know; not this caller's business
        return {
          facility_id: f.id,
          facility_name: f.name,
          billed: Number(r.billed || 0),
          paid: Number(r.paid || 0),
          outstanding: Number(r.outstanding || 0),
          unpaid_orders: r.unpaid_orders || 0,
          oldest_unpaid_at: r.oldest_unpaid_at || null,
        }
      })
      .filter(Boolean)
  }

  /**
   * What the store has ISSUED to facilities, aggregated — read from the WMS.
   *
   * Built on dispatch orders rather than EnVo's own warehouse_requests, so it covers
   * BOTH orders a facility raised through EnVo and direct dispatches raised at the
   * warehouse. Reading only EnVo's requests is what made Spend report ₦0 issued beside
   * a six-figure debt: every order behind that debt was a direct dispatch.
   */
  static async spend({ facilityIds = null, groupBy = 'facility', from = null, to = null, scheme = null } = {}) {
    const { rows: facs } = facilityIds === null
      ? await query('select id, code, name from facilities where code is not null')
      : facilityIds.length === 0
        ? { rows: [] }
        : await query('select id, code, name from facilities where code is not null and id = any($1)', [facilityIds])
    if (!facs.length) return []

    const url = new URL(`${WMS_API_URL}/inbound/spend`)
    url.searchParams.set('group_by', groupBy)
    // Always scoped: omitting this would have the WMS answer for every facility it
    // knows, past the caller's jurisdiction.
    url.searchParams.set('envoFacilityIds', facs.map(f => f.code).join(','))
    if (from) url.searchParams.set('from', from)
    if (to) url.searchParams.set('to', to)
    if (scheme) url.searchParams.set('scheme', scheme)

    let rows
    try {
      const res = await fetch(url, { headers: svcHeaders })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        const e = new Error(body.error || `WMS /inbound/spend -> ${res.status}`)
        e.status = res.status === 400 ? 400 : 503
        throw e
      }
      rows = await res.json()
    } catch (err) {
      if (err.status === 400) throw err
      console.error('Could not read spend from the WMS:', err.message)
      const e = new Error('The central store could not be reached for spend')
      e.status = 503
      throw e
    }

    // The facility grain comes back keyed by WMS code; map it onto EnVo ids so the
    // client can drill into a facility it knows.
    const byCode = new Map(facs.map(f => [f.code, f]))
    return rows.map(r => ({
      key: groupBy === 'facility' ? (byCode.get(r.key)?.id ?? r.key) : r.key,
      label: groupBy === 'facility' ? (byCode.get(r.key)?.name ?? r.label) : r.label,
      orders: Number(r.orders || 0),
      quantity: Number(r.quantity || 0),
      issued: Number(r.issued || 0),
      paid: Number(r.paid || 0),
      outstanding: Number(r.outstanding || 0),
    }))
  }

  /**
   * The orders behind one facility's balance, with their instalments.
   *
   * Most of these are DIRECT dispatches — raised at the warehouse with no EnVo request.
   * EnVo's own warehouse_requests table cannot show them, which is why a facility could
   * see "0 requests" beside a balance of hundreds of thousands. This closes that gap.
   */
  static async ordersFor(facilityId) {
    const { rows } = await query('select code, name from facilities where id = $1', [facilityId])
    const fac = rows[0]
    if (!fac?.code) return []

    const url = new URL(`${WMS_API_URL}/inbound/balances/orders`)
    url.searchParams.set('envoFacilityId', fac.code)
    try {
      const res = await fetch(url, { headers: svcHeaders })
      if (!res.ok) throw new Error(`WMS /inbound/balances/orders -> ${res.status}`)
      const orders = await res.json()
      return orders.map(o => ({
        id: o.id,
        // Where the order came from, so the facility can tell an order it raised from
        // one the warehouse issued directly.
        source: o.envo_request_id ? 'request' : 'direct',
        envo_request_id: o.envo_request_id || null,
        scheme: o.scheme,
        is_debt: o.is_debt,
        dispatched_at: o.dispatched_at,
        dispatched_by: o.dispatched_by,
        notes: o.notes,
        total_amount: Number(o.total_amount || 0),
        amount_paid: Number(o.amount_paid || 0),
        outstanding: Number(o.outstanding || 0),
        payments: (o.payments || []).map(p => ({ ...p, amount: Number(p.amount) })),
        // The commodities actually issued on this order.
        items: (o.items || []).map(i => ({
          ...i,
          quantity: Number(i.quantity),
          unit_price: Number(i.unit_price),
          line_total: Number(i.line_total),
        })),
      }))
    } catch (err) {
      console.error('Could not read orders from the WMS:', err.message)
      const e = new Error('The central store could not be reached for this facility’s orders')
      e.status = 503
      throw e
    }
  }
}
