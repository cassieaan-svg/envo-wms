import { describe, test, expect } from 'vitest'
import {
  putSnapshot, getSnapshot,
  putQueueEntry, getQueueEntry, deleteQueueEntry, listQueueEntries,
} from './offlineDb'

// Runs against fake-indexeddb (see src/test/setup.js) — a real IndexedDB
// implementation, not a mock, so this exercises the actual offlineDb.js code path.

describe('offlineDb: snapshot store', () => {
  test('putSnapshot / getSnapshot round-trips and stamps cachedAt', async () => {
    const envelope = { generatedAt: '2026-01-01T00:00:00Z', data: { commodities: [{ id: 'c1' }] } }
    await putSnapshot('fac-1', envelope)
    const got = await getSnapshot('fac-1')
    expect(got.facilityId).toBe('fac-1')
    expect(got.data.commodities).toEqual([{ id: 'c1' }])
    expect(got.cachedAt).toBeTruthy()
  })

  test('getSnapshot returns null for a facility never cached', async () => {
    expect(await getSnapshot('never-seen')).toBeNull()
  })

  test('putSnapshot overwrites the previous snapshot for the same facility', async () => {
    await putSnapshot('fac-2', { data: { commodities: [{ id: 'old' }] } })
    await putSnapshot('fac-2', { data: { commodities: [{ id: 'new' }] } })
    const got = await getSnapshot('fac-2')
    expect(got.data.commodities).toEqual([{ id: 'new' }])
  })
})

describe('offlineDb: queue store', () => {
  const entry = (id, overrides = {}) => ({
    clientTxnId: id, operation: 'dispense', facilityId: 'fac-1',
    body: { quantity: 1 }, status: 'pending', attempts: 0,
    createdAt: new Date().toISOString(), lastAttemptAt: null, lastError: null,
    ...overrides,
  })

  test('putQueueEntry / getQueueEntry round-trips', async () => {
    await putQueueEntry(entry('tx-1'))
    const got = await getQueueEntry('tx-1')
    expect(got.clientTxnId).toBe('tx-1')
    expect(got.status).toBe('pending')
  })

  test('getQueueEntry returns null for an id never queued', async () => {
    expect(await getQueueEntry('never-queued')).toBeNull()
  })

  test('putQueueEntry with the same id overwrites (upsert, not append)', async () => {
    await putQueueEntry(entry('tx-2'))
    await putQueueEntry(entry('tx-2', { status: 'failed', lastError: 'boom' }))
    const got = await getQueueEntry('tx-2')
    expect(got.status).toBe('failed')
    expect(got.lastError).toBe('boom')
  })

  test('deleteQueueEntry removes it', async () => {
    await putQueueEntry(entry('tx-3'))
    await deleteQueueEntry('tx-3')
    expect(await getQueueEntry('tx-3')).toBeNull()
  })

  test('listQueueEntries returns entries oldest-first', async () => {
    await putQueueEntry(entry('tx-old', { createdAt: '2026-01-01T00:00:00.000Z' }))
    await putQueueEntry(entry('tx-new', { createdAt: '2026-01-02T00:00:00.000Z' }))
    await putQueueEntry(entry('tx-mid', { createdAt: '2026-01-01T12:00:00.000Z' }))
    const ids = (await listQueueEntries()).map(e => e.clientTxnId)
    expect(ids).toEqual(expect.arrayContaining(['tx-old', 'tx-mid', 'tx-new']))
    const oldIdx = ids.indexOf('tx-old'), midIdx = ids.indexOf('tx-mid'), newIdx = ids.indexOf('tx-new')
    expect(oldIdx).toBeLessThan(midIdx)
    expect(midIdx).toBeLessThan(newIdx)
  })
})
