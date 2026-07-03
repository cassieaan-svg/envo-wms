import { useState, useEffect } from 'react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/appStore'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { MetricGrid, Metric } from '../../components/ui/Metric'
import { CatBadge } from '../../components/ui/Badge'
import { LoadingState, EmptyState, Spinner } from '../../components/ui/Loading'
import { fmtDate, capExpiryBatchesToStockByFacility } from '../../utils/helpers'
import { FacilityPicker } from '../../components/ui/FacilityPicker'

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
  const [expDrill, setExpDrill]   = useState(null)  // 'critical' | 'warning' | 'monitor' | 'total'
  const [expBatchComm, setExpBatchComm] = useState(null)  // Expiring-batches table: commodity drilled into {id,name,cat}
  const [expPeriod, setExpPeriod] = useState(180)   // expiry look-ahead window (days)
  const [catFilter, setCatFilter] = useState('')    // commodity category narrowing (consumption)
  const [expCat, setExpCat]       = useState('')    // commodity category narrowing (expiry)

  // Honour the admin's facility/LGA/state scope (same resolution as stock loads)
  // so Consumption and Expiry stay within the viewer's jurisdiction.
  const { fid, scopeIds } = store.getAdminStockScope()
  const scopeKey = fid || (scopeIds && scopeIds.length ? scopeIds.join(',') : 'all')
  const commIds  = store.allCommodities.map(c => c.id)
  // Resolve the facility_ids view-filter for the log queries: the admin's scope
  // (single facility or LGA/state set) optionally narrowed by a picked LGA. Returns
  // an array for facility_ids, or undefined to span the whole token scope. An empty
  // result becomes a sentinel id so the server returns nothing (not everything).
  const facilityFilter = (lgaIds) => {
    let base = fid ? [fid] : (scopeIds && scopeIds.length ? scopeIds : null)
    if (lgaIds) base = base ? base.filter(id => lgaIds.includes(id)) : lgaIds
    if (base == null) return undefined
    return base.length ? base : ['00000000-0000-0000-0000-000000000000']
  }

  // Facility metadata for LGA / facility drill-downs
  const facMeta = {}
  store.allFacilities.forEach(f => { facMeta[f.id] = { name: f.name, lga: f.lga || '—' } })
  const categories = [...new Set(store.allCommodities.map(c => c.category).filter(Boolean))].sort()

  useEffect(() => { loadConsumption() }, [scopeKey, period, catFilter])
  useEffect(() => { if (tab==='expiry') loadExpiry() }, [tab, expPeriod, expCat, scopeKey])

  async function loadConsumption() {
    setLoading(true)
    setCatDrill(null); setCommDrill(null); setMetricDrill(null)
    const start = new Date(); start.setDate(start.getDate()-period)
    const facility_ids = facilityFilter()

    // Paginate — an admin over a long period easily exceeds the 1000-row cap,
    // which would otherwise silently understate totals and drill-downs.
    const PAGE = 1000
    let rows = []
    for (let offset = 0; ; offset += PAGE) {
      let data
      try {
        data = await api.dispense.history({
          facility_ids,
          commodity_ids: commIds,
          from: start.toISOString(),
          section: commoditySection || undefined,
          limit: PAGE, offset,
        })
      } catch { break }
      if (!data || !data.length) break
      rows = rows.concat(data)
      if (data.length < PAGE) break
    }

    // Narrow to a single commodity category if one is picked.
    if (catFilter) rows = rows.filter(r => (r.commodities?.category || 'Other') === catFilter)

    const byComm={}, byCat={}, daily={}
    for(let i=period-1;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);daily[d.toISOString().split('T')[0]]=0}
    rows.forEach(r=>{
      const name=r.commodities?.name||r.commodity_id
      const cat=r.commodities?.category||'Other'
      if(!byComm[name]) byComm[name]={name,cat,unit:r.commodities?.unit||'',qty:0,txn:0,commodity_id:r.commodity_id}
      byComm[name].qty+=r.quantity; byComm[name].txn++
      byCat[cat]=(byCat[cat]||0)+r.quantity
      const day=r.dispensed_at?.slice(0,10)
      if(day&&daily[day]!==undefined) daily[day]+=r.quantity
    })
    setCons({rows,byComm:Object.values(byComm).sort((a,b)=>b.qty-a.qty),byCat,daily,total:rows.reduce((s,r)=>s+r.quantity,0)})
    setLoading(false)
  }

  async function loadExpiry() {
    setLoading(true)
    setExpDrill(null); setExpBatchComm(null)
    const now=new Date()
    const cutoff=new Date(now.getTime()+expPeriod*86400000).toISOString().split('T')[0]
    const facility_ids = facilityFilter()

    // Paginate — large jurisdictions over a long window exceed the 1000-row cap.
    const PAGE = 1000
    const fetchAllPages = async (fn, params) => {
      const out = []
      for (let offset = 0; ; offset += PAGE) {
        let data
        try { data = await fn({ ...params, limit: PAGE, offset }) } catch { break }
        if (!data || !data.length) break
        out.push(...data)
        if (data.length < PAGE) break
      }
      return out
    }

    const all = await fetchAllPages(api.intake.history, {
      facility_ids, commodity_ids: commIds,
      expiry_from: now.toISOString().split('T')[0], expiry_to: cutoff,
      has_quantity: true, section: commoditySection || undefined,
    })

    // Intake records the quantity RECEIVED and is never decremented as stock is
    // consumed/transferred, so cap each batch to its own facility's current stock
    // on hand for that commodity. Batches span many facilities here, so SOH is
    // keyed per (facility, commodity) — not a single per-commodity total. Pharmacy
    // SOH = store + dispensary (both from /api/stock) + DSD.
    const [stockRows, dsdRows] = await Promise.all([
      fetchAllPages(api.stock.list, { facility_ids, commodity_ids: commIds }),
      fetchAllPages(api.stock.dsd.list, { facility_ids }),
    ])
    const sohByFacComm = {}
    const addSoh = (fId, cId, q) => { const k = `${fId}|${cId}`; sohByFacComm[k] = (sohByFacComm[k] || 0) + (q || 0) }
    stockRows.forEach(s => addSoh(s.facility_id, s.commodity_id, s.quantity))
    dsdRows.forEach(d => addSoh(d.facility_id, d.commodity_id, d.quantity))

    // Narrow to a single commodity category if one is picked.
    const allFiltered = expCat ? all.filter(r => (r.commodities?.category || 'Other') === expCat) : all
    // capExpiryBatchesToStockByFacility drops depleted batches and returns soonest-first.
    setExpiryData(capExpiryBatchesToStockByFacility(allFiltered, sohByFacComm))
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
          <div className="text-xs text-gray-500 uppercase tracking-widest mb-2">By LGA</div>
          <div className="space-y-2">
            {byLga.map(([lga,v])=>{
              const pct=Math.round((v/total)*100)||0
              return (
                <div key={lga}>
                  <div className="flex justify-between mb-1"><span className="text-sm text-gray-300">{lga}</span><span className="text-xs font-mono text-gray-500">{pct}% · {v.toLocaleString()}</span></div>
                  <div className="h-1.5 bg-white/5 rounded-full"><div style={{width:`${pct}%`,height:'100%',background:'#3fb950',borderRadius:'9999px'}}/></div>
                </div>
              )
            })}
          </div>
        </CardBody>
        <div className="px-5 pt-1 pb-2 text-xs text-gray-500 uppercase tracking-widest">By facility</div>
        <div className="table-wrap"><table className="w-full text-sm">
          <thead><tr className="border-b border-white/8 bg-white/2">
            {['#','Facility','LGA',unitsLabel,'Share'].map(h=>(
              <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
            ))}
          </tr></thead>
          <tbody>{byFac.map((f,i)=>{
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
      </>
    )
  }

  // Expiry urgency buckets (days until expiry) for the clickable metric cards.
  const expDays = r => (new Date(r.expiry_date)-today)/86400000
  const expBucketRows = b => (expiryData||[]).filter(r=>{
    const d=expDays(r)
    if(b==='critical') return d<=30
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
            <button onClick={loadExpiry} disabled={loading} className="ml-auto text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5 disabled:opacity-60 inline-flex items-center gap-1.5">
              {loading && <Spinner size="sm"/>}{loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </Card>
      )}

      {loading && <LoadingState/>}

      {!loading && tab==='consumption' && consData && (
        <>
          <MetricGrid>
            <Metric label={`Units consumed (${period}d)`} value={consData.total.toLocaleString()} color="green"/>
            <Metric label="Commodities moved" value={consData.byComm.length} color="blue"
              onClick={isAdm?()=>setMetricDrill(metricDrill==='commodities'?null:'commodities'):undefined} active={metricDrill==='commodities'}/>
            <Metric label="Transactions" value={consData.rows.length.toLocaleString()}
              onClick={isAdm?()=>setMetricDrill(metricDrill==='transactions'?null:'transactions'):undefined} active={metricDrill==='transactions'}/>
          </MetricGrid>

          {isAdm && metricDrill && (
            <Card>
              <CardHeader>
                <CardTitle>{metricDrill==='transactions' ? 'Transactions — by LGA & facility' : 'Commodities moved — full list'}</CardTitle>
                <button onClick={()=>setMetricDrill(null)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">← Close</button>
              </CardHeader>
              {metricDrill==='commodities' ? (
                consData.byComm.length===0 ? <EmptyState message="No commodities moved in this period."/> : (
                  <div className="table-wrap"><table className="w-full text-sm">
                    <thead><tr className="border-b border-white/8 bg-white/2">
                      {['#','Commodity','Category','Units Consumed','Transactions','Share'].map(h=>(
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
                <FacilityLgaBreakdown rows={consData.rows} mode={metricDrill==='transactions'?'count':'units'} unitsLabel={metricDrill==='transactions'?'Transactions':'Units Consumed'}/>
              )}
            </Card>
          )}

          <div className={`grid grid-cols-1 ${isAdm ? 'lg:grid-cols-2' : ''} gap-4 mb-4`}>
            <Card>
              <CardHeader><CardTitle>Daily consumption</CardTitle></CardHeader>
              <CardBody>
                {(() => {
                  const entries = Object.entries(consData.daily)
                  const maxVal = Math.max(...entries.map(([,v])=>v),1)
                  const step = Math.max(1, Math.ceil(entries.length/15))
                  return (
                    <div style={{display:'flex',alignItems:'flex-end',gap:'2px',height:'80px'}}>
                      {entries.map(([day,val],i)=>{
                        const h=Math.round((val/maxVal)*100)
                        const d=new Date(day)
                        const lbl=d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'})
                        const showLbl = entries.length<=31 || i%step===0
                        return (
                          <div key={day} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:'3px'}}>
                            <div style={{width:'100%',background:'#3fb950',borderRadius:'2px 2px 0 0',height:`${h}%`,minHeight:val>0?2:0,opacity:0.85}} title={`${lbl}: ${val.toLocaleString()}`}/>
                            <div style={{fontSize:'9px',color:'#484f58',writingMode:'vertical-rl',transform:'rotate(180deg)',maxHeight:'28px',overflow:'hidden'}}>{showLbl?lbl:''}</div>
                          </div>
                        )
                      })}
                    </div>
                  )
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
                  return (
                    <div className="flex items-center gap-5 flex-wrap">
                      <svg viewBox="0 0 100 100" style={{width:130,height:130,flexShrink:0}}>
                        <g transform="rotate(-90 50 50)">
                          {catEntries.map(([cat,qty],i)=>{
                            const dash=(qty/total)*C
                            const seg=(
                              <circle key={cat} cx="50" cy="50" r={R} fill="none"
                                stroke={catColor(cat,i)} strokeWidth="16"
                                strokeDasharray={`${dash} ${C-dash}`} strokeDashoffset={-acc}
                                style={{opacity:catDrill&&catDrill!==cat?0.3:1,transition:'opacity .15s'}}/>
                            )
                            acc+=dash
                            return seg
                          })}
                        </g>
                      </svg>
                      <div className="flex-1 min-w-[180px] space-y-1">
                        {catEntries.map(([cat,qty],i)=>{
                          const pct=Math.round((qty/total)*100)||0
                          const active=catDrill===cat
                          return (
                            <button key={cat} type="button" disabled={!isAdm}
                              onClick={()=>isAdm && setCatDrill(active?null:cat)}
                              className={`w-full flex items-center justify-between gap-3 text-left px-2 py-1 rounded-lg ${isAdm?'hover:bg-white/5 cursor-pointer':''} ${active?'bg-white/8':''}`}>
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
              return (
                <>
                  <CardHeader>
                    <CardTitle>{commDrill.name} — facilities consuming this commodity</CardTitle>
                    <button onClick={()=>setCommDrill(null)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">← Top commodities</button>
                  </CardHeader>
                  {byFac.length===0 ? <EmptyState message="No facility-level data."/> : (
                    <div className="table-wrap"><table className="w-full text-sm">
                      <thead><tr className="border-b border-white/8 bg-white/2">
                        {['#','Facility','LGA','Units Consumed','Share'].map(h=>(
                          <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>{byFac.map((f,i)=>{
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
                      })}</tbody>
                    </table></div>
                  )}
                </>
              )
            })() : (
              <>
                <CardHeader><CardTitle>Top commodities</CardTitle>{isAdm && consData.byComm.length>0 && <span className="text-xs text-gray-500">click a commodity for facilities</span>}</CardHeader>
                {consData.byComm.length===0 ? <EmptyState message="No dispensing in this period."/> : (
                  <div className="table-wrap"><table className="w-full text-sm">
                    <thead><tr className="border-b border-white/8 bg-white/2">
                      {['#','Commodity','Category','Units Consumed','Transactions','Share'].map(h=>(
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
                <Metric label="Critical (≤30d)" value={expBucketRows('critical').length} color="red"
                  onClick={isAdm?()=>setExpDrill(expDrill==='critical'?null:'critical'):undefined} active={expDrill==='critical'}/>
                <Metric label="Warning (≤90d)" value={expBucketRows('warning').length} color="amber"
                  onClick={isAdm?()=>setExpDrill(expDrill==='warning'?null:'warning'):undefined} active={expDrill==='warning'}/>
                <Metric label="Monitor (>90d)" value={expBucketRows('monitor').length} color="blue"
                  onClick={isAdm?()=>setExpDrill(expDrill==='monitor'?null:'monitor'):undefined} active={expDrill==='monitor'}/>
                <Metric label="Total batches" value={expiryData.length}
                  onClick={isAdm?()=>setExpDrill(expDrill==='total'?null:'total'):undefined} active={expDrill==='total'}/>
              </MetricGrid>

              {isAdm && expDrill && (() => {
                const rows = expBucketRows(expDrill)
                const total = rows.reduce((s,r)=>s+r.quantity,0)||1
                const commMap={}
                rows.forEach(r=>{ const n=r.commodities?.name||r.commodity_id; if(!commMap[n])commMap[n]={name:n,cat:r.commodities?.category||'—',unit:r.commodities?.unit||'',qty:0,batches:0}; commMap[n].qty+=r.quantity; commMap[n].batches++ })
                const byComm=Object.values(commMap).sort((a,b)=>b.qty-a.qty)
                const aggBy = keyFn => { const m={}; rows.forEach(r=>{const k=keyFn(r); if(k==null)return; m[k]=(m[k]||0)+r.quantity}); return Object.entries(m).sort((a,b)=>b[1]-a[1]) }
                const byLga = aggBy(r=>facMeta[r.facility_id]?.lga||'—')
                const byFac = aggBy(r=>r.facility_id).map(([id,v])=>({id,v,name:facMeta[id]?.name||'—',lga:facMeta[id]?.lga||'—'}))
                const labels={critical:'Critical (≤30d)',warning:'Warning (≤90d)',monitor:'Monitor (>90d)',total:'All expiring batches'}
                return (
                  <Card>
                    <CardHeader>
                      <CardTitle>{labels[expDrill]} — commodities, LGAs &amp; facilities</CardTitle>
                      <button onClick={()=>setExpDrill(null)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">← Close</button>
                    </CardHeader>
                    <div className="px-5 pt-3 pb-2 text-xs text-gray-500 uppercase tracking-widest">By commodity</div>
                    {byComm.length===0 ? <EmptyState message="No batches in this bucket."/> : (
                      <div className="table-wrap"><table className="w-full text-sm">
                        <thead><tr className="border-b border-white/8 bg-white/2">
                          {['Commodity','Category','Batches','Qty','Share'].map(h=>(
                            <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                          ))}
                        </tr></thead>
                        <tbody>{byComm.map((c,i)=>{
                          const pct=Math.round((c.qty/total)*100)||0
                          return (
                            <tr key={i} className="border-b border-white/5 hover:bg-white/2">
                              <td className="px-4 py-3 font-medium text-gray-100">{c.name}</td>
                              <td className="px-4 py-3"><CatBadge>{c.cat}</CatBadge></td>
                              <td className="px-4 py-3 text-gray-400">{c.batches}</td>
                              <td className="px-4 py-3 font-mono text-sm text-gray-200">{c.qty.toLocaleString()} {c.unit}</td>
                              <td className="px-4 py-3 text-xs text-gray-500">{pct}%</td>
                            </tr>
                          )
                        })}</tbody>
                      </table></div>
                    )}
                    <CardBody>
                      <div className="text-xs text-gray-500 uppercase tracking-widest mb-2">By LGA</div>
                      <div className="space-y-2">
                        {byLga.map(([lga,v])=>{
                          const pct=Math.round((v/total)*100)||0
                          return (
                            <div key={lga}>
                              <div className="flex justify-between mb-1"><span className="text-sm text-gray-300">{lga}</span><span className="text-xs font-mono text-gray-500">{pct}% · {v.toLocaleString()}</span></div>
                              <div className="h-1.5 bg-white/5 rounded-full"><div style={{width:`${pct}%`,height:'100%',background:'#d29922',borderRadius:'9999px'}}/></div>
                            </div>
                          )
                        })}
                      </div>
                    </CardBody>
                    <div className="px-5 pt-1 pb-2 text-xs text-gray-500 uppercase tracking-widest">By facility</div>
                    <div className="table-wrap"><table className="w-full text-sm">
                      <thead><tr className="border-b border-white/8 bg-white/2">
                        {['#','Facility','LGA','Qty','Share'].map(h=>(
                          <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>{byFac.map((f,i)=>{
                        const pct=Math.round((f.v/total)*100)||0
                        return (
                          <tr key={f.id} className="border-b border-white/5 hover:bg-white/2">
                            <td className="px-4 py-3 font-mono text-xs text-gray-600">{i+1}</td>
                            <td className="px-4 py-3 font-medium text-gray-100">{f.name}</td>
                            <td className="px-4 py-3 text-xs text-gray-500">{f.lga}</td>
                            <td className="px-4 py-3 font-mono text-sm text-gray-200">{f.v.toLocaleString()}</td>
                            <td className="px-4 py-3 text-xs text-gray-500">{pct}%</td>
                          </tr>
                        )
                      })}</tbody>
                    </table></div>
                  </Card>
                )
              })()}

              <Card>
                <CardHeader><CardTitle>Expiring batches</CardTitle>{isAdm && expiryData.length>0 && !expBatchComm && <span className="text-xs text-gray-500">click a commodity for facilities</span>}</CardHeader>
                {expiryData.length===0 ? <EmptyState message="No expiring batches in this period ✓"/> :
                  !isAdm ? (
                    /* Facility view: flat batch list (their own batches). */
                    <div className="table-wrap"><table className="w-full text-sm">
                      <thead><tr className="border-b border-white/8 bg-white/2">
                        {['Commodity','Expiry date','Days left','Qty','Batch','Urgency'].map(h=>(
                          <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>{expiryData.map(r=>{
                        const dL=Math.round((new Date(r.expiry_date)-today)/86400000)
                        const u=dL<=30?{l:'Critical',c:'text-red-400'}:dL<=90?{l:'Warning',c:'text-amber-400'}:{l:'Monitor',c:'text-blue-400'}
                        return (
                          <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
                            <td className="px-4 py-3 font-medium text-gray-100">{r.commodities?.name||'—'}</td>
                            <td className="px-4 py-3 font-mono text-xs text-gray-300">{fmtDate(r.expiry_date)}</td>
                            <td className={`px-4 py-3 font-mono text-sm font-semibold ${u.c}`}>{dL}d</td>
                            <td className="px-4 py-3 font-mono text-sm text-gray-300">{r.quantity} {r.commodities?.unit||''}</td>
                            <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.batch_number||'—'}</td>
                            <td className="px-4 py-3"><span className={`text-xs font-semibold ${u.c}`}>{u.l}</span></td>
                          </tr>
                        )
                      })}</tbody>
                    </table></div>
                  ) : expBatchComm ? (() => {
                    /* Admin drill: expiring batches for the selected commodity, by facility. */
                    const batches = expiryData.filter(r => r.commodity_id === expBatchComm.id).sort((a,b)=>new Date(a.expiry_date)-new Date(b.expiry_date))
                    return (
                      <>
                        <div className="px-5 py-3 border-b border-white/8 flex items-center justify-between flex-wrap gap-2">
                          <span className="text-sm text-gray-300 flex items-center gap-2">{expBatchComm.name} <CatBadge>{expBatchComm.cat}</CatBadge> — expiring batches by facility</span>
                          <button onClick={()=>setExpBatchComm(null)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">← Back to commodities</button>
                        </div>
                        <div className="table-wrap"><table className="w-full text-sm">
                          <thead><tr className="border-b border-white/8 bg-white/2">
                            {['Facility','LGA','Batch','Expiry date','Days left','Qty','Urgency'].map(h=>(
                              <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                            ))}
                          </tr></thead>
                          <tbody>{batches.map(r=>{
                            const dL=Math.round((new Date(r.expiry_date)-today)/86400000)
                            const u=dL<=30?{l:'Critical',c:'text-red-400'}:dL<=90?{l:'Warning',c:'text-amber-400'}:{l:'Monitor',c:'text-blue-400'}
                            return (
                              <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
                                <td className="px-4 py-3 font-medium text-gray-100">{facMeta[r.facility_id]?.name||'—'}</td>
                                <td className="px-4 py-3 text-xs text-gray-500">{facMeta[r.facility_id]?.lga||'—'}</td>
                                <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.batch_number||'—'}</td>
                                <td className="px-4 py-3 font-mono text-xs text-gray-300">{fmtDate(r.expiry_date)}</td>
                                <td className={`px-4 py-3 font-mono text-sm font-semibold ${u.c}`}>{dL}d</td>
                                <td className="px-4 py-3 font-mono text-sm text-gray-300">{r.quantity} {r.commodities?.unit||''}</td>
                                <td className="px-4 py-3"><span className={`text-xs font-semibold ${u.c}`}>{u.l}</span></td>
                              </tr>
                            )
                          })}</tbody>
                        </table></div>
                      </>
                    )
                  })() : (() => {
                    /* Admin top view: one row per commodity (tap to drill into facilities). */
                    const byComm={}
                    expiryData.forEach(r=>{
                      const g=byComm[r.commodity_id]||(byComm[r.commodity_id]={id:r.commodity_id,name:r.commodities?.name||'—',cat:r.commodities?.category||'—',unit:r.commodities?.unit||'',batches:0,qty:0,soonest:null,facs:new Set()})
                      g.batches++; g.qty+=r.quantity; g.facs.add(r.facility_id)
                      const d=new Date(r.expiry_date); if(!g.soonest||d<g.soonest) g.soonest=d
                    })
                    const list=Object.values(byComm).sort((a,b)=>a.soonest-b.soonest)
                    return (
                      <div className="table-wrap"><table className="w-full text-sm">
                        <thead><tr className="border-b border-white/8 bg-white/2">
                          {['Commodity','Category','Facilities','Batches','Total qty','Soonest expiry','Days left','Urgency'].map(h=>(
                            <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                          ))}
                        </tr></thead>
                        <tbody>{list.map(g=>{
                          const dL=Math.round((g.soonest-today)/86400000)
                          const u=dL<=30?{l:'Critical',c:'text-red-400'}:dL<=90?{l:'Warning',c:'text-amber-400'}:{l:'Monitor',c:'text-blue-400'}
                          return (
                            <tr key={g.id} onClick={()=>setExpBatchComm({id:g.id,name:g.name,cat:g.cat})} className="border-b border-white/5 cursor-pointer hover:bg-white/5">
                              <td className="px-4 py-3 font-medium text-blue-400 hover:text-blue-300">{g.name}<span className="text-gray-600 ml-1">›</span></td>
                              <td className="px-4 py-3"><CatBadge>{g.cat}</CatBadge></td>
                              <td className="px-4 py-3 text-gray-400">{g.facs.size}</td>
                              <td className="px-4 py-3 text-gray-400">{g.batches}</td>
                              <td className="px-4 py-3 font-mono text-sm text-gray-300">{g.qty} {g.unit}</td>
                              <td className="px-4 py-3 font-mono text-xs text-gray-300">{fmtDate(g.soonest.toISOString().slice(0,10))}</td>
                              <td className={`px-4 py-3 font-mono text-sm font-semibold ${u.c}`}>{dL}d</td>
                              <td className="px-4 py-3"><span className={`text-xs font-semibold ${u.c}`}>{u.l}</span></td>
                            </tr>
                          )
                        })}</tbody>
                      </table></div>
                    )
                  })()
                }
              </Card>
            </>
          )}
        </>
      )}
    </div>
  )
}
