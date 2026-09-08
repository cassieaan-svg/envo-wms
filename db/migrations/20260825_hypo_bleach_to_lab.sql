-- Move Hypo Bleach from General Consumables to Lab consumables (2026-08-25).
--
-- An UPDATE, not a new row. A second 'Hypo Bleach' would be a separate commodity id
-- splitting stock, intake and expiry between two rows that read identically on
-- screen - the kind of thing that only surfaces later as figures that will not
-- reconcile. The id is unchanged, so anything referencing it follows.
--
-- Visibility does change, which is the point: General Consumables is a state-office
-- category, and the State Office Store is scoped to Lab consumables + General
-- Consumables so it keeps seeing this either way, while lab-section users gain it.
--
-- No reference to commodities.module - see the note in 20260825_add_commodities.sql.
--
-- Idempotent: matches nothing once applied.
update commodities
   set category = 'Lab consumables'
 where name = 'Hypo Bleach'
   and category = 'General Consumables';
