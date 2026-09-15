# EnVo Essential Commodities — Offline Capability Design

Status: **design only, not implemented.** Builds on
`ESSENTIAL_COMMODITIES_OFFLINE_AUDIT` (the audit conversation) and the decision already
made: **browser-level offline** (a PWA on the facility's device), not a per-facility local
server. No local Postgres per facility, no second CMS-style instance — this is lighter than
the WMS's own offline solution, not a repeat of it.

## The one hard rule

**Raising a request to the warehouse is the only operation that requires connectivity.**
Everything else in the Essential Commodities module — dispense, intake, adjustments,
transfers, bin cards, viewing the catalogue/prices/stock, browsing the knowledge base —
must work with zero connection, on a device that has never talked to the internet that
session.

## What's already there to build on

The audit found this app's *server* already has one working precedent:
`WarehouseRequestService.create()` writes a request `pending` locally first, then submits
to the WMS through a durable, resubmittable outbox — the same discipline as
envo-wms's own outbox. That pattern is the template; it just needs to move one layer
further out, onto the facility's device itself, and needs matching idempotency support
added to the endpoints that don't have it yet (see "Backend changes needed," below).

## Architecture

```
Facility device (PWA, offline-capable)
  - Service worker caches the app shell — loads with zero connection
  - IndexedDB holds: last-synced catalogue/prices/stock snapshot, KB articles,
    a local WRITE QUEUE of everything recorded while offline
  - Every write queued locally is a LEDGER ENTRY (see rule below), never an overwrite
        │
        │  on reconnect: drain the queue
        ▼
Central backend (envo-inventory-tracker's existing Express/Postgres — unchanged location,
no new server)
  - Each write endpoint that becomes offline-queueable gets client-supplied idempotency
    (same INSERT ... ON CONFLICT DO NOTHING claim pattern as WMS's IdempotencyService)
  - A snapshot endpoint serves "everything this facility needs cached" in one pull,
    mirroring MasterDataService.snapshot()
        │
        ▼
envo-wms (via the existing warehouse-request outbox — unchanged, already durable)
```

### The rule every offline-capable write must follow: ledger entries, not overwrites

This is the rule that makes offline safe without a conflict-resolution system. Every
write that can happen offline must be an **additive fact** — "10 units of X were
dispensed at 14:32" — never "set the stock count to 340." Two devices recording two
independent dispense events both apply cleanly, in whatever order they arrive, exactly
like `batch_movements` in the WMS never lets two writers disagree about what happened,
only about the order they're read back in. The moment an offline write becomes "set
field to X" instead of "record that this happened," two devices *can* conflict, and
there's no honest way to resolve that automatically. This isn't a new invention — it's
the same discipline `commodity_batches`/`batch_movements` already enforces in the WMS,
carried over here as a hard constraint on which operations are allowed to be offline in
the first place.

**Transfers are the one case worth flagging explicitly.** A transfer touches two
facilities' stock. It must be modeled as two independent ledger events — a "transfer out"
recorded by the initiating facility, a "transfer in" confirmation recorded separately by
the receiving facility — never one shared record both sides edit. This mirrors how
dispatch (warehouse) and receipt (facility) are already two separately-authored events in
the WMS, not a single record two parties fight over.

## Backend changes needed (not yet built)

1. **Idempotency on every offline-queueable write** — `dispense`, `intake`,
   `adjustments`, `transfers`, `bincard`. Same shape as `IdempotencyService` in the WMS:
   a client-generated id, claimed as the first statement of the transaction, a unique
   index that makes a replay return the original result instead of double-applying.
   This is directly portable logic, not new design — it's the exact mechanism already
   proven twice in this project.
2. **A facility snapshot endpoint** — catalogue, current prices, this facility's current
   stock summary, KB articles, in one response, pulled whenever the device is online.
   Mirrors `MasterDataService.snapshot()`.
3. **Nothing changes about `warehouseRequests`** — it already has its own durability;
   it just stays the one thing that genuinely can't be attempted offline, and the UI
   should say so honestly rather than silently queuing something that can't be queued.

## Frontend changes needed (not yet built)

1. **PWA scaffolding** — service worker + manifest. envo-wms's frontend already has a
   working `vite-plugin-pwa` setup; that's a real starting template, not a green-field
   build.
2. **IndexedDB layer** — a small local store, not a heavy sync framework. Holds the
   cached snapshot (read-only, refreshed on reconnect) and the local write queue
   (pending → syncing → synced/failed, with retry).
3. **A drain loop** — on the `online` browser event and on a periodic timer, walk the
   queue and POST each entry with its idempotency id, mark it synced or leave it queued
   on failure. Same shape as the WMS's outbox worker, just running in the browser instead
   of a Node process.
4. **Honest status UI** — the same amber-bar language the WMS already uses ("work is
   being recorded and held"), applied per-queued-item where useful ("3 entries waiting
   to sync").
5. **Module-aware**: this only applies to the Essential Commodities module. HIV stays
   exactly as it is today — online-only, no queuing, a screen that simply can't load
   without a connection. The two modules already share one app via the `x-envo-module`
   header; the offline layer just needs to check which module is active before deciding
   whether to queue or refuse.

## What stays online-only, deliberately

- **Raising a warehouse request** — the one hard rule, above.
- **The HIV module**, entirely, unless asked to extend later.
- **Reports/oversight screens** for state/LGA/cluster/overall admins — these are review
  tooling, not field operations; no facility depends on them working with no connection,
  and building offline support for them isn't buying anything real.
- **SSE-based live updates** — naturally just don't fire offline; the module falls back
  to the last cached snapshot, which is already the plan for everything else.

## Decisions carried over from the audit (recommended defaults, not yet confirmed)

1. **Device model**: assume a facility may use more than one device, not a single shared
   terminal like the WMS. Each device keeps its own local queue; because every write is
   a ledger entry (see the rule above), multiple devices queuing independently is safe —
   this needs no single-device assumption.
2. **Offline data volume**: cache current catalogue/prices/stock summary and recent
   activity needed to keep working; deep historical reports remain an online-only pull.
   Keeping the offline device's job to "keep operating," not "hold the full archive,"
   matches how the WMS itself treats offline (receiving/adjustments always work; deep
   reporting isn't a blocking dependency).
3. **Conflicts**: mostly don't exist, by construction, because of the ledger-entry rule.
   The one place this needs real care is transfers (addressed above).

## Open questions still needing your decision

1. Confirm the device-model assumption above, or say if it should be single-device-per-
   facility instead (simpler, but a real constraint on how facilities actually work).
2. Should the local write queue have a cap (age or count) before it starts warning the
   user their device needs to get back online, the way the WMS's outbox surfaces "stuck"
   callbacks past a threshold?
3. Does the facility snapshot pull happen automatically in the background whenever
   online, or only on an explicit "sync now" action — same choice the WMS already made
   (both exist there: an automatic worker and a manual button)?
4. Should bin cards and reports get *read-only* offline caching (last-known state,
   clearly labeled stale) even though they're not write-capable offline, or stay
   fully online-only including reads?

## Migration/rollout shape (once approved)

Same sequence as everything else in this project: idempotency support on the backend
first (testable in isolation, no frontend dependency) → snapshot endpoint → PWA
scaffolding → local queue + drain loop → per-screen offline wiring, starting with
whichever operation is highest-value (likely dispense or intake) → full regression
before calling it done.

## Not started

No code, no migration, no PWA config. This document is the reference point for when
implementation begins.
