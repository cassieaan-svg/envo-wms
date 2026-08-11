-- Batch numbers are recorded as stock is handled, not invented up front.
--
-- The opening stock came from a physical count, which had real quantities but no lot
-- codes — every one of those 70 lots was labelled 'PHYS-2026-08' as a stand-in. Deleting
-- them would throw away the counted stock, so instead the label is cleared and the lots
-- stand as "quantity known, lot not yet identified" until someone reads the real number
-- off the carton.
--
-- That means batch_number has to be nullable. The uniqueness rule still holds for real
-- numbers — Postgres treats NULLs as distinct in a unique index, so any number of
-- unlabelled lots can coexist, but a genuine code still can't be entered twice for the
-- same commodity.

ALTER TABLE commodity_batches ALTER COLUMN batch_number DROP NOT NULL;

UPDATE commodity_batches
   SET batch_number = NULL
 WHERE batch_number = 'PHYS-2026-08';
