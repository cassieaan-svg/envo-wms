-- Distinguishes primary (PHC) from secondary (hospital) facilities, so the facility list
-- can be filtered by level. Nullable: the pre-existing test facilities are tagged
-- separately by name match, and anything unmatched stays NULL rather than guessed at.
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS facility_type TEXT
  CHECK (facility_type IN ('primary', 'secondary'));

CREATE INDEX IF NOT EXISTS facilities_type_idx ON facilities (facility_type);
