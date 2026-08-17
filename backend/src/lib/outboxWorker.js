import { OutboxService } from '../services/outboxService.js'

// Periodically delivers whatever is queued in the outbox. Runs in-process; a single
// backend instance is assumed (SKIP LOCKED makes it safe if that ever changes).
const INTERVAL_MS = 15000
let timer = null

async function tick() {
  try {
    await OutboxService.drainOnce()
  } catch (err) {
    console.error('[outbox] drain failed:', err.message)
  }
}

export function startOutboxWorker() {
  if (timer) return
  timer = setInterval(tick, INTERVAL_MS)
  timer.unref?.()   // don't keep the process alive just for the drain timer
  tick()            // deliver anything already waiting at startup
}

export function stopOutboxWorker() {
  if (timer) { clearInterval(timer); timer = null }
}
