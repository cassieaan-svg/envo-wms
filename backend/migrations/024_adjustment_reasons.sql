-- Adjustments carried a free-text reason, so "damaged", "damage", "broken in store" and a
-- blank all meant the same thing and none of them could be counted. The reason is now a
-- fixed code, which is what makes losses reportable: you can ask how much went to expiry
-- this quarter, and get an answer.
--
-- Nullable, and only constrained on adjustments: receipts and dispatches have a reason
-- built into what they are, and the stock-take receipts already written must stay valid.
ALTER TABLE batch_movements ADD COLUMN IF NOT EXISTS reason text;

ALTER TABLE batch_movements DROP CONSTRAINT IF EXISTS batch_movements_reason_check;
ALTER TABLE batch_movements ADD CONSTRAINT batch_movements_reason_check CHECK (
  reason IS NULL OR reason = ANY (ARRAY[
    'expired',
    'loss',
    'damaged',
    'count_correction',
    'facility_return'
  ])
);

-- Every adjustment must say why. Existing rows predate the column, so they are exempt:
-- the constraint is NOT VALID and applies to new writes only.
ALTER TABLE batch_movements DROP CONSTRAINT IF EXISTS batch_movements_adjustment_reason_check;
ALTER TABLE batch_movements ADD CONSTRAINT batch_movements_adjustment_reason_check CHECK (
  movement_type <> 'adjustment' OR reason IS NOT NULL
) NOT VALID;

-- The reporting query is "adjustments of this reason over this period".
CREATE INDEX IF NOT EXISTS batch_movements_reason_idx
  ON batch_movements (reason, created_at)
  WHERE reason IS NOT NULL;
