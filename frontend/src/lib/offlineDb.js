// A small local store, not a heavy sync framework (see
// docs/ESSENTIAL_COMMODITIES_OFFLINE_DESIGN.md in the envo-wms sibling project).
// Two IndexedDB object stores:
//
//   snapshot  — one row per facility: the last-pulled catalogue/prices/stock summary.
//               Read-only from the app's perspective; only snapshotSync.js writes it.
//   queue     — the local write queue. One row per queued write: pending → syncing →
//               synced/failed, with retry. Only offlineQueue.js writes it.
//
// Raw IndexedDB, not a wrapper library — the whole point is that this stays small
// enough to read in one sitting.

const DB_NAME = 'envo-essential-offline'
const DB_VERSION = 1

let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('snapshot')) {
        db.createObjectStore('snapshot', { keyPath: 'facilityId' })
      }
      if (!db.objectStoreNames.contains('queue')) {
        const store = db.createObjectStore('queue', { keyPath: 'clientTxnId' })
        store.createIndex('status', 'status')
        store.createIndex('createdAt', 'createdAt')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx(db, storeName, mode) {
  const t = db.transaction(storeName, mode)
  return t.objectStore(storeName)
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// ── snapshot store ──────────────────────────────────────────────────────────

export async function putSnapshot(facilityId, snapshot) {
  const db = await openDb()
  const store = tx(db, 'snapshot', 'readwrite')
  await promisify(store.put({ facilityId, ...snapshot, cachedAt: new Date().toISOString() }))
}

export async function getSnapshot(facilityId) {
  const db = await openDb()
  const store = tx(db, 'snapshot', 'readonly')
  return (await promisify(store.get(facilityId))) || null
}

// ── queue store ──────────────────────────────────────────────────────────────

export async function putQueueEntry(entry) {
  const db = await openDb()
  const store = tx(db, 'queue', 'readwrite')
  await promisify(store.put(entry))
}

export async function getQueueEntry(clientTxnId) {
  const db = await openDb()
  const store = tx(db, 'queue', 'readonly')
  return (await promisify(store.get(clientTxnId))) || null
}

export async function deleteQueueEntry(clientTxnId) {
  const db = await openDb()
  const store = tx(db, 'queue', 'readwrite')
  await promisify(store.delete(clientTxnId))
}

export async function listQueueEntries() {
  const db = await openDb()
  const store = tx(db, 'queue', 'readonly')
  const all = await promisify(store.getAll())
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
