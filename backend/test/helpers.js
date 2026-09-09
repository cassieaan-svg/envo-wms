// Shared fixtures for the Phase 1 tests.
//
// These run against a REAL database — the invariants under test are enforced by Postgres
// (a unique index, row locks, transaction rollback), and none of that survives being
// mocked. Point PG* at a scratch database, not the warehouse.
//
// Every fixture is namespaced with a unique suffix and torn down children-first. A cleanup
// that cannot clean up reports rather than swallowing: a test run that silently leaks a
// commodity leaves phantom stock behind in whatever database it touched.

// Imported for its side effect: refuses to proceed against anything but a scratch
// database. Also preloaded via `node --import` in the test script, so a test file that
// does not use these helpers is still guarded.
import './guard.mjs';
import { query, withTransaction } from '../src/db.js';

let counter = 0;
export const uniq = () => `${Date.now()}-${process.pid}-${counter++}`;

// A ULID-shaped id, the same shape the frontend generates.
export const txnId = (label = 'T') => `${label}-${uniq()}`.replace(/[^A-Za-z0-9_-]/g, '-');

// `role` is kept for the legacy users.role column (display only, post Phase 1). What
// actually gates a route now is user_roles/role_permissions, so this also grants the
// permission-bundle role that matches the legacy meaning of `role`: 'admin' -> the full
// operational role (warehouse_admin), so existing tests written against "an admin user"
// keep exercising exactly the same permissions the old requireAdmin gate gave them.
// Pass `roles: []` for a plain authenticated user with no grants, or `roles: [...]` for
// anything more specific (e.g. ['picker_dispatcher']).
export async function makeUser({ role = 'admin', roles } = {}) {
  const username = `test-user-${uniq()}`;
  const { rows } = await query(
    `INSERT INTO users (username, password_hash, full_name, role)
     VALUES ($1, 'x', 'Test User', $2) RETURNING id, username, role`,
    [username, role]
  );
  const user = rows[0];

  const roleKeys = roles !== undefined ? roles : (role === 'admin' ? ['warehouse_admin'] : []);
  for (const key of roleKeys) {
    await query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE key = $2
       ON CONFLICT (user_id, role_id) WHERE facility_scope_id IS NULL DO NOTHING`,
      [user.id, key]
    );
  }
  return user;
}

export async function makeFacility() {
  const { rows } = await query(
    `INSERT INTO facilities (name, state, lga, is_active)
     VALUES ($1, 'Akwa Ibom', 'Uyo', true) RETURNING id, name`,
    [`Test Facility ${uniq()}`]
  );
  return rows[0];
}

export async function makeCommodity() {
  const { rows } = await query(
    `INSERT INTO commodities (name, category, unit, is_active)
     VALUES ($1, 'Test', 'unit', true) RETURNING id, name`,
    [`Test Commodity ${uniq()}`]
  );
  return rows[0];
}

/**
 * A batch with its opening receipt movement, written the way BatchService.receive would —
 * so the ledger and the balance agree from the start and any drift is the test's doing.
 * `expiryDate` defaults to well in the future so FEFO will consider it.
 */
export async function makeBatch(commodityId, quantity, { expiryDate = '2030-01-01', batchNumber = null } = {}) {
  // ONE transaction, deliberately. The balance guard (035) checks at commit that a batch's
  // quantity_remaining agrees with its ledger; creating the batch and its opening movement
  // as two auto-committed statements would leave the balance unexplained at the end of the
  // first one and be rejected — correctly. Fixtures have to be built the way the application
  // builds them.
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO commodity_batches
         (commodity_id, batch_number, expiry_date, quantity_received, quantity_remaining, created_by)
       VALUES ($1, $2, $3, $4, $4, 'test')
       RETURNING id, commodity_id, batch_number, expiry_date, quantity_remaining`,
      [commodityId, batchNumber, expiryDate, quantity]
    );
    const batch = rows[0];
    await client.query(
      `INSERT INTO batch_movements (batch_id, movement_type, quantity, note, created_by)
       VALUES ($1, 'receipt', $2, 'test fixture', 'test')`,
      [batch.id, quantity]
    );
    return batch;
  });
}

export async function batchQuantity(batchId) {
  const { rows } = await query('SELECT quantity_remaining FROM commodity_batches WHERE id = $1', [batchId]);
  return rows[0] ? Number(rows[0].quantity_remaining) : null;
}

export async function movementsFor(batchId, movementType = null) {
  const { rows } = await query(
    `SELECT * FROM batch_movements
      WHERE batch_id = $1 AND ($2::text IS NULL OR movement_type = $2)
      ORDER BY id`,
    [batchId, movementType]
  );
  return rows;
}

export async function scheme() {
  const { rows } = await query("SELECT key FROM schemes WHERE active ORDER BY sort_order LIMIT 1");
  return rows[0]?.key || 'drf';
}

/**
 * Remove a test's rows, children before parents. batch_movements and
 * inventory_transactions both reference batches, and inventory_transactions is referenced
 * by movements, so the order here is not negotiable.
 */
export async function cleanup({ batchIds = [], commodityIds = [], facilityIds = [], userIds = [], clientTxnIds = [] }) {
  const steps = [
    ['discrepancies', 'DELETE FROM stock_discrepancies WHERE batch_id = ANY($1)', [batchIds]],
    ['movements', 'DELETE FROM batch_movements WHERE batch_id = ANY($1)', [batchIds]],
    ['prices', 'DELETE FROM commodity_prices WHERE commodity_id = ANY($1)', [commodityIds]],
    ['order items', `DELETE FROM dispatch_order_items WHERE dispatch_order_id IN (
                       SELECT id FROM dispatch_orders WHERE facility_id = ANY($1))`, [facilityIds]],
    ['payments', `DELETE FROM dispatch_order_payments WHERE dispatch_order_id IN (
                       SELECT id FROM dispatch_orders WHERE facility_id = ANY($1))`, [facilityIds]],
    ['txns', 'DELETE FROM inventory_transactions WHERE client_txn_id = ANY($1)', [clientTxnIds]],
    // Requests sit between orders and facilities in the reference graph: a request points at
    // both. They have to go after the transactions that reference them and before the orders
    // and facilities they reference, or the facility delete fails and the fixture leaks.
    ['request items', `DELETE FROM request_items WHERE request_id IN (
                         SELECT id FROM requests WHERE facility_id = ANY($1))`, [facilityIds]],
    ['requests', 'DELETE FROM requests WHERE facility_id = ANY($1)', [facilityIds]],
    ['orders', 'DELETE FROM dispatch_orders WHERE facility_id = ANY($1)', [facilityIds]],
    ['batches', 'DELETE FROM commodity_batches WHERE id = ANY($1)', [batchIds]],
    ['commodities', 'DELETE FROM commodities WHERE id = ANY($1)', [commodityIds]],
    ['facilities', 'DELETE FROM facilities WHERE id = ANY($1)', [facilityIds]],
    // authz_audit_log and user_roles.granted_by both reference users with no cascade — a
    // test user who acted as an admin (granting a role, disabling someone) leaves rows that
    // block their own deletion otherwise.
    ['authz audit rows', 'DELETE FROM authz_audit_log WHERE actor_user_id = ANY($1) OR target_user_id = ANY($1)', [userIds]],
    ['role grants (as grantor)', 'UPDATE user_roles SET granted_by = NULL WHERE granted_by = ANY($1)', [userIds]],
    ['users', 'DELETE FROM users WHERE id = ANY($1)', [userIds]],
  ];
  for (const [label, sql, params] of steps) {
    if (!params[0] || !params[0].length) continue;
    try { await query(sql, params); }
    catch (err) { console.warn(`[cleanup] ${label} not removed: ${err.message}`); }
  }
}
