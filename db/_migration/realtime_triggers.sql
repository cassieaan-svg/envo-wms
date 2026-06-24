-- Realtime change notifications (replaces Supabase realtime).
-- Triggers pg_notify on the 'envo_change' channel whenever a watched table changes.
-- A backend LISTEN client forwards these to connected SSE clients, which then
-- refetch their (scoped) data — mirroring the old unfiltered sb.channel behaviour.

-- Generic notifier: just the table + operation. Used by tables whose subscribers
-- only ever reload on any change (stock + the log tables).
create or replace function envo_notify_generic() returns trigger as $$
begin
  perform pg_notify('envo_change', json_build_object(
    'table', tg_table_name,
    'op', tg_op
  )::text);
  return null;
end;
$$ language plpgsql;

-- Transfer notifier: carries the few fields the Transfers/Alerts callbacks inspect
-- (status, facility ids, commodity_name) so they can show the "dispatched to you"
-- toast without an extra fetch. Kept small to stay well under pg_notify's 8000-byte cap.
create or replace function envo_notify_transfer() returns trigger as $$
begin
  perform pg_notify('envo_change', json_build_object(
    'table', tg_table_name,
    'op', tg_op,
    'new', case when tg_op = 'DELETE' then null else json_build_object(
      'id', new.id, 'status', new.status,
      'sending_facility_id', new.sending_facility_id,
      'receiving_facility_id', new.receiving_facility_id,
      'commodity_name', new.commodity_name
    ) end,
    'old', case when tg_op = 'INSERT' then null else json_build_object(
      'id', old.id, 'status', old.status,
      'sending_facility_id', old.sending_facility_id,
      'receiving_facility_id', old.receiving_facility_id
    ) end
  )::text);
  return null;
end;
$$ language plpgsql;

drop trigger if exists envo_rt_stock on stock;
create trigger envo_rt_stock after insert or update or delete on stock
  for each row execute function envo_notify_generic();

drop trigger if exists envo_rt_dispense on dispense_log;
create trigger envo_rt_dispense after insert or update or delete on dispense_log
  for each row execute function envo_notify_generic();

drop trigger if exists envo_rt_intake on intake_log;
create trigger envo_rt_intake after insert or update or delete on intake_log
  for each row execute function envo_notify_generic();

drop trigger if exists envo_rt_adjustment on stock_adjustment_log;
create trigger envo_rt_adjustment after insert or update or delete on stock_adjustment_log
  for each row execute function envo_notify_generic();

drop trigger if exists envo_rt_transfer on stock_transfer_log;
create trigger envo_rt_transfer after insert or update or delete on stock_transfer_log
  for each row execute function envo_notify_transfer();
