# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- `PATCH /api/transfers/:id/dispatch` now accepts an optional `lots` payload.
  - Clients may supply `lots` (array of `{ batch, quantity }`) to explicitly select batches for fulfilling a transfer.
  - The server validates `lots` sum matches the requested `quantity`, enforces batch-level availability/expiry, and performs the dispatch atomically.

### Tests

- Integration test for explicit-lots dispatch (50 + 150 → 200).
- Unit tests for `LotService.debit` enforcement and shortfall behaviour.

### Notes

- Supplying explicit `lots` causes the server to call `LotService.debit` with `enforce: true` for each batch, returning HTTP 409 on insufficient batch quantities.
