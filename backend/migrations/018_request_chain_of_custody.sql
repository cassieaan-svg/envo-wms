-- Who handled a request at each stage, so a dispatched order reads like a waybill:
-- requested at the facility, picked in the store, carried by a named driver, received
-- back at the facility.
--
-- requested_by / requester_phone arrive from EnVo with the request. picked_by is captured
-- when a store officer starts picking. carrier_* is captured at dispatch — the warehouse
-- will not release stock to an unnamed carrier. received_* comes back from EnVo when the
-- facility confirms delivery.

ALTER TABLE requests ADD COLUMN IF NOT EXISTS requested_by    TEXT;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS requester_phone TEXT;

ALTER TABLE requests ADD COLUMN IF NOT EXISTS picked_by       TEXT;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS picked_at       TIMESTAMPTZ;

ALTER TABLE requests ADD COLUMN IF NOT EXISTS carrier_name    TEXT;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS carrier_phone   TEXT;

ALTER TABLE requests ADD COLUMN IF NOT EXISTS received_by     TEXT;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS received_at     TIMESTAMPTZ;
