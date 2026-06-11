-- Per-facility custom AMC window.
--
-- Lets a facility choose the explicit From→To month range used to compute AMC
-- (Average Monthly Consumption). The AMC formula is unchanged — total dispensed
-- over the window ÷ number of months — only the window is configurable, stored
-- per facility here. When a facility has no row, the app falls back to the
-- default quarterly window.
--
-- Kept in its own table (rather than columns on `facilities`) so configuring the
-- window doesn't require granting UPDATE on facility names/locations.
--
-- Run once in the Supabase SQL editor (Database → SQL editor).

CREATE TABLE IF NOT EXISTS public.facility_amc_settings (
  facility_id uuid PRIMARY KEY REFERENCES public.facilities(id) ON DELETE CASCADE,
  amc_from    date NOT NULL,                      -- first day of the start month
  amc_to      date NOT NULL,                      -- first day of the end month (inclusive)
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  CONSTRAINT amc_from_le_to CHECK (amc_from <= amc_to)
);

ALTER TABLE public.facility_amc_settings ENABLE ROW LEVEL SECURITY;

-- Anyone signed in can read (admins aggregate across facilities; facility users
-- read their own window).
DROP POLICY IF EXISTS "Read AMC settings" ON public.facility_amc_settings;
CREATE POLICY "Read AMC settings" ON public.facility_amc_settings
  FOR SELECT TO authenticated
  USING (true);

-- A facility's own managers, or any admin, may create/update its window.
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
