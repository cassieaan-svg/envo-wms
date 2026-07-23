-- Record the batch/expiry the user actually consumed at dispense.
--
-- EnVo consumes FEFO by assumption: dispenses record no batch, so the bin card
-- ESTIMATES which lot a consumption drew from (first-expiry-first-out). Staff can
-- now pick the batch intentionally at dispense; when they do, it is stored here
-- and the bin card honours it instead of estimating (binCardService.fefoAttribute
-- already keeps a movement's own recorded batch and only estimates the rest).
--
-- Nullable: existing rows and any dispense recorded without a chosen batch stay
-- FEFO-estimated exactly as before.
--
-- Apply:  psql "$DATABASE_URL" -f db/migrations/20260723_dispense_batch.sql
--   or on the VM, via the backend pool (psql is not on PATH there) —
--   cd C:\envo\app\backend; node -e "import('./src/db.js').then(async ({query,pool})=>{const fs=await import('node:fs');await query(fs.readFileSync('../db/migrations/20260723_dispense_batch.sql','utf8'));console.log('applied');await pool.end()})"
-- Idempotent; safe to re-run. Must run BEFORE the backend that writes these columns.

begin;

alter table dispense_log add column if not exists batch_number text;
alter table dispense_log add column if not exists expiry_date  date;

comment on column dispense_log.batch_number is
  'Batch the user chose to consume; null = FEFO-estimated on the bin card.';
comment on column dispense_log.expiry_date is
  'Expiry of the chosen batch, captured alongside batch_number.';

commit;
