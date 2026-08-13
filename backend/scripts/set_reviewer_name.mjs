// Set (or clear) an account's `reviewer_name` — the name prefilled into the
// "Reviewed by" / signer fields.
//
// Why a separate key rather than editing full_name: full_name is what the sidebar
// shows as "LOGGED IN AS", and several accounts are deliberately named for the ROLE
// they represent ("Akwa Ibom State Admin") rather than the person holding it.
// reviewer_name lets such an account sign redistribution reviews as a person without
// relabelling the session. The UI falls back to full_name when it is absent, so
// accounts without one are completely unaffected.
//
// It is a PREFILL only — the field stays editable, so the reviewer can type someone
// else's name when a colleague signs off instead.
//
// Safety: dry-run by default; prints the before/after metadata and changes nothing.
//
//   node scripts/set_reviewer_name.mjs <email> "SPO Jnr"           # preview
//   node scripts/set_reviewer_name.mjs <email> "SPO Jnr" --apply   # commit
//   node scripts/set_reviewer_name.mjs <email> --clear --apply     # remove it

import { query, pool } from '../src/db.js'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const CLEAR = args.includes('--clear')
const positional = args.filter(a => !a.startsWith('--'))
const [email, name] = positional

if (!email || (!CLEAR && !name)) {
  console.error('usage: node scripts/set_reviewer_name.mjs <email> "<name>" [--apply]')
  console.error('       node scripts/set_reviewer_name.mjs <email> --clear [--apply]')
  process.exit(1)
}

const { rows } = await query(
  'select id, email, raw_user_meta_data as meta from users where lower(email) = lower($1)', [email])

if (!rows.length) {
  console.error(`no account found for ${email}`)
  await pool.end()
  process.exit(1)
}

const u = rows[0]
const before = u.meta || {}
const after = { ...before }
if (CLEAR) delete after.reviewer_name
else after.reviewer_name = name

console.log(`account : ${u.email}`)
console.log(`sidebar : ${before.full_name || before.fn || '(none)'}   (full_name — NOT changed)`)
console.log(`reviewer: ${before.reviewer_name || '(none)'}  ->  ${after.reviewer_name || '(none)'}`)

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.')
} else if (JSON.stringify(before) === JSON.stringify(after)) {
  console.log('\nalready set to that value — nothing to do.')
} else {
  // Merge rather than replace, so no other metadata key can be lost by this script.
  await query(
    `update users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || $2::jsonb
      where id = $1`, [u.id, JSON.stringify({ reviewer_name: after.reviewer_name ?? null })])
  if (CLEAR) {
    await query(`update users set raw_user_meta_data = raw_user_meta_data - 'reviewer_name' where id = $1`, [u.id])
  }
  console.log('\napplied. The account must sign out and back in — the name travels in the JWT.')
}

await pool.end()
