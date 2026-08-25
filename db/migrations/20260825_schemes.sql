-- Funding schemes for Essential Commodities (2026-08-25). Phase 1 of the scheme +
-- indebtedness work; the WMS has a matching migration (schemes + requests.scheme).
--
-- The warehouse distributes under three funds, and who pays differs by fund:
--
--   drf        Drug Revolving Fund   — the facility pays; this is what creates debt
--   bhcpf      BHCPF                 — government-funded; the facility is not billed
--   insurance  Health Insurance      — the insurer pays; the facility is not billed
--
-- A TABLE, not an enum or a CHECK constraint: a fourth fund later is one insert here
-- rather than an ALTER TYPE or a constraint rewrite, and `creates_debt` gives the
-- account ledger (phase 2) one place to ask "does issuing this bill the facility?"
-- rather than hardcoding the DRF key in several services.
--
-- Prices still matter on every scheme. BHCPF and insurance issues are not billed to the
-- facility, but their VALUE is needed for claims and reporting — so nothing here makes
-- price conditional.
--
-- Apply:  psql "$DATABASE_URL" -f db/migrations/20260825_schemes.sql
-- Idempotent: safe to re-run.

begin;

create table if not exists schemes (
  key          text primary key,
  label        text not null,
  -- Does an issue under this scheme create a debt owed to the central store?
  creates_debt boolean not null default false,
  active       boolean not null default true,
  sort_order   int not null default 0
);

insert into schemes (key, label, creates_debt, sort_order) values
  ('drf',       'Drug Revolving Fund (DRF)', true,  1),
  ('bhcpf',     'BHCPF',                     false, 2),
  ('insurance', 'Health Insurance',          false, 3)
on conflict (key) do nothing;

-- The fund the facility is drawing on. ONE column, not a requested/dispatched pair: the
-- facility's choice is binding, and the warehouse cannot move a request onto another
-- fund. (The warehouse does choose a fund for a DIRECT dispatch it raises itself, but
-- that is a WMS-side document with no EnVo request behind it.) If the store can't fill
-- a request from the fund it was raised against, the answer is to reject it so the
-- facility re-raises — not to silently change who pays.
--
-- DEFAULT 'drf' backfills every existing row: the warehouse has been running a single
-- implicit fund, and that fund is the DRF (the printed voucher is the DRF voucher). The
-- FK is satisfied because the rows above are inserted in this same transaction.
alter table warehouse_requests
  add column if not exists scheme text not null default 'drf' references schemes(key);

create index if not exists warehouse_requests_scheme_idx
  on warehouse_requests (scheme, requested_at desc);

-- Fail loudly rather than leave a half-applied state.
do $$
declare n int;
begin
  select count(*) into n from warehouse_requests where scheme is null;
  if n > 0 then raise exception 'warehouse_requests.scheme NULL for % row(s)', n; end if;
  if (select count(*) from schemes where active) < 3 then
    raise exception 'expected the three funding schemes to be present';
  end if;
end $$;

commit;
