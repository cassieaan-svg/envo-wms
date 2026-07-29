// Pharmacy vs. lab component split, by commodity category. This is the backend
// copy of the map the frontend uses in src/utils/helpers.js (SECTION_CATEGORIES) —
// keep the two in sync. Here it is a server-enforced access boundary, not just a
// display filter: a caller whose token pins them to one section can only read/write
// commodities in that section's categories.
export const SECTION_CATEGORIES = {
  pharmacy: ['Pharmacy drugs'],
  lab:      ['RTKs', 'Lab reagents', 'Lab consumables'],
}

// The new "General Consumables" category — not part of any section list, so a
// regular section-pinned caller never sees it (excluded by the include-list filter).
export const GENERAL_CONSUMABLES = 'General Consumables'

// The COMPLETE category set a per-state "State Office Store" sees — it replaces the
// caller's normal section list (it is NOT the lab section): a state office handles
// only lab consumables and general consumables, not RTKs or reagents. Null-section
// admins still see everything. Keep in sync with the frontend copy in helpers.js.
export const STATE_OFFICE_CATEGORIES = ['Lab consumables', GENERAL_CONSUMABLES]

// A facility is a per-state office store when its name reads "… State Office Store"
// (the naming convention set by create_state_offices.mjs — state-tier, no LGA/cluster).
export function isStateOfficeName(name) {
  return /state office store/i.test(name || '')
}

// The commodity categories a section covers, or null when the caller is not
// section-restricted (sees both). Unknown section strings → null (fail open to
// "both" rather than silently hiding everything; the role scoping still applies).
export function categoriesForSection(section) {
  if (!section) return null
  return SECTION_CATEGORIES[section] || null
}
