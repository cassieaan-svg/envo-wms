-- The August 2026 stock-take sheet counted seven items the catalogue does not carry.
-- They are real stock on the shelf, so the catalogue is what is wrong, not the count.
--
-- 'Metronidazole 200mg by 1000' is not a duplicate: the sheet counts the 100-pack and the
-- 1000-pack separately because they are separate lines on the store's price list, and
-- merging them would lose that split. The name carries the pack size because 'unit' is
-- free text across this catalogue and cannot be relied on to tell them apart.
INSERT INTO commodities (name, category, unit) VALUES
  ('Amoxicillin 250mg (Dispersible)',                'Tablets, caplets & capsules', '10'),
  ('Ampicillin 250mg (tab)',                         'Tablets, caplets & capsules', '100'),
  ('Enzoron',                                        'Tablets, caplets & capsules', '30'),
  ('Metronidazole 200mg by 1000',                    'Tablets, caplets & capsules', '1000'),
  ('Tamsulosin 0.4mg',                               'Tablets, caplets & capsules', '30'),
  ('Telmisartan 40mg + Hydrochlorothiazide 12.5mg',  'Tablets, caplets & capsules', '28'),
  ('Oxytocin 10iu',                                  'Injections',                  NULL)
ON CONFLICT DO NOTHING;
