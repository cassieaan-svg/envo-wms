-- Understock/overstock thresholds. Single central warehouse, so these live on the
-- commodity rather than per-location. NULL means "no alert configured".
ALTER TABLE commodities ADD COLUMN reorder_level NUMERIC(12,2);
ALTER TABLE commodities ADD COLUMN max_level NUMERIC(12,2);
