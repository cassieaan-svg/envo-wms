import { useEffect } from 'react'
import { sb } from '../lib/supabase'
import { useAppStore } from '../store/appStore'
import { SECTION_CATEGORIES } from '../utils/helpers'

export function useStock() {
  const store = useAppStore()

  const loadStock = async () => {
    const { accessLevel, currentFacility, adminFilterFacility,
            allFacilities, allCommodities, commoditySection } = useAppStore.getState()

    let q = sb.from('stock').select(
      'id,facility_id,commodity_id,quantity,tablet_buffer,baseline_amc,updated_at,location_type,' +
      'facilities(name,state,lga),commodities(name,category,unit,dispensing_unit,pack_size)'
    )

    // Scope by facility
    const fac = accessLevel === 'facility' ? currentFacility : adminFilterFacility
    if (fac) {
      q = q.eq('facility_id', fac.id)
    } else if (accessLevel === 'facility' && currentFacility?.id) {
      q = q.eq('facility_id', currentFacility.id)
    } else if (accessLevel !== 'overall_admin') {
      const facIds = allFacilities.map(f => f.id)
      if (facIds.length) q = q.in('facility_id', facIds)
    }

    // Scope by commodity section - filter both by store's commodities AND category
    if (commoditySection) {
      const sectionIds = allCommodities.map(c => c.id)
      if (sectionIds.length) q = q.in('commodity_id', sectionIds)
      // Extra safety: also filter by category directly
      const sectionCats = SECTION_CATEGORIES[commoditySection] || []
      if (sectionCats.length) q = q.in('commodities.category', sectionCats)
    }

    const { data, error } = await q
    if (!error) store.setStockData(data || [])
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
