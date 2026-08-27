// Which deployment this process is.
//
// There is one WMS today and it is the cloud one. There will be a second — the local
// instance in the central medical store — and from the day it exists, every row either
// system writes has to say which of them wrote it. A row created before that distinction
// was recorded can never be assigned honestly afterwards, so the stamp starts now, while
// the answer is still known for certain.
//
// WMS_ORIGIN is 'cloud' or 'cms'; WMS_INSTANCE_ID names the particular deployment
// ('cloud-vm', 'cms-uyo'). Both default to the cloud, which is what an unconfigured
// deployment is today — but a wrong value is worse than a missing one, so an unrecognised
// WMS_ORIGIN stops the process at startup rather than writing rows nothing will recognise.

const VALID_ORIGINS = new Set(['cloud', 'cms']);

const configured = (process.env.WMS_ORIGIN || 'cloud').trim().toLowerCase();

if (!VALID_ORIGINS.has(configured)) {
  throw new Error(
    `WMS_ORIGIN must be 'cloud' or 'cms' (got "${process.env.WMS_ORIGIN}"). ` +
    'It decides which instance authored every inventory row this process writes, so it ' +
    'will not be guessed at.'
  );
}

export const ORIGIN = configured;
export const INSTANCE_ID = (process.env.WMS_INSTANCE_ID || '').trim() || null;

// Spread into an insert's parameters so the two columns are always written together and a
// new write path cannot quietly omit them.
export const stamp = () => ({ origin: ORIGIN, sourceInstance: INSTANCE_ID });
