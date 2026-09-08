// One definition of "an account that was provisioned, not made by a test".
//
// WHY THIS EXISTS. `node --test` runs test FILES in parallel against one shared
// database, so any assertion about the real population — "every Essential
// account holds two sections", "no HIV role carries Essential module scope" —
// can catch another suite's fixture mid-flight.
//
// Most fixtures live under the reserved `.invalid` TLD and are easy to exclude.
// The createUser tests cannot: createUser mints genuine `<name>@envo.ng` logins,
// because that is precisely what it is for. Those accounts are indistinguishable
// from provisioned ones except by their username prefix.
//
// Import this rather than writing the exclusion inline. Six assertions were
// patched individually before it existed, which is how a shared rule ends up
// with six slightly different spellings.
//
// Usage:
//   import { NOT_TEST_ACCOUNT } from './helpers/realAccounts.js'
//   `select … from users u where ${NOT_TEST_ACCOUNT} and …`
//
// The alias is `u` by convention; pass a different one where needed.

export const TEST_USERNAME_PREFIX = 'probe.create.'

export const notTestAccount = (alias = 'u') =>
  `${alias}.email not like '%.invalid' and ${alias}.email not like '${TEST_USERNAME_PREFIX}%'`

export const NOT_TEST_ACCOUNT = notTestAccount('u')

// The JS-side equivalent, for filtering rows already fetched.
export const isTestAccount = email =>
  String(email || '').endsWith('.invalid') || String(email || '').startsWith(TEST_USERNAME_PREFIX)
