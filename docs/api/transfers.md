# Transfers API

## PATCH /api/transfers/:id/dispatch

Dispatch a transfer from a sender facility. This endpoint accepts two modes:

- FEFO (default): backend will select lots (first-expiring-first-out) to fulfil the requested quantity.
- Explicit lots: the client supplies a `lots` array to instruct the backend exactly which batches and quantities to draw from.

Request body (FEFO)

- `quantity` (number) — the amount to dispatch. When `lots` is omitted the server will perform FEFO draws.

Request body (Explicit lots)

- `quantity` (number) — total quantity requested by the transfer (required).
- `lots` (array of objects) — optional. Each object must include:
  - `batch` (string|null) — batch identifier (use `null` for no-batch lots).
  - `quantity` (number) — quantity to take from this batch.

Example (explicit lots)

{
  "quantity": 200,
  "lots": [
    { "batch": "A-2026-06", "quantity": 50 },
    { "batch": "B-2026-06", "quantity": 150 }
  ]
}

Server behaviour

- When `lots` is provided the server validates that the sum of `lots[].quantity` equals `quantity` and that each referenced batch has sufficient non-expired quantity.
- For each lot entry the server calls `LotService.debit(..., { batch: <batch>, enforce: true })` which enforces batch-level availability and expiry rules. If any requested batch is insufficient the request fails with HTTP 409 and a descriptive message.
- The dispatch is performed atomically inside a single database transaction: aggregate `stock` and `stock_lot` ledger updates are applied together and `stock_transfer_log` is updated to `in_transit` and its `lots` column stores the supplied `lots` JSON.
- When `lots` is omitted the server falls back to FEFO behaviour and returns `{ drawn, shortfall }` where appropriate.

Responses

- 200 OK — dispatch succeeded. Returns the transfer row including `status: 'in_transit'` and `lots` (drawn lots metadata).
- 400 Bad Request — validation error (e.g. `lots` sum mismatch, malformed body).
- 409 Conflict — insufficient quantity for a specified batch (explicit-lots + `enforce: true`).
- 401/403 — authentication/authorization errors.

Notes

- Clients should always display per-batch remaining quantities before constructing an explicit `lots` payload to avoid 409 responses.
- The endpoint is idempotent only when the caller follows the transfer lifecycle rules; clients should follow the UI flow that locks/marks transfers before repeated dispatch attempts.
