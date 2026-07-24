-- Lab consumables: rename two units to match the measurement sheet.
--
-- Both are PURE RENAMES confirmed with the lab — the count does not change and
-- nothing is converted:
--   Urinalysis Strip  kits  -> strip   (1 strip = 1 kit = 1 test, all 1:1)
--   Cotton Wool 500g  packs -> roll    (a 500g pack IS a roll)
--
-- No quantity, stock row, lot or log is touched: `unit` is only the label shown
-- beside a number, so 326 stays 326 and 1,374 stays 1,374 — they just read
-- "326 strips" and "1,374 rolls".
--
-- Urinalysis Strip also loses pack_size "100 tests" and dispensing_unit "test".
-- Those described a kit that breaks into 100 tests, but one strip performs one
-- test, so there is nothing to break down. (They were inert anyway: the app tests
-- `pack_size > 1`, and the text "100 tests" evaluates to NaN, so the breakdown
-- never displayed.) Clearing them stops the app ever implying a 100x split.
--
-- Units are stored SINGULAR: the UI pluralises for quantity != 1, so 'strip'
-- renders "1 strip" / "326 strips". The old plural 'packs' rendered "1 packs".
--
-- Deliberately NOT changed: Pasteur Pipette and Vacutainer Needle, where the
-- sheet says "Pack" but the recorded quantities (37,669 and 82,963) read as
-- individual pieces. Relabelling those without converting would misstate the
-- holdings, so they keep 'pcs' pending confirmation from the lab.
--
-- Apply:
--   cd C:\envo\app\backend
--   node -e "import('./src/db.js').then(async ({query,pool})=>{const fs=await import('node:fs');await query(fs.readFileSync('../db/migrations/20260724_lab_unit_renames.sql','utf8'));console.log('applied');await pool.end()})"
-- Idempotent: re-running sets the same values.

begin;

update commodities
   set unit = 'strip', dispensing_unit = null, pack_size = null
 where category = 'Lab consumables'
   and lower(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g')) = 'urinalysisstrip';

update commodities
   set unit = 'roll', dispensing_unit = null
 where category = 'Lab consumables'
   and lower(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g')) = 'cottonwool500g';

commit;
