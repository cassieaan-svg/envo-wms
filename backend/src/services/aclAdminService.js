import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { query, withTransaction } from '../db.js'
import { SECTION_CATEGORIES } from '../constants/sections.js'
import { FEATURES, isDeclaredFeature } from '../constants/features.js'

// Same alphabet and shape the provisioning scripts use: no look-alike characters
// (0/O, 1/l/I), and at least one digit so it survives a password policy.
const PW_CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
function generatePassword() {
  let pw
  do { pw = Array.from(crypto.randomBytes(12), b => PW_CHARS[b % PW_CHARS.length]).join('') }
  while (!/[2-9]/.test(pw))
  return pw
}

// Read and write models for the administration screens.
//
// THIS FILE IS NOT AN AUTHORIZATION LAYER FOR THE APP. It configures the ACL
// tables, which are still shadow-only — scope.js remains the sole authority for
// every operational request. Nothing here is consulted when a user reads stock.
//
// It does, however, enforce the GOVERNANCE rules on its own writes, because a
// configuration surface that trusts its caller is a privilege-escalation tool.
// Every rule below is applied server-side; the UI's hidden buttons and filtered
// lists are convenience, never protection.
//
// The rules (Phase 2M governance):
//   * user administration requires write capability — so system_admin,
//     state_admin and essential_admin, and nobody else;
//   * an administrator may never create or modify a role ABOVE their own;
//   * an administrator may never modify their OWN role, scope or permissions;
//   * a state_admin is confined to users in its own state;
//   * direct grant/deny overrides are system_admin only;
//   * facility_role is frontend-only and must never become an authorization
//     source — it is deliberately not writable here.

// Rank orders the roles for the "never above your own level" rule. Equal rank is
// allowed (a state_admin may create another state_admin in its own state); a
// strictly higher rank is not.
const ROLE_RANK = {
  facility: 1,
  state_viewer: 2,
  cluster_admin: 2,
  lga_admin: 2,
  state_admin: 3,
  essential_admin: 3,
  overall_admin: 4,
  system_admin: 5,
}

// Which geography scope_type each role must carry. `null` means the role is
// national and must carry NO geography row — an empty scope means unconstrained,
// so allowing one on a narrower role would be a silent widening.
const REQUIRED_GEOGRAPHY = {
  facility: 'facility',
  state_admin: 'state',
  state_viewer: 'state',
  cluster_admin: 'cluster',
  lga_admin: 'lga',
  overall_admin: null,
  system_admin: null,
  essential_admin: 'state',
}

export const ASSIGNABLE_ROLES = Object.keys(ROLE_RANK)
export const SECTIONS = Object.keys(SECTION_CATEGORIES)

export class AclAdminError extends Error {
  constructor(message, status = 400, code = 'VALIDATION') {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * The caller's administrative identity, derived from req.scope — i.e. from the
 * JWT via scope.js, NOT from the ACL tables. Returns null for everyone who may
 * not administer users at all.
 *
 * `state` non-null confines every read and write to that state.
 */
export function adminIdentity(scope, actorId) {
  if (!scope || !actorId) return null
  if (scope.accessLevel === 'system_admin') {
    return { kind: 'system_admin', actorId, rank: ROLE_RANK.system_admin, state: null,
             module: null, canOverride: true }
  }
  if (scope.accessLevel === 'state_admin' && scope.adminState) {
    return { kind: 'state_admin', actorId, rank: ROLE_RANK.state_admin, state: scope.adminState,
             module: null, canOverride: false }
  }
  // Phase 2M.2. Confined on TWO dimensions, not one: its own state AND the
  // Essential module. "Essential Commodities users within their authorized
  // scope" means it administers its own programme's people, not every account
  // that happens to sit in the same state — so `module` narrows further, and
  // every read and write below intersects both.
  if (scope.accessLevel === 'essential_admin' && scope.adminState) {
    return { kind: 'essential_admin', actorId, rank: ROLE_RANK.essential_admin,
             state: scope.adminState, module: 'essential', canOverride: false }
  }
  return null
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * Users the caller may see, with their role and scope. Searchable by email.
 *
 * A state_admin sees only users in its own state — determined from the user's
 * own admin_state, or from the state of the facility they are attached to.
 */
export async function listUsers(identity, { q = '', limit = 50, offset = 0 } = {}) {
  const params = []
  const conds = [`u.email not like '%.invalid'`]

  if (identity.state) {
    params.push(identity.state)
    conds.push(`(
      u.raw_user_meta_data->>'admin_state' = $${params.length}
      or exists (select 1 from facilities f
                  where f.id::text = u.raw_user_meta_data->>'facility_id'
                    and f.state = $${params.length})
    )`)
  }
  if (identity.module) {
    // Users of this administrator's own programme only. An account with NO module
    // scope is excluded rather than included: an absent dimension means
    // unconstrained, so treating it as "not mine" is the fail-closed reading.
    params.push(identity.module)
    conds.push(`exists (select 1 from user_role_scopes s
                         where s.user_id = u.id and s.dimension = 'module'
                           and s.scope_id = $${params.length})`)
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`)
    conds.push(`lower(u.email) like $${params.length}`)
  }

  params.push(Math.min(Number(limit) || 50, 200))
  const limitAt = params.length
  params.push(Math.max(Number(offset) || 0, 0))

  // The scope shown is the ACL GEOGRAPHY ROW, not the legacy facility_id. Only
  // facility users have a facility_id, so joining on that alone left every admin
  // tier showing "—" while actually holding a real state/cluster/LGA scope. For a
  // facility scope the id is resolved to the facility's name; the others are
  // already human-readable.
  const { rows } = await query(`
    select u.id, u.email, u.created_at,
           u.raw_user_meta_data->>'access_level'      legacy_access_level,
           u.raw_user_meta_data->>'commodity_section' legacy_section,
           r.name role,
           f.name facility_name, f.state, f.lga, f.cluster,
           g.scope_type scope_type,
           coalesce(gf.name, g.scope_id) scope_label,
           -- AGGREGATED, not joined. A dual-module login (see
           -- 20260907_acl_dual_module_logins.sql) holds TWO module rows, and a
           -- plain LEFT JOIN duplicates the whole user row once per module.
           (select string_agg(mm.scope_id, ' + ' order by mm.scope_id)
              from user_role_scopes mm
             where mm.user_id = u.id and mm.dimension = 'module') module,
           -- The ACL SECTION SCOPE, aggregated like the module column. The list
           -- reports ACL configuration in every other column (role, scope,
           -- module), so reporting legacy metadata here read as "unscoped" for
           -- any account whose section lives only in the ACL — the lga_admin and
           -- state_admin Essential accounts, whose metadata carries no
           -- commodity_section at all. Legacy stays visible in the detail panel,
           -- where it is explicitly labelled as the live sign-in metadata.
           (select string_agg(ss.scope_id, ' + ' order by ss.scope_id)
              from user_role_scopes ss
             where ss.user_id = u.id and ss.dimension = 'commodity'
               and ss.scope_type = 'section') acl_section
      from users u
      left join user_roles ur on ur.user_id = u.id
      left join roles r on r.id = ur.role_id
      left join facilities f on f.id::text = u.raw_user_meta_data->>'facility_id'
      left join user_role_scopes g
        on g.user_id = u.id and g.dimension = 'geography'
      left join facilities gf
        on g.scope_type = 'facility' and gf.id::text = g.scope_id
     where ${conds.join(' and ')}
     order by u.email
     limit $${limitAt} offset $${limitAt + 1}`, params)

  const { rows: count } = await query(
    `select count(*)::int n from users u where ${conds.join(' and ')}`,
    params.slice(0, params.length - 2))

  return { users: rows, total: count[0].n }
}

/**
 * One user's full configuration: role, every scope row, and the permission list
 * split into role-inherited versus direct override.
 *
 * The split is the point. A UI that shows one merged list invites an
 * administrator to "grant" something the role already carries, creating a direct
 * override that then survives a role change.
 */
export async function getUserConfig(identity, userId) {
  const { rows: users } = await query(`
    select u.id, u.email, u.created_at, u.raw_user_meta_data meta,
           f.name facility_name, f.state, f.lga, f.cluster
      from users u
      left join facilities f on f.id::text = u.raw_user_meta_data->>'facility_id'
     where u.id = $1`, [userId])
  if (!users.length) throw new AclAdminError('User not found', 404, 'NOT_FOUND')
  const user = users[0]

  await assertInScope(identity, user)

  const [{ rows: roleRows }, { rows: scopes }, { rows: overrides }, { rows: all }] = await Promise.all([
    query(`select r.name from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1`, [userId]),
    query(`select dimension, scope_type, scope_id from user_role_scopes where user_id = $1
            order by dimension, scope_type, scope_id`, [userId]),
    query(`select permission_key, effect, scope_type, scope_id from user_permissions
            where user_id = $1 order by permission_key`, [userId]),
    query(`select key, module, description from permissions where is_active order by key`),
  ])

  const role = roleRows[0]?.name || null
  const { rows: inherited } = role
    ? await query(`select rp.permission_key key from role_permissions rp
                     join roles r on r.id = rp.role_id where r.name = $1`, [role])
    : { rows: [] }

  const inheritedSet = new Set(inherited.map(r => r.key))
  const overrideBy = new Map(overrides.map(o => [o.permission_key, o]))

  const permissions = all.map(p => {
    const o = overrideBy.get(p.key)
    return {
      key: p.key,
      module: p.module,
      description: p.description,
      inherited: inheritedSet.has(p.key),
      override: o ? o.effect : null,
      // The effective answer, computed the same way the resolver does it:
      // deny beats grant beats role.
      effective: o ? o.effect === 'grant' : inheritedSet.has(p.key),
    }
  })

  return {
    id: user.id,
    email: user.email,
    created_at: user.created_at,
    role,
    // Legacy metadata is shown READ-ONLY. It is what scope.js actually enforces
    // today, so hiding it would make the screen look authoritative when it is
    // not — and facility_role is displayed precisely so it is visible as the
    // frontend-only field it is.
    legacy: {
      access_level: user.meta?.access_level ?? null,
      commodity_section: user.meta?.commodity_section ?? null,
      facility_role: user.meta?.facility_role ?? null,
      facility_name: user.facility_name,
      state: user.state, lga: user.lga, cluster: user.cluster,
    },
    scopes,
    permissions,
    editable: canEdit(identity, { id: user.id, role }),
  }
}

// ── Governance ──────────────────────────────────────────────────────────────

// 404 rather than 403 throughout: an administrator must not be able to probe for
// the existence of accounts outside its remit.
const notFound = () => { throw new AclAdminError('User not found', 404, 'NOT_FOUND') }

async function assertInScope(identity, user) {
  if (identity.state) {
    const userState = user.meta?.admin_state || user.state
    if (userState !== identity.state) notFound()
  }
  if (identity.module) {
    const { rows } = await query(
      `select 1 from user_role_scopes
        where user_id = $1 and dimension = 'module' and scope_id = $2`,
      [user.id, identity.module])
    // No module row means unconstrained, which is NOT "in my module" — an
    // administrator confined to one programme must not administer an account
    // that spans all of them.
    if (!rows.length) notFound()
  }
}

function canEdit(identity, target) {
  if (target.id === identity.actorId) return false
  if (target.role && ROLE_RANK[target.role] > identity.rank) return false
  return true
}

/**
 * Every rule that governs a write, in one place so the route cannot bypass one
 * by calling a different method.
 */
async function assertMayWrite(identity, userId, nextRole) {
  if (userId === identity.actorId) {
    throw new AclAdminError(
      'You cannot change your own role, scope or permissions.', 403, 'SELF_EDIT')
  }

  const { rows } = await query(`
    select u.id, u.raw_user_meta_data meta, f.state, r.name role
      from users u
      left join facilities f on f.id::text = u.raw_user_meta_data->>'facility_id'
      left join user_roles ur on ur.user_id = u.id
      left join roles r on r.id = ur.role_id
     where u.id = $1`, [userId])
  if (!rows.length) throw new AclAdminError('User not found', 404, 'NOT_FOUND')
  const target = rows[0]

  await assertInScope(identity, target)

  // Not above your own level — checked on BOTH the current role and the
  // requested one. Checking only the requested role would let a state_admin
  // demote an overall_admin; checking only the current role would let it create
  // one.
  if (target.role && ROLE_RANK[target.role] > identity.rank) {
    throw new AclAdminError(
      `You cannot modify a ${target.role} account.`, 403, 'ABOVE_LEVEL')
  }
  if (nextRole && ROLE_RANK[nextRole] > identity.rank) {
    throw new AclAdminError(
      `You cannot assign the ${nextRole} role.`, 403, 'ABOVE_LEVEL')
  }
  return target
}

/**
 * The modules the ACTOR itself holds. Read from the actor's own scope rows rather
 * than hard-coded, so "what may I grant" tracks "what do I have" without a second
 * copy of that decision in code.
 *
 * An empty result means unconstrained (system_admin), not "nothing".
 */
async function actorModules(identity) {
  const { rows } = await query(
    `select scope_id from user_role_scopes where user_id = $1 and dimension = 'module'`,
    [identity.actorId])
  return rows.map(r => r.scope_id)
}

async function validateScopes(role, scopes, identity) {
  // A module-confined administrator may only produce users inside the modules it
  // holds ITSELF. Without this it could hand an account a module it does not have
  // — or omit the module row entirely, which means unconstrained — and so create
  // an administrator wider than itself.
  //
  // A SUBSET check, not equality: an Essential administrator holds both hiv and
  // essential, and must be able to create a single-module user as well as a
  // dual-module one.
  if (identity?.module) {
    const mine = await actorModules(identity)
    const asked = scopes.filter(s => s.dimension === 'module').map(s => s.scope_id)
    if (!asked.length) {
      throw new AclAdminError(
        'A module is required — an account with none is unconstrained across every module.',
        403, 'OUT_OF_MODULE')
    }
    const outside = asked.filter(mod => !mine.includes(mod))
    if (outside.length) {
      throw new AclAdminError(
        `You may only grant modules you hold yourself (${mine.join(', ') || 'none'}).`,
        403, 'OUT_OF_MODULE')
    }
  }

  const required = REQUIRED_GEOGRAPHY[role]
  const geography = scopes.filter(s => s.dimension === 'geography')

  if (required === null) {
    if (geography.length) {
      throw new AclAdminError(
        `The ${role} role is national and must carry no geographic scope.`)
    }
  } else {
    if (geography.length !== 1) {
      throw new AclAdminError(
        `The ${role} role needs exactly one ${required} scope.`)
    }
    if (geography[0].scope_type !== required) {
      throw new AclAdminError(
        `The ${role} role is scoped by ${required}, not ${geography[0].scope_type}.`)
    }
  }

  for (const s of scopes) {
    if (!s.scope_id || !String(s.scope_id).trim()) {
      // An empty scope_id means "unconstrained" to the resolver. Accepting one
      // from a form would turn a typo into a privilege grant.
      throw new AclAdminError('A scope value cannot be empty.')
    }
    if (s.dimension === 'commodity' && s.scope_type === 'section'
        && !Object.hasOwn(SECTION_CATEGORIES, s.scope_id)) {
      throw new AclAdminError(`"${s.scope_id}" is not a declared section.`)
    }
  }
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Set a user's role and scope rows together, in ONE transaction.
 *
 * Role and scope are inseparable: a role with the wrong scope shape is either
 * broken (a facility user with no facility) or dangerous (a facility user with a
 * state scope). Writing them separately would leave a window where one is
 * applied and the other is not.
 */
export async function setUserRoleAndScope(identity, userId, { role, scopes = [] }) {
  if (!ASSIGNABLE_ROLES.includes(role)) {
    throw new AclAdminError(`Unknown role "${role}".`)
  }
  await assertMayWrite(identity, userId, role)
  await validateScopes(role, scopes, identity)

  await withTransaction(async exec => {
    const { rows: r } = await exec(`select id from roles where name = $1`, [role])
    if (!r.length) throw new AclAdminError(`Role "${role}" is not seeded.`, 500, 'MISSING_ROLE')
    const roleId = r[0].id

    // user_roles.scope_type/scope_id are NOT vestigial yet, despite the Phase 2G
    // note that geography moved to user_role_scopes. The resolver's
    // own_facility_only check still reads `assignment.scope_type` — so writing
    // ('','') here would leave a facility user unable to record a dispense,
    // because the grant would find no facility scope to require. The pair is
    // therefore kept in step with the geography row; a national role has none,
    // and ('','') is exactly how Phase 2D represents that.
    const geo = scopes.find(s => s.dimension === 'geography')
    await exec(`delete from user_role_scopes where user_id = $1`, [userId])
    await exec(`delete from user_roles where user_id = $1`, [userId])
    await exec(
      `insert into user_roles (user_id, role_id, scope_type, scope_id) values ($1, $2, $3, $4)`,
      [userId, roleId, geo?.scope_type ?? '', geo ? String(geo.scope_id).trim() : ''])
    for (const s of scopes) {
      await exec(
        `insert into user_role_scopes (user_id, role_id, dimension, scope_type, scope_id)
         values ($1, $2, $3, $4, $5) on conflict do nothing`,
        [userId, roleId, s.dimension, s.scope_type, String(s.scope_id).trim()])
    }
  })

  return getUserConfig(identity, userId)
}

/**
 * Create a new account.
 *
 * THIS IS THE ONE WRITE ON THIS SURFACE THAT AFFECTS LIVE AUTHORIZATION, and it
 * cannot be otherwise: scope.js decides access from raw_user_meta_data, so an
 * account with no metadata can sign in and reach nothing. Every other write here
 * touches ACL tables only and takes effect at cutover.
 *
 * Two things keep that safe:
 *
 *   1. METADATA IS DERIVED, NEVER ACCEPTED. The caller sends a role and scopes,
 *      both validated by the same rules as an edit; the metadata is computed
 *      from them here. A client cannot post `{ access_level: 'overall_admin' }`
 *      and have it stored, because the request has no metadata field at all.
 *   2. The role and scope validation runs BEFORE anything is written, inside one
 *      transaction with the ACL rows.
 *
 * The password is generated server-side and returned ONCE. It is never stored in
 * plaintext and never logged — the same handling the provisioning scripts use.
 */
export async function createUser(identity, { username, role, scopes = [] } = {}) {
  const name = String(username || '').trim().replace(/@envo\.ng$/i, '').toLowerCase()
  if (!name) throw new AclAdminError('A username is required.')
  if (!/^[a-z0-9._-]+$/.test(name)) {
    throw new AclAdminError('Username may contain only letters, digits, dot, dash and underscore.')
  }
  if (!ASSIGNABLE_ROLES.includes(role)) throw new AclAdminError(`Unknown role "${role}".`)

  // The same ceiling an edit obeys: never create a role above your own.
  if (ROLE_RANK[role] > identity.rank) {
    throw new AclAdminError(`You cannot create a ${role} account.`, 403, 'ABOVE_LEVEL')
  }
  await validateScopes(role, scopes, identity)

  const geo = scopes.find(s => s.dimension === 'geography')
  const sections = scopes.filter(s => s.dimension === 'commodity' && s.scope_type === 'section')
                         .map(s => s.scope_id)
  const modules = scopes.filter(s => s.dimension === 'module').map(s => s.scope_id)

  // A state-confined administrator may only create inside its own state — checked
  // against the geography that will actually be written, whatever its shape.
  if (identity.state) {
    const inState = geo && (
      geo.scope_type === 'state' ? geo.scope_id === identity.state
      : (await query(
          `select 1 from facilities where ${geo.scope_type === 'facility' ? 'id::text' : geo.scope_type} = $1
             and state = $2`, [geo.scope_id, identity.state])).rows.length > 0)
    if (!inState) {
      throw new AclAdminError(`You may only create accounts in ${identity.state}.`, 403, 'OUT_OF_SCOPE')
    }
  }

  const email = `${name}@envo.ng`
  const { rows: existing } = await query(`select 1 from users where lower(email) = $1`, [email])
  if (existing.length) throw new AclAdminError(`${email} already exists.`, 409, 'DUPLICATE')

  // Metadata derived from the validated role and scopes — see the note above.
  const meta = { access_level: role, email_verified: true }
  if (geo?.scope_type === 'facility') {
    const { rows: f } = await query(`select name, state from facilities where id = $1`, [geo.scope_id])
    if (!f.length) throw new AclAdminError('That facility does not exist.')
    meta.facility_id = geo.scope_id
    meta.facility_name = f[0].name
    meta.admin_state = f[0].state
  } else if (geo?.scope_type === 'state') meta.admin_state = geo.scope_id
  else if (geo?.scope_type === 'lga') meta.admin_lga = geo.scope_id
  else if (geo?.scope_type === 'cluster') meta.admin_cluster = geo.scope_id

  // commodity_section is single-valued in the legacy metadata, so a multi-section
  // account records the first as its live pin. The ACL carries the full set; the
  // two diverge deliberately, exactly as they do for the existing Essential
  // accounts.
  if (sections.length) meta.commodity_section = sections[0]
  // The essential-commodities branch's live gate. Set it when the account is
  // actually being given that module, so ACL and legacy agree from the start.
  if (modules.includes('essential')) meta.essential = true

  const password = generatePassword()
  const hash = await bcrypt.hash(password, 10)

  const id = await withTransaction(async exec => {
    const { rows: r } = await exec(`select id from roles where name = $1`, [role])
    if (!r.length) throw new AclAdminError(`Role "${role}" is not seeded.`, 500, 'MISSING_ROLE')
    const roleId = r[0].id

    const { rows: u } = await exec(
      `insert into users (id, email, encrypted_password, raw_user_meta_data)
       values (gen_random_uuid(), $1, $2, $3::jsonb) returning id`,
      [email, hash, JSON.stringify(meta)])
    const userId = u[0].id

    await exec(
      `insert into user_roles (user_id, role_id, scope_type, scope_id) values ($1, $2, $3, $4)`,
      [userId, roleId, geo?.scope_type ?? '', geo ? String(geo.scope_id).trim() : ''])
    for (const s of scopes) {
      await exec(
        `insert into user_role_scopes (user_id, role_id, dimension, scope_type, scope_id)
         values ($1, $2, $3, $4, $5) on conflict do nothing`,
        [userId, roleId, s.dimension, s.scope_type, String(s.scope_id).trim()])
    }
    return userId
  })

  // Returned ONCE. The caller shows it to the administrator and it is never
  // retrievable again — only a bcrypt hash is stored.
  return { user: await getUserConfig(identity, id), username: name, password }
}

/**
 * Set or clear a direct per-user override. system_admin only.
 */
export async function setUserOverride(identity, userId, { permission_key, effect }) {
  if (!identity.canOverride) {
    throw new AclAdminError(
      'Only a system administrator may set a direct permission override.', 403, 'FORBIDDEN')
  }
  await assertMayWrite(identity, userId, null)

  const { rows: p } = await query(
    `select 1 from permissions where key = $1 and is_active`, [permission_key])
  if (!p.length) throw new AclAdminError(`Unknown permission "${permission_key}".`)

  if (effect === null) {
    await query(`delete from user_permissions where user_id = $1 and permission_key = $2`,
      [userId, permission_key])
  } else {
    if (effect !== 'grant' && effect !== 'deny') {
      throw new AclAdminError(`Effect must be "grant", "deny" or null.`)
    }
    await query(`
      insert into user_permissions (user_id, permission_key, effect, scope_type, scope_id)
      values ($1, $2, $3, '', '')
      on conflict (user_id, permission_key, scope_type, scope_id)
        do update set effect = excluded.effect`,
      [userId, permission_key, effect])
  }
  return getUserConfig(identity, userId)
}

// ── Feature configuration ───────────────────────────────────────────────────

/**
 * The declared feature registry, as the UI needs it. Sourced from features.js so
 * the screen cannot offer a feature nothing enforces.
 */
export function featureRegistry() {
  return Object.entries(FEATURES).map(([key, suppresses]) => ({ key, suppresses }))
}

/**
 * Configuration rows for the caller's facilities. Absent row = enabled, so this
 * returns only the explicit disables; the UI fills in the rest.
 */
export async function listFeatureConfig(identity) {
  // Feature configuration is keyed by SECTION (pharmacy/lab/…), and sections are
  // an HIV concept — the Essential module has categories, not sections. So a
  // module-confined administrator has nothing to configure here, and showing it
  // another module's configuration would be a cross-module read.
  if (identity.module) return []

  const params = []
  let where = ''
  if (identity.state) {
    params.push(identity.state)
    where = `where f.state = $1`
  }
  const { rows } = await query(`
    select fc.facility_id, f.name facility_name, f.state,
           fc.department, fc.feature, fc.enabled, fc.updated_at
      from feature_config fc
      join facilities f on f.id = fc.facility_id
      ${where}
     order by f.name, fc.department, fc.feature`, params)
  return rows
}

/**
 * Enable or disable one feature for one department at one facility.
 *
 * DENY-ONLY, and enforced as such: enabling deletes the row rather than storing
 * `enabled = true`. An absent row already means enabled, so a stored `true` would
 * be a second representation of the same state — and the first step towards
 * someone reading configuration as a grant.
 */
export async function setFeatureConfig(identity, { facility_id, department, feature, enabled }) {
  if (identity.module) {
    throw new AclAdminError(
      `Feature configuration is organised by section, which belongs to the HIV module. An administrator scoped to the ${identity.module} module has no sections to configure.`,
      403, 'OUT_OF_MODULE')
  }
  if (!isDeclaredFeature(feature)) {
    throw new AclAdminError(
      `"${feature}" is not a declared feature. Features are declared in code so a typo cannot create one that nothing enforces.`)
  }
  if (!Object.hasOwn(SECTION_CATEGORIES, department)) {
    throw new AclAdminError(`"${department}" is not a declared section.`)
  }

  const { rows } = await query(`select id, state from facilities where id = $1`, [facility_id])
  if (!rows.length) throw new AclAdminError('Facility not found', 404, 'NOT_FOUND')
  if (identity.state && rows[0].state !== identity.state) {
    throw new AclAdminError('That facility is outside your state.', 403, 'OUT_OF_SCOPE')
  }

  if (enabled) {
    await query(
      `delete from feature_config where facility_id = $1 and department = $2 and feature = $3`,
      [facility_id, department, feature])
  } else {
    await query(`
      insert into feature_config (facility_id, department, feature, enabled, updated_by)
      values ($1, $2, $3, false, $4)
      on conflict (facility_id, department, feature)
        do update set enabled = false, updated_by = excluded.updated_by, updated_at = now()`,
      [facility_id, department, feature, identity.actorId])
  }
  return listFeatureConfig(identity)
}
