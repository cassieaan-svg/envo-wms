-- Audit finding B-1: the rollback path for the ACL cutover.
--
-- The cutover gates require "a single flag returning authorization to legacy
-- without a deploy, tested before cutover, not after" (authorization-model.md
-- gate 9, gap-closure-design.md criterion 4). Nothing implemented it. This is
-- that flag, plus somewhere to record what the two authorities disagree about.
--
-- ── authorization_mode ──────────────────────────────────────────────────────
--
-- ONE ROW, enforced by a primary key on a constant. Three values:
--
--   legacy    scope.js decides. The resolver is never consulted — not even
--             computed. This is the DEFAULT and the state production is in.
--   shadow    scope.js decides. The resolver is computed alongside and every
--             disagreement is recorded. Behaviour is identical to `legacy`;
--             the only difference is that divergences become visible.
--   enforce   the resolver decides, and disagreements are still recorded.
--             scope.js is still computed, so rolling back is a value change.
--
-- WHY A TABLE AND NOT ONLY AN ENV VAR. "Without a deploy" is the requirement,
-- and on a single-VM manual-deploy topology editing .env and restarting the
-- service under pressure is neither fast nor reversible mid-incident. A row is
-- one UPDATE and takes effect within the cache TTL — seconds — across every
-- process. ENVO_AUTH_MODE still exists and OVERRIDES this row, as a kill switch
-- that works even when the database is the thing misbehaving.
--
-- FAIL-SAFE, ALWAYS TOWARDS LEGACY. A missing table, an unreadable row, an
-- unrecognised value, or a resolver that throws all resolve to `legacy`. There
-- is deliberately no failure path that lands in `enforce`: the ACL has never
-- authorised a production request, so it is never the safer guess.
--
-- ── authorization_divergence ────────────────────────────────────────────────
--
-- Where shadow mode puts its findings. AGGREGATED, not an event log: the key is
-- the SHAPE of the disagreement, and repeats bump a counter. A systematically
-- divergent permission therefore costs one row, not one row per request, which
-- is what makes it safe to leave on in production.
--
-- Neither table is read by any authorization decision except the mode itself.
--
-- Idempotent. Run manually on prod (migrations do not auto-apply here).

create table if not exists authorization_mode (
  -- The constant makes the single-row invariant a constraint rather than a
  -- convention: a second row is impossible, so "which one is live" is never a
  -- question during an incident.
  id          boolean primary key default true check (id),
  mode        text    not null default 'legacy'
                check (mode in ('legacy', 'shadow', 'enforce')),
  -- Free text, for the person who flipped it. Shown by scripts/auth_mode.mjs.
  note        text,
  changed_by  text,
  changed_at  timestamptz not null default now()
);

insert into authorization_mode (id, mode, note, changed_by)
values (true, 'legacy', 'Initial state: scope.js is the sole authority.', 'migration')
on conflict (id) do nothing;

create table if not exists authorization_divergence (
  user_id        uuid        not null references users(id) on delete cascade,
  permission_key text        not null,
  -- What each authority said. Part of the key: the same user and permission
  -- diverging in BOTH directions is two findings, not one overwritten by the other.
  legacy_allowed boolean     not null,
  acl_allowed    boolean     not null,
  mode           text        not null,
  -- Enough context to reproduce the decision without storing every request.
  facility_id    uuid,
  commodity_id   uuid,
  acl_reason     text,
  hits           bigint      not null default 1,
  first_seen     timestamptz not null default now(),
  last_seen      timestamptz not null default now(),
  primary key (user_id, permission_key, legacy_allowed, acl_allowed)
);

create index if not exists authorization_divergence_last_seen_idx
  on authorization_divergence (last_seen desc);
