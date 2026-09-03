# Phase 2E — ACL Shadow Comparison Findings

Status: **shadow mode only, approved.** Nothing here is implemented in the request path.
`backend/src/middleware/scope.js` remains the sole authorization authority. This document
records where `backend/src/services/aclResolver.js` — called from nowhere in the request
path — agrees and disagrees with it, and why each disagreement is left as-is rather than
resolved by changing either side.

Companion to `docs/authorization/permission-catalogue.md` (Phase 2A). Source of the findings
below: `backend/test/aclShadowComparison.test.js`, which asserts each mismatch **stays** a
mismatch — a regression there means the resolver quietly grew a legacy special case (or
reproduced a legacy bug) it should not yet have.

Shadow comparison result: **24 comparisons, 22 matches, 2 asserted mismatches**, plus one
dimension (commodity-section) with no resolver-side equivalent to compare against at all.

---

## Follow-up 1 — Pending-transfer counterparty `stock.read`

**Classification: legacy special case.**

Legacy `scope.js:129-142` lets a facility user read a **counterparty** facility's stock while a
transfer between the two is `pending` — a dynamic exception based on another table's rows, not
on the user's assigned scope. The ACL resolver has no model of "another facility's in-flight
transfer relationship," and none is added here. `stock.read`'s scope for a facility role remains
exactly "the assigned facility," which is narrower than legacy in this one case.

**Do not broaden the resolver to reproduce this.** Left as a known, asserted mismatch.

## Follow-up 2 — Commodity-section scope

**Classification: ACL scope-model gap / legacy special case.**

`commodity_section` (pharmacy/lab) and the category filtering it drives (`SECTION_CATEGORIES`,
the hub-store override, `FACILITY_EXTRA_COMMODITIES`) have **no representation anywhere in the
ACL schema** — not in `permissions`, not in `user_roles.scope_type`/`scope_id`. This is not a
gap in one function; it is an entire dimension the current five tables cannot express.

**No new permission key was created to represent it** (e.g. no `stock.read.pharmacy` or similar)
— that would be exactly the anti-pattern the permission-key naming rule forbids (a permission
must never encode scope). The correct fix, if one is ever built, is a new scope dimension
alongside facility/state/cluster/LGA — a design decision for a later phase, not this one.

## Follow-up 3 — Cross-facility write distinction

**Classification: ACL scope-model gap.**

`WRITE_ADMIN_LEVELS` in `scope.js` grants `state_admin` cross-facility write on `stock`,
`dsd_stock`, `sdp_stock`, `amc_settings`, and `transfer` — but **never** on `dispense_log`,
`intake_log`, or `adjustment_log` (an admin isn't the one physically dispensing or receiving —
`scope.js:48-53`). `role_permissions` has no column that could express "this permission, for this
role, narrows across facilities; that one doesn't" — `state_admin` holds all 24 permissions as
one flat grant.

The resolver reproduces the distinction via `CROSS_FACILITY_WRITE_PERMISSIONS`, a constant set
mirroring `WRITE_ADMIN_LEVELS`'s cross-facility grants exactly. **This constant is preserved as
the correct, deliberate representation of current behavior — it is not a placeholder to remove,
and cross-facility write must not be broadened to any additional permission** without a
corresponding change to the legacy `WRITE_ADMIN_LEVELS` map first (which this phase does not
touch).

## Follow-up 4 — Unmapped-table facility write

**Classification: existing legacy authorization bug.**

`enforceFacilityWrite` grants a facility user's own-facility write for **any** table string,
including one entirely absent from `WRITE_ADMIN_LEVELS` (documented in the Phase 2A catalogue,
Section 6). The resolver correctly **denies** an undeclared permission key — deny-by-default,
not allow-by-omission.

**This must never be reproduced.** The shadow comparison test asserts this stays a mismatch;
"fixing" the resolver to match legacy here would mean baking a known security-relevant bug into
the new system rather than retiring it at cutover.

---

## Observed implementation detail — transfer bundles the section gate inline

`enforceTransferAccess` / `mayWriteTransfer` apply the commodity-section check **inline**, as
part of the same guard that checks facility-party scope. `stock`'s equivalent section check
(`enforceCommoditySection`) is a **separate** function, called independently by routes that need
it. This asymmetry was discovered constructing the transfer shadow-comparison test — an early
version passed no commodity, which the transfer guard's inline section gate treated as an
unknown-category refusal, unrelated to the facility-party scope the test intended to isolate.

This is recorded as an **observed legacy implementation detail, not something to normalize in
Phase 2E.** The two guards are allowed to keep differing in shape; a future phase deciding to
unify them (or not) is a separate design question.

---

## What is NOT a finding

For completeness: `overall_admin`'s deliberate read-only design (Phase 2A/2C, Step 8) and its
scope representation (`scope_type=''`, unconstrained) both matched cleanly in shadow comparison
and are not listed above as gaps — they are correctly and fully representable in the current
model.
