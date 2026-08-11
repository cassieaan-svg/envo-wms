-- The June 2026 "updated corrected" Ministry of Health (Uyo) price list added 11 items
-- that were not yet in the catalogue. All 11 arrived WITHOUT a price in the source
-- (blank or "-"), so they are inserted is_active = FALSE and get NO commodity_prices
-- row: they stay off the requestable catalogue until a real unit price is supplied
-- (set the price, then flip is_active = TRUE). Existing items and prices are untouched.
--
-- Unit is set to '1' (per unit) to match the tablet catalogue convention; correct it
-- when the real price/pack is confirmed.
--
-- Idempotent: each item is inserted only if a commodity of that name does not exist.
-- (The migrate runner wraps this file in its own transaction.)

INSERT INTO commodities (name, category, unit, is_active)
SELECT v.name, v.category, '1', FALSE
FROM (VALUES
  ('Clonazepam 1mg',    'Tablets, caplets & capsules'),
  ('Daravit promo',     'Tablets, caplets & capsules'),
  ('Glasodex 50mg',     'Tablets, caplets & capsules'),
  ('Neurocalm 75mg',    'Tablets, caplets & capsules'),
  ('Rosuvastatin 20mg', 'Tablets, caplets & capsules'),
  ('Strimox 0.5mg',     'Tablets, caplets & capsules'),
  ('Tadalis 20mg',      'Tablets, caplets & capsules'),
  ('Tadalis 5mg',       'Tablets, caplets & capsules'),
  ('Vilget 50/1000mg',  'Tablets, caplets & capsules'),
  ('Vitamin C 500mg',   'Tablets, caplets & capsules'),
  ('Coloprup',          'Syrups & suspensions')
) AS v(name, category)
WHERE NOT EXISTS (SELECT 1 FROM commodities c WHERE c.name = v.name);
