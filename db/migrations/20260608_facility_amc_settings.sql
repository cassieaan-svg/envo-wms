-- Per-facility custom AMC months.
--
-- Lets a facility pick the specific months used to compute AMC (Average Monthly
-- Consumption) — an arbitrary set, not necessarily a contiguous range (e.g.
-- Jan, Mar, Jun). The formula is unchanged: total dispensed across the chosen
-- months ÷ number of chosen months. When a facility has no row, the app falls
-- back to the default quarterly window.
--
-- Months are stored as 'YYYY-MM' strings. Kept in its own table (rather than
-- columns on `facilities`) so configuring this doesn't require granting UPDATE
-- on facility names/locations.
--
-- Run once in the Supabase SQL editor (Database → SQL editor). If an earlier
-- (range-based) version of this table was already created, drop it first:
--   DROP TABLE IF EXISTS public.facility_amc_settings;

CREATE TABLE IF NOT EXISTS public.facility_amc_settings (
  facility_id uuid PRIMARY KEY REFERENCES public.facilities(id) ON DELETE CASCADE,
  months      text[] NOT NULL,                    -- e.g. {'2026-01','2026-03','2026-06'}
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  CONSTRAINT months_not_empty CHECK (array_length(months, 1) >= 1)
);

ALTER TABLE public.facility_amc_settings ENABLE ROW LEVEL SECURITY;

-- Anyone signed in can read (admins aggregate across facilities; facility users
-- read their own selection).
DROP POLICY IF EXISTS "Read AMC settings" ON public.facility_amc_settings;
CREATE POLICY "Read AMC settings" ON public.facility_amc_settings
  FOR SELECT TO authenticated
  USING (true);

-- A facility's own managers, or any admin, may create/update its selection.
-- Mirrors the access_level pattern used by the stock / log-table policies.
DROP POLICY IF EXISTS "Write AMC settings" ON public.facility_amc_settings;
CREATE POLICY "Write AMC settings" ON public.facility_amc_settings
  FOR ALL TO authenticated
  USING (
    ((facility_id)::text = ((auth.jwt() -> 'user_metadata') ->> 'facility_id'))
    OR (((auth.jwt() -> 'user_metadata') ->> 'is_admin') = 'true')
    OR (((auth.jwt() -> 'user_metadata') ->> 'access_level')
        = ANY (ARRAY['overall_admin', 'state_admin', 'cluster_admin', 'lga_admin']))
  )
  WITH CHECK (
    ((facility_id)::text = ((auth.jwt() -> 'user_metadata') ->> 'facility_id'))
    OR (((auth.jwt() -> 'user_metadata') ->> 'is_admin') = 'true')
    OR (((auth.jwt() -> 'user_metadata') ->> 'access_level')
        = ANY (ARRAY['overall_admin', 'state_admin', 'cluster_admin', 'lga_admin']))
  );
