-- Correct the Flucytosine dosage form: it is an oral tablet, not an injection.
--
-- The commodity was recorded as "Flucytosine injection" (unit vials), but the
-- product actually stocked/dispensed for cryptococcal meningitis is the oral
-- tablet. Rename it and switch its unit so the CRRF and every stock screen show
-- the correct form. Idempotent and safe to re-run.

begin;

update commodities
   set name = 'Flucytosine',
       unit = 'tabs',
       dispensing_unit = 'tab'
 where name = 'Flucytosine injection';

commit;
