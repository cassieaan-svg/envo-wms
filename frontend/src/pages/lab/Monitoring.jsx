import { useState, useEffect } from 'react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/appStore'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { MetricGrid, Metric } from '../../components/ui/Metric'
import { CatBadge } from '../../components/ui/Badge'
import { LoadingState, EmptyState, Spinner } from '../../components/ui/Loading'
import { FacilityPicker } from '../../components/ui/FacilityPicker'
import { DailyTrendChart } from '../../components/DailyTrendChart'

// Minimal CSV export (mirrors the AllFacilities helper): download rows as a file.
function exportCsv(filename, headers, rows) {
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const csv = [headers, ...rows].map(r => r.map(esc).join(',')).join('\r\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}
import { fmtDate, capExpiryBatchesToStockByFacility } from '../../utils/helpers'

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
  const [metricDrill, setMetricDrill] = useState(null)  // 'units' | 'transactions' | 'commodities'
  const [lgaDrill, setLgaDrill] = useState(null)  // LGA name drilled into within a by-LGA breakdown
  const [catHover, setCatHover] = useState(null)  // category hovered in the donut (highlight only)
  const [expDrill, setExpDrill]   = useState(null)  // 'critical' | 'warning' | 'monitor' | 'total'
  const [expBatchComm, setExpBatchComm] = useState(null)  // Expiring-batches table: commodity drilled into {id,name,cat}
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

  async function loadUtilization() {
    setLoading(true)
    setCatDrill(null); setCommDrill(null); setMetricDrill(null); setLgaDrill(null)
    const start = new Date(); start.setDate(start.getDate()-period)
    const scopeParams = store.getAdminScopeParams()

    // Paginate — an admin over a long period easily exceeds the 1000-row cap,
    // which would otherwise silently understate totals and drill-downs.
    const PAGE = 1000
    let rows = []
    for (let offset = 0; ; offset += PAGE) {
      let data
      try {
        data = await api.dispense.history({
          ...scopeParams,
          // commodity scope is applied server-side via the section/category scope;
          // enumerating every commodity id here would bloat the URL past proxy limits.
          from: start.toISOString(),
          section: commoditySection || undefined,
          limit: PAGE, offset,
        })
      } catch { break }
      if (!data || !data.length) break
      rows = rows.concat(data)
      if (data.length < PAGE) break
    }

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
    const scopeParams = store.getAdminScopeParams()

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
      ...scopeParams,
      expiry_from: now.toISOString().split('T')[0], expiry_to: cutoff,
      has_quantity: true, section: commoditySection || undefined,
    })

    // Intake records the quantity RECEIVED and is never decremented as stock is
    // consumed/transferred, so cap each batch to its own facility's current stock
    // on hand for that commodity. Batches span many facilities here, so SOH is
    // keyed per (facility, commodity) — not a single per-commodity total. Lab
    // SOH = store (from /api/stock) + SDP.
    const [stockRows, sdpRows] = await Promise.all([
      fetchAllPages(api.stock.list, { ...scopeParams }),
      fetchAllPages(api.stock.sdp.list, { ...scopeParams }),
    ])
    const sohByFacComm = {}
    const addSoh = (fId, cId, q) => { const k = `${fId}|${cId}`; sohByFacComm[k] = (sohByFacComm[k] || 0) + (q || 0) }
    stockRows.filter(s => s.location_type === 'store').forEach(s => addSoh(s.facility_id, s.commodity_id, s.quantity))
    sdpRows.forEach(d => addSoh(d.facility_id, d.commodity_id, d.quantity))

    // capExpiryBatchesToStockByFacility drops depleted batches and returns soonest-first.
    setExpiryData(capExpiryBatchesToStockByFacility(all, sohByFacComm))
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
        <TabBtn id="utilization" label="📊 Utilization"/>
        <TabBtn id="expiry"      label="⏳ Expiry"/>
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
            <button onClick={loadExpiry} disabled={loading} className="ml-auto text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5 disabled:opacity-60 inline-flex items-center gap-1.5">
              {loading && <Spinner size="sm"/>}{loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </Card>
      )}

      {loading && <LoadingState/>}

      {!loading && tab==='utilization' && consData && (
        <>
          <MetricGrid>
            <Metric label={`Units utilized (${period}d)`} value={consData.total.toLocaleString()} color="green"/>
            <Metric label="Commodities utilized" value={consData.byComm.length} color="blue"
              onClick={isAdm?()=>setMetricDrill(metricDrill==='commodities'?null:'commodities'):undefined} active={metricDrill==='commodities'}/>
            <Metric label="Utilization records" value={consData.rows.length.toLocaleString()}
              onClick={isAdm?()=>{setLgaDrill(null);setMetricDrill(metricDrill==='transactions'?null:'transactions')}:undefined} active={metricDrill==='transactions'}/>
          </MetricGrid>

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
                <FacilityLgaBreakdown rows={consData.rows} mode={metricDrill==='transactions'?'count':'units'} unitsLabel={metricDrill==='transactions'?'Utilization records':'Units Utilized'}/>
              )}
            </Card>
          )}

          <div className={`grid grid-cols-1 ${isAdm ? 'lg:grid-cols-2' : ''} gap-4 mb-4`}>
            <Card>
              <CardHeader><CardTitle>Daily utilization</CardTitle></CardHeader>
              <CardBody>
                <DailyTrendChart daily={consData.daily} unit="units" />
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
              const commRows = consData.rows.filter(r=>r.commodity_id===commDrill.id)
              const cTotal = commRows.reduce((s,r)=>s+r.quantity,0)||1
              const byFac = aggRows(commRows, r=>r.facility_id).map(([id,qty])=>({id,qty,name:facMeta[id]?.name||'—',lga:facMeta[id]?.lga||'—'}))
              return (
                <>
                  <CardHeader>
                    <CardTitle>{commDrill.name} — facilities utilizing this commodity</CardTitle>
                    <button onClick={()=>setCommDrill(null)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">← Top commodities</button>
                  </CardHeader>
                  {byFac.length===0 ? <EmptyState message="No facility-level data."/> : (
                    <div className="table-wrap"><table className="w-full text-sm">
                      <thead><tr className="border-b border-white/8 bg-white/2">
                        {['#','Facility','LGA','Units Utilized','Share'].map(h=>(
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
                          <div className="flex gap-2">
                            <button onClick={()=>{
                              const base=(expBatchComm.name||'commodity').replace(/[^a-z0-9]+/gi,'_').replace(/^_+|_+$/g,'')
                              const headers=['Facility','LGA','Batch','Expiry date','Days left','Qty','Unit','Urgency']
                              const rows=batches.map(r=>{const dL=Math.round((new Date(r.expiry_date)-today)/86400000);const u=dL<=30?'Critical':dL<=90?'Warning':'Monitor';return [facMeta[r.facility_id]?.name||'—',facMeta[r.facility_id]?.lga||'—',r.batch_number||'',fmtDate(r.expiry_date),dL,r.quantity,r.commodities?.unit||'',u]})
                              exportCsv(`${base}_expiring-batches.csv`, headers, rows)
                            }} disabled={batches.length===0} className="text-xs text-gray-300 hover:text-white border border-white/10 rounded px-3 py-1.5 disabled:opacity-50">↓ Download CSV</button>
                            <button onClick={()=>setExpBatchComm(null)} className="text-xs text-gray-500 hover:text-gray-300 border border-white/10 rounded px-3 py-1.5">← Back to commodities</button>
                          </div>
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
                      <>
                      <div className="px-5 py-2 flex justify-end">
                        <button onClick={()=>{
                          const headers=['Commodity','Category','Facilities','Batches','Total qty','Unit','Soonest expiry','Days left','Urgency']
                          const rows=list.map(g=>{const dL=Math.round((g.soonest-today)/86400000);const u=dL<=30?'Critical':dL<=90?'Warning':'Monitor';return [g.name,g.cat,g.facs.size,g.batches,g.qty,g.unit,fmtDate(g.soonest.toISOString().slice(0,10)),dL,u]})
                          exportCsv(`expiring-commodities_${expPeriod}d.csv`, headers, rows)
                        }} disabled={list.length===0} className="text-xs text-gray-300 hover:text-white border border-white/10 rounded px-3 py-1.5 disabled:opacity-50">↓ Download CSV</button>
                      </div>
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
                      </>
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
