-- Let access-level admins read dispense / intake / adjustment activity.
--
-- Symptom: an overall/state/LGA admin sees stock and transfers across
-- facilities, but the Activity Log, Monitoring dashboard and Weekly/Monthly
-- reports show nothing for consumption, intake and adjustments — even a
-- consumption that was just recorded at a facility.
--
-- Cause: the SELECT policies on these three log tables only admit an admin via
-- the legacy `is_admin = 'true'` JWT claim (or a matching facility_id):
--
--   facility_id = jwt.user_metadata.facility_id  OR  jwt.user_metadata.is_admin = 'true'
--
-- But admins are provisioned with `access_level` ('overall_admin' /
-- 'state_admin' / 'lga_admin') and NO is_admin flag and NO facility_id, so they
-- match neither branch and read zero rows. The stock and stock_transfer_log
-- policies already admit `access_level`, which is why those two read fine.
--
-- Fix: add the same `access_level` clause to the three log tables' SELECT
-- policies so it matches stock_transfer_log. RLS stays permissive for any
-- admin; the frontend still narrows state/LGA admins to their own facilities.
-- INSERT (Write) policies are intentionally left unchanged — admins do not
-- perform dispense/intake/adjustment operations, only read them.
--
-- Run this once in the Supabase SQL editor (Database → SQL editor).

-- ── dispense_log ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Read dispense log" ON public.dispense_log;
CREATE POLICY "Read dispense log" ON public.dispense_log
  FOR SELECT TO authenticated
  USING (
    ((facility_id)::text = ((auth.jwt() -> 'user_metadata') ->> 'facility_id'))
    OR (((auth.jwt() -> 'user_metadata') ->> 'is_admin') = 'true')
    OR (((auth.jwt() -> 'user_metadata') ->> 'access_level')
        = ANY (ARRAY['overall_admin', 'state_admin', 'cluster_admin', 'lga_admin']))
  );

-- ── intake_log ────────────────────────────────────────────────
DROP POLICY IF EXISTS "Read intake log" ON public.intake_log;
CREATE POLICY "Read intake log" ON public.intake_log
  FOR SELECT TO authenticated
  USING (
    ((facility_id)::text = ((auth.jwt() -> 'user_metadata') ->> 'facility_id'))
    OR (((auth.jwt() -> 'user_metadata') ->> 'is_admin') = 'true')
    OR (((auth.jwt() -> 'user_metadata') ->> 'access_level')
        = ANY (ARRAY['overall_admin', 'state_admin', 'cluster_admin', 'lga_admin']))
  );

-- ── stock_adjustment_log ──────────────────────────────────────
DROP POLICY IF EXISTS "Read adjustments" ON public.stock_adjustment_log;
CREATE POLICY "Read adjustments" ON public.stock_adjustment_log
  FOR SELECT TO authenticated
  USING (
    ((facility_id)::text = ((auth.jwt() -> 'user_metadata') ->> 'facility_id'))
    OR (((auth.jwt() -> 'user_metadata') ->> 'is_admin') = 'true')
    OR (((auth.jwt() -> 'user_metadata') ->> 'access_level')
        = ANY (ARRAY['overall_admin', 'state_admin', 'cluster_admin', 'lga_admin']))
  );
