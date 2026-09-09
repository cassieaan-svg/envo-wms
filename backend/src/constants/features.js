// Configurable features — the registry of workflows that can be switched off
// for a department at a facility (feature_config).
//
// A FEATURE IS NOT A PERMISSION. A permission answers "is this user capable of
// this action"; a feature answers "does this workflow exist here at all". They
// are different questions with different owners: permissions are engineering's
// (declared in code, granted to roles), features are an administrator's
// (toggled at runtime, no deploy). See docs/authorization/authorization-model.md.
//
// Declared here rather than free text in the database so a typo cannot create a
// feature that nothing enforces — the same reason permission keys are
// code-declared. A row whose `feature` is not in this map is a data error, and
// aclFeatureConfig.test.js asserts none exist.

// feature key -> the permission keys it suppresses when disabled.
//
// DELIBERATELY WRITE-ONLY. Disabling `transfer` stops transfers being CREATED or
// ACTED ON; it does not hide transfer history. That matches the product's own
// existing behavior: the external-redistribution module is kept "view/print
// only" with its send form hard-disabled, precisely so past transfers stay
// readable. Gating transfer.read would break printing historical forms — the
// stated reason that module still exists.
export const FEATURES = {
  transfer: ['transfer.write'],
}

// The reverse lookup the resolver needs: permission key -> feature that gates it.
// A permission absent from this map is never feature-gated.
export const FEATURE_BY_PERMISSION = Object.freeze(
  Object.fromEntries(
    Object.entries(FEATURES).flatMap(([feature, keys]) => keys.map(k => [k, feature]))
  )
)

export const isDeclaredFeature = (name) => Object.prototype.hasOwnProperty.call(FEATURES, name)
