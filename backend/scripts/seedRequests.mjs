// Sample facility requests, for looking at the queue before EnVo starts sending real ones.
//   node scripts/seedRequests.mjs          seed a handful
//   node scripts/seedRequests.mjs --clear  remove them again
//
// Everything created here carries a SAMPLE- prefix on envo_request_id, so --clear can
// remove exactly what this script made and nothing else.
import pool, { query, withTransaction } from '../src/db.js';

const PREFIX = 'SAMPLE-';

// [facility name fragment, status, notes, [[commodity name fragment, qty], ...]]
const SAMPLES = [
  ['Mercy Hospital', 'pending', null, [
    ['Amoxicillin 500mg', 400],
    ['Paracetamol 500mg', 1200],
    ['0.9%Sodium Chloride 500mls', 60],
  ]],
  ['Ukpom Abak General Hospital', 'pending', null, [
    ['Chromic catgut 1', 40],
    ['Cotton wool 500g hard', 25],
    ['Gutt Gentamicin', 12],
  ]],
  ['Eket Immanuel General Hospital', 'picking', null, [
    ['Albendazole 400mg', 300],
    ['Amlodipine 10mg', 500],
  ]],
  ['Iko Town Primary Health Centre', 'dispatched', null, [
    ['Calamine lotion', 30],
    ['Benzyl Benzoate', 20],
  ]],
];

async function clear() {
  const { rows } = await query(
    `DELETE FROM requests WHERE envo_request_id LIKE $1 RETURNING id`,
    [`${PREFIX}%`]
  );
  console.log(`removed ${rows.length} sample request(s)`);
}

async function seed() {
  let made = 0;

  for (const [facilityName, status, notes, lines] of SAMPLES) {
    await withTransaction(async (client) => {
      const { rows: fac } = await client.query(
        'SELECT id, envo_facility_id FROM facilities WHERE name ILIKE $1 LIMIT 1',
        [`%${facilityName}%`]
      );
      if (!fac[0]) {
        console.warn(`skipped — no facility matching "${facilityName}"`);
        return;
      }

      // Resolve each line against the live catalogue so prices match the real master.
      const items = [];
      for (const [nameFragment, quantity] of lines) {
        const { rows: c } = await client.query(
          `SELECT c.id, p.unit_price
             FROM commodities c
             LEFT JOIN commodity_prices p ON p.commodity_id = c.id AND p.is_current
            WHERE c.name ILIKE $1 AND c.is_active
            LIMIT 1`,
          [`%${nameFragment}%`]
        );
        if (!c[0]) {
          console.warn(`  skipped line — no commodity matching "${nameFragment}"`);
          continue;
        }
        const unitPrice = Number(c[0].unit_price || 0);
        items.push({ commodityId: c[0].id, quantity, unitPrice, lineTotal: +(unitPrice * quantity).toFixed(2) });
      }
      if (items.length === 0) return;

      const total = +items.reduce((s, i) => s + i.lineTotal, 0).toFixed(2);
      const dispatched = status === 'dispatched';

      const { rows: req } = await client.query(
        `INSERT INTO requests
           (envo_request_id, envo_facility_id, facility_id, status, total_amount, notes,
            created_at, dispatched_at, dispatched_by)
         VALUES ($1, $2, $3, $4, $5, $6,
                 now() - ($7 || ' days')::interval,
                 CASE WHEN $8 THEN now() - interval '1 day' ELSE NULL END,
                 CASE WHEN $8 THEN 'cms.admin' ELSE NULL END)
         ON CONFLICT (envo_request_id) DO NOTHING
         RETURNING id`,
        [
          `${PREFIX}${facilityName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          fac[0].envo_facility_id,
          fac[0].id,
          status,
          total,
          notes,
          String(made + 1),
          dispatched,
        ]
      );
      if (!req[0]) return; // already seeded

      for (const i of items) {
        await client.query(
          `INSERT INTO request_items
             (request_id, commodity_id, quantity, unit_price, line_total, qty_dispatched)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [req[0].id, i.commodityId, i.quantity, i.unitPrice, i.lineTotal, dispatched ? i.quantity : null]
        );
      }
      made += 1;
      console.log(`  ${status.padEnd(10)} ${facilityName} — ${items.length} line(s), total ${total}`);
    });
  }

  console.log(`${made} sample request(s) created`);
}

const run = process.argv.includes('--clear') ? clear : seed;

run()
  .catch((err) => {
    console.error('seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
