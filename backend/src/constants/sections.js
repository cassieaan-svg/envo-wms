// Pharmacy vs. lab component split, by commodity category. This is the backend
// copy of the map the frontend uses in src/utils/helpers.js (SECTION_CATEGORIES) —
// keep the two in sync. Here it is a server-enforced access boundary, not just a
// display filter: a caller whose token pins them to one section can only read/write
// commodities in that section's categories.
export const SECTION_CATEGORIES = {
  pharmacy: ['Pharmacy drugs', 'Medical supplies'],
  lab:      ['RTKs', 'Lab reagents', 'Lab consumables'],
}

// Categories that only the per-state "State Office Store" facilities handle. These
// are deliberately NOT part of any section's list above, so a section-pinned caller
// (a regular pharmacy/lab facility, a cluster/LGA viewer, an HQ section viewer) has
// them excluded automatically by the include-list filter. Only state-office callers
// get them appended (see attachScope) — and null-section admins see everything, so
// they see these too. Keep in sync with the frontend copy in src/utils/helpers.js.
export const STATE_OFFICE_CATEGORIES = ['General Consumables']

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
