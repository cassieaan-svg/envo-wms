# Warehouse authorization — project record

Status: **closed**. Phase 1 implemented and verified; Phase 2 audited and deliberately
not implemented. This document is the closing note — what exists, why, and why the
project stopped where it did.

## What this replaced

Before this project, WMS authorization was a single binary `users.role` column
(`admin` / `standard`), enforced by one `requireAdmin` middleware applied by hand to a
subset of routes. Several state-changing routes — fulfilling or rejecting a request,
recording a facility receipt, printing a dispatch order — had no role check at all,
reachable by any logged-in user. There was no user-management UI (accounts were seeded
directly in the database), no audit trail of who changed what, and no offline-specific
handling beyond "the local roster doesn't expire during an outage."

## What exists now (Phase 1)

A permission-first model: `permissions → roles → user_roles`, entirely separate from
EnVo's own ACL — WMS has always had its own `users` table and must keep authenticating
and authorizing through a Cloud outage, which a shared, centrally-hosted ACL cannot
promise.

- **33 permissions**, one per real route/service boundary (`batches.adjust`,
  `requests.fulfil`, `facilities.manage`, `roles.assignAny`, …) —
  [migrations/040_authorization.sql](../backend/migrations/040_authorization.sql).
- **Four roles**, each a permission bundle, not a hardcoded identity:
  - **System Administrator** — identity/permission architecture and instance config
    only. Deliberately zero operational permissions.
  - **Warehouse Admin** — full operational authority (batches, requests, dispatch,
    facilities, commodities, vendors, reconciliation, accounts) plus user
    creation/disable and assigning *operational* roles — but not the permission
    architecture itself, and not System Administrator/Warehouse Admin to anyone.
  - **Picker/Dispatcher** — the request/dispatch/fulfilment workflow.
  - **Receiving Clerk** — intake/batch creation.
- **`AuthzService`/`requirePermission`** replace `requireAdmin` everywhere, plus close
  every route that was previously open to any logged-in user.
- **User administration**: `/api/admin/users*` — create/disable/enable, an offline
  emergency lockout (`is_locally_disabled`, local-only, never synced in either
  direction), role grant/revoke split by tier (`roles.assignOperational` vs
  `roles.assignAny`). Self-role-changes are refused unconditionally, even for System
  Administrator.
- **Every** user/role/permission change is attributed in `authz_audit_log`
  (actor + timestamp).
- **Offline model**: Cloud is the sole writer of role assignments; `user_roles` syncs
  down to CMS and is replaced wholesale (not just upserted) so a Cloud-side revocation
  actually takes effect locally. The stale-permission window after a Cloud-side change
  is the same accepted tradeoff already in place for account status. The local
  emergency lockout is the escape hatch for "disable this account right now, offline."
- **Existing accounts migrated on evidence, not assumption**: `cms.admin` →
  Warehouse Admin only (everything it had ever actually done), `cms.viewer` →
  Picker/Dispatcher only (everything *it* had ever actually done, including the four
  previously-unguarded actions). Neither was promoted to System Administrator —
  nothing in either account's history justified it. That role has no holder yet;
  `scripts/createSystemAdministrator.mjs` mints one deliberately, on request, with a
  password chosen at the time.
- **A verification audit found and closed one real gap**: `/api/sync` had been mounted
  a second time behind a plain user login (no permission check at all), reachable by
  any authenticated user — including, on a Cloud instance, a route that serializes
  every user's password hash by design (CMS needs it to authenticate offline). Split
  into `routes/sync.js` (server-to-server protocol, `/sync`, `syncAuth` only) and
  `routes/syncStatus.js` (user-facing status/trigger, `/api/sync`,
  `requirePermission('sync.view'|'sync.forceRun')`). A second verification pass
  confirmed the fix and found nothing further.

Full history: the Phase 1 design and both verification audits are in this session's
transcript; the code is the current source of truth for exact behavior.

## What was deliberately not built (Phase 2)

Phase 2 set out to add a facility/warehouse **scope** dimension on top of the Phase 1
permission model — the natural next axis, by analogy with EnVo's own ACL.

The first Phase 2 pass proposed scoping Picker/Dispatcher and Receiving Clerk by
facility, on the (wrong) assumption that warehouse staff are assigned to particular
facilities. **That assumption was corrected**: Pickers/Dispatchers operate as a
warehouse-wide pool and can process any facility's request or dispatch. A re-audit,
grounded in that correction, then checked the codebase itself for any genuine
per-user ownership or assignment boundary — not just facility — and found none:

- `commodity_batches` (actual stock) carries no facility dimension at all; a
  `facility_id` only ever names *who a transaction was for* (a business entity), never
  a boundary a user's access needs to respect.
- `picked_by`, `dispatched_by`, `created_by` are free-text attribution fields, not
  `user_id` foreign keys — they record who physically did something, for the paper
  trail, and nothing reads them back to gate who may act next.
- `inventory_transactions.actor_user_id` — the one real `REFERENCES users(id)`
  column tied to a workflow action — exists purely for idempotency-replay protection
  (stop user B from fishing for user A's completed transaction by guessing their
  `clientTxnId`), by its own migration's stated intent. It does not, and was never
  meant to, gate ordinary access.
- Request status (`pending → picking → dispatched`) is a shared state machine any
  authorized user can advance; there is no per-user lock or assignment anywhere in it.
- The only dimension the codebase actually partitions by is *instance*
  (`WMS_ROLE`/`WMS_ORIGIN` — Cloud vs. a given CMS deployment), which is a deployment
  concern already fully handled and explicitly out of scope for a *user* authorization
  model.

**Conclusion: no genuine scope dimension exists in this WMS below the instance level.**
Building one — `user_facility_scopes` or otherwise — would have added a control
surface with no workflow behind it: maintenance burden and a place for a future bug
to hide, not a real security improvement. Phase 2 was closed on that finding rather
than implemented. No scope-related schema, service, or route change was made.

## If a scope need appears later

The trigger would be a genuine new workflow, not a re-reading of the current one — a
second physical warehouse (already the correct answer: a new CMS instance, not a
scope value in this one), or a future zone/team staffing model with real assignment
logic behind it. Either warrants its own small audit at the time, grounded in
whatever actually exists then.

## Where to look

- Permission catalogue, roles, seed data: `backend/migrations/040_authorization.sql`,
  `041_extend_sync_view.sql`
- Enforcement: `backend/src/services/authzService.js`,
  `backend/src/middleware/requirePermission.js`
- User/role administration: `backend/src/services/adminUsersService.js`,
  `backend/src/routes/adminUsers.js`
- Offline sync of role assignments: `backend/src/services/masterDataService.js`
- Tests: `backend/test/authorization.test.js`
- System Administrator bootstrap: `backend/scripts/createSystemAdministrator.mjs`
