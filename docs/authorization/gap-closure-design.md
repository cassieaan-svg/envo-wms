# Gap Closure Design — closing every open question in the ACL migration

Status: **design proposal. Nothing here is implemented.**

Companion to `permission-catalogue.md` (Phase 2A) and `shadow-comparison.md` (Phase 2E).
This document takes every open gap, question, and deferred decision accumulated across
Phases 1C–2E and proposes a concrete resolution for each — or, where the decision is not
mine to make, states exactly what is needed and from whom.

Each item is marked:
- **CLOSED BY DESIGN** — resolution proposed here, implementable once approved
- **NEEDS A DECISION** — requires a call that only the team can make
- **NEEDS VERIFICATION** — a factual question with a defined method to answer it

---

## Part 1 — The scope model is the root cause of three separate gaps

Three of the outstanding gaps look unrelated but share one cause: `user_roles` carries
**exactly one** `(scope_type, scope_id)` pair per assignment, so it can express *one*
dimension of scope and nothing else.

Real access is **multi-dimensional**:

| Who | Geographic dimension | Commodity dimension |
|---|---|---|
| Facility pharmacy user | facility X | section `pharmacy` |
| Akwa Ibom State Office Store | facility Y | `Lab consumables` + `General Consumables` **plus the single commodity `Alere Determine`** |
| `state_admin` | state S | *(unconstrained — sees both sections)* |
| `overall_admin` | *(unconstrained)* | *(unconstrained)* |

The current single-pair model can hold the left column only. That is why commodity-section
scope is absent entirely, and why the individual-commodity grant has nowhere to live.

### Proposed: scope becomes a set, with dimensions

Replace the single pair with a scope table:

```sql
user_role_scopes (
  user_id     uuid    not null,
  role_id     uuid    not null,
  dimension   text    not null,   -- 'geography' | 'commodity'
  scope_type  text    not null,   -- geography: facility|state|cluster|lga
                                  -- commodity: section|category|commodity
  scope_id    text    not null,
  primary key (user_id, role_id, dimension, scope_type, scope_id)
)
```

**Resolution rule — the whole model in three lines:**
- Within a dimension, rows are **OR**ed (any match satisfies that dimension)
- Across dimensions, they are **AND**ed (every dimension present must be satisfied)
- A dimension with **no rows** is **unconstrained** on that dimension

That single rule closes three gaps at once:

**Gap: commodity-section scope (Phase 2E follow-up 2) — CLOSED BY DESIGN.**
A pharmacy facility user gets `geography/facility/X` + `commodity/section/pharmacy`. The
hub-store override becomes ordinary rows: `commodity/category/Lab consumables` +
`commodity/category/General Consumables`, replacing the section row rather than being a
name-regex special case in code.

**Gap: individual commodity grants (`FACILITY_EXTRA_COMMODITIES`) — CLOSED BY DESIGN.**
Akwa Ibom's `Alere Determine` grant is simply one more OR row in the commodity dimension:
`commodity/commodity/<alere-determine-id>`. No new concept, no permission-key abuse, and
crucially **no facility name hardcoded in source** — which retires that defect too.

**Gap: hub-store detection by facility name — CLOSED BY DESIGN (consequentially).**
Once the hub's commodity scope is data, `isStateOfficeName()` / `isClusterStoreName()` no
longer decide access. Renaming a facility stops changing its permissions. (The separate
`facilities.facility_type` column remains worth adding for other reasons, but is no longer
load-bearing for authorization.)

### Migration path for the scope change

`user_roles` already holds 7,567 rows. This is additive and reversible:

1. Create `user_role_scopes`; leave `user_roles.scope_type`/`scope_id` in place, untouched.
2. Backfill `geography` rows from the existing pair (1:1, no interpretation needed).
3. Backfill `commodity` rows from each user's `raw_user_meta_data.commodity_section`, plus
   the hub-store and `FACILITY_EXTRA_COMMODITIES` cases — all currently derivable from code
   constants that would be read once and turned into data.
4. Resolver reads the new table; shadow-compare as in Phase 2E before anything cuts over.
5. Drop the old columns only after cutover proves stable.

---

## Part 2 — The remaining Phase 2E follow-ups

### Cross-facility write distinction (follow-up 3) — CLOSED BY DESIGN

`state_admin` holds `stock.write` state-wide but `dispense_log.write` own-facility-only.
`role_permissions` cannot express that; the resolver currently mirrors it with the
`CROSS_FACILITY_WRITE_PERMISSIONS` constant.

**Proposal — one nullable column:**

```sql
alter table role_permissions add column scope_mode text not null default 'inherit';
  -- 'inherit'          : use the role assignment's own scope (current default behavior)
  -- 'own_facility_only': ignore wider geographic scope; require the actor's own facility
```

`state_admin`'s `dispense_log.write` / `intake_log.write` / `adjustment_log.write` rows get
`own_facility_only`; everything else stays `inherit`. The rule moves from a code constant
into the data, where it can be configured — which is the entire point of the project.

### Pending-transfer counterparty (follow-up 1) — NEEDS VERIFICATION

Legacy lets a facility read a counterparty facility's stock while a transfer between them is
`pending`. Two facts make this look **vestigial rather than load-bearing**:

- Its own comment says it was ported from a Supabase RLS `stock_select` sub-select — i.e.
  carried over for fidelity during the Supabase migration, not written for a feature.
- I could find no frontend code that reads counterparty stock. Every `stock_balance` usage in
  the transfer pages reads the caller's *own* facility.

**Method to settle it:** instrument `pendingTransferCounterparties()` to log when it actually
widens a decision (i.e. when the counterparty branch is the *only* reason a read was allowed),
run for one reporting cycle, and count. Zero hits over a full cycle means it can be dropped at
cutover with no user-visible change. Non-zero means we model it as a derived scope.

**Do not remove it on the strength of the two facts above alone** — "I couldn't find a caller"
is weaker evidence than a measurement.

### Unmapped-table fail-open (follow-up 4) — CLOSED BY DESIGN

`enforceFacilityWrite` grants own-facility write for *any* table string, including undeclared
ones. The ACL model is deny-by-default, so **cutover closes this automatically**. No separate
fix is required, and none should be attempted in the resolver.

Optional hardening before cutover: make legacy's `enforceFacilityWrite` reject a table not in
`READ_ADMIN_LEVELS`/`WRITE_ADMIN_LEVELS`. Low risk (every real call site passes a known
string), but it *is* a legacy behavior change and needs its own approval.

---

## Part 3 — Transfer workflow

### `transfer.write` split — CLOSED BY DESIGN (agreed in discussion)

| Key | Actions | Held by |
|---|---|---|
| `transfer.create` | `POST /` — facility submits a request | facility, state_admin |
| `transfer.assign` | assign, assign-batch — **admin picks the source facility** | **state_admin only** |
| `transfer.dispatch` | dispatch, dispatch-batch — assigned facility arranges & sends | facility, state_admin |
| `transfer.confirm_receipt` | accept, dispute, receive | facility, state_admin |
| `transfer.distribute_internal` | approve-internal, approve-dsd | facility, state_admin |
| `transfer.manage` | cancel, update, delete | facility, state_admin |

`transfer.read` unchanged. Catalogue **24 → 29**.

Matches the workflow the app has always had, confirmed in the frontend's own copy: *"Request
submitted — awaiting admin assignment"* → *"Admin will review and assign a source facility"* →
*"Requests the admin assigned this facility to dispatch as the source"* → receiver accepts.

Withholding `transfer.assign` from `facility` is the one tightening: today a facility could
call assign via the API, though the UI never offers it.

### Direct-push creation path — NEEDS A DECISION

The backend still accepts a transfer created with `sending_facility_id` set by the caller — a
direct facility-to-facility push. The frontend form for this is **hard-disabled**:

```jsx
{/* Send form intentionally disabled: this module is view/print only and must
    NOT be used to perform transfers. */}
{false && ( … <form onSubmit={sendTransfer}> … )}
```

So the API permits something the product deliberately forbids. **Recommended:** add
creation-time validation — a facility may set `receiving_facility_id` only; `sending_facility_id`
is settable solely via `transfer.assign`. This is a legacy behavior change (small, and it only
closes a path nothing legitimately uses), so it needs an explicit yes.

---

## Part 4 — Process and sequencing

### Cutover criteria — PROPOSED, NEEDS A DECISION

No definition currently exists for when the resolver becomes authoritative. Proposed gates,
all of which must hold:

1. **Every shadow mismatch is classified and either resolved or explicitly accepted** — with
   an owner's sign-off on each accepted behavior change.
2. **Shadow mode runs in production for one full reporting cycle** with zero *unexplained*
   mismatches. (Shadow mode has never run against production data — see below.)
3. **Scope model v2 shipped and backfilled**, since three known gaps cannot close without it.
4. **A rollback path exists** — a single flag returning authorization to legacy without a
   deploy, tested before cutover, not after.
5. **The counterparty measurement (Part 2) has a result**, so cutover isn't silently removing
   an access path someone depends on.

### Phase sequencing — PROPOSED

```
2F  transfer.write split                   (designed, ready)
2G  scope model v2 + backfill              (closes 3 gaps; largest piece)
2H  role_permissions.scope_mode            (small, closes follow-up 3)
2I  counterparty measurement               (runs in parallel; informs cutover)
2J  production shadow deployment           (first time any of this touches prod)
2K  cutover, behind a rollback flag
```

Deliberately *not* in this list: feature configuration, notifications, item unification, and
`facilities.facility_type`. Those are the original architecture's later phases and shouldn't
be interleaved with finishing authorization.

### Production timeline — NEEDS A DECISION

**Every ACL migration so far has run only on the local dev database.** Production has zero rows
in all five ACL tables. Nothing is broken by this — nothing reads them — but it means:

- The shadow comparison has **never run against production data or production user metadata**.
- Local data is known to differ from production (Tools tables and Essential Commodities columns
  exist locally and not in production; local also carries an `hq_tools` account production may
  not have).

Somebody needs to decide when Phases 2B–2E's migrations get applied to production, and who
applies them (migrations never auto-run here; they're applied by hand on the VM).

---

## Part 5 — Smaller open items

| Item | Status | Proposal |
|---|---|---|
| **Naming: category / department / unit / section** | NEEDS A DECISION | Deferred by the team from the outset. Part 1's scope model uses `dimension='commodity'` with `scope_type` of `section`/`category`/`commodity`, so the *user-facing* label can be chosen later without a schema change. |
| **`hq_tools` account (1 user)** | NEEDS A DECISION | Correctly excluded from Phase 2D — has no ACL role. If Tools ever merges to `main`, it needs a real role; until then it is a dormant account with no ACL identity. Decide: assign a role, deactivate, or leave. |
| **`cassieaan@gmail.com` (facility role, no facility_id)** | NEEDS A DECISION | Migrated faithfully with empty scope — can access nothing, matching today. Likely a dormant personal/test account. Decide: deactivate or assign a facility. |
| **`facilities.facility_type` column** | Downgraded | Was a prerequisite for retiring the hub-store name regex; Part 1 retires that regex by other means. Still worth adding for clarity, no longer blocking. |
| **`tools/*.jsx` stash on `envo-import`** | NEEDS A DECISION | Unrelated to ACL — 32 modified files parked in a stash from earlier session work. Decide whether to restore, commit, or discard. |

---

## Summary

| Gap | Resolution |
|---|---|
| `transfer.write` too coarse | **Closed by design** — 6 keys (Part 3) |
| Commodity-section scope absent | **Closed by design** — scope dimensions (Part 1) |
| Individual commodity grants unrepresentable | **Closed by design** — same mechanism (Part 1) |
| Hub-store detection by facility name | **Closed by design** — consequence of Part 1 |
| Cross-facility write distinction | **Closed by design** — `scope_mode` column (Part 2) |
| Unmapped-table fail-open | **Closed by design** — cutover closes it inherently (Part 2) |
| Pending-transfer counterparty | **Needs verification** — measure before removing (Part 2) |
| Direct-push creation path | **Needs a decision** — recommended to close (Part 3) |
| Cutover criteria | **Proposed** — five gates (Part 4) |
| Phase sequencing | **Proposed** — 2F→2K (Part 4) |
| Production timeline | **Needs a decision** (Part 4) |
| Naming | **Needs a decision** — but no longer blocking (Part 5) |
| Orphan accounts, tools stash | **Need decisions** — all minor (Part 5) |

Six of thirteen close purely on design approval. One needs a measurement. Six need a decision
from the team, of which only the production timeline is on the critical path.
