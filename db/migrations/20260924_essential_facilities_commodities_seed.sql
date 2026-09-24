-- Essential Commodities: real facility roster, commodity catalogue, and LGA
-- coverage, exported from the working dev database as a data-only migration.
--
-- Idempotent:
--   commodities  matched by its UNIQUE name column        -> ON CONFLICT (name) DO NOTHING
--   facilities   has no natural unique key, so matched by (name, state) via NOT EXISTS
--   facility_modules matched by its (facility_id, module) primary key -> ON CONFLICT DO NOTHING
--
-- LGAs are not a separate table here -- they live on facilities.lga, so enrolling the
-- facility roster below is what carries every LGA this migration covers.
--
-- Run: node scripts/apply_migration.mjs <this file's name>

begin;

-- ── Commodities (module = 'essential') ──────────────────────────────────────
insert into commodities (name, category, unit, pack_size, dispensing_unit, unit_price, module, item_type, item_code, is_active, description)
values
  ('0.9%Sodium Chloride 1000mls', 'Infusions', '1', null, null, 1280.00, 'essential', 'commodity', null, true, null),
  ('0.9%Sodium Chloride 500mls', 'Infusions', '1', null, null, 620.00, 'essential', 'commodity', null, true, null),
  ('10% dextrose water 500mls', 'Infusions', '1', null, null, 719.00, 'essential', 'commodity', null, true, null),
  ('4.3% Dextrose saline 500mls', 'Infusions', '1', null, null, 750.00, 'essential', 'commodity', null, true, null),
  ('Absorbent Guage roll', 'Consumables', 'roll', null, null, 9380.00, 'essential', 'commodity', null, true, null),
  ('Aceclofenac 100mg', 'Tablets, caplets & capsules', '1', null, null, 71.00, 'essential', 'commodity', null, true, null),
  ('Acetazolamide', 'Tablets, caplets & capsules', '1', null, null, 46.00, 'essential', 'commodity', null, true, null),
  ('Acetylsalicylic Acid 75mg', 'Tablets, caplets & capsules', '1', null, null, 9.00, 'essential', 'commodity', null, true, null),
  ('Actrapid Insulin 100iu', 'Injections', '1', null, null, 20125.00, 'essential', 'commodity', null, true, null),
  ('Adhesive plaster rolls 4’ (small size)', 'Consumables', '1', null, null, 1940.00, 'essential', 'commodity', null, true, null),
  ('Adhesive plaster rolls 6’ (big size)', 'Consumables', '1', null, null, 3125.00, 'essential', 'commodity', null, true, null),
  ('Adrenaline HCL', 'Injections', 'amp', null, null, 450.00, 'essential', 'commodity', null, true, null),
  ('Albendazole 100mg/5ml', 'Syrups & suspensions', '10ml', null, null, 390.00, 'essential', 'commodity', null, true, null),
  ('Albendazole 200mg', 'Tablets, caplets & capsules', '1', null, null, 160.00, 'essential', 'commodity', null, true, null),
  ('Albendazole 400mg', 'Tablets, caplets & capsules', '1', null, null, 290.00, 'essential', 'commodity', null, true, null),
  ('Amiloride + Hydrochlorothiazide (2.5mg +25mg)', 'Tablets, caplets & capsules', '1', null, null, 23.00, 'essential', 'commodity', null, true, null),
  ('Aminophylline 250mg', 'Injections', 'amp', null, null, 240.00, 'essential', 'commodity', null, true, null),
  ('Amiodarone 150mg', 'Injections', '1', null, null, 1788.00, 'essential', 'commodity', null, true, null),
  ('Amiodarone 200mg', 'Tablets, caplets & capsules', '1', null, null, 85.00, 'essential', 'commodity', null, true, null),
  ('Amitriptyline 25mg', 'Tablets, caplets & capsules', '1', null, null, 50.00, 'essential', 'commodity', null, true, null),
  ('Amlodipine + losartan (5mg + 50mg)', 'Tablets, caplets & capsules', '1', null, null, 192.00, 'essential', 'commodity', null, true, null),
  ('Amlodipine 10mg', 'Tablets, caplets & capsules', '1', null, null, 35.00, 'essential', 'commodity', null, true, null),
  ('Amlodipine 5mg', 'Tablets, caplets & capsules', '1', null, null, 22.00, 'essential', 'commodity', null, true, null),
  ('Amoxicillin 125mg/5ml', 'Syrups & suspensions', '100ml', null, null, 1880.00, 'essential', 'commodity', null, true, null),
  ('Amoxicillin 200mg + Clavulanic acid 28.5mg (100ml)', 'Syrups & suspensions', '100ml', null, null, 4490.00, 'essential', 'commodity', null, true, null),
  ('Amoxicillin 200mg + Clavulanic acid 28.5mg (70ml)', 'Syrups & suspensions', '70ml', null, null, 4490.00, 'essential', 'commodity', null, true, null),
  ('Amoxicillin 250mg', 'Tablets, caplets & capsules', '1', null, null, 36.00, 'essential', 'commodity', null, true, null),
  ('Amoxicillin 250mg (Dispersible)', 'Tablets, caplets & capsules', '10', null, null, null, 'essential', 'commodity', null, true, null),
  ('Amoxicillin 250mg (Dispersible) 250mg', 'Tablets, caplets & capsules', '1', null, null, 53.00, 'essential', 'commodity', null, true, null),
  ('Amoxicillin 250mg + clavulanic acid 125mg', 'Tablets, caplets & capsules', '1', null, null, 157.00, 'essential', 'commodity', null, true, null),
  ('Amoxicillin 500mg', 'Tablets, caplets & capsules', '1', null, null, 525.00, 'essential', 'commodity', null, true, null),
  ('Amoxicillin 500MG + clavulanic acid 125mg', 'Tablets, caplets & capsules', '1', null, null, 210.00, 'essential', 'commodity', null, true, null),
  ('Amoxiclav 1.2g', 'Injections', 'vials', null, null, 3375.00, 'essential', 'commodity', null, true, null),
  ('Amoxil 250mg/5ml', 'Syrups & suspensions', '1', null, null, 2125.00, 'essential', 'commodity', null, true, null),
  ('Ampicillin 125mg/5ml', 'Syrups & suspensions', '100ml', null, null, 940.00, 'essential', 'commodity', null, true, null),
  ('Ampicillin 125mg/Cloxacillin 125mg', 'Syrups & suspensions', '100ml', null, null, 1850.00, 'essential', 'commodity', null, true, null),
  ('Ampicillin 250mg (tab)', 'Tablets, caplets & capsules', '100', null, null, null, 'essential', 'commodity', null, true, null),
  ('Ampicillin 250MG + cloxacillin 250mg', 'Tablets, caplets & capsules', '1', null, null, 50.00, 'essential', 'commodity', null, true, null),
  ('Ampicillin 500mg', 'Tablets, caplets & capsules', '1', null, null, 79.00, 'essential', 'commodity', null, true, null),
  ('Ampicillin/Cloxacillin Drops', 'Syrups & suspensions', '1', null, null, 1250.00, 'essential', 'commodity', null, true, null),
  ('Antirabies Vaccine', 'Injections', '1', null, null, 14375.00, 'essential', 'commodity', null, true, null),
  ('Antisnake Venom', 'Injections', '1', null, null, 20000.00, 'essential', 'commodity', null, true, null),
  ('Antitetanus 1500IU', 'Injections', '1', null, null, 540.00, 'essential', 'commodity', null, true, null),
  ('Anusol Suppository', 'Consumables', '1', null, null, 337.00, 'essential', 'commodity', null, true, null),
  ('Artane 5mg (Benzhexol)', 'Tablets, caplets & capsules', '1', null, null, 12.00, 'essential', 'commodity', null, true, null),
  ('Ascorbic acid 100mg', 'Tablets, caplets & capsules', '1', null, null, 5.00, 'essential', 'commodity', null, true, null),
  ('Ascorbic acid 100mg/5ml', 'Syrups & suspensions', '100ml', null, null, 770.00, 'essential', 'commodity', null, true, null),
  ('Astyfer', 'Syrups & suspensions', '200ml', null, null, 4620.00, 'essential', 'commodity', null, true, null),
  ('Astymin', 'Syrups & suspensions', '200ml', null, null, 4620.00, 'essential', 'commodity', null, true, null),
  ('Astymin IV', 'Injections', '1', null, null, 15400.00, 'essential', 'commodity', null, true, null),
  ('Atorvastatin 10mg', 'Tablets, caplets & capsules', '1', null, null, 125.00, 'essential', 'commodity', null, true, null),
  ('Atorvastatin 20mg', 'Tablets, caplets & capsules', '1', null, null, 250.00, 'essential', 'commodity', null, true, null),
  ('Atracorium', 'Injections', '1', null, null, 2200.00, 'essential', 'commodity', null, true, null),
  ('Atropine 0.5mg/ml', 'Injections', 'amp', null, null, 540.00, 'essential', 'commodity', null, true, null),
  ('ATS 1500IU', 'Injections', '1', null, null, 600.00, 'essential', 'commodity', null, true, null),
  ('Avrocid', 'Syrups & suspensions', '200ml', null, null, 2050.00, 'essential', 'commodity', null, true, null),
  ('Azithromycin 250mg/5ml', 'Syrups & suspensions', '30ml', null, null, 1670.00, 'essential', 'commodity', null, true, null),
  ('Azithromycin 500mg', 'Tablets, caplets & capsules', '1', null, null, 4813.00, 'essential', 'commodity', null, true, null),
  ('B. Complex', 'Syrups & suspensions', '100ml', null, null, 713.00, 'essential', 'commodity', null, true, null),
  ('Benzyl Benzoate', 'Consumables', '1', null, null, 1380.00, 'essential', 'commodity', null, true, null),
  ('Betahistine 6mg', 'Tablets, caplets & capsules', '1', null, null, 369.00, 'essential', 'commodity', null, true, null),
  ('Biopentin NT 400mg', 'Tablets, caplets & capsules', '1', null, null, 599.00, 'essential', 'commodity', null, true, null),
  ('Biopentin Plain 300mg', 'Tablets, caplets & capsules', '1', null, null, 3713.00, 'essential', 'commodity', null, true, null),
  ('Bisoprolol 1.5mg', 'Tablets, caplets & capsules', '1', null, null, 86.00, 'essential', 'commodity', null, true, null),
  ('Bisoprolol 2.5mg', 'Tablets, caplets & capsules', '1', null, null, 96.00, 'essential', 'commodity', null, true, null),
  ('Bromazepam 3mg', 'Tablets, caplets & capsules', '1', null, null, 45.00, 'essential', 'commodity', null, true, null),
  ('Broncholyte', 'Syrups & suspensions', '100ml', null, null, 1010.00, 'essential', 'commodity', null, true, null),
  ('Calamine lotion', 'Consumables', '1', null, null, 570.00, 'essential', 'commodity', null, true, null),
  ('Calcium D3', 'Tablets, caplets & capsules', '1', null, null, 756.00, 'essential', 'commodity', null, true, null),
  ('Calcium Gluconate', 'Injections', '1', null, null, 2613.00, 'essential', 'commodity', null, true, null),
  ('Calcium lactate 300mg', 'Tablets, caplets & capsules', '1', null, null, 10.00, 'essential', 'commodity', null, true, null),
  ('Calibrated Drapes', 'Consumables', '1', null, null, 1625.00, 'essential', 'commodity', null, true, null),
  ('Candesartan 8mg', 'Tablets, caplets & capsules', '1', null, null, 207.00, 'essential', 'commodity', null, true, null),
  ('Cannular 18G Green', 'Consumables', '1', null, null, 180.00, 'essential', 'commodity', null, true, null),
  ('Cannular 20G pink', 'Consumables', '1', null, null, 180.00, 'essential', 'commodity', null, true, null),
  ('Cannular 22G blue', 'Consumables', '1', null, null, 190.00, 'essential', 'commodity', null, true, null),
  ('Cannular 24G yellow', 'Consumables', '1', null, null, 193.00, 'essential', 'commodity', null, true, null),
  ('Cap Astyfer', 'Tablets, caplets & capsules', '1', null, null, 154.00, 'essential', 'commodity', null, true, null),
  ('Cap Astymin', 'Tablets, caplets & capsules', '1', null, null, 231.00, 'essential', 'commodity', null, true, null),
  ('Carbamazepine 200mg', 'Tablets, caplets & capsules', '1', null, null, 69.00, 'essential', 'commodity', null, true, null),
  ('Carbetocin', 'Injections', 'amp', null, null, 2025.00, 'essential', 'commodity', null, true, null),
  ('Carvedilol 6.25mg', 'Tablets, caplets & capsules', '1', null, null, 74.00, 'essential', 'commodity', null, true, null),
  ('Catheter 14', 'Consumables', '1', null, null, 915.00, 'essential', 'commodity', null, true, null),
  ('Cefadox 200mg', 'Tablets, caplets & capsules', '1', null, null, 618.00, 'essential', 'commodity', null, true, null),
  ('Cefixime 200mg', 'Tablets, caplets & capsules', '1', null, null, 300.00, 'essential', 'commodity', null, true, null),
  ('Cefixime 400mg', 'Tablets, caplets & capsules', '1', null, null, 338.00, 'essential', 'commodity', null, true, null),
  ('Cefpodoxime 00mg', 'Syrups & suspensions', '1', null, null, 4313.00, 'essential', 'commodity', null, true, null),
  ('Ceftazidime', 'Injections', '1', null, null, 2063.00, 'essential', 'commodity', null, true, null),
  ('Ceftriaxone 1g', 'Injections', '1', null, null, 1065.00, 'essential', 'commodity', null, true, null),
  ('Ceftriaxone 1g+ Sulbactam 0.5g', 'Injections', 'vials', null, null, 2070.00, 'essential', 'commodity', null, true, null),
  ('Cefuroxime 125mg/5ml', 'Syrups & suspensions', '100ml', null, null, 3130.00, 'essential', 'commodity', null, true, null),
  ('Cefuroxime 250mg', 'Tablets, caplets & capsules', '1', null, null, 500.00, 'essential', 'commodity', null, true, null),
  ('Cefuroxime 500mg', 'Tablets, caplets & capsules', '1', null, null, 375.00, 'essential', 'commodity', null, true, null),
  ('Cefuroxime 750mg', 'Injections', '1', null, null, 963.00, 'essential', 'commodity', null, true, null),
  ('Celecoxib 200mg', 'Tablets, caplets & capsules', '1', null, null, 163.00, 'essential', 'commodity', null, true, null),
  ('Cephalexin', 'Syrups & suspensions', '1', null, null, 2875.00, 'essential', 'commodity', null, true, null),
  ('Cephalexin 500mg', 'Tablets, caplets & capsules', '1', null, null, 850.00, 'essential', 'commodity', null, true, null),
  ('Chlorhexidine Diaclikonate gel', 'Consumables', '1', null, null, 1130.00, 'essential', 'commodity', null, true, null),
  ('Chlorpheniramine 2mg/5ml', 'Syrups & suspensions', '100ml', null, null, 875.00, 'essential', 'commodity', null, true, null),
  ('Chlorpheniramine maleate 4mg', 'Tablets, caplets & capsules', '1', null, null, 11.00, 'essential', 'commodity', null, true, null),
  ('Chlorpromazine 100mg', 'Tablets, caplets & capsules', '1', null, null, 35.00, 'essential', 'commodity', null, true, null),
  ('Chlorpromazine 50mg/2ml', 'Injections', 'amp', null, null, 255.00, 'essential', 'commodity', null, true, null),
  ('Chondroitin + Glucosamine', 'Tablets, caplets & capsules', '1', null, null, 220.00, 'essential', 'commodity', null, true, null),
  ('Chromic 0', 'Consumables', '1', null, null, 584.00, 'essential', 'commodity', null, true, null),
  ('Chromic 2/0', 'Consumables', '1', null, null, 584.00, 'essential', 'commodity', null, true, null),
  ('Chromic catgut 1', 'Consumables', '1', null, null, 521.00, 'essential', 'commodity', null, true, null),
  ('Chromic catgut 2', 'Consumables', '1', null, null, 600.00, 'essential', 'commodity', null, true, null),
  ('Chymotrypsin 100000 IU + Trypsin 1400 IU', 'Tablets, caplets & capsules', '1', null, null, 37.00, 'essential', 'commodity', null, true, null),
  ('Cilostazol 10mg', 'Tablets, caplets & capsules', '1', null, null, 642.00, 'essential', 'commodity', null, true, null),
  ('Ciprofloxacin 200mg 100mls', 'Infusions', '1', null, null, 390.00, 'essential', 'commodity', null, true, null),
  ('Ciprofloxacin 500mg', 'Tablets, caplets & capsules', '1', null, null, 82.00, 'essential', 'commodity', null, true, null),
  ('Clarithromycin 500mg', 'Tablets, caplets & capsules', '1', null, null, 390.00, 'essential', 'commodity', null, true, null),
  ('Clindamycin 300mg', 'Injections', '1', null, null, 2063.00, 'essential', 'commodity', null, true, null),
  ('Clonazepam 1mg', 'Tablets, caplets & capsules', '1', null, null, null, 'essential', 'commodity', null, true, null),
  ('Clopidogrel 75mg', 'Tablets, caplets & capsules', '1', null, null, 61.00, 'essential', 'commodity', null, true, null),
  ('Clotrimazole cream', 'Consumables', '1', null, null, 590.00, 'essential', 'commodity', null, true, null),
  ('Clotrimazole pessaries', 'Consumables', '1', null, null, 602.00, 'essential', 'commodity', null, true, null),
  ('Co Approvet 150mg', 'Tablets, caplets & capsules', '1', null, null, 8250.00, 'essential', 'commodity', null, true, null),
  ('Cocodamol 8/500mg', 'Tablets, caplets & capsules', '1', null, null, 375.00, 'essential', 'commodity', null, true, null),
  ('Cognitol', 'Tablets, caplets & capsules', '1', null, null, 135.00, 'essential', 'commodity', null, true, null),
  ('Coloprup', 'Syrups & suspensions', '1', null, null, null, 'essential', 'commodity', null, true, null),
  ('Cord clamp', 'Consumables', '1', null, null, 100.00, 'essential', 'commodity', null, true, null),
  ('Coton wool 100mg', 'Consumables', '1', null, null, 260.00, 'essential', 'commodity', null, true, null),
  ('Cotrimoxazole 240mg/5ml', 'Syrups & suspensions', '50ml', null, null, 860.00, 'essential', 'commodity', null, true, null),
  ('Cotrimoxazole 480mg', 'Tablets, caplets & capsules', '1', null, null, 28.00, 'essential', 'commodity', null, true, null),
  ('Cotton crepe bandage', 'Consumables', '1', null, null, 630.00, 'essential', 'commodity', null, true, null),
  ('Cotton wool 500g hard', 'Consumables', '1', null, null, 4375.00, 'essential', 'commodity', null, true, null),
  ('Cotton wool 500mg soft', 'Consumables', '1', null, null, 3250.00, 'essential', 'commodity', null, true, null),
  ('Cough Adult', 'Syrups & suspensions', '100ml', null, null, 700.00, 'essential', 'commodity', null, true, null),
  ('Cough child', 'Syrups & suspensions', '100ml', null, null, 700.00, 'essential', 'commodity', null, true, null),
  ('Crystalline penicillin 1mu', 'Injections', 'vials', null, null, 240.00, 'essential', 'commodity', null, true, null),
  ('Cytotec', 'Tablets, caplets & capsules', '1', null, null, 928.00, 'essential', 'commodity', null, true, null),
  ('Daravit forte', 'Tablets, caplets & capsules', '1', null, null, 151.00, 'essential', 'commodity', null, true, null),
  ('Daravit Joint active', 'Tablets, caplets & capsules', '1', null, null, 297.00, 'essential', 'commodity', null, true, null),
  ('Daravit promo', 'Tablets, caplets & capsules', '1', null, null, null, 'essential', 'commodity', null, true, null),
  ('Daravit woman', 'Tablets, caplets & capsules', '1', null, null, 256.00, 'essential', 'commodity', null, true, null),
  ('Dermazin', 'Consumables', '1', null, null, 6188.00, 'essential', 'commodity', null, true, null),
  ('Dexamethasone 1mg', 'Tablets, caplets & capsules', '1', null, null, 10.00, 'essential', 'commodity', null, true, null),
  ('Dexamethasone 4mg', 'Injections', 'amp', null, null, 120.00, 'essential', 'commodity', null, true, null),
  ('DF118 30mg', 'Tablets, caplets & capsules', '1', null, null, 550.00, 'essential', 'commodity', null, true, null),
  ('Diamicron 60mg', 'Tablets, caplets & capsules', '1', null, null, 590.00, 'essential', 'commodity', null, true, null),
  ('Diazepam 10mg', 'Injections', 'amp', null, null, 375.00, 'essential', 'commodity', null, true, null),
  ('Diazepam 5mg', 'Tablets, caplets & capsules', '1', null, null, 10.00, 'essential', 'commodity', null, true, null),
  ('Diclofenac 75mg + misoprostol 200mcg', 'Tablets, caplets & capsules', '1', null, null, 219.00, 'essential', 'commodity', null, true, null),
  ('Diclofenac potassium 100mg', 'Tablets, caplets & capsules', '1', null, null, 10.00, 'essential', 'commodity', null, true, null),
  ('Diclofenac potassium 50mg', 'Tablets, caplets & capsules', '1', null, null, 23.00, 'essential', 'commodity', null, true, null),
  ('Diclofenac Sodium 75mg/3ml', 'Injections', 'amp', null, null, 99.00, 'essential', 'commodity', null, true, null),
  ('Diethylcarbamazine 50mg (Cenocide)', 'Tablets, caplets & capsules', '1', null, null, 163.00, 'essential', 'commodity', null, true, null),
  ('Digoxin 25mg', 'Tablets, caplets & capsules', '1', null, null, 44.00, 'essential', 'commodity', null, true, null),
  ('Dispensing envelope', 'Consumables', '1', null, null, 450.00, 'essential', 'commodity', null, true, null),
  ('Disposable needle 21G', 'Consumables', '1', null, null, 20.00, 'essential', 'commodity', null, true, null),
  ('Disposable needle 23G', 'Consumables', '1', null, null, 20.00, 'essential', 'commodity', null, true, null),
  ('Dobutamine 250mg', 'Injections', '1', null, null, 1100.00, 'essential', 'commodity', null, true, null),
  ('Dolometa B', 'Tablets, caplets & capsules', '1', null, null, 54.00, 'essential', 'commodity', null, true, null),
  ('Dopamine 200mg', 'Injections', '1', null, null, 1238.00, 'essential', 'commodity', null, true, null),
  ('Doxazocin 4mg', 'Tablets, caplets & capsules', '1', null, null, 101.00, 'essential', 'commodity', null, true, null),
  ('Doxycycline 100mg', 'Tablets, caplets & capsules', '1', null, null, 33.00, 'essential', 'commodity', null, true, null),
  ('Ecoslim 100mg', 'Tablets, caplets & capsules', '1', null, null, 753.00, 'essential', 'commodity', null, true, null),
  ('Elastoplast dressing', 'Consumables', '1', null, null, 20.00, 'essential', 'commodity', null, true, null),
  ('Eliquis 5mg', 'Tablets, caplets & capsules', '1', null, null, 1008.00, 'essential', 'commodity', null, true, null),
  ('Empiget 10mg', 'Tablets, caplets & capsules', '1', null, null, 344.00, 'essential', 'commodity', null, true, null),
  ('Empiget 25mg', 'Tablets, caplets & capsules', '1', null, null, 550.00, 'essential', 'commodity', null, true, null),
  ('Emzoron', 'Tablets, caplets & capsules', '1', null, null, 87.00, 'essential', 'commodity', null, true, null),
  ('Enzoron', 'Tablets, caplets & capsules', '30', null, null, null, 'essential', 'commodity', null, true, null),
  ('Epiderm cream', 'Consumables', '1', null, null, 900.00, 'essential', 'commodity', null, true, null),
  ('Ergometrine 0.5mg/ml', 'Injections', 'amp', null, null, 1225.00, 'essential', 'commodity', null, true, null),
  ('Erythromycin 125mg/5ml', 'Syrups & suspensions', '100ml', null, null, 1830.00, 'essential', 'commodity', null, true, null),
  ('Erythromycin stearate 250mg', 'Tablets, caplets & capsules', '1', null, null, 150.00, 'essential', 'commodity', null, true, null),
  ('Erythromycin stearate 500mg', 'Tablets, caplets & capsules', '1', null, null, 179.00, 'essential', 'commodity', null, true, null),
  ('Erythropoietin 40mg', 'Injections', '1', null, null, 7563.00, 'essential', 'commodity', null, true, null),
  ('Esofag Kit', 'Tablets, caplets & capsules', '1', null, null, 15125.00, 'essential', 'commodity', null, true, null),
  ('Evening Primrose', 'Tablets, caplets & capsules', '1', null, null, 185.00, 'essential', 'commodity', null, true, null),
  ('Examination gloves', 'Consumables', '1', null, null, 103.00, 'essential', 'commodity', null, true, null),
  ('Exforge 10/160/12.5mg', 'Tablets, caplets & capsules', '1', null, null, 1558.00, 'essential', 'commodity', null, true, null),
  ('Fentanyl', 'Injections', '1', null, null, 9625.00, 'essential', 'commodity', null, true, null),
  ('Ferobin', 'Syrups & suspensions', '200ml', null, null, 2595.00, 'essential', 'commodity', null, true, null),
  ('Ferobin Plus', 'Tablets, caplets & capsules', '1', null, null, 48.00, 'essential', 'commodity', null, true, null),
  ('Ferotal', 'Syrups & suspensions', '100ml', null, null, 1082.00, 'essential', 'commodity', null, true, null),
  ('Ferrous sulphate 200mg', 'Tablets, caplets & capsules', '1', null, null, 3.00, 'essential', 'commodity', null, true, null),
  ('Finasteride 5mg', 'Tablets, caplets & capsules', '1', null, null, 152.00, 'essential', 'commodity', null, true, null),
  ('Fluconazole 150mg', 'Tablets, caplets & capsules', '1', null, null, 115.00, 'essential', 'commodity', null, true, null),
  ('Fluconazole 200mg', 'Tablets, caplets & capsules', '1', null, null, 1100.00, 'essential', 'commodity', null, true, null),
  ('Fluoxetine 20mg', 'Tablets, caplets & capsules', '1', null, null, 138.00, 'essential', 'commodity', null, true, null),
  ('Fluphenazine', 'Injections', '1', null, null, 607.00, 'essential', 'commodity', null, true, null),
  ('Folic acid 5mg', 'Tablets, caplets & capsules', '1', null, null, 4.00, 'essential', 'commodity', null, true, null),
  ('Folly Catheter 16', 'Consumables', '1', null, null, 1090.00, 'essential', 'commodity', null, true, null),
  ('Folly catheter 18', 'Consumables', '1', null, null, 1090.00, 'essential', 'commodity', null, true, null),
  ('Frusemide 20mg/2ml', 'Injections', 'amp', null, null, 71.00, 'essential', 'commodity', null, true, null),
  ('Frusemide 40mg', 'Tablets, caplets & capsules', '1', null, null, 15.00, 'essential', 'commodity', null, true, null),
  ('Fungbact A', 'Consumables', '1', null, null, 875.00, 'essential', 'commodity', null, true, null),
  ('Gascol', 'Syrups & suspensions', '150ml', null, null, 2275.00, 'essential', 'commodity', null, true, null),
  ('Gentamycin 80mg/2ml', 'Injections', '1', null, null, 94.00, 'essential', 'commodity', null, true, null),
  ('Gentamycin cream', 'Consumables', '1', null, null, 880.00, 'essential', 'commodity', null, true, null),
  ('Gentian violet', 'Consumables', '1', null, null, 570.00, 'essential', 'commodity', null, true, null),
  ('Glasodex 50mg', 'Tablets, caplets & capsules', '1', null, null, null, 'essential', 'commodity', null, true, null),
  ('Glibenclamide 5mg', 'Tablets, caplets & capsules', '1', null, null, 9.00, 'essential', 'commodity', null, true, null),
  ('Glimepiride 4mg', 'Tablets, caplets & capsules', '1', null, null, 149.00, 'essential', 'commodity', null, true, null),
  ('Glucose 10% in Water 500ml', 'Infusions', '1', null, null, 719.00, 'essential', 'commodity', null, true, null),
  ('Glucose 5% in saline 1L', 'Infusions', '1', null, null, 1280.00, 'essential', 'commodity', null, true, null),
  ('Glucose 5% in saline 500mls', 'Infusions', '1', null, null, 620.00, 'essential', 'commodity', null, true, null),
  ('Glucose 5% in water 500mls', 'Infusions', '1', null, null, 620.00, 'essential', 'commodity', null, true, null),
  ('Glucose strip (FINETEST)', 'Consumables', '1', null, null, 250.00, 'essential', 'commodity', null, true, null),
  ('Glycopyrrolate', 'Injections', '1', null, null, 894.00, 'essential', 'commodity', null, true, null),
  ('Guage bandage 6’', 'Consumables', '1', null, null, 280.00, 'essential', 'commodity', null, true, null),
  ('Gutt Antallerge', 'Ophthalmic preparations', '1', null, null, 1700.00, 'essential', 'commodity', null, true, null),
  ('Gutt Bet – N', 'Ophthalmic preparations', '1', null, null, 582.00, 'essential', 'commodity', null, true, null),
  ('Gutt Brimonidine', 'Ophthalmic preparations', '1', null, null, 3595.00, 'essential', 'commodity', null, true, null),
  ('Gutt Cataract eye drop', 'Ophthalmic preparations', '1', null, null, 3190.00, 'essential', 'commodity', null, true, null),
  ('Gutt Chloramphenicol', 'Ophthalmic preparations', '1', null, null, 580.00, 'essential', 'commodity', null, true, null),
  ('Gutt Ciprofloxacin', 'Ophthalmic preparations', '1', null, null, 744.00, 'essential', 'commodity', null, true, null),
  ('Gutt Dexamethasone', 'Ophthalmic preparations', '1', null, null, 1870.00, 'essential', 'commodity', null, true, null),
  ('Gutt Diclofenac eye drop', 'Ophthalmic preparations', '1', null, null, 1280.00, 'essential', 'commodity', null, true, null),
  ('Gutt Gentamicin', 'Ophthalmic preparations', '1', null, null, 600.00, 'essential', 'commodity', null, true, null),
  ('Gutt Hypromellose', 'Ophthalmic preparations', '1', null, null, 1700.00, 'essential', 'commodity', null, true, null),
  ('Gutt Ivycrom eye drop', 'Ophthalmic preparations', '1', null, null, 3510.00, 'essential', 'commodity', null, true, null),
  ('Gutt Ivyflur', 'Ophthalmic preparations', '1', null, null, 3575.00, 'essential', 'commodity', null, true, null),
  ('Gutt Ivymoicell Prost', 'Ophthalmic preparations', '1', null, null, 1600.00, 'essential', 'commodity', null, true, null),
  ('Gutt Ivyxolol eye drop', 'Ophthalmic preparations', '1', null, null, 3770.00, 'essential', 'commodity', null, true, null),
  ('Gutt Maxitrol', 'Ophthalmic preparations', '1', null, null, 7910.00, 'essential', 'commodity', null, true, null),
  ('Gutt Misopt', 'Ophthalmic preparations', '1', null, null, 6420.00, 'essential', 'commodity', null, true, null),
  ('Gutt Moxifloxacin', 'Ophthalmic preparations', '1', null, null, 1988.00, 'essential', 'commodity', null, true, null),
  ('Gutt Olapotadine', 'Ophthalmic preparations', '1', null, null, 3165.00, 'essential', 'commodity', null, true, null),
  ('Gutt Proist', 'Ophthalmic preparations', '1', null, null, 1415.00, 'essential', 'commodity', null, true, null),
  ('Gutt Proist Plus', 'Ophthalmic preparations', '1', null, null, 3400.00, 'essential', 'commodity', null, true, null),
  ('Gutt Prollerg', 'Ophthalmic preparations', '1', null, null, 1415.00, 'essential', 'commodity', null, true, null),
  ('Gutt Timolol', 'Ophthalmic preparations', '1', null, null, 1095.00, 'essential', 'commodity', null, true, null),
  ('Gutt Tobramycin', 'Ophthalmic preparations', '1', null, null, 1540.00, 'essential', 'commodity', null, true, null),
  ('Gutt Tobramycin/ Dexamethasone', 'Ophthalmic preparations', '1', null, null, 920.00, 'essential', 'commodity', null, true, null),
  ('Gutt Tropicamide', 'Ophthalmic preparations', '1', null, null, 2875.00, 'essential', 'commodity', null, true, null),
  ('Gutt Xydoz –T', 'Ophthalmic preparations', '1', null, null, 3845.00, 'essential', 'commodity', null, true, null),
  ('Gutt Xylase T', 'Ophthalmic preparations', '1', null, null, 7175.00, 'essential', 'commodity', null, true, null),
  ('Gutt Xytica', 'Ophthalmic preparations', '1', null, null, 5125.00, 'essential', 'commodity', null, true, null),
  ('Haemoforce forte', 'Syrups & suspensions', '100ml', null, null, 2430.00, 'essential', 'commodity', null, true, null),
  ('Haloperidol', 'Injections', 'amp', null, null, 563.00, 'essential', 'commodity', null, true, null),
  ('Haloperidol 10mg', 'Tablets, caplets & capsules', '1', null, null, 19.00, 'essential', 'commodity', null, true, null),
  ('Haloperidol 5mg', 'Tablets, caplets & capsules', '1', null, null, 17.00, 'essential', 'commodity', null, true, null),
  ('Heavy Vaccine', 'Injections', '1', null, null, 2800.00, 'essential', 'commodity', null, true, null),
  ('Hemoforce Forte', 'Tablets, caplets & capsules', '1', null, null, 84.00, 'essential', 'commodity', null, true, null),
  ('Hemoforce Plus', 'Syrups & suspensions', '1', null, null, 2298.00, 'essential', 'commodity', null, true, null),
  ('Heparin', 'Injections', '1', null, null, 5225.00, 'essential', 'commodity', null, true, null),
  ('Hydrochlorothiazide 25mg', 'Tablets, caplets & capsules', '1', null, null, 18.00, 'essential', 'commodity', null, true, null),
  ('Hydrocortisone 100mg', 'Injections', '1', null, null, 498.00, 'essential', 'commodity', null, true, null),
  ('Hydrocortisone Cream', 'Consumables', '1', null, null, 1035.00, 'essential', 'commodity', null, true, null),
  ('Hydrogen Peroxide 100ml', 'Consumables', '1', null, null, 575.00, 'essential', 'commodity', null, true, null),
  ('Hyoscine-N-Butyl Bromide', 'Tablets, caplets & capsules', '1', null, null, 23.00, 'essential', 'commodity', null, true, null),
  ('Hyoscine-N-Butylbromide 5mg/5ml', 'Syrups & suspensions', '60ml', null, null, 1010.00, 'essential', 'commodity', null, true, null),
  ('Hyoscine N-Butyl Bromide 20mg/ml', 'Injections', 'vials', null, null, 77.00, 'essential', 'commodity', null, true, null),
  ('Hypodermic syringe 10ml', 'Consumables', '1', null, null, 67.00, 'essential', 'commodity', null, true, null),
  ('Hypodermic syringe 2ml', 'Consumables', '1', null, null, 42.00, 'essential', 'commodity', null, true, null),
  ('Hypodermic syringe 5ml', 'Consumables', '1', null, null, 43.00, 'essential', 'commodity', null, true, null),
  ('Ibuprofen 100mg/5ml', 'Syrups & suspensions', '100ml', null, null, 710.00, 'essential', 'commodity', null, true, null),
  ('Ibuprofen 200mg', 'Tablets, caplets & capsules', '1', null, null, 20.00, 'essential', 'commodity', null, true, null),
  ('Ibuprofen 400mg', 'Tablets, caplets & capsules', '1', null, null, 6.00, 'essential', 'commodity', null, true, null),
  ('Indapamide 1.5mg', 'Tablets, caplets & capsules', '1', null, null, 221.00, 'essential', 'commodity', null, true, null),
  ('Infusion set', 'Consumables', '1', null, null, 193.00, 'essential', 'commodity', null, true, null),
  ('Iodine tincture', 'Consumables', '1', null, null, 650.00, 'essential', 'commodity', null, true, null),
  ('Ipratromium Nebules', 'Consumables', '1', null, null, 16958.00, 'essential', 'commodity', null, true, null),
  ('Iron Sucrose', 'Injections', 'amp', null, null, 1650.00, 'essential', 'commodity', null, true, null),
  ('Isoflurane', 'Injections', '1', null, null, 68750.00, 'essential', 'commodity', null, true, null),
  ('Isoplama', 'Injections', '1', null, null, 1238.00, 'essential', 'commodity', null, true, null),
  ('Ivermectin 3mg', 'Tablets, caplets & capsules', '1', null, null, 20.00, 'essential', 'commodity', null, true, null),
  ('Izal', 'Consumables', '4L', null, null, 27315.00, 'essential', 'commodity', null, true, null),
  ('Jawaron', 'Tablets, caplets & capsules', '1', null, null, 1513.00, 'essential', 'commodity', null, true, null),
  ('Jik (sodium hypochlorite) 1.4L', 'Consumables', '1', null, null, 7250.00, 'essential', 'commodity', null, true, null),
  ('Ketamine', 'Injections', '1', null, null, 3019.00, 'essential', 'commodity', null, true, null),
  ('Ketoconazole 200mg', 'Tablets, caplets & capsules', '1', null, null, 59.00, 'essential', 'commodity', null, true, null),
  ('Ketoconazole Cream', 'Consumables', '1', null, null, 795.00, 'essential', 'commodity', null, true, null),
  ('Klovinal', 'Consumables', '1', null, null, 840.00, 'essential', 'commodity', null, true, null),
  ('Kotase', 'Tablets, caplets & capsules', '1', null, null, 123.00, 'essential', 'commodity', null, true, null),
  ('Labetalol', 'Injections', 'vials', null, null, 2688.00, 'essential', 'commodity', null, true, null),
  ('Lantus', 'Injections', '1', null, null, 20000.00, 'essential', 'commodity', null, true, null),
  ('Levetiracetam 500mg', 'Tablets, caplets & capsules', '1', null, null, 124.00, 'essential', 'commodity', null, true, null),
  ('Levofloxacin 500mg', 'Tablets, caplets & capsules', '1', null, null, 144.00, 'essential', 'commodity', null, true, null),
  ('Levofloxacin 500mg 100mls', 'Infusions', '1', null, null, 580.00, 'essential', 'commodity', null, true, null),
  ('Levofloxacin 750mg', 'Tablets, caplets & capsules', '1', null, null, 173.00, 'essential', 'commodity', null, true, null),
  ('Lidocaine + Adrenaline', 'Injections', 'vials', null, null, 1510.00, 'essential', 'commodity', null, true, null),
  ('Lidocaine 2% 20mg/ml', 'Injections', 'vials', null, null, 1440.00, 'essential', 'commodity', null, true, null),
  ('Linagliptin 5mg', 'Tablets, caplets & capsules', '1', null, null, 642.00, 'essential', 'commodity', null, true, null),
  ('Lisinopril 10mg', 'Tablets, caplets & capsules', '1', null, null, 30.00, 'essential', 'commodity', null, true, null),
  ('Lisinopril 5mg', 'Tablets, caplets & capsules', '1', null, null, 25.00, 'essential', 'commodity', null, true, null),
  ('Livolyn Forte', 'Tablets, caplets & capsules', '1', null, null, 390.00, 'essential', 'commodity', null, true, null),
  ('Loperamide 2mg', 'Tablets, caplets & capsules', '1', null, null, 22.00, 'essential', 'commodity', null, true, null),
  ('Loratadine 10mg', 'Tablets, caplets & capsules', '1', null, null, 19.00, 'essential', 'commodity', null, true, null),
  ('Loratadine 5mg/5ml', 'Syrups & suspensions', '1', null, null, 860.00, 'essential', 'commodity', null, true, null),
  ('Losartan sodium + hydrochlorothiazide (50mg + 12.5mg)', 'Tablets, caplets & capsules', '1', null, null, 165.00, 'essential', 'commodity', null, true, null),
  ('Losartan sodium 100mg', 'Tablets, caplets & capsules', '1', null, null, 65.00, 'essential', 'commodity', null, true, null),
  ('Losartan sodium 50mg', 'Tablets, caplets & capsules', '1', null, null, 50.00, 'essential', 'commodity', null, true, null),
  ('Magnarite', 'Syrups & suspensions', '200ml', null, null, 2063.00, 'essential', 'commodity', null, true, null),
  ('Magnavite', 'Tablets, caplets & capsules', '1', null, null, 71.00, 'essential', 'commodity', null, true, null),
  ('Magnesium sulphate 50% in 10ml', 'Injections', 'amp', null, null, 690.00, 'essential', 'commodity', null, true, null),
  ('Magnesium trisilicate (MMT)', 'Tablets, caplets & capsules', '1', null, null, 23.00, 'essential', 'commodity', null, true, null),
  ('Magsil', 'Syrups & suspensions', '200ml', null, null, 1130.00, 'essential', 'commodity', null, true, null),
  ('Mannitol 20% solution 500mls', 'Infusions', '1', null, null, 1610.00, 'essential', 'commodity', null, true, null),
  ('Mebendazole 100mg', 'Tablets, caplets & capsules', '1', null, null, 44.00, 'essential', 'commodity', null, true, null),
  ('Meconerv forte', 'Tablets, caplets & capsules', '1', null, null, 288.00, 'essential', 'commodity', null, true, null),
  ('Meropenem', 'Injections', '1', null, null, 9625.00, 'essential', 'commodity', null, true, null),
  ('Metformin 500mg', 'Tablets, caplets & capsules', '1', null, null, 25.00, 'essential', 'commodity', null, true, null),
  ('Methocarbamol 500mg', 'Tablets, caplets & capsules', '1', null, null, 130.00, 'essential', 'commodity', null, true, null),
  ('Methylated spirit 200ml', 'Consumables', '1', null, null, 1630.00, 'essential', 'commodity', null, true, null),
  ('Methylated spirit 4L', 'Consumables', '1', null, null, 5750.00, 'essential', 'commodity', null, true, null),
  ('Methyldopa 250mg', 'Tablets, caplets & capsules', '1', null, null, 115.00, 'essential', 'commodity', null, true, null),
  ('Methylprednisolone 500mg', 'Injections', '1', null, null, 689.00, 'essential', 'commodity', null, true, null),
  ('Metoclopramide 10mg', 'Tablets, caplets & capsules', '1', null, null, 9.00, 'essential', 'commodity', null, true, null),
  ('Metoclopramide 50mg/2ml', 'Injections', 'amp', null, null, 78.00, 'essential', 'commodity', null, true, null),
  ('Metoprolol 50mg', 'Tablets, caplets & capsules', '1', null, null, 78.00, 'essential', 'commodity', null, true, null),
  ('Metronidazole 200mg', 'Tablets, caplets & capsules', '1', null, null, 12.00, 'essential', 'commodity', null, true, null),
  ('Metronidazole 200mg by 1000', 'Tablets, caplets & capsules', '1000', null, null, null, 'essential', 'commodity', null, true, null),
  ('Metronidazole 200mg/5ml', 'Syrups & suspensions', '1', null, null, 710.00, 'essential', 'commodity', null, true, null),
  ('Metronidazole 400mg', 'Tablets, caplets & capsules', '1', null, null, 17.00, 'essential', 'commodity', null, true, null),
  ('Metronidazole 500mg 100mls', 'Infusions', '1', null, null, 480.00, 'essential', 'commodity', null, true, null),
  ('Mic Attix', 'Tablets, caplets & capsules', '1', null, null, 233.00, 'essential', 'commodity', null, true, null),
  ('Misoprostol 200mcg', 'Tablets, caplets & capsules', '1', null, null, 313.00, 'essential', 'commodity', null, true, null),
  ('Mixtard', 'Injections', '1', null, null, 20843.00, 'essential', 'commodity', null, true, null),
  ('MMT', 'Syrups & suspensions', '15ml', null, null, 1125.00, 'essential', 'commodity', null, true, null),
  ('MMT(HMB)', 'Syrups & suspensions', '1', null, null, 1125.00, 'essential', 'commodity', null, true, null),
  ('Moduretic', 'Tablets, caplets & capsules', '1', null, null, 23.00, 'essential', 'commodity', null, true, null),
  ('Montelukast 10mg', 'Tablets, caplets & capsules', '1', null, null, 183.00, 'essential', 'commodity', null, true, null),
  ('Morphine', 'Injections', '1', null, null, 9057.00, 'essential', 'commodity', null, true, null),
  ('MRDT X 25', 'Consumables', '1', null, null, 776.00, 'essential', 'commodity', null, true, null),
  ('Multivite', 'Tablets, caplets & capsules', '1', null, null, 650.00, 'essential', 'commodity', null, true, null),
  ('Multivite drops', 'Syrups & suspensions', '1', null, null, 880.00, 'essential', 'commodity', null, true, null),
  ('Mupirocin', 'Consumables', 'Tube', null, null, 2340.00, 'essential', 'commodity', null, true, null),
  ('Natrixam 1.5mg/10mg', 'Tablets, caplets & capsules', '1', null, null, 252.00, 'essential', 'commodity', null, true, null),
  ('Neostigmine 2.5mg', 'Injections', '1', null, null, 963.00, 'essential', 'commodity', null, true, null),
  ('Neurocalm 75mg', 'Tablets, caplets & capsules', '1', null, null, null, 'essential', 'commodity', null, true, null),
  ('Neurogesic ointment 35g', 'Consumables', '1', null, null, 2000.00, 'essential', 'commodity', null, true, null),
  ('Neurogesic ointment 85g', 'Consumables', '1', null, null, 2850.00, 'essential', 'commodity', null, true, null),
  ('Neurovite forte', 'Tablets, caplets & capsules', '1', null, null, 144.00, 'essential', 'commodity', null, true, null),
  ('Neurozam', 'Tablets, caplets & capsules', '1', null, null, 848.00, 'essential', 'commodity', null, true, null),
  ('NG Tube Size 10', 'Consumables', '1', null, null, 795.00, 'essential', 'commodity', null, true, null),
  ('NG Tube Size 14', 'Consumables', '1', null, null, 795.00, 'essential', 'commodity', null, true, null),
  ('NG Tube Size 16', 'Consumables', '1', null, null, 795.00, 'essential', 'commodity', null, true, null),
  ('NG Tube Size 4', 'Consumables', '1', null, null, 795.00, 'essential', 'commodity', null, true, null),
  ('NG Tube Size 6', 'Consumables', '1', null, null, 795.00, 'essential', 'commodity', null, true, null),
  ('NG Tube Size 8', 'Consumables', '1', null, null, 795.00, 'essential', 'commodity', null, true, null),
  ('Nifecard 30mg', 'Tablets, caplets & capsules', '1', null, null, 207.00, 'essential', 'commodity', null, true, null),
  ('Nifedipine 20mg', 'Tablets, caplets & capsules', '1', null, null, 20.00, 'essential', 'commodity', null, true, null),
  ('Nimodipine 30mg', 'Tablets, caplets & capsules', '1', null, null, 596.00, 'essential', 'commodity', null, true, null),
  ('Nitrofurantoin 100mg', 'Tablets, caplets & capsules', '1', null, null, 13.00, 'essential', 'commodity', null, true, null),
  ('Noradrenaline', 'Injections', '1', null, null, 825.00, 'essential', 'commodity', null, true, null),
  ('Nospamin', 'Syrups & suspensions', '1', null, null, 815.00, 'essential', 'commodity', null, true, null),
  ('Nylon 0', 'Consumables', '1', null, null, 329.00, 'essential', 'commodity', null, true, null),
  ('Nylon 1', 'Consumables', '1', null, null, 329.00, 'essential', 'commodity', null, true, null),
  ('Nylon 2', 'Consumables', '1', null, null, 329.00, 'essential', 'commodity', null, true, null),
  ('Nystatin vaginal pessary', 'Consumables', '1', null, null, 103.00, 'essential', 'commodity', null, true, null),
  ('OCC Chloramphenicol', 'Ophthalmic preparations', '1', null, null, 520.00, 'essential', 'commodity', null, true, null),
  ('Ofloxacin 400mg', 'Tablets, caplets & capsules', '1', null, null, 73.00, 'essential', 'commodity', null, true, null),
  ('Olanzapine 10mg', 'Tablets, caplets & capsules', '1', null, null, 163.00, 'essential', 'commodity', null, true, null),
  ('Olanzapine 5mg', 'Tablets, caplets & capsules', '1', null, null, 138.00, 'essential', 'commodity', null, true, null),
  ('Omeprazole 20mg', 'Tablets, caplets & capsules', '1', null, null, 75.00, 'essential', 'commodity', null, true, null),
  ('Omeprazole 40mg', 'Injections', 'vials', null, null, 820.00, 'essential', 'commodity', null, true, null),
  ('Ondansetron 8mg', 'Injections', '1', null, null, 2200.00, 'essential', 'commodity', null, true, null),
  ('ORS', 'Infusions', '1', null, null, 190.00, 'essential', 'commodity', null, true, null),
  ('Oxytocin 101u', 'Injections', 'amp', null, null, 220.00, 'essential', 'commodity', null, true, null),
  ('Oxytocin 10iu', 'Injections', null, null, null, null, 'essential', 'commodity', null, true, null),
  ('Pancuronium', 'Injections', '1', null, null, 1170.00, 'essential', 'commodity', null, true, null),
  ('Paracetamol 125mg/5ml', 'Syrups & suspensions', '15ml', null, null, 690.00, 'essential', 'commodity', null, true, null),
  ('Paracetamol 300mg/2ml', 'Injections', 'amp', null, null, 94.00, 'essential', 'commodity', null, true, null),
  ('Paracetamol 500mg', 'Tablets, caplets & capsules', '1', null, null, 9.00, 'essential', 'commodity', null, true, null),
  ('Paracetamol drops 120mg/5ml', 'Syrups & suspensions', '60ml', null, null, 880.00, 'essential', 'commodity', null, true, null),
  ('Paracetamol suppository', 'Consumables', '1', null, null, 525.00, 'essential', 'commodity', null, true, null),
  ('Paraldehyde', 'Injections', 'amp', null, null, 910.00, 'essential', 'commodity', null, true, null),
  ('Pardopa 275mg', 'Tablets, caplets & capsules', '1', null, null, 367.00, 'essential', 'commodity', null, true, null),
  ('Pentazocine 30mg/ml', 'Injections', 'amp', null, null, 688.00, 'essential', 'commodity', null, true, null),
  ('Permethrin cream', 'Consumables', '1', null, null, 2000.00, 'essential', 'commodity', null, true, null),
  ('Pethidine', 'Injections', '1', null, null, 10725.00, 'essential', 'commodity', null, true, null),
  ('Phenobarbitone 30mg', 'Tablets, caplets & capsules', '1', null, null, 23.00, 'essential', 'commodity', null, true, null),
  ('Phenobarbitone 30mg/5ml', 'Syrups & suspensions', '15ml', null, null, 1875.00, 'essential', 'commodity', null, true, null),
  ('Phenytoin 10mg', 'Tablets, caplets & capsules', '1', null, null, 37.00, 'essential', 'commodity', null, true, null),
  ('Phenytoin 250mg', 'Injections', '1', null, null, 21945.00, 'essential', 'commodity', null, true, null),
  ('Piroxicam 20mg', 'Tablets, caplets & capsules', '1', null, null, 19.00, 'essential', 'commodity', null, true, null),
  ('Plain Marcaine', 'Injections', '1', null, null, 6190.00, 'essential', 'commodity', null, true, null),
  ('Potassium chloride 20%', 'Injections', '1', null, null, 825.00, 'essential', 'commodity', null, true, null),
  ('Povidone Iodine 10% 2L', 'Consumables', '1', null, null, 39000.00, 'essential', 'commodity', null, true, null),
  ('Prednisolone 5mg', 'Tablets, caplets & capsules', '1', null, null, 10.00, 'essential', 'commodity', null, true, null),
  ('Pregabalin 75mg', 'Tablets, caplets & capsules', '1', null, null, 316.00, 'essential', 'commodity', null, true, null),
  ('Pregnancy test strip', 'Consumables', '1', null, null, 100.00, 'essential', 'commodity', null, true, null),
  ('Promethazine', 'Injections', 'amp', null, null, 87.00, 'essential', 'commodity', null, true, null),
  ('Promethazine 5mg/5ml', 'Syrups & suspensions', '60ml', null, null, 450.00, 'essential', 'commodity', null, true, null),
  ('Propofol', 'Injections', '1', null, null, 3438.00, 'essential', 'commodity', null, true, null),
  ('Proprandol 40mg', 'Tablets, caplets & capsules', '1', null, null, 83.00, 'essential', 'commodity', null, true, null),
  ('Purit 4L', 'Consumables', '1', null, null, 24375.00, 'essential', 'commodity', null, true, null),
  ('Pyrantel Pamoate 15mg', 'Tablets, caplets & capsules', '1', null, null, 142.00, 'essential', 'commodity', null, true, null),
  ('Pyrantel pamoate 50mg/ml', 'Syrups & suspensions', '60ml', null, null, 2000.00, 'essential', 'commodity', null, true, null),
  ('Quinine 300mg/ml', 'Injections', '1', null, null, 500.00, 'essential', 'commodity', null, true, null),
  ('Rabies vaccine', 'Injections', '1', null, null, 13750.00, 'essential', 'commodity', null, true, null),
  ('Ramipril 10mg', 'Tablets, caplets & capsules', '1', null, null, 161.00, 'essential', 'commodity', null, true, null),
  ('Ranferon -12', 'Syrups & suspensions', '15ml', null, null, 1625.00, 'essential', 'commodity', null, true, null),
  ('Ringer’s lactate 500mls', 'Infusions', '1', null, null, 750.00, 'essential', 'commodity', null, true, null),
  ('Rocephin', 'Injections', '1', null, null, 7420.00, 'essential', 'commodity', null, true, null),
  ('Rosuvastatin 10mg', 'Tablets, caplets & capsules', '1', null, null, 138.00, 'essential', 'commodity', null, true, null),
  ('Rosuvastatin 20mg', 'Tablets, caplets & capsules', '1', null, null, null, 'essential', 'commodity', null, true, null),
  ('Salbutamol 2mg/5ml', 'Syrups & suspensions', '1', null, null, 1070.00, 'essential', 'commodity', null, true, null),
  ('Salbutamol 4mg', 'Tablets, caplets & capsules', '1', null, null, 8.00, 'essential', 'commodity', null, true, null),
  ('Salbutamol Inhaler', 'Consumables', '1', null, null, 1230.00, 'essential', 'commodity', null, true, null),
  ('Scalp vein 21G', 'Consumables', '1', null, null, 125.00, 'essential', 'commodity', null, true, null),
  ('Scalp vein 23G', 'Consumables', '1', null, null, 125.00, 'essential', 'commodity', null, true, null),
  ('Sertraline 50mg', 'Tablets, caplets & capsules', '1', null, null, 252.00, 'essential', 'commodity', null, true, null),
  ('Silk', 'Consumables', '1', null, null, 438.00, 'essential', 'commodity', null, true, null),
  ('Sirdalud 4mg', 'Tablets, caplets & capsules', '1', null, null, 387.00, 'essential', 'commodity', null, true, null),
  ('Skineal cream', 'Consumables', '1', null, null, 1380.00, 'essential', 'commodity', null, true, null),
  ('Slow K 600mg', 'Tablets, caplets & capsules', '1', null, null, 155.00, 'essential', 'commodity', null, true, null),
  ('Sodium Bicarbonate', 'Injections', 'vials', null, null, 825.00, 'essential', 'commodity', null, true, null),
  ('Sodium Valproate', 'Injections', 'vials', null, null, 2338.00, 'essential', 'commodity', null, true, null),
  ('Solifenacin 10mg', 'Tablets, caplets & capsules', '1', null, null, 298.00, 'essential', 'commodity', null, true, null),
  ('Soluset', 'Consumables', '1', null, null, 2425.00, 'essential', 'commodity', null, true, null),
  ('Spinal Needle', 'Consumables', '1', null, null, 863.00, 'essential', 'commodity', null, true, null),
  ('Spirocard 25mg', 'Tablets, caplets & capsules', '1', null, null, 68.00, 'essential', 'commodity', null, true, null),
  ('Spironolactone 25mg', 'Tablets, caplets & capsules', '1', null, null, 132.00, 'essential', 'commodity', null, true, null),
  ('Strimox 0.5mg', 'Tablets, caplets & capsules', '1', null, null, null, 'essential', 'commodity', null, true, null),
  ('Stugeron 25mg (Cinnarizine)', 'Tablets, caplets & capsules', '1', null, null, 139.00, 'essential', 'commodity', null, true, null),
  ('Sulphadoxine 500mg + Pyrimethamine 25mg', 'Tablets, caplets & capsules', '1', null, null, 243.00, 'essential', 'commodity', null, true, null),
  ('Sulphur Ointment', 'Consumables', '1', null, null, 1000.00, 'essential', 'commodity', null, true, null),
  ('Surgical blades x 100', 'Consumables', '1', null, null, 75.00, 'essential', 'commodity', null, true, null),
  ('Surgical gloves', 'Consumables', '1', null, null, 370.00, 'essential', 'commodity', null, true, null),
  ('Suxamethoium', 'Injections', '1', null, null, 757.00, 'essential', 'commodity', null, true, null),
  ('Syschol 500mg', 'Injections', '1', null, null, 11688.00, 'essential', 'commodity', null, true, null),
  ('Tadalis 20mg', 'Tablets, caplets & capsules', '1', null, null, null, 'essential', 'commodity', null, true, null),
  ('Tadalis 5mg', 'Tablets, caplets & capsules', '1', null, null, null, 'essential', 'commodity', null, true, null),
  ('Tamsolusin 0.4mg', 'Tablets, caplets & capsules', '1', null, null, 145.00, 'essential', 'commodity', null, true, null),
  ('Tamsulosin + Dutasteride', 'Tablets, caplets & capsules', '1', null, null, 383.00, 'essential', 'commodity', null, true, null),
  ('Tamsulosin 0.4mg', 'Tablets, caplets & capsules', '30', null, null, null, 'essential', 'commodity', null, true, null),
  ('Telmisartan 40mg', 'Tablets, caplets & capsules', '1', null, null, 220.00, 'essential', 'commodity', null, true, null),
  ('Telmisartan 40mg + Hydrochlorothiazide 12.5mg', 'Tablets, caplets & capsules', '28', null, null, null, 'essential', 'commodity', null, true, null),
  ('Telmisartan 80mg', 'Tablets, caplets & capsules', '1', null, null, 255.00, 'essential', 'commodity', null, true, null),
  ('Tetanus Toxoid 0.5ml', 'Injections', 'amp', null, null, 575.00, 'essential', 'commodity', null, true, null),
  ('Tetracycline 250mg', 'Tablets, caplets & capsules', '1', null, null, 32.00, 'essential', 'commodity', null, true, null),
  ('Tinidazole 20mg', 'Tablets, caplets & capsules', '1', null, null, 190.00, 'essential', 'commodity', null, true, null),
  ('Torsemide', 'Injections', '1', null, null, 750.00, 'essential', 'commodity', null, true, null),
  ('Torsemide 10mg', 'Tablets, caplets & capsules', '1', null, null, 144.00, 'essential', 'commodity', null, true, null),
  ('Torsemide 20mg', 'Tablets, caplets & capsules', '1', null, null, 168.00, 'essential', 'commodity', null, true, null),
  ('Tramadol', 'Injections', '1', null, null, 1100.00, 'essential', 'commodity', null, true, null),
  ('Tranexamic Acid', 'Tablets, caplets & capsules', '1', null, null, 838.00, 'essential', 'commodity', null, true, null),
  ('Triamcinolone 40mg', 'Injections', '1', null, null, 825.00, 'essential', 'commodity', null, true, null),
  ('Trifluoperazine 5mg (Stelazine)', 'Tablets, caplets & capsules', '1', null, null, 15.00, 'essential', 'commodity', null, true, null),
  ('Urine bag', 'Consumables', '1', null, null, 488.00, 'essential', 'commodity', null, true, null),
  ('Vicryl 0', 'Consumables', '1', null, null, 917.00, 'essential', 'commodity', null, true, null),
  ('Vicryl 1', 'Consumables', '1', null, null, 917.00, 'essential', 'commodity', null, true, null),
  ('Vicryl 1 2/0', 'Consumables', '1', null, null, 917.00, 'essential', 'commodity', null, true, null),
  ('Vicryl 2', 'Consumables', '1', null, null, 1020.00, 'essential', 'commodity', null, true, null),
  ('Vilget 50/1000mg', 'Tablets, caplets & capsules', '1', null, null, null, 'essential', 'commodity', null, true, null),
  ('Vitamin A 100,000IU', 'Tablets, caplets & capsules', '1', null, null, 76.00, 'essential', 'commodity', null, true, null),
  ('Vitamin B-complex', 'Tablets, caplets & capsules', '1', null, null, 4.00, 'essential', 'commodity', null, true, null),
  ('Vitamin B 12', 'Injections', '1', null, null, 255.00, 'essential', 'commodity', null, true, null),
  ('Vitamin B complex', 'Injections', '1', null, null, 255.00, 'essential', 'commodity', null, true, null),
  ('Vitamin C', 'Injections', '1', null, null, 165.00, 'essential', 'commodity', null, true, null),
  ('Vitamin C 500mg', 'Tablets, caplets & capsules', '1', null, null, null, 'essential', 'commodity', null, true, null),
  ('Vitamin c drops', 'Syrups & suspensions', '100ml', null, null, 880.00, 'essential', 'commodity', null, true, null),
  ('Vitamin E 1000IU', 'Tablets, caplets & capsules', '1', null, null, 132.00, 'essential', 'commodity', null, true, null),
  ('Vitamin K', 'Tablets, caplets & capsules', '1', null, null, 10.00, 'essential', 'commodity', null, true, null),
  ('Vitamin K3 10mg/ml', 'Injections', '1', null, null, 313.00, 'essential', 'commodity', null, true, null),
  ('Water for injection', 'Consumables', '1', null, null, 90.00, 'essential', 'commodity', null, true, null),
  ('Well rose', 'Tablets, caplets & capsules', '1', null, null, 165.00, 'essential', 'commodity', null, true, null),
  ('Whitfield Ointment', 'Consumables', '1', null, null, 1000.00, 'essential', 'commodity', null, true, null),
  ('Zinc gluconate 20mg', 'Tablets, caplets & capsules', '1', null, null, 24.00, 'essential', 'commodity', null, true, null),
  ('Zinc oxide', 'Consumables', '1', null, null, 920.00, 'essential', 'commodity', null, true, null),
  ('Zopiclone 7.5mg', 'Injections', '1', null, null, 3720.00, 'essential', 'commodity', null, true, null)
on conflict (name) do nothing;

-- ── Facilities (enrolled in the essential module) ───────────────────────────
insert into facilities (name, code, state, lga, cluster, level)
select 'Abiakpo Health Centre', 'AHC052', 'Akwa Ibom', 'Abak', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Abiakpo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Afaha Obong Health Centre', 'AOH049', 'Akwa Ibom', 'Abak', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Afaha Obong Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'General Hospital Ukpom Abak', 'GHU009', 'Akwa Ibom', 'Abak', 'Ikot Ekpene', 'secondary'
where not exists (select 1 from facilities where name = 'General Hospital Ukpom Abak' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'HEALTH POST, ABAK ITENGE', 'HPA520', 'Akwa Ibom', 'Abak', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'HEALTH POST, ABAK ITENGE' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ibanang Ediene Health Centre', 'IEH044', 'Akwa Ibom', 'Abak', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ibanang Ediene Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ibong Otoro Health Centre', 'IOH054', 'Akwa Ibom', 'Abak', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ibong Otoro Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Akpan Ikpong Health Centre', 'IAI048', 'Akwa Ibom', 'Abak', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Akpan Ikpong Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Edong Health Post', 'IEH051', 'Akwa Ibom', 'Abak', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Edong Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Etukudo Health Centre', 'IEH361', 'Akwa Ibom', 'Abak', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Etukudo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ossom Health Post', 'IOH053', 'Akwa Ibom', 'Abak', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ossom Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Itung Health Centre', 'IHC045', 'Akwa Ibom', 'Abak', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Itung Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Midim Health Centre', 'MHC050', 'Akwa Ibom', 'Abak', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Midim Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Operational Base Abak Primary Health Centre', 'OBA046', 'Akwa Ibom', 'Abak', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Operational Base Abak Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ukpom Health Centre', 'UHC360', 'Akwa Ibom', 'Abak', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ukpom Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Utu Ikot Ebak Health Post', 'UIE047', 'Akwa Ibom', 'Abak', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Utu Ikot Ebak Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Amadaka Primary Health Centre', 'APH057', 'Akwa Ibom', 'Eastern Obolo', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Amadaka Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Amauka Primary Health Centre', 'APH061', 'Akwa Ibom', 'Eastern Obolo', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Amauka Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Atabrikang Health Post', 'AHP064', 'Akwa Ibom', 'Eastern Obolo', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Atabrikang Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Cottage Hospital Eastern Obolo/General Hospital Okoroette', 'CHE033', 'Akwa Ibom', 'Eastern Obolo', 'Eket', 'secondary'
where not exists (select 1 from facilities where name = 'Cottage Hospital Eastern Obolo/General Hospital Okoroette' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Elekpon Health Post', 'EHP058', 'Akwa Ibom', 'Eastern Obolo', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Elekpon Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Emereoko Health Centre', 'EHC060', 'Akwa Ibom', 'Eastern Obolo', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Emereoko Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Iko Primary Health Centre', 'IPH063', 'Akwa Ibom', 'Eastern Obolo', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Iko Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikonta Obianga Primary Health Centre', 'IOP059', 'Akwa Ibom', 'Eastern Obolo', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikonta Obianga Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Okoroette Primary Health Centre', 'OPH055', 'Akwa Ibom', 'Eastern Obolo', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Okoroette Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Okoroinyong Primary Health Centre', 'OPH062', 'Akwa Ibom', 'Eastern Obolo', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Okoroinyong Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Okorombokho Health Post', 'OHP056', 'Akwa Ibom', 'Eastern Obolo', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Okorombokho Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Afaha Atai Health Post', 'AAH065', 'Akwa Ibom', 'Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Afaha Atai Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Comprehensive Health Centre Okon Eket', 'CHC034', 'Akwa Ibom', 'Eket', 'Eket', 'secondary'
where not exists (select 1 from facilities where name = 'Comprehensive Health Centre Okon Eket' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ebana Health Centre', 'EHC362', 'Akwa Ibom', 'Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ebana Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Effoi Health Centre', 'EHC068', 'Akwa Ibom', 'Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Effoi Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Esit Urua Health Post', 'EUH363', 'Akwa Ibom', 'Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Esit Urua Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Government Dental Centre Eket', 'GDC042', 'Akwa Ibom', 'Eket', 'Eket', 'secondary'
where not exists (select 1 from facilities where name = 'Government Dental Centre Eket' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Idua Health Post', 'IHP071', 'Akwa Ibom', 'Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Idua Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Idung Iniang Health Centre', 'IIH066', 'Akwa Ibom', 'Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Idung Iniang Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Iko Eket Health Centre', 'IEH364', 'Akwa Ibom', 'Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Iko Eket Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Abasi Okon Comprehensive Health Centre', 'IAO075', 'Akwa Ibom', 'Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Abasi Okon Comprehensive Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Abia Health Centre', 'IAH365', 'Akwa Ibom', 'Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Abia Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ebok Poly Operational Base Clinic', 'IEP072', 'Akwa Ibom', 'Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ebok Poly Operational Base Clinic' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Okudomo Health Centre', 'IOH070', 'Akwa Ibom', 'Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Okudomo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ukpong Health Post', 'IUH076', 'Akwa Ibom', 'Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ukpong Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Usoekong Health Post', 'IUH067', 'Akwa Ibom', 'Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Usoekong Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Immanuel General Hospital Eket', 'IGH004', 'Akwa Ibom', 'Eket', 'Eket', 'secondary'
where not exists (select 1 from facilities where name = 'Immanuel General Hospital Eket' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mkpok Model Health Centre', 'MMH073', 'Akwa Ibom', 'Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Mkpok Model Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nduo Eduo Health Post', 'NEH074', 'Akwa Ibom', 'Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Nduo Eduo Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Odio Health Centre', 'OHC069', 'Akwa Ibom', 'Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Odio Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Psychiatric Hospital Eket', 'PHE027', 'Akwa Ibom', 'Eket', 'Eket', 'secondary'
where not exists (select 1 from facilities where name = 'Psychiatric Hospital Eket' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Afaha Ekpenedi Health Post', 'AEH085', 'Akwa Ibom', 'Esit Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Afaha Ekpenedi Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Akpasung Health Post', 'AHP366', 'Akwa Ibom', 'Esit Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Akpasung Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Base Uquo Primary Health Centre', 'BUP086', 'Akwa Ibom', 'Esit Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Base Uquo Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Cottage Hospital Ekpene Obo', 'CHE026', 'Akwa Ibom', 'Esit Eket', 'Eket', 'secondary'
where not exists (select 1 from facilities where name = 'Cottage Hospital Ekpene Obo' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ebe Ekpi Health Post', 'EEH078', 'Akwa Ibom', 'Esit Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ebe Ekpi Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ebighi Okpono Health Post', 'EOH079', 'Akwa Ibom', 'Esit Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ebighi Okpono Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Edor Health Centre', 'EHC080', 'Akwa Ibom', 'Esit Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Edor Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ekpene Obo Health Post', 'EOH081', 'Akwa Ibom', 'Esit Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ekpene Obo Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Etebi Health Centre', 'EHC082', 'Akwa Ibom', 'Esit Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Etebi Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Etebi Idung Assan Health Centre', 'EIA083', 'Akwa Ibom', 'Esit Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Etebi Idung Assan Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Iko Efak Health Post', 'IEH077', 'Akwa Ibom', 'Esit Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Iko Efak Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikpa Health Centre', 'IHC084', 'Akwa Ibom', 'Esit Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikpa Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ntakinyang Health Centre', 'NHC367', 'Akwa Ibom', 'Esit Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ntakinyang Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Odoronkit Health Centre', 'OHC368', 'Akwa Ibom', 'Esit Eket', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Odoronkit Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Adiasim Health Centre', 'AHC087', 'Akwa Ibom', 'Essien Udim', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Adiasim Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Afaha Ikot Ebak Primary Health Centre', 'AIE088', 'Akwa Ibom', 'Essien Udim', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Afaha Ikot Ebak Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Atan Ikot Okoro Health Centre', 'AIO376', 'Akwa Ibom', 'Essien Udim', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Atan Ikot Okoro Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Community Ikpe Ikot Ntuen Health Centre', 'CII372', 'Akwa Ibom', 'Essien Udim', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Community Ikpe Ikot Ntuen Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Cottage Hospital Ukana', 'CHU029', 'Akwa Ibom', 'Essien Udim', 'Ikot Ekpene', 'secondary'
where not exists (select 1 from facilities where name = 'Cottage Hospital Ukana' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ekpenyong Atai Health Centre', 'EAH090', 'Akwa Ibom', 'Essien Udim', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ekpenyong Atai Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'General Hospital Ikpe Annang', 'GHI011', 'Akwa Ibom', 'Essien Udim', 'Ikot Ekpene', 'secondary'
where not exists (select 1 from facilities where name = 'General Hospital Ikpe Annang' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Akpanefia Health Centre', 'IAH374', 'Akwa Ibom', 'Essien Udim', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Akpanefia Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ondo Health Centre', 'IOH369', 'Akwa Ibom', 'Essien Udim', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ondo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Otu Ukana West Health Centre', 'IOU096', 'Akwa Ibom', 'Essien Udim', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Otu Ukana West Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikpe Annang Health Centre', 'IAH091', 'Akwa Ibom', 'Essien Udim', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikpe Annang Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikpe Ikot Akpan Health Centre', 'IIA373', 'Akwa Ibom', 'Essien Udim', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikpe Ikot Akpan Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Midim Atan Health Centre', 'MAH089', 'Akwa Ibom', 'Essien Udim', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Midim Atan Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mkpatak Health Centre', 'MHC371', 'Akwa Ibom', 'Essien Udim', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Mkpatak Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Odoro Ikot 1 Health Centre', 'OIH092', 'Akwa Ibom', 'Essien Udim', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Odoro Ikot 1 Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Odoro Ikot 2 Health Centre', 'OIH093', 'Akwa Ibom', 'Essien Udim', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Odoro Ikot 2 Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Okon Ikot Ocho Health Centre', 'OIO094', 'Akwa Ibom', 'Essien Udim', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Okon Ikot Ocho Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ukana East Primary Health Centre', 'UEP095', 'Akwa Ibom', 'Essien Udim', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ukana East Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ukana Ikot Ideh Health Centre', 'UII097', 'Akwa Ibom', 'Essien Udim', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ukana Ikot Ideh Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ukana Nsasak Primary Health Centre', 'UNP375', 'Akwa Ibom', 'Essien Udim', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ukana Nsasak Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Utu Ikot Ukpong Health Centre', 'UIU370', 'Akwa Ibom', 'Essien Udim', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Utu Ikot Ukpong Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Akai Uro Health Centre', 'AUH378', 'Akwa Ibom', 'Etim Ekpo', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Akai Uro Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Atan Eka Uruk Eshiet Health Centre', 'AEU101', 'Akwa Ibom', 'Etim Ekpo', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Atan Eka Uruk Eshiet Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'General Hospital Uruk Ata Ikot Ekpor (Etim Ekpo)', 'GHU014', 'Akwa Ibom', 'Etim Ekpo', 'Ikot Ekpene', 'secondary'
where not exists (select 1 from facilities where name = 'General Hospital Uruk Ata Ikot Ekpor (Etim Ekpo)' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ebo Health Centre', 'IEH100', 'Akwa Ibom', 'Etim Ekpo', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ebo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Edet Health Post', 'IEH380', 'Akwa Ibom', 'Etim Ekpo', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Edet Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ese Health Centre', 'IEH381', 'Akwa Ibom', 'Etim Ekpo', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ese Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Obioma Health Centre', 'IOH098', 'Akwa Ibom', 'Etim Ekpo', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Obioma Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Udobong Health Centre', 'IUH103', 'Akwa Ibom', 'Etim Ekpo', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Udobong Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikpe Annang Primary Health Centre (Model)', 'IAP099', 'Akwa Ibom', 'Etim Ekpo', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikpe Annang Primary Health Centre (Model)' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Iwukem Primary Health Centre', 'IPH104', 'Akwa Ibom', 'Etim Ekpo', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Iwukem Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Obong Ntak Health Centre', 'ONH102', 'Akwa Ibom', 'Etim Ekpo', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Obong Ntak Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Uruk Ata Ikot Ekpor Operational Base Primary Health Centre', 'UAI379', 'Akwa Ibom', 'Etim Ekpo', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Uruk Ata Ikot Ekpor Operational Base Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Utu Etim Ekpo Health Centre', 'UEE377', 'Akwa Ibom', 'Etim Ekpo', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Utu Etim Ekpo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Akpasak Efa Health Post', 'AEH114', 'Akwa Ibom', 'Etinan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Akpasak Efa Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Edem Ekpat Primary Health Centre', 'EEP108', 'Akwa Ibom', 'Etinan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Edem Ekpat Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ekpene Ukpa Health Centre', 'EUH106', 'Akwa Ibom', 'Etinan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ekpene Ukpa Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Etinan Primary Health Centre', 'EPH105', 'Akwa Ibom', 'Etinan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Etinan Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'General Hospital Etinan', 'GHE006', 'Akwa Ibom', 'Etinan', 'Uyo', 'secondary'
where not exists (select 1 from facilities where name = 'General Hospital Etinan' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'General Hospital Mbioto II', 'GHM012', 'Akwa Ibom', 'Etinan', 'Uyo', 'secondary'
where not exists (select 1 from facilities where name = 'General Hospital Mbioto II' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Akpan Ntembom Primary Health Centre', 'IAN389', 'Akwa Ibom', 'Etinan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Akpan Ntembom Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ekan Health Post', 'IEH111', 'Akwa Ibom', 'Etinan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ekan Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Esen Oku Health Centre', 'IEO113', 'Akwa Ibom', 'Etinan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Esen Oku Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Inyang Health Post', 'IIH385', 'Akwa Ibom', 'Etinan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Inyang Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Mfon Health Centre', 'IMH387', 'Akwa Ibom', 'Etinan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Mfon Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Obio Eka Primary Health Centre', 'IOE388', 'Akwa Ibom', 'Etinan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Obio Eka Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Obio Inyang Health Centre', 'IOI110', 'Akwa Ibom', 'Etinan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Obio Inyang Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Udo Oto Primary Health Centre', 'IUO107', 'Akwa Ibom', 'Etinan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Udo Oto Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Udobia Primary Health Centre', 'IUP109', 'Akwa Ibom', 'Etinan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Udobia Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Iwo Etor Health Centre', 'IEH115', 'Akwa Ibom', 'Etinan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Iwo Etor Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ndon Eyo 2 Primary Health Centre', 'NEP382', 'Akwa Ibom', 'Etinan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ndon Eyo 2 Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ndon Eyo Health Post', 'NEH383', 'Akwa Ibom', 'Etinan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ndon Eyo Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ndon Utim Primary Health Centre', 'NUP384', 'Akwa Ibom', 'Etinan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ndon Utim Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nkana Health Centre', 'NHC112', 'Akwa Ibom', 'Etinan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Nkana Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Oniong Primary Health Centre', 'OPH386', 'Akwa Ibom', 'Etinan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Oniong Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'QIC Leprosy Hospital Ekpene Obom', 'QLH018', 'Akwa Ibom', 'Etinan', 'Uyo', 'secondary'
where not exists (select 1 from facilities where name = 'QIC Leprosy Hospital Ekpene Obom' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Akata Health Post', 'AHP390', 'Akwa Ibom', 'Ibeno', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Akata Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Atabrikan Health Post', 'AHP125', 'Akwa Ibom', 'Ibeno', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Atabrikan Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Atia Health Centre', 'AHC126', 'Akwa Ibom', 'Ibeno', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Atia Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Cottage Hospital Ibeno', 'CHI030', 'Akwa Ibom', 'Ibeno', 'Eket', 'secondary'
where not exists (select 1 from facilities where name = 'Cottage Hospital Ibeno' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Inua Iyiet Ikot Health Post', 'III122', 'Akwa Ibom', 'Ibeno', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Inua Iyiet Ikot Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Itak Abasi Health Centre', 'IAH117', 'Akwa Ibom', 'Ibeno', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Itak Abasi Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Iwuochang Health Post', 'IHP124', 'Akwa Ibom', 'Ibeno', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Iwuochang Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Iwuokpom Health Centre', 'IHC391', 'Akwa Ibom', 'Ibeno', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Iwuokpom Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Iwuokpom Opolom Health Post', 'IOH120', 'Akwa Ibom', 'Ibeno', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Iwuokpom Opolom Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mkpanak Health Centre', 'MHC119', 'Akwa Ibom', 'Ibeno', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Mkpanak Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ndito Eka Iba Health Centre', 'NEI121', 'Akwa Ibom', 'Ibeno', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ndito Eka Iba Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ntafre Health Centre', 'NHC392', 'Akwa Ibom', 'Ibeno', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ntafre Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Okoroutip Health Centre', 'OHC123', 'Akwa Ibom', 'Ibeno', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Okoroutip Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Opolom Health Centre', 'OHC118', 'Akwa Ibom', 'Ibeno', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Opolom Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Upenekan Operational Base Primary Health Centre', 'UOB116', 'Akwa Ibom', 'Ibeno', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Upenekan Operational Base Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Afaha Atai Health Centre', 'AAH132', 'Akwa Ibom', 'Ibesikpo Asutan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Afaha Atai Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Afaha Udoeyop Health Centre', 'AUH135', 'Akwa Ibom', 'Ibesikpo Asutan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Afaha Udoeyop Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Akpaedung Health Post', 'IAH129', 'Akwa Ibom', 'Ibesikpo Asutan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Akpaedung Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Atang Esen Health Post', 'IAE130', 'Akwa Ibom', 'Ibesikpo Asutan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Atang Esen Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Efre Health Centre', 'IEH397', 'Akwa Ibom', 'Ibesikpo Asutan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Efre Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Iko Primary Health Centre', 'IIP394', 'Akwa Ibom', 'Ibesikpo Asutan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Iko Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Iyan Health Centre', 'IIH393', 'Akwa Ibom', 'Ibesikpo Asutan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Iyan Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Nkwo Health Post', 'INH131', 'Akwa Ibom', 'Ibesikpo Asutan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Nkwo Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Obio Edim Health Centre', 'IOE128', 'Akwa Ibom', 'Ibesikpo Asutan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Obio Edim Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Udo Ekop Health Centre', 'IUE395', 'Akwa Ibom', 'Ibesikpo Asutan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Udo Ekop Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mbierebe Akpawat Primary Health Centre', 'MAP396', 'Akwa Ibom', 'Ibesikpo Asutan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Mbierebe Akpawat Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mount Carmel Hospital Akpa Utong', 'MCH017', 'Akwa Ibom', 'Ibesikpo Asutan', 'Uyo', 'secondary'
where not exists (select 1 from facilities where name = 'Mount Carmel Hospital Akpa Utong' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nung Oku Health Post', 'NOH518', 'Akwa Ibom', 'Ibesikpo Asutan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Nung Oku Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nung Udoe Model Health Centre', 'NUM134', 'Akwa Ibom', 'Ibesikpo Asutan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Nung Udoe Model Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nung Udoe Operational Base Primary Health Centre', 'NUO133', 'Akwa Ibom', 'Ibesikpo Asutan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Nung Udoe Operational Base Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Okop Ndua Erong Health Centre', 'ONE127', 'Akwa Ibom', 'Ibesikpo Asutan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Okop Ndua Erong Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Afaha Obio Eno Health Centre', 'AOE405', 'Akwa Ibom', 'Ibiono-Ibom', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Afaha Obio Eno Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Aka Ididep Health Centre', 'AIH401', 'Akwa Ibom', 'Ibiono-Ibom', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Aka Ididep Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ekimbuk Health Centre', 'EHC402', 'Akwa Ibom', 'Ibiono-Ibom', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ekimbuk Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ibiaku Health Centre', 'IHC145', 'Akwa Ibom', 'Ibiono-Ibom', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ibiaku Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ididep Model Health Centre', 'IMH139', 'Akwa Ibom', 'Ibiono-Ibom', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ididep Model Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ididep Usuk Health Centre', 'IUH399', 'Akwa Ibom', 'Ibiono-Ibom', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ididep Usuk Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Idoro Comprehensive Health Centre', 'ICH141', 'Akwa Ibom', 'Ibiono-Ibom', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Idoro Comprehensive Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Adaidem Primary Health Centre', 'IAP142', 'Akwa Ibom', 'Ibiono-Ibom', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Adaidem Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Edung Health Centre', 'IEH136', 'Akwa Ibom', 'Ibiono-Ibom', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Edung Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Esen Model Health Centre', 'IEM140', 'Akwa Ibom', 'Ibiono-Ibom', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Esen Model Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Etim Health Centre', 'IEH400', 'Akwa Ibom', 'Ibiono-Ibom', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Etim Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Idaha Health Centre', 'IIH143', 'Akwa Ibom', 'Ibiono-Ibom', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Idaha Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Uba Health Centre', 'IUH398', 'Akwa Ibom', 'Ibiono-Ibom', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Uba Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikpa Operational Base Primary Health Centre', 'IOB137', 'Akwa Ibom', 'Ibiono-Ibom', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikpa Operational Base Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikpanya Health Centre', 'IHC146', 'Akwa Ibom', 'Ibiono-Ibom', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikpanya Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nsan Health Centre', 'NHC144', 'Akwa Ibom', 'Ibiono-Ibom', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Nsan Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Okopedi Use Health Centre', 'OUH138', 'Akwa Ibom', 'Ibiono-Ibom', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Okopedi Use Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ono Comprehensive Health Centre', 'OCH403', 'Akwa Ibom', 'Ibiono-Ibom', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ono Comprehensive Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Use Ikot Amama Health Centre', 'UIA404', 'Akwa Ibom', 'Ibiono-Ibom', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Use Ikot Amama Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Achan Ika Health Centre', 'AIH147', 'Akwa Ibom', 'Ika', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Achan Ika Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Cottage Hospital Ika', 'CHI032', 'Akwa Ibom', 'Ika', 'Ikot Ekpene', 'secondary'
where not exists (select 1 from facilities where name = 'Cottage Hospital Ika' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Efen Ikot Udonya Health Post', 'EIU151', 'Akwa Ibom', 'Ika', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Efen Ikot Udonya Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Akpan Anwa Health Centre', 'IAA153', 'Akwa Ibom', 'Ika', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Akpan Anwa Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Inyang Ese Health Post', 'IIE149', 'Akwa Ibom', 'Ika', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Inyang Ese Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Okoro Ata Leprosy Clinic', 'IOA148', 'Akwa Ibom', 'Ika', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Okoro Ata Leprosy Clinic' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Osukong Health Post', 'IOH406', 'Akwa Ibom', 'Ika', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Osukong Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Udo Health Post', 'IUH407', 'Akwa Ibom', 'Ika', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Udo Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Udom Health Centre', 'IUH154', 'Akwa Ibom', 'Ika', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Udom Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Itak Nto Urua Health Post', 'INU152', 'Akwa Ibom', 'Ika', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Itak Nto Urua Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nto Etukudo Health Centre', 'NEH156', 'Akwa Ibom', 'Ika', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Nto Etukudo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nto Uso Health Centre', 'NUH155', 'Akwa Ibom', 'Ika', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Nto Uso Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Urua Inyang Operational Base Primary Health Centre', 'UIO150', 'Akwa Ibom', 'Ika', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Urua Inyang Operational Base Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Aka Ekpeme Primary Health Centre', 'AEP412', 'Akwa Ibom', 'Ikono', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Aka Ekpeme Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Asanting Ikono Immunization Primary Health Centre', 'AII160', 'Akwa Ibom', 'Ikono', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Asanting Ikono Immunization Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ediene Atai Health Centre', 'EAH409', 'Akwa Ibom', 'Ikono', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ediene Atai Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ediene I Health Centre', 'EIH157', 'Akwa Ibom', 'Ikono', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ediene I Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Etip Ediene Health Centre', 'EEH158', 'Akwa Ibom', 'Ikono', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Etip Ediene Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'General Hospital Ikono', 'GHI007', 'Akwa Ibom', 'Ikono', 'Ikot Ekpene', 'secondary'
where not exists (select 1 from facilities where name = 'General Hospital Ikono' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ibiaku Ntok Okpo Primary Health Centre', 'INO161', 'Akwa Ibom', 'Ikono', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ibiaku Ntok Okpo Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Idaha Primary Health Centre', 'IIP165', 'Akwa Ibom', 'Ikono', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Idaha Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Onwon Health Centre', 'IOH408', 'Akwa Ibom', 'Ikono', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Onwon Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mbiabong Ukam Health Centre', 'MUH162', 'Akwa Ibom', 'Ikono', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Mbiabong Ukam Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ndiya Ikot Akpan Edet Health Centre', 'NIA413', 'Akwa Ibom', 'Ikono', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ndiya Ikot Akpan Edet Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nkara Obio Health Post', 'NOH414', 'Akwa Ibom', 'Ikono', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Nkara Obio Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nkwot Edem Edet Health Post', 'NEE167', 'Akwa Ibom', 'Ikono', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Nkwot Edem Edet Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nkwot Nung Imo Health Centre', 'NNI166', 'Akwa Ibom', 'Ikono', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Nkwot Nung Imo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nung Udoe Itak Health Centre', 'NUI164', 'Akwa Ibom', 'Ikono', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Nung Udoe Itak Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nung Ukim Health Centre', 'NUH159', 'Akwa Ibom', 'Ikono', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Nung Ukim Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Obio Itak Primary Health Centre', 'OIP410', 'Akwa Ibom', 'Ikono', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Obio Itak Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Osuk Ediene Health Centre', 'OEH411', 'Akwa Ibom', 'Ikono', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Osuk Ediene Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ukpom Primary Health Centre', 'UPH163', 'Akwa Ibom', 'Ikono', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ukpom Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Comprehensive Health Centre Essene', 'CHC040', 'Akwa Ibom', 'Ikot Abasi', 'Eket', 'secondary'
where not exists (select 1 from facilities where name = 'Comprehensive Health Centre Essene' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Edemaya Primary Health Centre', 'EPH168', 'Akwa Ibom', 'Ikot Abasi', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Edemaya Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Essene Health Centre', 'EHC173', 'Akwa Ibom', 'Ikot Abasi', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Essene Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'General Hospital Ikot Abasi', 'GHI005', 'Akwa Ibom', 'Ikot Abasi', 'Eket', 'secondary'
where not exists (select 1 from facilities where name = 'General Hospital Ikot Abasi' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Abasi Primary Health Centre', 'IAP171', 'Akwa Ibom', 'Ikot Abasi', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Abasi Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Akan Primary Health Centre', 'IAP175', 'Akwa Ibom', 'Ikot Abasi', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Akan Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Akpan Udo Health Centre', 'IAU416', 'Akwa Ibom', 'Ikot Abasi', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Akpan Udo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ekara Health Centre', 'IEH170', 'Akwa Ibom', 'Ikot Abasi', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ekara Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Etetuk Health Centre', 'IEH172', 'Akwa Ibom', 'Ikot Abasi', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Etetuk Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Okpok Health Post', 'IOH169', 'Akwa Ibom', 'Ikot Abasi', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Okpok Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Okwo Primary Health Centre', 'IOP176', 'Akwa Ibom', 'Ikot Abasi', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Okwo Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Umiang Okon Health Centre', 'IUO177', 'Akwa Ibom', 'Ikot Abasi', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Umiang Okon Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Usop Primary Health Centre', 'IUP174', 'Akwa Ibom', 'Ikot Abasi', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Usop Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Uta Ewa Health Centre', 'UEH415', 'Akwa Ibom', 'Ikot Abasi', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Uta Ewa Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Abak Ifia PHC', 'AIP519', 'Akwa Ibom', 'Ikot Ekpene', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Abak Ifia PHC' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Abiakpo Ikot Essien Health Centre', 'AIE180', 'Akwa Ibom', 'Ikot Ekpene', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Abiakpo Ikot Essien Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Abiakpo Ikot Ntuen Health Post', 'AIN188', 'Akwa Ibom', 'Ikot Ekpene', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Abiakpo Ikot Ntuen Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Amayam Health Centre', 'AHC182', 'Akwa Ibom', 'Ikot Ekpene', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Amayam Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'General Hospital Ikot Ekpene', 'GHI002', 'Akwa Ibom', 'Ikot Ekpene', 'Ikot Ekpene', 'secondary'
where not exists (select 1 from facilities where name = 'General Hospital Ikot Ekpene' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Government Dental Centre Ikot Ekpene', 'GDC041', 'Akwa Ibom', 'Ikot Ekpene', 'Ikot Ekpene', 'secondary'
where not exists (select 1 from facilities where name = 'Government Dental Centre Ikot Ekpene' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ibong Ikot Akan Health Centre', 'IIA418', 'Akwa Ibom', 'Ikot Ekpene', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ibong Ikot Akan Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ekpene Operational Base Primary Health Centre', 'IEO183', 'Akwa Ibom', 'Ikot Ekpene', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ekpene Operational Base Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Inyang Health Post', 'IIH184', 'Akwa Ibom', 'Ikot Ekpene', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Inyang Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Osura Health Post', 'IOH186', 'Akwa Ibom', 'Ikot Ekpene', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Osura Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Otu Health Post', 'IOH417', 'Akwa Ibom', 'Ikot Ekpene', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Otu Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Udoe Health Post', 'IUH185', 'Akwa Ibom', 'Ikot Ekpene', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Udoe Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Infectious Disease Hospital Ikot Ekpene', 'IDH028', 'Akwa Ibom', 'Ikot Ekpene', 'Ikot Ekpene', 'secondary'
where not exists (select 1 from facilities where name = 'Infectious Disease Hospital Ikot Ekpene' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mbiaso Health Post', 'MHP187', 'Akwa Ibom', 'Ikot Ekpene', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Mbiaso Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Urua Obo Health Post', 'UOH419', 'Akwa Ibom', 'Ikot Ekpene', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Urua Obo Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Uruk Uso Health Centre', 'UUH179', 'Akwa Ibom', 'Ikot Ekpene', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Uruk Uso Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Utu Edem Usung Health Post', 'UEU178', 'Akwa Ibom', 'Ikot Ekpene', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Utu Edem Usung Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Utu Ikot Ekpenyong Health Post', 'UIE181', 'Akwa Ibom', 'Ikot Ekpene', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Utu Ikot Ekpenyong Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Awa Ndem Imen Health Post', 'ANI426', 'Akwa Ibom', 'Ini', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Awa Ndem Imen Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Edem Idim Ibakesi Health Centre', 'EII427', 'Akwa Ibom', 'Ini', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Edem Idim Ibakesi Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Edem Idim Ibakesi Model Health Centre', 'EII420', 'Akwa Ibom', 'Ini', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Edem Idim Ibakesi Model Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ekio Ikpe Health Post', 'EIH423', 'Akwa Ibom', 'Ini', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ekio Ikpe Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'General Hospital Ikpe Ikot Nkon, Ini', 'GHI008', 'Akwa Ibom', 'Ini', 'Ikot Ekpene', 'secondary'
where not exists (select 1 from facilities where name = 'General Hospital Ikpe Ikot Nkon, Ini' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikpe Ikot Nkon Health Centre', 'IIN190', 'Akwa Ibom', 'Ini', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikpe Ikot Nkon Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Iwerre Health Centre', 'IHC192', 'Akwa Ibom', 'Ini', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Iwerre Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mbiabet Ikpe Health Centre', 'MIH421', 'Akwa Ibom', 'Ini', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Mbiabet Ikpe Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mbiabong Ikot Udofia Health Centre', 'MIU189', 'Akwa Ibom', 'Ini', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Mbiabong Ikot Udofia Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mbiafun Ikot Abasi Health Post', 'MIA428', 'Akwa Ibom', 'Ini', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Mbiafun Ikot Abasi Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nchana Ebua Health Post', 'NEH424', 'Akwa Ibom', 'Ini', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Nchana Ebua Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Odoro Ikpe Operational Base Primary Health Centre', 'OIO422', 'Akwa Ibom', 'Ini', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Odoro Ikpe Operational Base Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Odoro Ukwok Health Centre', 'OUH193', 'Akwa Ibom', 'Ini', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Odoro Ukwok Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ogu Itumbonuso Health Centre', 'OIH191', 'Akwa Ibom', 'Ini', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ogu Itumbonuso Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Okpoto Health Post', 'OHP425', 'Akwa Ibom', 'Ini', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Okpoto Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Usuk Ibakesi Health Centre', 'UIH194', 'Akwa Ibom', 'Ini', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Usuk Ibakesi Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Usuk Ukwok Health Post', 'UUH195', 'Akwa Ibom', 'Ini', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Usuk Ukwok Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ayadehe Health Post', 'AHP202', 'Akwa Ibom', 'Itu', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ayadehe Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ekritam Primary Health Centre', 'EPH197', 'Akwa Ibom', 'Itu', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ekritam Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ema Itam Primary Health Centre', 'EIP431', 'Akwa Ibom', 'Itu', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ema Itam Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Andem Health Centre', 'IAH199', 'Akwa Ibom', 'Itu', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Andem Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ekwere Health Post', 'IEH434', 'Akwa Ibom', 'Itu', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ekwere Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ntu Health Post', 'INH433', 'Akwa Ibom', 'Itu', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ntu Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mary Slessor General Hospital Itu', 'MSG019', 'Akwa Ibom', 'Itu', 'Ikot Ekpene', 'secondary'
where not exists (select 1 from facilities where name = 'Mary Slessor General Hospital Itu' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mbak Atai Operational Base Primary Health Centre', 'MAO201', 'Akwa Ibom', 'Itu', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Mbak Atai Operational Base Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mbak Itam 3 Health Centre', 'MIH205', 'Akwa Ibom', 'Itu', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Mbak Itam 3 Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mbiabong Health Post', 'MHP196', 'Akwa Ibom', 'Itu', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Mbiabong Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mkpeti Health Centre', 'MHC432', 'Akwa Ibom', 'Itu', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Mkpeti Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nkim Itam Health Centre', 'NIH200', 'Akwa Ibom', 'Itu', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Nkim Itam Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'North Itam Health Post', 'NIH429', 'Akwa Ibom', 'Itu', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'North Itam Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ntak Inyang Health Centre', 'NIH206', 'Akwa Ibom', 'Itu', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ntak Inyang Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Oma Oku Iboku Health Centre', 'OOI203', 'Akwa Ibom', 'Itu', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Oma Oku Iboku Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Uyo Itam Health Centre', 'UIH198', 'Akwa Ibom', 'Itu', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Uyo Itam Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Uyo Itam Primary Health Centre', 'UIP430', 'Akwa Ibom', 'Itu', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Uyo Itam Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'West Itam Primary Health Centre', 'WIP204', 'Akwa Ibom', 'Itu', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'West Itam Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Asiak Obufa Health Post', 'AOH209', 'Akwa Ibom', 'Mbo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Asiak Obufa Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Brama Health Centre', 'BHC435', 'Akwa Ibom', 'Mbo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Brama Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ebughu 1 Primary Health Centre', 'EPH207', 'Akwa Ibom', 'Mbo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ebughu 1 Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ekiebong Health Post', 'EHP436', 'Akwa Ibom', 'Mbo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ekiebong Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Enwang Primary Health Centre', 'EPH212', 'Akwa Ibom', 'Mbo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Enwang Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Esuk Enwang Health Centre', 'EEH210', 'Akwa Ibom', 'Mbo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Esuk Enwang Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Eyo Ukut Enwang 1 Health Post', 'EUE211', 'Akwa Ibom', 'Mbo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Eyo Ukut Enwang 1 Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ibaka Primary Health Centre', 'IPH213', 'Akwa Ibom', 'Mbo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ibaka Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Oduo Primary Health Centre', 'OPH208', 'Akwa Ibom', 'Mbo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Oduo Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Uda Mbo Primary Health Centre', 'UMP214', 'Akwa Ibom', 'Mbo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Uda Mbo Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Udesi Primary Health Centre', 'UPH216', 'Akwa Ibom', 'Mbo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Udesi Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Udungnyafa Health Post', 'UHP437', 'Akwa Ibom', 'Mbo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Udungnyafa Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Unyenge Health Post', 'UHP215', 'Akwa Ibom', 'Mbo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Unyenge Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Asana/Ibianga Health Post', 'AHP440', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Asana/Ibianga Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Cottage Hospital Asong', 'CHA020', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'secondary'
where not exists (select 1 from facilities where name = 'Cottage Hospital Asong' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Cottage Hospital Ikot Abia', 'CHI021', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'secondary'
where not exists (select 1 from facilities where name = 'Cottage Hospital Ikot Abia' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Cottage Hospital Ikot Ekpaw', 'CHI022', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'secondary'
where not exists (select 1 from facilities where name = 'Cottage Hospital Ikot Ekpaw' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Etuk Nung Ukim Health Centre', 'ENU226', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Etuk Nung Ukim Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ibekwe Akpan Nya Health Centre', 'IAN217', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ibekwe Akpan Nya Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Abasi Obio Nkan Health Centre', 'IAO224', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Abasi Obio Nkan Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Abia Enin Health Post', 'IAE218', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Abia Enin Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Akata Health Centre', 'IAH220', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Akata Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Akpaden Health Centre', 'IAH222', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Akpaden Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Eda Health Centre', 'IEH225', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Eda Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ekpe Health Centre', 'IEH444', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ekpe Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Eyiene Primary Health Centre', 'IEP442', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Eyiene Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Idiong Health Centre', 'IIH219', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Idiong Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Inyang Okop Primary Health Centre', 'IIO438', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Inyang Okop Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Obio Ndoho Health Post', 'ION439', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Obio Ndoho Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Obiokoi Health Post', 'IOH443', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Obiokoi Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Unya Health Centre', 'IUH441', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Unya Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Minya Health Centre', 'MHC227', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Minya Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ndon Health Post', 'NHP223', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ndon Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Operational Base Mkpat Enin Primary Health Centre', 'OBM228', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Operational Base Mkpat Enin Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ukam Health Centre', 'UHC221', 'Akwa Ibom', 'Mkpat-Enin', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ukam Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Comprehensive Health Centre Ikot Nkpene', 'CHC037', 'Akwa Ibom', 'Nsit-Atai', 'Uyo', 'secondary'
where not exists (select 1 from facilities where name = 'Comprehensive Health Centre Ikot Nkpene' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ibedu Health Centre', 'IHC246', 'Akwa Ibom', 'Nsit-Atai', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ibedu Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Edebe Health Centre', 'IEH245', 'Akwa Ibom', 'Nsit-Atai', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Edebe Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Itie Udung Health Centre', 'IIU244', 'Akwa Ibom', 'Nsit-Atai', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Itie Udung Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Mkpo Health Centre', 'IMH242', 'Akwa Ibom', 'Nsit-Atai', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Mkpo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Obon Health Centre', 'IOH243', 'Akwa Ibom', 'Nsit-Atai', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Obon Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Otu Health Post', 'IOH241', 'Akwa Ibom', 'Nsit-Atai', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Otu Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Uyo Health Centre', 'IUH248', 'Akwa Ibom', 'Nsit-Atai', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Uyo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Iwok Health Post', 'IHP240', 'Akwa Ibom', 'Nsit-Atai', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Iwok Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Odot Operational Base Primary Health Centre', 'OOB239', 'Akwa Ibom', 'Nsit-Atai', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Odot Operational Base Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Okoro Nsit Health Post', 'ONH247', 'Akwa Ibom', 'Nsit-Atai', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Okoro Nsit Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Afaha Abia Health Centre', 'AAH256', 'Akwa Ibom', 'Nsit-Ibom', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Afaha Abia Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Afaha Offiong Operational Base Primary Health Centre', 'AOO254', 'Akwa Ibom', 'Nsit-Ibom', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Afaha Offiong Operational Base Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Afia Nsit Urua Nko Health Centre', 'ANU255', 'Akwa Ibom', 'Nsit-Ibom', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Afia Nsit Urua Nko Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Asang Primary Health Centre', 'APH252', 'Akwa Ibom', 'Nsit-Ibom', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Asang Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Edebom 1 Health Post', 'EHP453', 'Akwa Ibom', 'Nsit-Ibom', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Edebom 1 Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ekpene Ikpan Health Post', 'EIH446', 'Akwa Ibom', 'Nsit-Ibom', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ekpene Ikpan Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Nya Health Post', 'INH257', 'Akwa Ibom', 'Nsit-Ibom', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Nya Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Obio Etan Primary Health Centre', 'IOE451', 'Akwa Ibom', 'Nsit-Ibom', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Obio Etan Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Offiok Health Centre', 'IOH250', 'Akwa Ibom', 'Nsit-Ibom', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Offiok Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Oku Nsit Health Post', 'ION447', 'Akwa Ibom', 'Nsit-Ibom', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Oku Nsit Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mbiaso Primary Health Centre', 'MPH258', 'Akwa Ibom', 'Nsit-Ibom', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Mbiaso Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mbiokporo 1 Primary Health Centre', 'MPH249', 'Akwa Ibom', 'Nsit-Ibom', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Mbiokporo 1 Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mbiokporo 2 Health Centre', 'MHC452', 'Akwa Ibom', 'Nsit-Ibom', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Mbiokporo 2 Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Oboatai Health Centre', 'OHC251', 'Akwa Ibom', 'Nsit-Ibom', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Oboatai Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Oboetim Primary Health Centre', 'OPH448', 'Akwa Ibom', 'Nsit-Ibom', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Oboetim Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Oboetok Health Post', 'OHP253', 'Akwa Ibom', 'Nsit-Ibom', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Oboetok Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Oboyo Ikot Ita Model Primaryhealth Centre Primary Health Centre', 'OII450', 'Akwa Ibom', 'Nsit-Ibom', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Oboyo Ikot Ita Model Primaryhealth Centre Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Okwo Nsit Health Centre', 'ONH449', 'Akwa Ibom', 'Nsit-Ibom', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Okwo Nsit Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Comprehensive Health Centre Ikot Edibon', 'CHC036', 'Akwa Ibom', 'Nsit-Ubium', 'Eket', 'secondary'
where not exists (select 1 from facilities where name = 'Comprehensive Health Centre Ikot Edibon' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Cottage Hospital Akai Ubium', 'CHA024', 'Akwa Ibom', 'Nsit-Ubium', 'Eket', 'secondary'
where not exists (select 1 from facilities where name = 'Cottage Hospital Akai Ubium' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Cottage Hospital Ikot Ekpene Udo', 'CHI025', 'Akwa Ibom', 'Nsit-Ubium', 'Eket', 'secondary'
where not exists (select 1 from facilities where name = 'Cottage Hospital Ikot Ekpene Udo' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Akpan Abia Health Centre', 'IAA459', 'Akwa Ibom', 'Nsit-Ubium', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Akpan Abia Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Akpatu Health Centre', 'IAH454', 'Akwa Ibom', 'Nsit-Ubium', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Akpatu Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Edibon Operational Base Primary Health Centre', 'IEO261', 'Akwa Ibom', 'Nsit-Ubium', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Edibon Operational Base Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ekwere Model Health Centre', 'IEM263', 'Akwa Ibom', 'Nsit-Ubium', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ekwere Model Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Eyo Health Centre', 'IEH262', 'Akwa Ibom', 'Nsit-Ubium', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Eyo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Okpudo Health Centre', 'IOH463', 'Akwa Ibom', 'Nsit-Ubium', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Okpudo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Okwot Primary Health Centre', 'IOP458', 'Akwa Ibom', 'Nsit-Ubium', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Okwot Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ubo Health Centre', 'IUH264', 'Akwa Ibom', 'Nsit-Ubium', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ubo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Udoide Health Post', 'IUH460', 'Akwa Ibom', 'Nsit-Ubium', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Udoide Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ukap Health Centre', 'IUH456', 'Akwa Ibom', 'Nsit-Ubium', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ukap Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ukobo Health Centre', 'IUH259', 'Akwa Ibom', 'Nsit-Ubium', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ukobo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Itreto Health Centre', 'IHC260', 'Akwa Ibom', 'Nsit-Ubium', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Itreto Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ndiya Health Centre', 'NHC457', 'Akwa Ibom', 'Nsit-Ubium', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ndiya Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ntit Oton Health Post', 'NOH455', 'Akwa Ibom', 'Nsit-Ubium', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ntit Oton Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nung Obong Primary Health Centre', 'NOP265', 'Akwa Ibom', 'Nsit-Ubium', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Nung Obong Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Obio Ubium Health Centre', 'OUH461', 'Akwa Ibom', 'Nsit-Ubium', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Obio Ubium Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Odoro Atasung Health Post', 'OAH464', 'Akwa Ibom', 'Nsit-Ubium', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Odoro Atasung Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Primary Obi Ubium Health Centre', 'POU462', 'Akwa Ibom', 'Nsit-Ubium', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Primary Obi Ubium Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Abak Ukpom Health Post', 'AUH468', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Abak Ukpom Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Abama Health Centre', 'AHC272', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Abama Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Abiakpo Idiaha Health Post', 'AIH467', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Abiakpo Idiaha Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Abiakpo Nkap Health Centre', 'ANH471', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Abiakpo Nkap Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Attai Ikwen Health Centre', 'AIH474', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Attai Ikwen Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Comprehensive Health Centre Nto Edino', 'CHC039', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'secondary'
where not exists (select 1 from facilities where name = 'Comprehensive Health Centre Nto Edino' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Editaha Okop Health Centre', 'EOH469', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Editaha Okop Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Abasi Eduo Health Post', 'IAE472', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Abasi Eduo Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Abia Anwan Health Centre', 'IAA266', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Abia Anwan Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ide Health Post', 'IIH269', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ide Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ukpong Health Post', 'IUH465', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ukpong Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ukpong Ikot Udoanwan Health Centre', 'IUI466', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ukpong Ikot Udoanwan Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Utu Model Primary Health Centre', 'IUM275', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Utu Model Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikwen Ikot Udom Health Centre', 'IIU475', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ikwen Ikot Udom Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nko Health Centre', 'NHC274', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Nko Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nsit Ikpe Health Post', 'NIH473', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Nsit Ikpe Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nto Assiak Health Post', 'NAH470', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Nto Assiak Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nto Edino Operation Base Primary Health Centre', 'NEO271', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Nto Edino Operation Base Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nto Eton Health Post', 'NEH267', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Nto Eton Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Obot Akara Health Centre', 'OAH273', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Obot Akara Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Okop Eto Health Post', 'OEH270', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Okop Eto Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ubon Akwa Health Post', 'UAH268', 'Akwa Ibom', 'Obot Akara', 'Ikot Ekpene', 'primary'
where not exists (select 1 from facilities where name = 'Ubon Akwa Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Afaha Akai Health Centre', 'AAH476', 'Akwa Ibom', 'Okobo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Afaha Akai Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Atak Oro Nsie Health Centre', 'AON477', 'Akwa Ibom', 'Okobo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Atak Oro Nsie Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Eastern Okobo Health Centre', 'EOH280', 'Akwa Ibom', 'Okobo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Eastern Okobo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ekeya Health Centre', 'EHC277', 'Akwa Ibom', 'Okobo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ekeya Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Eweme Model Health Centre', 'EMH279', 'Akwa Ibom', 'Okobo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Eweme Model Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'General Hospital Amammong Okobo', 'GHA010', 'Akwa Ibom', 'Okobo', 'Uyo', 'secondary'
where not exists (select 1 from facilities where name = 'General Hospital Amammong Okobo' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Grace Efiong Osung Health Centre', 'GEO517', 'Akwa Ibom', 'Okobo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Grace Efiong Osung Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mbokpu Oduobo Primary Health Centre', 'MOP276', 'Akwa Ibom', 'Okobo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Mbokpu Oduobo Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nsating Health Post', 'NHP481', 'Akwa Ibom', 'Okobo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Nsating Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Odobo Health Centre', 'OHC281', 'Akwa Ibom', 'Okobo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Odobo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Okopedi Primary Health Centre', 'OPH283', 'Akwa Ibom', 'Okobo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Okopedi Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Oti Oro Health Centre', 'OOH478', 'Akwa Ibom', 'Okobo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Oti Oro Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Urue Ita Health Post', 'UIH278', 'Akwa Ibom', 'Okobo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Urue Ita Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Uruting Health Post', 'UHP480', 'Akwa Ibom', 'Okobo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Uruting Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Utine Health Post', 'UHP282', 'Akwa Ibom', 'Okobo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Utine Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Utine Nduong Health Post', 'UNH479', 'Akwa Ibom', 'Okobo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Utine Nduong Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Abat Primary Health Centre', 'APH289', 'Akwa Ibom', 'Onna', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Abat Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Atiamkpat Health Centre', 'AHC484', 'Akwa Ibom', 'Onna', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Atiamkpat Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Comprehensive Health Centre Awa', 'CHC035', 'Akwa Ibom', 'Onna', 'Eket', 'secondary'
where not exists (select 1 from facilities where name = 'Comprehensive Health Centre Awa' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Cottage Hospital Ikot Eko Ibon', 'CHI023', 'Akwa Ibom', 'Onna', 'Eket', 'secondary'
where not exists (select 1 from facilities where name = 'Cottage Hospital Ikot Eko Ibon' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Edem Idim Ishiet Health Post', 'EII285', 'Akwa Ibom', 'Onna', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Edem Idim Ishiet Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Akpan Nko Health Centre', 'IAN286', 'Akwa Ibom', 'Onna', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Akpan Nko Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Annang Health Centre', 'IAH290', 'Akwa Ibom', 'Onna', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Annang Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ebidang Health Centre', 'IEH488', 'Akwa Ibom', 'Onna', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ebidang Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ese Ishiet Health Post', 'IEI482', 'Akwa Ibom', 'Onna', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ese Ishiet Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Idem Udo Health Centre', 'IIU284', 'Akwa Ibom', 'Onna', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Idem Udo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Mbong Health Centre', 'IMH485', 'Akwa Ibom', 'Onna', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Mbong Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Nkan Health Centre', 'INH288', 'Akwa Ibom', 'Onna', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Nkan Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Udo Health Centre', 'IUH293', 'Akwa Ibom', 'Onna', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Udo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikwe Health Centre', 'IHC291', 'Akwa Ibom', 'Onna', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikwe Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mkpok Health Centre', 'MHC287', 'Akwa Ibom', 'Onna', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Mkpok Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ntan Ide Ekpe Health Centre', 'NIE483', 'Akwa Ibom', 'Onna', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ntan Ide Ekpe Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nung Oku Ekanem Health Centre', 'NOE486', 'Akwa Ibom', 'Onna', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Nung Oku Ekanem Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Okat Health Centre', 'OHC487', 'Akwa Ibom', 'Onna', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Okat Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ukpana Health Centre', 'UHC292', 'Akwa Ibom', 'Onna', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ukpana Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Afaha Eduok Ukpata Primary Health Centre', 'AEU297', 'Akwa Ibom', 'Oron', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Afaha Eduok Ukpata Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Anamfa Health Post', 'AHP295', 'Akwa Ibom', 'Oron', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Anamfa Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Esin Ufot Primary Health Centre', 'EUP299', 'Akwa Ibom', 'Oron', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Esin Ufot Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Esuk Oro Health Post', 'EOH298', 'Akwa Ibom', 'Oron', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Esuk Oro Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Eyo Abasi Health Post', 'EAH301', 'Akwa Ibom', 'Oron', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Eyo Abasi Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Eyotong Health Post', 'EHP489', 'Akwa Ibom', 'Oron', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Eyotong Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'General Hospital Iquita (Oron)', 'GHI003', 'Akwa Ibom', 'Oron', 'Uyo', 'secondary'
where not exists (select 1 from facilities where name = 'General Hospital Iquita (Oron)' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Idua Assang Health Post', 'IAH294', 'Akwa Ibom', 'Oron', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Idua Assang Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Iyamba Health Post', 'IHP296', 'Akwa Ibom', 'Oron', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Iyamba Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Oron Ija Primary Health Centre', 'OIP300', 'Akwa Ibom', 'Oron', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Oron Ija Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Uya Oron Health Post', 'UOH302', 'Akwa Ibom', 'Oron', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Uya Oron Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ekparakwa Health Centre', 'EHC307', 'Akwa Ibom', 'Oruk Anam', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ekparakwa Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'General Hospital Ikot Okoro', 'GHI013', 'Akwa Ibom', 'Oruk Anam', 'Eket', 'secondary'
where not exists (select 1 from facilities where name = 'General Hospital Ikot Okoro' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ibianga Asakpa Health Centre', 'IAH492', 'Akwa Ibom', 'Oruk Anam', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ibianga Asakpa Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Akpan Essien Health Centre', 'IAE304', 'Akwa Ibom', 'Oruk Anam', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Akpan Essien Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Eka Ideh Health Post', 'IEI494', 'Akwa Ibom', 'Oruk Anam', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Eka Ideh Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Esenam Health Centre', 'IEH305', 'Akwa Ibom', 'Oruk Anam', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Esenam Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Iba Health Centre', 'IIH309', 'Akwa Ibom', 'Oruk Anam', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Iba Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ibritam Operational Base Primary Health Centre', 'IIO311', 'Akwa Ibom', 'Oruk Anam', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ibritam Operational Base Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Inyang1 Ikot Ibritam Ll In Ward 2 Primary Health Centre', 'III312', 'Akwa Ibom', 'Oruk Anam', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Inyang1 Ikot Ibritam Ll In Ward 2 Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Obio Nkan Health Centre', 'ION493', 'Akwa Ibom', 'Oruk Anam', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Obio Nkan Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Obio Nkan Health Post', 'ION314', 'Akwa Ibom', 'Oruk Anam', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Obio Nkan Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Osute Health Centre', 'IOH490', 'Akwa Ibom', 'Oruk Anam', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Osute Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Otok Health Centre', 'IOH303', 'Akwa Ibom', 'Oruk Anam', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Otok Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Udoro Health Centre', 'IUH310', 'Akwa Ibom', 'Oruk Anam', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Udoro Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ukpong Obiose Health Centre', 'IUO306', 'Akwa Ibom', 'Oruk Anam', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ukpong Obiose Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Inen Nsai Health Post', 'INH315', 'Akwa Ibom', 'Oruk Anam', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Inen Nsai Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ntak Ibesit Health Post', 'NIH308', 'Akwa Ibom', 'Oruk Anam', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ntak Ibesit Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nung Okubo 2 Health Centre', 'NOH313', 'Akwa Ibom', 'Oruk Anam', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Nung Okubo 2 Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Obiokpa Primary Health Centre', 'OPH316', 'Akwa Ibom', 'Oruk Anam', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Obiokpa Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Redeemer Cottage Hospital Ibesit', 'RCH031', 'Akwa Ibom', 'Oruk Anam', 'Eket', 'secondary'
where not exists (select 1 from facilities where name = 'Redeemer Cottage Hospital Ibesit' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ukpom Edem Inyang Health Centre', 'UEI491', 'Akwa Ibom', 'Oruk Anam', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ukpom Edem Inyang Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Edikor Eyokpu Primary Health Centre', 'EEP237', 'Akwa Ibom', 'Udung-Uko', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Edikor Eyokpu Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ekim Health Centre', 'EHC238', 'Akwa Ibom', 'Udung-Uko', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ekim Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Eniongo Health Post', 'EHP445', 'Akwa Ibom', 'Udung-Uko', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Eniongo Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Eyibia Health Post', 'EHP236', 'Akwa Ibom', 'Udung-Uko', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Eyibia Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Eyo Okponung Primary Health Centre', 'EOP232', 'Akwa Ibom', 'Udung-Uko', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Eyo Okponung Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Eyobiosiio Health Post', 'EHP233', 'Akwa Ibom', 'Udung-Uko', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Eyobiosiio Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Eyofin Primary Health Centre', 'EPH230', 'Akwa Ibom', 'Udung-Uko', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Eyofin Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Eyonsek Health Centre', 'EHC229', 'Akwa Ibom', 'Udung-Uko', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Eyonsek Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Eyotai Health Centre', 'EHC234', 'Akwa Ibom', 'Udung-Uko', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Eyotai Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Uboro Isong Inyang Health Post', 'UII235', 'Akwa Ibom', 'Udung-Uko', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Uboro Isong Inyang Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ukukudung Health Post', 'UHP231', 'Akwa Ibom', 'Udung-Uko', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ukukudung Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Adat Ifang Health Centre', 'AIH322', 'Akwa Ibom', 'Ukanafun', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Adat Ifang Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Afaha Ikot Akwa Health Post', 'AIA501', 'Akwa Ibom', 'Ukanafun', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Afaha Ikot Akwa Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Afaha Ikot Inyang Health Centre', 'AII317', 'Akwa Ibom', 'Ukanafun', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Afaha Ikot Inyang Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Afaha Odon Primary Health Centre', 'AOP495', 'Akwa Ibom', 'Ukanafun', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Afaha Odon Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Idung Nneke Health Post', 'INH321', 'Akwa Ibom', 'Ukanafun', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Idung Nneke Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Akpa Nkuk Primary Health Centre', 'IAN327', 'Akwa Ibom', 'Ukanafun', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Akpa Nkuk Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ebok Health Post', 'IEH497', 'Akwa Ibom', 'Ukanafun', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ebok Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Idiong Health Post', 'IIH325', 'Akwa Ibom', 'Ukanafun', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Idiong Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Oku Usung Health Post', 'IOU319', 'Akwa Ibom', 'Ukanafun', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Oku Usung Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Udo Mbang Afaha Obo Health Centre', 'IUM323', 'Akwa Ibom', 'Ukanafun', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Udo Mbang Afaha Obo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Udo Ossiom Health Centre', 'IUO324', 'Akwa Ibom', 'Ukanafun', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Udo Ossiom Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Udombang Afaha Obo Health Post', 'IUA498', 'Akwa Ibom', 'Ukanafun', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Udombang Afaha Obo Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Unah Health Centre', 'IUH326', 'Akwa Ibom', 'Ukanafun', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Unah Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nkek Health Post', 'NHP500', 'Akwa Ibom', 'Ukanafun', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Nkek Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Northern Afaha Health Centre', 'NAH318', 'Akwa Ibom', 'Ukanafun', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Northern Afaha Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nto Okon Health Post', 'NOH496', 'Akwa Ibom', 'Ukanafun', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Nto Okon Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ohaobu Health Centre', 'OHC499', 'Akwa Ibom', 'Ukanafun', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ohaobu Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ukanafun General Hospital', 'UGH043', 'Akwa Ibom', 'Ukanafun', 'Uyo', 'secondary'
where not exists (select 1 from facilities where name = 'Ukanafun General Hospital' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Utu Nsekhe Health Centre', 'UNH320', 'Akwa Ibom', 'Ukanafun', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Utu Nsekhe Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Adadia Health Post', 'AHP334', 'Akwa Ibom', 'Uruan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Adadia Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Comprehensive Health Centre Mbiaya Uruan', 'CHC038', 'Akwa Ibom', 'Uruan', 'Uyo', 'secondary'
where not exists (select 1 from facilities where name = 'Comprehensive Health Centre Mbiaya Uruan' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ekpene Ibia Health Centre', 'EIH333', 'Akwa Ibom', 'Uruan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ekpene Ibia Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ekpene Ukim Health Post', 'EUH504', 'Akwa Ibom', 'Uruan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ekpene Ukim Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Eman Ikot Ebo Health Post', 'EIE502', 'Akwa Ibom', 'Uruan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Eman Ikot Ebo Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ibiaku Issiet Health Centre', 'IIH337', 'Akwa Ibom', 'Uruan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ibiaku Issiet Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ibikpe Health Post', 'IHP331', 'Akwa Ibom', 'Uruan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ibikpe Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Idu Primary Health Centre', 'IPH328', 'Akwa Ibom', 'Uruan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Idu Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ifianyong Obot Health Post', 'IOH332', 'Akwa Ibom', 'Uruan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ifianyong Obot Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Otoinyie Health Centre', 'IOH330', 'Akwa Ibom', 'Uruan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Otoinyie Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mbiakong Uruan Health Post', 'MUH503', 'Akwa Ibom', 'Uruan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Mbiakong Uruan Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Methodist General Hospital Ituk Mbang', 'MGH015', 'Akwa Ibom', 'Uruan', 'Uyo', 'secondary'
where not exists (select 1 from facilities where name = 'Methodist General Hospital Ituk Mbang' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ndon Ebom Health Centre', 'NEH338', 'Akwa Ibom', 'Uruan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ndon Ebom Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nung Ikono Ufok Health Post', 'NIU336', 'Akwa Ibom', 'Uruan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Nung Ikono Ufok Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Nwaniba Health Centre', 'NHC329', 'Akwa Ibom', 'Uruan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Nwaniba Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'PRIMARY HEALTH CENTRE, IBIAKU URUAN', 'PHC521', 'Akwa Ibom', 'Uruan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'PRIMARY HEALTH CENTRE, IBIAKU URUAN' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Use Health Centre', 'UHC335', 'Akwa Ibom', 'Uruan', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Use Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Victor Attah Int''l Airport Clinic', 'VAI001', 'Akwa Ibom', 'Uruan', 'Uyo', 'secondary'
where not exists (select 1 from facilities where name = 'Victor Attah Int''l Airport Clinic' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Edok Oruko Primary Health Centre', 'EOP340', 'Akwa Ibom', 'Urue-Offong/Oruko', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Edok Oruko Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Elei Primary Health Centre', 'EPH505', 'Akwa Ibom', 'Urue-Offong/Oruko', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Elei Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'General Hospital Urue Offong Oruko', 'GHU016', 'Akwa Ibom', 'Urue-Offong/Oruko', 'Eket', 'secondary'
where not exists (select 1 from facilities where name = 'General Hospital Urue Offong Oruko' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ibotong Primary Health Centre', 'IPH508', 'Akwa Ibom', 'Urue-Offong/Oruko', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ibotong Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikpe Oro Health Post', 'IOH347', 'Akwa Ibom', 'Urue-Offong/Oruko', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ikpe Oro Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mbukpo Eyoima Primary Health Centre', 'MEP506', 'Akwa Ibom', 'Urue-Offong/Oruko', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Mbukpo Eyoima Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mbukpo Eyokan Primary Health Centre', 'MEP509', 'Akwa Ibom', 'Urue-Offong/Oruko', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Mbukpo Eyokan Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mbukpo Uko Akai Health Centre', 'MUA339', 'Akwa Ibom', 'Urue-Offong/Oruko', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Mbukpo Uko Akai Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Model PHC, Eyulor', 'MPE516', 'Akwa Ibom', 'Urue-Offong/Oruko', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Model PHC, Eyulor' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Oduonim Health Post', 'OHP341', 'Akwa Ibom', 'Urue-Offong/Oruko', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Oduonim Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Okossi Primary Health Centre (Model)', 'OPH348', 'Akwa Ibom', 'Urue-Offong/Oruko', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Okossi Primary Health Centre (Model)' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Operation Base Urue Offong Primary Health Centre', 'OBU345', 'Akwa Ibom', 'Urue-Offong/Oruko', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Operation Base Urue Offong Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Oyoku Ibighi Primary Health Centre', 'OIP344', 'Akwa Ibom', 'Urue-Offong/Oruko', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Oyoku Ibighi Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Oyubia Health Post', 'OHP346', 'Akwa Ibom', 'Urue-Offong/Oruko', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Oyubia Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Uboro Primary Health Centre', 'UPH507', 'Akwa Ibom', 'Urue-Offong/Oruko', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Uboro Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Udung Ukpor Health Centre', 'UUH343', 'Akwa Ibom', 'Urue-Offong/Oruko', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Udung Ukpor Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ukuda Health Post', 'UHP342', 'Akwa Ibom', 'Urue-Offong/Oruko', 'Eket', 'primary'
where not exists (select 1 from facilities where name = 'Ukuda Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Aka Offot Health Centre', 'AOH357', 'Akwa Ibom', 'Uyo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Aka Offot Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Akamba Nsukara Health Post', 'ANH354', 'Akwa Ibom', 'Uyo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Akamba Nsukara Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Atan Offot Primary Health Centre', 'AOP513', 'Akwa Ibom', 'Uyo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Atan Offot Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ewet Offot Health Post', 'EOH359', 'Akwa Ibom', 'Uyo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ewet Offot Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Idoro Uyo Health Centre', 'IUH355', 'Akwa Ibom', 'Uyo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Idoro Uyo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ifa Atai Primary Health Centre', 'IAP511', 'Akwa Ibom', 'Uyo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ifa Atai Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ifa Ikot Okpon Primary Health Centre', 'IIO510', 'Akwa Ibom', 'Uyo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ifa Ikot Okpon Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ayan Ikono Health Centre', 'IAI351', 'Akwa Ibom', 'Uyo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ayan Ikono Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'IKOT EBIDO ULTRA MODERN HEALTH CENTRE', 'IEU515', 'Akwa Ibom', 'Uyo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'IKOT EBIDO ULTRA MODERN HEALTH CENTRE' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ebo Health Centre', 'IEH352', 'Akwa Ibom', 'Uyo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ebo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Ofon Health Post', 'IOH512', 'Akwa Ibom', 'Uyo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Ofon Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Ikot Okubo Health Centre', 'IOH353', 'Akwa Ibom', 'Uyo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Ikot Okubo Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mbak Etoi Health Centre', 'MEH350', 'Akwa Ibom', 'Uyo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Mbak Etoi Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Mbiabong Anyanya Health Post', 'MAH349', 'Akwa Ibom', 'Uyo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Mbiabong Anyanya Health Post' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Obio Etoi Community Health Centre', 'OEC514', 'Akwa Ibom', 'Uyo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Obio Etoi Community Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Oku Uyo Health Centre (Model)', 'OUH356', 'Akwa Ibom', 'Uyo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Oku Uyo Health Centre (Model)' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Test Essential Facility', 'TEF-001', 'Akwa Ibom', 'Uyo', 'Uyo', null
where not exists (select 1 from facilities where name = 'Test Essential Facility' and coalesce(state,'') = coalesce('Akwa Ibom',''));
insert into facilities (name, code, state, lga, cluster, level)
select 'Uyo Primary Health Centre', 'UPH358', 'Akwa Ibom', 'Uyo', 'Uyo', 'primary'
where not exists (select 1 from facilities where name = 'Uyo Primary Health Centre' and coalesce(state,'') = coalesce('Akwa Ibom',''));

-- ── Enrol every facility above in the essential module (name is unique across
-- this roster -- verified no facility name spans more than one state) ──────
insert into facility_modules (facility_id, module)
select f.id, 'essential' from facilities f where f.name in (
  'Abiakpo Health Centre',
  'Afaha Obong Health Centre',
  'General Hospital Ukpom Abak',
  'HEALTH POST, ABAK ITENGE',
  'Ibanang Ediene Health Centre',
  'Ibong Otoro Health Centre',
  'Ikot Akpan Ikpong Health Centre',
  'Ikot Edong Health Post',
  'Ikot Etukudo Health Centre',
  'Ikot Ossom Health Post',
  'Itung Health Centre',
  'Midim Health Centre',
  'Operational Base Abak Primary Health Centre',
  'Ukpom Health Centre',
  'Utu Ikot Ebak Health Post',
  'Amadaka Primary Health Centre',
  'Amauka Primary Health Centre',
  'Atabrikang Health Post',
  'Cottage Hospital Eastern Obolo/General Hospital Okoroette',
  'Elekpon Health Post',
  'Emereoko Health Centre',
  'Iko Primary Health Centre',
  'Ikonta Obianga Primary Health Centre',
  'Okoroette Primary Health Centre',
  'Okoroinyong Primary Health Centre',
  'Okorombokho Health Post',
  'Afaha Atai Health Post',
  'Comprehensive Health Centre Okon Eket',
  'Ebana Health Centre',
  'Effoi Health Centre',
  'Esit Urua Health Post',
  'Government Dental Centre Eket',
  'Idua Health Post',
  'Idung Iniang Health Centre',
  'Iko Eket Health Centre',
  'Ikot Abasi Okon Comprehensive Health Centre',
  'Ikot Abia Health Centre',
  'Ikot Ebok Poly Operational Base Clinic',
  'Ikot Okudomo Health Centre',
  'Ikot Ukpong Health Post',
  'Ikot Usoekong Health Post',
  'Immanuel General Hospital Eket',
  'Mkpok Model Health Centre',
  'Nduo Eduo Health Post',
  'Odio Health Centre',
  'Psychiatric Hospital Eket',
  'Afaha Ekpenedi Health Post',
  'Akpasung Health Post',
  'Base Uquo Primary Health Centre',
  'Cottage Hospital Ekpene Obo',
  'Ebe Ekpi Health Post',
  'Ebighi Okpono Health Post',
  'Edor Health Centre',
  'Ekpene Obo Health Post',
  'Etebi Health Centre',
  'Etebi Idung Assan Health Centre',
  'Iko Efak Health Post',
  'Ikpa Health Centre',
  'Ntakinyang Health Centre',
  'Odoronkit Health Centre',
  'Adiasim Health Centre',
  'Afaha Ikot Ebak Primary Health Centre',
  'Atan Ikot Okoro Health Centre',
  'Community Ikpe Ikot Ntuen Health Centre',
  'Cottage Hospital Ukana',
  'Ekpenyong Atai Health Centre',
  'General Hospital Ikpe Annang',
  'Ikot Akpanefia Health Centre',
  'Ikot Ondo Health Centre',
  'Ikot Otu Ukana West Health Centre',
  'Ikpe Annang Health Centre',
  'Ikpe Ikot Akpan Health Centre',
  'Midim Atan Health Centre',
  'Mkpatak Health Centre',
  'Odoro Ikot 1 Health Centre',
  'Odoro Ikot 2 Health Centre',
  'Okon Ikot Ocho Health Centre',
  'Ukana East Primary Health Centre',
  'Ukana Ikot Ideh Health Centre',
  'Ukana Nsasak Primary Health Centre',
  'Utu Ikot Ukpong Health Centre',
  'Akai Uro Health Centre',
  'Atan Eka Uruk Eshiet Health Centre',
  'General Hospital Uruk Ata Ikot Ekpor (Etim Ekpo)',
  'Ikot Ebo Health Centre',
  'Ikot Edet Health Post',
  'Ikot Ese Health Centre',
  'Ikot Obioma Health Centre',
  'Ikot Udobong Health Centre',
  'Ikpe Annang Primary Health Centre (Model)',
  'Iwukem Primary Health Centre',
  'Obong Ntak Health Centre',
  'Uruk Ata Ikot Ekpor Operational Base Primary Health Centre',
  'Utu Etim Ekpo Health Centre',
  'Akpasak Efa Health Post',
  'Edem Ekpat Primary Health Centre',
  'Ekpene Ukpa Health Centre',
  'Etinan Primary Health Centre',
  'General Hospital Etinan',
  'General Hospital Mbioto II',
  'Ikot Akpan Ntembom Primary Health Centre',
  'Ikot Ekan Health Post',
  'Ikot Esen Oku Health Centre',
  'Ikot Inyang Health Post',
  'Ikot Mfon Health Centre',
  'Ikot Obio Eka Primary Health Centre',
  'Ikot Obio Inyang Health Centre',
  'Ikot Udo Oto Primary Health Centre',
  'Ikot Udobia Primary Health Centre',
  'Iwo Etor Health Centre',
  'Ndon Eyo 2 Primary Health Centre',
  'Ndon Eyo Health Post',
  'Ndon Utim Primary Health Centre',
  'Nkana Health Centre',
  'Oniong Primary Health Centre',
  'QIC Leprosy Hospital Ekpene Obom',
  'Akata Health Post',
  'Atabrikan Health Post',
  'Atia Health Centre',
  'Cottage Hospital Ibeno',
  'Inua Iyiet Ikot Health Post',
  'Itak Abasi Health Centre',
  'Iwuochang Health Post',
  'Iwuokpom Health Centre',
  'Iwuokpom Opolom Health Post',
  'Mkpanak Health Centre',
  'Ndito Eka Iba Health Centre',
  'Ntafre Health Centre',
  'Okoroutip Health Centre',
  'Opolom Health Centre',
  'Upenekan Operational Base Primary Health Centre',
  'Afaha Atai Health Centre',
  'Afaha Udoeyop Health Centre',
  'Ikot Akpaedung Health Post',
  'Ikot Atang Esen Health Post',
  'Ikot Efre Health Centre',
  'Ikot Iko Primary Health Centre',
  'Ikot Iyan Health Centre',
  'Ikot Nkwo Health Post',
  'Ikot Obio Edim Health Centre',
  'Ikot Udo Ekop Health Centre',
  'Mbierebe Akpawat Primary Health Centre',
  'Mount Carmel Hospital Akpa Utong',
  'Nung Oku Health Post',
  'Nung Udoe Model Health Centre',
  'Nung Udoe Operational Base Primary Health Centre',
  'Okop Ndua Erong Health Centre',
  'Afaha Obio Eno Health Centre',
  'Aka Ididep Health Centre',
  'Ekimbuk Health Centre',
  'Ibiaku Health Centre',
  'Ididep Model Health Centre',
  'Ididep Usuk Health Centre',
  'Idoro Comprehensive Health Centre',
  'Ikot Adaidem Primary Health Centre',
  'Ikot Edung Health Centre',
  'Ikot Esen Model Health Centre',
  'Ikot Etim Health Centre',
  'Ikot Idaha Health Centre',
  'Ikot Uba Health Centre',
  'Ikpa Operational Base Primary Health Centre',
  'Ikpanya Health Centre',
  'Nsan Health Centre',
  'Okopedi Use Health Centre',
  'Ono Comprehensive Health Centre',
  'Use Ikot Amama Health Centre',
  'Achan Ika Health Centre',
  'Cottage Hospital Ika',
  'Efen Ikot Udonya Health Post',
  'Ikot Akpan Anwa Health Centre',
  'Ikot Inyang Ese Health Post',
  'Ikot Okoro Ata Leprosy Clinic',
  'Ikot Osukong Health Post',
  'Ikot Udo Health Post',
  'Ikot Udom Health Centre',
  'Itak Nto Urua Health Post',
  'Nto Etukudo Health Centre',
  'Nto Uso Health Centre',
  'Urua Inyang Operational Base Primary Health Centre',
  'Aka Ekpeme Primary Health Centre',
  'Asanting Ikono Immunization Primary Health Centre',
  'Ediene Atai Health Centre',
  'Ediene I Health Centre',
  'Etip Ediene Health Centre',
  'General Hospital Ikono',
  'Ibiaku Ntok Okpo Primary Health Centre',
  'Ikot Idaha Primary Health Centre',
  'Ikot Onwon Health Centre',
  'Mbiabong Ukam Health Centre',
  'Ndiya Ikot Akpan Edet Health Centre',
  'Nkara Obio Health Post',
  'Nkwot Edem Edet Health Post',
  'Nkwot Nung Imo Health Centre',
  'Nung Udoe Itak Health Centre',
  'Nung Ukim Health Centre',
  'Obio Itak Primary Health Centre',
  'Osuk Ediene Health Centre',
  'Ukpom Primary Health Centre',
  'Comprehensive Health Centre Essene',
  'Edemaya Primary Health Centre',
  'Essene Health Centre',
  'General Hospital Ikot Abasi',
  'Ikot Abasi Primary Health Centre',
  'Ikot Akan Primary Health Centre',
  'Ikot Akpan Udo Health Centre',
  'Ikot Ekara Health Centre',
  'Ikot Etetuk Health Centre',
  'Ikot Okpok Health Post',
  'Ikot Okwo Primary Health Centre',
  'Ikot Umiang Okon Health Centre',
  'Ikot Usop Primary Health Centre',
  'Uta Ewa Health Centre',
  'Abak Ifia PHC',
  'Abiakpo Ikot Essien Health Centre',
  'Abiakpo Ikot Ntuen Health Post',
  'Amayam Health Centre',
  'General Hospital Ikot Ekpene',
  'Government Dental Centre Ikot Ekpene',
  'Ibong Ikot Akan Health Centre',
  'Ikot Ekpene Operational Base Primary Health Centre',
  'Ikot Inyang Health Post',
  'Ikot Osura Health Post',
  'Ikot Otu Health Post',
  'Ikot Udoe Health Post',
  'Infectious Disease Hospital Ikot Ekpene',
  'Mbiaso Health Post',
  'Urua Obo Health Post',
  'Uruk Uso Health Centre',
  'Utu Edem Usung Health Post',
  'Utu Ikot Ekpenyong Health Post',
  'Awa Ndem Imen Health Post',
  'Edem Idim Ibakesi Health Centre',
  'Edem Idim Ibakesi Model Health Centre',
  'Ekio Ikpe Health Post',
  'General Hospital Ikpe Ikot Nkon, Ini',
  'Ikpe Ikot Nkon Health Centre',
  'Iwerre Health Centre',
  'Mbiabet Ikpe Health Centre',
  'Mbiabong Ikot Udofia Health Centre',
  'Mbiafun Ikot Abasi Health Post',
  'Nchana Ebua Health Post',
  'Odoro Ikpe Operational Base Primary Health Centre',
  'Odoro Ukwok Health Centre',
  'Ogu Itumbonuso Health Centre',
  'Okpoto Health Post',
  'Usuk Ibakesi Health Centre',
  'Usuk Ukwok Health Post',
  'Ayadehe Health Post',
  'Ekritam Primary Health Centre',
  'Ema Itam Primary Health Centre',
  'Ikot Andem Health Centre',
  'Ikot Ekwere Health Post',
  'Ikot Ntu Health Post',
  'Mary Slessor General Hospital Itu',
  'Mbak Atai Operational Base Primary Health Centre',
  'Mbak Itam 3 Health Centre',
  'Mbiabong Health Post',
  'Mkpeti Health Centre',
  'Nkim Itam Health Centre',
  'North Itam Health Post',
  'Ntak Inyang Health Centre',
  'Oma Oku Iboku Health Centre',
  'Uyo Itam Health Centre',
  'Uyo Itam Primary Health Centre',
  'West Itam Primary Health Centre',
  'Asiak Obufa Health Post',
  'Brama Health Centre',
  'Ebughu 1 Primary Health Centre',
  'Ekiebong Health Post',
  'Enwang Primary Health Centre',
  'Esuk Enwang Health Centre',
  'Eyo Ukut Enwang 1 Health Post',
  'Ibaka Primary Health Centre',
  'Oduo Primary Health Centre',
  'Uda Mbo Primary Health Centre',
  'Udesi Primary Health Centre',
  'Udungnyafa Health Post',
  'Unyenge Health Post',
  'Asana/Ibianga Health Post',
  'Cottage Hospital Asong',
  'Cottage Hospital Ikot Abia',
  'Cottage Hospital Ikot Ekpaw',
  'Etuk Nung Ukim Health Centre',
  'Ibekwe Akpan Nya Health Centre',
  'Ikot Abasi Obio Nkan Health Centre',
  'Ikot Abia Enin Health Post',
  'Ikot Akata Health Centre',
  'Ikot Akpaden Health Centre',
  'Ikot Eda Health Centre',
  'Ikot Ekpe Health Centre',
  'Ikot Eyiene Primary Health Centre',
  'Ikot Idiong Health Centre',
  'Ikot Inyang Okop Primary Health Centre',
  'Ikot Obio Ndoho Health Post',
  'Ikot Obiokoi Health Post',
  'Ikot Unya Health Centre',
  'Minya Health Centre',
  'Ndon Health Post',
  'Operational Base Mkpat Enin Primary Health Centre',
  'Ukam Health Centre',
  'Comprehensive Health Centre Ikot Nkpene',
  'Ibedu Health Centre',
  'Ikot Edebe Health Centre',
  'Ikot Itie Udung Health Centre',
  'Ikot Mkpo Health Centre',
  'Ikot Obon Health Centre',
  'Ikot Otu Health Post',
  'Ikot Uyo Health Centre',
  'Iwok Health Post',
  'Odot Operational Base Primary Health Centre',
  'Okoro Nsit Health Post',
  'Afaha Abia Health Centre',
  'Afaha Offiong Operational Base Primary Health Centre',
  'Afia Nsit Urua Nko Health Centre',
  'Asang Primary Health Centre',
  'Edebom 1 Health Post',
  'Ekpene Ikpan Health Post',
  'Ikot Nya Health Post',
  'Ikot Obio Etan Primary Health Centre',
  'Ikot Offiok Health Centre',
  'Ikot Oku Nsit Health Post',
  'Mbiaso Primary Health Centre',
  'Mbiokporo 1 Primary Health Centre',
  'Mbiokporo 2 Health Centre',
  'Oboatai Health Centre',
  'Oboetim Primary Health Centre',
  'Oboetok Health Post',
  'Oboyo Ikot Ita Model Primaryhealth Centre Primary Health Centre',
  'Okwo Nsit Health Centre',
  'Comprehensive Health Centre Ikot Edibon',
  'Cottage Hospital Akai Ubium',
  'Cottage Hospital Ikot Ekpene Udo',
  'Ikot Akpan Abia Health Centre',
  'Ikot Akpatu Health Centre',
  'Ikot Edibon Operational Base Primary Health Centre',
  'Ikot Ekwere Model Health Centre',
  'Ikot Eyo Health Centre',
  'Ikot Okpudo Health Centre',
  'Ikot Okwot Primary Health Centre',
  'Ikot Ubo Health Centre',
  'Ikot Udoide Health Post',
  'Ikot Ukap Health Centre',
  'Ikot Ukobo Health Centre',
  'Itreto Health Centre',
  'Ndiya Health Centre',
  'Ntit Oton Health Post',
  'Nung Obong Primary Health Centre',
  'Obio Ubium Health Centre',
  'Odoro Atasung Health Post',
  'Primary Obi Ubium Health Centre',
  'Abak Ukpom Health Post',
  'Abama Health Centre',
  'Abiakpo Idiaha Health Post',
  'Abiakpo Nkap Health Centre',
  'Attai Ikwen Health Centre',
  'Comprehensive Health Centre Nto Edino',
  'Editaha Okop Health Centre',
  'Ikot Abasi Eduo Health Post',
  'Ikot Abia Anwan Health Centre',
  'Ikot Ide Health Post',
  'Ikot Ukpong Health Post',
  'Ikot Ukpong Ikot Udoanwan Health Centre',
  'Ikot Utu Model Primary Health Centre',
  'Ikwen Ikot Udom Health Centre',
  'Nko Health Centre',
  'Nsit Ikpe Health Post',
  'Nto Assiak Health Post',
  'Nto Edino Operation Base Primary Health Centre',
  'Nto Eton Health Post',
  'Obot Akara Health Centre',
  'Okop Eto Health Post',
  'Ubon Akwa Health Post',
  'Afaha Akai Health Centre',
  'Atak Oro Nsie Health Centre',
  'Eastern Okobo Health Centre',
  'Ekeya Health Centre',
  'Eweme Model Health Centre',
  'General Hospital Amammong Okobo',
  'Grace Efiong Osung Health Centre',
  'Mbokpu Oduobo Primary Health Centre',
  'Nsating Health Post',
  'Odobo Health Centre',
  'Okopedi Primary Health Centre',
  'Oti Oro Health Centre',
  'Urue Ita Health Post',
  'Uruting Health Post',
  'Utine Health Post',
  'Utine Nduong Health Post',
  'Abat Primary Health Centre',
  'Atiamkpat Health Centre',
  'Comprehensive Health Centre Awa',
  'Cottage Hospital Ikot Eko Ibon',
  'Edem Idim Ishiet Health Post',
  'Ikot Akpan Nko Health Centre',
  'Ikot Annang Health Centre',
  'Ikot Ebidang Health Centre',
  'Ikot Ese Ishiet Health Post',
  'Ikot Idem Udo Health Centre',
  'Ikot Mbong Health Centre',
  'Ikot Nkan Health Centre',
  'Ikot Udo Health Centre',
  'Ikwe Health Centre',
  'Mkpok Health Centre',
  'Ntan Ide Ekpe Health Centre',
  'Nung Oku Ekanem Health Centre',
  'Okat Health Centre',
  'Ukpana Health Centre',
  'Afaha Eduok Ukpata Primary Health Centre',
  'Anamfa Health Post',
  'Esin Ufot Primary Health Centre',
  'Esuk Oro Health Post',
  'Eyo Abasi Health Post',
  'Eyotong Health Post',
  'General Hospital Iquita (Oron)',
  'Idua Assang Health Post',
  'Iyamba Health Post',
  'Oron Ija Primary Health Centre',
  'Uya Oron Health Post',
  'Ekparakwa Health Centre',
  'General Hospital Ikot Okoro',
  'Ibianga Asakpa Health Centre',
  'Ikot Akpan Essien Health Centre',
  'Ikot Eka Ideh Health Post',
  'Ikot Esenam Health Centre',
  'Ikot Iba Health Centre',
  'Ikot Ibritam Operational Base Primary Health Centre',
  'Ikot Inyang1 Ikot Ibritam Ll In Ward 2 Primary Health Centre',
  'Ikot Obio Nkan Health Centre',
  'Ikot Obio Nkan Health Post',
  'Ikot Osute Health Centre',
  'Ikot Otok Health Centre',
  'Ikot Udoro Health Centre',
  'Ikot Ukpong Obiose Health Centre',
  'Inen Nsai Health Post',
  'Ntak Ibesit Health Post',
  'Nung Okubo 2 Health Centre',
  'Obiokpa Primary Health Centre',
  'Redeemer Cottage Hospital Ibesit',
  'Ukpom Edem Inyang Health Centre',
  'Edikor Eyokpu Primary Health Centre',
  'Ekim Health Centre',
  'Eniongo Health Post',
  'Eyibia Health Post',
  'Eyo Okponung Primary Health Centre',
  'Eyobiosiio Health Post',
  'Eyofin Primary Health Centre',
  'Eyonsek Health Centre',
  'Eyotai Health Centre',
  'Uboro Isong Inyang Health Post',
  'Ukukudung Health Post',
  'Adat Ifang Health Centre',
  'Afaha Ikot Akwa Health Post',
  'Afaha Ikot Inyang Health Centre',
  'Afaha Odon Primary Health Centre',
  'Idung Nneke Health Post',
  'Ikot Akpa Nkuk Primary Health Centre',
  'Ikot Ebok Health Post',
  'Ikot Idiong Health Post',
  'Ikot Oku Usung Health Post',
  'Ikot Udo Mbang Afaha Obo Health Centre',
  'Ikot Udo Ossiom Health Centre',
  'Ikot Udombang Afaha Obo Health Post',
  'Ikot Unah Health Centre',
  'Nkek Health Post',
  'Northern Afaha Health Centre',
  'Nto Okon Health Post',
  'Ohaobu Health Centre',
  'Ukanafun General Hospital',
  'Utu Nsekhe Health Centre',
  'Adadia Health Post',
  'Comprehensive Health Centre Mbiaya Uruan',
  'Ekpene Ibia Health Centre',
  'Ekpene Ukim Health Post',
  'Eman Ikot Ebo Health Post',
  'Ibiaku Issiet Health Centre',
  'Ibikpe Health Post',
  'Idu Primary Health Centre',
  'Ifianyong Obot Health Post',
  'Ikot Otoinyie Health Centre',
  'Mbiakong Uruan Health Post',
  'Methodist General Hospital Ituk Mbang',
  'Ndon Ebom Health Centre',
  'Nung Ikono Ufok Health Post',
  'Nwaniba Health Centre',
  'PRIMARY HEALTH CENTRE, IBIAKU URUAN',
  'Use Health Centre',
  'Victor Attah Int''l Airport Clinic',
  'Edok Oruko Primary Health Centre',
  'Elei Primary Health Centre',
  'General Hospital Urue Offong Oruko',
  'Ibotong Primary Health Centre',
  'Ikpe Oro Health Post',
  'Mbukpo Eyoima Primary Health Centre',
  'Mbukpo Eyokan Primary Health Centre',
  'Mbukpo Uko Akai Health Centre',
  'Model PHC, Eyulor',
  'Oduonim Health Post',
  'Okossi Primary Health Centre (Model)',
  'Operation Base Urue Offong Primary Health Centre',
  'Oyoku Ibighi Primary Health Centre',
  'Oyubia Health Post',
  'Uboro Primary Health Centre',
  'Udung Ukpor Health Centre',
  'Ukuda Health Post',
  'Aka Offot Health Centre',
  'Akamba Nsukara Health Post',
  'Atan Offot Primary Health Centre',
  'Ewet Offot Health Post',
  'Idoro Uyo Health Centre',
  'Ifa Atai Primary Health Centre',
  'Ifa Ikot Okpon Primary Health Centre',
  'Ikot Ayan Ikono Health Centre',
  'IKOT EBIDO ULTRA MODERN HEALTH CENTRE',
  'Ikot Ebo Health Centre',
  'Ikot Ofon Health Post',
  'Ikot Okubo Health Centre',
  'Mbak Etoi Health Centre',
  'Mbiabong Anyanya Health Post',
  'Obio Etoi Community Health Centre',
  'Oku Uyo Health Centre (Model)',
  'Test Essential Facility',
  'Uyo Primary Health Centre'
)
on conflict (facility_id, module) do nothing;

commit;
