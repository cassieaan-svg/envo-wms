-- Categories arrived in block capitals because that's how the source price list prints its
-- section headers. Stored in sentence case instead so they read like the rest of the app
-- and export cleanly. 'SYRUP|SUSPENSIONS' carried a pipe from a line break in the document.
UPDATE commodities SET category = 'Tablets, caplets & capsules' WHERE category = 'TABLETS/ CAPLETS/ CAPSULES';
UPDATE commodities SET category = 'Injections'                 WHERE category = 'INJECTIONS';
UPDATE commodities SET category = 'Syrups & suspensions'       WHERE category = 'SYRUP|SUSPENSIONS';
UPDATE commodities SET category = 'Infusions'                  WHERE category = 'INFUSIONS';
UPDATE commodities SET category = 'Consumables'                WHERE category = 'CONSUMABLES';
UPDATE commodities SET category = 'Ophthalmic preparations'    WHERE category = 'OPHTHALMIC PREPARATIONS';
