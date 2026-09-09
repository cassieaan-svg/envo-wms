// Transaction identity and safe retries for inventory-changing operations.
//
// Every operation that moves stock claims its identity here first, inside the same
// transaction that does the work. A retry carrying the same client_txn_id does not repeat
// the work — it is handed back what the first attempt produced.
//
// HOW THE RACE IS WON. Two identical requests arriving at once both reach the INSERT. The
// unique index on client_txn_id serialises them: one inserts, the other blocks until the
// first commits and then finds ON CONFLICT DO NOTHING gave it no row. It reads the
// committed transaction back and replays its result. Neither the check nor the insert is
// trusted on its own — a "SELECT then INSERT" in application code would let both requests
// see nothing and both proceed, which is precisely the bug this exists to prevent.
//
// WHY THIS MUST BE THE FIRST STATEMENT IN THE TRANSACTION. It is the gate. If a caller
// decremented stock first and claimed afterwards, a duplicate would already have moved the
// stock by the time it discovered it was a duplicate.
//
// AUTHORIZATION IS NOT DELEGATED HERE. Callers run behind authMiddleware and requirePermission;
// by the time claim() is reached the user is authenticated and permitted. What claim() adds
// is ownership: a replay is served only to the account that created the transaction, so a
// guessed or stolen client_txn_id returns a conflict rather than another user's order.

import { ORIGIN, INSTANCE_ID } from '../lib/instance.js';
import { IS_CMS } from '../lib/role.js';
import { SyncService } from './syncService.js';

const VALID_ID = /^[A-Za-z0-9_-]{8,64}$/;

export class IdempotencyService {
  // Reject ids that couldn't have come from a real client before they reach the database.
  // Not a security control — the ownership check below is — but it keeps junk out of a
  // uniquely-indexed column and turns a typo into a clear 400.
  static validate(clientTxnId) {
    if (clientTxnId == null || clientTxnId === '') return null;
    const value = String(clientTxnId).trim();
    if (!VALID_ID.test(value)) {
      const err = new Error(
        'clientTxnId must be 8-64 characters of letters, digits, hyphen or underscore'
      );
      err.status = 400;
      throw err;
    }
    return value;
  }

  /**
   * Same as validate(), but absent is refused.
   *
   * Phase 1 accepted requests without an id so an older client kept working while the
   * frontend caught up. Every client now sends one, and continuing to accept requests
   * without one would leave a permanent way to bypass the protection — a caller that
   * omits the field gets no retry safety and never learns it.
   */
  static require(clientTxnId) {
    const value = IdempotencyService.validate(clientTxnId);
    if (!value) {
      const err = new Error(
        'clientTxnId is required — every inventory-changing request must carry a ' +
        'transaction id that stays the same across retries'
      );
      err.status = 400;
      throw err;
    }
    return value;
  }

  /**
   * Claim this transaction, or discover it has already been done.
   *
   * Returns { txn, replay:false } when this call owns the work and should proceed, or
   * { txn, replay:true } when an earlier attempt already completed it — in which case the
   * caller must return txn.result and change nothing.
   *
   * `client` must be the transaction client, and this must be its first statement.
   */
  static async claim(client, { clientTxnId, operation, actorUserId = null, actor = null }) {
    const inserted = await client.query(
      `INSERT INTO inventory_transactions
         (client_txn_id, operation, actor_user_id, actor, origin, source_instance)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (client_txn_id) DO NOTHING
       RETURNING *`,
      [clientTxnId, operation, actorUserId, actor, ORIGIN, INSTANCE_ID]
    );
    if (inserted.rows[0]) return { txn: inserted.rows[0], replay: false };

    // No row: someone else holds this id. They have committed by now (we blocked on the
    // index until they did), so read theirs.
    const existing = await client.query(
      'SELECT * FROM inventory_transactions WHERE client_txn_id = $1',
      [clientTxnId]
    );

    if (!existing.rows[0]) {
      // The holder rolled back and released the id — their work never happened, so this
      // attempt is free to do it. One retry only: a second empty read would mean something
      // is wrong that retrying cannot fix.
      const retry = await client.query(
        `INSERT INTO inventory_transactions
           (client_txn_id, operation, actor_user_id, actor, origin, source_instance)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (client_txn_id) DO NOTHING
         RETURNING *`,
        [clientTxnId, operation, actorUserId, actor, ORIGIN, INSTANCE_ID]
      );
      if (retry.rows[0]) return { txn: retry.rows[0], replay: false };
      const err = new Error('could not establish transaction identity, please retry');
      err.status = 409;
      throw err;
    }

    const txn = existing.rows[0];

    // Ownership. A transaction id is an identifier, never a capability: it must not let
    // one account read back another account's work.
    if (txn.actor_user_id != null && actorUserId != null && txn.actor_user_id !== actorUserId) {
      const err = new Error('this transaction id belongs to another user');
      err.status = 409;
      throw err;
    }

    // Same id, different operation — a client bug, and dangerous to guess at: replaying a
    // receipt's result to a dispatch would report success for something that never
    // happened. Refuse.
    if (txn.operation !== operation) {
      const err = new Error(
        `transaction id already used for a different operation (${txn.operation})`
      );
      err.status = 409;
      throw err;
    }

    return { txn, replay: true };
  }

  /**
   * Store what this transaction produced, and what it touched, so a later retry can be
   * answered without repeating it. Runs inside the same transaction as the work, so a
   * committed transaction always has its result and a rolled-back one leaves nothing.
   */
  static async complete(client, txnId, result, links = {}) {
    const { batchId = null, dispatchOrderId = null, requestId = null } = links;
    const { rows } = await client.query(
      `UPDATE inventory_transactions
          SET result = $2::jsonb,
              batch_id = COALESCE($3, batch_id),
              dispatch_order_id = COALESCE($4, dispatch_order_id),
              request_id = COALESCE($5, request_id)
        WHERE id = $1
        RETURNING client_txn_id`,
      [txnId, JSON.stringify(result ?? null), batchId, dispatchOrderId, requestId]
    );

    // Queue the transaction for Cloud, on CMS only, in THIS transaction.
    //
    // Hooked here rather than at each of the five write paths deliberately: this is the one
    // point every claimed inventory transaction already passes through, so coverage is
    // structural instead of something a future write path has to remember. And because it
    // shares the transaction, a dispatch that commits always has its sync record waiting,
    // while one that rolls back leaves nothing claiming it happened.
    if (IS_CMS && rows[0]) {
      await SyncService.enqueue(client, {
        clientTxnId: rows[0].client_txn_id,
        // Causality is per batch or per order, so the outbox holds a reversal behind the
        // dispatch it reverses rather than letting it overtake.
        causeKey: dispatchOrderId ? `order:${dispatchOrderId}`
                : batchId ? `batch:${batchId}`
                : `txn:${rows[0].client_txn_id}`,
      });
    }
  }

  // The movements a given client transaction produced — the audit answer to "what did this
  // actually do?", and how the tests assert that a retry produced nothing new.
  static async movementsFor(client, clientTxnId) {
    const run = client ? (t, p) => client.query(t, p) : null;
    const { rows } = await run(
      `SELECT m.* FROM batch_movements m
         JOIN inventory_transactions t ON t.id = m.txn_id
        WHERE t.client_txn_id = $1
        ORDER BY m.id`,
      [clientTxnId]
    );
    return rows;
  }
}
