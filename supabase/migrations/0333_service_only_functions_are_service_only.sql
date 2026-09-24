-- Service-only functions are service-only. (SEC-024)
--
-- Two SECURITY DEFINER functions do no check of their own on who is calling,
-- because they were only ever meant to be called by the server:
--
--   wallet_reserve_card_auth(family, child_wallet, amount, auth_id, description)
--     places a `processing` debit hold on a child's spend bucket — the Stripe
--     Issuing authorization webhook's funds check (0155).
--   marketplace_place_bid_unchecked(listing, bidder_member, bidder_family, max)
--     the raw bid engine behind the CHECKED `marketplace_place_bid` wrapper
--     (0184), which verifies the caller owns the bidding member and family.
--
-- Both migrations locked them down the way vanilla Postgres needs:
-- `revoke all ... from public` then `grant execute ... to service_role`. On
-- Supabase that is not enough. Its default privileges grant EXECUTE on every
-- new function DIRECTLY to anon and authenticated (pg_default_acl, objtype f),
-- and a revoke from PUBLIC does not touch a direct role grant. 0221 found this
-- for `authenticated` on the bid function and revoked that one role; `anon`
-- kept it. 0155 was never revisited.
--
-- Measured on the local Supabase stack with ONLY the public anon key — no
-- session, no account:
--
--   wallet_reserve_card_auth(<family>, <child wallet>, 2000, ...) -> true
--     the child's spendable balance: 2000 -> 0 (a forged "Card hold")
--   marketplace_place_bid_unchecked(<listing>, <another family's member>,
--                                   <that family>, 5000000)
--     -> {"ok":true,"leading":true} — a leading bid in a family's name that
--        never placed it, with a $50,000 ceiling
--
-- Both callers in the app use the service client (the Issuing webhook, and the
-- checked wrapper, which is itself SECURITY DEFINER and so calls the raw
-- function as its owner), so revoking the client roles changes nothing that
-- is meant to work. docs/audit/definer-functions-check-their-caller-check.sql
-- holds the general rule for every definer function anon can execute.

revoke all on function public.wallet_reserve_card_auth(uuid, uuid, bigint, text, text) from public, anon, authenticated;
grant execute on function public.wallet_reserve_card_auth(uuid, uuid, bigint, text, text) to service_role;

revoke all on function public.marketplace_place_bid_unchecked(uuid, uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.marketplace_place_bid_unchecked(uuid, uuid, uuid, bigint) to service_role;

do $check$
declare
  fn text;
begin
  foreach fn in array array[
    'public.wallet_reserve_card_auth(uuid, uuid, bigint, text, text)',
    'public.marketplace_place_bid_unchecked(uuid, uuid, uuid, bigint)'
  ] loop
    if has_function_privilege('anon', fn, 'execute') or has_function_privilege('authenticated', fn, 'execute') then
      raise exception '0333: a client role can still execute %', fn;
    end if;
    if not has_function_privilege('service_role', fn, 'execute') then
      raise exception '0333: service_role lost %, so its server caller is broken', fn;
    end if;
  end loop;
end
$check$;
