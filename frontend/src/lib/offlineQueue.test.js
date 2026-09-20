import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

// api.js is mocked here — this is a unit test of the QUEUE's own logic (claiming,
// replaying, status transitions, the stop-on-network-failure rule), not an
// integration test against a real backend. That integration proof already exists:
// every one of these operations was verified live against the real server (forced
// offline, queued, reconnected, confirmed server-side) — see the commit history for
// dispenseIdempotency-style live verification. This file protects that behaviour
// from silently regressing.
const mockApi = {
  dispense: { record: vi.fn() },
  intake: { record: vi.fn() },
  adjustments: { record: vi.fn() },
  transfers: { dispatch: vi.fn(), accept: vi.fn() },
  warehouseRequests: { create: vi.fn() },
}
vi.mock('./api', () => ({ api: mockApi }))

const { enqueue, listQueue, queueHealth, drainQueue, discardQueueEntry, retryQueueEntry, STUCK_AGE_MS, STUCK_COUNT } =
  await import('./offlineQueue')

beforeEach(() => {
  Object.values(mockApi).forEach(group => Object.values(group).forEach(fn => fn.mockReset()))
})

async function clearQueue() {
  for (const e of await listQueue()) await discardQueueEntry(e.clientTxnId)
}
afterEach(clearQueue)

describe('enqueue', () => {
  test('assigns a clientTxnId matching the backend IdempotencyService pattern (8-64 chars, letters/digits/-/_)', async () => {
    const entry = await enqueue('dispense', 'fac-1', { quantity: 5 })
    expect(entry.clientTxnId).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(entry.operation).toBe('dispense')
    expect(entry.status).toBe('pending')
    // The client_txn_id is baked into the stored body, so replaying it later sends
    // exactly what the live path would have sent, plus the id.
    expect(entry.body.client_txn_id).toBe(entry.clientTxnId)
    expect(entry.body.quantity).toBe(5)
  })

  test('two enqueues get different ids', async () => {
    const a = await enqueue('dispense', 'fac-1', { quantity: 1 })
    const b = await enqueue('dispense', 'fac-1', { quantity: 1 })
    expect(a.clientTxnId).not.toBe(b.clientTxnId)
  })

  test('rejects an unknown operation name', async () => {
    await expect(enqueue('not-a-real-operation', 'fac-1', {})).rejects.toThrow(/Unknown offline operation/)
  })
})

describe('queueHealth', () => {
  test('empty queue', async () => {
    expect(await queueHealth()).toMatchObject({ pendingCount: 0, failedCount: 0, totalCount: 0, isStuck: false })
  })

  test('counts pending and failed separately, and totalCount is everything', async () => {
    // Order matters: a network failure stops the drain (see the drainQueue tests
    // below), so the failed one must be processed FIRST to still get attempted, and
    // the network-failure one second so it's the one left pending. Two enqueues back
    // to back can land in the same millisecond, making their createdAt tie — force
    // the order explicitly rather than relying on wall-clock timing.
    mockApi.intake.record.mockRejectedValueOnce(Object.assign(new Error('bad data'), { status: 400 }))
    mockApi.dispense.record.mockRejectedValueOnce(new TypeError('offline'))
    const a = await enqueue('intake', 'fac-1', {})
    const b = await enqueue('dispense', 'fac-1', {})
    const { putQueueEntry, getQueueEntry } = await import('./offlineDb')
    await putQueueEntry({ ...(await getQueueEntry(a.clientTxnId)), createdAt: '2026-01-01T00:00:00.000Z' })
    await putQueueEntry({ ...(await getQueueEntry(b.clientTxnId)), createdAt: '2026-01-01T00:00:01.000Z' })
    await drainQueue()
    const health = await queueHealth()
    expect(health.totalCount).toBe(2)
    expect(health.failedCount).toBe(1)
    expect(health.pendingCount).toBe(1)
  })

  test('isStuck when the queue has more than STUCK_COUNT entries', async () => {
    for (let i = 0; i < STUCK_COUNT + 1; i++) await enqueue('dispense', 'fac-1', { quantity: i })
    expect((await queueHealth()).isStuck).toBe(true)
  })

  test('isStuck when the oldest entry is older than STUCK_AGE_MS', async () => {
    const entry = await enqueue('dispense', 'fac-1', {})
    const { putQueueEntry, getQueueEntry } = await import('./offlineDb')
    const stored = await getQueueEntry(entry.clientTxnId)
    await putQueueEntry({ ...stored, createdAt: new Date(Date.now() - STUCK_AGE_MS - 1000).toISOString() })
    expect((await queueHealth()).isStuck).toBe(true)
  })
})

describe('drainQueue', () => {
  test('a successful replay removes the entry from the queue', async () => {
    mockApi.dispense.record.mockResolvedValueOnce({ id: 'server-row-1' })
    await enqueue('dispense', 'fac-1', { quantity: 3 })
    const result = await drainQueue()
    expect(result.drained).toBe(1)
    expect(await listQueue()).toHaveLength(0)
  })

  test('replays with the exact body enqueued, including client_txn_id', async () => {
    mockApi.intake.record.mockResolvedValueOnce({ id: 'ok' })
    const entry = await enqueue('intake', 'fac-1', { quantity: 7, batch_number: 'B1' })
    await drainQueue()
    expect(mockApi.intake.record).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 7, batch_number: 'B1', client_txn_id: entry.clientTxnId })
    )
  })

  test('a network failure (no err.status) leaves the entry pending and stops the drain', async () => {
    mockApi.dispense.record.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await enqueue('dispense', 'fac-1', { quantity: 1 })
    const result = await drainQueue()
    expect(result.drained).toBe(0)
    expect(result.failed).toBe(0)
    const remaining = await listQueue()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].status).toBe('pending')
    expect(remaining[0].attempts).toBe(1)
  })

  test('a server rejection (err.status set) marks the entry failed, not pending, and does not stop the drain', async () => {
    mockApi.dispense.record.mockRejectedValueOnce(Object.assign(new Error('insufficient stock'), { status: 409 }))
    mockApi.intake.record.mockResolvedValueOnce({ id: 'ok' })
    await enqueue('dispense', 'fac-1', { quantity: 1 })
    await enqueue('intake', 'fac-1', { quantity: 1 })
    const result = await drainQueue()
    expect(result.failed).toBe(1)
    expect(result.drained).toBe(1)
    const remaining = await listQueue()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].status).toBe('failed')
    expect(remaining[0].lastError).toBe('insufficient stock')
  })

  test('a network failure on an earlier entry stops later entries from being attempted at all', async () => {
    mockApi.dispense.record.mockRejectedValueOnce(new TypeError('network down'))
    await enqueue('dispense', 'fac-1', { quantity: 1 })
    await enqueue('intake', 'fac-1', { quantity: 1 })
    await drainQueue()
    expect(mockApi.intake.record).not.toHaveBeenCalled()
  })

  test('concurrent drainQueue calls do not double-replay (re-entrant guard)', async () => {
    mockApi.dispense.record.mockResolvedValueOnce({ id: 'ok' })
    await enqueue('dispense', 'fac-1', { quantity: 1 })
    // Both fire at once; drainQueue's module-level `draining` flag (set synchronously,
    // before the first await) means whichever call loses the race is a same-tick
    // no-op — it never even reaches the mock.
    const [first, second] = await Promise.all([drainQueue(), drainQueue()])
    const results = [first, second]
    expect(results.some(r => r.drained === 1)).toBe(true)
    expect(results.some(r => r.drained === 0 && r.failed === 0)).toBe(true)
    expect(mockApi.dispense.record).toHaveBeenCalledTimes(1)
  })

  test('transferDispatch replays as api.transfers.dispatch(id, body) — id extracted, not sent in the body', async () => {
    mockApi.transfers.dispatch.mockResolvedValueOnce({ id: 'transfer-1', status: 'in_transit' })
    const { enqueue: enq } = await import('./offlineQueue')
    await enq('transferDispatch', null, { id: 'transfer-1', approved_by: 'tester', quantity: 5 })
    await drainQueue()
    expect(mockApi.transfers.dispatch).toHaveBeenCalledWith(
      'transfer-1',
      expect.objectContaining({ approved_by: 'tester', quantity: 5 })
    )
    const [, calledBody] = mockApi.transfers.dispatch.mock.calls[0]
    expect(calledBody.id).toBeUndefined()
  })
})

describe('retryQueueEntry / discardQueueEntry', () => {
  test('retryQueueEntry resets a failed entry to pending and clears its error', async () => {
    mockApi.dispense.record.mockRejectedValueOnce(Object.assign(new Error('bad'), { status: 400 }))
    const entry = await enqueue('dispense', 'fac-1', { quantity: 1 })
    await drainQueue()
    expect((await listQueue())[0].status).toBe('failed')

    await retryQueueEntry(entry.clientTxnId)
    const retried = (await listQueue())[0]
    expect(retried.status).toBe('pending')
    expect(retried.lastError).toBeNull()
  })

  test('discardQueueEntry removes it permanently', async () => {
    const entry = await enqueue('dispense', 'fac-1', { quantity: 1 })
    await discardQueueEntry(entry.clientTxnId)
    expect(await listQueue()).toHaveLength(0)
  })
})
