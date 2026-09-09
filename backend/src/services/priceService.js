import { query, withTransaction } from '../db.js';
import { OutboxService } from './outboxService.js';
import { IS_CLOUD } from '../lib/role.js';

export class PriceService {
  static async history(commodityId) {
    const { rows } = await query(
      `SELECT id, unit_price, effective_date, is_current, created_by, created_at
         FROM commodity_prices
        WHERE commodity_id = $1
        ORDER BY effective_date DESC, created_at DESC`,
      [commodityId]
    );
    return rows;
  }

  // Adjusting a price never overwrites the old row: it's flipped to is_current = false and
  // a new current row is inserted, so the trail of what a commodity used to cost survives.
  static async setCurrentPrice(commodityId, { unitPrice, effectiveDate, createdBy }) {
    return withTransaction(async (client) => {
      await client.query(
        'UPDATE commodity_prices SET is_current = FALSE WHERE commodity_id = $1 AND is_current',
        [commodityId]
      );

      const { rows } = await client.query(
        `INSERT INTO commodity_prices (commodity_id, unit_price, effective_date, is_current, created_by)
         VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), TRUE, $4)
         RETURNING id, commodity_id, unit_price, effective_date, is_current, created_at`,
        [commodityId, unitPrice, effectiveDate ?? null, createdBy ?? null]
      );

      // Push the new price to EnVo through the outbox, in the same transaction — so a
      // change made while EnVo is down (or offline) is delivered the moment it's back,
      // rather than lost after a few retries. causeKey chains per-commodity price rows.
      //
      // EnVo is Cloud's relationship, not the warehouse's — same reasoning as
      // RequestService's status callbacks. On CMS this queued a callback the instance can
      // never deliver: it has no ENVO_API_URL by design, so the row failed on every attempt
      // and retried forever (see requestService.js's IS_CLOUD guards for the same fix,
      // found the same way — a two-instance commissioning drill).
      //
      // NOTE this does not make a CMS-side price change reach EnVo some other way: master
      // data sync is one-directional, Cloud -> CMS only (see MasterDataService's own header
      // comment) — commodity_prices is a table CMS mirrors, not one it feeds back. A price
      // set locally at CMS today is silently overwritten by the next Cloud sync pull and
      // never seen by EnVo either way; this guard only stops that from ALSO leaving a
      // permanently-failing outbox row behind. Whether CMS should be allowed to set prices
      // at all is a separate question this fix does not resolve.
      if (IS_CLOUD) await OutboxService.enqueue(
        'commodity_price',
        { wmsCommodityId: commodityId, unitPrice: Number(unitPrice), causeKey: `price:${commodityId}` },
        client
      );

      return rows[0];
    });
  }
}
