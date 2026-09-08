import { useState, useEffect } from 'react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/appStore'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { MetricGrid, Metric } from '../../components/ui/Metric'
import { CatBadge } from '../../components/ui/Badge'
import { LoadingState, EmptyState, Spinner } from '../../components/ui/Loading'
import { FacilityPicker } from '../../components/ui/FacilityPicker'
import { DailyTrendChart } from '../../components/DailyTrendChart'
import { exportCsv, exportPdf } from '../../utils/download'
import { Pagination, pageSlice } from '../../components/ui/Pagination'
import { fmtDate } from '../../utils/helpers'

// Batch / expiry for a transfer, which carries them in its `lots` jsonb column
// ([{qty, batch, expiry}, …]) rather than in flat columns like an intake row does.
// A transfer can draw on several lots: the batches are listed, and the EARLIEST
// expiry is shown since that is the one that governs when the stock must move.
// Older rows predate the column and legitimately have no lot data.
function lotFields(lots) {
  const arr = Array.isArray(lots) ? lots : []
  if (!arr.length) return { batch: '—', expiry: null }
  const batches = [...new Set(arr.map(l => l && l.batch).filter(Boolean))]
  const expiries = arr.map(l => l && l.expiry).filter(Boolean).sort()
  return {
    batch: batches.length ? batches.join(', ') : '—',
    expiry: expiries[0] || null,
    // More lots than shown → the table marks it rather than silently truncating.
    extraExpiries: Math.max(0, new Set(expiries).size - 1),
  }
}

export function Monitoring() {
  const store = useAppStore()
  const isAdm = store.isAdmin()
  const commoditySection = store.commoditySection
  const [tab, setTab]       = useState('utilization')
  const [period, setPeriod] = useState(30)
  const [consData, setCons] = useState(null)
  const [expiryData, setExpiryData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [catDrill, setCatDrill]   = useState(null)  // category drilled into
  const [commDrill, setCommDrill] = useState(null)  // { id, name, unit } drilled into
  // Drill-in aggregates, fetched on click instead of sliced from a full download.
  const [commDetail, setCommDetail] = useState(null)  // { id, byFac[], byDay[] }
  const [catDetail, setCatDetail]   = useState(null)  // { cat, byFac[] }
  const [metricDrill, setMetricDrill] = useState(null)  // 'units' | 'transactions' | 'commodities'
  const [lgaDrill, setLgaDrill] = useState(null)  // LGA name drilled into within a by-LGA breakdown
  // The geography breakdown is a secondary question — the scope picker above already
  // filters the whole page by state/LGA/facility. Closed by default.
  const [lgaOpen, setLgaOpen] = useState(false)
  // Leaf of the geography path: LGA → facility → the commodities that facility
  // moved. Fetched on click, since it is one small aggregate per facility.
  const [facDrill, setFacDrill] = useState(null)   // { id, name, lga }
  const [facComms, setFacComms] = useState(null)   // { id, kind, rows[], raw[] }
  const [partyDrill, setPartyDrill] = useState(null)  // counterparty name drilled into
  // Table page numbers. Held here, not beside the tables: those render inside
  // conditionals and IIFEs, where a hook would be a conditional hook.
  const [commPage, setCommPage]             = useState(0)
  const [intakeCommPage, setIntakeCommPage] = useState(0)
  const [deliveryPage, setDeliveryPage]     = useState(0)
  const [adjCommPage, setAdjCommPage]       = useState(0)
  const [adjRowPage, setAdjRowPage]         = useState(0)
  const [catHover, setCatHover] = useState(null)  // category hovered in the donut (highlight only)
  const [consFilter, setConsFilter] = useState('consuming')  // commodity drill facility filter: 'consuming' | 'none' | 'all'
  const [expUrgency, setExpUrgency] = useState('all')  // expiry urgency filter: 'all'|'expired'|'critical'|'warning'|'monitor'
  const [expPeriod, setExpPeriod] = useState(180)   // expiry look-ahead window (days)
  // Expiry, structured like the other tabs: commodities first, then the facilities
  // holding that commodity's expiring stock. The flat batch list it replaced put
  // every batch across every facility on one unpaged page.
  const [expCommDrill, setExpCommDrill] = useState(null)  // { id, name, unit }
  const [expCommPage, setExpCommPage]   = useState(0)
  const [expBatchPage, setExpBatchPage] = useState(0)
  // ── Intake tab ──────────────────────────────────────────────────────────────
  const [intakeData, setIntakeData]     = useState(null)  // aggregates for the Intake tab
  const [intakeDrill, setIntakeDrill]   = useState(null)  // { id, name, unit } commodity drilled into
  const [intakeRcpts, setIntakeRcpts]   = useState(null)  // { id, rows[] } receipt-level detail
  const [intakeMetric, setIntakeMetric] = useState(null)  // 'intake' | 'transferin' | 'commodities'
  // When one card stands for both directions, this says which one the geography
  // panel and chart are currently describing.
  const [redistDir, setRedistDir] = useState('in')   // 'in' | 'out'
  const [intakeSource, setIntakeSource] = useState('all') // receipt drill filter: 'all'|'intake'|'transfer'|'out'
  const [supplierFilter, setSupplierFilter] = useState('') // intake tab: ''=all | 'ghsc' | 'other'
  // ── Adjustments tab ─────────────────────────────────────────────────────────
  const [adjData, setAdjData]     = useState(null)  // aggregates for the Adjustments tab
  const [adjDrill, setAdjDrill]   = useState(null)  // { id, name, unit } commodity drilled into
  const [adjRows, setAdjRows]     = useState(null)  // { id, rows[] } row-level detail
  const [adjMetric, setAdjMetric] = useState(null)  // 'positive' | 'negative' | 'commodities'
  const [adjType, setAdjType]     = useState('all')
  // Reason → facilities → commodities. Each level is one small aggregate fetched
  // on click; the reason list itself is already loaded with the tab.
  const [reasonDrill, setReasonDrill] = useState(null)   // { reason, type }
  const [reasonFacs, setReasonFacs]   = useState(null)   // { key, rows[] }
  const [reasonFac, setReasonFac]     = useState(null)   // { id, name, lga }
  const [reasonComms, setReasonComms] = useState(null)   // { key, rows[] } // row filter: 'all'|'Increase'|'Decrease'

  // Honour the admin's facility/LGA/state scope (same resolution as stock loads)
  // so Utilization and Expiry stay within the viewer's jurisdiction.
  const { fid, scopeIds } = store.getAdminStockScope()
  const scopeKey = fid || (scopeIds && scopeIds.length ? scopeIds.join(',') : 'all')
  // Compact scope params ({ facility_id } | { state[, lga] } | {}) that the server
  // resolves — instead of enumerating hundreds of facility ids in the URL, which
  // overflows proxy request-URI limits on large states and silently 404s.

  // Facility metadata for LGA / facility drill-downs
  const facMeta = {}
  store.allFacilities.forEach(f => { facMeta[f.id] = { name: f.name, lga: f.lga || '—' } })
  // Commodity metadata comes from the catalogue already in the store, rather than
  // being repeated on every aggregate row. Hoisted to component scope because the
  // breakdown components render from it too, not just the loader.
  const commMeta = {}
  store.allCommodities.forEach(c => { commMeta[c.id] = c })

  useEffect(() => { loadUtilization() }, [scopeKey, period])
  useEffect(() => { if (tab==='intake') loadIntake() }, [tab, scopeKey, period, supplierFilter])
  useEffect(() => { if (tab==='adjustments') loadAdjustments() }, [tab, scopeKey, period])
  useEffect(() => { if (adjDrill?.id) loadAdjustmentRows(adjDrill.id); else setAdjRows(null) }, [adjDrill?.id])
  useEffect(() => {
    if (reasonDrill) loadReasonFacilities(reasonDrill.reason, reasonDrill.type); else setReasonFacs(null)
  }, [reasonDrill?.reason, reasonDrill?.type])
  useEffect(() => {
    if (reasonDrill && reasonFac) loadReasonCommodities(reasonDrill.reason, reasonDrill.type, reasonFac.id)
    else setReasonComms(null)
  }, [reasonFac?.id])
  useEffect(() => { if (tab==='expiry') loadExpiry() }, [tab, expPeriod, scopeKey])
  // Receipt-level rows load on click; clearing the commodity drill drops them.
  useEffect(() => { if (intakeDrill?.id) loadIntakeReceipts(intakeDrill.id); else setIntakeRcpts(null) }, [intakeDrill?.id])
  // Drill-ins load their own breakdown; clearing the drill drops it again.
  useEffect(() => { if (commDrill?.id) loadCommodityDrill(commDrill.id); else setCommDetail(null) }, [commDrill?.id])
  useEffect(() => { if (catDrill) loadCategoryDrill(catDrill); else setCatDetail(null) }, [catDrill])
  useEffect(() => { setPartyDrill(null) }, [facDrill?.id, facDrill?.leaf])
  useEffect(() => {
    if (!facDrill?.id) { setFacComms(null); return }
    if (facDrill.leaf === 'in' || facDrill.leaf === 'out') loadFacilityCounterparties(facDrill.id, facDrill.leaf)
    else loadFacilityCommodities(facDrill.id, facDrill.leaf || 'dispense')
  }, [facDrill?.id, facDrill?.leaf])

  async function loadUtilization() {
    setLoading(true)
    setCatDrill(null); setCommDrill(null); setMetricDrill(null); setLgaDrill(null); setCommPage(0)
    setFacDrill(null)
    const start = new Date(); start.setDate(start.getDate()-period)
    const scopeParams = store.getAdminScopeParams()

    // Every figure on this page is a sum or a count, so the server does the
    // grouping and we fetch the aggregates IN PARALLEL - instead of draining
    // dispense_log 1000 rows at a time only to reduce it here.
    const base = { ...scopeParams, section: commoditySection || undefined, from: start.toISOString() }

    // No `tz`: this page buckets days by UTC throughout (the section chart keys on
    // toISOString().split('T')[0] and the per-commodity chart on
    // dispensed_at.slice(0,10)). Preserved exactly - standardising Monitoring's day
    // buckets on Africa/Lagos is a separate follow-up.
    // Intake rides along on the same window/scope/section as utilization, via the
    // mirror aggregate — so "received" and "utilized" on this page are always the
    // same facilities over the same days, and can be read against each other.
    const [commRows, facRows, dayRows] = await Promise.all([
      api.dispense.summary({ ...base, group_by: 'commodity' }).catch(() => []),
      api.dispense.summary({ ...base, group_by: 'facility' }).catch(() => []),
      api.dispense.summary({ ...base, group_by: 'day' }).catch(() => []),
    ])

    const byCat={}, daily={}
    for(let i=period-1;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);daily[d.toISOString().split('T')[0]]=0}
    ;(dayRows||[]).forEach(r=>{ if(daily[r.day]!==undefined) daily[r.day]+=r.qty })

    const byComm=(commRows||[]).map(r=>{
      const c=commMeta[r.commodity_id]
      const cat=c?.category||'Other'
      byCat[cat]=(byCat[cat]||0)+r.qty
      return {name:c?.name||r.commodity_id,cat,unit:c?.unit||'',qty:r.qty,txn:r.txn,commodity_id:r.commodity_id}
    }).sort((a,b)=>b.qty-a.qty)

    // NOTE: intake and transfer-in are deliberately NOT loaded here. They have
    // their own tab, which owns every "what arrived" figure; duplicating them on
    // Utilization made this load fetch four extra aggregates for cards that said
    // the same thing one tab over.
    setCons({
      byComm, byCat, daily,
      byFac: facRows||[],
      total: (commRows||[]).reduce((s,r)=>s+r.qty,0),
      txnTotal: (commRows||[]).reduce((s,r)=>s+r.txn,0),
    })
    setLoading(false)
  }

  // The commodities one FACILITY moved over the current period, so the leaf always
  // totals to the figure on the card that opened it.
  async function loadFacilityCommodities(facilityId, kind = 'dispense') {
    setFacComms(null)
    const start = new Date(); start.setDate(start.getDate()-period)
    const summaryFn = kind === 'intake' ? api.intake.summary
      : kind === 'adjustment' ? api.adjustments.summary
      : api.dispense.summary
    const rows = await summaryFn({
      facility_id: facilityId, section: commoditySection || undefined,
      from: start.toISOString(),
      // adjustments group by direction as well, so its rows carry `type`
      group_by: kind === 'adjustment' ? 'commodity,type' : 'commodity',
    }).catch(() => [])
    let out = rows || []
    if (kind === 'adjustment') {
      const m = {}
      out.forEach(r => {
        const e = m[r.commodity_id] ||= { commodity_id: r.commodity_id, qty: 0, txn: 0 }
        e.qty += r.qty; e.txn += r.txn
      })
      out = Object.values(m)
    }
    setFacComms({ id: facilityId, kind, rows: out.slice().sort((a,b)=>b.qty-a.qty) })
  }

  // Where a facility's transfers came FROM (dir 'in') or went TO (dir 'out').
  //
  // This one needs the transfer LIST, not an aggregate: the counterparty facility
  // is a column on the transfer row and is summed away by every group_by the
  // summary endpoint offers. Two consequences handled here — the list bounds dates
  // by whole days, so the window is trimmed to the exact instants afterwards; and
  // it takes no category filter, so the tab's category narrowing is applied client
  // side, or this leaf would disagree with the card that opened it.
  const catFilterActive = false, catFilterValue = null   // lab has no category filter
  async function loadFacilityCounterparties(facilityId, dir) {
    const start = new Date(); start.setDate(start.getDate()-period)
    const dayOf = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    const fromDay = dayOf(start), toDay = undefined
    const lo = start.getTime(), hi = Infinity
    const rows = await api.transfers.list({
      facility_id: facilityId, section: commoditySection || undefined,
      direction: dir === 'out' ? 'outgoing' : 'incoming',
      status: 'accepted', date_field: 'resolved_at',
      from: fromDay, to: toDay, limit: 1000,
    }).catch(() => [])

    const agg = {}
    const keep = (rows || [])
      .filter(t => { const ts = new Date(t.resolved_at).getTime(); return ts >= lo && ts <= hi })
      // Real facility-to-facility movements only, the same rule the cards use:
      // internal store→dispensary and SDP sub-unit rows are not arrivals or exits.
      .filter(t => t.sending_facility_id && t.receiving_facility_id
                   && t.sending_facility_id !== t.receiving_facility_id)
      .filter(t => !catFilterActive || (commMeta[t.commodity_id]?.category === catFilterValue))
    keep.forEach(t => {
        const other = dir === 'out'
          ? (t.receiving_facility_name || facMeta[t.receiving_facility_id]?.name || '—')
          : (t.sending_facility_name   || facMeta[t.sending_facility_id]?.name   || '—')
        const a = agg[other] ||= { name: other, qty: 0, txn: 0 }
        a.qty += (t.qty_accepted ?? t.quantity ?? 0)
        a.txn += 1
    })
    // `raw` is kept so drilling ONE counterparty can split it by commodity without
    // going back to the server — the rows are already here, just grouped differently.
    setFacComms({ id: facilityId, kind: dir, raw: keep,
                  rows: Object.values(agg).sort((a,b)=>b.txn-a.txn) })
  }

  // Drill-in detail is fetched ON CLICK rather than sliced out of a full download.
  async function loadCommodityDrill(commodityId) {
    setCommDetail(null)
    const start = new Date(); start.setDate(start.getDate()-period)
    const q = {
      ...store.getAdminScopeParams(), section: commoditySection || undefined,
      from: start.toISOString(), commodity_id: commodityId,
    }
    const [byFac, byDay] = await Promise.all([
      api.dispense.summary({ ...q, group_by: 'commodity,facility' }).catch(() => []),
      api.dispense.summary({ ...q, group_by: 'commodity,day' }).catch(() => []),
    ])
    setCommDetail({ id: commodityId, byFac: byFac||[], byDay: byDay||[] })
  }

  async function loadCategoryDrill(cat) {
    setCatDetail(null)
    const start = new Date(); start.setDate(start.getDate()-period)
    const byFac = await api.dispense.summary({
      ...store.getAdminScopeParams(), section: commoditySection || undefined,
      from: start.toISOString(), group_by: 'facility', category: cat,
    }).catch(() => [])
    setCatDetail({ cat, byFac: byFac||[] })
  }

  async function loadExpiry() {
    setLoading(true)
    setExpUrgency('all')
    setExpCommDrill(null); setExpCommPage(0); setExpBatchPage(0)
    const now=new Date()
    const cutoff=new Date(now.getTime()+expPeriod*86400000).toISOString().split('T')[0]
    const scopeParams = store.getAdminScopeParams()

    // Per-batch balances straight from the AUTHORITATIVE lot ledger — already the
    // on-hand truth (no intake-history estimate to cap), so a batch that is ALREADY
    // expired but still on the shelf (e.g. received expired) surfaces here and the
    // quantities reconcile to Stock Levels. Expired lots are always returned;
    // `expiry_to` caps the future look-ahead window.
    const lots = await api.stock.lotsExpiry({
      ...scopeParams,
      expiry_to: cutoff,
      section: commoditySection || undefined,
    }).catch(() => [])
    setExpiryData(lots || [])
    setLoading(false)
  }

  // ── Intake tab ──────────────────────────────────────────────────────────────
  // Everything that ARRIVED in the window, from both sources: supplier receipts
  // (intake_log) and accepted inter-facility transfers. Same rolling period and
  // scope as the Utilization tab, so the two tabs are comparable.
  async function loadIntake() {
    setLoading(true)
    setIntakeDrill(null); setIntakeMetric(null); setLgaDrill(null); setIntakeCommPage(0)
    const start = new Date(); start.setDate(start.getDate()-period)
    const q = { ...store.getAdminScopeParams(), section: commoditySection || undefined,
                from: start.toISOString() }
    // Supplier filter (GHSC-PSM / others) applies to supplier RECEIPTS only. When one
    // is chosen, inter-facility transfers — which have no supplier — are excluded.
    const iq = { ...q, supplier: supplierFilter || undefined }
    const noTransfers = !!supplierFilter
    const none = Promise.resolve([])

    const [iComm, iFac, iDay, tComm, tFac, tDay, oComm, oFac, oDay] = await Promise.all([
      api.intake.summary({ ...iq, group_by: 'commodity' }).catch(() => []),
      api.intake.summary({ ...iq, group_by: 'facility' }).catch(() => []),
      api.intake.summary({ ...iq, group_by: 'day' }).catch(() => []),
      noTransfers ? none : api.transfers.summary({ ...q, group_by: 'commodity' }).catch(() => []),
      noTransfers ? none : api.transfers.summary({ ...q, group_by: 'facility' }).catch(() => []),
      noTransfers ? none : api.transfers.summary({ ...q, group_by: 'day' }).catch(() => []),
      // Stock LEAVING the scope. Not part of any "received" figure — it sits beside
      // them so the tab shows movement in both directions.
      noTransfers ? none : api.transfers.summary({ ...q, group_by: 'commodity', direction: 'out' }).catch(() => []),
      noTransfers ? none : api.transfers.summary({ ...q, group_by: 'facility', direction: 'out' }).catch(() => []),
      noTransfers ? none : api.transfers.summary({ ...q, group_by: 'day', direction: 'out' }).catch(() => []),
    ])

    // Day buckets keyed by UTC date, matching this page's other charts. Two series:
    // the section-level chart plots INTAKE COUNTS (a units total across
    // commodities would be adding reagents to kits to rolls), while the commodity
    // drill plots units, which are homogeneous once a single commodity is selected.
    const seed = () => { const o={}; for(let i=period-1;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);o[d.toISOString().split('T')[0]]=0} return o }
    // One series PER MOVEMENT. A single combined line could not answer "how much
    // came in as intake" — the question the Intake card asks.
    const daily = seed(), dailyIntake = seed(), dailyIn = seed(), dailyOut = seed()
    const fill = (rows, target) => (rows||[]).forEach(r=>{ if(target[r.day]!==undefined) target[r.day]+=r.txn })
    fill(iDay, dailyIntake); fill(tDay, dailyIn); fill(oDay, dailyOut)
    ;[...(iDay||[]), ...(tDay||[])].forEach(r=>{ if(daily[r.day]!==undefined) daily[r.day]+=r.qty })
    const dailyCount = seed()
    Object.keys(dailyCount).forEach(k=>{ dailyCount[k] = dailyIntake[k] + dailyIn[k] })

    // Merge all three movements per commodity, keeping them separately addressable
    // so the table can show where each commodity's stock came from AND where it
    // went. `txn` counts INBOUND intake records only — outbound is its own column, and
    // folding it into an intake count would overstate what arrived.
    const merged = {}
    const put = (rows, key, countsAsDelivery) => (rows||[]).forEach(r=>{
      const m = merged[r.commodity_id] ||= { commodity_id:r.commodity_id, intake:0, transfer:0, out:0,
                                             txn:0, intakeTxn:0, transferTxn:0, outTxn:0 }
      m[key] += r.qty
      if (countsAsDelivery) { m.txn += r.txn; m[key+'Txn'] += r.txn } else m.outTxn += r.txn
    })
    put(iComm,'intake',true); put(tComm,'transfer',true); put(oComm,'out',false)
    const byComm = Object.values(merged)
      .map(m=>({ ...m, qty:m.intake+m.transfer,
                 name: commMeta[m.commodity_id]?.name || m.commodity_id,
                 cat:  commMeta[m.commodity_id]?.category || 'Other',
                 unit: commMeta[m.commodity_id]?.unit || '' }))
      .sort((a,b)=>b.qty-a.qty || b.out-a.out)

    setIntakeData({
      byComm, daily, dailyCount,
      dailyIntake, dailyIn, dailyOut,
      intakeByFac: iFac||[], transferByFac: tFac||[],
      intakeByCommRows: iComm||[], transferByCommRows: tComm||[],
      outByFac: oFac||[], outByCommRows: oComm||[],
      outTxn: (oComm||[]).reduce((s,r)=>s+r.txn,0),
      intakeTxn:     (iComm||[]).reduce((s,r)=>s+r.txn,0),
      transferTxn:   (tComm||[]).reduce((s,r)=>s+r.txn,0),
    })
    setLoading(false)
  }

  // Receipt-level detail for ONE commodity: every individual intake with its
  // date and quantity (plus batch / expiry / source), which the aggregates
  // deliberately collapse. Fetched on click — this is row data, not a sum.
  //
  // ── Adjustments tab ─────────────────────────────────────────────────────────
  // The third movement type: stock changing WITHOUT a physical movement — count
  // corrections, write-offs, returns. Positive and negative are kept apart at every
  // level, never netted: a net of zero equally means "nothing happened" and "5,000
  // added, 5,000 removed", and those are very different facts.
  async function loadAdjustments() {
    setLoading(true)
    setAdjDrill(null); setAdjMetric(null); setLgaDrill(null); setAdjType('all'); setAdjCommPage(0)
    setReasonDrill(null); setReasonFac(null)
    const start = new Date(); start.setDate(start.getDate()-period)
    const q = { ...store.getAdminScopeParams(), section: commoditySection || undefined,
                from: start.toISOString() }

    // Each aggregate already carries `type`, so one request per shape covers both
    // directions and they are split client-side — rather than doubling the requests.
    const [cRows, fRows, dRows, rRows] = await Promise.all([
      api.adjustments.summary({ ...q, group_by: 'commodity,type' }).catch(() => []),
      api.adjustments.summary({ ...q, group_by: 'facility,type' }).catch(() => []),
      api.adjustments.summary({ ...q, group_by: 'day,type' }).catch(() => []),
      api.adjustments.summary({ ...q, group_by: 'reason,type' }).catch(() => []),
    ])

    const isUp = r => r.type === 'Increase'
    const seedA = () => { const o={}; for(let i=period-1;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);o[d.toISOString().split('T')[0]]=0} return o }
    // Split by direction as well as day: a combined line cannot answer "how many
    // were write-offs", which is what the Negative card asks.
    const daily = seedA(), dailyUp = seedA(), dailyDown = seedA()
    ;(dRows||[]).forEach(r=>{
      if (daily[r.day] === undefined) return
      daily[r.day] += r.txn
      ;(isUp(r) ? dailyUp : dailyDown)[r.day] += r.txn
    })

    const merged = {}
    ;(cRows||[]).forEach(r=>{
      const m = merged[r.commodity_id] ||= { commodity_id:r.commodity_id, up:0, down:0, upTxn:0, downTxn:0 }
      if (isUp(r)) { m.up += r.qty; m.upTxn += r.txn } else { m.down += r.qty; m.downTxn += r.txn }
    })
    const byComm = Object.values(merged)
      .map(m=>({ ...m, txn:m.upTxn+m.downTxn,
                 name: commMeta[m.commodity_id]?.name || m.commodity_id,
                 cat:  commMeta[m.commodity_id]?.category || 'Other',
                 unit: commMeta[m.commodity_id]?.unit || '' }))
      .sort((a,b)=>b.txn-a.txn)

    // Reasons, kept separate per direction — the same wording means different things
    // in each ('Physical count correction' splits both ways), so pooling them would
    // merge two distinct events under one label.
    const byReason = { Increase: [], Decrease: [] }
    ;(rRows||[]).forEach(r=>{ (byReason[r.type] ||= []).push({ reason:r.reason, qty:r.qty, txn:r.txn }) })
    Object.values(byReason).forEach(list => list.sort((a,b)=>b.txn-a.txn))

    setAdjData({
      byComm, byReason, daily, dailyUp, dailyDown,
      byFacUp:   (fRows||[]).filter(isUp),
      byFacDown: (fRows||[]).filter(r=>!isUp(r)),
      byCommUp:  (cRows||[]).filter(isUp),
      byCommDown:(cRows||[]).filter(r=>!isUp(r)),
      upTxn:   (cRows||[]).filter(isUp).reduce((s,r)=>s+r.txn,0),
      downTxn: (cRows||[]).filter(r=>!isUp(r)).reduce((s,r)=>s+r.txn,0),
    })
    setLoading(false)
  }

  // Which facilities recorded a given reason, and then what they adjusted. Both
  // narrow on the SAME reason and direction the bar was showing, so each level
  // totals to the one above it.
  async function loadReasonFacilities(reason, type) {
    const start = new Date(); start.setDate(start.getDate()-period)
    const win = { from: start.toISOString() }
    setReasonFacs(null)
    const rows = await api.adjustments.summary({
      ...store.getAdminScopeParams(), section: commoditySection || undefined, ...win,
      group_by: 'facility', adjustment_type: type, reason,
    }).catch(() => [])
    setReasonFacs({ key: `${type}|${reason}`, rows: (rows||[]).slice().sort((a,b)=>b.txn-a.txn) })
  }

  async function loadReasonCommodities(reason, type, facilityId) {
    const start = new Date(); start.setDate(start.getDate()-period)
    const win = { from: start.toISOString() }
    setReasonComms(null)
    const rows = await api.adjustments.summary({
      facility_id: facilityId, section: commoditySection || undefined, ...win,
      group_by: 'commodity', adjustment_type: type, reason,
    }).catch(() => [])
    setReasonComms({ key: `${type}|${reason}|${facilityId}`, rows: (rows||[]).slice().sort((a,b)=>b.txn-a.txn) })
  }

  // Row-level adjustments for ONE commodity: date, direction, quantity and the
  // stated reason for each. Fetched on click — row data, not a sum.
  async function loadAdjustmentRows(commodityId) {
    setAdjRows(null)
    const start = new Date(); start.setDate(start.getDate()-period)
    const rows = await api.adjustments.history({
      ...store.getAdminScopeParams(), section: commoditySection || undefined,
      from: start.toISOString(), commodity_ids: commodityId, limit: 1000,
    }).catch(() => [])
    setAdjRows({ id: commodityId, rows: (rows||[]).slice().sort((a,b)=> new Date(b.adjusted_at||0) - new Date(a.adjusted_at||0)) })
  }

  // One row per transfer, not per day. `direction: 'incoming'` matters for an admin
  // whose scope contains both endpoints — without it the same internal movement
  // would come back as both an in and an out.
  async function loadIntakeReceipts(commodityId) {
    setIntakeRcpts(null)
    const start = new Date(); start.setDate(start.getDate()-period)
    const scope = store.getAdminScopeParams()
    const common = { ...scope, section: commoditySection || undefined,
                     from: start.toISOString() }
    const dayOf = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`

    // With a supplier filter active the drill must match the aggregate above it:
    // only supplier receipts of that kind, and no inter-facility transfers.
    const isGhsc = s => /ghsc|psm/i.test(String(s || ''))
    const supplierOk = r => !supplierFilter || (supplierFilter === 'ghsc' ? isGhsc(r.supplier_source) : !isGhsc(r.supplier_source))
    const noTransfers = !!supplierFilter
    const none = Promise.resolve([])

    const [receiptsRaw, transfers, outbound] = await Promise.all([
      api.intake.history({ ...common, commodity_ids: commodityId, limit: 1000 }).catch(() => []),
      // The transfer list bounds dates by DAY (it appends its own T00:00:00), so the
      // window is widened to a whole day here and trimmed to the exact instant below
      // — otherwise the itemised list could disagree with the aggregate card.
      noTransfers ? none : api.transfers.list({ ...scope, section: commoditySection || undefined,
                           commodity_ids: commodityId, direction: 'incoming',
                           status: 'accepted', date_field: 'resolved_at',
                           from: dayOf(start), limit: 1000 }).catch(() => []),
      // Outbound, so the commodity drill covers movement in BOTH directions —
      // otherwise Transferred-Out is a headline figure with nothing behind it.
      noTransfers ? none : api.transfers.list({ ...scope, section: commoditySection || undefined,
                           commodity_ids: commodityId, direction: 'outgoing',
                           status: 'accepted', date_field: 'resolved_at',
                           from: dayOf(start), limit: 1000 }).catch(() => []),
    ])
    const receipts = (receiptsRaw || []).filter(supplierOk)

    const lo = start.getTime()
    const rows = [
      ...(receipts||[]).map(r=>({
        id: r.id, kind: 'Intake', at: r.received_at,
        qty: r.quantity, batch: r.batch_number || '—', expiry: r.expiry_date || null,
        source: r.supplier_source || '—', by: r.received_by || '—',
        facility: r.facilities?.name || facMeta[r.facility_id]?.name || '—',
      })),
      ...(transfers||[])
        .filter(t => new Date(t.resolved_at).getTime() >= lo)
        // Mirrors the service: count only movements between two REAL, DIFFERENT
        // facilities. Excludes '[Internal: Store→Dispensary]' (sender = receiver) and
        // '[SDP: Main Lab]' (no receiving_facility_id — a sub-unit of the sender).
        // In both the stock stayed inside the facility, so nothing was received.
        .filter(t => t.sending_facility_id && t.receiving_facility_id
                     && t.sending_facility_id !== t.receiving_facility_id)
        .map(t=>({
          id: t.id, kind: 'Transfer', at: t.resolved_at,
          // A partial acceptance credits only what was accepted; qty_accepted is
          // null on rows predating the column, which accepted in full.
          qty: t.qty_accepted ?? t.quantity,
          ...lotFields(t.lots),
          source: t.sending_facility_name || facMeta[t.sending_facility_id]?.name || '—',
          by: t.resolved_by || '—',
          facility: t.receiving_facility_name || facMeta[t.receiving_facility_id]?.name || '—',
        })),
      ...(outbound||[])
        .filter(t => new Date(t.resolved_at).getTime() >= lo)
        .filter(t => t.sending_facility_id && t.receiving_facility_id
                     && t.sending_facility_id !== t.receiving_facility_id)
        .map(t=>({
          id: t.id, kind: 'Transfer out', at: t.resolved_at,
          qty: t.qty_accepted ?? t.quantity,
          ...lotFields(t.lots),
          // For an outbound row "To" is where it WENT, so the column reads as the
          // counterparty either way; `facility` stays the one that held the stock.
          source: t.receiving_facility_name || facMeta[t.receiving_facility_id]?.name || '—',
          by: t.resolved_by || '—',
          facility: t.sending_facility_name || facMeta[t.sending_facility_id]?.name || '—',
        })),
    ].sort((a,b)=> new Date(b.at||0) - new Date(a.at||0))

    setIntakeRcpts({ id: commodityId, rows })
  }

  function switchTab(t) {
    setTab(t)
    if(t==='utilization') loadUtilization()
  }

  const today=new Date()
  const catColors={'Pharmacy drugs':'#3fb950','RTKs':'#58a6ff','Lab reagents':'#d29922','Lab consumables':'#f778ba','Medical supplies':'#bc8cff'}
  const palette=['#3fb950','#58a6ff','#d29922','#bc8cff','#f778ba','#e3826b','#39c5cf','#a371f7']
  const catColor=(cat,i=0)=>catColors[cat]||palette[i%palette.length]

  // Aggregate loaded dispense rows by a key (facility id / LGA) for drill-downs.
  const aggRows = (rows, keyFn, field='qty') => {
    const m={}
    ;(rows||[]).forEach(r=>{ const k=keyFn(r); if(k==null) return; m[k]=(m[k]||0)+(r[field]||0) })
    return Object.entries(m).sort((a,b)=>b[1]-a[1])
  }

  // Breakdown by COMMODITY over a per-commodity aggregate — the drill a facility
  // user gets where an admin gets FacilityLgaBreakdown. A facility has exactly one
  // facility in scope, so "by LGA and facility" would be a one-row table telling
  // them what they already know; "which commodities did this cover" is the
  // question they can actually act on.
  const CommodityBreakdown = ({ rows, mode, unitsLabel }) => {
    const field = mode==='count' ? 'txn' : 'qty'
    const list = aggRows(rows, r=>r.commodity_id, field)
      .map(([id,v])=>({ id, v, name: commMeta[id]?.name || '—', cat: commMeta[id]?.category || 'Other', unit: commMeta[id]?.unit || '' }))
    const total = list.reduce((s,r)=>s+r.v,0) || 1
    if (!list.length) return <EmptyState message="Nothing recorded in this period."/>
    return (
      <div className="table-wrap"><table className="w-full text-sm">
        <thead><tr className="border-b border-white/8 bg-white/2">
          {['#','Commodity','Category',unitsLabel,'Share'].map(h=>(
            <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
          ))}
        </tr></thead>
        <tbody>{list.map((c,i)=>{
          const pct=Math.round((c.v/total)*100)||0
          return (
            <tr key={c.id} className="border-b border-white/5 hover:bg-white/2">
              <td className="px-4 py-3 font-mono text-xs text-gray-600">{i+1}</td>
              <td className="px-4 py-3 font-medium text-gray-100">{c.name}</td>
              <td className="px-4 py-3"><CatBadge>{c.cat}</CatBadge></td>
              <td className="px-4 py-3 font-mono text-sm text-green-400">{c.v.toLocaleString()} {mode==='count'?'':c.unit}</td>
              <td className="px-4 py-3 text-xs text-gray-500">{pct}%</td>
            </tr>
          )
        })}</tbody>
      </table></div>
    )
  }

  // Breakdown of the loaded rows by LGA + facility, either summing units
  // (mode='units') or counting transactions (mode='count').
  const FacilityLgaBreakdown = ({ rows, mode, unitsLabel, leaf = 'dispense' }) => {
    if (!lgaOpen) return (
      <button type="button" onClick={()=>setLgaOpen(true)}
        className="w-full text-left px-5 py-3 border-t border-white/8 text-xs text-gray-500 uppercase tracking-widest hover:text-gray-300">
        By LGA &amp; facility <span className="text-gray-600 normal-case tracking-normal">— show breakdown ›</span>
      </button>
    )
    // `txn` is the server's count(*), exactly what rows.length used to be.
    const field = mode==='count' ? 'txn' : 'qty'
    const aggBy = keyFn => aggRows(rows, keyFn, field)
    const total = (rows||[]).reduce((s,r)=>s+(r[field]||0),0) || 1
    const byLga = aggBy(r=>facMeta[r.facility_id]?.lga || '—')
    const byFac = aggBy(r=>r.facility_id).map(([id,v])=>({id,v,name:facMeta[id]?.name||'—',lga:facMeta[id]?.lga||'—'}))
    // THREE views, never stacked: the LGA list, then one LGA's facilities, then one
    // facility's commodities. Each replaces the last, so the answer you asked for is
    // at the top rather than below everything you scrolled past to get it.
    if (facDrill) {
      const ready = facComms?.id === facDrill.id && facComms?.kind === (facDrill.leaf || 'dispense')
      const rows = ready ? facComms.rows : null
      const party = facDrill.leaf === 'in' || facDrill.leaf === 'out'

      // One facility PAIR, split by commodity — what actually moved between them.
      // Built from the transfer rows already fetched for the counterparty list, so
      // this level costs nothing.
      if (party && partyDrill && ready) {
        const out = facDrill.leaf === 'out'
        const mine = (facComms.raw || []).filter(t => (out
          ? (t.receiving_facility_name || facMeta[t.receiving_facility_id]?.name || '—')
          : (t.sending_facility_name   || facMeta[t.sending_facility_id]?.name   || '—')) === partyDrill)
        const byC = {}
        mine.forEach(t => {
          const e = byC[t.commodity_id] ||= { commodity_id: t.commodity_id, qty: 0, txn: 0 }
          e.qty += (t.qty_accepted ?? t.quantity ?? 0); e.txn += 1
        })
        const list = Object.values(byC).sort((a,b)=>b.qty-a.qty)
        return (
          <>
            <div className="px-5 pt-3 pb-2 flex items-center justify-between gap-3 flex-wrap">
              <span className="text-xs text-gray-500 uppercase tracking-widest">
                {facDrill.name} <span className="normal-case tracking-normal text-gray-600">
                  {out ? '→' : '←'} {partyDrill} — commodities</span>
              </span>
              <button onClick={()=>setPartyDrill(null)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-2 py-1">← {facDrill.name}</button>
            </div>
            {!list.length ? <EmptyState message="No commodities recorded for this pair."/> : (
              <div className="table-wrap"><table className="w-full text-sm">
                <thead><tr className="border-b border-white/8 bg-white/2">
                  {['#','Commodity','Category','Transfers','Quantity'].map(h=>(
                    <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                  ))}
                </tr></thead>
                <tbody>{list.map((r,i)=>{
                  const c = commMeta[r.commodity_id]
                  return (
                    <tr key={r.commodity_id} className="border-b border-white/5 hover:bg-white/2">
                      <td className="px-4 py-3 font-mono text-xs text-gray-600">{i+1}</td>
                      <td className="px-4 py-3 font-medium text-gray-100">{c?.name || r.commodity_id}</td>
                      <td className="px-4 py-3"><CatBadge>{c?.category || 'Other'}</CatBadge></td>
                      <td className="px-4 py-3 text-gray-300">{r.txn.toLocaleString()}</td>
                      <td className="px-4 py-3 font-mono text-sm text-green-400">{r.qty.toLocaleString()} {c?.unit || ''}</td>
                    </tr>
                  )
                })}</tbody>
              </table></div>
            )}
          </>
        )
      }
      const tot = (rows||[]).reduce((s2,r)=>s2+(mode==='count'?r.txn:r.qty),0) || 1
      return (
        <>
          <div className="px-5 pt-3 pb-2 flex items-center justify-between gap-3 flex-wrap">
            <span className="text-xs text-gray-500 uppercase tracking-widest">
              {facDrill.name} <span className="normal-case tracking-normal text-gray-600">— {
                facDrill.leaf === 'in'  ? 'received from' :
                facDrill.leaf === 'out' ? 'sent to' : 'commodities'
              }</span>
            </span>
            <button onClick={()=>setFacDrill(null)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-2 py-1">← {facDrill.lga && facDrill.lga !== '—' ? facDrill.lga : 'Back'}</button>
          </div>
          {!rows ? <LoadingState/> : !rows.length ? (
            <EmptyState message={party
              ? `No transfers ${facDrill.leaf === 'out' ? 'sent by' : 'received by'} this facility in this period.`
              : 'Nothing recorded for this facility in this period.'}/>
          ) : (
            <div className="table-wrap"><table className="w-full text-sm">
              <thead><tr className="border-b border-white/8 bg-white/2">
                {(party
                  ? ['#', facDrill.leaf === 'out' ? 'Sent to' : 'Received from', 'Transfers', 'Quantity', 'Share']
                  : ['#','Commodity','Category',unitsLabel,'Quantity','Share']
                ).map(h=>(
                  <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                ))}
              </tr></thead>
              <tbody>{rows.map((r,i)=>{
                const v = mode==='count' ? r.txn : r.qty
                if (party) return (
                  <tr key={r.name} onClick={()=>setPartyDrill(r.name)}
                      className="border-b border-white/5 hover:bg-white/5 cursor-pointer">
                    <td className="px-4 py-3 font-mono text-xs text-gray-600">{i+1}</td>
                    <td className="px-4 py-3 font-medium text-gray-100">{r.name}<span className="text-gray-600 ml-1">›</span></td>
                    <td className="px-4 py-3 text-gray-300">{r.txn.toLocaleString()}</td>
                    {/* Quantity is safe to total here only because it is one facility
                        pair at a time; across commodities it would mix units, so it is
                        shown beside the transfer count rather than instead of it. */}
                    <td className="px-4 py-3 font-mono text-sm text-gray-400">{r.qty.toLocaleString()}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{Math.round((r.txn/((rows||[]).reduce((s2,x)=>s2+x.txn,0)||1))*100)||0}%</td>
                  </tr>
                )
                const c = commMeta[r.commodity_id]
                return (
                  <tr key={r.commodity_id} className="border-b border-white/5 hover:bg-white/2">
                    <td className="px-4 py-3 font-mono text-xs text-gray-600">{i+1}</td>
                    <td className="px-4 py-3 font-medium text-gray-100">{c?.name || r.commodity_id}</td>
                    <td className="px-4 py-3"><CatBadge>{c?.category || 'Other'}</CatBadge></td>
                    <td className="px-4 py-3 font-mono text-sm text-gray-300">{v.toLocaleString()}</td>
                    <td className="px-4 py-3 font-mono text-sm text-green-400">{(r.qty ?? 0).toLocaleString()} {c?.unit || ''}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{Math.round((v/tot)*100)||0}%</td>
                  </tr>
                )
              })}</tbody>
            </table></div>
          )}
        </>
      )
    }
    if (!lgaDrill) return (
      <>
        <CardBody>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-500 uppercase tracking-widest">By LGA <span className="normal-case tracking-normal text-gray-600">— click an LGA to see its facilities</span></span>
            <button type="button" onClick={()=>{setLgaOpen(false);setLgaDrill(null);setFacDrill(null)}} className="text-xs text-gray-500 hover:text-gray-300">Hide</button>
          </div>
          <div className="space-y-2">
            {byLga.map(([lga,v])=>{
              const pct=Math.round((v/total)*100)||0
              const active=lgaDrill===lga
              return (
                <button key={lga} onClick={()=>setLgaDrill(active?null:lga)} className="w-full text-left group">
                  <div className="flex justify-between mb-1">
                    <span className={`text-sm ${active?'text-green-400':'text-gray-300 group-hover:text-gray-100'}`}>{lga} ›</span>
                    <span className="text-xs font-mono text-gray-500">{pct}% · {v.toLocaleString()}</span>
                  </div>
                  <div className="h-1.5 bg-white/5 rounded-full"><div style={{width:`${pct}%`,height:'100%',background:active?'#58d364':'#3fb950',borderRadius:'9999px'}}/></div>
                </button>
              )
            })}
          </div>
        </CardBody>
      </>
    )
    return (
      <>
        <div className="px-5 pt-1 pb-2 text-xs text-gray-500 uppercase tracking-widest flex items-center justify-between">
          <span>Facilities in {lgaDrill}</span>
          <button onClick={()=>{setLgaDrill(null);setFacDrill(null)}} className="normal-case tracking-normal text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-2 py-1">← All LGAs</button>
        </div>
        {(
          <div className="table-wrap"><table className="w-full text-sm">
            <thead><tr className="border-b border-white/8 bg-white/2">
              {['#','Facility','LGA',unitsLabel,'Share'].map(h=>(
                <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
              ))}
            </tr></thead>
            <tbody>{byFac.filter(f=>f.lga===lgaDrill).map((f,i)=>{
              const pct=Math.round((f.v/total)*100)||0
              return (
                <tr key={f.id} onClick={()=>setFacDrill({id:f.id,name:f.name,lga:f.lga,leaf})}
                    className="border-b border-white/5 hover:bg-white/5 cursor-pointer">
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">{i+1}</td>
                  <td className="px-4 py-3 font-medium text-gray-100">{f.name}<span className="text-gray-600 ml-1">›</span></td>
                  <td className="px-4 py-3 text-xs text-gray-500">{f.lga}</td>
                  <td className="px-4 py-3 font-mono text-sm text-green-400">{f.v.toLocaleString()}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{pct}%</td>
                </tr>
              )
            })}</tbody>
          </table></div>
        )}
      </>
    )
  }

  // Expiry urgency buckets (days until expiry) for the clickable metric cards.
  const expDays = r => (new Date(r.expiry_date)-today)/86400000
  const expBucketRows = b => (expiryData||[]).filter(r=>{
    const d=expDays(r)
    if(b==='expired')  return d<0
    if(b==='critical') return d>=0 && d<=30
    if(b==='warning')  return d>30 && d<=90
    if(b==='monitor')  return d>90
    return true
  })

  // Tailwind classes, not inline styles. Light mode is implemented in index.css by
  // remapping class names (html:not(.dark) [class*="text-gray-100"] { ... }), which
  // inline styles bypass entirely — so the active tab was #e6edf3 text on
  // rgba(255,255,255,.08): near-white on white, and effectively invisible in light
  // mode. The active state is now carried by an accent underline and text weight
  // rather than a background tint, because every bg-white/* is remapped to solid
  // white in light mode and would vanish against the bar it sits in.
  const TabBtn=({id,label})=>{
    const on = tab===id
    return (
      <button type="button" role="tab" aria-selected={on} onClick={()=>switchTab(id)}
        className={`flex-1 px-4 py-2.5 text-sm border-b-2 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500/50 ${
          on ? 'border-green-500 text-gray-100 font-medium bg-white/5'
             : 'border-transparent text-gray-500 hover:text-gray-300 hover:bg-white/2'}`}>
        {label}
      </button>
    )
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100">Monitoring Dashboard</h1>
        <p className="text-sm text-gray-500 mt-1">Real-time programme performance</p>
      </div>

      <div role="tablist" className="flex mb-5 rounded-lg overflow-hidden border border-white/10 bg-white/3">
        <TabBtn id="utilization" label="Utilization"/>
        <TabBtn id="intake"      label="Intake"/>
        <TabBtn id="adjustments" label="Adjustments"/>
        <TabBtn id="expiry"      label="Expiry"/>
      </div>

      {/* Admin location filter — State → LGA → Facility (self-hides for facility users) */}
      <FacilityPicker />

      {/* Period selector — shared by Utilization and Intake, which use the same
          rolling window (Expiry has its own controls below). */}
      {tab!=='expiry' && (
        <Card>
          <div className="px-4 py-3 flex gap-3 items-center flex-wrap">
            <span className="text-xs text-gray-500 uppercase tracking-widest">Period</span>
            <select value={period} onChange={e=>{setPeriod(parseInt(e.target.value))}}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
              <option value={7}>Last 7 days</option>
              <option value={14}>Last 14 days</option>
              <option value={30}>Last 30 days</option>
              <option value={60}>Last 60 days</option>
              <option value={90}>Last 90 days</option>
              <option value={180}>Last 6 months</option>
              <option value={365}>Last 12 months</option>
            </select>
            {tab==='intake' && (<>
              <span className="text-xs text-gray-500 uppercase tracking-widest ml-2">Supplier</span>
              <select value={supplierFilter} onChange={e=>setSupplierFilter(e.target.value)}
                className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
                <option value="">All suppliers</option>
                <option value="ghsc">GHSC-PSM</option>
                <option value="other">Others</option>
              </select>
            </>)}
            <button onClick={tab==='intake'?loadIntake:tab==='adjustments'?loadAdjustments:loadUtilization} disabled={loading} className="ml-auto text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5 disabled:opacity-60 inline-flex items-center gap-1.5">
              {loading && <Spinner size="sm"/>}{loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </Card>
      )}

      {/* Period filter — shown for expiry */}
      {tab==='expiry' && (
        <Card>
          <div className="px-4 py-3 flex gap-3 items-center flex-wrap">
            <span className="text-xs text-gray-500 uppercase tracking-widest">Period</span>
            <select value={expPeriod} onChange={e=>setExpPeriod(parseInt(e.target.value))}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
              <option value={30}>Next 30 days</option>
              <option value={90}>Next 90 days</option>
              <option value={180}>Next 6 months</option>
              <option value={365}>Next 12 months</option>
            </select>
            {isAdm && (<>
              <span className="text-xs text-gray-500 uppercase tracking-widest ml-2">Urgency</span>
              <select value={expUrgency} onChange={e=>setExpUrgency(e.target.value)}
                className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
                <option value="all">All urgencies</option>
                <option value="expired">Expired</option>
                <option value="critical">Critical (≤30d)</option>
                <option value="warning">Warning (≤90d)</option>
                <option value="monitor">Monitor (&gt;90d)</option>
              </select>
            </>)}
            <button onClick={loadExpiry} disabled={loading} className="ml-auto text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5 disabled:opacity-60 inline-flex items-center gap-1.5">
              {loading && <Spinner size="sm"/>}{loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          {/* Says plainly what this tab is NOT, because the obvious reading — that an
              expiry write-off is counted twice across the two tabs — is wrong, and
              only the ledger behaviour explains why. A Decrease adjustment debits the
              lot, so written-off stock leaves this tab the moment it is recorded. */}
          <div className="px-4 pb-3 -mt-1 text-xs text-gray-500">
            Stock <span className="text-gray-400">still on hand</span>, as of now — not a total for the period.
            Stock already written off has left this tab; find it under
            <span className="text-gray-400"> Adjustments → Expired</span>. The two never
            count the same units.
          </div>
        </Card>
      )}

      {loading && <LoadingState/>}

      {!loading && tab==='utilization' && consData && (
        <>
          {commDrill ? (() => {
            // Drilled into one commodity → scope the summary cards to it.
            const cRows = commDetail?.id === commDrill.id ? commDetail.byFac : []
            const cTotal = cRows.reduce((s, r) => s + r.qty, 0)
            const cFacs = cRows.length
            return (
              <MetricGrid>
                <Metric label={`${commDrill.name} — units utilized (${period}d)`} value={cTotal.toLocaleString()} color="green"/>
                <Metric label="Facilities utilizing" value={cFacs} color="blue"/>
                <Metric label="Utilization records" value={cRows.reduce((s,r)=>s+r.txn,0).toLocaleString()}/>
              </MetricGrid>
            )
          })() : (
          <MetricGrid>
            <Metric label={`Units utilized (${period}d)`} value={consData.total.toLocaleString()} color="green"
              onClick={isAdm?()=>{setLgaDrill(null);setMetricDrill(metricDrill==='units'?null:'units')}:undefined} active={metricDrill==='units'}/>
            {/* Intake and transfer-in live on the Intake tab, not here — this tab is
                about what went OUT. Every card drills: admins get the LGA/facility
                breakdown, a facility user gets by-commodity. */}
            <Metric label="Commodities utilized" value={consData.byComm.length} color="blue"
              onClick={isAdm?()=>{setLgaDrill(null);setMetricDrill(metricDrill==='commodities'?null:'commodities')}:undefined} active={metricDrill==='commodities'}/>
            <Metric label="Utilization records" value={consData.txnTotal.toLocaleString()}
              onClick={isAdm?()=>{setLgaDrill(null);setMetricDrill(metricDrill==='transactions'?null:'transactions')}:undefined} active={metricDrill==='transactions'}/>
          </MetricGrid>
          )}


          <div className={`grid grid-cols-1 ${isAdm ? 'lg:grid-cols-2' : ''} gap-4 mb-4`}>
            <Card>
              <CardHeader><CardTitle>{commDrill ? `Daily utilization — ${commDrill.name}` : 'Daily utilization'}</CardTitle></CardHeader>
              <CardBody>
                {(() => {
                  // Drilled into one commodity → rebuild the daily series from just its
                  // rows, reusing the section's ordered date buckets and day-key logic.
                  const daily = commDrill
                    ? (commDetail?.id === commDrill.id ? commDetail.byDay : []).reduce((m, r) => {
                        if (m[r.day] !== undefined) m[r.day] += r.qty
                        return m
                      }, Object.fromEntries(Object.keys(consData.daily).map(k => [k, 0])))
                    : consData.daily
                  return <DailyTrendChart daily={daily} unit="units" />
                })()}
              </CardBody>
            </Card>

            {isAdm && (
            <Card>
              <CardHeader><CardTitle>By category</CardTitle><span className="text-xs text-gray-500">click to drill down</span></CardHeader>
              <CardBody>
                {(() => {
                  const catEntries = Object.entries(consData.byCat).sort((a,b)=>b[1]-a[1])
                  const total = consData.total || 1
                  if (catEntries.length===0) return <div className="text-sm text-gray-500 py-6 text-center">No utilization in this period.</div>
                  const R=42, C=2*Math.PI*R
                  let acc=0
                  const focusCat=catHover||catDrill
                  const centerVal=focusCat?(consData.byCat[focusCat]||0):total
                  const centerSub=focusCat?`${Math.round(((consData.byCat[focusCat]||0)/total)*100)||0}% of total`:'units'
                  return (
                    <div className="flex items-center gap-5 flex-wrap">
                      <svg viewBox="0 0 100 100" style={{width:140,height:140,flexShrink:0}}>
                        <g transform="rotate(-90 50 50)">
                          {catEntries.map(([cat,qty],i)=>{
                            const dash=(qty/total)*C
                            const dim=focusCat&&focusCat!==cat
                            const on=(catDrill===cat)||(catHover===cat)
                            const seg=(
                              <circle key={cat} cx="50" cy="50" r={R} fill="none"
                                stroke={catColor(cat,i)} strokeWidth={on?19:15}
                                strokeDasharray={`${dash} ${C-dash}`} strokeDashoffset={-acc}
                                onClick={()=>isAdm && setCatDrill(catDrill===cat?null:cat)}
                                onMouseEnter={()=>setCatHover(cat)} onMouseLeave={()=>setCatHover(null)}
                                style={{opacity:dim?0.3:1,cursor:isAdm?'pointer':'default',transition:'opacity .15s, stroke-width .15s'}}/>
                            )
                            acc+=dash
                            return seg
                          })}
                        </g>
                        {/* fill-current + a text-* class, not a hardcoded fill: light mode is
                            applied by remapping `color` on class names, which an SVG fill
                            attribute bypasses. Hardcoded #e6edf3 left this number
                            near-white on a white card. */}
                        <text x="50" y="48" textAnchor="middle" className="fill-current text-gray-100" style={{fontSize:'12px',fontWeight:600}}>{centerVal.toLocaleString()}</text>
                        <text x="50" y="57" textAnchor="middle" className="fill-current text-gray-500" style={{fontSize:'6px',letterSpacing:'0.3px'}}>{centerSub}</text>
                      </svg>
                      <div className="flex-1 min-w-[180px] space-y-1">
                        {catEntries.map(([cat,qty],i)=>{
                          const pct=Math.round((qty/total)*100)||0
                          const active=catDrill===cat
                          return (
                            <button key={cat} type="button" disabled={!isAdm}
                              onClick={()=>isAdm && setCatDrill(active?null:cat)}
                              onMouseEnter={()=>setCatHover(cat)} onMouseLeave={()=>setCatHover(null)}
                              className={`w-full flex items-center justify-between gap-3 text-left px-2 py-1 rounded-lg ${isAdm?'hover:bg-white/5 cursor-pointer':''} ${active||catHover===cat?'bg-white/8':''}`}>
                              <span className="flex items-center gap-2 text-sm text-gray-300">
                                <span style={{width:10,height:10,borderRadius:'9999px',background:catColor(cat,i),display:'inline-block',flexShrink:0}}/>
                                {cat}
                              </span>
                              <span className="text-xs font-mono text-gray-500 whitespace-nowrap">{pct}% · {qty.toLocaleString()}</span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}
              </CardBody>
            </Card>
            )}
          </div>

          <Card>
            {isAdm && commDrill ? (() => {
              /* In-place drill: the Top-commodities table swaps to this commodity's
                 facility breakdown; Back restores the table. Rest of the page stays. */
              const commRows = commDetail?.id === commDrill.id ? commDetail.byFac : []
              const cTotal = commRows.reduce((s,r)=>s+r.qty,0)||1
              const byFac = aggRows(commRows, r=>r.facility_id).map(([id,qty])=>({id,qty,name:facMeta[id]?.name||'—',lga:facMeta[id]?.lga||'—'}))
              // Facilities in the current scope that utilized none of this commodity.
              const consumedIds = new Set(byFac.map(f=>f.id))
              const inScopeIds = (scopeIds && scopeIds.length) ? scopeIds : store.allFacilities.map(f=>f.id)
              const nonConsumers = inScopeIds
                .filter(id => !consumedIds.has(id) && facMeta[id])
                .map(id => ({ id, qty:0, name: facMeta[id]?.name||'—', lga: facMeta[id]?.lga||'—' }))
                .sort((a,b) => (a.lga||'').localeCompare(b.lga||'') || a.name.localeCompare(b.name))
              const showConsuming = consFilter !== 'none'
              const showNone = consFilter !== 'consuming'
              const shownRows = [...(showConsuming ? byFac : []), ...(showNone ? nonConsumers : [])]
              const base = (commDrill.name||'commodity').replace(/[^a-z0-9]+/gi,'_').replace(/^_+|_+$/g,'')
              const expHeaders = ['#','Facility','LGA','Units Utilized','Unit','Share %']
              const expRows = () => shownRows.map((f,i)=>[i+1,f.name,f.lga,f.qty,commDrill.unit||'',Math.round((f.qty/cTotal)*100)||0])
              const expSub = consFilter==='none' ? 'facilities with no utilization' : consFilter==='all' ? 'including facilities with no utilization' : null
              const btnCls = "text-xs text-gray-300 hover:text-white border border-white/10 rounded px-3 py-1.5 disabled:opacity-50"
              return (
                <>
                  <CardHeader>
                    <CardTitle>{commDrill.name} — facilities utilizing this commodity</CardTitle>
                    <div className="flex gap-2 flex-wrap">
                      <button onClick={()=>exportCsv(`${base}_facilities-utilizing.csv`, expHeaders, expRows())} disabled={!shownRows.length} className={btnCls}>Download CSV</button>
                      <button onClick={()=>exportPdf(`${commDrill.name} — facilities utilizing`, expSub, expHeaders, expRows(), new Set([3,5]))} disabled={!shownRows.length} className={btnCls}>Print / Save as PDF</button>
                      <select value={consFilter} onChange={e=>setConsFilter(e.target.value)} className={btnCls} title="Filter facilities by utilization">
                        <option value="consuming">With utilization ({byFac.length})</option>
                        <option value="none">No utilization ({nonConsumers.length})</option>
                        <option value="all">All facilities ({byFac.length+nonConsumers.length})</option>
                      </select>
                      <button onClick={()=>{setCommDrill(null);setConsFilter('consuming')}} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">← Top commodities</button>
                    </div>
                  </CardHeader>
                  {!shownRows.length ? <EmptyState message={consFilter==='none' ? 'Every facility in scope utilized this commodity.' : 'No facility-level data.'}/> : (
                    <div className="table-wrap"><table className="w-full text-sm">
                      <thead><tr className="border-b border-white/8 bg-white/2">
                        {['#','Facility','LGA','Units Utilized','Share'].map(h=>(
                          <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {showConsuming && byFac.map((f,i)=>{
                          const pct=Math.round((f.qty/cTotal)*100)||0
                          return (
                            <tr key={f.id} className="border-b border-white/5 hover:bg-white/2">
                              <td className="px-4 py-3 font-mono text-xs text-gray-600">{i+1}</td>
                              <td className="px-4 py-3 font-medium text-gray-100">{f.name}</td>
                              <td className="px-4 py-3 text-xs text-gray-500">{f.lga}</td>
                              <td className="px-4 py-3 font-mono text-sm text-green-400">{f.qty.toLocaleString()} {commDrill.unit||''}</td>
                              <td className="px-4 py-3 text-xs text-gray-500">{pct}%</td>
                            </tr>
                          )
                        })}
                        {consFilter==='all' && showNone && nonConsumers.length>0 && (
                          <tr className="bg-white/2"><td colSpan={5} className="px-4 py-2 text-xs text-gray-500 uppercase tracking-wider">Facilities with no utilization ({nonConsumers.length})</td></tr>
                        )}
                        {showNone && nonConsumers.map((f,i)=>(
                          <tr key={f.id} className="border-b border-white/5 hover:bg-white/2">
                            <td className="px-4 py-3 font-mono text-xs text-gray-600">{(consFilter==='all'?byFac.length:0)+i+1}</td>
                            <td className="px-4 py-3 font-medium text-gray-400">{f.name}</td>
                            <td className="px-4 py-3 text-xs text-gray-500">{f.lga}</td>
                            <td className="px-4 py-3 font-mono text-sm text-gray-600">0 {commDrill.unit||''}</td>
                            <td className="px-4 py-3 text-xs text-gray-600">0%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table></div>
                  )}
                </>
              )
            })() : (
              <>
                <CardHeader><CardTitle>Commodities utilized</CardTitle>
                  <div className="flex items-center gap-3">
                    {isAdm && consData.byComm.length>0 && <span className="text-xs text-gray-500">click a commodity for facilities</span>}
                    <button onClick={()=>{
                      const headers=['#','Commodity','Category','Units utilized','Unit','Utilization records','Share %']
                      const rows=consData.byComm.map((c,i)=>[i+1,c.name,c.cat,c.qty,c.unit||'',c.txn,Math.round((c.qty/consData.total)*100)||0])
                      exportCsv(`top-commodities_utilization_${period}d.csv`, headers, rows)
                    }} disabled={consData.byComm.length===0} className="text-xs text-gray-300 hover:text-white border border-white/10 rounded px-3 py-1.5 disabled:opacity-50">↓ Download CSV</button>
                  </div>
                </CardHeader>
                {consData.byComm.length===0 ? <EmptyState message="No dispensing in this period."/> : (
                  <div className="table-wrap"><table className="w-full text-sm">
                    <thead><tr className="border-b border-white/8 bg-white/2">
                      {['#','Commodity','Category','Units Utilized','Utilization records','Share'].map(h=>(
                        <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>{pageSlice(consData.byComm, commPage).slice.map((c,i)=>{
                      const pct=Math.round((c.qty/consData.total)*100)||0
                      const color=catColor(c.cat,i)
                      return (
                        <tr key={c.commodity_id||i} onClick={()=>isAdm && setCommDrill({id:c.commodity_id,name:c.name,unit:c.unit})}
                          className={`border-b border-white/5 ${isAdm?'cursor-pointer':''} hover:bg-white/2`}>
                          <td className="px-4 py-3 font-mono text-xs text-gray-600">{pageSlice(consData.byComm, commPage).offset + i + 1}</td>
                          <td className="px-4 py-3 font-medium text-gray-100">{c.name}{isAdm && <span className="text-gray-600 ml-1">›</span>}</td>
                          <td className="px-4 py-3"><CatBadge>{c.cat}</CatBadge></td>
                          <td className="px-4 py-3 font-mono text-sm text-green-400">{c.qty.toLocaleString()} {c.unit}</td>
                          <td className="px-4 py-3 text-gray-400">{c.txn}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="w-14 h-1.5 bg-white/5 rounded-full">
                                <div style={{width:`${Math.min(100,(c.qty/consData.byComm[0].qty)*100)}%`,height:'100%',background:color,borderRadius:'9999px'}}/>
                              </div>
                              <span className="text-xs text-gray-500">{pct}%</span>
                            </div>
                          </td>
                        </tr>
                      )
                    })}</tbody>
                  </table>
                  <Pagination pager={pageSlice(consData.byComm, commPage)} onPage={setCommPage} unit="commodities"/>
                  </div>
                )}
              </>
            )}
          </Card>

          {isAdm && catDrill && (() => {
            const catRows = catDetail?.cat === catDrill ? catDetail.byFac : []
            const catTotal = catRows.reduce((s,r)=>s+r.qty,0)||1
            const byLga = aggRows(catRows, r=>facMeta[r.facility_id]?.lga || '—')
            const byFac = aggRows(catRows, r=>r.facility_id).map(([id,qty])=>({id,qty,name:facMeta[id]?.name||'—',lga:facMeta[id]?.lga||'—'}))
            return (
              <Card>
                <CardHeader>
                  <CardTitle>{catDrill} — by LGA &amp; facility</CardTitle>
                  <button onClick={()=>setCatDrill(null)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">← All categories</button>
                </CardHeader>
                <CardBody>
                  <div className="text-xs text-gray-500 uppercase tracking-widest mb-2">By LGA</div>
                  <div className="space-y-2">
                    {byLga.map(([lga,qty])=>{
                      const pct=Math.round((qty/catTotal)*100)||0
                      return (
                        <div key={lga}>
                          <div className="flex justify-between mb-1"><span className="text-sm text-gray-300">{lga}</span><span className="text-xs font-mono text-gray-500">{pct}% · {qty.toLocaleString()}</span></div>
                          <div className="h-1.5 bg-white/5 rounded-full"><div style={{width:`${pct}%`,height:'100%',background:catColor(catDrill),borderRadius:'9999px'}}/></div>
                        </div>
                      )
                    })}
                  </div>
                </CardBody>
                <div className="px-5 pt-1 pb-2 text-xs text-gray-500 uppercase tracking-widest">By facility</div>
                <div className="table-wrap"><table className="w-full text-sm">
                  <thead><tr className="border-b border-white/8 bg-white/2">
                    {['Facility','LGA','Units Utilized','Share'].map(h=>(
                      <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>{byFac.map(f=>{
                    const pct=Math.round((f.qty/catTotal)*100)||0
                    return (
                      <tr key={f.id} className="border-b border-white/5 hover:bg-white/2">
                        <td className="px-4 py-3 font-medium text-gray-100">{f.name}</td>
                        <td className="px-4 py-3 text-xs text-gray-500">{f.lga}</td>
                        <td className="px-4 py-3 font-mono text-sm text-green-400">{f.qty.toLocaleString()}</td>
                        <td className="px-4 py-3 text-xs text-gray-500">{pct}%</td>
                      </tr>
                    )
                  })}</tbody>
                </table></div>
              </Card>
            )
          })()}

          <div id="metric-breakdown"/>
          {metricDrill && isAdm && (() => {
            const cfg = {
              units:        { title: 'Units utilized',      mode: 'units', label: 'Units Utilized' },
              commodities:  { title: 'Commodities utilized', mode: 'units', label: 'Units Utilized', countsCommodities: true },
              transactions: { title: 'Utilization records',  mode: 'count', label: 'Utilization records' },
            }[metricDrill]
            if (!cfg) return null
            return (
              <Card>
                <CardHeader>
                  <CardTitle>{cfg.title} — breakdown</CardTitle>
                  <button onClick={()=>{setMetricDrill(null);setLgaDrill(null);setFacDrill(null)}} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">← Close</button>
                </CardHeader>
                {cfg.countsCommodities && lgaOpen && (
                  <div className="px-5 pt-3 -mb-1 text-xs text-gray-500">
                    Facilities are ranked by units utilized — a count of distinct commodities per facility is not in this aggregate.
                  </div>
                )}
                <FacilityLgaBreakdown rows={consData.byFac} mode={cfg.mode} unitsLabel={cfg.label}/>
              </Card>
            )
          })()}

        </>
      )}

      {!loading && tab==='intake' && intakeData && (() => {
      // The movement rows the table shows, narrowed by whichever card is active.
      // Filtering to rows that actually have that movement — a commodity with no
      // transfers out should not sit in a transferred-out list showing a dash.
      // Filter AND re-sort by the measure asked for. Sorting by total received
      // regardless made a filter look inert: the biggest commodity overall led
      // every list, including "transferred-in only" where its 500 units are
      // nothing beside its 123,311 of intake.
      // A redistribution is ONE event: it leaves A and arrives at B. When the
      // viewer's scope contains both ends, every transfer is counted once each way
      // and the two cards are guaranteed identical — two cards implying two
      // quantities. Detected from the data rather than from the role, so a state
      // whose transfers all stay inside it collapses correctly too.
      const balanced = intakeData.transferTxn === intakeData.outTxn
      const movementKey = { intake:'intake', transferin:'transfer', transferout:'out', received:'qty' }[intakeMetric]
      const movementRows = intakeMetric === 'redistribution'
        ? intakeData.byComm.filter(c => c.transfer > 0 || c.out > 0).slice()
            .sort((a,b) => (b.transfer + b.out) - (a.transfer + a.out))
        : (movementKey
            ? intakeData.byComm.filter(c => c[movementKey] > 0).slice().sort((a,b) => b[movementKey] - a[movementKey])
            : intakeData.byComm)
      return (
        <>
          {intakeDrill ? (() => {
            // Drilled into one commodity → the cards scope to it, and the table
            // below becomes the receipt-level list (date + quantity per intake).
            const m = intakeData.byComm.find(c=>c.commodity_id===intakeDrill.id) || { intake:0, transfer:0, qty:0, txn:0 }
            // Quantity IS meaningful here: one commodity means one unit, so it is
            // shown alongside the counts, spelled with its unit.
            const nRcpts = intakeRcpts?.id===intakeDrill.id ? intakeRcpts.rows : null
            return (
              <MetricGrid cols={5}>
                <Metric label={`${intakeDrill.name} — total intake (${period}d)`} color="green"
                  value={(nRcpts?.length ?? 0).toLocaleString()} loading={!nRcpts}/>
                <Metric label="Intake" value={(nRcpts?.filter(r=>r.kind==='Intake').length ?? 0).toLocaleString()}
                  color="blue" loading={!nRcpts}/>
                <Metric label="Transferred-In" value={(nRcpts?.filter(r=>r.kind==='Transfer').length ?? 0).toLocaleString()}
                  color="blue" loading={!nRcpts}/>
                <Metric label={`Quantity received (${intakeDrill.unit||'units'})`} value={m.qty.toLocaleString()}/>
                <Metric label="Transferred-Out" color="amber"
                  value={(nRcpts?.filter(r=>r.kind==='Transfer out').length ?? 0).toLocaleString()} loading={!nRcpts}/>
              </MetricGrid>
            )
          })() : (
          // COUNTS, not quantities. Summing quantity across commodities would add
          // reagents to test kits to rolls, producing a number that looks precise
          // but measures nothing. Counts are checkable. Per-commodity quantities
          // live in the table below, where one row is one commodity in one unit.
          <MetricGrid cols={balanced ? 3 : 4}>
            <Metric label={`Intake (${period}d)`} value={intakeData.intakeTxn.toLocaleString()} color="green"
              onClick={()=>{setLgaDrill(null);setFacDrill(null);setIntakeCommPage(0);setIntakeMetric(intakeMetric==='intake'?null:'intake')}} active={intakeMetric==='intake'}/>
            {balanced ? (
              // One card, because in and out describe the SAME movements here.
              <Metric label="Redistributions" value={intakeData.transferTxn.toLocaleString()} color="blue"
                onClick={()=>{setLgaDrill(null);setFacDrill(null);setIntakeCommPage(0);setRedistDir('in');setIntakeMetric(intakeMetric==='redistribution'?null:'redistribution')}}
                active={intakeMetric==='redistribution'}/>
            ) : (<>
              <Metric label="Transferred-In" value={intakeData.transferTxn.toLocaleString()} color="blue"
                onClick={()=>{setLgaDrill(null);setFacDrill(null);setIntakeCommPage(0);setIntakeMetric(intakeMetric==='transferin'?null:'transferin')}} active={intakeMetric==='transferin'}/>
              {/* Deliberately amber, not blue: this is stock going OUT, and must not be
                  read as another arrival alongside the two inbound cards. */}
              <Metric label="Transferred-Out" value={intakeData.outTxn.toLocaleString()} color="amber"
                onClick={()=>{setLgaDrill(null);setFacDrill(null);setIntakeCommPage(0);setIntakeMetric(intakeMetric==='transferout'?null:'transferout')}} active={intakeMetric==='transferout'}/>
            </>)}
            {/* A different measure from the three above — how many DISTINCT commodities
                arrived, not how many movements. Clicking it clears the filter. */}
            <Metric label="Commodities received" value={intakeData.byComm.filter(c=>c.qty>0).length} color="blue"
              onClick={()=>{setLgaDrill(null);setFacDrill(null);setIntakeCommPage(0);setIntakeMetric(intakeMetric==='received'?null:'received')}} active={intakeMetric==='received'}/>
          </MetricGrid>
          )}


          <Card>
            <CardHeader><CardTitle>{intakeDrill ? `Daily quantity received — ${intakeDrill.name}` : (
              intakeMetric==='intake'      ? 'Daily stock intake' :
              intakeMetric==='transferin'  ? 'Daily transferred-in' :
              intakeMetric==='transferout' ? 'Daily transferred-out' :
              intakeMetric==='redistribution' ? (redistDir==='out' ? 'Daily redistributions sent' : 'Daily redistributions received') :
                                             'Daily stock received'
            )}</CardTitle></CardHeader>
            <CardBody>
              {(() => {
                // Drilled in → rebuild the series from this commodity's receipts,
                // reusing the tab's ordered date buckets so the axis doesn't move.
                // One commodity means one unit, so quantity is plotted there; the
                // section-level chart plots intake counts instead (mixed units).
                const daily = intakeDrill
                  ? (intakeRcpts?.id===intakeDrill.id ? intakeRcpts.rows : []).reduce((m,r)=>{
                      const k = r.at ? String(r.at).slice(0,10) : null
                      if (k && m[k]!==undefined) m[k] += r.qty
                      return m
                    }, Object.fromEntries(Object.keys(intakeData.daily).map(k=>[k,0])))
                  : intakeMetric==='intake'      ? intakeData.dailyIntake
                  : intakeMetric==='transferin'  ? intakeData.dailyIn
                  : intakeMetric==='transferout' ? intakeData.dailyOut
                  : intakeMetric==='redistribution' ? (redistDir==='out' ? intakeData.dailyOut : intakeData.dailyIn)
                  : intakeData.dailyCount
                return <DailyTrendChart daily={daily} unit={intakeDrill ? (intakeDrill.unit||'units')
                  : intakeMetric==='intake' ? 'intakes'
                  : intakeMetric==='transferin' ? 'transfers in'
                  : intakeMetric==='transferout' ? 'transfers out'
                  : intakeMetric==='redistribution' ? (redistDir==='out' ? 'sent' : 'received') : 'intakes'}/>
              })()}
            </CardBody>
          </Card>

          <Card>
            {intakeDrill ? (() => {
              // ── Receipt-level detail: the date and quantity of every intake ──
              const all = intakeRcpts?.id===intakeDrill.id ? intakeRcpts.rows : []
              // 'all' means all INBOUND. Outbound is opt-in, never mixed into a
              // received total — the two directions must not be summed.
              const inbound = all.filter(r => r.kind!=='Transfer out')
              const rows = intakeSource==='all'      ? inbound
                         : intakeSource==='intake'   ? all.filter(r=>r.kind==='Intake')
                         : intakeSource==='transfer' ? all.filter(r=>r.kind==='Transfer')
                                                     : all.filter(r=>r.kind==='Transfer out')
              const total = rows.reduce((s,r)=>s+r.qty,0)
              const outward = intakeSource==='out'
              const base = (intakeDrill.name||'commodity').replace(/[^a-z0-9]+/gi,'_').replace(/^_+|_+$/g,'')
              const headers = ['Date','Source',outward?'To':'From','Facility','Quantity','Batch','Expiry',outward?'Actioned by':'Received by']
              const expRows = () => rows.map(r=>[fmtDate(r.at), r.kind, r.source, r.facility, r.qty, r.batch, r.expiry?fmtDate(r.expiry):'—', r.by])
              const btnCls = "text-xs text-gray-300 hover:text-white border border-white/10 rounded px-3 py-1.5 disabled:opacity-50"
              return (
                <>
                  <CardHeader>
                    <CardTitle>{intakeDrill.name} — {outward?'transferred out':'intake'} ({rows.length}, {total.toLocaleString()} {intakeDrill.unit||'units'})</CardTitle>
                    <div className="flex gap-2 flex-wrap">
                      <button onClick={()=>exportCsv(`${base}_intake.csv`, headers, expRows())} disabled={!rows.length} className={btnCls}>Download CSV</button>
                      <button onClick={()=>exportPdf(`${intakeDrill.name} — intake`, null, headers, expRows(), new Set([4]))} disabled={!rows.length} className={btnCls}>Print / Save as PDF</button>
                      <select value={intakeSource} onChange={e=>{setIntakeSource(e.target.value);setDeliveryPage(0)}} className={btnCls} title="Filter by where the stock came from">
                        <option value="all">All received ({inbound.length})</option>
                        <option value="intake">Intake ({all.filter(r=>r.kind==='Intake').length})</option>
                        <option value="transfer">Transferred-In ({all.filter(r=>r.kind==='Transfer').length})</option>
                        <option value="out">Transferred-Out ({all.filter(r=>r.kind==='Transfer out').length})</option>
                      </select>
                      <button onClick={()=>{setIntakeDrill(null);setIntakeSource('all')}} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">← All commodities</button>
                    </div>
                  </CardHeader>
                  {intakeRcpts?.id!==intakeDrill.id ? <LoadingState/> : !rows.length ? (
                    <EmptyState message={outward?'This commodity was not transferred out in this period.':'No intake of this commodity in this period.'}/>
                  ) : (
                    <div className="table-wrap"><table className="w-full text-sm">
                      <thead><tr className="border-b border-white/8 bg-white/2">
                        {headers.map(h=>(
                          <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>{pageSlice(rows, deliveryPage).slice.map(r=>(
                        <tr key={`${r.kind}-${r.id}`} className="border-b border-white/5 hover:bg-white/2">
                          <td className="px-4 py-3 text-gray-300 whitespace-nowrap">{fmtDate(r.at)}</td>
                          <td className="px-4 py-3"><CatBadge>{r.kind}</CatBadge></td>
                          <td className="px-4 py-3 text-xs text-gray-400">{r.source}</td>
                          <td className="px-4 py-3 text-xs text-gray-500">{r.facility}</td>
                          <td className="px-4 py-3 font-mono text-sm text-green-400">{r.qty.toLocaleString()} {intakeDrill.unit||''}</td>
                          <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.batch}</td>
                          <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                            {r.expiry?fmtDate(r.expiry):'—'}
                            {r.extraExpiries>0 && <span className="text-gray-600" title="This intake drew on several lots; the earliest expiry is shown"> +{r.extraExpiries}</span>}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-500">{r.by}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                    <Pagination pager={pageSlice(rows, deliveryPage)} onPage={setDeliveryPage} unit="intake records"/>
                    </div>
                  )}
                  {/* Which facilities this commodity reached. Sits BELOW the intake list:
                      the per-intake rows are what the drill was opened for, and a
                      29-row summary above them pushed the actual table off screen. Derived from the rows already fetched — the
                      facility is on every one of them — so it costs no request. */}
                  {intakeRcpts?.id===intakeDrill.id && rows.length > 0 && isAdm && (() => {
                    const byFac = {}
                    rows.forEach(r => { byFac[r.facility] = (byFac[r.facility] || 0) + r.qty })
                    const list = Object.entries(byFac).sort((a,b)=>b[1]-a[1])
                    const tot = list.reduce((s2,[,v])=>s2+v,0) || 1
                    if (list.length < 2) return null   // one facility says nothing a list wouldn't
                    return (
                      <div className="px-5 pb-3">
                        <div className="text-xs text-gray-500 uppercase tracking-widest mb-2">
                          By facility <span className="normal-case tracking-normal text-gray-600">— {list.length} facilities</span>
                        </div>
                        <div className="space-y-2">
                          {list.map(([name,v])=>{
                            const pct=Math.round((v/tot)*100)||0
                            return (
                              <div key={name}>
                                <div className="flex justify-between mb-1">
                                  <span className="text-sm text-gray-300">{name}</span>
                                  <span className="text-xs font-mono text-gray-500">{pct}% · {v.toLocaleString()} {intakeDrill.unit||''}</span>
                                </div>
                                <div className="h-1.5 bg-white/5 rounded-full">
                                  <div style={{width:`${pct}%`,height:'100%',background:'#3fb950',borderRadius:'9999px'}}/>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })()}
                </>
              )
            })() : (
              <>
                <CardHeader>
                  <CardTitle>{
                    intakeMetric==='intake'      ? 'Commodity movement — intake only' :
                    intakeMetric==='transferin'  ? 'Commodity movement — transferred-in only' :
                    intakeMetric==='transferout' ? 'Commodity movement — transferred-out only' :
                    intakeMetric==='received'    ? 'Commodity movement — received only' :
                    intakeMetric==='redistribution' ? 'Commodity movement — redistributed only' :
                                                   'Commodity movement'
                  }</CardTitle>
                  <div className="flex items-center gap-3">
                    {intakeMetric && <button onClick={()=>{setIntakeMetric(null);setIntakeCommPage(0)}} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-2 py-1">Clear filter</button>}
                    <span className="text-xs text-gray-500">click a commodity for its dates &amp; quantities</span>
                  </div>
                </CardHeader>
                {!movementRows.length ? <EmptyState message="Nothing matching this filter in the period."/> : (
                  <div className="table-wrap"><table className="w-full text-sm">
                    <thead><tr className="border-b border-white/8 bg-white/2">
                      {/* No "share of total" column: the total would be a sum across
                          different units, so a percentage of it means nothing. The
                          quantities below are per-commodity, hence per-unit, and are
                          spelled with their unit. */}
                      {/* When the scope holds both ends of every transfer, Transferred-In
                          and Transferred-Out are the SAME movements per commodity and the
                          two columns print identical numbers. One "Redistributed" column
                          says it once. Split back apart when they genuinely differ. */}
                      {['#','Commodity','Category',
                        intakeMetric==='intake' ? 'Intake records' :
                        intakeMetric==='transferin' ? 'Transfers in' :
                        intakeMetric==='transferout' ? 'Transfers out' :
                        intakeMetric==='redistribution' ? 'Redistributions' : 'Records',
                        'Intake',
                        ...(balanced ? ['Redistributed','Total Received']
                                     : ['Transferred-In','Total Received','Transferred-Out'])].map(h=>(
                        <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>{(() => {
                      const pg = pageSlice(movementRows, intakeCommPage)
                      return pg.slice.map((c,i)=>(
                        <tr key={c.commodity_id}
                            onClick={()=>{setIntakeSource('all');setDeliveryPage(0);setIntakeDrill({id:c.commodity_id,name:c.name,unit:c.unit})}}
                            className="border-b border-white/5 hover:bg-white/5 cursor-pointer">
                          <td className="px-4 py-3 font-mono text-xs text-gray-600">{pg.offset + i + 1}</td>
                          <td className="px-4 py-3 font-medium text-gray-100">{c.name} ›</td>
                          <td className="px-4 py-3"><CatBadge>{c.cat}</CatBadge></td>
                          <td className="px-4 py-3 text-gray-400">{(
                            intakeMetric==='intake' ? c.intakeTxn :
                            intakeMetric==='transferin' ? c.transferTxn :
                            intakeMetric==='transferout' ? c.outTxn :
                            intakeMetric==='redistribution' ? (redistDir==='out' ? c.outTxn : c.transferTxn) : c.txn
                          ).toLocaleString()}</td>
                          <td className="px-4 py-3 font-mono text-sm text-gray-400">{c.intake.toLocaleString()}</td>
                          {balanced ? (<>
                            {/* One movement, one column: it left a facility and arrived at
                                another, both inside this view. */}
                            <td className="px-4 py-3 font-mono text-sm text-amber-400">{c.transfer ? `${c.transfer.toLocaleString()} ${c.unit}` : '—'}</td>
                            <td className="px-4 py-3 font-mono text-sm text-green-400">{c.qty.toLocaleString()} {c.unit}</td>
                          </>) : (<>
                            <td className="px-4 py-3 font-mono text-sm text-gray-400">{c.transfer.toLocaleString()}</td>
                            <td className="px-4 py-3 font-mono text-sm text-green-400">{c.qty.toLocaleString()} {c.unit}</td>
                            {/* Amber and last: stock leaving, never part of the received total. */}
                            <td className="px-4 py-3 font-mono text-sm text-amber-400">{c.out ? `${c.out.toLocaleString()} ${c.unit}` : '—'}</td>
                          </>)}
                        </tr>
                      ))
                    })()}</tbody>
                  </table>
                  <Pagination pager={pageSlice(movementRows, intakeCommPage)} onPage={setIntakeCommPage} unit="commodities"/>
                  </div>
                )}
              </>
            )}
          </Card>

          {intakeMetric && intakeMetric!=='received' && !intakeDrill && isAdm && (() => {
            // The totals are identical when the scope holds both ends, but the
            // FACILITIES are not: a hub ships out far more than it takes in. That is
            // the whole reason the collapsed card still needs a direction toggle.
            const redist = intakeMetric === 'redistribution'
            const dir = redist ? redistDir : intakeMetric==='transferout' ? 'out' : intakeMetric==='transferin' ? 'in' : null
            const cfg = redist
              ? { title: 'Redistributions',
                  fac: redistDir==='out' ? intakeData.outByFac : intakeData.transferByFac,
                  label: redistDir==='out' ? 'Transferred-Out' : 'Transferred-In' }
              : {
                  intake:      { title: 'Intake',          fac: intakeData.intakeByFac,   label: 'Intake records' },
                  transferin:  { title: 'Transferred-In',  fac: intakeData.transferByFac, label: 'Transferred-In' },
                  transferout: { title: 'Transferred-Out', fac: intakeData.outByFac,      label: 'Transferred-Out' },
                }[intakeMetric]
            if (!cfg) return null
            const tab = (v,l) => (
              <button key={v} onClick={()=>{setRedistDir(v);setLgaDrill(null);setFacDrill(null)}}
                className={`text-xs px-2.5 py-1 rounded border ${redistDir===v
                  ? 'border-blue-500/60 text-gray-100 bg-white/5' : 'border-white/10 text-gray-500 hover:text-gray-300'}`}>{l}</button>
            )
            return (
              <Card>
                <CardHeader>
                  <CardTitle>{cfg.title} — by {dir==='out' ? 'sending ' : ''}LGA &amp; facility</CardTitle>
                  <div className="flex items-center gap-2">
                    {redist && <>{tab('in','Transferred-In')}{tab('out','Transferred-Out')}</>}
                    <button onClick={()=>{setIntakeMetric(null);setLgaDrill(null);setFacDrill(null)}} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">← Close</button>
                  </div>
                </CardHeader>
                {redist && (
                  <div className="px-5 pt-1 -mb-1 text-xs text-gray-500">
                    Every redistribution leaves one facility and arrives at another, so both directions
                    count the same {intakeData.transferTxn.toLocaleString()} movements — the facilities differ, the total cannot.
                  </div>
                )}
                <FacilityLgaBreakdown rows={cfg.fac} mode="count" unitsLabel={cfg.label}
                  leaf={dir === 'in' ? 'in' : dir === 'out' ? 'out' : 'intake'}/>
              </Card>
            )
          })()}

        </>
      )})()}

      {!loading && tab==='adjustments' && adjData && (() => {
      // Filter AND re-sort by the direction asked for, so the top of the list is
      // what the card counted rather than always the biggest overall.
      const adjRowsFiltered = adjMetric==='positive' ? adjData.byComm.filter(c=>c.upTxn>0).slice().sort((a,b)=>b.upTxn-a.upTxn)
        : adjMetric==='negative' ? adjData.byComm.filter(c=>c.downTxn>0).slice().sort((a,b)=>b.downTxn-a.downTxn)
        : adjData.byComm
      return (
        <>
          {adjDrill ? (() => {
            const m = adjData.byComm.find(c=>c.commodity_id===adjDrill.id) || { up:0, down:0, upTxn:0, downTxn:0, txn:0 }
            return (
              <MetricGrid>
                <Metric label={`${adjDrill.name} — adjustments (${period}d)`} value={m.txn.toLocaleString()} color="green"/>
                <Metric label="Positive adjustments" value={m.upTxn.toLocaleString()} color="blue"/>
                <Metric label="Negative adjustments" value={m.downTxn.toLocaleString()} color="amber"/>
                {/* Quantities are safe here: one commodity, one unit. Shown as two
                    figures, never a net — +5,000/−5,000 must not read as zero. */}
                <Metric label={`Quantity +/− (${adjDrill.unit||'units'})`}
                  value={`+${m.up.toLocaleString()} / −${m.down.toLocaleString()}`}/>
              </MetricGrid>
            )
          })() : (
          // Counts, for the same reason as the Intake tab: a quantity total across
          // commodities would be adding different units together.
          <MetricGrid>
            {/* Same shape as Intake: each card FILTERS the table below rather than
                opening a panel of its own, and the total clears the filter. */}
            <Metric label={`Adjustments (${period}d)`} value={(adjData.upTxn+adjData.downTxn).toLocaleString()} color="green"
              onClick={()=>{setLgaDrill(null);setFacDrill(null);setAdjCommPage(0);setAdjMetric(null)}} active={!adjMetric}/>
            <Metric label="Positive adjustments" value={adjData.upTxn.toLocaleString()} color="blue"
              onClick={()=>{setLgaDrill(null);setFacDrill(null);setAdjCommPage(0);setAdjMetric(adjMetric==='positive'?null:'positive')}} active={adjMetric==='positive'}/>
            <Metric label="Negative adjustments" value={adjData.downTxn.toLocaleString()} color="amber"
              onClick={()=>{setLgaDrill(null);setFacDrill(null);setAdjCommPage(0);setAdjMetric(adjMetric==='negative'?null:'negative')}} active={adjMetric==='negative'}/>
            {/* Plain figure: every commodity in the table has been adjusted, so a
                filter here would select the whole list and do nothing. */}
            <Metric label="Commodities adjusted" value={adjData.byComm.length} color="blue"/>
          </MetricGrid>
          )}



          <Card>
            <CardHeader><CardTitle>{adjDrill ? `Daily adjustments — ${adjDrill.name}` : (
              adjMetric==='positive' ? 'Daily positive adjustments' :
              adjMetric==='negative' ? 'Daily negative adjustments' : 'Daily adjustments'
            )}</CardTitle></CardHeader>
            <CardBody>
              {(() => {
                const daily = adjDrill
                  ? (adjRows?.id===adjDrill.id ? adjRows.rows : []).reduce((mm,r)=>{
                      const k = r.adjusted_at ? String(r.adjusted_at).slice(0,10) : null
                      if (k && mm[k]!==undefined) mm[k] += 1
                      return mm
                    }, Object.fromEntries(Object.keys(adjData.daily).map(k=>[k,0])))
                  : adjMetric==='positive' ? adjData.dailyUp
                  : adjMetric==='negative' ? adjData.dailyDown
                  : adjData.daily
                return <DailyTrendChart daily={daily} unit="adjustments"/>
              })()}
            </CardBody>
          </Card>

          {!adjDrill && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            {/* Reasons, side by side rather than pooled. The SAME wording carries a
                different meaning in each column — "Physical count correction" appears
                as both a positive and a negative — so one merged list would collapse
                two distinct events into a single row. */}
            {[['Increase','Positive adjustments','#3fb950'],['Decrease','Negative adjustments','#d29922']]
              // The card filters with its metric: asking for positive adjustments and
              // being shown the negative reasons beside them is the same mixing the
              // rest of this tab now avoids.
              .filter(([type]) => !adjMetric
                || (adjMetric==='positive' && type==='Increase')
                || (adjMetric==='negative' && type==='Decrease'))
              .map(([type,title,colour])=>{
              const list = adjData.byReason[type] || []
              const tot = list.reduce((s,r)=>s+r.txn,0) || 1
              return (
                <Card key={type}>
                  <CardHeader><CardTitle>{title} — by reason</CardTitle>
                    <span className="text-xs text-gray-500">{list.reduce((s,r)=>s+r.txn,0).toLocaleString()} total</span>
                  </CardHeader>
                  {/* 'Expired' here is stock ALREADY removed; the Expiry tab shows what
                      is still on the shelf. Debiting the lot is what keeps them apart. */}
                  {type==='Decrease' && list.some(r=>r.reason==='Expired') && (
                    <div className="px-5 -mb-2 text-xs text-gray-500">
                      “Expired” is stock already written off — the Expiry tab shows only what is
                      <span className="text-gray-400"> still on hand</span>.
                    </div>
                  )}
                  <CardBody>
                    {!list.length ? <div className="text-sm text-gray-500">None in this period.</div> : (
                      <div className="space-y-2">
                        {list.map(r=>{
                          const pct = Math.round((r.txn/tot)*100)||0
                          const on = reasonDrill?.reason===r.reason && reasonDrill?.type===type
                          return (
                            <button key={r.reason} type="button" disabled={!isAdm}
                              onClick={()=>{setReasonFac(null);setReasonDrill(on ? null : { reason:r.reason, type })}}
                              className={`w-full text-left group ${isAdm ? 'cursor-pointer' : 'cursor-default'}`}>
                              <div className="flex justify-between mb-1">
                                <span className={`text-sm ${on ? 'text-gray-100' : 'text-gray-300 group-hover:text-gray-100'}`}>{r.reason}{isAdm && ' ›'}</span>
                                <span className="text-xs font-mono text-gray-500">{pct}% · {r.txn.toLocaleString()}</span>
                              </div>
                              <div className="h-1.5 bg-white/5 rounded-full">
                                <div style={{width:`${pct}%`,height:'100%',background:colour,borderRadius:'9999px',opacity:on?1:0.75}}/>
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </CardBody>
                </Card>
              )
            })}
          </div>
          )}

          {isAdm && reasonDrill && !adjDrill && (() => {
            const dirLabel = reasonDrill.type==='Increase' ? 'positive' : 'negative'
            const key = `${reasonDrill.type}|${reasonDrill.reason}`
            // Second level: one facility's commodities for that same reason.
            if (reasonFac) {
              const ready = reasonComms?.key === `${key}|${reasonFac.id}`
              const rows = ready ? reasonComms.rows : null
              const tot = (rows||[]).reduce((s2,r)=>s2+r.txn,0) || 1
              return (
                <Card>
                  <CardHeader>
                    <CardTitle>{reasonFac.name} — “{reasonDrill.reason}” ({dirLabel})</CardTitle>
                    <button onClick={()=>setReasonFac(null)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">← All facilities</button>
                  </CardHeader>
                  {!rows ? <LoadingState/> : !rows.length ? <EmptyState message="Nothing recorded for this facility and reason."/> : (
                    <div className="table-wrap"><table className="w-full text-sm">
                      <thead><tr className="border-b border-white/8 bg-white/2">
                        {['#','Commodity','Category','Adjustments','Quantity','Share'].map(h=>(
                          <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>{rows.map((r,i)=>{
                        const c = commMeta[r.commodity_id]
                        return (
                          <tr key={r.commodity_id} className="border-b border-white/5 hover:bg-white/2">
                            <td className="px-4 py-3 font-mono text-xs text-gray-600">{i+1}</td>
                            <td className="px-4 py-3 font-medium text-gray-100">{c?.name || r.commodity_id}</td>
                            <td className="px-4 py-3"><CatBadge>{c?.category || 'Other'}</CatBadge></td>
                            <td className="px-4 py-3 text-gray-300">{r.txn.toLocaleString()}</td>
                            <td className={`px-4 py-3 font-mono text-sm ${reasonDrill.type==='Increase'?'text-green-400':'text-amber-400'}`}>
                              {reasonDrill.type==='Increase'?'+':'−'}{r.qty.toLocaleString()} {c?.unit || ''}
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-500">{Math.round((r.txn/tot)*100)||0}%</td>
                          </tr>
                        )
                      })}</tbody>
                    </table></div>
                  )}
                </Card>
              )
            }
            // First level: which facilities gave that reason.
            const ready = reasonFacs?.key === key
            const rows = ready ? reasonFacs.rows : null
            const tot = (rows||[]).reduce((s2,r)=>s2+r.txn,0) || 1
            return (
              <Card>
                <CardHeader>
                  <CardTitle>“{reasonDrill.reason}” ({dirLabel}) — by facility</CardTitle>
                  <button onClick={()=>setReasonDrill(null)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">← Close</button>
                </CardHeader>
                {!rows ? <LoadingState/> : !rows.length ? <EmptyState message="No facility recorded this reason in the period."/> : (
                  <div className="table-wrap"><table className="w-full text-sm">
                    <thead><tr className="border-b border-white/8 bg-white/2">
                      {['#','Facility','LGA','Adjustments','Share'].map(h=>(
                        <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>{rows.map((r,i)=>(
                      <tr key={r.facility_id}
                          onClick={()=>setReasonFac({id:r.facility_id,name:facMeta[r.facility_id]?.name||'—',lga:facMeta[r.facility_id]?.lga||'—'})}
                          className="border-b border-white/5 hover:bg-white/5 cursor-pointer">
                        <td className="px-4 py-3 font-mono text-xs text-gray-600">{i+1}</td>
                        <td className="px-4 py-3 font-medium text-gray-100">{facMeta[r.facility_id]?.name||'—'}<span className="text-gray-600 ml-1">›</span></td>
                        <td className="px-4 py-3 text-xs text-gray-500">{facMeta[r.facility_id]?.lga||'—'}</td>
                        <td className="px-4 py-3 text-gray-300">{r.txn.toLocaleString()}</td>
                        <td className="px-4 py-3 text-xs text-gray-500">{Math.round((r.txn/tot)*100)||0}%</td>
                      </tr>
                    ))}</tbody>
                  </table></div>
                )}
              </Card>
            )
          })()}

          <Card>
            {adjDrill ? (() => {
              const all = adjRows?.id===adjDrill.id ? adjRows.rows : []
              const rows = adjType==='all' ? all : all.filter(r=>r.adjustment_type===adjType)
              const base = (adjDrill.name||'commodity').replace(/[^a-z0-9]+/gi,'_').replace(/^_+|_+$/g,'')
              const headers = ['Date','Type','Quantity','Reason','Batch','Expiry','Facility','Adjusted by']
              const expRows = () => rows.map(r=>[fmtDate(r.adjusted_at), r.adjustment_type, r.quantity,
                r.reason||'(not stated)', r.batch_number||'—', r.expiry_date?fmtDate(r.expiry_date):'—',
                r.facilities?.name||facMeta[r.facility_id]?.name||'—', r.adjusted_by||'—'])
              const btnCls = "text-xs text-gray-300 hover:text-white border border-white/10 rounded px-3 py-1.5 disabled:opacity-50"
              return (
                <>
                  <CardHeader>
                    <CardTitle>{adjDrill.name} — adjustments ({rows.length})</CardTitle>
                    <div className="flex gap-2 flex-wrap">
                      <button onClick={()=>exportCsv(`${base}_adjustments.csv`, headers, expRows())} disabled={!rows.length} className={btnCls}>Download CSV</button>
                      <button onClick={()=>exportPdf(`${adjDrill.name} — adjustments`, null, headers, expRows(), new Set([2]))} disabled={!rows.length} className={btnCls}>Print / Save as PDF</button>
                      <select value={adjType} onChange={e=>{setAdjType(e.target.value);setAdjRowPage(0)}} className={btnCls} title="Filter by direction">
                        <option value="all">Both directions ({all.length})</option>
                        <option value="Increase">Positive ({all.filter(r=>r.adjustment_type==='Increase').length})</option>
                        <option value="Decrease">Negative ({all.filter(r=>r.adjustment_type==='Decrease').length})</option>
                      </select>
                      <button onClick={()=>{setAdjDrill(null);setAdjType('all')}} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">← All commodities</button>
                    </div>
                  </CardHeader>
                  {adjRows?.id!==adjDrill.id ? <LoadingState/> : !rows.length ? (
                    <EmptyState message="No adjustments of this commodity in this period."/>
                  ) : (
                    <div className="table-wrap"><table className="w-full text-sm">
                      <thead><tr className="border-b border-white/8 bg-white/2">
                        {headers.map(h=>(
                          <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>{pageSlice(rows, adjRowPage).slice.map(r=>{
                        const up = r.adjustment_type==='Increase'
                        return (
                          <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
                            <td className="px-4 py-3 text-gray-300 whitespace-nowrap">{fmtDate(r.adjusted_at)}</td>
                            <td className={`px-4 py-3 text-xs font-medium ${up?'text-green-400':'text-amber-400'}`}>{up?'Positive':'Negative'}</td>
                            <td className={`px-4 py-3 font-mono text-sm ${up?'text-green-400':'text-amber-400'}`}>
                              {up?'+':'−'}{Number(r.quantity||0).toLocaleString()} {adjDrill.unit||''}
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-400">{r.reason||'(not stated)'}</td>
                            <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.batch_number||'—'}</td>
                            <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{r.expiry_date?fmtDate(r.expiry_date):'—'}</td>
                            <td className="px-4 py-3 text-xs text-gray-500">{r.facilities?.name||facMeta[r.facility_id]?.name||'—'}</td>
                            <td className="px-4 py-3 text-xs text-gray-500">{r.adjusted_by||'—'}</td>
                          </tr>
                        )
                      })}</tbody>
                    </table>
                    <Pagination pager={pageSlice(rows, adjRowPage)} onPage={setAdjRowPage} unit="adjustments"/>
                    </div>
                  )}
                </>
              )
            })() : (
              <>
                <CardHeader>
                  <CardTitle>{
                    adjMetric==='positive' ? 'Commodities adjusted — positive only' :
                    adjMetric==='negative' ? 'Commodities adjusted — negative only' :
                                             'Commodities adjusted'
                  }</CardTitle>
                  <div className="flex items-center gap-3">
                    {adjMetric && <button onClick={()=>{setAdjMetric(null);setAdjCommPage(0)}} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-2 py-1">Clear filter</button>}
                    <span className="text-xs text-gray-500">click a commodity for its adjustments &amp; reasons</span>
                  </div>
                </CardHeader>
                {!adjRowsFiltered.length ? <EmptyState message="Nothing matching this filter in the period."/> : (
                  <div className="table-wrap"><table className="w-full text-sm">
                    <thead><tr className="border-b border-white/8 bg-white/2">
                      {['#','Commodity','Category','Adjustments','Positive','Negative','Quantity +','Quantity −'].map(h=>(
                        <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>{pageSlice(adjRowsFiltered, adjCommPage).slice.map((c,i)=>(
                      <tr key={c.commodity_id}
                          onClick={()=>{setAdjType('all');setAdjRowPage(0);setAdjDrill({id:c.commodity_id,name:c.name,unit:c.unit})}}
                          className="border-b border-white/5 hover:bg-white/5 cursor-pointer">
                        <td className="px-4 py-3 font-mono text-xs text-gray-600">{pageSlice(adjRowsFiltered, adjCommPage).offset + i + 1}</td>
                        <td className="px-4 py-3 font-medium text-gray-100">{c.name} ›</td>
                        <td className="px-4 py-3"><CatBadge>{c.cat}</CatBadge></td>
                        <td className="px-4 py-3 text-gray-300">{c.txn.toLocaleString()}</td>
                        <td className="px-4 py-3 text-gray-400">{c.upTxn.toLocaleString()}</td>
                        <td className="px-4 py-3 text-gray-400">{c.downTxn.toLocaleString()}</td>
                        <td className="px-4 py-3 font-mono text-sm text-green-400">{c.up ? `+${c.up.toLocaleString()} ${c.unit}` : '—'}</td>
                        <td className="px-4 py-3 font-mono text-sm text-amber-400">{c.down ? `−${c.down.toLocaleString()} ${c.unit}` : '—'}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                  <Pagination pager={pageSlice(adjRowsFiltered, adjCommPage)} onPage={setAdjCommPage} unit="commodities"/>
                  </div>
                )}
              </>
            )}
          </Card>

          {adjMetric && !adjDrill && isAdm && (() => {
            const cfg = adjMetric==='positive'
              ? { title: 'Positive adjustments', fac: adjData.byFacUp,   label: 'Positive adjustments' }
              : { title: 'Negative adjustments', fac: adjData.byFacDown, label: 'Negative adjustments' }
            return (
              <Card>
                <CardHeader>
                  <CardTitle>{cfg.title} — by LGA &amp; facility</CardTitle>
                  <button onClick={()=>{setAdjMetric(null);setLgaDrill(null);setFacDrill(null)}} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">← Close</button>
                </CardHeader>
                <FacilityLgaBreakdown rows={cfg.fac} mode="count" unitsLabel={cfg.label} leaf="adjustment"/>
              </Card>
            )
          })()}

        </>
      )})()}

      {!loading && tab==='expiry' && (
        <>
          {!expiryData ? <EmptyState message="Loading…"/> : (
            <>
              <MetricGrid>
                <Metric label="Expired" value={expBucketRows('expired').length} color="red"
                  onClick={isAdm?()=>setExpUrgency(expUrgency==='expired'?'all':'expired'):undefined} active={expUrgency==='expired'}/>
                <Metric label="Critical (≤30d)" value={expBucketRows('critical').length} color="red"
                  onClick={isAdm?()=>setExpUrgency(expUrgency==='critical'?'all':'critical'):undefined} active={expUrgency==='critical'}/>
                <Metric label="Warning (≤90d)" value={expBucketRows('warning').length} color="amber"
                  onClick={isAdm?()=>setExpUrgency(expUrgency==='warning'?'all':'warning'):undefined} active={expUrgency==='warning'}/>
                <Metric label="Monitor (>90d)" value={expBucketRows('monitor').length} color="blue"
                  onClick={isAdm?()=>setExpUrgency(expUrgency==='monitor'?'all':'monitor'):undefined} active={expUrgency==='monitor'}/>
                <Metric label="Total batches" value={expiryData.length}
                  onClick={isAdm?()=>setExpUrgency('all'):undefined} active={expUrgency==='all'}/>
              </MetricGrid>

              {!isAdm ? (
                <Card>
                  <CardHeader><CardTitle>Expiring batches</CardTitle></CardHeader>
                  {expiryData.length===0 ? <EmptyState message="No expiring batches in this period ✓"/> : (
                    /* Facility view: flat batch list (their own batches). */
                    <div className="table-wrap"><table className="w-full text-sm">
                      <thead><tr className="border-b border-white/8 bg-white/2">
                        {['Commodity','Expiry date','Days left','Qty','Batch','Urgency'].map(h=>(
                          <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>{pageSlice(expiryData, expBatchPage).slice.map(r=>{
                        const dL=Math.round((new Date(r.expiry_date)-today)/86400000)
                        const u=dL<0?{l:'Expired',c:'text-red-500'}:dL<=30?{l:'Critical',c:'text-red-400'}:dL<=90?{l:'Warning',c:'text-amber-400'}:{l:'Monitor',c:'text-blue-400'}
                        return (
                          <tr key={`${r.commodity_id}|${r.batch_number}|${r.expiry_date}`} className="border-b border-white/5 hover:bg-white/2">
                            <td className="px-4 py-3 font-medium text-gray-100">{r.commodities?.name||'—'}</td>
                            <td className="px-4 py-3 font-mono text-xs text-gray-300">{fmtDate(r.expiry_date)}</td>
                            <td className={`px-4 py-3 font-mono text-sm font-semibold ${u.c}`}>{dL<0?`${-dL}d ago`:`${dL}d`}</td>
                            <td className="px-4 py-3 font-mono text-sm text-gray-300">{r.quantity} {r.commodities?.unit||''}</td>
                            <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.batch_number||'—'}</td>
                            <td className="px-4 py-3"><span className={`text-xs font-semibold ${u.c}`}>{u.l}</span></td>
                          </tr>
                        )
                      })}</tbody>
                    </table>
                    <Pagination pager={pageSlice(expiryData, expBatchPage)} onPage={setExpBatchPage} unit="batches"/>
                    </div>
                  )}
                </Card>
              ) : (() => {
                /* Admin view, structured like Consumption/Intake/Adjustments:
                   COMMODITIES first, then the facilities holding that commodity's
                   expiring stock, then its batches. The flat batch list this replaced
                   put every batch across every facility on one unpaged page — with
                   thousands of lots that is unreadable and slow, and it could not
                   answer "which commodity is most at risk" without manual scanning. */
                const urgencyLabel = {all:'All expiring',expired:'Expired',critical:'Critical (≤30d)',warning:'Warning (≤90d)',monitor:'Monitor (>90d)'}[expUrgency]
                const rows = (expUrgency==='all' ? expiryData : expBucketRows(expUrgency)).slice()
                  .sort((a,b)=>new Date(a.expiry_date)-new Date(b.expiry_date))
                const daysLeft = r => Math.round((new Date(r.expiry_date)-today)/86400000)
                const urg = dL => dL<0?{l:'Expired',c:'text-red-500'}:dL<=30?{l:'Critical',c:'text-red-400'}:dL<=90?{l:'Warning',c:'text-amber-400'}:{l:'Monitor',c:'text-blue-400'}

                const download = (list, name) => {
                  const headers=['Facility','LGA','Commodity','Category','Batch','Expiry date','Days left','Qty','Unit','Urgency']
                  const csv=list.map(r=>[facMeta[r.facility_id]?.name||'—',facMeta[r.facility_id]?.lga||'—',
                    r.commodities?.name||'—',r.commodities?.category||'—',r.batch_number||'',fmtDate(r.expiry_date),
                    daysLeft(r),r.quantity,r.commodities?.unit||'',urg(daysLeft(r)).l])
                  exportCsv(name, headers, csv)
                }
                const btnCls = "text-xs text-gray-300 hover:text-white border border-white/10 rounded px-3 py-1.5 disabled:opacity-50"

                // ── one commodity: the facilities holding it, and its batches ──
                if (expCommDrill) {
                  const mine = rows.filter(r => r.commodity_id === expCommDrill.id)
                  const byFac = {}
                  mine.forEach(r => {
                    const f = byFac[r.facility_id] ||= { facility_id:r.facility_id, batches:0, qty:0, soonest:null }
                    f.batches += 1; f.qty += (r.quantity||0)
                    if (!f.soonest || new Date(r.expiry_date) < new Date(f.soonest)) f.soonest = r.expiry_date
                  })
                  const facList = Object.values(byFac).sort((a,b)=>new Date(a.soonest)-new Date(b.soonest))
                  const pg = pageSlice(mine, expBatchPage)
                  // ONE table, not two. A facility summary above a batch list repeated
                  // itself line for line whenever a facility held a single batch —
                  // which is the common case. The batch rows already name the facility;
                  // they only lacked the LGA, and the facility count is in the heading.
                  return (
                    <Card>
                      <CardHeader>
                        <CardTitle>
                          {expCommDrill.name} — {urgencyLabel.toLowerCase()} stock
                          <span className="text-gray-500 font-normal"> · {mine.length} {mine.length===1?'batch':'batches'} across {facList.length} {facList.length===1?'facility':'facilities'}</span>
                        </CardTitle>
                        <div className="flex gap-2 flex-wrap">
                          <button onClick={()=>download(mine, `${(expCommDrill.name||'commodity').replace(/[^a-z0-9]+/gi,'_')}_expiring.csv`)} disabled={!mine.length} className={btnCls}>Download CSV</button>
                          <button onClick={()=>{setExpCommDrill(null);setExpBatchPage(0)}} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">← All commodities</button>
                        </div>
                      </CardHeader>
                      {!mine.length ? <EmptyState message="No expiring batches for this commodity."/> : (
                        <div className="table-wrap"><table className="w-full text-sm">
                          <thead><tr className="border-b border-white/8 bg-white/2">
                            {['#','Facility','LGA','Batch','Expiry date','Days left','Qty','Urgency'].map(h=>(
                              <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                            ))}
                          </tr></thead>
                          <tbody>{pg.slice.map((r,i)=>{
                            const dL=daysLeft(r), u=urg(dL)
                            return (
                              <tr key={`${r.facility_id}|${r.batch_number}|${r.expiry_date}`} className="border-b border-white/5 hover:bg-white/2">
                                <td className="px-4 py-3 font-mono text-xs text-gray-600">{pg.offset+i+1}</td>
                                <td className="px-4 py-3 font-medium text-gray-100">{facMeta[r.facility_id]?.name||'—'}</td>
                                <td className="px-4 py-3 text-xs text-gray-500">{facMeta[r.facility_id]?.lga||'—'}</td>
                                <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.batch_number||'(no batch)'}</td>
                                <td className="px-4 py-3 font-mono text-xs text-gray-300">{fmtDate(r.expiry_date)}</td>
                                <td className={`px-4 py-3 font-mono text-sm font-semibold ${u.c}`}>{dL<0?`${-dL}d ago`:`${dL}d`}</td>
                                <td className="px-4 py-3 font-mono text-sm text-gray-300">{r.quantity} {r.commodities?.unit||''}</td>
                                <td className={`px-4 py-3 text-xs font-semibold ${u.c}`}>{u.l}</td>
                              </tr>
                            )
                          })}</tbody>
                        </table>
                        <Pagination pager={pg} onPage={setExpBatchPage} unit="batches"/>
                        </div>
                      )}
                    </Card>
                  )
                }

                // ── all commodities with expiring stock, worst first ──
                const byComm = {}
                rows.forEach(r => {
                  const c = byComm[r.commodity_id] ||= {
                    commodity_id: r.commodity_id, name: r.commodities?.name || '—',
                    cat: r.commodities?.category || 'Other', unit: r.commodities?.unit || '',
                    batches: 0, qty: 0, facilities: new Set(), soonest: null,
                  }
                  c.batches += 1; c.qty += (r.quantity||0); c.facilities.add(r.facility_id)
                  if (!c.soonest || new Date(r.expiry_date) < new Date(c.soonest)) c.soonest = r.expiry_date
                })
                // Soonest expiry first: the ranking that matches what the tab is for.
                const commList = Object.values(byComm).sort((a,b)=>new Date(a.soonest)-new Date(b.soonest))
                const pg = pageSlice(commList, expCommPage)
                return (
                  <Card>
                    <CardHeader>
                      <CardTitle>{urgencyLabel} — by commodity <span className="text-gray-500 font-normal">· {rows.length} {rows.length===1?'batch':'batches'}</span></CardTitle>
                      <div className="flex items-center gap-3">
                        <button onClick={()=>download(rows, `expiring-batches_${expUrgency}.csv`)} disabled={!rows.length} className={btnCls}>Download CSV</button>
                        <span className="text-xs text-gray-500">click a commodity for its facilities</span>
                      </div>
                    </CardHeader>
                    {!commList.length ? <EmptyState message="No expiring batches in this view ✓"/> : (
                      <div className="table-wrap"><table className="w-full text-sm">
                        <thead><tr className="border-b border-white/8 bg-white/2">
                          {['#','Commodity','Category','Facilities','Batches','Quantity','Soonest expiry','Urgency'].map(h=>(
                            <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                          ))}
                        </tr></thead>
                        <tbody>{pg.slice.map((c,i)=>{
                          const dL=Math.round((new Date(c.soonest)-today)/86400000), u=urg(dL)
                          return (
                            <tr key={c.commodity_id}
                                onClick={()=>{setExpBatchPage(0);setExpCommDrill({id:c.commodity_id,name:c.name,unit:c.unit})}}
                                className="border-b border-white/5 hover:bg-white/5 cursor-pointer">
                              <td className="px-4 py-3 font-mono text-xs text-gray-600">{pg.offset+i+1}</td>
                              <td className="px-4 py-3 font-medium text-gray-100">{c.name}<span className="text-gray-600 ml-1">›</span></td>
                              <td className="px-4 py-3"><CatBadge>{c.cat}</CatBadge></td>
                              <td className="px-4 py-3 text-gray-300">{c.facilities.size}</td>
                              <td className="px-4 py-3 text-gray-300">{c.batches}</td>
                              <td className="px-4 py-3 font-mono text-sm text-gray-300">{c.qty.toLocaleString()} {c.unit}</td>
                              <td className="px-4 py-3 font-mono text-xs text-gray-300">{fmtDate(c.soonest)}</td>
                              <td className={`px-4 py-3 text-xs font-semibold ${u.c}`}>{u.l}</td>
                            </tr>
                          )
                        })}</tbody>
                      </table>
                      <Pagination pager={pg} onPage={setExpCommPage} unit="commodities"/>
                      </div>
                    )}
                  </Card>
                )
              })()}
            </>
          )}
        </>
      )}
    </div>
  )
}
