import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

const mockApi = { facilitySnapshot: { get: vi.fn() } }
vi.mock('./api', () => ({ api: mockApi }))

// offlineDb is mocked (not fake-indexeddb) so every test here settles on plain
// microtasks — IndexedDB's own event-based completion timing would otherwise make
// the timer/event-driven tests below flaky. offlineDb.js's actual read/write
// behaviour is covered directly in offlineDb.test.js.
const mockPutSnapshot = vi.fn().mockResolvedValue(undefined)
const mockGetSnapshot = vi.fn().mockResolvedValue(null)
vi.mock('./offlineDb', () => ({ putSnapshot: mockPutSnapshot, getSnapshot: mockGetSnapshot }))

const { pullSnapshot, cachedSnapshot, onSnapshotUpdated, startAutoSync, stopAutoSync } = await import('./snapshotSync')

function setOnline(value) {
  Object.defineProperty(navigator, 'onLine', { get: () => value, configurable: true })
}

beforeEach(() => {
  mockApi.facilitySnapshot.get.mockReset()
  mockPutSnapshot.mockClear()
  mockGetSnapshot.mockReset().mockResolvedValue(null)
  setOnline(true)
})
afterEach(() => {
  stopAutoSync()
  vi.useRealTimers()
})

describe('pullSnapshot', () => {
  test('fetches, caches (putSnapshot) and returns the snapshot', async () => {
    const envelope = { generatedAt: 'now', data: { commodities: [{ id: 'c1' }] } }
    mockApi.facilitySnapshot.get.mockResolvedValue(envelope)
    const result = await pullSnapshot('fac-1')
    expect(result).toBe(envelope)
    expect(mockPutSnapshot).toHaveBeenCalledWith('fac-1', envelope)
  })

  test('cachedSnapshot reads through to offlineDb.getSnapshot', async () => {
    mockGetSnapshot.mockResolvedValue({ facilityId: 'fac-1', data: { commodities: [] } })
    const result = await cachedSnapshot('fac-1')
    expect(mockGetSnapshot).toHaveBeenCalledWith('fac-1')
    expect(result.facilityId).toBe('fac-1')
  })

  test('notifies onSnapshotUpdated listeners with the new envelope', async () => {
    const envelope = { data: { commodities: [] } }
    mockApi.facilitySnapshot.get.mockResolvedValue(envelope)
    const seen = []
    const unsubscribe = onSnapshotUpdated(e => seen.push(e))
    await pullSnapshot('fac-2')
    expect(seen).toEqual([envelope])
    unsubscribe()
  })

  test('unsubscribing stops further notifications', async () => {
    mockApi.facilitySnapshot.get.mockResolvedValue({ data: {} })
    const seen = []
    const unsubscribe = onSnapshotUpdated(e => seen.push(e))
    unsubscribe()
    await pullSnapshot('fac-3')
    expect(seen).toEqual([])
  })

  test('a fetch failure propagates (caller decides whether to swallow it)', async () => {
    mockApi.facilitySnapshot.get.mockRejectedValue(new Error('network down'))
    await expect(pullSnapshot('fac-4')).rejects.toThrow('network down')
  })

  test('cachedSnapshot returns null for a facility never pulled', async () => {
    expect(await cachedSnapshot('never-pulled-facility')).toBeNull()
  })
})

describe('startAutoSync / stopAutoSync', () => {
  test('pulls immediately on start when online', async () => {
    mockApi.facilitySnapshot.get.mockResolvedValue({ data: {} })
    startAutoSync('fac-5')
    // The initial pull is fire-and-forget inside startAutoSync — give its promise a
    // tick to run.
    await Promise.resolve(); await Promise.resolve()
    expect(mockApi.facilitySnapshot.get).toHaveBeenCalledTimes(1)
  })

  test('does not pull immediately on start when offline', async () => {
    setOnline(false)
    mockApi.facilitySnapshot.get.mockResolvedValue({ data: {} })
    startAutoSync('fac-6')
    await Promise.resolve(); await Promise.resolve()
    expect(mockApi.facilitySnapshot.get).not.toHaveBeenCalled()
  })

  test('pulls again on a real "online" DOM event', async () => {
    setOnline(false)
    mockApi.facilitySnapshot.get.mockResolvedValue({ data: {} })
    startAutoSync('fac-7')
    await Promise.resolve()
    expect(mockApi.facilitySnapshot.get).not.toHaveBeenCalled()

    setOnline(true)
    window.dispatchEvent(new Event('online'))
    await Promise.resolve(); await Promise.resolve()
    expect(mockApi.facilitySnapshot.get).toHaveBeenCalledTimes(1)
  })

  test('stopAutoSync removes the online listener — a later event pulls nothing', async () => {
    mockApi.facilitySnapshot.get.mockResolvedValue({ data: {} })
    startAutoSync('fac-8')
    await Promise.resolve(); await Promise.resolve()
    mockApi.facilitySnapshot.get.mockClear()

    stopAutoSync()
    window.dispatchEvent(new Event('online'))
    await Promise.resolve(); await Promise.resolve()
    expect(mockApi.facilitySnapshot.get).not.toHaveBeenCalled()
  })

  test('pulls again on the periodic timer', async () => {
    vi.useFakeTimers()
    mockApi.facilitySnapshot.get.mockResolvedValue({ data: {} })
    startAutoSync('fac-9')
    await vi.advanceTimersByTimeAsync(0)
    expect(mockApi.facilitySnapshot.get).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(mockApi.facilitySnapshot.get).toHaveBeenCalledTimes(2)
  })

  test('starting again while already running does not leave two timers/listeners behind', async () => {
    vi.useFakeTimers()
    mockApi.facilitySnapshot.get.mockResolvedValue({ data: {} })
    startAutoSync('fac-10')
    await vi.advanceTimersByTimeAsync(0)
    startAutoSync('fac-10') // restart, as a real remount would do
    await vi.advanceTimersByTimeAsync(0)
    mockApi.facilitySnapshot.get.mockClear()

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    // If the first interval leaked, this would be 2.
    expect(mockApi.facilitySnapshot.get).toHaveBeenCalledTimes(1)
  })
})
