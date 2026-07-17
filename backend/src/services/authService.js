import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { query } from '../db.js'

// Auth backed by the migrated `users` table. Passwords are the original GoTrue
// bcrypt hashes ($2a$…), which bcryptjs verifies directly — so existing
// passwords keep working with no reset.

const JWT_SECRET = process.env.JWT_SECRET

// jsonwebtoken's expiresIn must be a number of seconds or an ms-style timespan
// ("7d", "20h", "60"). Guard against a malformed JWT_EXPIRES_IN in the env so a
// bad value can't throw on every login — fall back to 7 days.
function resolveExpiresIn(raw) {
  const v = (raw ?? '').toString().trim()
  if (!v) return '7d'
  if (/^\d+$/.test(v)) return Number(v)   // plain number = seconds
  if (/^\d+(\.\d+)?\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)$/i.test(v)) return v
  console.warn(`[auth] invalid JWT_EXPIRES_IN "${raw}" — falling back to 7d`)
  return '7d'
}
const JWT_EXPIRES_IN = resolveExpiresIn(process.env.JWT_EXPIRES_IN)

// Shape the user exactly like the Supabase auth user the frontend expects.
export function userPayload(u) {
  return { id: u.id, email: u.email, user_metadata: u.raw_user_meta_data || {} }
}

export function makeToken(u) {
  return jwt.sign(
    { sub: u.id, email: u.email, user_metadata: u.raw_user_meta_data || {} },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  )
}

// Verify email + password. Returns the user row or null (never reveals which
// half was wrong).
export async function verifyCredentials(email, password) {
  const { rows } = await query(
    'select id, email, encrypted_password, raw_user_meta_data from users where lower(email) = lower($1)',
    [email]
  )
  const u = rows[0]
  if (!u || !u.encrypted_password) return null
  const ok = await bcrypt.compare(password, u.encrypted_password)
  return ok ? u : null
}

export async function getUserById(id) {
  const { rows } = await query(
    'select id, email, raw_user_meta_data from users where id = $1',
    [id]
  )
  return rows[0] || null
}

export async function setPassword(userId, newPassword) {
  const hash = await bcrypt.hash(newPassword, 10)
  await query('update users set encrypted_password = $1 where id = $2', [hash, userId])
}
