-- privileged-rpc-grants-check.sql
--
-- The worker-queue and ledger RPCs are reachable ONLY by the service role,
-- checked against the FULLY REPLAYED schema.
--
-- That last part is the whole point. 0204 and 0253 already revoked these from
-- public/anon/authenticated, and 0253 even raised an exception if its revoke
-- had not taken — but it checked the privileges at its own moment in the chain.
-- Supabase's default privileges grant EXECUTE on functions straight to anon and
-- authenticated, so a later migration re-creating one of these functions
-- (0263 re-creates claim_ai_runs) hands the grant back, and nothing noticed.
-- By the end of the chain `authenticated` could execute all five again.
--
-- What that allowed: claim_ai_runs is SECURITY DEFINER and platform-wide, not
-- family-scoped. An ordinary member of one household could lease AI runs
-- belonging to another, pull them out of the real worker's queue, and read back
-- their ids. 0288 closes it; this keeps it closed.
--
-- Run by docs/audit/run-probes.sh, which globs docs/audit/*-check.sql.

\set ON_ERROR_STOP on

do $$
declare
  v_fn text;
  v_open text[] := '{}';
  v_missing text[] := '{}';
begin
  foreach v_fn in array array[
    'public.claim_ai_runs(integer,integer)',
    'public.claim_marketing_generation_jobs(integer)',
    'public.loyalty_award_points(uuid,integer,text,text,text,uuid,uuid)',
    'public.loyalty_redeem_reward(uuid,uuid,uuid)',
    'public.loyalty_cancel_redemption(uuid,uuid)'
  ] loop
    if to_regprocedure(v_fn) is null then
      raise exception 'A-13 FAIL: % does not exist — the probe is checking a function that has been renamed', v_fn;
    end if;
    if has_function_privilege('anon', v_fn, 'EXECUTE')
       or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      v_open := array_append(v_open, v_fn);
    end if;
    if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
      v_missing := array_append(v_missing, v_fn);
    end if;
  end loop;

  if array_length(v_open, 1) is not null then
    raise exception 'A-13 FAIL: a client role holds EXECUTE on privileged RPC(s): %', v_open;
  end if;
  if array_length(v_missing, 1) is not null then
    raise exception 'A-13 FAIL: service_role cannot execute %, so the worker is broken', v_missing;
  end if;
  raise notice 'A-13 OK: the five privileged RPCs are service-role only, at the end of the chain';
end $$;
