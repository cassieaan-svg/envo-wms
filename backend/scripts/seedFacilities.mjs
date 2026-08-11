// Loads the Akwa Ibom facility register into envo_wms.
//   node scripts/seedFacilities.mjs
// Safe to re-run: rows are matched on envo_facility_id, so existing facilities have their
// name/LGA refreshed rather than being duplicated.
import pool, { withTransaction } from '../src/db.js';
import { AKWA_IBOM_FACILITIES } from './facilityData.js';

const STATE = 'Akwa Ibom';

async function main() {
  const { inserted, updated } = await withTransaction(async (client) => {
    let inserted = 0;
    let updated = 0;

    for (const [name, lga, code] of AKWA_IBOM_FACILITIES) {
      const { rows } = await client.query(
        `INSERT INTO facilities (name, state, lga, envo_facility_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (envo_facility_id) DO UPDATE
           SET name = EXCLUDED.name,
               lga = EXCLUDED.lga,
               state = EXCLUDED.state
         RETURNING (xmax = 0) AS was_inserted`,
        [name, STATE, lga, code]
      );
      if (rows[0].was_inserted) inserted += 1;
      else updated += 1;
    }

    return { inserted, updated };
  });

  const { rows } = await pool.query(
    `SELECT lga, COUNT(*)::int AS n FROM facilities WHERE state = $1 GROUP BY lga ORDER BY lga`,
    [STATE]
  );

  console.log(`${inserted} inserted, ${updated} updated`);
  console.log(`${rows.length} LGAs, ${rows.reduce((s, r) => s + r.n, 0)} facilities in ${STATE}`);
}

main()
  .catch((err) => {
    console.error('seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
