# Two-machine commissioning procedure

The single-machine drill (`npm run commission`) proves the logic: envelopes, idempotency,
ordering, offline dispatch, restart, backup and restore. What it cannot prove is anything
about a real network, because `kill`ing a process is a *clean* failure and a warehouse's
internet does not fail cleanly.

This is the procedure for the first real two-machine test. **Nothing below has been performed
yet** — it is written to be followed, not reported as done.

```
   MACHINE A — Cloud WMS            MACHINE B — CMS Local WMS
   role: cloud                      role: cms
   reachable over the internet      warehouse LAN + internet
            ▲                                ▲
            └────────── internet ────────────┘
                                             │  LAN / Wi-Fi
                                             ▼
                                    Warehouse device (browser)
```

## Before the day

**Machine A (Cloud)**

```
WMS_ROLE=cloud
WMS_ORIGIN=cloud
WMS_INSTANCE_ID=cloud-vm
PGDATABASE=<cloud database>
SYNC_TOKEN=<generate; NOT the EnVo SERVICE_TOKEN>
ENVO_API_URL=<EnVo origin>
SERVICE_TOKEN=<EnVo shared secret>
```

**Machine B (CMS)**

```
WMS_ROLE=cms
WMS_ORIGIN=cms
WMS_INSTANCE_ID=cms-uyo
PGDATABASE=<cms database>
CLOUD_API_URL=https://<machine A>
SYNC_TOKEN=<same as Machine A>
# ENVO_API_URL deliberately unset — CMS must not be able to reach EnVo
BACKUP_DIR=<second physical disk>
```

1. `npm run migrate` on both.
2. On Machine B only, once, before any stock is received:
   `npm run init-cms` (dry run), then `node scripts/initCmsInstance.mjs --commit`.
   It refuses if the database already holds transactions, or if Cloud has grown past the
   1,000,000 floor. **If it refuses, stop and resolve that first** — do not force it.
3. Bind CMS to the LAN interface, not localhost, and give it a fixed IP or reservation.
4. Confirm a warehouse device can reach `http://<machine B>:5100` over Wi-Fi.
5. Leave `SYNC_WORKER` on (the default) so sync runs in the background.

## The test

### Stage 1 — online
- Raise a request in EnVo. Confirm it reaches Cloud, then CMS (`GET /api/requests` on B).
- Dispatch something from the warehouse device. Confirm it appears on Cloud within a tick.
- Check `GET /api/sync/status` on B: pending should return to zero.

### Stage 2 — internet off, LAN up
**Disconnect Machine B's internet only.** Do not disable its network adapter — pull the WAN,
or block outbound to Machine A at the router. The Wi-Fi the devices use must stay up.

- The warehouse device must still reach CMS. *(If it cannot, the LAN binding is wrong.)*
- Fulfil the request synced in Stage 1.
- Create a new direct dispatch with no EnVo request behind it.
- Receive a delivery; make an adjustment.
- Print the waybill. Print it again — it must say REPRINT #1.
- Confirm stock changed and `GET /api/sync/status` shows transactions held, not lost.
- Restart the CMS machine entirely. Confirm both services come back and nothing is lost.

### Stage 3 — internet restored
- Watch the sync worker drain, or press sync in the UI.
- On Cloud: transaction count matches, uids match, `origin=cms`, no duplicates.
- Request status reaches EnVo. The direct dispatch does **not** appear as an EnVo request.
- Run `npm run reconcile` on both. CMS must be clean; Cloud may differ on pre-sync history.

## What this stage tests that the single-machine drill cannot

- Real latency, packet loss, and **half-open connections** — a link that degrades rather than
  dies is where timeout handling actually gets tested.
- Warehouse Wi-Fi reaching CMS while CMS cannot reach the internet — the real topology.
- TLS on the CMS→Cloud link.
- **Clock skew between machines.** Timestamps come from each instance's own clock; two
  machines will not agree exactly.
- An unclean power loss, and a genuine `pg_restore` on the machine that failed.
- A real printer.

## Physical printing — NOT YET TESTED

The drill proves the document renders offline with its lines and lots, and that reprints are
numbered. Still to check with hardware:

- printing to a LAN printer with no internet present
- quantities and lot numbers correct on paper
- paper size and margins on the real waybill stock
- the REPRINT label visible where a storekeeper will actually look

## Rollback

CMS is not yet the stock authority: `CLOUD_STOCK_AUTHORITY` stays `true` on Cloud until the
warehouse has run on CMS successfully. Until that flag is flipped, abandoning the test means
stopping Machine B — Cloud continues as it does today.
