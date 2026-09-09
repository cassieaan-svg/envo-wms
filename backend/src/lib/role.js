// Which of the two instances this process is, and what that permits.
//
// There is one codebase and two deployments. The inventory core — receiving, FEFO, dispatch,
// fulfilment, adjustments, reconciliation — is identical in both and must stay that way:
// duplicating it in a second application would guarantee drift in exactly the code where
// drift is most expensive. What differs is which routes are mounted, which workers run, and
// which writes are allowed.
//
//   cloud  owns master data, EnVo integration and central reporting. It holds a READ-ONLY
//          mirror of the warehouse's stock, advanced only by ingesting what CMS sends.
//   cms    owns the warehouse's operational inventory. It never talks to EnVo.
//
// The ownership rule this file enforces is the one the whole architecture rests on:
// CMS Local is the only writer of CMS warehouse stock. Cloud must never modify it, not even
// to be helpful, because two writers means two balances and no way to tell which is real.

import { ORIGIN } from './instance.js';

const VALID_ROLES = new Set(['cloud', 'cms']);

// Defaults to 'cloud', which is what today's single deployment is. An unrecognised value
// stops the process rather than starting an instance whose permissions nobody can predict.
const configured = (process.env.WMS_ROLE || 'cloud').trim().toLowerCase();

if (!VALID_ROLES.has(configured)) {
  throw new Error(
    `WMS_ROLE must be 'cloud' or 'cms' (got "${process.env.WMS_ROLE}"). It decides which ` +
    'routes are mounted and which writes are permitted, so it will not be guessed at.'
  );
}

export const ROLE = configured;
export const IS_CLOUD = ROLE === 'cloud';
export const IS_CMS = ROLE === 'cms';

// WMS_ROLE and WMS_ORIGIN describe the same instance from two angles and must agree. A
// process that mounts the cloud surface while stamping rows 'cms' would produce records
// nothing downstream could interpret.
if ((IS_CMS && ORIGIN !== 'cms') || (IS_CLOUD && ORIGIN !== 'cloud')) {
  throw new Error(
    `WMS_ROLE="${ROLE}" and WMS_ORIGIN="${ORIGIN}" disagree. They name the same instance ` +
    'and must be set together.'
  );
}

// Is THIS instance allowed to author warehouse stock?
//
// CMS always is — that is what it exists for. Cloud's answer changes over time, and the
// default matters: today there is one deployment, it runs as `cloud`, and it writes stock
// every day. Defaulting Cloud to "not the authority" would take the live system down the
// moment this code shipped, before a warehouse instance existed to take over.
//
// So Cloud keeps the authority until CMS is commissioned, and handing it over is one
// deliberate act: set CLOUD_STOCK_AUTHORITY=false on Cloud once the warehouse instance is
// live. From that moment Cloud can only mirror, and the two-writer failure the whole
// architecture guards against becomes impossible rather than merely discouraged.
export const CLOUD_HAS_STOCK_AUTHORITY =
  (process.env.CLOUD_STOCK_AUTHORITY || 'true').trim().toLowerCase() !== 'false';

export const OWNS_WAREHOUSE_STOCK = IS_CMS || CLOUD_HAS_STOCK_AUTHORITY;

/**
 * Refuse a warehouse-stock write on an instance that does not own it.
 *
 * Called at the top of every service that moves stock, so the boundary is enforced by code
 * that runs rather than by a document describing what people should avoid doing.
 *
 * Ingest is the single exception, and says so explicitly: Cloud accepting an envelope is not
 * Cloud authoring stock, it is Cloud recording what CMS already did.
 */
export function assertCanWriteWarehouseStock({ viaIngest = false } = {}) {
  if (viaIngest) return;
  if (OWNS_WAREHOUSE_STOCK) return;
  const err = new Error(
    'This instance does not own warehouse stock. CMS Local is the operational writer; ' +
    'Cloud only mirrors what CMS reports. Perform this operation on the CMS instance.'
  );
  err.status = 403;
  err.code = 'NOT_STOCK_AUTHORITY';
  throw err;
}

// Express guard for whole routers whose writes belong to one role only.
export function requireStockAuthority(req, res, next) {
  try {
    assertCanWriteWarehouseStock();
    return next();
  } catch (err) {
    return res.status(err.status || 403).json({ error: err.message, code: err.code });
  }
}

// Same discipline as stock, for a different reason: pricing is set operationally, at the
// warehouse, by the people who negotiate with vendors and know what a commodity actually
// costs to lay in — not at Cloud, which has no relationship with a vendor at all. Unlike
// stock authority there is no phased handover here: CMS has always been where a price is
// decided, this just makes the code refuse the write Cloud was never supposed to make.
//
// Ingest is the exception, exactly as for stock: Cloud applying a price CMS already set is
// not Cloud authoring a price, it is Cloud recording what CMS decided.
export function assertCanSetPrices({ viaIngest = false } = {}) {
  if (viaIngest) return;
  if (IS_CMS) return;
  const err = new Error(
    'This instance does not set prices. CMS is the price authority — pricing is decided at ' +
    'the warehouse. Perform this operation on the CMS instance.'
  );
  err.status = 403;
  err.code = 'NOT_PRICE_AUTHORITY';
  throw err;
}

export function describeRole() {
  return {
    role: ROLE,
    origin: ORIGIN,
    instanceId: process.env.WMS_INSTANCE_ID || null,
    ownsWarehouseStock: OWNS_WAREHOUSE_STOCK,
    talksToEnvo: IS_CLOUD,
  };
}
