-- An adjustment is often authorised on paper before it is recorded — a disposal
-- certificate, a return note, a memo. EnVo carries that paper trail as a reference number
-- on the adjustment, and without somewhere to put it people bury it in the note, where it
-- cannot be searched on.
ALTER TABLE batch_movements ADD COLUMN IF NOT EXISTS reference text;
