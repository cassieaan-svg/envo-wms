-- The warehouse needs to reach the person who raised a request — a name alone isn't
-- enough when a driver is at the gate and something on the order needs confirming. Sent
-- on to the WMS with the request, alongside requested_by.
ALTER TABLE warehouse_requests ADD COLUMN IF NOT EXISTS requester_phone TEXT;
