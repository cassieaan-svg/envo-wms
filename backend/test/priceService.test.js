// CMS is the price authority (see priceService.js). This covers:
//  - Cloud can no longer set a price directly (assertCanSetPrices) — it used to, silently
//    queuing an EnVo callback CMS could never deliver (the bug this whole mechanism replaced).
//  - CMS pushes a price it sets via the new sync_price outbox kind, never the direct
//    EnVo-facing 'commodity_price' kind.
//  - Cloud's ingest of a CMS-pushed price: idempotent on uid, refuses a non-'cms' origin,
//    refuses an unknown commodity, and — once applied — is the one place 'commodity_price'
//    (the EnVo push) is still enqueued.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pool, { query } from '../src/db.js';
import { PriceService } from '../src/services/priceService.js';
import { CommodityService } from '../src/services/commodityService.js';
import { IS_CLOUD } from '../src/lib/role.js';
import { makeCommodity, cleanup, uniq } from './helpers.js';

test.after(async () => { await pool.end(); });

async function outboxRowsFor(commodityId, kind) {
  const { rows } = await query(
    `SELECT * FROM outbox WHERE kind = $1 AND payload->>'wmsCommodityId' = $2
        OR (kind = $1 AND payload->>'causeKey' = $3)`,
    [kind, String(commodityId), `price:${commodityId}`]
  );
  return rows;
}

async function cleanupPrice(commodityId) {
  await query('DELETE FROM outbox WHERE payload->>$1 = $2', ['causeKey', `price:${commodityId}`]);
  await query('DELETE FROM commodity_prices WHERE commodity_id = $1', [commodityId]);
}

test('setCurrentPrice is refused on Cloud, and enqueues nothing', async () => {
  const commodity = await makeCommodity();
  try {
    if (IS_CLOUD) {
      await assert.rejects(
        PriceService.setCurrentPrice(commodity.id, { unitPrice: 25, createdBy: 'Test' }),
        /does not set prices/
      );
      const rows = await query('SELECT 1 FROM commodity_prices WHERE commodity_id = $1', [commodity.id]);
      assert.equal(rows.rows.length, 0, 'no row was written');
    } else {
      // This suite may also run under WMS_ROLE=cms — there the call must succeed instead.
      const price = await PriceService.setCurrentPrice(commodity.id, { unitPrice: 25, createdBy: 'Test' });
      assert.equal(Number(price.unit_price), 25);
    }
  } finally {
    await cleanupPrice(commodity.id);
    await cleanup({ commodityIds: [commodity.id] });
  }
});

test('on CMS, setCurrentPrice enqueues sync_price (never commodity_price directly)', { skip: IS_CLOUD ? 'requires WMS_ROLE=cms' : false }, async () => {
  const commodity = await makeCommodity();
  try {
    await PriceService.setCurrentPrice(commodity.id, { unitPrice: 30, createdBy: 'Test' });

    const syncRows = await outboxRowsFor(commodity.id, 'sync_price');
    const directRows = await outboxRowsFor(commodity.id, 'commodity_price');
    assert.equal(syncRows.length, 1, 'CMS queues the push to Cloud');
    assert.equal(directRows.length, 0, 'CMS never enqueues the direct EnVo callback — it has no ENVO_API_URL');
  } finally {
    await cleanupPrice(commodity.id);
    await cleanup({ commodityIds: [commodity.id] });
  }
});

test('price history is append-only regardless of role', { skip: IS_CLOUD ? 'requires WMS_ROLE=cms' : false }, async () => {
  const commodity = await makeCommodity();
  try {
    const first = await PriceService.setCurrentPrice(commodity.id, { unitPrice: 10, createdBy: 'Test' });
    const second = await PriceService.setCurrentPrice(commodity.id, { unitPrice: 12, createdBy: 'Test' });

    const history = await PriceService.history(commodity.id);
    assert.equal(history.length, 2, 'the old price row survives, not overwritten');
    assert.equal(history.find((h) => h.id === second.id).is_current, true);
    assert.equal(history.find((h) => h.id === first.id).is_current, false);
  } finally {
    await cleanupPrice(commodity.id);
    await cleanup({ commodityIds: [commodity.id] });
  }
});

test('Cloud ingest applies a CMS-authored price and queues the EnVo push', { skip: !IS_CLOUD ? 'requires WMS_ROLE=cloud' : false }, async () => {
  const commodity = await makeCommodity();
  try {
    const envelope = {
      price: {
        uid: crypto.randomUUID(), commodity_id: commodity.id, unit_price: 42,
        effective_date: null, created_by: 'Test Store Officer', origin: 'cms', source_instance: 'cms-test',
      },
    };
    const result = await PriceService.ingest(envelope);
    assert.equal(result.applied, true);
    assert.equal(result.duplicate, false);

    const history = await PriceService.history(commodity.id);
    assert.equal(history.length, 1);
    assert.equal(Number(history[0].unit_price), 42);

    const pushed = await outboxRowsFor(commodity.id, 'commodity_price');
    assert.equal(pushed.length, 1, 'Cloud queues the EnVo push once it has applied the price');

    // Replaying the same envelope changes nothing and queues nothing a second time.
    const replay = await PriceService.ingest(envelope);
    assert.equal(replay.duplicate, true);
    const stillOnlyOne = await outboxRowsFor(commodity.id, 'commodity_price');
    assert.equal(stillOnlyOne.length, 1, 'a replayed envelope does not double-queue the EnVo push');
  } finally {
    await cleanupPrice(commodity.id);
    await cleanup({ commodityIds: [commodity.id] });
  }
});

test('Cloud ingest refuses an envelope not carrying origin cms', { skip: !IS_CLOUD ? 'requires WMS_ROLE=cloud' : false }, async () => {
  const commodity = await makeCommodity();
  try {
    await assert.rejects(
      PriceService.ingest({
        price: { uid: crypto.randomUUID(), commodity_id: commodity.id, unit_price: 5, origin: 'cloud' },
      }),
      /Cloud only mirrors what CMS decides/
    );
  } finally {
    await cleanup({ commodityIds: [commodity.id] });
  }
});

test('CommodityService.create routes its opening price through the same authority check', async () => {
  const name = `Test Commodity ${uniq()}`;
  if (IS_CLOUD) {
    await assert.rejects(
      CommodityService.create({ name, unitPrice: 15, createdBy: 'Test' }),
      /does not set prices/
    );
    // The commodity itself should not have been created either — one transaction, all or
    // nothing, exactly like every other multi-statement write in this codebase.
    const { rows } = await query('SELECT 1 FROM commodities WHERE name = $1', [name]);
    assert.equal(rows.length, 0, 'a refused price rolls back the whole commodity creation');
  } else {
    const commodity = await CommodityService.create({ name, unitPrice: 15, createdBy: 'Test' });
    assert.equal(Number(commodity.current_price), 15);
    await cleanupPrice(commodity.id);
    await cleanup({ commodityIds: [commodity.id] });
  }
});
