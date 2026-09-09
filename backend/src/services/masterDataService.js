import crypto from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { IS_CLOUD } from '../lib/role.js';

// Master data flows one way: Cloud owns it, CMS copies it.
//
// WHY A FULL SNAPSHOT RATHER THAN A CHANGE CURSOR. The whole of it is small — on the current
// database, 940 commodities, 182 facilities, 246 users, a handful of prices, schemes and
// vendors. A snapshot is a few hundred kilobytes, and it is correct by construction: it
// cannot miss a change, cannot get stuck behind a bad cursor, and handles deactivations and
// deletions without a tombstone mechanism. A cursor would be a lot of moving parts to save
// bandwidth the warehouse link can spare.
//
// The snapshot carries a content hash, so an unchanged pull costs one comparison and writes
// nothing. That hash is the "version" recorded in sync_state.
//
// CMS mirrors Cloud's integer ids verbatim. It never authors master data, so there is nothing
// to collide, and every existing foreign key keeps working with no translation layer.

// How long CMS may run on cached master data before the operator is warned, and before
// priced work is refused. Prices are the sharp edge: dispatching against a stale price
// misstates what a facility owes, and that error is discovered long after the stock is gone.
export const MASTER_DATA_WARN_HOURS = Number(process.env.MASTER_DATA_WARN_HOURS || 24);

// Withdrawn: there is no expiry on the cached roster, and none on priced work either.
//
// Phase 4 blocked priced dispatch after 72h and stopped authenticating after 72h. Both have
// been removed. Internet availability governs SYNCHRONISATION, not whether a warehouse may
// work: a store that cannot dispatch because a link has been down for three days is a store
// that has stopped functioning for a reason its staff cannot fix. Staleness is now something
// the operator is TOLD about and can judge, not something that takes decisions away.

const TABLES = ['commodities', 'commodity_prices', 'facilities', 'facility_commodities',
                'schemes', 'vendors', 'users', 'user_roles'];

// user_roles is Cloud-authoritative — see the Phase 1 authorization design and migration
// 040. roles/permissions/role_permissions are NOT synced: they are static catalogue data,
// seeded identically by migration 040 on both instances, so there is nothing to replicate.
// users.is_locally_disabled is likewise never part of this payload in either direction —
// it is this instance's own emergency-lockout state, and must survive a sync untouched.

/**
 * The staleness policy itself, as a pure function of "when did we last hear from Cloud".
 *
 * Separated from the role-aware wrapper below so the policy can be exercised directly. The
 * wrapper short-circuits on Cloud — which has no master data of its own to be stale — and
 * that short-circuit would otherwise make the thresholds untestable except by standing up a
 * second process.
 */
export function classifyStaleness(lastSuccessAt, { now = Date.now() } = {}) {
  if (!lastSuccessAt) {
    return { level: 'never', ageHours: null, neverSynced: true, pricedWorkAllowed: true };
  }
  const ageHours = (now - new Date(lastSuccessAt).getTime()) / 3_600_000;
  const level = ageHours >= MASTER_DATA_WARN_HOURS ? 'warn' : 'fresh';
  // Always true. Kept in the shape so callers and the UI need no change, and so the reason
  // it is always true is stated where anyone reintroducing a block would read it.
  return { level, ageHours: Math.round(ageHours * 10) / 10, pricedWorkAllowed: true };
}

export class MasterDataService {
  // ── Cloud side ────────────────────────────────────────────────────────────
  /**
   * The snapshot Cloud serves to CMS. Read-only.
   *
   * Password hashes are included deliberately: CMS has to authenticate people when the
   * internet is gone, and it can only do that against the same bcrypt hashes Cloud holds.
   * The link is service-token authenticated and TLS-terminated, and the hashes are bcrypt —
   * this is the same exposure as the database backup that already crosses the wire.
   */
  static async snapshot() {
    if (!IS_CLOUD) {
      const e = new Error('only the Cloud instance serves master data'); e.status = 403; throw e;
    }

    const [commodities, prices, facilities, facilityCommodities, schemes, vendors, users, userRoles] =
      await Promise.all([
        query(`SELECT id, envo_commodity_id, name, category, unit, is_active,
                      reorder_level, max_level
                 FROM commodities ORDER BY id`),
        query(`SELECT id, commodity_id, vendor_id, brand_name, unit_price, effective_date,
                      is_current, created_by
                 FROM commodity_prices ORDER BY id`),
        query(`SELECT id, envo_facility_id, name, state, lga, is_active
                 FROM facilities ORDER BY id`),
        query(`SELECT id, facility_id, commodity_id, is_default, added_by, added_at
                 FROM facility_commodities ORDER BY id`),
        query(`SELECT key, label, creates_debt, active, sort_order FROM schemes ORDER BY key`),
        query(`SELECT id, name, contact_name, contact_phone, contact_email, is_active
                 FROM vendors ORDER BY id`),
        query(`SELECT id, uid, username, password_hash, full_name, role, is_active
                 FROM users ORDER BY id`),
        // Cloud is the sole writer of role assignments (Phase 1 design, section 6) — CMS
        // never authors this table, only mirrors it, exactly like every other master-data row.
        query(`SELECT id, user_id, role_id, facility_scope_id, granted_by, granted_at
                 FROM user_roles ORDER BY id`),
      ]);

    const payload = {
      commodities: commodities.rows,
      commodity_prices: prices.rows,
      facilities: facilities.rows,
      facility_commodities: facilityCommodities.rows,
      schemes: schemes.rows,
      vendors: vendors.rows,
      users: users.rows,
      user_roles: userRoles.rows,
    };

    return {
      generatedAt: new Date().toISOString(),
      version: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      counts: Object.fromEntries(TABLES.map((t) => [t, payload[t].length])),
      data: payload,
    };
  }

  // ── CMS side ──────────────────────────────────────────────────────────────
  /**
   * Apply a snapshot locally. One transaction: master data is a set, and half of it is worse
   * than none — a facility roster that landed without its commodities would look like a
   * deliberate deactivation.
   *
   * Rows are upserted by Cloud's primary key. Nothing is deleted: a commodity that vanished
   * from Cloud may still be referenced by a local batch, and breaking that foreign key to
   * mirror a deletion would take out warehouse history. Deactivation (`is_active = false`)
   * is how Cloud retires something, and that copies down like any other column.
   */
  static async apply(snapshot) {
    const d = snapshot?.data;
    if (!d) { const e = new Error('snapshot has no data'); e.status = 400; throw e; }

    return withTransaction(async (client) => {
      const upsert = async (sql, rows, values) => {
        for (const r of rows || []) await client.query(sql, values(r));
      };

      await upsert(
        `INSERT INTO commodities (id, envo_commodity_id, name, category, unit, is_active, reorder_level, max_level)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET envo_commodity_id=EXCLUDED.envo_commodity_id,
           name=EXCLUDED.name, category=EXCLUDED.category, unit=EXCLUDED.unit,
           is_active=EXCLUDED.is_active, reorder_level=EXCLUDED.reorder_level,
           max_level=EXCLUDED.max_level`,
        d.commodities, (r) => [r.id, r.envo_commodity_id, r.name, r.category, r.unit,
                               r.is_active, r.reorder_level, r.max_level]);

      await upsert(
        `INSERT INTO facilities (id, envo_facility_id, name, state, lga, is_active)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET envo_facility_id=EXCLUDED.envo_facility_id,
           name=EXCLUDED.name, state=EXCLUDED.state, lga=EXCLUDED.lga, is_active=EXCLUDED.is_active`,
        d.facilities, (r) => [r.id, r.envo_facility_id, r.name, r.state, r.lga, r.is_active]);

      await upsert(
        `INSERT INTO vendors (id, name, contact_name, contact_phone, contact_email, is_active)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, contact_name=EXCLUDED.contact_name,
           contact_phone=EXCLUDED.contact_phone, contact_email=EXCLUDED.contact_email,
           is_active=EXCLUDED.is_active`,
        d.vendors, (r) => [r.id, r.name, r.contact_name, r.contact_phone, r.contact_email, r.is_active]);

      await upsert(
        `INSERT INTO schemes (key, label, creates_debt, active, sort_order) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (key) DO UPDATE SET label=EXCLUDED.label, creates_debt=EXCLUDED.creates_debt,
           active=EXCLUDED.active, sort_order=EXCLUDED.sort_order`,
        d.schemes, (r) => [r.key, r.label, r.creates_debt, r.active, r.sort_order]);

      await upsert(
        `INSERT INTO commodity_prices
           (id, commodity_id, vendor_id, brand_name, unit_price, effective_date, is_current, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET vendor_id=EXCLUDED.vendor_id,
           brand_name=EXCLUDED.brand_name, unit_price=EXCLUDED.unit_price,
           effective_date=EXCLUDED.effective_date, is_current=EXCLUDED.is_current`,
        d.commodity_prices, (r) => [r.id, r.commodity_id, r.vendor_id, r.brand_name, r.unit_price,
                                    r.effective_date, r.is_current, r.created_by]);

      await upsert(
        `INSERT INTO facility_commodities (id, facility_id, commodity_id, is_default, added_by, added_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET is_default=EXCLUDED.is_default`,
        d.facility_commodities, (r) => [r.id, r.facility_id, r.commodity_id, r.is_default,
                                        r.added_by, r.added_at]);

      // The roster CMS authenticates against while the internet is gone.
      await upsert(
        `INSERT INTO users (id, uid, username, password_hash, full_name, role, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username,
           password_hash=EXCLUDED.password_hash, full_name=EXCLUDED.full_name,
           role=EXCLUDED.role, is_active=EXCLUDED.is_active`,
        d.users, (r) => [r.id, r.uid, r.username, r.password_hash, r.full_name, r.role, r.is_active]);

      // user_roles is the one table in this payload that is fully replaced rather than only
      // upserted. Every other table's "no deletes" rule exists because a local row might
      // still be referenced by warehouse history a deletion would break; a role grant has no
      // such downstream reference, and unlike master data, a STALE grant is itself a live
      // access-control defect — a revocation made in Cloud must actually take effect here,
      // not linger because nothing told this table to drop it. Cloud is the sole writer of
      // this table (Phase 1 design, section 6), so replacing wholesale from its snapshot is
      // safe: there is no local edit this could ever clobber.
      const incomingIds = (d.user_roles || []).map((r) => r.id);
      await client.query(
        'DELETE FROM user_roles WHERE id != ALL($1::int[])',
        [incomingIds.length ? incomingIds : [0]]
      );
      await upsert(
        `INSERT INTO user_roles (id, user_id, role_id, facility_scope_id, granted_by, granted_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET user_id=EXCLUDED.user_id, role_id=EXCLUDED.role_id,
           facility_scope_id=EXCLUDED.facility_scope_id, granted_by=EXCLUDED.granted_by,
           granted_at=EXCLUDED.granted_at`,
        d.user_roles, (r) => [r.id, r.user_id, r.role_id, r.facility_scope_id, r.granted_by, r.granted_at]);

      await client.query(
        `INSERT INTO sync_state (stream, cursor, last_success_at, last_attempt_at, last_error, detail, updated_at)
         VALUES ('master_data', $1, now(), now(), NULL, $2::jsonb, now())
         ON CONFLICT (stream) DO UPDATE SET cursor=EXCLUDED.cursor,
           last_success_at=EXCLUDED.last_success_at, last_attempt_at=EXCLUDED.last_attempt_at,
           last_error=NULL, detail=EXCLUDED.detail, updated_at=now()`,
        [snapshot.version, JSON.stringify({ counts: snapshot.counts, generatedAt: snapshot.generatedAt })]);

      return snapshot.counts;
    });
  }

  static async recordFailure(stream, message) {
    await query(
      `INSERT INTO sync_state (stream, last_attempt_at, last_error, updated_at)
       VALUES ($1, now(), $2, now())
       ON CONFLICT (stream) DO UPDATE SET last_attempt_at=now(), last_error=$2, updated_at=now()`,
      [stream, String(message).slice(0, 500)]);
  }

  static async state(stream = 'master_data') {
    const { rows } = await query('SELECT * FROM sync_state WHERE stream = $1', [stream]);
    return rows[0] || null;
  }

  /**
   * How stale is the local copy, and what does that permit?
   *
   * `fresh` → normal. `warn` → past 24h, surfaced to the operator but nothing is refused.
   * `blocked` → past 72h, priced work is refused.
   *
   * Receiving, adjustments and stocktake stay available at every level. They do not depend
   * on a price being right, and refusing them would stop the warehouse recording stock it is
   * physically holding — which helps nobody and loses information.
   */
  static async staleness() {
    if (IS_CLOUD) {
      return { level: 'fresh', ageHours: 0, appliesTo: 'cloud', pricedWorkAllowed: true };
    }
    const st = await MasterDataService.state('master_data');
    const c = classifyStaleness(st?.last_success_at ?? null);
    return {
      ...c,
      lastSuccessAt: st?.last_success_at ?? null,
      version: st?.cursor ?? null,
      warnAfterHours: MASTER_DATA_WARN_HOURS,
      message: c.neverSynced
        ? 'This warehouse has not yet received master data from Cloud. Prices and the facility '
          + 'list are whatever was seeded locally.'
        : c.level === 'warn'
        ? `Master data is ${Math.round(c.ageHours)}h old. Prices and the facility list may have `
          + 'changed in Cloud since this copy was taken. Warehouse operations are unaffected.'
        : null,
    };
  }

  /**
   * Whether the cached roster may authenticate people. Always yes.
   *
   * Retained so callers and the status endpoint keep working, and so the age is still
   * reported — an operator seeing "roster 40h old" can act on it. It no longer decides
   * anything.
   */
  static async authRosterStatus() {
    if (IS_CLOUD) return { usable: true, ageHours: 0 };
    const st = await MasterDataService.state('master_data');
    if (!st?.last_success_at) return { usable: true, ageHours: null, neverSynced: true };
    return {
      usable: true,
      ageHours: Math.round(((Date.now() - new Date(st.last_success_at).getTime()) / 3_600_000) * 10) / 10,
    };
  }
}
