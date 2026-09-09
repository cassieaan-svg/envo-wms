# EnVo Permission Catalogue — Phase 2A

Status: **design and inventory only. Nothing in this document is implemented.**

Source: `main` at commit `d2766f2`, inspected directly — `backend/src/middleware/scope.js`,
`backend/src/middleware/auth.js`, every route file, `backend/src/server.js`,
`backend/src/constants/sections.js`, and the frontend's own copy of the access model in
`frontend/src/utils/session.js`. Nothing here is inferred from an earlier report; every claim
below was checked against this code.

Two branch facts that shape this document:

- **`main` has no Tools module.** No `tool_*` routes, no `hq_tools` access level, no tools tables.
  This catalogue is therefore commodity/inventory-only. Tools permissions are a separate,
  later exercise once (or if) that module is merged to `main`.
- **`main`'s own test suite is 74 passing, 0 failing** — not the 137 figure from earlier phases.
  That 137 included Phase 1 test files (`authorizationBaseline.test.js`,
  `identityFoundation.test.js`) built against `envo-import`, which has Tools and is not this
  branch's ancestry. Those suites still exist, untouched, parked outside this branch (see
  Section H). This phase adds no tests and changes none — 74/0 is what `main` alone produces,
  and it is unchanged by this work.

---

## 1. Permission design principles

Three independent concepts. The confusion between them is exactly what the current system's
role-string checks conflate, and exactly what this redesign must keep apart:

```
PERMISSION   Can this user perform this action at all?        stock.write
ROLE         A named bundle of permissions a user holds.       state_admin
SCOPE        Which rows the permission applies to.             own state
```

`state_admin → stock.write, scoped to own state` is three separate facts. A role is never itself
a permission; a permission never carries a scope suffix (no `stock.write.own_state` — see
Section 4). This document defines permissions only. Roles and scope are catalogued for context
(Sections 3 and 4) but are explicitly **not** being created in this phase.

---

## 2. Permission catalogue

24 keys. `<resource>.read` / `<resource>.write` where the app actually distinguishes them;
special names only where a genuinely distinct action exists (Section 5).

| Permission key | Resource (DB table) | Current authorization source | Scope-dependent? | Notes |
|---|---|---|---|---|
| `stock.read` | `stock` | `enforceFacilityRead(...,'stock')`, `scopedReadFacilityIds` | Yes | Also grants read of the counterparty facility on a pending transfer — see Section 4 |
| `stock.write` | `stock` | `enforceFacilityWrite(...,'stock')` | Yes | Also governs lot edits (`PATCH /lots/:id`) — `stock_lot` has no permission of its own |
| `dsd_stock.read` | `dsd_stock` | `enforceFacilityRead(...,'dsd_stock')` | Yes | Separate resource from `stock`, not a scope of it |
| `dsd_stock.write` | `dsd_stock` | `enforceFacilityWrite(...,'dsd_stock')` | Yes | |
| `sdp_stock.read` | `sdp_stock` | `enforceFacilityRead(...,'sdp_stock')` | Yes | Separate resource from `stock`, not a scope of it |
| `sdp_stock.write` | `sdp_stock` | `enforceFacilityWrite(...,'sdp_stock')` | Yes | |
| `transfer.read` | `stock_transfer_log` | `enforceTransferAccess` | Yes | Business object is "transfer"; table is `stock_transfer_log` |
| `transfer.write` | `stock_transfer_log` | `enforceTransferWrite` / `mayWriteTransfer` | Yes | **One key covers create, dispatch, assign, accept, dispute, cancel, approve-internal, approve-dsd, receive, update, delete** — see Section 5 |
| `dispense_log.read` | `dispense_log` | `enforceFacilityRead(...,'dispense_log')` | Yes | |
| `dispense_log.write` | `dispense_log` | `enforceFacilityWrite(...,'dispense_log')` | Yes | Own-facility only for every role, including `state_admin` (see Section 3) |
| `intake_log.read` | `intake_log` | `enforceFacilityRead(...,'intake_log')` | Yes | |
| `intake_log.write` | `intake_log` | `enforceFacilityWrite(...,'intake_log')` | Yes | Own-facility only for every role |
| `adjustment_log.read` | `stock_adjustment_log` | `enforceFacilityRead(...,'adjustment_log')` | Yes | |
| `adjustment_log.write` | `stock_adjustment_log` | `enforceFacilityWrite(...,'adjustment_log')` | Yes | Own-facility only for every role |
| `amc_settings.read` | `facility_amc_settings` | none — `READ_ADMIN_LEVELS['amc_settings'] === 'public'` | No | Any authenticated user, unscoped |
| `amc_settings.write` | `facility_amc_settings` | `enforceFacilityWrite(...,'amc_settings')` | Yes | |
| `commodity.read` | `commodities` | none — `READ_ADMIN_LEVELS['commodities'] === 'public'` | No | Any authenticated user. See exclusions (Section 7) — no write exists |
| `facility.read` | `facilities` | none — `READ_ADMIN_LEVELS['facilities'] === 'public'` | No | Any authenticated user. No write exists |
| `edit_history.read` | `edit_history` | **none** — auth-only | No | Not facility-scoped at all today — see Section 6 |
| `edit_history.write` | `edit_history` | **none** — auth-only | No | Not facility-scoped at all today — see Section 6 |
| `report.read` | (derived) | `enforceFacilityRead(...,'dispense_log')` | Yes | Own resource: daily/weekly/monthly/stock-balance/CSV-export reports. Piggybacks on the `dispense_log` read tier today — see note below |
| `activity.read` | (derived) | `enforceFacilityRead(...,'dispense_log')` | Yes | Activity feed. Same piggyback |
| `bincard.read` | (derived) | `enforceFacilityRead(...,'stock')` | Yes | Bin card / stock-take view. Piggybacks on `stock`'s read tier |
| `system.diagnostics.read` | — | `isAdminScope(req.scope)` | No | Dev-only (`ENVO_DIAG=1`), exposes raw SQL text. Operational, not a business permission — see Section 5 |

**Deliberately excluded, and why** (Step 3's "a table is not automatically a permission"):

- `stock_lot` — no independent guard exists; lot edits are gated by `stock.write`.
- `commodity.write`, `facility.write` — **no write endpoint exists on `main` for either
  resource.** `commodities.js` and `facilities.js` are GET-only routers. Inventing a write
  permission for a capability that doesn't exist would be exactly the anti-pattern Step 3 warns
  against.
- CRUD granularity (`stock.create` / `stock.update` / `stock.delete`) — the current system draws
  the line at read/write only; no route or guard distinguishes finer than that anywhere.

**One naming inconsistency worth flagging, not resolving here:** `commodities.js`'s
`GET /transacted` endpoint is facility-scoped (`enforceFacilityRead(...,'dispense_log')`), unlike
every other commodity read, which is public. It doesn't cleanly fit `commodity.read` (which is
unscoped) or a new key (the capability is still "read commodities," just filtered by transaction
history). Left as `commodity.read` with this note; a future phase should decide whether it needs
its own key.

---

## 3. Current authorization mapping

Six access levels exist on `main` (`hq_tools` does not — Tools isn't merged here). For each:
current permissions, current scope, with source lines.

### `facility` (default when `access_level` is unset — see Section 8)
```
permissions → stock.{read,write}, dsd_stock.{read,write}, sdp_stock.{read,write},
              transfer.{read,write}, dispense_log.{read,write}, intake_log.{read,write},
              adjustment_log.{read,write}, amc_settings.{read,write},
              commodity.read, facility.read, edit_history.{read,write},
              report.read, activity.read, bincard.read
scope        → own facility only (facilityId === s.facilityId), plus the counterparty
              facility of any pending transfer on `stock.read`
section       → pinned to account's commodity_section (pharmacy | lab | null = both)
```
`facility_role` (`dispenser` / `store_manager` / `sdp` / `dsd`) carries **zero backend
authorization effect** — verified by direct code reading (no route or guard reads it) and by the
existing `authorizationBaseline.test.js` suite's explicit assertion that all four values produce
identical write verdicts. It is a frontend page-set selector only.

### `state_admin`
```
permissions → same full set as facility, PLUS cross-facility write on:
              stock, dsd_stock, sdp_stock, amc_settings, transfer (WRITE_ADMIN_LEVELS)
scope        → own state (adminState), via narrowedAdminFacilityIds
section       → none — sees both pharmacy and lab (attachScope: bothSections includes
              state_admin explicitly)
```
`dispense_log` / `intake_log` / `adjustment_log` writes stay **own-facility only even for
`state_admin`** — `WRITE_ADMIN_LEVELS` maps all three to `[]`. An admin isn't the one physically
dispensing or receiving stock. `state_admin` has no `facilityId`, so in practice it cannot write
these logs at all.

### `state_viewer`
```
permissions → every *.read permission facility/state_admin has; NO writes anywhere
              (absent from WRITE_ADMIN_LEVELS on every table)
scope        → own state (adminState)
section       → none — sees both (attachScope explicitly includes it in bothSections... )
```
Correction while writing this: re-checked `attachScope` — `bothSections` only lists
`overall_admin` and `state_admin` explicitly. `state_viewer` falls through to the section-pinned
branch **unless its account has no `commodity_section` set**, in which case it fails open to both
(Section 8). Documenting the code exactly as it behaves, not as summarized.

### `cluster_admin`
```
permissions → every *.read permission; NO writes anywhere
scope        → own cluster (adminCluster) — includes `stock` (a 2026-07 redesign explicitly
              added cluster_admin to stock reads; see scope.js:27-30 comment)
section       → pinned to account's commodity_section, same as facility
```

### `lga_admin`
```
permissions → every *.read permission; NO writes anywhere
scope        → own LGA (adminLga)
section       → pinned to account's commodity_section, same as facility
```

### `overall_admin` (or `is_admin: true` — see Section 8, this flag is dead in production data)
```
permissions → every *.read permission on every resource; NO writes ANYWHERE
scope        → unconstrained (all facilities, national)
section       → none — sees both
```
**Deliberate design decision, not a gap:** `isWriteAdmin` does not short-circuit on `isAdmin`.
The code comment at `scope.js:150-152` states this explicitly — there is no in-app super-writer;
emergency cross-state fixes go through the database directly. A future permission seeding that
grants the admin role every permission indiscriminately would silently break this and must not
do so.

---

## 4. Scope mapping

Explicitly **not** permissions. These are the dimensions a permission's grant is filtered by.

| Scope dimension | Values | Applies to |
|---|---|---|
| Facility | own facility id | every `facility`-tier permission |
| State | `adminState` → narrowed facility id set | `state_admin`, `state_viewer` |
| Cluster | `adminCluster` → narrowed facility id set | `cluster_admin` |
| LGA | `adminLga` → narrowed facility id set | `lga_admin` |
| National (unconstrained) | `null` = no filter | `overall_admin`; also any narrowed tier whose narrowing field is unset (Section 8) |
| Section / category | `commodity_section` → `SECTION_CATEGORIES` list, or the hub-store override, or an unrestricted `null` | every resource whose rows carry a `category` |
| Transfer-partner | sending or receiving `facility_id` of *that specific transfer row* | `transfer.read`, `transfer.write` only — not a general facility scope |
| Pending-transfer counterparty | facilities with an in-flight `pending` transfer against the caller's facility | `stock.read` only, as an addition on top of "own facility" |

**`dsd_stock` and `sdp_stock` are separate resources with their own permissions, not a scope
refinement of `stock`.** They are distinct database tables with their own entries in
`READ_ADMIN_LEVELS` / `WRITE_ADMIN_LEVELS`. This is a deliberate distinction the catalogue
preserves rather than collapsing.

**Department/section is scope, not permission** — as the task instructions require this be
stated explicitly: `commodity_section` (`pharmacy` | `lab`) filters *which commodity categories*
a granted permission's rows may touch. It never determines *whether* the permission exists.
A pharmacy-pinned facility user and a lab-pinned facility user hold the **identical** permission
set (`stock.write`, etc.) — only the category filter under `stock.write` differs.

---

## 5. Special actions

Two candidates examined; one warranted, one explicitly rejected.

### `transfer.write` covers ten distinct transitions — deliberately not split further

Every transfer state transition — `dispatch`, `dispatch-batch`, `assign`, `assign-batch`,
`accept`, `dispute`, `cancel`, `approve-internal`, `approve-dsd`, `receive`, plus the generic
metadata `PATCH` and `DELETE` — routes through one shared function, `runTransition`, which calls
**the exact same guard**, `enforceTransferWrite`, with no per-transition variation:

```js
// backend/src/routes/transfers.js:17-29
async function runTransition(req, res, fn, notFoundMsg = '...') {
  const transfer = await TransferService.getTransferById(req.params.id)
  if (!transfer) { ... }
  if (!(await enforceTransferWrite(req, res, transfer))) return   // ← the ONE gate
  const result = await fn()
  ...
}
```

The task's own example (`transfer.accept`, `transfer.authorize`) suggested these might warrant
separate keys. Verified against the actual code: **they do not, today.** There is currently no
backend capability distinction between accepting a transfer and dispatching one — both require
being a party to the transfer or being the in-state `state_admin`. Splitting them now would
invent permissions with no corresponding application behavior, which Step 5 explicitly
prohibits. This is flagged rather than silently decided, because it directly touches the
business goal from the original design review (state can turn *authorization* on/off per
department) — that distinction does not exist in the backend yet. It is future work for the
feature-configuration phase, not this one, and this document records that the ten transitions
currently share one permission so nothing is lost when that decision gets made.

### `system.diagnostics.read` — included, flagged as low priority

Gated by `isAdminScope`, dev-only (`ENVO_DIAG=1`), exposes raw SQL pool diagnostics. A genuine
protected action, but operational rather than a business capability. Included for completeness;
not expected to matter for the ACL rollout.

---

## 6. Known authorization defects

Documented, not fixed — per the stop gate, later phases must address these.

**CURRENT BEHAVIOR:** `enforceFacilityWrite` grants **unconditional** own-facility write for
*any* table string, including one absent from `WRITE_ADMIN_LEVELS` entirely.
```js
// scope.js:228-237
export async function enforceFacilityWrite(req, res, facilityId, table) {
  if (isWriteAdmin(s, table)) { /* admin cross-facility check */ }
  if (facilityId === s.facilityId) return true     // ← no table check at all
  return forbid(res), false
}
```
**FUTURE PHASE REQUIREMENT:** A permission resolver must not inherit this shape. A facility-tier
user's write must be denied for any resource without an explicit permission grant — deny by
default, not allow by omission.

**CURRENT BEHAVIOR:** An admin tier whose narrowing field is unset (`state_admin` with no
`adminState`, etc.) reads/writes **nationally** — `narrowedAdminFacilityIds` returns `null`
(unconstrained) rather than empty.
**FUTURE PHASE REQUIREMENT:** Missing scope data must resolve to *no* access, not *all* access.

**CURRENT BEHAVIOR:** An unrecognized `commodity_section` value fails open to unrestricted
(`categoriesForSection` returns `null` for anything not in `SECTION_CATEGORIES` — this is live
today: 3 real accounts carry `commodity_section: 'tools'`, and see every category).
**FUTURE PHASE REQUIREMENT:** An unrecognized scope value must deny, not fall through to "sees
everything."

**CURRENT BEHAVIOR:** Hub-store detection (`isStateOfficeName` / `isClusterStoreName`) matches
the facility's **name** by regex, not a stable identifier. A facility named to match the pattern
gets the hub category override regardless of its actual `facility_id`; renaming a facility
changes its access.
**FUTURE PHASE REQUIREMENT:** Replace with a real `facilities.facility_type` column (already
recommended in the earlier architecture review — this phase does not implement it).

**CURRENT BEHAVIOR:** `FACILITY_EXTRA_COMMODITIES` hardcodes one facility name
(`'akwa ibom state office store'`) and one commodity grant directly in source.
**FUTURE PHASE REQUIREMENT:** Becomes a data-driven grant (`user_permissions` or an equivalent),
not a source-code edit, once the permission/scope tables exist.

**CURRENT BEHAVIOR:** `edit_history` has **no facility scoping of any kind** — any authenticated
user can read or write any audit-trail row for any facility. The code comment
(`routes/editHistory.js:7-10`) states this was a known, accepted gap even under the prior RLS
model ("Adding facility scoping here would be a new access model; left as a follow-up").
**FUTURE PHASE REQUIREMENT:** Decide whether `edit_history` scope should mirror the scope of the
record it audits (e.g. a dispense-log edit inherits `dispense_log`'s facility scope) — a genuine
design question, not carried over here.

**CURRENT BEHAVIOR:** `is_admin: true` in token metadata promotes to `overall_admin` — but **zero
of 7,568 users in the database set this flag.** It is reachable code with no live path.
**FUTURE PHASE REQUIREMENT:** None strictly required, but a permission seeding pass should not
silently assume this flag matters; verify against real data before seeding, as this document did.

---

## 7. Explicit exclusions

Per the task's requirement to state plainly what is *not* a permission:

- **Facility names, state names, LGA names, cluster names** — always scope identifiers, never
  permission keys. (Compare the current `isHubStoreName` defect above, which is exactly a
  facility *name* incorrectly deciding an access outcome — the future model must not repeat
  that shape at the permission layer either.)
- **Commodity categories** (`Pharmacy drugs`, `RTKs`, `Lab consumables`, …) — scope filters under
  a resource permission, never permissions themselves.
- **`commodity_section` (department/section: pharmacy, lab)** — scope, as stated in Section 4.
  Confirmed by direct evidence: differently-sectioned facility users hold identical permission
  sets.
- **Role names** (`facility`, `state_admin`, `overall_admin`, …) — a role is a bundle of
  permissions assigned to a user; the permission layer must never reference a role name in a
  business rule. (`scope.js`'s current `READ_ADMIN_LEVELS` / `WRITE_ADMIN_LEVELS` do exactly
  this today — role-string arrays — which is the pattern Phase 2B replaces.)
- **`facility_role`** (`dispenser`, `store_manager`, `sdp`, `dsd`) — not a permission and not
  currently even a role in the backend sense; a UI-only workflow selector with zero
  authorization effect (Section 3).
- **User names / user ids** — never appear in a permission key. `FACILITY_EXTRA_COMMODITIES`
  keying an exception to a facility name (not a user) is the closest existing analogue, and it
  is cited in Section 6 as a defect to correct, not a pattern to continue.
- **UI page names** (`Catalogue`, `Dashboard`, `Transfers`, …) — the catalogue is keyed to
  backend-protected actions only. Frontend page-routing concerns (e.g. `commodity_section:
  'tools'` selecting a page set) are out of scope for this document.

---

## Files changed

```
docs/authorization/permission-catalogue.md   (new — this file)
```

Nothing else. No source file, migration, test, or configuration was modified to produce this
document.

## Tests

`main`'s own suite, run in this branch's worktree before writing anything:

```
tests 74
pass  74
fail  0
```

This is the accurate baseline for `user-permissions` (branched from `main`, not `envo-import`).
The 137-passing figure from earlier phases belongs to `envo-import`'s test file set
(`authorizationBaseline.test.js` + `identityFoundation.test.js`, 42 + 21 tests, layered on
`envo-import`'s original 74 shared tests... actually 116, see note below), which have not been
brought onto this branch. This phase adds no test and modifies none; 74/0 is unchanged by it.

*(Minor note for the record: `envo-import`'s original suite was 116, not 74 — it carries seven
additional Tools-related and other test files absent from `main`. The 74 here is `main`'s own,
smaller, original set. Both are internally consistent; they are simply different branches'
baselines.)*

## Safety confirmation

- ✅ No database changes — read-only queries only (`information_schema`, code inspection)
- ✅ No users changed
- ✅ No passwords changed
- ✅ No authentication changes
- ✅ No authorization behavior changes — `scope.js` not modified
- ✅ No stock changes
- ✅ No commodity changes
- ✅ No Essential Commodities changes (not present on `main` in any case)
- ✅ No Tools changes (not present on `main` in any case)
- ✅ No frontend changes
- ✅ No roles, permissions, or resolver tables created
- ✅ `backend/.env` was copied into this worktree from the existing checkout to run the test
  suite (a gitignored config file, identical across checkouts, containing no code) — the only
  filesystem change outside the one documentation file

## Stop gate

Stopped here as instructed. No permissions table, roles table, `role_permissions`,
`user_roles`, `user_permissions`, resolver, authorization cutover, or frontend permission check
has been created. This document is for review before Phase 2B (schema).
