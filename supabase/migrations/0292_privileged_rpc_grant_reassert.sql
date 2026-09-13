-- Bubaly :: 0292 Re-assert the privileged-RPC lockdowns, at the end of the chain
-- ----------------------------------------------------------------------------
-- Three migrations already locked these functions to the service role. On a
-- freshly replayed database today, `authenticated` can execute all of them
-- again:
--
--   0253  revoke all on claim_ai_runs from public, anon, authenticated
--         -- and raised an exception if the revoke had not taken
--   0204  revoke all on loyalty_award_points / _redeem_reward / _cancel_redemption
--
-- The lockdowns did not survive the rest of the chain. Supabase's default
-- privileges grant EXECUTE on functions directly to anon, authenticated and
-- service_role — 0253's own header says so — so every later migration that
-- re-creates one of these functions can hand the grant straight back.
-- `0263_dead_letter_reconcile.sql` re-creates `claim_ai_runs`, and the current
-- ACL is `{postgres, service_role, authenticated}`: the revoke is gone.
--
-- 0253's verification block was correct and still passed, because it checked
-- the privileges AT ITS OWN MOMENT in the chain. Nothing checked the FINAL
-- state, which is the only state a database actually runs in. That is the real
-- defect here, and `docs/audit/privileged-rpc-grants-check.sql` is the part
-- that stops it recurring: it runs against the fully replayed schema.
--
-- What the open grant allowed, verified directly rather than argued:
-- `claim_ai_runs` is SECURITY DEFINER and scoped to the whole platform, not to
-- a family. Acting as an ordinary member of family A:
--
--   set role authenticated; set request.jwt.claim.sub = '<member of family A>';
--   select * from public.claim_ai_runs(10, 60);
--   -> claimed ids: 00000000-0000-4000-8000-00000000ab01   (a run owned by family B)
--
-- So any signed-in user could lease AI jobs belonging to any other household,
-- take them out of the real worker's queue, drive the run state machine across
-- tenants, and read back the run ids. `claim_marketing_generation_jobs` is the
-- same worker-queue shape and was reachable by `anon` as well.
--
-- Every legitimate caller of all five goes through `createServiceClient()`
-- (lib/ai/runs/store.ts, app/api/cron/*, lib/loyalty/server.ts via the admin
-- actions), so nothing loses a call it is entitled to make.
--
-- Idempotent; no data change.

revoke all on function public.claim_ai_runs(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_ai_runs(integer, integer) to service_role;

revoke all on function public.claim_marketing_generation_jobs(integer) from public, anon, authenticated;
grant execute on function public.claim_marketing_generation_jobs(integer) to service_role;

revoke all on function public.loyalty_award_points(uuid, integer, text, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.loyalty_award_points(uuid, integer, text, text, text, uuid, uuid) to service_role;

revoke all on function public.loyalty_redeem_reward(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.loyalty_redeem_reward(uuid, uuid, uuid) to service_role;

revoke all on function public.loyalty_cancel_redemption(uuid, uuid) from public, anon, authenticated;
grant execute on function public.loyalty_cancel_redemption(uuid, uuid) to service_role;

do $$
declare
  v_fn text;
  v_open text[] := '{}';
begin
  foreach v_fn in array array[
    'public.claim_ai_runs(integer,integer)',
    'public.claim_marketing_generation_jobs(integer)',
    'public.loyalty_award_points(uuid,integer,text,text,text,uuid,uuid)',
    'public.loyalty_redeem_reward(uuid,uuid,uuid)',
    'public.loyalty_cancel_redemption(uuid,uuid)'
  ] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE')
       or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      v_open := array_append(v_open, v_fn);
    end if;
    if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception 'service_role lost EXECUTE on %', v_fn;
    end if;
  end loop;

  if array_length(v_open, 1) is not null then
    raise exception 'client roles still hold EXECUTE on privileged RPC(s): %', v_open;
  end if;
  raise notice '0292 OK: the five privileged RPCs are service-role only.';
end $$;
