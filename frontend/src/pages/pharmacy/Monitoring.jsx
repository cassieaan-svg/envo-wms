import { useState, useEffect } from 'react'
import { sb } from '../../lib/supabase'
import { useAppStore } from '../../store/appStore'
import { Card, CardHeader, CardTitle, CardBody } from '../../components/ui/Card'
import { MetricGrid, Metric } from '../../components/ui/Metric'
import { CatBadge, Badge } from '../../components/ui/Badge'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { fmtDate, getMOS, getStockStatus, fmtStockQty } from '../../utils/helpers'

export function Monitoring() {
  const store = useAppStore()
  const isAdm = store.isAdmin()
  const commoditySection = store.commoditySection
  const sec = q => commoditySection ? q.eq('section', commoditySection) : q
  const [tab, setTab]       = useState('consumption')
  const [period, setPeriod] = useState(30)
  const [consData, setCons] = useState(null)
  const [stockData2, setStockData2] = useState(null)
  const [expiryData, setExpiryData] = useState(null)
  const [loading, setLoading] = useState(false)

  const fid     = store.currentFacility?.id || store.getEffectiveFacilityId()
  const commIds = store.allCommodities.map(c => c.id)

  useEffect(() => { loadConsumption() }, [fid, period])

  async function loadConsumption() {
    setLoading(true)
    const start = new Date(); start.setDate(start.getDate()-period)
    let q = sb.from('dispense_log')
      .select('commodity_id,quantity,dispensed_at,commodities(name,category,unit),facilities(name)')
      .gte('dispensed_at',start.toISOString()).in('commodity_id',commIds)
    if (fid) q = q.eq('facility_id',fid)
    q = sec(q)
    const { data } = await q

    const rows = data||[]
    const byComm={}, byCat={}, daily={}
    for(let i=period-1;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);daily[d.toISOString().split('T')[0]]=0}
    rows.forEach(r=>{
      const name=r.commodities?.name||r.commodity_id
      const cat=r.commodities?.category||'Other'
      if(!byComm[name]) byComm[name]={name,cat,unit:r.commodities?.unit||'',qty:0,txn:0}
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
    const today=new Date(); const cutoff=new Date(today.getTime()+180*86400000).toISOString().split('T')[0]
    let q = sb.from('intake_log')
      .select('*,commodities(name,category,unit)')
      .not('expiry_date','is',null).lte('expiry_date',cutoff)
      .gte('expiry_date',today.toISOString().split('T')[0])
      .gt('quantity',0).in('commodity_id',commIds)
    if(fid) q=q.eq('facility_id',fid)
    q = sec(q)
    const {data} = await q
    setExpiryData(data||[])
    setLoading(false)
  }

  async function loadStockMon() {
    setLoading(true)
    const threeMonthsAgo=new Date(); threeMonthsAgo.setMonth(threeMonthsAgo.getMonth()-3)
    const commDispenses={}
    if(commIds.length&&fid){
      const {data}=await sec(sb.from('dispense_log').select('commodity_id,quantity,dispensed_at').gte('dispensed_at',threeMonthsAgo.toISOString()).in('commodity_id',commIds).eq('facility_id',fid))
      const g={}
      ;(data||[]).forEach(d=>{const m=d.dispensed_at.slice(0,7);if(!g[d.commodity_id])g[d.commodity_id]={};g[d.commodity_id][m]=(g[d.commodity_id][m]||0)+d.quantity})
      Object.entries(g).forEach(([cid,months])=>{const vals=Object.values(months).sort((a,b)=>b-a);commDispenses[cid]=vals.length>=2?(vals[0]+vals[1])/2:vals[0]||0})
    }
    const enriched=store.stockData.map(r=>{
      const amc=commDispenses[r.commodity_id]&&commDispenses[r.commodity_id]>0?commDispenses[r.commodity_id]:(r.baseline_amc||0)
      const mos=getMOS(r.quantity,amc)
      const status=getStockStatus(r.quantity,amc)
      return{...r,amc,mos,status}
    })
    setStockData2(enriched)
    setLoading(false)
  }

  function switchTab(t) {
    setTab(t)
    if(t==='consumption') loadConsumption()
    if(t==='expiry')      loadExpiry()
    if(t==='stock')       loadStockMon()
  }

  const today=new Date()
  const catColors={'Pharmacy drugs':'#3fb950','RTKs':'#58a6ff','Lab reagents':'#d29922','Medical supplies':'#bc8cff'}
  const statusColor={out:'text-red-400',low:'text-red-400',ok:'text-green-400',over:'text-blue-400',unknown:'text-gray-500'}
  const statusLabel={out:'Out of stock',low:'Low stock',ok:'In stock',over:'Overstock',unknown:'No data'}

  const TabBtn=({id,label})=>(
    <button onClick={()=>switchTab(id)}
      style={{flex:1,padding:'10px',border:'none',cursor:'pointer',fontFamily:'inherit',fontSize:'13px',fontWeight:tab===id?500:400,background:tab===id?'rgba(255,255,255,0.08)':'transparent',color:tab===id?'#e6edf3':'#8b949e',borderRight:id!=='stock'?'1px solid rgba(255,255,255,0.08)':'none'}}>
      {label}
    </button>
  )

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100">Monitoring Dashboard</h1>
        <p className="text-sm text-gray-500 mt-1">Real-time programme performance</p>
      </div>

      {isAdm && (
        <div style={{display:'flex',gap:0,marginBottom:'1.25rem',border:'1px solid rgba(255,255,255,0.08)',borderRadius:'8px',overflow:'hidden',background:'rgba(255,255,255,0.03)'}}>
          <TabBtn id="consumption" label="📊 Consumption"/>
          <TabBtn id="expiry"      label="⏳ Expiry"/>
          <TabBtn id="stock"       label="📦 Stock on Hand"/>
        </div>
      )}

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
          </div>
        </Card>
      )}

      {loading && <LoadingState/>}

      {!loading && tab==='consumption' && consData && (
        <>
          <MetricGrid>
            <Metric label={`Units consumed (${period}d)`} value={consData.total.toLocaleString()} color="green"/>
            <Metric label="Commodities moved" value={consData.byComm.length} color="blue"/>
            <Metric label="Transactions" value={consData.rows.length.toLocaleString()}/>
          </MetricGrid>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            <Card>
              <CardHeader><CardTitle>Daily consumption — last {Math.min(period,30)} days</CardTitle></CardHeader>
              <CardBody>
                {(() => {
                  const entries = Object.entries(consData.daily).slice(-Math.min(period,30))
                  const maxVal = Math.max(...entries.map(([,v])=>v),1)
                  return (
                    <div style={{display:'flex',alignItems:'flex-end',gap:'3px',height:'80px'}}>
                      {entries.map(([day,val])=>{
                        const h=Math.round((val/maxVal)*100)
                        const d=new Date(day)
                        const lbl=d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'})
                        return (
                          <div key={day} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:'3px'}}>
                            <div style={{width:'100%',background:'#3fb950',borderRadius:'2px 2px 0 0',height:`${h}%`,minHeight:val>0?2:0,opacity:0.85}} title={`${lbl}: ${val}`}/>
                            <div style={{fontSize:'9px',color:'#484f58',writingMode:'vertical-rl',transform:'rotate(180deg)',maxHeight:'28px',overflow:'hidden'}}>{lbl}</div>
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}
              </CardBody>
            </Card>

            <Card>
              <CardHeader><CardTitle>By category</CardTitle></CardHeader>
              <CardBody>
                {Object.entries(consData.byCat).sort((a,b)=>b[1]-a[1]).map(([cat,qty])=>{
                  const pct=Math.round((qty/consData.total)*100)||0
                  const color=catColors[cat]||'#8b949e'
                  return (
                    <div key={cat} className="mb-3">
                      <div className="flex justify-between mb-1">
                        <span className="text-sm text-gray-300">{cat}</span>
                        <span className="text-xs font-mono text-gray-500">{qty.toLocaleString()} ({pct}%)</span>
                      </div>
                      <div className="h-1.5 bg-white/5 rounded-full">
                        <div style={{width:`${pct}%`,height:'100%',background:color,borderRadius:'9999px'}}/>
                      </div>
                    </div>
                  )
                })}
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle>Top commodities — last {period} days</CardTitle></CardHeader>
            {consData.byComm.length===0 ? <EmptyState message="No dispensing in this period."/> : (
              <div className="table-wrap"><table className="w-full text-sm">
                <thead><tr className="border-b border-white/8 bg-white/2">
                  {['#','Commodity','Category','Units Consumed','Transactions','Share'].map(h=>(
                    <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                  ))}
                </tr></thead>
                <tbody>{consData.byComm.slice(0,15).map((c,i)=>{
                  const pct=Math.round((c.qty/consData.total)*100)||0
                  const color=catColors[c.cat]||'#8b949e'
                  return (
                    <tr key={i} className="border-b border-white/5 hover:bg-white/2">
                      <td className="px-4 py-3 font-mono text-xs text-gray-600">{i+1}</td>
                      <td className="px-4 py-3 font-medium text-gray-100">{c.name}</td>
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
          </Card>
        </>
      )}

      {!loading && tab==='expiry' && isAdm && (
        <>
          {!expiryData ? <EmptyState message="Loading…"/> : (
            <>
              <MetricGrid>
                <Metric label="Critical (≤30d)"  value={expiryData.filter(r=>(new Date(r.expiry_date)-today)/86400000<=30).length}  color="red"/>
                <Metric label="Warning (≤90d)"   value={expiryData.filter(r=>{const d=(new Date(r.expiry_date)-today)/86400000;return d>30&&d<=90}).length} color="amber"/>
                <Metric label="Monitor (≤6mo)"   value={expiryData.filter(r=>(new Date(r.expiry_date)-today)/86400000>90).length}   color="blue"/>
                <Metric label="Total batches"     value={expiryData.length}/>
              </MetricGrid>
              <Card>
                <CardHeader><CardTitle>Expiring batches — next 6 months</CardTitle></CardHeader>
                {expiryData.length===0 ? <EmptyState message="No batches expiring in the next 6 months ✓"/> : (
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
                )}
              </Card>
            </>
          )}
        </>
      )}

      {!loading && tab==='stock' && isAdm && (
        <>
          {!stockData2 ? <EmptyState message="Loading…"/> : (
            <>
              <MetricGrid>
                <Metric label="Total units"    value={stockData2.reduce((s,r)=>s+r.quantity,0).toLocaleString()} color="green"/>
                <Metric label="Out of stock"   value={stockData2.filter(r=>r.status==='out').length}   color="red"/>
                <Metric label="Low stock"      value={stockData2.filter(r=>r.status==='low').length}   color="amber"/>
                <Metric label="Overstock"      value={stockData2.filter(r=>r.status==='over').length}  color="blue"/>
              </MetricGrid>
              <Card>
                <CardHeader><CardTitle>Stock detail — MOS &amp; AMC</CardTitle></CardHeader>
                <div className="table-wrap"><table className="w-full text-sm">
                  <thead><tr className="border-b border-white/8 bg-white/2">
                    {['Commodity','Category','Stock on hand','AMC','MOS','Status'].map(h=>(
                      <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>{stockData2.sort((a,b)=>(a.mos===null?999:a.mos)-(b.mos===null?999:b.mos)).map(r=>(
                    <tr key={r.id} className="border-b border-white/5 hover:bg-white/2">
                      <td className="px-4 py-3 font-medium text-gray-100">{r.commodities?.name||'—'}</td>
                      <td className="px-4 py-3"><CatBadge>{r.commodities?.category||'—'}</CatBadge></td>
                      <td className={`px-4 py-3 font-mono text-sm ${r.quantity===0?'text-red-400 font-semibold':'text-gray-200'}`}>{fmtStockQty(r.quantity,r.commodities)}</td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.amc>0?r.amc.toFixed(1):'—'}</td>
                      <td className={`px-4 py-3 font-mono text-sm font-medium ${statusColor[r.status]}`}>{r.mos!==null?r.mos+'mo':'—'}</td>
                      <td className="px-4 py-3"><Badge type={r.status==='unknown'?'info':r.status}>{statusLabel[r.status]}</Badge></td>
                    </tr>
                  ))}</tbody>
                </table></div>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  )
}
