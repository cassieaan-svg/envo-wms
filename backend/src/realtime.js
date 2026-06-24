import pg from 'pg'
import jwt from 'jsonwebtoken'

// Realtime change stream (replaces Supabase realtime). A dedicated Postgres
// connection LISTENs on the 'envo_change' channel (fed by the table triggers in
// db/_migration/realtime_triggers.sql) and forwards each notification to every
// connected SSE client. The stream carries only {table, op, …} — no bulk data —
// so clients refetch through the scoped, authenticated /api endpoints.

const clients = new Set() // Express response objects

function broadcast(payloadStr) {
  const frame = `data: ${payloadStr}\n\n`
  for (const res of clients) {
    try { res.write(frame) } catch { clients.delete(res) }
  }
}

// Dedicated LISTEN connection (separate from the query pool, since LISTEN holds
// the connection open). Reconnects with backoff on error.
async function startListener() {
  const client = new pg.Client({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT) || 5432,
    database: process.env.PGDATABASE || 'envo',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD,
  })
  client.on('notification', msg => {
    if (msg.channel === 'envo_change' && msg.payload) broadcast(msg.payload)
  })
  client.on('error', err => {
    console.error('[realtime] listen connection error:', err.message)
    try { client.end() } catch { /* ignore */ }
    setTimeout(startListener, 2000)
  })
  await client.connect()
  await client.query('LISTEN envo_change')
  console.log('[realtime] listening on envo_change')
}

export function initRealtime() {
  startListener().catch(err => {
    console.error('[realtime] failed to start listener, retrying:', err.message)
    setTimeout(initRealtime, 2000)
  })
}

// SSE endpoint. EventSource can't send an Authorization header, so the JWT is
// passed as ?token= and verified here (the stream itself carries no sensitive
// data — table names + a few transfer fields). Mount this BEFORE the /api auth
// middleware so it isn't rejected for lacking the header.
export function sseHandler(req, res) {
  try {
    jwt.verify(req.query.token || '', process.env.JWT_SECRET)
  } catch {
    return res.status(401).json({ error: 'Invalid or missing token' })
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // don't let a reverse proxy buffer the stream
  })
  res.flushHeaders?.()
  res.write('retry: 3000\n\n')   // client reconnect backoff hint
  res.write(': connected\n\n')
  clients.add(res)

  // Heartbeat so idle connections aren't dropped by proxies / timeouts.
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n') } catch { /* closed */ } }, 25000)

  req.on('close', () => { clearInterval(heartbeat); clients.delete(res) })
}
