// Regression: PriceService.setCurrentPrice previously enqueued a 'commodity_price' outbox
// callback unconditionally. On a CMS instance that callback can never be delivered — CMS has
// no ENVO_API_URL by design (the same failure already found and fixed for RequestService's
// status callbacks) — so it retried forever. Fixed by gating the enqueue on IS_CLOUD, exactly
// like every other EnVo-callback enqueue in the codebase.

import test from 'node:test';
import assert from 'node:assert/strict';
import pool, { query } from '../src/db.js';
import { PriceService } from '../src/services/priceService.js';
import { makeCommodity, cleanup } from './helpers.js';

test.after(async () => { await pool.end(); });

async function outboxCountForCommodity(commodityId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM outbox
      WHERE kind = 'commodity_price' AND payload->>'wmsCommodityId' = $1`,
    [String(commodityId)]
  );
  return rows[0].n;
}

test('setCurrentPrice enqueues no outbox callback when this process is not Cloud', async () => {
  const commodity = await makeCommodity();
  try {
    // The test suite's guard.mjs / server default runs as WMS_ROLE=cloud unless overridden;
    // this asserts the behavior directly against IS_CLOUD rather than assuming the env, so
    // it is meaningful under either role the suite is run with.
    const { IS_CLOUD } = await import('../src/lib/role.js');

    await PriceService.setCurrentPrice(commodity.id, { unitPrice: 25, createdBy: 'Test' });

    const n = await outboxCountForCommodity(commodity.id);
    if (IS_CLOUD) {
      assert.equal(n, 1, 'Cloud still pushes the price to EnVo through the outbox');
    } else {
      assert.equal(n, 0, 'CMS must not enqueue a callback it can never deliver');
    }
  } finally {
    await query('DELETE FROM outbox WHERE kind = $1 AND payload->>$2 = $3',
      ['commodity_price', 'wmsCommodityId', String(commodity.id)]);
    await cleanup({ commodityIds: [commodity.id] });
  }
});

test('setCurrentPrice still writes the price row and preserves history regardless of role', async () => {
  const commodity = await makeCommodity();
  try {
    const first = await PriceService.setCurrentPrice(commodity.id, { unitPrice: 10, createdBy: 'Test' });
    const second = await PriceService.setCurrentPrice(commodity.id, { unitPrice: 12, createdBy: 'Test' });

    assert.equal(Number(second.unit_price), 12);

    const history = await PriceService.history(commodity.id);
    assert.equal(history.length, 2, 'the old price row survives, not overwritten');
    const current = history.find((h) => h.is_current);
    assert.equal(current.id, second.id);
    assert.equal(history.find((h) => h.id === first.id).is_current, false);
  } finally {
    await query('DELETE FROM outbox WHERE kind = $1 AND payload->>$2 = $3',
      ['commodity_price', 'wmsCommodityId', String(commodity.id)]);
    await cleanup({ commodityIds: [commodity.id] });
  }
});
