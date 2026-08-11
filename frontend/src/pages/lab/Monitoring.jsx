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
import { fmtDate } from '../../utils/helpers'

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
  const [catHover, setCatHover] = useState(null)  // category hovered in the donut (highlight only)
  const [consFilter, setConsFilter] = useState('consuming')  // commodity drill facility filter: 'consuming' | 'none' | 'all'
  const [expUrgency, setExpUrgency] = useState('all')  // expiry urgency filter: 'all'|'expired'|'critical'|'warning'|'monitor'
  const [expPeriod, setExpPeriod] = useState(180)   // expiry look-ahead window (days)

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

  useEffect(() => { loadUtilization() }, [scopeKey, period])
  useEffect(() => { if (tab==='expiry') loadExpiry() }, [tab, expPeriod, scopeKey])
  // Drill-ins load their own breakdown; clearing the drill drops it again.
  useEffect(() => { if (commDrill?.id) loadCommodityDrill(commDrill.id); else setCommDetail(null) }, [commDrill?.id])
  useEffect(() => { if (catDrill) loadCategoryDrill(catDrill); else setCatDetail(null) }, [catDrill])

  async function loadUtilization() {
    setLoading(true)
    setCatDrill(null); setCommDrill(null); setMetricDrill(null); setLgaDrill(null)
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
    const [commRows, facRows, dayRows] = await Promise.all([
      api.dispense.summary({ ...base, group_by: 'commodity' }).catch(() => []),
      api.dispense.summary({ ...base, group_by: 'facility' }).catch(() => []),
      api.dispense.summary({ ...base, group_by: 'day' }).catch(() => []),
    ])

    // Commodity metadata comes from the catalogue already in the store, rather
    // than being repeated on every one of thousands of log rows.
    const commMeta = {}
    store.allCommodities.forEach(c => { commMeta[c.id] = c })

    const byCat={}, daily={}
    for(let i=period-1;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);daily[d.toISOString().split('T')[0]]=0}
    ;(dayRows||[]).forEach(r=>{ if(daily[r.day]!==undefined) daily[r.day]+=r.qty })

    const byComm=(commRows||[]).map(r=>{
      const c=commMeta[r.commodity_id]
      const cat=c?.category||'Other'
      byCat[cat]=(byCat[cat]||0)+r.qty
      return {name:c?.name||r.commodity_id,cat,unit:c?.unit||'',qty:r.qty,txn:r.txn,commodity_id:r.commodity_id}
    }).sort((a,b)=>b.qty-a.qty)

    setCons({
      byComm, byCat, daily,
      byFac: facRows||[],
      total: (commRows||[]).reduce((s,r)=>s+r.qty,0),
      txnTotal: (commRows||[]).reduce((s,r)=>s+r.txn,0),
    })
    setLoading(false)
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

  // Breakdown of the loaded rows by LGA + facility, either summing units
  // (mode='units') or counting transactions (mode='count').
  const FacilityLgaBreakdown = ({ rows, mode, unitsLabel }) => {
    // `txn` is the server's count(*), exactly what rows.length used to be.
    const field = mode==='count' ? 'txn' : 'qty'
    const aggBy = keyFn => aggRows(rows, keyFn, field)
    const total = (rows||[]).reduce((s,r)=>s+(r[field]||0),0) || 1
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
        <TabBtn id="utilization" label="Utilization"/>
        <TabBtn id="expiry"      label="Expiry"/>
      </div>

      {/* Admin location filter — State → LGA → Facility (self-hides for facility users) */}
      <FacilityPicker />

      {/* Period selector — always shown for utilization */}
      {tab==='utilization' && (
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
            <button onClick={loadUtilization} disabled={loading} className="ml-auto text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5 disabled:opacity-60 inline-flex items-center gap-1.5">
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
            <Metric label={`Units utilized (${period}d)`} value={consData.total.toLocaleString()} color="green"/>
            <Metric label="Commodities utilized" value={consData.byComm.length} color="blue"
              onClick={isAdm?()=>setMetricDrill(metricDrill==='commodities'?null:'commodities'):undefined} active={metricDrill==='commodities'}/>
            <Metric label="Utilization records" value={consData.txnTotal.toLocaleString()}
              onClick={isAdm?()=>{setLgaDrill(null);setMetricDrill(metricDrill==='transactions'?null:'transactions')}:undefined} active={metricDrill==='transactions'}/>
          </MetricGrid>
          )}

          {isAdm && metricDrill && (
            <Card>
              <CardHeader>
                <CardTitle>{metricDrill==='transactions' ? 'Utilization records — by LGA & facility' : 'Commodities utilized — full list'}</CardTitle>
                <button onClick={()=>{setMetricDrill(null);setLgaDrill(null)}} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">← Close</button>
              </CardHeader>
              {metricDrill==='commodities' ? (
                consData.byComm.length===0 ? <EmptyState message="No commodities utilized in this period."/> : (
                  <div className="table-wrap"><table className="w-full text-sm">
                    <thead><tr className="border-b border-white/8 bg-white/2">
                      {['#','Commodity','Category','Units Utilized','Utilization records','Share'].map(h=>(
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
                <FacilityLgaBreakdown rows={consData.byFac} mode={metricDrill==='transactions'?'count':'units'} unitsLabel={metricDrill==='transactions'?'Utilization records':'Units Utilized'}/>
              )}
            </Card>
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
                <CardHeader><CardTitle>Top commodities</CardTitle>
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
