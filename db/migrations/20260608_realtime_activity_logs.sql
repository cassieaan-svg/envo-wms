-- Enable realtime (postgres_changes) on the activity log tables so the
-- Activity Log updates live, the same way the stock table already does.
--
-- The frontend subscribes to dispense_log / intake_log / stock_adjustment_log
-- via sb.channel(...).on('postgres_changes', ...). Those events are only
-- delivered for tables that belong to the `supabase_realtime` publication, and
-- they respect each table's RLS (so admins receive events thanks to the
-- companion policy migration 20260608_admin_read_activity_logs_rls.sql).
--
-- Idempotent: only adds a table if it isn't already a publication member, so
-- this is safe to run more than once.
--
-- Run this once in the Supabase SQL editor (Database → SQL editor).

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dispense_log', 'intake_log', 'stock_adjustment_log'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
