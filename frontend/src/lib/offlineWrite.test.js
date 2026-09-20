import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

// Unit test of the module-aware routing rule itself: HIV (or no module chosen) must
// be a pure passthrough with zero queueing, and Essential must queue on a network
// failure but never on a genuine server rejection. The live, end-to-end proof of the
// full queue→drain→server round trip lives in the commit history (forced-offline
// browser verification against the real backend); this protects the ROUTING LOGIC
// from regressing silently.
const mockApi = { dispense: { record: vi.fn() } }
const mockGetModule = vi.fn()
vi.mock('./api', () => ({ api: mockApi, getModule: mockGetModule }))

const mockEnqueue = vi.fn()
vi.mock('./offlineQueue', () => ({ enqueue: mockEnqueue }))

const { offlineDispense } = await import('./offlineWrite')

const originalOnLine = Object.getOwnPropertyDescriptor(navigator, 'onLine')
function setOnline(value) {
  Object.defineProperty(navigator, 'onLine', { get: () => value, configurable: true })
}

beforeEach(() => {
  mockApi.dispense.record.mockReset()
  mockGetModule.mockReset()
  mockEnqueue.mockReset()
  mockEnqueue.mockResolvedValue({ clientTxnId: 'queued-id', operation: 'dispense', status: 'pending' })
})
afterEach(() => {
  if (originalOnLine) Object.defineProperty(navigator, 'onLine', originalOnLine)
})

describe('offlineDispense — module routing', () => {
  test('outside the Essential module, calls the live API directly and never enqueues', async () => {
    mockGetModule.mockReturnValue('hiv')
    mockApi.dispense.record.mockResolvedValue({ id: 'server-row' })
    const result = await offlineDispense({ facility_id: 'f1', quantity: 1 })
    expect(result).toEqual({ id: 'server-row' })
    expect(mockApi.dispense.record).toHaveBeenCalledTimes(1)
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  test('with no module chosen yet, also passes through unchanged', async () => {
    mockGetModule.mockReturnValue(null)
    mockApi.dispense.record.mockResolvedValue({ id: 'server-row' })
    await offlineDispense({ facility_id: 'f1', quantity: 1 })
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  test('a live-call error outside Essential propagates unchanged (no swallowing, no queueing)', async () => {
    mockGetModule.mockReturnValue('hiv')
    mockApi.dispense.record.mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }))
    await expect(offlineDispense({ facility_id: 'f1' })).rejects.toThrow('bad request')
    expect(mockEnqueue).not.toHaveBeenCalled()
  })
})

describe('offlineDispense — Essential module, online', () => {
  beforeEach(() => { mockGetModule.mockReturnValue('essential'); setOnline(true) })

  test('a normal success is NOT queued, and returns { ...data, queued: false }', async () => {
    mockApi.dispense.record.mockResolvedValue({ id: 'server-row', quantity: 5 })
    const result = await offlineDispense({ facility_id: 'f1', quantity: 5 })
    expect(result).toEqual({ id: 'server-row', quantity: 5, queued: false })
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  test('a genuine server rejection (err.status set) is rethrown, never queued', async () => {
    mockApi.dispense.record.mockRejectedValue(Object.assign(new Error('insufficient stock'), { status: 409 }))
    await expect(offlineDispense({ facility_id: 'f1' })).rejects.toThrow('insufficient stock')
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  test('a network failure (no err.status — the request never reached the server) falls back to the queue', async () => {
    mockApi.dispense.record.mockRejectedValue(new TypeError('Failed to fetch'))
    const body = { facility_id: 'f1', quantity: 3 }
    const result = await offlineDispense(body)
    expect(result).toEqual({ clientTxnId: 'queued-id', queued: true })
    expect(mockEnqueue).toHaveBeenCalledWith('dispense', 'f1', body)
  })
})

describe('offlineDispense — Essential module, offline', () => {
  test('navigator.onLine === false skips the live attempt entirely and queues immediately', async () => {
    mockGetModule.mockReturnValue('essential')
    setOnline(false)
    const body = { facility_id: 'f1', quantity: 2 }
    const result = await offlineDispense(body)
    expect(result).toEqual({ clientTxnId: 'queued-id', queued: true })
    expect(mockApi.dispense.record).not.toHaveBeenCalled()
    expect(mockEnqueue).toHaveBeenCalledWith('dispense', 'f1', body)
  })
})
