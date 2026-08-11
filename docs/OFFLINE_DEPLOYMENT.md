# Running EnVo Warehouse offline

The Central Medical Store loses its internet connection regularly, and dispatching cannot
stop when that happens. This document describes how the app is deployed so that it doesn't.

## The shape of the solution

**The whole application runs inside the warehouse.** Postgres, the backend and the built
frontend all sit on one PC on the store LAN; staff reach it from their own machines over
that network. Losing the internet cuts the store off from EnVo — it does not cut staff off
from the warehouse system.

This is deliberately *not* a browser-offline PWA. Dispatch allocates stock FEFO under
`SELECT … FOR UPDATE`, which is what stops two people dispatching the same lot at the same
moment. Queueing dispatches in browsers would mean giving that up and reconciling negative
stock by hand afterwards. Keeping one server authoritative keeps the guarantee.

What actually needs the internet is narrow: **only the EnVo integration**. Everything
else — dispatch, picking, batches, alerts, reports, printing — is local and unaffected.

## What happens when the line goes down

| Area | Behaviour offline |
| --- | --- |
| Dispatch, batches, requests, reports, printing | Fully working. No dependency on EnVo. |
| Status callbacks to EnVo | Queued in `outbox` and delivered automatically when the link returns. Nothing is lost. |
| Facility stock lookup (proxied from EnVo) | Serves the last figures fetched, labelled stale with the time they were taken. |
| New facility requests arriving from EnVo | Cannot arrive until the link returns. EnVo's `resubmit` action re-sends anything stuck. |

### The outbox

Every outbound call to EnVo is written to the `outbox` table **in the same transaction as
the change it describes**, so a dispatch that commits can never leave its callback
unqueued. A worker drains the queue every 15 seconds, retrying with exponential backoff
from 30 seconds up to an hour.

There is deliberately **no dead-lettering**: a warehouse can legitimately be offline
overnight, and discarding the callback would leave the facility permanently wrong. Rows are
kept after delivery as the record of what EnVo was told and when.

Staff can see the state of the queue on the Requests page — either "EnVo is up to date" or
a count waiting to reach EnVo, with the age of the oldest item.

### Stale facility stock

`GET /api/facilities/:id/stock` caches each successful response in
`facility_stock_cache`. When EnVo is unreachable it serves the cached payload with
`stale: true` and the time it was fetched, and the modal shows a banner saying so. It only
fails outright if that facility has never been fetched successfully.

## Installing on the store PC

1. **Postgres** on the store PC. Create the `envo_wms` database.
2. **Backend**: copy `backend/.env.example` to `backend/.env` and fill in the database
   credentials, a real `JWT_SECRET`, and `ENVO_API_URL` / `SERVICE_TOKEN` for EnVo.
3. **Migrations**: `node backend/scripts/migrate.mjs`. These do not run automatically.
4. **Frontend**: set `VITE_API_URL` to the store PC's **LAN address** before building —
   see below — then `npm --prefix frontend run build`.
5. Serve `frontend/dist` from the same host and start the backend so both survive a reboot.

### `VITE_API_URL` must be the LAN address

Vite bakes this value in at **build** time. `localhost` resolves to whichever machine the
browser is running on, so a build made with `localhost` works only on the server itself and
fails on every other PC in the store — with no obvious error beyond data never loading.

```
VITE_API_URL=http://192.168.1.50:5100
```

Give the store PC a static LAN IP (or a DHCP reservation) so the address stays put.
Changing this value requires rebuilding the frontend.

### Fonts are self-hosted

DM Sans is bundled from the `@fontsource/dm-sans` package rather than imported from Google
Fonts. A remote font `@import` blocks first paint on a cold cache with no internet, so the
app would appear to hang on the first load of the day. Nothing in the built output requests
an external host.

## Checking it works

Before relying on it, confirm the degradation path end to end:

1. Stop EnVo's backend.
2. Fulfil a request in the WMS. It should dispatch normally, and the callback should sit in
   `outbox` with `delivered_at` null.
3. Open a facility's stock view — it should show the stale banner, not an error.
4. Confirm dispatch, batches and printing are all unaffected.
5. Start EnVo again. Within about 15 seconds the worker should drain the queue, the
   Requests page should report EnVo up to date, and EnVo should reflect the dispatch.
