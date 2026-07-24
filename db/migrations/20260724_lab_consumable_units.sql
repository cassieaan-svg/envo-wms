-- Lab consumables: record the measuring unit used for consumption.
--
-- Source: "LABORATORY CONSUMABLES AND UNIT OF MEASUREMENT ON EnVO.xlsx" (73 rows),
-- supplied as the authority for how each lab consumable is counted.
--
-- Only fills a unit that is currently NULL. Anything already configured is left
-- alone, so a deliberate setup can't be overwritten — notably Urinalysis Strip
-- (kits of 100 tests, and holding stock), Cotton Wool 500g, Pasteur Pipette and
-- Vacutainer Needle, where the sheet disagrees with what is already in use. Those
-- four are intentionally untouched and can be changed individually later.
--
-- Units are stored SINGULAR ('piece', 'pack'): the UI pluralises for quantity != 1,
-- so 'piece' renders "1 piece" / "63 pieces", whereas 'pieces' would render
-- "1 pieces". Where the sheet gave a pack count ("Roll (100 PCS)", "Pack (50pcs)")
-- the count goes to pack_size and dispensing_unit is set to 'piece', so a quantity
-- breaks down as "1 roll = 100 pieces".
--
-- Matched on the name with case and punctuation ignored, so "Arc file Jacket" and
-- "PH meter" line up with the stored spellings. The sheet's "Vacine Box" is the
-- stored "Vaccine Box" (sheet typo) and is keyed to the stored spelling here.
--
-- Apply:
--   cd C:\envo\app\backend
--   node -e "import('./src/db.js').then(async ({query,pool})=>{const fs=await import('node:fs');await query(fs.readFileSync('../db/migrations/20260724_lab_consumable_units.sql','utf8'));console.log('applied');await pool.end()})"
-- Idempotent: re-running changes nothing, because every row it set is no longer NULL.

begin;

with sheet(key, unit, pack_size, dispensing_unit) as (
  values
    ('handgloves', 'pack', null, null),   -- Handgloves · Pack
    ('falcontubes15ml', 'piece', null, null),   -- Falcon Tubes (15ml) · Piece
    ('falcontubes50ml', 'piece', null, null),   -- Falcon Tubes (50ml) · Piece
    ('toner05a', 'piece', null, null),   -- Toner 05A · Piece
    ('toner53a', 'piece', null, null),   -- Toner 53A · Piece
    ('toner59a', 'piece', null, null),   -- Toner 59A · Piece
    ('toner80a', 'piece', null, null),   -- Toner 80A · Piece
    ('toner85a', 'piece', null, null),   -- Toner 85A · Piece
    ('toner106a', 'piece', null, null),   -- Toner 106A · Piece
    ('toner150a', 'piece', null, null),   -- Toner 150A · Piece
    ('vaselinesizedcontainer', 'piece', null, null),   -- Vaseline Sized container · Piece
    ('filterpaper', 'pack', null, null),   -- Filter Paper · pack
    ('stamppad', 'piece', null, null),   -- Stamp Pad · piece
    ('rubberband', 'pack', null, null),   -- Rubber Band · Pack
    ('phmeter', 'piece', null, null),   -- PH meter · Piece
    ('glacialaceticacid', 'bottle', null, null),   -- Glacial Acetic Acid · Bottle
    ('cautiontape', 'roll', null, null),   -- Caution tape · Roll
    ('permanentmarker', 'piece', null, null),   -- Permanent Marker · Piece
    ('finetipmarker', 'piece', null, null),   -- Fine tip Marker · Piece
    ('ballpointpen', 'piece', null, null),   -- Ball Point Pen · Piece
    ('autoclavablebiohazardbag', 'roll', '100', 'piece'),   -- Autoclavable Biohazard bag · Roll (100 PCS)
    ('transparentbiohazardbag', 'roll', null, null),   -- Transparent Biohazard Bag · Roll
    ('staplingpin', 'pack', null, null),   -- Stapling Pin · Pack
    ('eppendorfthermometer', 'piece', null, null),   -- Eppendorf Thermometer · Piece
    ('multichannelautomaticpipette', 'piece', null, null),   -- Multichannel Automatic Pipette · Piece
    ('automaticpipette', 'piece', null, null),   -- Automatic Pipette · Piece
    ('maskingtape', 'roll', null, null),   -- Masking Tape · Roll
    ('bucketcentrifuge', 'piece', null, null),   -- Bucket Centrifuge · Piece
    ('cryovialsblue', 'pack', null, null),   -- Cryovials (Blue) · Pack
    ('cryovialsred', 'pack', null, null),   -- Cryovials (Red) · Pack
    ('urinecontainer', 'piece', null, null),   -- Urine Container · Piece
    ('vaccinebox', 'piece', null, null),   -- Vaccine Box · Piece
    ('jablobox', 'piece', null, null),   -- Jablo Box · Piece
    ('tissueboxwipes', 'pack', null, null),   -- Tissue Box/Wipes · Pack
    ('kimwipes', 'pack', null, null),   -- Kim wipes · Pack
    ('antiviralspray', 'bottle', null, null),   -- Antiviral Spray · Bottle
    ('absoluteethanol', 'bottle', null, null),   -- Absolute Ethanol · Bottle
    ('pasteurpipette', 'pack', null, null),   -- Pasteur Pipette · pack
    ('alcoholpad', 'pack', null, null),   -- Alcohol Pad · Pack
    ('arcfilejacket', 'piece', null, null),   -- Arc file Jacket · Piece
    ('vacutainerneedle', 'pack', null, null),   -- Vacutainer needle · Pack
    ('butterflyneedle', 'pack', null, null),   -- Butterfly Needle · Pack
    ('filterpipettetip', 'pack', null, null),   -- Filter pipette tip · pack
    ('disposablelabcoat', 'piece', null, null),   -- Disposable Labcoat · piece
    ('tourniquet', 'piece', null, null),   -- Tourniquet · piece
    ('eyewashstation', 'piece', null, null),   -- Eyewash Station · Piece
    ('handwash', 'bottle', null, null),   -- Handwash · Bottle
    ('handsanitizer', 'bottle', null, null),   -- Handsanitizer · Bottle
    ('cottonwool500g', 'roll', null, null),   -- Cotton wool 500g · Roll
    ('benchpad', 'pack', null, null),   -- Benchpad · Pack
    ('biohazardbagyellow', 'roll', '100', 'piece'),   -- Biohazard Bag (Yellow) · Roll (100 PCS)
    ('biohazardbagred', 'roll', '100', 'piece'),   -- Biohazard Bag (Red) · Roll (100 PCS)
    ('biohazardbagblack', 'roll', '100', 'piece'),   -- Biohazard Bag (Black) · Roll (100 PCS)
    ('edtabottle2ml', 'pack', null, null),   -- EDTA Bottle (2ml) · Pack
    ('edtabottle5ml', 'pack', '100', 'piece'),   -- EDTA Bottle (5ml) · pack(100pcs)
    ('edtabottle10ml', 'pack', null, null),   -- EDTA Bottle (10ml) · Pack
    ('barcodelabel', 'roll', null, null),   -- Barcode Label · Rolls
    ('barcoderibbon', 'pack', '100', 'piece'),   -- Barcode Ribbon · pack (100pcs)
    ('timer', 'piece', null, null),   -- Timer · Piece
    ('thermometerwaterbath', 'piece', null, null),   -- Thermometer (Water bath) · Piece
    ('thermometerroom', 'piece', null, null),   -- Thermometer (Room) · Piece
    ('thermometerfreezer', 'piece', null, null),   -- Thermometer (Freezer) · Piece
    ('thermometerrefrigerator', 'piece', null, null),   -- Thermometer (Refrigerator) · Piece
    ('facemask', 'pack', '50', 'piece'),   -- Facemask · Pack (50pcs)
    ('methylatedspirit', 'bottle', null, null),   -- Methylated Spirit · Bottle
    ('envelopesbrown', 'piece', null, null),   -- Envelopes (Brown) · Piece
    ('jik', 'bottle', null, null),   -- Jik · Bottle
    ('sharpbox', 'pack', null, null),   -- Sharpbox · Pack
    ('vaginalspeculum', 'piece', null, null),   -- Vaginal Speculum · Piece
    ('needleholder', 'pack', null, null),   -- Needle Holder · Pack
    ('harpic', 'bottle', null, null),   -- Harpic · Bottle
    ('urinalysisstrip', 'strip', null, null),   -- Urinalysis Strip · strip
    ('a4paper', 'rim', null, null)   -- A4 Paper · Rim
)
update commodities c
   set unit            = s.unit,
       pack_size       = coalesce(s.pack_size, c.pack_size),
       dispensing_unit = coalesce(s.dispensing_unit, c.dispensing_unit)
  from sheet s
 where c.category = 'Lab consumables'
   and c.unit is null
   and lower(regexp_replace(c.name, '[^a-zA-Z0-9]', '', 'g')) = s.key;

commit;
