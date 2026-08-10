import { useState, useEffect } from 'react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/appStore'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { MetricGrid, Metric } from '../../components/ui/Metric'
import { CatBadge } from '../../components/ui/Badge'
import { LoadingState, EmptyState, Spinner } from '../../components/ui/Loading'
import { fmtDate } from '../../utils/helpers'
import { FacilityPicker } from '../../components/ui/FacilityPicker'
import { DailyTrendChart } from '../../components/DailyTrendChart'
import { exportCsv, exportPdf } from '../../utils/download'

// ── Reporting period ──────────────────────────────────────────────────────────
// "Last N days" means N COMPLETE calendar days ending yesterday — local dates,
// midnight to midnight. It deliberately excludes today, so a period is settled
// and reproducible: the same selection queried twice returns the same number.
//
// It used to be a rolling `now - N days` with no upper bound, which meant the
// oldest day was a partial (everything before the load time was missing) and the
// newest was today-so-far. That is what made a "last 7 days" figure disagree with
// a Mon–Sun export of the same week, and it let mis-keyed future dates (2027+)
// count as consumption because nothing bounded the top of the range.
const localDay = d => {
  const t = new Date(d)
  return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`
}
// [start, end] covering the N complete days before today, inclusive. `end` is the
// last instant of yesterday because the API's `to` bound is inclusive (<=).
function periodWindow(days, from = new Date()) {
  const midnightToday = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  const start = new Date(midnightToday); start.setDate(start.getDate() - days)
  const end = new Date(midnightToday.getTime() - 1)
  return { start, end }
}

export function Monitoring() {
  const store = useAppStore()
  const isAdm = store.isAdmin()
  const commoditySection = store.commoditySection
  const [tab, setTab]       = useState('consumption')
  const [period, setPeriod] = useState(30)
  const [consData, setCons] = useState(null)
  const [expiryData, setExpiryData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [catDrill, setCatDrill]   = useState(null)  // category drilled into
  const [commDrill, setCommDrill] = useState(null)  // { id, name, unit } drilled into
  const [metricDrill, setMetricDrill] = useState(null)  // 'units' | 'transactions' | 'commodities'
  const [lgaDrill, setLgaDrill] = useState(null)  // LGA name drilled into within a by-LGA breakdown
  const [catHover, setCatHover] = useState(null)  // category hovered in the donut (highlight only)
  const [consFilter, setConsFilter] = useState('consuming')  // commodity drill facility filter: 'consuming' | 'none' | 'all'
  const [expUrgency, setExpUrgency] = useState('all')  // expiry urgency filter: 'all'|'expired'|'critical'|'warning'|'monitor'
  const [expPeriod, setExpPeriod] = useState(180)   // expiry look-ahead window (days)
  const [catFilter, setCatFilter] = useState('')    // commodity category narrowing (consumption)
  const [expCat, setExpCat]       = useState('')    // commodity category narrowing (expiry)

  // Honour the admin's facility/LGA/state scope (same resolution as stock loads)
  // so Consumption and Expiry stay within the viewer's jurisdiction.
  const { fid, scopeIds } = store.getAdminStockScope()
  const scopeKey = fid || (scopeIds && scopeIds.length ? scopeIds.join(',') : 'all')
  // Compact scope params ({ facility_id } | { state[, lga] } | {}) that the server
  // resolves — instead of enumerating hundreds of facility ids in the URL, which
  // overflows proxy request-URI limits on large states and silently 404s.

  // Facility metadata for LGA / facility drill-downs
  const facMeta = {}
  store.allFacilities.forEach(f => { facMeta[f.id] = { name: f.name, lga: f.lga || '—' } })
  const categories = [...new Set(store.allCommodities.map(c => c.category).filter(Boolean))].sort()

  useEffect(() => { loadConsumption() }, [scopeKey, period, catFilter])
  useEffect(() => { if (tab==='expiry') loadExpiry() }, [tab, expPeriod, expCat, scopeKey])

  async function loadConsumption() {
    setLoading(true)
    setCatDrill(null); setCommDrill(null); setMetricDrill(null); setLgaDrill(null)
    const { start, end } = periodWindow(period)
    const scopeParams = store.getAdminScopeParams()

    // Paginate — an admin over a long period easily exceeds the 1000-row cap,
    // which would otherwise silently understate totals and drill-downs.
    const fetchRows = async (from, to) => {
      const PAGE = 1000
      let out = []
      for (let offset = 0; ; offset += PAGE) {
        let data
        try {
          data = await api.dispense.history({
            ...scopeParams,
            // commodity scope is applied server-side via the section/category scope;
            // enumerating every commodity id here would bloat the URL past proxy limits.
            from: from.toISOString(),
            to: to.toISOString(),
            section: commoditySection || undefined,
            limit: PAGE, offset,
          })
        } catch { break }
        if (!data || !data.length) break
        out = out.concat(data)
        if (data.length < PAGE) break
      }
      // Narrow to a single commodity category if one is picked.
      return catFilter ? out.filter(r => (r.commodities?.category || 'Other') === catFilter) : out
    }

    // Today is fetched separately and never merged into `rows`: it is shown as a
    // running figure only, and must not move a period total that is meant to be
    // settled. It joins the period tomorrow, once the day is complete.
    const todayStart = new Date(); todayStart.setHours(0,0,0,0)
    const [rows, todayRows] = await Promise.all([
      fetchRows(start, end),
      fetchRows(todayStart, new Date()),
    ])

    const byComm={}, byCat={}, daily={}
    // One bucket per day of the SAME window the totals use, keyed by local date —
    // previously these were built from `now` in UTC, so the chart and the metric
    // cards covered different days and their totals could not be reconciled.
    for(let i=0;i<period;i++){const d=new Date(start);d.setDate(d.getDate()+i);daily[localDay(d)]=0}
    rows.forEach(r=>{
      const name=r.commodities?.name||r.commodity_id
      const cat=r.commodities?.category||'Other'
      if(!byComm[name]) byComm[name]={name,cat,unit:r.commodities?.unit||'',qty:0,txn:0,commodity_id:r.commodity_id}
      byComm[name].qty+=r.quantity; byComm[name].txn++
      byCat[cat]=(byCat[cat]||0)+r.quantity
      // Bucket by LOCAL date to match the keys above; slicing the ISO string used
      // the UTC date, which lands WAT after-midnight entries on the previous day.
      const day=r.dispensed_at?localDay(r.dispensed_at):null
      if(day&&daily[day]!==undefined) daily[day]+=r.quantity
    })
    setCons({rows,todayRows,byComm:Object.values(byComm).sort((a,b)=>b.qty-a.qty),byCat,daily,total:rows.reduce((s,r)=>s+r.quantity,0)})
    setLoading(false)
  }

  async function loadExpiry() {
    setLoading(true)
    setExpUrgency('all')
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

    // Narrow to a single commodity category if one is picked.
    const filtered = expCat ? (lots || []).filter(r => (r.commodities?.category || 'Other') === expCat) : (lots || [])
    setExpiryData(filtered)
    setLoading(false)
  }

  function switchTab(t) {
    setTab(t)
    if(t==='consumption') loadConsumption()
  }

  const today=new Date()
  const catColors={'Pharmacy drugs':'#3fb950','RTKs':'#58a6ff','Lab reagents':'#d29922','Medical supplies':'#bc8cff'}
  const palette=['#3fb950','#58a6ff','#d29922','#bc8cff','#f778ba','#e3826b','#39c5cf','#a371f7']
  const catColor=(cat,i=0)=>catColors[cat]||palette[i%palette.length]

  // Aggregate loaded dispense rows by a key (facility id / LGA) for drill-downs.
  const aggRows = (rows, keyFn) => {
    const m={}
    rows.forEach(r=>{ const k=keyFn(r); if(k==null) return; m[k]=(m[k]||0)+r.quantity })
    return Object.entries(m).sort((a,b)=>b[1]-a[1])
  }

  // Breakdown of the loaded rows by LGA + facility, either summing units
  // (mode='units') or counting transactions (mode='count').
  const FacilityLgaBreakdown = ({ rows, mode, unitsLabel }) => {
    const aggBy = keyFn => {
      const m={}
      rows.forEach(r=>{ const k=keyFn(r); if(k==null) return; m[k]=(m[k]||0)+(mode==='count'?1:r.quantity) })
      return Object.entries(m).sort((a,b)=>b[1]-a[1])
    }
    const total = (mode==='count' ? rows.length : rows.reduce((s,r)=>s+r.quantity,0)) || 1
    const byLga = aggBy(r=>facMeta[r.facility_id]?.lga || '—')
    const byFac = aggBy(r=>r.facility_id).map(([id,v])=>({id,v,name:facMeta[id]?.name||'—',lga:facMeta[id]?.lga||'—'}))
    return (
      <>
        <CardBody>
          <div className="text-xs text-gray-500 uppercase tracking-widest mb-2">By LGA <span className="normal-case tracking-normal text-gray-600">— click an LGA to see its facilities</span></div>
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
        <div className="px-5 pt-1 pb-2 text-xs text-gray-500 uppercase tracking-widest flex items-center justify-between">
          <span>{lgaDrill ? `Facilities in ${lgaDrill}` : 'By facility'}</span>
          {lgaDrill && <button onClick={()=>setLgaDrill(null)} className="normal-case tracking-normal text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-2 py-1">← All LGAs</button>}
        </div>
        {!lgaDrill ? (
          <div className="px-5 pb-5 text-sm text-gray-500">Select an LGA above to see its facilities.</div>
        ) : (
          <div className="table-wrap"><table className="w-full text-sm">
            <thead><tr className="border-b border-white/8 bg-white/2">
              {['#','Facility','LGA',unitsLabel,'Share'].map(h=>(
                <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
              ))}
            </tr></thead>
            <tbody>{byFac.filter(f=>f.lga===lgaDrill).map((f,i)=>{
              const pct=Math.round((f.v/total)*100)||0
              return (
                <tr key={f.id} className="border-b border-white/5 hover:bg-white/2">
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">{i+1}</td>
                  <td className="px-4 py-3 font-medium text-gray-100">{f.name}</td>
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

  const TabBtn=({id,label})=>(
    <button onClick={()=>switchTab(id)}
      style={{flex:1,padding:'10px',border:'none',cursor:'pointer',fontFamily:'inherit',fontSize:'13px',fontWeight:tab===id?500:400,background:tab===id?'rgba(255,255,255,0.08)':'transparent',color:tab===id?'#e6edf3':'#8b949e',borderRight:id!=='expiry'?'1px solid rgba(255,255,255,0.08)':'none'}}>
      {label}
    </button>
  )

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100">Monitoring Dashboard</h1>
        <p className="text-sm text-gray-500 mt-1">Real-time programme performance</p>
      </div>

      <div style={{display:'flex',gap:0,marginBottom:'1.25rem',border:'1px solid rgba(255,255,255,0.08)',borderRadius:'8px',overflow:'hidden',background:'rgba(255,255,255,0.03)'}}>
        <TabBtn id="consumption" label="📊 Consumption"/>
        <TabBtn id="expiry"      label="⏳ Expiry"/>
      </div>

      {/* Admin location filter — State → LGA → Facility (self-hides for facility users) */}
      <FacilityPicker />

      {/* Period selector — always shown for consumption */}
      {tab==='consumption' && (
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
            {/* Spell the window out — "last 7 days" alone gives no way to check a
                figure against an export covering specific dates. */}
            {(() => { const { start, end } = periodWindow(period)
              return <span className="text-xs text-gray-500" title="Complete days only — today is excluded until it ends">{fmtDate(start)} – {fmtDate(end)}</span> })()}
            <span className="text-xs text-gray-500 uppercase tracking-widest ml-2">Category</span>
            <select value={catFilter} onChange={e=>setCatFilter(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
              <option value="">All categories</option>
              {categories.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
            <button onClick={loadConsumption} disabled={loading} className="ml-auto text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5 disabled:opacity-60 inline-flex items-center gap-1.5">
              {loading && <Spinner size="sm"/>}{loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </Card>
      )}

      {/* Period + LGA filters — shown for expiry */}
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
            <span className="text-xs text-gray-500 uppercase tracking-widest ml-2">Category</span>
            <select value={expCat} onChange={e=>setExpCat(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
              <option value="">All categories</option>
              {categories.map(c=><option key={c} value={c}>{c}</option>)}
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
        </Card>
      )}

      {loading && <LoadingState/>}

      {!loading && tab==='consumption' && consData && (
        <>
          {commDrill ? (() => {
            // Drilled into one commodity → scope the summary cards to it, so the totals
            // read as "this commodity" rather than the whole section.
            const cRows = consData.rows.filter(r => r.commodity_id === commDrill.id)
            const cTotal = cRows.reduce((s, r) => s + r.quantity, 0)
            const cFacs = new Set(cRows.map(r => r.facility_id)).size
            const cToday = (consData.todayRows||[]).filter(r => r.commodity_id === commDrill.id)
                             .reduce((s, r) => s + r.quantity, 0)
            return (
              <MetricGrid>
                <Metric label={`${commDrill.name} — units consumed (${period}d)`} value={cTotal.toLocaleString()} color="green"/>
                <Metric label="Facilities consuming" value={cFacs} color="blue"/>
                <Metric label="Consumption records" value={cRows.length.toLocaleString()}/>
                <Metric label="Consumed today" value={cToday.toLocaleString()}/>
              </MetricGrid>
            )
          })() : (
          <MetricGrid>
            <Metric label={`Units consumed (${period}d)`} value={consData.total.toLocaleString()} color="green"/>
            <Metric label="Commodities consumed" value={consData.byComm.length} color="blue"
              onClick={isAdm?()=>setMetricDrill(metricDrill==='commodities'?null:'commodities'):undefined} active={metricDrill==='commodities'}/>
            <Metric label="Consumption records" value={consData.rows.length.toLocaleString()}
              onClick={isAdm?()=>{setLgaDrill(null);setMetricDrill(metricDrill==='transactions'?null:'transactions')}:undefined} active={metricDrill==='transactions'}/>
            <Metric label="Consumed today" value={(consData.todayRows||[]).reduce((s,r)=>s+r.quantity,0).toLocaleString()}/>
          </MetricGrid>
          )}

          {isAdm && metricDrill && (
            <Card>
              <CardHeader>
                <CardTitle>{metricDrill==='transactions' ? 'Consumption records — by LGA & facility' : 'Commodities consumed — full list'}</CardTitle>
                <button onClick={()=>{setMetricDrill(null);setLgaDrill(null)}} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">← Close</button>
              </CardHeader>
              {metricDrill==='commodities' ? (
                consData.byComm.length===0 ? <EmptyState message="No commodities consumed in this period."/> : (
                  <div className="table-wrap"><table className="w-full text-sm">
                    <thead><tr className="border-b border-white/8 bg-white/2">
                      {['#','Commodity','Category','Units Consumed','Consumption records','Share'].map(h=>(
                        <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>{consData.byComm.map((c,i)=>{
                      const pct=Math.round((c.qty/consData.total)*100)||0
                      return (
                        <tr key={i} className="border-b border-white/5 hover:bg-white/2">
                          <td className="px-4 py-3 font-mono text-xs text-gray-600">{i+1}</td>
                          <td className="px-4 py-3 font-medium text-gray-100">{c.name}</td>
                          <td className="px-4 py-3"><CatBadge>{c.cat}</CatBadge></td>
                          <td className="px-4 py-3 font-mono text-sm text-green-400">{c.qty.toLocaleString()} {c.unit}</td>
                          <td className="px-4 py-3 text-gray-400">{c.txn}</td>
                          <td className="px-4 py-3 text-xs text-gray-500">{pct}%</td>
                        </tr>
                      )
                    })}</tbody>
                  </table></div>
                )
              ) : (
                <FacilityLgaBreakdown rows={consData.rows} mode={metricDrill==='transactions'?'count':'units'} unitsLabel={metricDrill==='transactions'?'Consumption records':'Units Consumed'}/>
              )}
            </Card>
          )}

          <div className={`grid grid-cols-1 ${isAdm ? 'lg:grid-cols-2' : ''} gap-4 mb-4`}>
            <Card>
              <CardHeader><CardTitle>{commDrill ? `Daily consumption — ${commDrill.name}` : 'Daily consumption'}</CardTitle></CardHeader>
              <CardBody>
                {(() => {
                  // Drilled into one commodity → rebuild the daily series from just its
                  // rows, reusing the section's ordered date buckets and day-key logic.
                  const daily = commDrill
                    ? consData.rows.filter(r => r.commodity_id === commDrill.id).reduce((m, r) => {
                        const day = r.dispensed_at?.slice(0, 10)
                        if (day && m[day] !== undefined) m[day] += r.quantity
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
                  if (catEntries.length===0) return <div className="text-sm text-gray-500 py-6 text-center">No consumption in this period.</div>
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
                        <text x="50" y="48" textAnchor="middle" style={{fill:'#e6edf3',fontSize:'12px',fontWeight:600}}>{centerVal.toLocaleString()}</text>
                        <text x="50" y="57" textAnchor="middle" style={{fill:'#8b949e',fontSize:'6px',letterSpacing:'0.3px'}}>{centerSub}</text>
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
              const commRows = consData.rows.filter(r=>r.commodity_id===commDrill.id)
              const cTotal = commRows.reduce((s,r)=>s+r.quantity,0)||1
              const byFac = aggRows(commRows, r=>r.facility_id).map(([id,qty])=>({id,qty,name:facMeta[id]?.name||'—',lga:facMeta[id]?.lga||'—'}))
              // Facilities in the current scope that consumed none of this commodity.
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
              const expHeaders = ['#','Facility','LGA','Units Consumed','Unit','Share %']
              const expRows = () => shownRows.map((f,i)=>[i+1,f.name,f.lga,f.qty,commDrill.unit||'',Math.round((f.qty/cTotal)*100)||0])
              const expSub = consFilter==='none' ? 'facilities with no consumption' : consFilter==='all' ? 'including facilities with no consumption' : null
              const btnCls = "text-xs text-gray-300 hover:text-white border border-white/10 rounded px-3 py-1.5 disabled:opacity-50"
              return (
                <>
                  <CardHeader>
                    <CardTitle>{commDrill.name} — facilities consuming this commodity</CardTitle>
                    <div className="flex gap-2 flex-wrap">
                      <button onClick={()=>exportCsv(`${base}_facilities-consuming.csv`, expHeaders, expRows())} disabled={!shownRows.length} className={btnCls}>Download CSV</button>
                      <button onClick={()=>exportPdf(`${commDrill.name} — facilities consuming`, expSub, expHeaders, expRows(), new Set([3,5]))} disabled={!shownRows.length} className={btnCls}>Print / Save as PDF</button>
                      <select value={consFilter} onChange={e=>setConsFilter(e.target.value)} className={btnCls} title="Filter facilities by consumption">
                        <option value="consuming">With consumption ({byFac.length})</option>
                        <option value="none">No consumption ({nonConsumers.length})</option>
                        <option value="all">All facilities ({byFac.length+nonConsumers.length})</option>
                      </select>
                      <button onClick={()=>{setCommDrill(null);setConsFilter('consuming')}} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">← Top commodities</button>
                    </div>
                  </CardHeader>
                  {!shownRows.length ? <EmptyState message={consFilter==='none' ? 'Every facility in scope consumed this commodity.' : 'No facility-level data.'}/> : (
                    <div className="table-wrap"><table className="w-full text-sm">
                      <thead><tr className="border-b border-white/8 bg-white/2">
                        {['#','Facility','LGA','Units Consumed','Share'].map(h=>(
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
                          <tr className="bg-white/2"><td colSpan={5} className="px-4 py-2 text-xs text-gray-500 uppercase tracking-wider">Facilities with no consumption ({nonConsumers.length})</td></tr>
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
                <CardHeader><CardTitle>Top commodities</CardTitle>
                  <div className="flex items-center gap-3">
                    {isAdm && consData.byComm.length>0 && <span className="text-xs text-gray-500">click a commodity for facilities</span>}
                    <button onClick={()=>{
                      const headers=['#','Commodity','Category','Units consumed','Unit','Consumption records','Share %']
                      const rows=consData.byComm.map((c,i)=>[i+1,c.name,c.cat,c.qty,c.unit||'',c.txn,Math.round((c.qty/consData.total)*100)||0])
                      exportCsv(`top-commodities_consumption_${period}d.csv`, headers, rows)
                    }} disabled={consData.byComm.length===0} className="text-xs text-gray-300 hover:text-white border border-white/10 rounded px-3 py-1.5 disabled:opacity-50">↓ Download CSV</button>
                  </div>
                </CardHeader>
                {consData.byComm.length===0 ? <EmptyState message="No dispensing in this period."/> : (
                  <div className="table-wrap"><table className="w-full text-sm">
                    <thead><tr className="border-b border-white/8 bg-white/2">
                      {['#','Commodity','Category','Units Consumed','Consumption records','Share'].map(h=>(
                        <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>{consData.byComm.slice(0,15).map((c,i)=>{
                      const pct=Math.round((c.qty/consData.total)*100)||0
                      const color=catColor(c.cat,i)
                      return (
                        <tr key={i} onClick={()=>isAdm && setCommDrill({id:c.commodity_id,name:c.name,unit:c.unit})}
                          className={`border-b border-white/5 ${isAdm?'cursor-pointer':''} hover:bg-white/2`}>
                          <td className="px-4 py-3 font-mono text-xs text-gray-600">{i+1}</td>
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
                  </table></div>
                )}
              </>
            )}
          </Card>

          {isAdm && catDrill && (() => {
            const catRows = consData.rows.filter(r=>(r.commodities?.category||'Other')===catDrill)
            const catTotal = catRows.reduce((s,r)=>s+r.quantity,0)||1
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
                    {['Facility','LGA','Units Consumed','Share'].map(h=>(
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

        </>
      )}

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
                      <tbody>{expiryData.map(r=>{
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
                    </table></div>
                  )}
                </Card>
              ) : (() => {
                /* Admin view: one flat row per expiring batch — facility & commodity side by
                   side, filtered by the urgency dropdown / metric cards, with CSV download. */
                const urgencyLabel = {all:'All expiring',expired:'Expired',critical:'Critical (≤30d)',warning:'Warning (≤90d)',monitor:'Monitor (>90d)'}[expUrgency]
                const rows = (expUrgency==='all' ? expiryData : expBucketRows(expUrgency)).slice()
                  .sort((a,b)=>new Date(a.expiry_date)-new Date(b.expiry_date))
                const download = () => {
                  const headers=['Facility','LGA','Commodity','Category','Batch','Expiry date','Days left','Qty','Unit','Urgency']
                  const csv=rows.map(r=>{const dL=Math.round((new Date(r.expiry_date)-today)/86400000);const u=dL<0?'Expired':dL<=30?'Critical':dL<=90?'Warning':'Monitor';return [facMeta[r.facility_id]?.name||'—',facMeta[r.facility_id]?.lga||'—',r.commodities?.name||'—',r.commodities?.category||'—',r.batch_number||'',fmtDate(r.expiry_date),dL,r.quantity,r.commodities?.unit||'',u]})
                  exportCsv(`expiry_${expUrgency}_${expPeriod}d.csv`, headers, csv)
                }
                return (
                  <Card>
                    <CardHeader>
                      <CardTitle>{urgencyLabel} batches — by facility <span className="text-gray-500 font-normal">· {rows.length} {rows.length===1?'batch':'batches'}</span></CardTitle>
                      <button onClick={download} disabled={rows.length===0} className="text-xs text-gray-300 hover:text-white border border-white/10 rounded px-3 py-1.5 disabled:opacity-50 inline-flex items-center gap-1.5">↓ Download CSV</button>
                    </CardHeader>
                    {rows.length===0 ? <EmptyState message="No batches in this bucket ✓"/> : (
                      <div className="table-wrap"><table className="w-full text-sm">
                        <thead><tr className="border-b border-white/8 bg-white/2">
                          {['Facility','LGA','Commodity','Category','Batch','Expiry date','Days left','Qty','Urgency'].map(h=>(
                            <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                          ))}
                        </tr></thead>
                        <tbody>{rows.map(r=>{
                          const dL=Math.round((new Date(r.expiry_date)-today)/86400000)
                          const u=dL<0?{l:'Expired',c:'text-red-500'}:dL<=30?{l:'Critical',c:'text-red-400'}:dL<=90?{l:'Warning',c:'text-amber-400'}:{l:'Monitor',c:'text-blue-400'}
                          return (
                            <tr key={`${r.facility_id}|${r.commodity_id}|${r.batch_number}|${r.expiry_date}`} className="border-b border-white/5 hover:bg-white/2">
                              <td className="px-4 py-3 font-medium text-gray-100">{facMeta[r.facility_id]?.name||'—'}</td>
                              <td className="px-4 py-3 text-xs text-gray-500">{facMeta[r.facility_id]?.lga||'—'}</td>
                              <td className="px-4 py-3 text-gray-200">{r.commodities?.name||'—'}</td>
                              <td className="px-4 py-3"><CatBadge>{r.commodities?.category||'—'}</CatBadge></td>
                              <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.batch_number||'—'}</td>
                              <td className="px-4 py-3 font-mono text-xs text-gray-300">{fmtDate(r.expiry_date)}</td>
                              <td className={`px-4 py-3 font-mono text-sm font-semibold ${u.c}`}>{dL<0?`${-dL}d ago`:`${dL}d`}</td>
                              <td className="px-4 py-3 font-mono text-sm text-gray-300">{r.quantity} {r.commodities?.unit||''}</td>
                              <td className="px-4 py-3"><span className={`text-xs font-semibold ${u.c}`}>{u.l}</span></td>
                            </tr>
                          )
                        })}</tbody>
                      </table></div>
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
