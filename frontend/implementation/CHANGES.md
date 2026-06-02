# Implementation Summary

## 1. Terminology — "Dispense" → "Stock / Consumption"

All user-facing text that said "dispense" or "Dispense" was replaced. Backend DB columns (`dispense_log`, `dispensed_by`, `dispensed_at`) and internal JS identifiers are unchanged.

| Location | Before | After |
|---|---|---|
| Nav (pharmacy, lab, admin) | Record Dispense | Record Stock Consumed |
| Page heading | Record Dispense | Record Stock Consumed |
| Dashboard metric | Dispensed today | Stock consumed today |
| Monitoring / Daily Summary column | Units dispensed | Units Consumed |
| Activity Log filter / type | Dispense | Stock consumed / Consumption |
| Reports category label | Dispense | Consumption |
| Store role label | Dispenser | Stock Recorder |

**Files changed:** `src/pages/pharmacy/Nav.jsx`, `src/pages/lab/Nav.jsx`, `src/pages/admin/Nav.jsx`, `src/pages/pharmacy/Dashboard.jsx`, `src/pages/lab/Dashboard.jsx`, `src/pages/pharmacy/Monitoring.jsx`, `src/pages/lab/Monitoring.jsx`, `src/pages/admin/DailySummary.jsx`, `src/pages/pharmacy/Log.jsx`, `src/pages/lab/Log.jsx`, `src/utils/reports.js`, `src/store/appStore.js`

---

## 2. Dispense.jsx → RecordStock.jsx (pharmacy + lab)

The pages were renamed and rewritten:

- `src/pages/pharmacy/Dispense.jsx` → `src/pages/pharmacy/RecordStock.jsx`
- `src/pages/lab/Dispense.jsx` → `src/pages/lab/RecordStock.jsx`

`src/App.jsx` updated to import and use the new filenames.

---

## 3. Unit model — always record in `comm.unit`

**Problem:** Stock was previously tracked in a mix of units:
- `stock.quantity` stored in bottles/kits
- `dispense_log.quantity` stored in tablets/tests (sub-units)
- A `tablet_buffer` mechanism accumulated partial-bottle usage before deducting whole bottles

**Fix:** Everything now uses `comm.unit` (the storage/receive unit):
- Cotrimoxazole → tablets
- RTK → kits (1 test = 1 kit)
- Reagent bottle → bottles

### RecordStock changes (pharmacy + lab)
- Quantity label: `"Quantity (tablets)"` / `"Quantity (kits, 1 kit = 25 tests)"` etc.
- Removed `bottleEquiv` display hint
- Validation: direct comparison (`stock.quantity < item.quantity`)
- Stock deduction: direct subtraction (`stk.quantity - item.quantity`), no tablet_buffer

### helpers.js fixes
```js
// fmtStockQty — was wrongly dividing stock.quantity by pack_size
export function fmtStockQty(qty, comm) {
  const unit = comm?.unit || getCommodityDispenseUnit(comm)
  return `${qty?.toLocaleString()} ${unit}`
}

// fmtDispenseQty — now uses comm.unit (dispense_log.quantity now in comm.unit)
export function fmtDispenseQty(qty, comm) {
  const unit = comm?.unit || getCommodityDispenseUnit(comm)
  return `${qty?.toLocaleString()} ${unit}`
}
```

---

## 4. Lab Stock Levels — category filter fix

`src/pages/lab/Stock.jsx` was showing pharmacy categories (Pharmacy drugs, Medical supplies).
Fixed to show lab categories (RTKs, Lab reagents).

---

## 5. Intake — dispensing unit fields

When recording intake, users can now optionally set or update a commodity's `dispensing_unit` and `pack_size`. If filled, the commodity record in the DB is updated on submit.

Shown as a collapsible "Dispensing details (optional)" panel when a commodity is selected.

**Files:** `src/pages/pharmacy/Intake.jsx`, `src/pages/lab/Intake.jsx`

---

## 6. Intake — inline new commodity form

A "+ New commodity" button above the commodity dropdown opens an inline form with fields:
- Name (required)
- Category (required — dropdown filtered to section's categories)
- Unit (required, e.g. tablets, kits, bottles)
- Dispensing unit (optional)
- Pack size (optional)

On save: inserts to `commodities` table, refreshes `store.allCommodities`, auto-selects the new commodity.

**Files:** `src/pages/pharmacy/Intake.jsx`, `src/pages/lab/Intake.jsx`

---

## 7. Intake form UX improvements

- "Dispensing details" expanded panel replaced with a small **"Edit details"** toggle button
- Commodity dropdown gets a **✕ clear button** once a commodity is selected
- All fields except Notes are now **required** (commodity, quantity, source type, supplier, batch/lot, expiry date, delivery note ref, received by)
- **"Facility transfer"** removed from source type options — transfers are handled via the Transfers page

**Files:** `src/pages/pharmacy/Intake.jsx`, `src/pages/lab/Intake.jsx`

---

## 8. Dropdown CSS fix

Options and optgroups now render with light text on a dark background, consistent with the app's dark theme.

**File:** `src/index.css`

---

## 9. Stock table constraint fix + Store → Dispensary transfer

**Problem:** The stock table had a unique constraint on `(facility_id, commodity_id)` only. The code expected two rows per commodity — one `'store'` and one `'dispensary'` — causing a duplicate key error when the Store → Dispensary transfer tried to insert a second row.

**DB fix (run in Supabase SQL Editor):**
```sql
ALTER TABLE stock DROP CONSTRAINT stock_facility_id_commodity_id_key;
ALTER TABLE stock ADD CONSTRAINT stock_facility_id_commodity_id_location_type_key
  UNIQUE (facility_id, commodity_id, location_type);
```

**Code fixes:**
- `acceptTransfer` in both Transfers files now filters sender and receiver stock lookups by `location_type: 'store'`, and the insert fallback includes `location_type: 'store'`
- Store → Dispensary internal transfer tab added to pharmacy/Transfers (was missing, only existed in lab)
- All pack-size conversion (`needed = Math.ceil(qty / packSize)`) removed from transfer validation — direct quantity comparison using `comm.unit`
- Hardcoded "bottles" labels replaced with `comm.unit`

**Files:** `src/pages/pharmacy/Transfers.jsx`, `src/pages/lab/Transfers.jsx`

---

## 10. Staff accountability + Expiry tracking + DSD support + Four-column SOH display

**Problem:** The app needed stronger audit trails, expiry date tracking for compliance, support for Differentiated Service Delivery (DSD) sites, and visibility into multiple stock locations (Store, Dispensary, and now DSD).

### 10a — Required staff "by" fields

All record-keeping operations now require the person performing the action:

- **RecordStock** (pharmacy + lab): "Recorded by" made required with `required` attribute and validation `if (!by)` before save. Label updated to `"Recorded by *"`.
- **Adjustment** (pharmacy + lab): "Adjusted by" made required with same pattern.
- **Transfers send form** (inter-facility): new required "Sent by *" field. New state `sentBy` / `setSentBy`. Stored in `initiated_by` column of `stock_transfer_log` (replaces the email placeholder).

**Files:** `src/pages/lab/RecordStock.jsx`, `src/pages/pharmacy/RecordStock.jsx`, `src/pages/lab/Adjustment.jsx`, `src/pages/pharmacy/Adjustment.jsx`, `src/pages/lab/Transfers.jsx`, `src/pages/pharmacy/Transfers.jsx`

### 10b — Expiry date + batch/lot number on Adjustment

When adjusting stock (e.g. removing expired items), capture the expiry date and lot number for traceability:

- New state: `adjExpiry`, `adjBatch`
- New form fields: required "Expiry date *" and optional "Batch / lot number"
- Validation: `if (!adjExpiry)` guard before save
- DB insert includes `expiry_date` and `batch_number`
- Recent adjustments table: new "Expiry" column shows `fmtDate(r.expiry_date)`

**DB columns needed** (run in Supabase SQL Editor):
```sql
ALTER TABLE stock_adjustment_log ADD COLUMN IF NOT EXISTS expiry_date date;
ALTER TABLE stock_adjustment_log ADD COLUMN IF NOT EXISTS batch_number text;
```

**Files:** `src/pages/lab/Adjustment.jsx`, `src/pages/pharmacy/Adjustment.jsx`

### 10c — Expiry date + batch/lot number on Transfers (send form only)

When sending stock to another facility, optionally capture expiry and batch for the receiver's records:

- New state: `sendExpiry`, `sendBatch` (inter-facility send form only, NOT Store→Dispensary)
- Optional fields for expiry date and batch/lot number
- DB insert includes `expiry_date` and `batch_number`

**DB columns needed**:
```sql
ALTER TABLE stock_transfer_log ADD COLUMN IF NOT EXISTS expiry_date date;
ALTER TABLE stock_transfer_log ADD COLUMN IF NOT EXISTS batch_number text;
```

**Files:** `src/pages/lab/Transfers.jsx`, `src/pages/pharmacy/Transfers.jsx`

### 10d — DSD (Differentiated Service Delivery) transfer tab

New tab "Send to DSD" in the Transfers page for sending stock to DSD sites (CHEWs, community pharmacists, FBOs, mobile outreach, etc.). Unlike inter-facility transfers, DSD transfers are immediate (no pending/accept flow).

- Stock deducted from `location_type = 'store'` immediately
- Stock added to `location_type = 'dsd'` (upsert pattern — creates row if not exists)
- Transfer logged to `stock_transfer_log` with `status = 'accepted'`, `receiving_facility_id = null`, `receiving_facility_name = dsdSiteName`, notes prefixed with `[DSD: <type>]`
- DSD type options (hardcoded dropdown): Community Health Extension Worker (CHEW), Community Pharmacist, Faith-Based Organization (FBO), Mobile Outreach, Other
- Required fields: commodity, quantity, DSD type, site name, sent by

**Files:** `src/pages/lab/Transfers.jsx`, `src/pages/pharmacy/Transfers.jsx`

### 10e — Four-column SOH display (Store + Dispensary + DSD + Total)

Stock on-hand now displays separately for Store, Dispensary, and DSD sites, with a Total column:

- `src/utils/helpers.js` — `groupStockByComm`: now tracks `dsdQty`, sets `quantity = storeQty + dispensaryQty + dsdQty`
- `src/utils/helpers.js` — new `pluralizeUnit(qty, unit)`: returns singular unit when qty === 1, otherwise adds 's' (unless already ends in 's')
- `src/utils/helpers.js` — `fmtStockQty`: now calls `pluralizeUnit()` for correct singular/plural display
- `src/pages/lab/Stock.jsx` + `src/pages/pharmacy/Stock.jsx`: column headers now include 'Store SOH', 'Dispensary SOH', 'DSD SOH', 'Total SOH'. DSD SOH cell is purple when non-zero.
- `src/pages/lab/Dashboard.jsx` + `src/pages/pharmacy/Dashboard.jsx`: same column additions

**Files:** `src/utils/helpers.js`, `src/pages/lab/Stock.jsx`, `src/pages/pharmacy/Stock.jsx`, `src/pages/lab/Dashboard.jsx`, `src/pages/pharmacy/Dashboard.jsx`
