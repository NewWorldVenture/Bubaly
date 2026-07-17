-- FamilyOS :: 0221 — revoke marketplace_place_bid_unchecked from authenticated
--
-- P2 marketplace-integrity IDOR (PLA-0610 / LB-012). Migration 0184 hardened
-- auction bidding by RENAMEing the raw `marketplace_place_bid` → `_unchecked`
-- and introducing a CHECKED wrapper `marketplace_place_bid` that verifies
-- auth.uid() owns the bidding member + family before delegating to `_unchecked`.
-- 0184 did `revoke all ... _unchecked ... from public` + `grant ... to service_role`.
-- BUT a function RENAME preserves the existing ACL, so the `authenticated` grant
-- from the original 0183 `grant execute ... marketplace_place_bid ... to
-- authenticated, service_role` survived onto `_unchecked` — and `revoke ... from
-- public` does not remove a separate role grant. Net effect: any signed-in user
-- could call `marketplace_place_bid_unchecked(listing, ANY member, ANY family,
-- amount)` directly (SECURITY DEFINER = RLS bypass), skipping every check in the
-- wrapper, and place an auction bid ATTRIBUTED TO ANOTHER FAMILY.
--   (Proven live on PG16: as a family-A member the direct call returned a normal
--    result envelope — EXECUTE was permitted — instead of "permission denied".)
--
-- Fix: revoke EXECUTE from authenticated (and re-assert the public revoke). The
-- checked `marketplace_place_bid` wrapper is SECURITY DEFINER, so it invokes
-- `_unchecked` as the function owner, NOT as the caller — revoking the caller's
-- grant does not affect the legitimate bid path. The app only ever calls the
-- checked wrapper. Idempotent.

revoke all    on function public.marketplace_place_bid_unchecked(uuid, uuid, uuid, bigint) from public;
revoke execute on function public.marketplace_place_bid_unchecked(uuid, uuid, uuid, bigint) from authenticated;
grant  execute on function public.marketplace_place_bid_unchecked(uuid, uuid, uuid, bigint) to service_role;
