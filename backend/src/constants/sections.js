// Pharmacy vs. lab component split, by commodity category. This is the backend
// copy of the map the frontend uses in src/utils/helpers.js (SECTION_CATEGORIES) —
// keep the two in sync. Here it is a server-enforced access boundary, not just a
// display filter: a caller whose token pins them to one section can only read/write
// commodities in that section's categories.
export const SECTION_CATEGORIES = {
  pharmacy: ['Pharmacy drugs'],
  lab:      ['RTKs', 'Lab reagents', 'Lab consumables'],

  // A section is just "a named set of categories". It was originally only the
  // pharmacy/lab split inside HIV, but nothing in the mechanism requires that —
  // and treating it as an HIV-only concept left two category sets unreachable by
  // any section scope, which is a gap rather than a design.
  //
  // essential — the Essential Commodities module's own six categories. Without
  //   this, an Essential account pinned to a section could never see an Essential
  //   item: sections AND with the module dimension, and no section contained an
  //   Essential category.
  // general  — the hub-store category. It belongs to neither pharmacy nor lab
  //   (that is deliberate: a section-pinned facility must not see it), so it was
  //   reachable only through the STATE_OFFICE_CATEGORIES override and could not
  //   be granted to anyone else.
  //
  // ADDITIVE AND PROVABLY LIVE-SAFE: no account carries either value in
  // raw_user_meta_data.commodity_section (only lab, pharmacy, tools and none
  // exist), so categoriesForSection resolves these for nobody until an ACL scope
  // row names them. The pharmacy and lab lists are untouched.
  essential: ['Tablets, caplets & capsules', 'Consumables', 'Injections',
              'Syrups & suspensions', 'Ophthalmic preparations', 'Infusions'],
  general:   ['General Consumables'],
}

// The new "General Consumables" category — not part of the pharmacy or lab lists,
// so a caller pinned to either never sees it (excluded by the include-list filter).
export const GENERAL_CONSUMABLES = 'General Consumables'

// Which sections belong to which module. A module is the set of its sections'
// categories, so this is the one place that says what "the HIV catalogue" means.
//
// KEEP `me` IN MIND: when the envo-tools branch lands it adds an `me` section
// (M&E Tools) to the HIV module, and it must be added to HIV_SECTIONS here or
// admins will stop seeing those items.
const HIV_SECTIONS = ['pharmacy', 'lab', 'general']
const ESSENTIAL_SECTIONS = ['essential']

const categoriesOf = keys => [...new Set(keys.flatMap(k => SECTION_CATEGORIES[k] || []))]

export const HIV_CATEGORIES = categoriesOf(HIV_SECTIONS)
export const ESSENTIAL_CATEGORIES = categoriesOf(ESSENTIAL_SECTIONS)

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

// A facility is a cluster store when its name reads "… Cluster Lab Store" (the naming
// convention set by createClusterStores.mjs — cluster-tier, no LGA).
export function isClusterStoreName(name) {
  return /cluster lab store/i.test(name || '')
}

// A HUB store — state office or cluster store. Neither dispenses to patients: both hold
// stock and push it down to the facilities they serve. A cluster store is the state
// office one level down and handles the SAME categories, so this is deliberately ONE
// list rather than two identical ones that could drift apart.
export function isHubStoreName(name) {
  return isStateOfficeName(name) || isClusterStoreName(name)
}
export const HUB_STORE_CATEGORIES = STATE_OFFICE_CATEGORIES

// Per-facility grants of INDIVIDUAL commodities, on top of that facility's category
// list. Deliberately by commodity NAME and keyed by ONE facility, because the request
// this exists for cannot be expressed as a category:
//
//   Akwa Ibom's state office handles Alere Determine. Alere Determine's category is
//   RTKs — adding 'RTKs' to STATE_OFFICE_CATEGORIES would have granted EVERY RTK to
//   EVERY state office (Cross River and Lagos included), which is not what was asked.
//
// So this is an explicit allowlist, not a widening of the model: nothing here affects
// any facility that isn't named as a key. Keep in sync with the frontend copy in
// utils/helpers.js.
// Each grant records the commodity's own category as well as its name. The category
// isn't used to widen anything — it is what lets an explicit `?section=` narrowing
// drop the grant when it doesn't belong to the requested section (Alere Determine is
// an RTK, so it survives a lab-section view and is correctly excluded from a pharmacy
// one).
const FACILITY_EXTRA_COMMODITIES = {
  'akwa ibom state office store': [{ name: 'Alere Determine', category: 'RTKs' }],
}

const facilityKey = name => String(name || '').trim().toLowerCase()

// The individually-granted commodity names for a facility, or [] for the vast
// majority that have none. Name match is case-insensitive and whitespace-tolerant.
export function extraCommoditiesForFacility(name) {
  return (FACILITY_EXTRA_COMMODITIES[facilityKey(name)] || []).map(g => g.name)
}

// Narrow a grant list to those whose own category falls inside `sectionCats`. Used
// where a request explicitly asks for one section: a grant must not leak a commodity
// into a section it doesn't belong to. Passing a non-array (no narrowing) is a no-op.
export function narrowGrantsToCategories(commodityNames, sectionCats) {
  if (!Array.isArray(sectionCats) || !Array.isArray(commodityNames)) return commodityNames
  const catOf = new Map(Object.values(FACILITY_EXTRA_COMMODITIES).flat().map(g => [g.name, g.category]))
  return commodityNames.filter(n => sectionCats.includes(catOf.get(n)))
}

/**
 * The section/category WHERE fragment shared by every scoped query, so the category
 * list and the per-facility commodity grant can never drift apart between endpoints.
 *
 * Returns null when the caller isn't section-restricted (admins see everything).
 * Otherwise: `(c.category = any($n))`, OR-ed with `c.name = any($m)` when the caller
 * holds individual grants. Pushes onto `params` and uses the resulting positions, so
 * it composes with whatever the caller has already bound.
 */
export function sectionFilterSql(alias, categories, commodityNames, params) {
  if (!Array.isArray(categories) || !categories.length) return null
  const cat = `${alias}.category = any($${params.push(categories)})`
  if (!Array.isArray(commodityNames) || !commodityNames.length) return cat
  return `(${cat} or ${alias}.name = any($${params.push(commodityNames)}))`
}

/**
 * sectionFilterSql for the report queries, which bind a FIXED number of parameters
 * up front and append extras. `boundCount` is how many are already bound ($1..$n).
 * Returns the fragment ready to concatenate (already prefixed with " and ", or empty)
 * plus the parameters to spread onto the end of the array.
 */
export function sectionFilterFixed(alias, categories, commodityNames, boundCount) {
  const params = []
  const cond = sectionFilterSql(alias, categories, commodityNames,
    { push: v => { params.push(v); return boundCount + params.length } })
  return { cond: cond ? ` and ${cond}` : '', params }
}

// The in-memory equivalent of sectionFilterSql, for guards that already hold a row.
export function allowsCommodity(categories, commodityNames, category, name) {
  if (!Array.isArray(categories) || !categories.length) return true
  if (category && categories.includes(category)) return true
  return !!name && Array.isArray(commodityNames) && commodityNames.includes(name)
}

// The commodity categories a section covers, or null when the caller is not
// section-restricted (sees both). Unknown section strings → null (fail open to
// "both" rather than silently hiding everything; the role scoping still applies).
export function categoriesForSection(section) {
  if (!section) return null
  return SECTION_CATEGORIES[section] || null
}
