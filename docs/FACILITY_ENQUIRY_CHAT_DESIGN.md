# Facility ↔ Warehouse Enquiry System — Design

Status: **design captured, not yet implemented.** This is the write-up of a brainstorm
session; nothing described here has been built. It's recorded now so the decisions already
made don't have to be re-derived when implementation starts.

## Why this isn't "chat"

The obvious framing — real-time chat between a facility and the warehouse — doesn't fit this
system. The warehouse (CMS) can be offline for hours or days by design, and the essential
commodities module is being built the same way. Real-time messaging assumes both ends are
reachable *now*; that assumption is false here on purpose. So this is an **honest asynchronous
enquiry system**, not chat — the same trustworthy, store-and-forward model the rest of the WMS
already uses (dispatch, receipt, requests), applied to a new kind of record.

## The three tiers

Not every question needs a person. Sorting enquiries by what the asker actually wants — a
computed fact, or a person's judgment — determines which tier handles it:

| Tier | Handles | Needs a human? | Needs connectivity? |
|---|---|---|---|
| 1. Knowledge base | "How do I use the app" | No | No — synced content, works fully offline once pulled |
| 2. Auto-answered | Price check, stock check, order status | No | Only to fetch the latest synced answer |
| 3. Human thread | Everything else, including all free text | Yes | Only to actually deliver/receive the message |

### Tier 1 — Knowledge base

Static content: `kb_articles (id, title, body, category, updated_at)`. Cloud-authoritative,
synced down to CMS and to the facility's device **exactly like `commodities`/`facilities`
master data already sync** — no new sync mechanism, reuse of the existing one. Once synced, it
needs no connection at all — works on a fully offline device. Search starts as plain local
keyword matching over title/body; no AI, no third party, nothing that requires connectivity to
function. A smarter search (semantic matching) is a legitimate *online-only enhancement* later,
never the fallback path.

### Tier 2 — Auto-answered enquiries

A **structured** question — pick a category, then supply the specific commodity/quantity/order
— answered instantly from data the system already has. Never inferred from free text; the
asker must explicitly choose this path (see "Free text," below). Three categories:

- **Price check** (facility asks) — looked up from `commodity_prices` (CMS is already the price
  authority). Facility sees the **exact current price**.
- **Stock availability check** (facility asks) — the facility submits a **quantity it needs**,
  not just a commodity. The system compares that quantity against Cloud's mirrored on-hand
  balance (`SyncService.mirrorBalances`, already built for reconciliation, reusable here
  unchanged) and returns **only Yes or No** — never the actual on-hand figure. This is a
  deliberate privacy rule: **facilities never see warehouse stock levels**, under any
  circumstance, in any tier. Useful side effect: this becomes a legitimate "should I even
  bother requesting" pre-check before a facility raises a real request.
- **Order status check** (facility asks) — looked up from `requests.status` /
  `request_status_events`, which **already syncs to Cloud today** for EnVo's own callback
  purposes. Zero new sync work for this one. Facility sees the **exact current status**.

Every auto-answer is still logged — Tier 2 is not separate infrastructure from Tier 3, it's the
**same** `enquiries`/`enquiry_messages` tables, just with the system as the responder and the
thread auto-closed the instant it's answered. `enquiries.answered_by` is either `'system'` or a
real user id. One data model, one place to look for everything a facility (or the warehouse)
ever asked, whether a person touched it or not.

### Tier 3 — Human threads

Everything else: free text, and the warehouse-initiated "why do you still have this much and
you're requesting more" category.

**Why "why still requesting" is always Tier 3, not a data question**: the warehouse already has
the facility's on-hand figure in front of it (the existing `facility_stock_cache`/EnVo stock
proxy) — it's not missing data, it wants a **person's explanation**. That's the actual dividing
line between tiers: not "does the system have the data" but "does the asker want a computed
fact or a person's judgment." This category is fixed as warehouse-initiated, always routes to a
human thread, and **auto-attaches the facility's current on-hand figures as context** so the
warehouse officer doesn't compose a question with no data in front of them. (This is the
existing visibility direction already — warehouse seeing facility stock — not a new exposure;
facilities still never see warehouse stock, per the Tier 2 rule above.)

## Free text — always Tier 3, no exceptions

The realistic default: someone just types instead of picking a category. **Free text always
goes to a human.** No attempt to classify or auto-answer it — guessing wrong at intent risks
telling a facility "No, insufficient stock" when that's not even what they asked, and that's not
a risk worth taking to save a few seconds.

The one thing layered on top, purely as UX and never as a classification decision: a **local
keyword match** (no AI, no third party, works offline) that notices something like "price" +
a commodity name and offers a clickable suggestion — *"Did you mean: check the price of
Paracetamol 500mg?"* — above the text box. If clicked, that request goes through the Tier 2
structured path (with the asker's explicit confirmation) and can be auto-answered. If ignored,
the free text is sent as-is and becomes a human thread. **The system never auto-answers on its
own guess — only on something the asker actively confirmed.**

## Presence — honest, not fake

Not "is a person sitting there" (meaningless for a shared warehouse terminal) — **"is this
instance currently reachable,"** which this codebase already tracks:

- Warehouse side: `sync_state.last_success_at` — the same signal already driving the amber
  "waiting to reach Cloud" bar.
- Facility side: the same idea, once the offline essential-commodities module exists — it
  reports its own last-sync-to-Cloud timestamp the same way.

A facility opening a Tier 3 thread sees, honestly: *"The warehouse was last online 3 hours ago —
your message will be seen when they reconnect."* No fake typing indicators, no fake "online"
dot — the same honesty principle the rest of this app already applies (the amber bar is not
described as a fault; it's described as "work is being recorded and held").

## Data model (sketch — not yet migrated)

```
enquiries
  id, uid, category (kb | price_check | stock_check | order_status_check |
                      why_still_requesting | free_text),
  facility_id, initiated_by (facility | warehouse), status (open | answered | closed),
  answered_by (user id, or 'system'), context (jsonb — e.g. attached order id,
  attached facility stock snapshot), created_at

enquiry_messages
  id, uid, enquiry_id, sender_type (facility | warehouse | system),
  body, sent_by, origin, source_instance, created_at, synced_at
```

Same shape as `request_status_events` deliberately — `uid` for idempotency, `origin`/
`source_instance` for the identity-stamping discipline already used everywhere records
cross the CMS/Cloud boundary.

## Sync architecture — reuse, not invention

```
facility (EnVo / future offline essential module)
   → enquiry created at Cloud
   → synced DOWN to CMS on the next pull (same MasterDataService/RequestSyncService pattern)
   → warehouse staff reply, entered at CMS — works offline, queued locally
   → synced UP to Cloud via the outbox (same pattern as sync_transaction/sync_price)
   → Cloud delivers it back to the facility
```

**CMS never talks to a facility or to EnVo directly** — that boundary is already a hard rule in
this codebase (`envoClient.js` is only ever called from Cloud-gated code) and there's no reason
to break it here. A new outbox kind (`sync_enquiry_message`) carries the CMS→Cloud leg,
idempotent on `uid`, same envelope-at-send-time and per-thread causality-ordering discipline the
existing outbox drain already enforces.

## Who answers, and how ("getting an agent")

No new staffing concept — the same people already logged into the app, working one more queue,
exactly like Requests already works today:

- **Warehouse side**: an "Enquiries" tab, same list-then-detail pattern as the Requests page.
  No exclusive "claim" — matches how picking/dispatching is already a shared pool, not
  individually assigned. Whoever answers is attributed, same as `dispatched_by`/`picked_by`.
- **Facility side**: the equivalent screen in EnVo (or its future offline module).
- **Offline**: nothing special. A warehouse reply written while CMS is offline queues in the
  outbox like everything else and goes out the moment CMS reconnects — the staff member isn't
  "on call" in any special sense, they're just using the app normally.

**Open question**: should every operational role answer enquiries, or only Picker/Dispatcher
(the role that already interacts with facilities through requests) — the same kind of
role-scoping decision already worked through for the rest of this system.

## Third-party channels — deliberately out of the core design

If facility-side adoption via WhatsApp matters more than in-app usage, WhatsApp Business Cloud
API is the strongest option (near-universal adoption in this context, cheap in Nigeria's pricing
tier) — but it would be **one more entry channel into Tier 3**, not a replacement for anything
above. It has nothing to offer Tier 1 (a knowledge base) or Tier 2 (a data lookup) — those are
pure reads of this system's own content and sync state, and handing them to a third party would
be a pure liability. This is noted here as a later, optional decision, not part of the core
build.

## Open questions still to settle

1. HIV-module scope: does this enquiry system apply to Essential Commodities only, or could it
   extend to the HIV module later — affects whether `enquiries.category`/context stays
   Essential-specific or module-aware from the start.
2. Role scope for who on the warehouse side can answer (see above).
3. Should a warehouse-initiated "why still requesting" enquiry ever fire automatically (a flag
   raised by the system when a request looks like a duplicate of unused stock), or is it always
   a person choosing to ask?
4. Retention/visibility of closed auto-answered enquiries — anyone with access to the log, or
   only admins?

## Not started

No migration, no route, no UI. This document is the reference point for when implementation
begins — audit → design → approval → implementation → verification, the same sequence every
other piece of this project has followed.
