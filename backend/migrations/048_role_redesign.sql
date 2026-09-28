-- Role redesign: Accountant, Dispatch/Receiver, Admin Viewer, and renaming
-- Warehouse Admin to Admin. System Administrator is untouched.
--
-- - Warehouse Admin becomes Admin (same role row, same holders, just renamed) --
--   this is NOT a new role, so no user_roles change is needed for it.
-- - Picker/Dispatcher and Receiving Clerk are retired; every holder of either
--   moves onto the new merged Dispatch/Receiver role.
-- - Two new view permissions are added (vendors.view, commodities.view) because
--   neither existed before -- vendor and commodity reads were open to any
--   logged-in user regardless of role. Every route that reads them is gated to
--   match in the application code, not here.
-- - facilities.assignCommodities is dropped from every role bundle, including
--   Admin's: no frontend page calls the endpoint it gates, so nothing in the
--   app can currently exercise it. Add it back to whichever role needs it if a
--   real UI for it appears later.

begin;

-- ── New permissions ──────────────────────────────────────────────────────────
insert into permissions (key, description) values
  ('vendors.view', 'Read the vendor list/detail'),
  ('commodities.view', 'Read the commodity catalogue')
on conflict (key) do nothing;

-- ── Rename Warehouse Admin -> Admin (same row, same holders) ────────────────
update roles set key = 'admin', label = 'Admin' where key = 'warehouse_admin';

-- Admin's bundle: everything Warehouse Admin had, plus the two new view perms,
-- minus facilities.assignCommodities (see note above).
delete from role_permissions
 where role_id = (select id from roles where key = 'admin')
   and permission_key = 'facilities.assignCommodities';

insert into role_permissions (role_id, permission_key)
select (select id from roles where key = 'admin'), k
  from unnest(array['vendors.view', 'commodities.view']) as k
on conflict do nothing;

-- ── New role: Accountant ─────────────────────────────────────────────────────
insert into roles (key, label) values ('accountant', 'Accountant')
on conflict (key) do nothing;

insert into role_permissions (role_id, permission_key)
select (select id from roles where key = 'accountant'), k from unnest(array[
  'accounts.view', 'accounts.recordPayment',
  'facilities.view',
  'vendors.view',
  'monitoring.view',
  'dispatchOrders.print'
]) as k
on conflict do nothing;

-- ── New role: Dispatch/Receiver (merges Picker/Dispatcher + Receiving Clerk) ─
insert into roles (key, label) values ('dispatch_receiver', 'Dispatch/Receiver')
on conflict (key) do nothing;

insert into role_permissions (role_id, permission_key)
select (select id from roles where key = 'dispatch_receiver'), k from unnest(array[
  'batches.view', 'batches.create', 'batches.editNumber', 'batches.adjust',
  'requests.view', 'requests.fulfil', 'requests.receipt',
  'dispatchOrders.view', 'dispatchOrders.edit', 'dispatchOrders.print',
  'facilities.view',
  'accounts.view',
  'vendors.view', 'vendors.manage',
  'monitoring.view'
]) as k
on conflict do nothing;

-- ── New role: Admin Viewer ────────────────────────────────────────────────────
-- Read-only oversight: accounts/facilities/vendors/commodities/activity log, but
-- none of the operational workflow screens (requests/dispatch/batches) and no
-- users/roles administration.
insert into roles (key, label) values ('admin_viewer', 'Admin Viewer')
on conflict (key) do nothing;

insert into role_permissions (role_id, permission_key)
select (select id from roles where key = 'admin_viewer'), k from unnest(array[
  'accounts.view', 'facilities.view', 'vendors.view', 'commodities.view', 'monitoring.view'
]) as k
on conflict do nothing;

-- ── Migrate existing holders of the retired roles onto Dispatch/Receiver ────
insert into user_roles (user_id, role_id)
select ur.user_id, (select id from roles where key = 'dispatch_receiver')
  from user_roles ur
  join roles r on r.id = ur.role_id
 where r.key in ('picker_dispatcher', 'receiving_clerk')
on conflict (user_id, role_id) where facility_scope_id is null do nothing;

-- ── Retire Picker/Dispatcher and Receiving Clerk ─────────────────────────────
-- Cascades their user_roles and role_permissions rows; the migration above has
-- already copied every holder onto Dispatch/Receiver first.
delete from roles where key in ('picker_dispatcher', 'receiving_clerk');

commit;
