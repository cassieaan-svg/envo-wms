-- Picker/Dispatcher and Receiving Clerk lost the connection-status bar's sync info when the
-- Phase 1 verification audit's /api/sync fix gated it behind sync.view, which only System
-- Administrator and Warehouse Admin held. Both call sites (ConnectionBar.jsx, RequestsPage.jsx)
-- already failed soft, but the bar going blank for two of the four roles was never a design
-- decision — extending sync.view to them restores it.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'sync.view' FROM roles r
WHERE r.key IN ('picker_dispatcher', 'receiving_clerk')
ON CONFLICT DO NOTHING;
