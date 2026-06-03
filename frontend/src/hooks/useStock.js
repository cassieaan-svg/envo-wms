import { useEffect } from 'react'
import { sb } from '../lib/supabase'
import { useAppStore } from '../store/appStore'
import { SECTION_CATEGORIES } from '../utils/helpers'

export function useStock() {
  const store = useAppStore()

  const loadStock = async () => {
    const { accessLevel, currentFacility, adminFilterFacility,
            allFacilities, allCommodities, commoditySection } = useAppStore.getState()

    const select = 'id,facility_id,commodity_id,quantity,tablet_buffer,baseline_amc,updated_at,location_type,' +
      'facilities(name,state,lga),commodities(name,category,unit,dispensing_unit,pack_size)'

    const fac = accessLevel === 'facility' ? currentFacility : adminFilterFacility
    const sectionIds  = commoditySection ? allCommodities.map(c => c.id) : []
    const sectionCats = commoditySection ? (SECTION_CATEGORIES[commoditySection] || []) : []

    // Paginate: an admin viewing every facility easily exceeds the 1000-row
    // PostgREST cap, which would otherwise silently truncate the stock list.
    const PAGE = 1000
    let all = []
    let hadError = false
    for (let offset = 0; ; offset += PAGE) {
      let q = sb.from('stock').select(select).range(offset, offset + PAGE - 1)

      // Scope by facility
      if (fac) q = q.eq('facility_id', fac.id)
      else if (accessLevel === 'facility' && currentFacility?.id) q = q.eq('facility_id', currentFacility.id)
      else if (accessLevel !== 'overall_admin') {
        const facIds = allFacilities.map(f => f.id)
        if (facIds.length) q = q.in('facility_id', facIds)
      }

      // Scope by commodity section (commodities + category)
      if (sectionIds.length)  q = q.in('commodity_id', sectionIds)
      if (sectionCats.length) q = q.in('commodities.category', sectionCats)

      const { data, error } = await q
      if (error) { hadError = true; break }
      if (!data || !data.length) break
      all = all.concat(data)
      if (data.length < PAGE) break
    }

    if (!hadError) store.setStockData(all)
  }

  return { loadStock }
}

export function useRealtimeStock() {
  const { loadStock } = useStock()

  useEffect(() => {
    loadStock()
    const channel = sb.channel('stock-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stock' }, loadStock)
      .subscribe()
    return () => sb.removeChannel(channel)
  }, [])
}
