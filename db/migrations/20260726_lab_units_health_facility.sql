-- Lab consumables: set units from the HEALTH FACILITY measurement sheet.
--
-- Source: Heathfacility.xlsx, sheet "HEALTH FACILITY" (73 rows) - the updated
-- authority for how facilities count each lab consumable. SUPERSEDES
-- 20260724_lab_consumable_units.sql, which was built from the earlier sheet
-- (the same workbook's STORE tab). The two tabs disagree on 14 items: the state
-- store counts several things in packs where a health facility counts them in
-- pieces. commodities.unit is a single value per commodity, so EnVo can hold
-- only one - and the recorded quantities are facility-scale (Vacutainer Needle
-- 82,963 and Pasteur Pipette 37,669 read as individual pieces, not packs), so
-- the HEALTH FACILITY reading is the one that matches the data.
--
-- This sets the unit ABSOLUTELY for all 73 rows rather than filling blanks, so it
-- lands on the same result whether or not the earlier migration was applied.
--
-- Notable corrections vs the earlier sheet:
--   Cryovials (Blue/Red), Butterfly Needle, Benchpad, EDTA Bottle (2/5/10ml),
--   Barcode Ribbon, Facemask, Sharpbox, Needle Holder   pack  -> piece
--   Pasteur Pipette, Vacutainer Needle                  pcs   -> piece  (naming
--     only; these were already counted as pieces, which the sheet confirms)
--   A4 Paper                                            rim   -> ream
--   Handgloves / Methylated Spirit                      plural -> singular
-- EDTA Bottle (5ml), Barcode Ribbon and Facemask also LOSE their pack size: a
-- piece has no pack to break down.
--
-- Only labels change. No quantity, stock row, lot or log is touched.
--
-- Units are stored SINGULAR: the UI pluralises for quantity != 1, so 'piece'
-- renders "1 piece" / "63 pieces". Where the sheet still gives a pack count
-- ("Roll (100 PCS)") the count goes to pack_size with dispensing_unit 'piece',
-- so it reads "1 roll = 100 pieces".
--
-- Idempotent: re-running sets the same values.

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
    ('cryovialsblue', 'piece', null, null),   -- Cryovials (Blue) · piece
    ('cryovialsred', 'piece', null, null),   -- Cryovials (Red) · piece
    ('urinecontainer', 'piece', null, null),   -- Urine Container · Piece
    ('vaccinebox', 'piece', null, null),   -- Vacine Box · Piece
    ('jablobox', 'piece', null, null),   -- Jablo Box · Piece
    ('tissueboxwipes', 'pack', null, null),   -- Tissue Box/Wipes · Pack
    ('kimwipes', 'pack', null, null),   -- Kim wipes · Pack
    ('antiviralspray', 'bottle', null, null),   -- Antiviral Spray · Bottle
    ('absoluteethanol', 'bottle', null, null),   -- Absolute Ethanol · Bottle
    ('pasteurpipette', 'piece', null, null),   -- Pasteur Pipette · piece
    ('alcoholpad', 'pack', null, null),   -- Alcohol Pad · Pack
    ('arcfilejacket', 'piece', null, null),   -- Arc file Jacket · Piece
    ('vacutainerneedle', 'piece', null, null),   -- Vacutainer needle · piece
    ('butterflyneedle', 'piece', null, null),   -- Butterfly Needle · piece
    ('filterpipettetip', 'pack', null, null),   -- Filter pipette tip · pack
    ('disposablelabcoat', 'piece', null, null),   -- Disposable Labcoat · piece
    ('tourniquet', 'piece', null, null),   -- Tourniquet · piece
    ('eyewashstation', 'piece', null, null),   -- Eyewash Station · Piece
    ('handwash', 'bottle', null, null),   -- Handwash · Bottle
    ('handsanitizer', 'bottle', null, null),   -- Handsanitizer · Bottle
    ('cottonwool500g', 'roll', null, null),   -- Cotton wool 500g · Roll
    ('benchpad', 'piece', null, null),   -- Benchpad · piece
    ('biohazardbagyellow', 'roll', '100', 'piece'),   -- Biohazard Bag (Yellow) · Roll (100 PCS)
    ('biohazardbagred', 'roll', '100', 'piece'),   -- Biohazard Bag (Red) · Roll (100 PCS)
    ('biohazardbagblack', 'roll', '100', 'piece'),   -- Biohazard Bag (Black) · Roll (100 PCS)
    ('edtabottle2ml', 'piece', null, null),   -- EDTA Bottle (2ml) · piece
    ('edtabottle5ml', 'piece', null, null),   -- EDTA Bottle (5ml) · piece
    ('edtabottle10ml', 'piece', null, null),   -- EDTA Bottle (10ml) · piece
    ('barcodelabel', 'roll', null, null),   -- Barcode Label · Rolls
    ('barcoderibbon', 'piece', null, null),   -- Barcode Ribbon · piece
    ('timer', 'piece', null, null),   -- Timer · Piece
    ('thermometerwaterbath', 'piece', null, null),   -- Thermometer (Water bath) · Piece
    ('thermometerroom', 'piece', null, null),   -- Thermometer (Room) · Piece
    ('thermometerfreezer', 'piece', null, null),   -- Thermometer (Freezer) · Piece
    ('thermometerrefrigerator', 'piece', null, null),   -- Thermometer (Refrigerator) · Piece
    ('facemask', 'piece', null, null),   -- Facemask · piece
    ('methylatedspirit', 'bottle', null, null),   -- Methylated Spirit · Bottle
    ('envelopesbrown', 'piece', null, null),   -- Envelopes (Brown) · Piece
    ('jik', 'bottle', null, null),   -- Jik · Bottle
    ('sharpbox', 'piece', null, null),   -- Sharpbox · piece
    ('vaginalspeculum', 'piece', null, null),   -- Vaginal Speculum · Piece
    ('needleholder', 'piece', null, null),   -- Needle Holder · piece
    ('harpic', 'bottle', null, null),   -- Harpic · Bottle
    ('urinalysisstrip', 'strip', null, null),   -- Urinalysis Strip · strip
    ('a4paper', 'ream', null, null)   -- A4 Paper · Ream
)
update commodities c
   set unit            = s.unit,
       pack_size       = s.pack_size,
       dispensing_unit = s.dispensing_unit
  from sheet s
 where c.category = 'Lab consumables'
   and lower(regexp_replace(c.name, '[^a-zA-Z0-9]', '', 'g')) = s.key;

commit;
