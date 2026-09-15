// Transaction identity and safe retries for writes that will become offline-queueable.
//
// A device offline for hours queues its writes locally and replays them on reconnect. If
// the first attempt actually landed but the response never made it back to the device
// (a dropped connection, an app restart mid-sync), a naive retry repeats the write —
// dispensing the same 10 units twice, recording the same intake twice. The fix is a
// caller-supplied id that names the LOGICAL operation, generated on the device before the
// write is queued and reused unchanged on every retry of that same queued entry.
//
// Ported from envo-wms's IdempotencyService (backend/src/services/idempotencyService.js
// there) — that mechanism is already proven; this is the same design, adapted to this
// app's transaction API (`exec(text, params)` rather than a client object) and its own
// idempotent_operations table (see db/migrations/20260915_offline_write_idempotency.sql).
//
// HOW THE RACE IS WON. Two identical writes arriving at once both attempt the INSERT.
// The unique index on client_txn_id serialises them: one inserts, the other's
// ON CONFLICT DO NOTHING gives it no row, and it reads the committed row back instead.
// A "SELECT then INSERT" in application code would let both see nothing and both
// proceed — this is exactly the bug the unique index exists to prevent.
//
// WHY THIS MUST BE THE FIRST STATEMENT IN THE TRANSACTION. It is the gate. Claiming
// after the write would let a duplicate move stock before discovering it was a repeat.

const VALID_ID = /^[A-Za-z0-9_-]{8,64}$/

export class IdempotencyService {
  // Rejects ids that could not have come from a real client before they reach the
  // database — not the security control (ownership, below, is), just a clear 400 for a
  // typo'd or missing id instead of a constraint violation.
  static validate(clientTxnId) {
    if (clientTxnId == null || clientTxnId === '') return null
    const value = String(clientTxnId).trim()
    if (!VALID_ID.test(value)) {
      const err = new Error('client_txn_id must be 8-64 characters of letters, digits, hyphen or underscore')
      err.status = 400
      throw err
    }
    return value
  }

  // Same as validate(), but absent is refused — every offline-queueable write must
  // carry an id so a retry can be told apart from a second, real operation.
  static require(clientTxnId) {
    const value = IdempotencyService.validate(clientTxnId)
    if (!value) {
      const err = new Error('client_txn_id is required for this operation')
      err.status = 400
      throw err
    }
    return value
  }

  /**
   * Claim this operation, or discover it has already been done.
   *
   * Returns { claimed: true } when this call owns the work and should proceed, or
   * { claimed: false, result } when an earlier attempt already completed it — the
   * caller must return `result` unchanged and do nothing else.
   *
   * `exec` must be the transaction's bound query function (from withTransaction), and
   * this must be its first statement.
   */
  static async claim(exec, { clientTxnId, operation, actorUserId = null, facilityId = null }) {
    const inserted = await exec(
      `insert into idempotent_operations (client_txn_id, operation, actor_user_id, facility_id)
       values ($1, $2, $3, $4)
       on conflict (client_txn_id) do nothing
       returning id`,
      [clientTxnId, operation, actorUserId, facilityId]
    )
    if (inserted.rows[0]) return { claimed: true, id: inserted.rows[0].id }

    // No row: someone else holds this id. By the time our INSERT returned, they had
    // already committed or rolled back (we blocked on the unique index until they
    // finished), so read theirs.
    const existing = await exec(
      'select id, operation, actor_user_id, result from idempotent_operations where client_txn_id = $1',
      [clientTxnId]
    )

    if (!existing.rows[0]) {
      // The holder rolled back and released the id — nothing happened, so this attempt
      // is free to claim it. One retry only: a second empty read means something is
      // wrong that retrying cannot fix.
      const retry = await exec(
        `insert into idempotent_operations (client_txn_id, operation, actor_user_id, facility_id)
         values ($1, $2, $3, $4)
         on conflict (client_txn_id) do nothing
         returning id`,
        [clientTxnId, operation, actorUserId, facilityId]
      )
      if (retry.rows[0]) return { claimed: true, id: retry.rows[0].id }
      const err = new Error('could not establish operation identity, please retry')
      err.status = 409
      throw err
    }

    const existingRow = existing.rows[0]

    // Ownership. An id is an identifier, never a capability — it must not let one
    // account read back another account's operation.
    if (existingRow.actor_user_id != null && actorUserId != null && existingRow.actor_user_id !== actorUserId) {
      const err = new Error('this client_txn_id belongs to another user')
      err.status = 409
      throw err
    }

    // Same id, different operation — a client bug, and dangerous to guess at: replaying
    // an intake's result to a dispense would report success for something that never
    // happened.
    if (existingRow.operation !== operation) {
      const err = new Error(`client_txn_id already used for a different operation (${existingRow.operation})`)
      err.status = 409
      throw err
    }

    return { claimed: false, result: existingRow.result }
  }

  /**
   * Store what this operation produced, so a later retry can be answered without
   * repeating it. Runs inside the same transaction as the work, so a committed
   * transaction always has its result and a rolled-back one leaves nothing.
   */
  static async complete(exec, id, result) {
    await exec(
      'update idempotent_operations set result = $2::jsonb where id = $1',
      [id, JSON.stringify(result ?? null)]
    )
  }
}
