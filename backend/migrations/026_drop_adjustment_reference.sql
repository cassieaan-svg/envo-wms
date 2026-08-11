-- Added in 025 and dropped again before it carried anything: the approval reference has a
-- home in the note, and a second free-text field nobody fills in is worse than none.
ALTER TABLE batch_movements DROP COLUMN IF EXISTS reference;
