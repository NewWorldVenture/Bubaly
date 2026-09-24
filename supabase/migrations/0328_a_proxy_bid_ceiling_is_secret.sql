-- A proxy bid's ceiling is secret. (SEC-016)
--
-- `marketplace_place_bid` runs a proxy auction: a bidder states the most they
-- will pay, the visible price rises only as far as the next challenger forces
-- it, and the leader's maximum stays hidden. 0183 says so in the column
-- comments themselves:
--
--   reserve_cents      bigint,                      -- hidden floor
--   highest_max_cents  bigint not null default 0,   -- current leader's hidden proxy max
--
-- Nothing hid them. `marketplace_listings` grants table-level SELECT to
-- `authenticated`, and `marketplace_listings_circle_read` lets every family in
-- a sharing circle read every listing shared there, so every rival bidder could
-- read both columns. `marketplace_bids_select` lets the SELLER's family read
-- every bid on its listing, including each bidder's `max_cents`.
--
-- Measured over PostgREST with three real accounts — a seller and two bidders
-- in one circle:
--
--   Alice bids "up to $500"          -> leading, visible price $10.00
--   Bob selects highest_max_cents    -> 50000   (and reserve_cents -> 20000)
--   the seller selects max_cents     -> [50000]
--   Bob bids exactly 50000           -> leading: false, current_cents: 50000
--
-- Alice still wins, at her ENTIRE maximum. Bid exactly the leader's ceiling and
-- the engine's "doesn't beat the standing proxy" branch sets the price to
-- least(highest_max_cents, p_max + increment) — the ceiling itself. That is
-- shill bidding with perfect information, and the seller has it by default and
-- anyone the seller asks can get it. Without the peek, a rival's $300 bid would
-- have left the price at $300.50 (the increment at a $10 price is 50 cents).
--
-- ── the fix ─────────────────────────────────────────────────────────────────
--
-- Column privileges. Table-level SELECT is revoked from `anon` and
-- `authenticated` and re-granted on every column EXCEPT the secrets:
--
--   marketplace_listings : reserve_cents, highest_max_cents
--   marketplace_bids     : max_cents
--
-- The bid engine is SECURITY DEFINER and runs as the table owner, so it still
-- reads and writes all three. INSERT and UPDATE grants are untouched: a seller
-- still sets a reserve when listing. The service role keeps everything, so the
-- close-auctions cron is unaffected. Realtime's `apply_rls` filters each column
-- through `has_column_privilege(working_role, …)`, so the bid feed stops
-- carrying `max_cents` too.
--
-- The UI needs to know two things about a reserve — whether there is one, and
-- whether it has been met — never the figure. Those become stored generated
-- columns, mirroring `reserveMet()` in lib/marketplace/auction.ts exactly.
--
-- ── the trap this sets, and the check for it ────────────────────────────────
--
-- A column grant does not extend to columns added later. A future migration
-- that adds a column to either table must grant SELECT on it explicitly, or
-- every client read naming that column fails with 42501. The self-check at the
-- bottom — and docs/audit/proxy-bid-ceiling-is-secret-check.sql, which runs on
-- every PR — asserts that the selectable set is exactly "every column minus the
-- secrets", so the omission fails loudly instead of in production.

alter table public.marketplace_listings
  add column if not exists has_reserve boolean
    generated always as (reserve_cents is not null) stored;

alter table public.marketplace_listings
  add column if not exists reserve_met boolean
    generated always as (
      reserve_cents is null or (bid_count > 0 and current_bid_cents >= reserve_cents)
    ) stored;

comment on column public.marketplace_listings.has_reserve is
  'Whether the seller set a reserve. The figure itself (reserve_cents) is not client-selectable (0328).';
comment on column public.marketplace_listings.reserve_met is
  'Mirror of reserveMet() in lib/marketplace/auction.ts: no reserve, or a bid has reached it (0328).';

do $$
declare
  v_table   text;
  v_secrets text[];
  v_cols    text;
begin
  foreach v_table in array array['marketplace_listings', 'marketplace_bids'] loop
    v_secrets := case v_table
      when 'marketplace_listings' then array['reserve_cents', 'highest_max_cents']
      else array['max_cents'] end;

    select string_agg(format('%I', a.attname), ', ' order by a.attnum)
      into v_cols
      from pg_attribute a
     where a.attrelid = format('public.%I', v_table)::regclass
       and a.attnum > 0 and not a.attisdropped
       and a.attname <> all (v_secrets);

    execute format('revoke select on public.%I from anon, authenticated', v_table);
    execute format('grant select (%s) on public.%I to anon, authenticated', v_cols, v_table);
  end loop;
end $$;

-- ── self-check ──────────────────────────────────────────────────────────────
do $$
declare
  v_leaks   text;
  v_blocked text;
begin
  select string_agg(format('%s.%s for %s', t.tbl, a.attname, r.role), ', ')
    into v_leaks
    from (values ('marketplace_listings'), ('marketplace_bids')) t(tbl)
    join pg_attribute a on a.attrelid = format('public.%I', t.tbl)::regclass and a.attnum > 0 and not a.attisdropped
   cross join (values ('anon'), ('authenticated')) r(role)
   where a.attname in ('reserve_cents', 'highest_max_cents', 'max_cents')
     and has_column_privilege(r.role, format('public.%I', t.tbl), a.attname, 'SELECT');
  if v_leaks is not null then
    raise exception '0328: secret columns still client-selectable: %', v_leaks;
  end if;

  select string_agg(format('%s.%s', t.tbl, a.attname), ', ')
    into v_blocked
    from (values ('marketplace_listings'), ('marketplace_bids')) t(tbl)
    join pg_attribute a on a.attrelid = format('public.%I', t.tbl)::regclass and a.attnum > 0 and not a.attisdropped
   where a.attname not in ('reserve_cents', 'highest_max_cents', 'max_cents')
     and not has_column_privilege('authenticated', format('public.%I', t.tbl), a.attname, 'SELECT');
  if v_blocked is not null then
    raise exception '0328: ordinary columns lost their SELECT grant: %', v_blocked;
  end if;
end $$;
