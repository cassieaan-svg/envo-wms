import { useState, useEffect } from 'react'
import { sb } from '../../lib/supabase'
import { useAppStore } from '../../store/appStore'
import { Card, CardHeader, CardTitle } from '../../components/ui/Card'
import { CatBadge } from '../../components/ui/Badge'
import { LoadingState, EmptyState } from '../../components/ui/Loading'
import { fmtDate, todayLagos } from '../../utils/helpers'

export function DailySummary() {
  const store = useAppStore()
  const [date, setDate]   = useState(todayLagos())
  const [data, setData]   = useState([])
  const [loading, setLoading] = useState(false)
  const facId = store.getEffectiveFacilityId()

  useEffect(() => { load() }, [date, facId])

  async function load() {
    setLoading(true)
    let q = sb.from('dispense_log')
      .select('*,commodities(name,category,unit),facilities(name)')
      .gte('dispensed_at',date+'T00:00:00').lte('dispensed_at',date+'T23:59:59')
      .order('dispensed_at',{ascending:false})
    if (facId) q = q.eq('facility_id',facId)
    const { data: rows } = await q

    const agg={}
    ;(rows||[]).forEach(r=>{
      const k=r.facility_id+'|'+r.commodity_id
      if(!agg[k]) agg[k]={facName:r.facilities?.name||'—',commName:r.commodities?.name||'—',cat:r.commodities?.category||'—',unit:r.commodities?.unit||'',qty:0,txn:0}
      agg[k].qty+=r.quantity; agg[k].txn++
    })
    setData(Object.values(agg).sort((a,b)=>b.qty-a.qty))
    setLoading(false)
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-medium text-gray-100 flex items-center gap-2">
          Daily Summary <span className="text-xs bg-purple-500/20 text-purple-400 border border-purple-500/30 rounded px-2 py-0.5">Admin</span>
        </h1>
        <p className="text-sm text-gray-500 mt-1">Stock activity by facility and commodity</p>
      </div>
      <Card>
        <div className="px-4 py-3 flex gap-3 items-center">
          <span className="text-xs text-gray-500 uppercase tracking-widest">Date</span>
          <input type="date" value={date} onChange={e=>setDate(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"/>
        </div>
      </Card>
      <Card>
        <CardHeader><CardTitle>Stock recorded — {fmtDate(date)}</CardTitle></CardHeader>
        {loading ? <LoadingState/> : data.length===0 ? <EmptyState message="No stock recorded for this date."/> : (
          <div className="table-wrap"><table className="w-full text-sm">
            <thead><tr className="border-b border-white/8 bg-white/2">
              {['Facility','Commodity','Category','Units Consumed','Transactions'].map(h=>(
                <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
              ))}
            </tr></thead>
            <tbody>{data.map((r,i)=>(
              <tr key={i} className="border-b border-white/5 hover:bg-white/2">
                <td className="px-4 py-3 text-xs text-gray-400">{r.facName}</td>
                <td className="px-4 py-3 font-medium text-gray-100">{r.commName}</td>
                <td className="px-4 py-3"><CatBadge>{r.cat}</CatBadge></td>
                <td className="px-4 py-3 font-mono text-sm text-red-400">-{r.qty} {r.unit}</td>
                <td className="px-4 py-3 text-gray-400">{r.txn}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  )
}
