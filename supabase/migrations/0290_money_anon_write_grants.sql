-- Bubaly :: 0290 Close the anon grant on the money tables
-- ----------------------------------------------------------------------------
-- `docs/audit/wallet-write-rls-check.sql` invariant 6 asserts that `anon` holds
-- no INSERT on `wallet_transactions`, and it says why: the restrictive manager
-- guards added by 0254 are `TO authenticated`, and a restrictive policy only
-- ANDs with requests made AS one of the roles it names. For an ANONYMOUS
-- request those guards are simply absent, so the only thing standing between
-- anon and the money ledger is the grant layer.
--
-- That layer was never actually closed. Supabase's default privileges grant
-- `arwdDxt` on every new table in `public` to anon, authenticated and
-- service_role, so all five money tables have carried INSERT/UPDATE/DELETE for
-- anon since the day they were created. Run against a real Supabase database
-- the probe fails:
--
--   A-08 FAIL: anon holds INSERT on wallet_transactions — the restrictive
--   guards are `to authenticated` and would not apply
--
-- It has been passing in CI because `docs/audit/pg-bootstrap.sh` builds its
-- roles by hand and grants anon only SELECT, so the shim never reproduced the
-- configuration the assertion is about. That harness gap is fixed alongside
-- this migration.
--
-- NOT exploitable as it stands, and this migration does not claim otherwise:
-- the only permissive INSERT policy on wallet_transactions is
-- `wallet_transactions_mng_insert`, also `TO authenticated`, so an anon insert
-- is refused by RLS for want of any permissive policy. Verified directly:
-- `set role anon; insert into public.wallet_transactions …` returns
-- "new row violates row-level security policy". What this restores is the
-- defence in depth — a single future permissive policy written `TO public`
-- (the exact stray shape 0275 had to sweep away) would otherwise open an
-- anonymous mint path that no restrictive guard would catch.
--
-- Reads are deliberately left alone. RLS already returns nothing to anon, no
-- permissive SELECT policy names it, and revoking SELECT is a wider change than
-- the boundary needs. The public gift flow writes through
-- `createServiceClient()` (app/gift/actions.ts), which bypasses both grants and
-- RLS, so nothing legitimate loses a write here.
--
-- Follows the precedent set by 0184 (`revoke insert on public.marketplace_bids
-- from anon, authenticated`). Idempotent; no data change.

revoke insert, update, delete, truncate on public.wallet_transactions from anon;
revoke insert, update, delete, truncate on public.child_wallets       from anon;
revoke insert, update, delete, truncate on public.family_wallets      from anon;
revoke insert, update, delete, truncate on public.wallet_buckets      from anon;
revoke insert, update, delete, truncate on public.wallet_rules        from anon;

do $$
declare open_tables text[];
begin
  select array_agg(t order by t) into open_tables
  from unnest(array[
    'wallet_transactions','child_wallets','family_wallets','wallet_buckets','wallet_rules'
  ]) as t
  where has_table_privilege('anon', 'public.' || t, 'INSERT');

  if open_tables is not null then
    raise exception 'anon still holds INSERT on money table(s): %', open_tables;
  end if;
  raise notice '0290 OK: anon holds no write privilege on any money table.';
end $$;
