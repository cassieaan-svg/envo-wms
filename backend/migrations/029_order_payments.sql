-- Facility indebtedness to the central store, tracked per dispatch order.
--
-- WHAT IS OWED: an order issued under a scheme whose `creates_debt` is true — today
-- only the DRF. BHCPF and Health Insurance issues are settled by someone else, so they
-- are never a facility debt no matter what they cost.
--
-- Outstanding on an order = total_amount − everything paid against it. A facility's
-- total debt is the sum of that across its debt-bearing orders.
--
-- WHY A PAYMENTS TABLE rather than a single editable `amount_paid` column on the order:
-- the warehouse tops the figure up over time, in instalments, until the order clears.
-- With one mutable number, "₦40,000 of ₦100,000 paid" cannot be distinguished from a
-- typo that overwrote ₦60,000 with ₦40,000 — and there is nothing to point at when a
-- facility disputes the balance. Rows cost nothing extra to use (the UI still just asks
-- for an amount), and they make every balance explainable by the entries behind it.
-- This mirrors why stock here is a lot ledger rather than a quantity column.
--
-- Deliberately NOT captured: teller/deposit-slip references. Facilities pay into a bank
-- account and bring the teller, but the reference is not needed to know the balance and
-- was explicitly out of scope. `note` is free text if anyone wants to record one anyway.
--
-- Payments are NOT deleted. A wrong entry is corrected by recording a negative amount,
-- so the correction is as visible as the mistake.
--
-- Apply:  npm run migrate

BEGIN;

CREATE TABLE IF NOT EXISTS dispatch_order_payments (
  id                SERIAL PRIMARY KEY,
  dispatch_order_id INTEGER NOT NULL REFERENCES dispatch_orders(id) ON DELETE CASCADE,
  -- Signed: a positive amount is money received, a negative one reverses an entry made
  -- in error. NOT constrained to > 0 for exactly that reason.
  amount            NUMERIC(14,2) NOT NULL CHECK (amount <> 0),
  paid_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by       TEXT,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dispatch_order_payments_order_idx
  ON dispatch_order_payments (dispatch_order_id, paid_at DESC);

-- One definition of what is owed, so no query re-derives it and drifts. `is_debt`
-- carries the scheme's rule rather than any caller hardcoding 'drf'.
CREATE OR REPLACE VIEW dispatch_order_balances AS
SELECT o.id                AS dispatch_order_id,
       o.facility_id,
       o.scheme,
       s.creates_debt      AS is_debt,
       o.dispatched_at,
       o.total_amount,
       COALESCE(p.paid, 0)::numeric(14,2) AS amount_paid,
       -- Only a debt-bearing scheme can be outstanding. A BHCPF order is not "unpaid",
       -- it is simply not the facility's to pay — reporting it as outstanding would
       -- overstate what every facility owes.
       CASE WHEN s.creates_debt
            THEN (o.total_amount - COALESCE(p.paid, 0))::numeric(14,2)
            ELSE 0::numeric(14,2) END AS outstanding
  FROM dispatch_orders o
  JOIN schemes s ON s.key = o.scheme
  LEFT JOIN (
    SELECT dispatch_order_id, SUM(amount) AS paid
      FROM dispatch_order_payments GROUP BY dispatch_order_id
  ) p ON p.dispatch_order_id = o.id;

COMMIT;
