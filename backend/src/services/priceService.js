import { query, withTransaction } from '../db.js';
import { ORIGIN, INSTANCE_ID } from '../lib/instance.js';
import { IS_CLOUD, assertCanSetPrices } from '../lib/role.js';

// Outbox rows are inserted directly rather than through OutboxService.enqueue() —
// OutboxService's sync_price sender has to import THIS file to build the envelope it sends,
// and importing OutboxService back here would make the two modules circular. RequestStatusService
// solves the same problem the same way; see its `record()`.

// CMS is the price authority — pricing is decided operationally at the warehouse, not at
// Cloud, which has no relationship with a vendor to price against. A price set here has to
// reach EnVo (so the facility sees what the warehouse actually charges), and EnVo is
// reachable only from Cloud, so the path is: CMS writes locally -> pushes an envelope to
// Cloud (this file's setCurrentPrice + the sync_price outbox kind) -> Cloud applies it
// (ingest, below) and pushes it on to EnVo through its own existing outbox
// ('commodity_price', unchanged). Same shape as RequestStatusService's CMS->Cloud events,
// deliberately: it's the same problem (something decided at the warehouse has to reach a
// system only Cloud can talk to) solved the same way.
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
  //
  // `viaIngest`/`uid` are set only when Cloud is applying a price CMS already decided (see
  // ingest, below) — never by a caller setting a price directly.
  static async setCurrentPrice(commodityId, { unitPrice, effectiveDate, createdBy, client: existingClient = null, viaIngest = false, uid = null } = {}) {
    assertCanSetPrices({ viaIngest });

    const run = async (client) => {
      await client.query(
        'UPDATE commodity_prices SET is_current = FALSE WHERE commodity_id = $1 AND is_current',
        [commodityId]
      );

      const { rows } = await client.query(
        `INSERT INTO commodity_prices
           (commodity_id, unit_price, effective_date, is_current, created_by, uid, origin, source_instance)
         VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), TRUE, $4, COALESCE($5, gen_random_uuid()), $6, $7)
         RETURNING id, uid, commodity_id, unit_price, effective_date, is_current, created_at`,
        [commodityId, unitPrice, effectiveDate ?? null, createdBy ?? null, uid, ORIGIN, INSTANCE_ID]
      );
      const price = rows[0];

      // CMS pushes what it just decided up to Cloud, which is the only instance that can
      // reach EnVo. Not on ingest — that write IS the push landing, pushing it again would
      // loop forever.
      if (!viaIngest && !IS_CLOUD) {
        await client.query(
          `INSERT INTO outbox (kind, payload) VALUES ('sync_price', $1::jsonb)`,
          [JSON.stringify({ priceUid: price.uid, causeKey: `price:${commodityId}` })]
        );
      }

      return price;
    };

    if (existingClient) return run(existingClient);
    return withTransaction(run);
  }

  /** The row as it travels CMS -> Cloud. Built at send time, like an inventory envelope. */
  static async envelope(uid) {
    const { rows } = await query(
      `SELECT p.uid, p.commodity_id, c.uid AS commodity_uid, c.envo_commodity_id,
              p.unit_price, p.effective_date, p.created_by, p.origin, p.source_instance
         FROM commodity_prices p
         JOIN commodities c ON c.id = p.commodity_id
        WHERE p.uid = $1`,
      [uid]
    );
    if (!rows[0]) return null;
    return { envelopeVersion: 1, price: rows[0] };
  }

  static async markSynced(uid) {
    // commodity_prices carries no synced_at column of its own (unlike request_status_events)
    // — a price row is immutable once written, so "synced" is a fact about the outbox
    // delivery, not about the row. Nothing to update here; kept as a named step so the
    // sender in outboxService.js reads the same as sync_request_status's, and so a future
    // synced_at column (if ever added, e.g. for a "pending sync" indicator in the UI) has
    // one call site to change rather than several.
    return true;
  }

  /**
   * Cloud: apply a price CMS already decided, and push it on to EnVo.
   *
   * Idempotent on the price's own uid — a re-delivered envelope is recognised and applied
   * once. Refuses anything not carrying origin 'cms': Cloud never authors a price, so an
   * envelope claiming otherwise is either a bug or something worth refusing outright.
   */
  static async ingest(envelope) {
    if (!IS_CLOUD) {
      const e = new Error('only the Cloud instance ingests price envelopes'); e.status = 403; throw e;
    }
    const p = envelope?.price;
    if (!p?.uid || p.commodity_id == null || p.unit_price == null) {
      const e = new Error('malformed price envelope'); e.status = 400; throw e;
    }
    if (p.origin !== 'cms') {
      const e = new Error(`refusing a price envelope with origin "${p.origin}": Cloud only mirrors what CMS decides`);
      e.status = 403; e.code = 'BAD_ORIGIN'; throw e;
    }

    return withTransaction(async (client) => {
      const { rows: seen } = await client.query(
        'SELECT id, unit_price FROM commodity_prices WHERE uid = $1', [p.uid]);
      if (seen[0]) return { applied: false, duplicate: true, uid: p.uid };

      const { rows: commodityRows } = await client.query(
        'SELECT id FROM commodities WHERE id = $1', [p.commodity_id]);
      if (!commodityRows[0]) {
        const e = new Error(`no commodity here with id ${p.commodity_id}`); e.status = 404; throw e;
      }

      const price = await PriceService.setCurrentPrice(p.commodity_id, {
        unitPrice: p.unit_price,
        effectiveDate: p.effective_date,
        createdBy: p.created_by,
        client,
        viaIngest: true,
        uid: p.uid,
      });

      // Now push it on to EnVo — the one place 'commodity_price' is still enqueued. Cloud is
      // the only instance with an EnVo relationship, and this transaction is Cloud recording
      // what CMS decided, which is exactly the moment to tell EnVo.
      await client.query(
        `INSERT INTO outbox (kind, payload) VALUES ('commodity_price', $1::jsonb)`,
        [JSON.stringify({
          wmsCommodityId: p.commodity_id, unitPrice: Number(p.unit_price), causeKey: `price:${p.commodity_id}`,
        })]
      );

      return { applied: true, duplicate: false, uid: p.uid, price };
    });
  }
}
