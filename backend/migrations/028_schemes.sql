-- Funding schemes (phase 1 of scheme + facility indebtedness).
--
-- The store distributes under three funds, and who pays differs by fund:
--   drf        Drug Revolving Fund — the FACILITY pays; the only one that creates debt
--   bhcpf      BHCPF               — government-funded; the facility is not billed
--   insurance  Health Insurance    — the insurer pays; the facility is not billed
--
-- A table rather than an enum/CHECK so a fourth fund is one insert, and so
-- `creates_debt` gives the account ledger a single place to ask whether an issue bills
-- the facility — instead of the string 'drf' being hardcoded across services.
--
-- ONE scheme column on `requests`. The fund is the FACILITY's decision, sent by EnVo,
-- and the warehouse cannot change it: a request is filled from the fund it was raised
-- against, or it is rejected so the facility re-raises. Moving an order onto another
-- fund would change who pays for it, which is not the store's call to make silently.
--
-- `dispatch_orders.scheme` is different: a direct dispatch raised in the WMS has no
-- request behind it, so there the warehouse does choose the fund.
--
-- Backfill is 'drf' throughout: the store has been running one implicit fund, and the
-- voucher it prints is the DRF voucher.
--
-- Prices are unaffected — BHCPF and insurance issues still need a value for claims.
--
-- Apply:  npm run migrate

BEGIN;

CREATE TABLE IF NOT EXISTS schemes (
  key          TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  creates_debt BOOLEAN NOT NULL DEFAULT false,
  active       BOOLEAN NOT NULL DEFAULT true,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

INSERT INTO schemes (key, label, creates_debt, sort_order) VALUES
  ('drf',       'Drug Revolving Fund (DRF)', true,  1),
  ('bhcpf',     'BHCPF',                     false, 2),
  ('insurance', 'Health Insurance',          false, 3)
ON CONFLICT (key) DO NOTHING;

-- The fund the facility raised the request against, as sent by EnVo.
ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS scheme TEXT NOT NULL DEFAULT 'drf' REFERENCES schemes(key);

UPDATE requests SET scheme = 'drf' WHERE scheme IS NULL;

-- A dispatch not raised from a request (direct/walk-in issue) needs its own scheme —
-- otherwise those issues could never be attributed to a fund, and DRF debt posted from
-- dispatches would silently miss them.
ALTER TABLE dispatch_orders
  ADD COLUMN IF NOT EXISTS scheme TEXT NOT NULL DEFAULT 'drf' REFERENCES schemes(key);

CREATE INDEX IF NOT EXISTS requests_scheme_idx ON requests (scheme, created_at DESC);
CREATE INDEX IF NOT EXISTS dispatch_orders_scheme_idx ON dispatch_orders (scheme, dispatched_at DESC);

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM requests WHERE scheme IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'requests.scheme NULL for % row(s)', n; END IF;
  SELECT count(*) INTO n FROM dispatch_orders WHERE scheme IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'dispatch_orders.scheme NULL for % row(s)', n; END IF;
END $$;

COMMIT;
