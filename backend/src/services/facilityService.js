import { query, withTransaction } from '../db.js';

export class FacilityService {
  static async list({ state = null, lga = null, search = null, includeInactive = false } = {}) {
    const { rows } = await query(
      `SELECT id, envo_facility_id, name, state, lga, is_active, created_at
         FROM facilities
        WHERE ($1 OR is_active)
          AND ($2::text IS NULL OR state = $2)
          AND ($3::text IS NULL OR lga = $3)
          AND ($4::text IS NULL OR name ILIKE '%' || $4 || '%')
        ORDER BY state, lga NULLS LAST, name`,
      [includeInactive, state, lga, search]
    );
    return rows;
  }

  // Drives the LGA filter on the facility pickers.
  static async listLgas({ state = null } = {}) {
    const { rows } = await query(
      `SELECT lga, state, COUNT(*)::int AS facility_count
         FROM facilities
        WHERE is_active
          AND lga IS NOT NULL
          AND ($1::text IS NULL OR state = $1)
        GROUP BY lga, state
        ORDER BY lga`,
      [state]
    );
    return rows;
  }

  static async create({ name, state, lga, envoFacilityId }) {
    const { rows } = await query(
      `INSERT INTO facilities (name, state, lga, envo_facility_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, envo_facility_id, name, state, lga, is_active, created_at`,
      [name, state, lga || null, envoFacilityId || null]
    );
    return rows[0];
  }

  static async update(id, { name, state, lga, envoFacilityId, isActive }) {
    const { rows } = await query(
      `UPDATE facilities
          SET name = COALESCE($2, name),
              state = COALESCE($3, state),
              lga = COALESCE($4, lga),
              envo_facility_id = COALESCE($5, envo_facility_id),
              is_active = COALESCE($6, is_active)
        WHERE id = $1
        RETURNING id, envo_facility_id, name, state, lga, is_active, created_at`,
      [id, name ?? null, state ?? null, lga ?? null, envoFacilityId ?? null, isActive ?? null]
    );
    return rows[0] || null;
  }

  // Assigned list is a default, not a restriction — is_default distinguishes standard
  // assignments from ones an admin added by hand.
  static async listCommodities(facilityId) {
    const { rows } = await query(
      `SELECT fc.id,
              fc.commodity_id,
              c.name,
              c.category,
              c.unit,
              fc.is_default,
              fc.added_by,
              fc.added_at
         FROM facility_commodities fc
         JOIN commodities c ON c.id = fc.commodity_id
        WHERE fc.facility_id = $1
        ORDER BY c.category NULLS LAST, c.name`,
      [facilityId]
    );
    return rows;
  }

  static async addCommodity(facilityId, { commodityId, isDefault = false, addedBy }) {
    const { rows } = await query(
      `INSERT INTO facility_commodities (facility_id, commodity_id, is_default, added_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (facility_id, commodity_id) DO NOTHING
       RETURNING id, facility_id, commodity_id, is_default, added_by, added_at`,
      [facilityId, commodityId, isDefault, addedBy ?? null]
    );
    return rows[0] || null;
  }

  // Bulk assignment runs as one transaction so a partial failure doesn't leave a
  // half-assigned facility.
  static async addCommodities(facilityId, commodityIds, { isDefault = false, addedBy } = {}) {
    return withTransaction(async (client) => {
      const inserted = [];
      for (const commodityId of commodityIds) {
        const { rows } = await client.query(
          `INSERT INTO facility_commodities (facility_id, commodity_id, is_default, added_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (facility_id, commodity_id) DO NOTHING
           RETURNING commodity_id`,
          [facilityId, commodityId, isDefault, addedBy ?? null]
        );
        if (rows[0]) inserted.push(rows[0].commodity_id);
      }
      return inserted;
    });
  }

  static async removeCommodity(facilityId, commodityId) {
    const { rows } = await query(
      'DELETE FROM facility_commodities WHERE facility_id = $1 AND commodity_id = $2 RETURNING id',
      [facilityId, commodityId]
    );
    return rows[0] || null;
  }
}
