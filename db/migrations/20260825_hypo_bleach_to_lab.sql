-- Move Hypo Bleach from General Consumables to Lab consumables (2026-08-25).
--
-- An UPDATE, not a new row. A second 'Hypo Bleach' under the other category would
-- be a separate commodity id, splitting its stock, intake and expiry between two
-- rows that read identically on screen — the kind of thing that only shows up
-- later, as figures that will not reconcile.
--
-- Nothing is carried over because there is nothing to carry: at the time of
-- writing the commodity has no stock, no lots and no intake, dispense or
-- adjustment history. The id is unchanged regardless, so any future references
-- would follow it.
--
-- Visibility does change. General Consumables is a state-office category and the
-- State Office Store is scoped to Lab consumables + General Consumables, so it
-- keeps seeing this either way; lab-section users now see it too, which is the
-- point of the move.
--
-- Idempotent: matches nothing once applied.
update commodities
   set category = 'Lab consumables'
 where name = 'Hypo Bleach'
   and module = 'hiv'
   and category = 'General Consumables';
