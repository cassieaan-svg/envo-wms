// Pharmacy vs. lab component split, by commodity category. This is the backend
// copy of the map the frontend uses in src/utils/helpers.js (SECTION_CATEGORIES) —
// keep the two in sync. Here it is a server-enforced access boundary, not just a
// display filter: a caller whose token pins them to one section can only read/write
// commodities in that section's categories.
export const SECTION_CATEGORIES = {
  pharmacy: ['Pharmacy drugs', 'Medical supplies'],
  lab:      ['RTKs', 'Lab reagents', 'Lab consumables'],
}

// The commodity categories a section covers, or null when the caller is not
// section-restricted (sees both). Unknown section strings → null (fail open to
// "both" rather than silently hiding everything; the role scoping still applies).
export function categoriesForSection(section) {
  if (!section) return null
  return SECTION_CATEGORIES[section] || null
}
