-- Rename "University Teaching Hospital" to its real name, "University of Uyo
-- Teaching Hospital".
--
-- The name is denormalized in several places, so a rename is not a single UPDATE.
-- Every copy found by scanning all text/jsonb columns in `public` for the literal:
--   facilities.name                            (the record itself)
--   users.raw_user_meta_data->>'facility_name'  (what the app shows the user)
--   users.raw_user_meta_data->>'hub_facility'   (DSD spokes naming their hub)
--   patients.facility_name
--   stock_transfer_log.sending_facility_name / receiving_facility_name
--
-- facility_dispense_summary and facility_stock_snapshot are VIEWS and neither
-- hardcodes the name, so they follow automatically.
--
-- Everything else joins on facilities.id, which does not change — so stock,
-- consumption and dsd_stock are untouched by design.
--
-- Idempotent: re-running matches nothing. No begin/commit here — apply_migration.mjs
-- runs each file in its own transaction.

update facilities
   set name = 'University of Uyo Teaching Hospital'
 where name = 'University Teaching Hospital';

update users
   set raw_user_meta_data = raw_user_meta_data
         || jsonb_build_object('facility_name', 'University of Uyo Teaching Hospital')
 where raw_user_meta_data->>'facility_name' = 'University Teaching Hospital';

update users
   set raw_user_meta_data = raw_user_meta_data
         || jsonb_build_object('hub_facility', 'University of Uyo Teaching Hospital')
 where raw_user_meta_data->>'hub_facility' = 'University Teaching Hospital';

update patients
   set facility_name = 'University of Uyo Teaching Hospital'
 where facility_name = 'University Teaching Hospital';

update stock_transfer_log
   set sending_facility_name = 'University of Uyo Teaching Hospital'
 where sending_facility_name = 'University Teaching Hospital';

update stock_transfer_log
   set receiving_facility_name = 'University of Uyo Teaching Hospital'
 where receiving_facility_name = 'University Teaching Hospital';
