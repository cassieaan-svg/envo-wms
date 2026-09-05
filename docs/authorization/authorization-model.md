# EnVo Authorization Model

Status: **design proposal. No code, schema, or migration accompanies this document.**

Companions: `permission-catalogue.md` (Phase 2A), `shadow-comparison.md` (Phase 2E),
`gap-closure-design.md` (gap analysis). Where that last document already settled a question,
this one consolidates its conclusion rather than re-deriving it.

---

## 1. Executive summary

The project began with one requirement: **turn transfer authorization off for Pharmacy but not
Lab.** Five phases of ACL work later, the system still cannot express it. This document
explains why, and recommends the model that can.

The central finding is a semantic one. *"Pharmacy cannot transfer"* is **not** a statement
about whether Pharmacy staff are trusted to transfer. It is a statement that **the transfer
workflow does not exist for that department**. Those are different claims, they have different
audit meanings, and they belong in different layers.

**Recommendation: a hybrid model.** Permissions remain the capability layer and are the only
thing that ever *grants*. Geographic scope, department scope, feature configuration,
object-level exceptions and relationship rules all only ever *narrow*. Pharmacy vs Lab is
resolved by **feature configuration keyed on facility × department**, deny-only, never
granting.

A consequence worth stating plainly: **the six-key `transfer.write` split is not the answer to
the original requirement.** It remains worth building — it lets a dispenser accept a delivery
without being able to dispatch one — but that is capability granularity, a different problem
from departmental configuration.

---

## 2. Original business requirement

> "If a feature is available in the system and you want to turn it off for a department — for
> example, Pharmacy — you shouldn't have to go through the codebase. It should just be a
> configuration… Even if, in the future, Pharmacy decides to use authorization, they can simply
> turn it on."

Three properties are embedded in that sentence, and they drive the whole design:

1. **Configuration, not code.** An administrator changes it; no deploy.
2. **Reversible.** Off today, on tomorrow, with no migration.
3. **Departmental, not personal.** It applies to Pharmacy — not to a named user, and not to a
   role.

Any model that requires editing role grants, revoking permissions from individuals, or
redeploying to satisfy this requirement has failed it.

---

## 3. Current authorization model

Legacy `scope.js` (still authoritative) decides on two axes:

- **Facility scope** — own facility, or an admin tier narrowed to state / cluster / LGA, or
  unconstrained for `overall_admin`.
- **Section scope** — `commodity_section` (`pharmacy` | `lab`) filtering which commodity
  categories a caller may touch.

The ACL system built in Phases 2B–2E holds 24 permissions, 6 roles, 107 role→permission
mappings, and 7,566 user→role assignments with geographic scope. It reproduces the legacy
decision faithfully in shadow mode (22 of 24 comparisons match; the two mismatches are
deliberate and documented).

---

## 4. What the current ACL model cannot express

| # | Cannot express | Why |
|---|---|---|
| 1 | Pharmacy transfers off, Lab transfers on | Nothing keys a capability to a department |
| 2 | Department/section scope at all | `user_roles` holds one scope pair; geography consumes it |
| 3 | The `Alere Determine` commodity exception | Permissions are resource-level, not object-level |
| 4 | Pending-transfer counterparty stock access | Scope is static; this access is relational |
| 5 | `state_admin` writes stock state-wide but logs only own-facility | `role_permissions` has no per-grant scope qualifier |

Items 2–5 were analysed in `gap-closure-design.md`. Item 1 is the original requirement and is
resolved here.

---

## 5. Permission vs scope vs configuration

Three distinct questions, three distinct layers:

| Layer | Question | Grants? | Owner |
|---|---|---|---|
| **Permission** | *What actions is this user capable of?* | **Yes — the only granting layer** | Engineering (catalogue is code-declared) |
| **Scope** | *Over which records?* | No — narrows only | Provisioning (per user assignment) |
| **Configuration** | *Does this workflow exist here at all?* | No — narrows only | Administrator (runtime, no deploy) |

**One rule governs the whole model: permissions grant; everything else only narrows.**

That single sentence is what keeps the system auditable and prevents configuration from
becoming a privilege-escalation surface. If configuration could grant, then an administrator
toggling a feature could hand someone a capability their role never conferred — and no
permission audit would reveal it.

---

## 6. Department / section scope

### Current terminology (not a recommendation — the observed state)

The concept exists today as `commodity_section`, stored in `users.raw_user_meta_data`, with
values `pharmacy`, `lab`, and — on 3 accounts — `tools`. It is read in `scope.js`
(`attachScope`), mapped to commodity categories via `SECTION_CATEGORIES` in
`constants/sections.js`, mirrored client-side in `utils/session.js` and `utils/helpers.js`, and
used as a page-set selector in `App.jsx`.

The team has explicitly deferred choosing between **category / department / unit / section**.

### Recommendation

Make this a **first-class authorization concept**. It is not a permission (a pharmacy user and
a lab user hold *identical* permission sets — only their category filter differs), and it is
not itself configuration (it describes who the user *is*, not whether a feature is switched
on).

**Where it lives — stated precisely, because department appears in two places for two
different reasons:**

| Use | Layer | Mechanism |
|---|---|---|
| Filtering which commodity records a user may touch | Scope | Enforced *within* the commodity dimension as `scope_type='section'`, resolving to that department's category set (§16) |
| Keying which workflows are switched off where | Configuration | `feature_config` keyed on facility × department (§7) |

Department is therefore **not a third scope dimension**. The dimensions remain **geography**
and **commodity**; department is a granularity within the latter, and independently a
configuration key. This is intentional, and it is why the same word appears in both §7 and §16
without conflict.

On naming: the recommended canonical term is **department**, because that is the word the
business itself used throughout the original requirement, and because *category* is already
taken — `commodities.category` means dosage form (`Injections`, `Syrups & suspensions`). Using
one word for two things guarantees confusion.

**This is a recommendation, not a decision.** The name is deliberately isolated in the proposed
model (one column value, not a table name or a permission-key segment), so it can be changed
later without a schema change.

---

## 7. Pharmacy vs Lab transfer — the deny/disable question

This is the crux, so it is worked through explicitly.

### The two candidate readings

**Reading 1 — deny.** *Pharmacy staff are not permitted to transfer.* Implemented by removing
`transfer.write` from whatever role Pharmacy users hold, or adding a `user_permissions` deny.

**Reading 2 — disable.** *The transfer workflow is switched off for Pharmacy.* Implemented by a
configuration row that suppresses the capability regardless of who holds it.

### Why it is a disable

| | Deny | Disable |
|---|---|---|
| Applies to | Specific users/roles | Everyone in the department, whatever their role |
| Reversal | Re-grant permissions to N users | Flip one row |
| Audit reads as | *"This person was not trusted"* | *"This workflow was off here"* |
| If a new Pharmacy user is provisioned | Must remember to deny them too | Automatically covered |
| Matches the business phrasing | No | Yes — *"this feature is not applicable to the Pharmacy units"* |

The deny reading also fails a practical test. Every Pharmacy user holds the `facility` role, and
so does every Lab user — the same role, distinguished only by `commodity_section`. Denying
transfers to Pharmacy via permissions would require either a new role (`facility_pharmacy`,
which the brief rules out and which multiplies with every future toggle) or ~1,264 individual
`user_permissions` deny rows that must be maintained forever as staff join and leave.

**Conclusion: Pharmacy vs Lab is feature configuration.** Both concepts are nonetheless needed
in the system — deny remains the right mechanism for genuine individual trust decisions
(*"this particular storekeeper may not adjust stock"*), which is what `user_permissions`
already exists for.

### Configuration scope: facility × department

A configuration row is keyed on **(facility, department, feature)**.

Not department alone, because departments are not centrally run — Pharmacy at one facility may
work differently from Pharmacy at another, and the original framing ("your buildings") is
facility-centric.

**Default when absent: enabled.** The table starts empty and every existing workflow must keep
working, so a missing row cannot mean "off". This is not inheritance; it is the direct
consequence of the deny-only rule. It is stated explicitly here because a missing row must
never be read as ambiguous.

**No wildcards or inheritance in the recommended design** — per the constraint that these not
be introduced without demonstrated need.

> **Accepted trade-off, recorded so it is not discovered later.** Disabling a feature for
> Pharmacy across a whole state means one row per facility — roughly 160 rows for Akwa Ibom.
> That is acceptable if disabling is rare and genuinely per-facility, which the requirement
> suggests. If a *statewide* toggle is ever actually requested, the minimal extension is a
> wildcard facility (`facility_id IS NULL` meaning "all facilities in scope") with
> most-specific-wins resolution. Recommended **only if that need materialises** — not built
> speculatively.

---

## 8. Object-level commodity exceptions

`FACILITY_EXTRA_COMMODITIES` grants Akwa Ibom's state office access to one named commodity,
`Alere Determine`, outside its normal category set. It is hardcoded in `constants/sections.js`,
keyed by **facility name string**.

This cannot be a permission — permissions are resource-level (`stock.read`), and adding
`commodity.alere_determine.read` is precisely the catalogue explosion the brief forbids.

**Recommendation: it is scope, not permission.** `gap-closure-design.md` established that scope
must become multi-dimensional to hold department at all; once it is a *set* of rows rather than
a single pair, this exception is simply one more row in the commodity dimension:

```
dimension=commodity, scope_type=commodity, scope_id=<alere-determine-id>
```

No new mechanism, no new entity, and — importantly — **no facility name in source code**,
which retires that defect as a side effect.

The commodity dimension therefore admits three granularities: `section` (a department's whole
category set), `category` (one dosage-form category), and `commodity` (one specific item).
Rows within the dimension are OR-ed, so an exception is additive by construction, which is
exactly the existing semantics.

---

## 9. Relationship-based authorization

Legacy allows a facility to read a counterparty facility's stock **while a transfer between
them is pending**. This is not expressible as static scope: the access depends on the current
state of another table.

Three options:

| Option | Assessment |
|---|---|
| **Model it** as a derived/relationship scope the resolver evaluates at request time | Correct but introduces a whole new evaluation mode for one known case |
| **Accept its removal** at cutover | Simple; changes behavior — needs evidence nobody depends on it |
| **Replace it** with an explicit narrow rule scoped to transfer-related reads only | Middle ground; still special-cased, but bounded and declared |

**Recommendation: measure first, then almost certainly accept removal.** Two facts suggest it
is vestigial: its own comment says it was ported from a Supabase RLS `stock_select` sub-select
(carried over for fidelity, not written for a feature), and no frontend code reads counterparty
stock. But *"I could not find a caller"* is weaker evidence than a measurement, and this is an
access path.

**Method:** instrument `pendingTransferCounterparties()` to log only when it is the *sole*
reason a read was permitted; run one full reporting cycle; count. Zero means remove at cutover
with no user-visible change. Non-zero means model it as a relationship rule, scoped narrowly to
transfer-context reads.

Deliberately **not** recommended: a general-purpose relationship/policy engine. One known case
does not justify one.

---

## 10. Cross-facility write narrowing

`WRITE_ADMIN_LEVELS` grants `state_admin` cross-facility write on `stock`, `dsd_stock`,
`sdp_stock`, `amc_settings` and `transfers` — but never on `dispense_log`, `intake_log` or
`adjustment_log` (an admin is not the person physically dispensing). `role_permissions` cannot
express "this grant, for this role, does not widen across facilities", so the Phase 2E resolver
mirrors it with the `CROSS_FACILITY_WRITE_PERMISSIONS` constant.

**Recommendation: one nullable qualifier on the grant.**

```
role_permissions.scope_mode
  'inherit'           -- use the role assignment's own scope (default, current behavior)
  'own_facility_only' -- ignore wider geographic scope; require the actor's own facility
```

`state_admin`'s three log-write grants take `own_facility_only`; everything else stays
`inherit`. The rule moves from a code constant into data — which is the project's whole
purpose — without adding an entity or a dimension.

The Phase 2E constant stays exactly as it is until that column exists. Per the brief: **do not
remove the workaround in this phase, and do not broaden cross-facility access.**

---

## 11. Legacy fail-open bug

`enforceFacilityWrite` grants a facility user's own-facility write for *any* table string,
including one absent from both level maps — a documented defect.

The ACL model is **deny-by-default**: an undeclared permission key resolves to deny. So
**cutover closes this automatically**, with no separate fix and no reproduction of the bug in
the new resolver.

**Cutover implication:** this is a mismatch that *must remain a mismatch*. The shadow
comparison asserts it stays divergent precisely so nobody "achieves parity" by reintroducing a
fail-open. It is the one case where legacy and ACL disagreeing is the correct outcome.

---

## 12. Model comparison

### Model A — Permission splitting

Split `transfer.write` into per-action keys; potentially department-specific keys.

| | |
|---|---|
| Flexibility | Good for *capability* granularity (accept vs dispatch) |
| Explosion | **Fails.** Department-specific keys mean `transfer.write.pharmacy`, and every future toggle multiplies the catalogue |
| Migration | Moderate — reseed `role_permissions` |
| Auditability | Degrades: permission names start encoding organizational structure |
| **Solves Pharmacy/Lab?** | **No.** Splitting actions does not make any of them departmentally configurable |

### Model B — Permission + scope

Express it as `transfer.write` scoped to `department = lab`.

Scope alone cannot do it. Scope answers *which records*, and it is a property of **the user's
assignment**. To disable Pharmacy transfers you would remove the department from every Pharmacy
user's transfer scope — which is the deny reading again, with all its problems: per-user
maintenance, new joiners uncovered, and an audit trail that misrepresents a configuration
choice as a trust decision.

Scope is necessary — for department filtering of *records* — but insufficient for this.

### Model C — Permission + feature configuration

Role grants `transfer.write`; configuration says Pharmacy at facility X has transfers off.

| | |
|---|---|
| Separation | Clean: *"who is allowed?"* stays in permissions, *"is this workflow on here?"* in config |
| Explosion | None — features are coarse, one row per (facility, department, feature) |
| Reversal | One row |
| Auditability | Strong: a disabled feature reads as configuration, not as distrust |
| **Solves Pharmacy/Lab?** | **Yes** |

Does not by itself address department *record* filtering, object exceptions, or relationship
access.

### Model D — Hybrid

Permissions + geographic scope + department scope + feature configuration + object-level
exception + relationship context.

Tested against the five things the current model cannot express:

| Requirement | Layer that resolves it |
|---|---|
| Pharmacy transfers off | Feature configuration |
| Department record filtering | Department scope |
| `Alere Determine` exception | Object-level scope row (same mechanism as department) |
| Pending-transfer counterparty | Relationship rule — *or removal, pending measurement* |
| Cross-facility write narrowing | `scope_mode` qualifier on the grant |

Each requirement maps to exactly one layer, and no layer is introduced without a requirement
that demands it. Note that "object-level exception" is **not** a separate layer — it is the
scope layer with a finer granularity. The hybrid is therefore four layers, not six.

**Recommended: Model D**, constituted as permissions + multi-dimensional scope + feature
configuration, with relationship rules deferred pending measurement.

---

## 13. Recommended architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  AUTHORIZATION MODEL AT A GLANCE                                     │
└──────────────────────────────────────────────────────────────────────┘

   IDENTITY            who is this?                    users
       │
       ▼
   PERMISSION          what can they do?               role_permissions
   ── the ONLY         "stock.write"                   user_permissions
      granting layer                                   (grant | deny)
       │
       ▼
   SCOPE               over which records?             user_role_scopes
   ── narrows only     geography: facility/state/       (multi-dimensional)
                                 cluster/LGA
                       commodity: section/category/
                                  commodity
       │
       ▼
   CONFIGURATION       does this workflow exist        feature_config
   ── narrows only     here at all?                    (facility × department
      DENY-ONLY        "Pharmacy @ X: transfers off"    × feature)
       │
       ▼
   DECISION            allow only if EVERY layer allows

   deny wins at every layer · absent config = enabled · config never grants
```

---

## 14. Authorization precedence

Precedence only matters where layers can disagree. Because **only permissions grant and
everything else narrows**, the layers cannot conflict in the usual sense — every narrowing
layer has a veto. The evaluation order is therefore chosen for *cost* and *clarity*, not to
resolve contested outcomes.

```
1. Identity                 no user            → DENY
2. Explicit user deny       user_permissions   → DENY   (checked first: deny always wins)
3. Capability               role or user grant → else DENY
4. Feature configuration    disabled here?     → DENY   (cheap, no row scan; fails fast)
5. Geographic scope         facility in scope? → else DENY
6. Department scope         department match?  → else DENY
7. Object-level scope       commodity allowed? → else DENY
8. Relationship rules       contextual access  → may satisfy 5–7, never 2–4
9. ALLOW
```

Three points of substance:

- **Explicit deny precedes everything**, including the capability check. A deny must not depend
  on how the capability was acquired.
- **Feature configuration is evaluated before scope** purely because it is cheaper — a
  disabled feature short-circuits without a facility-membership query.
- **Relationship rules may satisfy scope but never override deny or configuration.** A pending
  transfer can justify reading a counterparty's stock; it can never resurrect a capability the
  user lacks or a feature that is switched off. This is what keeps the relationship layer from
  becoming a backdoor.

---

## 15. Configuration vs authorization — layer ownership

| Question | Permission | Role | Geographic scope | Department scope | Feature config | Object exception |
|---|---|---|---|---|---|---|
| Can user write stock? | **Yes** — `stock.write` | Bundles it | Which facility | Which categories | Could disable | — |
| Can Pharmacy transfer? | Holds `transfer.write` | Bundles it | — | — | **Yes — decides it** | — |
| Can Lab transfer? | Holds `transfer.write` | Bundles it | — | — | **Yes — decides it** | — |
| Can facility access Alere Determine? | `stock.read` | Bundles it | Facility must match | Normally excluded | — | **Yes — decides it** |
| Can facility see pending counterparty stock? | `stock.read` | Bundles it | **Normally denies** | — | — | — (relationship rule, if modeled) |

Read across row 2 and row 3: Pharmacy and Lab are **identical in every column except feature
configuration**. That is the whole argument for this model in one line.

---

## 16. Conceptual data model

Existing, unchanged: `permissions`, `roles`, `role_permissions`, `user_roles`,
`user_permissions`.

### Proposed additions

**`user_role_scopes`** — multi-dimensional scope
- *Purpose*: hold geography **and** commodity scope per assignment; the current single
  `(scope_type, scope_id)` pair on `user_roles` can hold only one dimension
- *Layer*: authorization (scope)
- *Level*: user × role
- *Resolution*: OR within a dimension, AND across dimensions, empty dimension = unconstrained
- *Replaces*: `user_roles.scope_type/scope_id` (kept in place during transition)
- *Also closes*: department scope, the `Alere Determine` exception, and hub-store detection by
  facility name

**`feature_config`** — deny-only workflow toggles
- *Purpose*: express "this workflow does not exist for this department at this facility"
- *Layer*: **configuration, not authorization** — administrator-owned, changeable at runtime
- *Level*: facility × department × feature
- *Semantics*: presence of a disabling row suppresses; absence = enabled; **cannot grant**
- *Relationship to ACL tables*: none structurally — it is consulted alongside them, never
  joined into a permission decision

**`role_permissions.scope_mode`** — a column, not an entity
- *Purpose*: express per-grant scope narrowing (`own_facility_only`)
- *Layer*: authorization

**`departments`** — a reference table, only if needed
- Recommended **only** if departments need attributes beyond a name. Today `pharmacy`/`lab`
  are bare strings and a lookup table would add a join without adding meaning. Defer.

### Deliberately not proposed

No policy engine, no expression language, no JSON policy blobs, no rules table, no dynamic SQL
authorization. The model above is four layers and two new tables, which a small team can hold
in their heads.

---

## 17. Migration implications

**Before cutover:**

- *Model*: `user_role_scopes`, `feature_config`, `scope_mode`
- *Seed*: department scope backfilled from `commodity_section`; hub-store category sets and the
  `Alere Determine` grant converted from code constants into scope rows; `feature_config`
  starts **empty** (everything enabled — matching today)
- *Migrate*: geography scope copied 1:1 from `user_roles`; **no user's effective access may
  change during migration**
- *Test*: shadow comparison extended to cover department scope, object exceptions and feature
  configuration — none of which the current 24-comparison harness exercises

**A gap that must close first:** Phase 2D was a point-in-time backfill. No provisioning script
writes a `user_roles` row, so accounts created since the backfill hold no ACL role — there is
already one. At cutover those users would be denied everything. Either provisioning must assign
roles, or the backfill must become repeatable. **This is a cutover blocker.**

---

## 18. Cutover gates

Measurable, no invented percentages:

1. **Every authorization path the routes actually use is covered** by a shadow comparison —
   enumerated from the route files, not sampled.
2. **Zero unexplained mismatches.** Every mismatch is either resolved or explicitly classified
   and signed off.
3. **Mismatches that must be zero:** any case where ACL would *grant* what legacy *denies*.
   Widening is never acceptable at cutover; narrowing may be, with sign-off.
4. **Mismatches that must remain non-zero:** the unmapped-table fail-open. Parity there would
   mean reproducing a known bug.
5. **Known legacy exceptions explicitly modeled or explicitly accepted as removed** — including
   the counterparty measurement having a result.
6. **Feature configuration, department scope and object exceptions each exercised** by tests
   against real seeded data, not fixtures alone.
7. **Fail-closed verified**: unknown permission, unknown role, missing scope and absent user all
   deny.
8. **Every account has an ACL role**, including those created after the backfill.
9. **Rollback tested before cutover** — a flag returning authorization to legacy without a
   deploy, exercised at least once.
10. **One full reporting cycle of production shadow** with the above holding.

---

## 19. Production strategy (no commands, no execution)

Production currently holds **no ACL data at all**; every migration so far has been
local-development only.

Ordering: schema → seed → backfill → verify → shadow (read-only, logging) → soak one reporting
cycle → cutover behind a flag → monitor → remove legacy only after a stable period.

Verification at each step is a reconciliation count against the legacy representation, not a
spot check. Rollback is the flag, not a migration reversal. If a mismatch appears post-cutover,
the flag returns authority to legacy immediately; the ACL data stays in place for diagnosis
rather than being rolled back.

Local data is known to differ from production (Tools tables, Essential Commodities columns, an
`hq_tools` account), so **shadow results from the dev database do not transfer** — the soak
must happen against production data.

---

## 20. Open decisions requiring approval

| # | Decision | Recommendation |
|---|---|---|
| 1 | Canonical name for the department dimension | **department** — but isolated so it can change cheaply |
| 2 | Wildcard/statewide feature config | **Not now.** Add only if a statewide toggle is actually requested |
| 3 | Counterparty access: model or remove | **Measure, then almost certainly remove** |
| 4 | `departments` reference table | **Defer** — no attributes justify it yet |
| 5 | Which features are configurable | Start with `transfer` only; expand on request |
| 6 | Provisioning assigns roles, or backfill becomes repeatable | Needed before cutover either way |

---

## 21. Recommended next phase

**2G — multi-dimensional scope.** It is the largest piece, it blocks three separate gaps
(department scope, object exceptions, hub-store naming), and feature configuration is
comparatively small once scope can express department at all.

The six-key transfer split is **not** next. It solves capability granularity, not the original
requirement, and sequencing it after scope avoids reworking its seed data twice.
