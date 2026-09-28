-- Direct Debit: a fourth funding scheme, set up exactly like the Drug Revolving Fund.
--
-- The FACILITY pays (creates_debt = true), so every rule that hangs off that flag applies to
-- it unchanged and with no code branch on the key: orders issued under it appear in Accounts
-- as money owed, take instalment payments, can be reversed by a negative entry, roll into a
-- facility's total debt, and surface in the debtors and spend reports.
-- (See 028_schemes.sql and 029_order_payments.sql — dispatch_order_balances reads
-- schemes.creates_debt, so this row is all the ledger needs.)
--
-- Nothing else is inserted: `requests.scheme` and `dispatch_orders.scheme` already reference
-- schemes(key), and the request path validates against this table. EnVo must send the key
-- 'direct_debit' for a facility to raise a request against it.
--
-- sort_order 4 lists it after the three existing funds without renumbering them.
--
-- Apply:  npm run migrate   (on Cloud as well as CMS — a dispatch made under this scheme
-- cannot sync to an instance whose schemes table does not have the row)

INSERT INTO schemes (key, label, creates_debt, sort_order) VALUES
  ('direct_debit', 'Direct Debit', true, 4)
ON CONFLICT (key) DO NOTHING;
