# Tests

These run against a real PostgreSQL database. The invariants under test — a unique index
resolving a race, `SELECT … FOR UPDATE` stopping two dispatches consuming the same stock, a
transaction rolling back cleanly — are enforced by Postgres, and none of them survive being
mocked. A mocked version of these tests would pass while the real system was broken.

That means the suite **writes and deletes**, so it must never see the warehouse database.

## Running them

```bash
createdb envo_wms_test                        # once
PGDATABASE=envo_wms_test npm run migrate      # once, and after any new migration
PGDATABASE=envo_wms_test npm test
```

## The guard

`test/guard.mjs` is preloaded via `node --import` before any test file, and imported again
by `test/helpers.js`. It refuses to let the suite start unless:

- `PGDATABASE` is set, and its name ends in `_test` (or exactly matches `WMS_TEST_DATABASE`);
- `PGHOST` is this machine, unless `WMS_TEST_ALLOW_REMOTE=1` is set deliberately.

It loads `backend/.env` the same way `src/db.js` does, so it checks the connection the tests
would actually open — a `.env` copied from the VM is caught, not ignored. An explicit
`PGDATABASE=… npm test` still overrides the file, because dotenv never overwrites a variable
that is already set.

There is no flag that switches the guard off. The one occasion it matters is the occasion
someone is in a hurry.

## Conventions

- Every fixture is namespaced with a unique suffix, so parallel runs cannot collide.
- Cleanup runs children-first (movements and transactions before batches, batches before
  commodities) and **reports** a failure rather than swallowing it — a cleanup that quietly
  cannot clean up leaves phantom stock behind in whatever database it touched.
- Assertions check stock quantities, not just row counts. A duplicate that wrote one movement
  but decremented twice would pass a row count and still be the bug worth catching.
