-- privileged-rpc-grants-check.sql
--
-- The worker-queue and ledger RPCs are reachable ONLY by the service role,
-- checked against the FULLY REPLAYED schema.
--
-- That last part is the whole point. 0204 and 0253 revoked these from
-- public/anon/authenticated, and 0253 even raised an exception if its revoke
-- had not taken — but it checked the privileges at its own moment in the chain.
-- Only the final state is the state a database runs in, and this checks that.
--
-- HISTORY, CORRECTED. 0292's header reports that on a replayed database
-- `authenticated` could execute all five again, and blames 0263's `create or
-- replace` of claim_ai_runs for handing the grant back. That mechanism is
-- wrong: CREATE OR REPLACE FUNCTION keeps the existing ACL (only DROP + CREATE
-- resets it), 0263:112-113 says exactly that about itself, and 0263:114-115
-- restates the revoke anyway. Checked on a copy of the replayed schema: a
-- function revoked to {postgres, service_role} keeps that ACL through a
-- `create or replace`, under this harness's defaults and under hosted
-- Supabase's function defaults alike. What re-opened them, per
-- rls-isolation-check.sql's Invariant-4 note, was a blanket `grant execute on
-- all functions in schema public to authenticated` that used to sit in THAT
-- probe, which runs after this one on the SAME shared database and so
-- poisoned every later run — a probe contaminating the database, not a
-- migration. No migration re-grants any of the five. The one real migration-level
-- gap 0292 closed is claim_marketing_generation_jobs: 0237:355 revoked it
-- from `public` only, which leaves the DIRECT anon/authenticated grants that
-- hosted Supabase's function default privileges hand every new function.
-- (Both this header and rls-isolation-check.sql once credited "0288". There
-- is no 0288 in this tree — 0287-0289 are absent; the reassert is 0292.)
--
-- What an open grant allows: claim_ai_runs is SECURITY DEFINER and
-- platform-wide, not family-scoped. An ordinary member of one household could
-- lease AI runs belonging to another, pull them out of the real worker's
-- queue, and read back their ids. The three loyalty RPCs take any p_family_id
-- and check nothing about the caller either.
--
-- Run by docs/audit/run-probes.sh, which globs docs/audit/*-check.sql.

\set ON_ERROR_STOP on

-- ── NEGATIVE CONTROL, and it runs FIRST, before the five refusals ────────────
--
-- MECHANISM: a GRANT, not RLS. There is no policy here to mirror — the invariant
-- is a catalog fact about each function's EXECUTE ACL. All five are SECURITY
-- DEFINER and none checks its caller (0204:8-280, 0237:326-354 and 0263:27-110
-- contain no auth.uid, is_family_member or current_setting), so they consult no
-- RLS policy and the ACL is the only thing standing between `authenticated` and
-- `claim_ai_runs`. Functions carry no trigger, CHECK or index to confuse with it.
--
-- WHICH STATEMENTS WRITE THAT ACL. Grepping the five names across
-- supabase/migrations returns 0204, 0218, 0237, 0250, 0253, 0263 and 0292; 0218
-- only mentions loyalty_redeem_reward in a comment. No migration after 0292
-- names any of them (checked through 0365, the newest file when this was
-- written). No migration does a blanket `grant|revoke … on all functions`, sets
-- `alter default privileges` for functions, or builds a function grant/revoke
-- with `execute format(…)` — the only two dynamic ACL loops, 0338:154 and
-- 0352:123, revoke TABLE DML from anon. So the final ACL of each function is the
-- product of these statements, last writer last:
--
--   claim_ai_runs                     0250 (from public) · 0253 · 0263 · 0292
--   claim_marketing_generation_jobs   0237 (from public ONLY) · 0292
--   loyalty_award_points / _redeem_reward / _cancel_redemption   0204 · 0292
--
-- 0292 is the last writer for all five, but for four of them its two statements
-- are byte-for-byte restatements of 0204:281-286 and 0263:114-115. It adds
-- something only for claim_marketing_generation_jobs, and only the `anon,
-- authenticated` half — which matters solely where default privileges grant
-- function EXECUTE to those roles DIRECTLY (hosted Supabase). This harness's
-- pg-bootstrap.sh models default privileges for TABLES only, so here a client
-- role reaches a function through PUBLIC alone, and "revoked from public" and
-- "revoked from public, anon, authenticated" leave the same ACL. On THIS
-- database, deleting 0292 outright leaves the probe green; the five FALSEs are
-- produced by 0204, 0237 and 0263 as much as by 0292. Leg 4 below proves, on a
-- throwaway function, that the refusal predicate DOES tell 0237's shape from
-- 0292's under hosted function defaults, and its notice says whether THIS
-- database models them. Making 0292 itself load-bearing here needs a function
-- line in pg-bootstrap.sh's default privileges; that is outside this file.
--
-- WHAT THE PROBE ASSERTS, AND WHAT A FALSE DOES NOT SAY BY ITSELF
-- ---------------------------------------------------------------------------
-- `has_function_privilege('anon'|'authenticated', <fn>, 'EXECUTE')` is FALSE,
-- five times over. A FALSE is not self-attributing. It is what a targeted revoke
-- produces — and equally what a database that hands these two roles EXECUTE on
-- NOTHING produces. The premise is that EXECUTE on a newly created function goes
-- to the client roles by default (to PUBLIC by PostgreSQL's own rule, and on a
-- hosted Supabase project directly to anon and authenticated as well), which is
-- why the five have to be held closed on purpose. Take that premise away and all
-- five FALSEs are free.
--
-- So: the same two actors, the same predicate, the answer the other way, and it
-- must land.
--
--   Leg 1 — a function created right here, in the SAME schema, by the SAME owner
--     as the five (asserted), which no revoke has touched: anon and authenticated
--     must hold EXECUTE on it. This is the leg with real discriminating power:
--     add `alter default privileges revoke execute on functions from public` to
--     pg-bootstrap.sh, or replay onto a Postgres that stops granting EXECUTE to
--     PUBLIC, and it goes red where the probe used to print "A-13 OK" over five
--     FALSEs that were the background. It has to be the GLOBAL form: the
--     per-schema `… in schema public revoke execute on functions from public`
--     cannot take away the built-in PUBLIC default (per-schema default
--     privileges only add to the global ones) and is a no-op — run against a
--     copy of the replayed schema, leg 1 stays green under it, correctly.
--   Leg 2 — the revoke-then-grant pair the chain uses (0292's text, identical to
--     0204's and 0263's), applied to that function: anon and authenticated flip
--     to FALSE, and service_role reads FALSE after the revoke and TRUE only after
--     the grant. The client-role half can fail only through role membership (a
--     client role made a member of the owner or of service_role), which the five
--     refusals would also see; it is here to show the statement shape does what
--     the probe reads it as doing, not as an independent tripwire. The
--     service_role half IS one: it proves `service_role` has no ambient route
--     (not superuser, not the owner), so the refusal block's "service_role CAN
--     execute" check is measuring the grant rather than reading TRUE for free.
--   Leg 3 — the real schema in bulk, two ways. (a) `authenticated` still holds
--     EXECUTE, by any route, on at least one other public function. (b) at least
--     one other public function still grants EXECUTE to PUBLIC — the route the
--     five would be open by on this database if their own revoke were missing.
--     (b) is what catches a blanket `revoke execute on all functions in schema
--     public from public`: that closes the five by a route that is not theirs,
--     leaves leg 1 green (its function is created afterwards, with the default),
--     and leaves (a) green too, because many public functions carry a DIRECT
--     grant to authenticated (leg 3b's error prints how many). Counted, not
--     hand-listed; nothing is seeded.
--   Leg 4 — the route on which 0292 is load-bearing. Under hosted Supabase's
--     function default privileges (set here with `alter default privileges`,
--     inside the rolled-back transaction), a new function's ACL carries anon and
--     authenticated directly. 0237's shape (`revoke all … from public`) must
--     leave both TRUE — so the refusal predicate would flag a revert to that
--     shape wherever those defaults exist — and 0292's shape must take both to
--     FALSE while service_role stays TRUE.
--
-- Rename or drop either client role and `has_function_privilege` raises 42704;
-- leg 1 catches that and says what it means for the verdict. Every DDL statement
-- the control runs sits inside a handler, so a connection that cannot create in
-- `public` reads "A-13 UNPROVEN" with the reason, not a bare 42501.
--
-- The existing `service_role` check does not stand in for any of the client-role
-- legs, for the reason the parent's positive control does not cover the child in
-- child-login-mapping-is-managers-only-check.sql: it proves the predicate can
-- answer yes for SOMEBODY, not that it could have answered yes for the two roles
-- whose FALSE is the finding.
--
-- WHAT IT STILL DOES NOT CATCH, said plainly rather than left to be discovered:
-- (1) on this harness, deleting 0292 alone (see above); (2) a blanket revoke from
-- PUBLIC followed by a later migration that creates a function with the default
-- ACL, which would put leg 3(b) back above zero. No migration in this tree does a
-- blanket function revoke today.
--
-- Seeds nothing and invents no UUIDs: the mechanism is an ACL, so there are no
-- rows to stand up and nothing here can collide with another probe's anchors.
-- Both control functions and the default-privilege change live inside one
-- transaction that is ROLLED BACK, so none of it outlives the control — the
-- probes glob alphabetically against ONE database, and rls-isolation-check.sql
-- carries the note on what a stray function grant left behind did to this very
-- probe's verdict.

begin;

do $$
begin
  if to_regprocedure('public.a13_control_untouched_rpc()') is not null then
    execute 'drop function public.a13_control_untouched_rpc()';
  end if;
  -- SECURITY INVOKER on purpose: `prosecdef` has no bearing on the EXECUTE ACL,
  -- so mirroring the subjects' SECURITY DEFINER would add nothing the control tests.
  execute $ddl$create function public.a13_control_untouched_rpc() returns integer
    language sql immutable as 'select 1'$ddl$;
exception when others then
  raise exception 'A-13 UNPROVEN: the control function could not be created (% : %) — without it the five refusals below have nothing to be measured against. This connection needs CREATE on schema public.', sqlstate, sqlerrm;
end $$;

do $$
declare
  ctl constant text := 'public.a13_control_untouched_rpc()';
  subjects constant text[] := array[
    'public.claim_ai_runs(integer,integer)',
    'public.claim_marketing_generation_jobs(integer)',
    'public.loyalty_award_points(uuid,integer,text,text,text,uuid,uuid)',
    'public.loyalty_redeem_reward(uuid,uuid,uuid)',
    'public.loyalty_cancel_redemption(uuid,uuid)'
  ];
  failures text[] := '{}';
  ok_auth boolean;
  ok_anon boolean;
  v_fn text;
  v_ctl_owner oid;
  v_owner oid;
begin
  if to_regprocedure(ctl) is null then
    raise exception 'A-13 UNPROVEN: the control function % was not created, so the five refusals below have nothing to be measured against', ctl;
  end if;

  -- Same owner, or the default the control received is not the default the
  -- five received at creation (acldefault and pg_default_acl are per-owner).
  -- A missing subject is left to the refusal block, which names it.
  select proowner into v_ctl_owner from pg_proc where oid = to_regprocedure(ctl);
  foreach v_fn in array subjects loop
    if to_regprocedure(v_fn) is not null then
      select proowner into v_owner from pg_proc where oid = to_regprocedure(v_fn);
      if v_owner <> v_ctl_owner then
        failures := array_append(failures, format('%s is owned by %s but the control by %s, so the control''s default ACL is not the one %s was created with', v_fn, pg_get_userbyid(v_owner), pg_get_userbyid(v_ctl_owner), v_fn));
      end if;
    end if;
  end loop;

  begin
    ok_auth := has_function_privilege('authenticated', ctl, 'EXECUTE');
    ok_anon := has_function_privilege('anon', ctl, 'EXECUTE');
  exception when others then
    raise exception 'A-13 UNPROVEN (the control this probe rests on could not even be asked): has_function_privilege raised %: % — a missing or renamed client role makes every FALSE below an artifact of that, not a lockdown', sqlstate, sqlerrm;
  end;

  if not ok_auth then
    failures := array_append(failures, 'authenticated does NOT hold EXECUTE on a brand-new public function that no revoke has touched');
  end if;
  if not ok_anon then
    failures := array_append(failures, 'anon does NOT hold EXECUTE on a brand-new public function that no revoke has touched');
  end if;

  if array_length(failures, 1) is not null then
    raise exception 'A-13 UNPROVEN (control leg 1): % — on this database a new function does not hand the client roles EXECUTE by default, so every revoke the chain makes (0204, 0237, 0250, 0253, 0263, 0292) could be deleted and the five checks below would still pass. The lockdown is not reported as holding and not as broken: it is reported as unproven.', array_to_string(failures, ' | ');
  end if;
  raise notice 'A-13 control leg 1 OK: anon and authenticated DO hold EXECUTE on an untouched public function with the same owner as the five, so a FALSE below is a revoke and not the background';
end $$;

-- The pair the chain uses (0292's text, identical to 0204's and 0263's), applied
-- in two steps so each half can be read on its own.
do $$
declare
  ctl constant text := 'public.a13_control_untouched_rpc()';
  still text[] := '{}';
begin
  begin
    execute 'revoke all on function public.a13_control_untouched_rpc() from public, anon, authenticated';
  exception when others then
    raise exception 'A-13 UNPROVEN (control leg 2): the chain''s revoke statement could not be replayed on the control function (% : %)', sqlstate, sqlerrm;
  end;

  if has_function_privilege('authenticated', ctl, 'EXECUTE') then
    still := array_append(still, 'authenticated');
  end if;
  if has_function_privilege('anon', ctl, 'EXECUTE') then
    still := array_append(still, 'anon');
  end if;
  if array_length(still, 1) is not null then
    raise exception 'A-13 UNPROVEN (control leg 2): the revoke statement the chain uses, replayed verbatim on an otherwise identical throwaway function, left EXECUTE with % — so a FALSE below cannot be read as that revoke having taken, and this predicate is not measuring what the probe claims it measures', array_to_string(still, ' and ');
  end if;
  if has_function_privilege('service_role', ctl, 'EXECUTE') then
    raise exception 'A-13 UNPROVEN (control leg 2): service_role still holds EXECUTE on a function it was never granted, after PUBLIC was revoked — it has an ambient route (superuser, owner, or a membership), so the "service_role CAN execute" check below reads TRUE whether or not the chain grants it';
  end if;

  begin
    execute 'grant execute on function public.a13_control_untouched_rpc() to service_role';
  exception when others then
    raise exception 'A-13 UNPROVEN (control leg 2): the chain''s grant statement could not be replayed on the control function (% : %)', sqlstate, sqlerrm;
  end;

  if not has_function_privilege('service_role', ctl, 'EXECUTE') then
    raise exception 'A-13 UNPROVEN (control leg 2): `grant execute … to service_role` did not give service_role EXECUTE on the control function';
  end if;
  if has_function_privilege('authenticated', ctl, 'EXECUTE') or has_function_privilege('anon', ctl, 'EXECUTE') then
    raise exception 'A-13 UNPROVEN (control leg 2): granting service_role EXECUTE also handed it to a client role — a client role is a member of service_role';
  end if;
  raise notice 'A-13 control leg 2 OK: that revoke flips both client roles AND service_role to FALSE on an otherwise identical function, and only the grant gives service_role EXECUTE back';
end $$;

do $$
declare
  n_live int;
  n_public int;
begin
  -- `::name` only states which overload is meant: with an untyped first argument
  -- PostgreSQL already resolves this call to (name, oid, text), because a string
  -- category candidate wins for an unknown literal (confirmed with EXPLAIN
  -- VERBOSE). It is not guarding against an ambiguity.
  select count(*) into n_live
  from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and p.prokind in ('f','p')
    and p.proname not like 'a13\_control\_%'
    and has_function_privilege('authenticated'::name, p.oid, 'EXECUTE');

  -- The PUBLIC route specifically: a function whose ACL (or, when proacl is
  -- null, whose owner's built-in default) still grants EXECUTE to PUBLIC.
  select count(*) into n_public
  from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and p.prokind in ('f','p')
    and p.proname not like 'a13\_control\_%'
    and exists (
      select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where a.grantee = 0 and a.privilege_type = 'EXECUTE');

  if n_live = 0 then
    raise exception 'A-13 UNPROVEN (control leg 3a): at the end of the chain `authenticated` holds EXECUTE on ZERO functions in schema public, so the five FALSEs below are the background rather than a finding. Something blanket-revoked function EXECUTE from the client roles; find it before reading this probe as a pass.';
  end if;
  if n_public = 0 then
    raise exception 'A-13 UNPROVEN (control leg 3b): no function in schema public still grants EXECUTE to PUBLIC (authenticated reaches % only through direct grants). Something blanket-revoked EXECUTE from PUBLIC, which closes the five whether or not their own revokes are there, so their FALSE below is the background rather than a finding.', n_live;
  end if;
  raise notice 'A-13 control leg 3 OK: authenticated still holds EXECUTE on % other function(s) in public, % of them through PUBLIC, so the five below are refused against a live background', n_live, n_public;
end $$;

do $$
declare
  ctl constant text := 'public.a13_control_hosted_default_rpc()';
  v_models_hosted boolean;
  still text[] := '{}';
begin
  -- Read BEFORE this leg changes anything: does THIS database's own default ACL
  -- hand function EXECUTE to anon or authenticated directly?
  select exists (
    select 1 from pg_default_acl d, aclexplode(d.defaclacl) a
    where d.defaclobjtype = 'f'
      and d.defaclrole = (select proowner from pg_proc where oid = to_regprocedure('public.claim_marketing_generation_jobs(integer)'))
      and (d.defaclnamespace = 0 or d.defaclnamespace = 'public'::regnamespace)
      and a.grantee in ('anon'::regrole, 'authenticated'::regrole)
      and a.privilege_type = 'EXECUTE')
  into v_models_hosted;

  begin
    execute 'alter default privileges in schema public grant execute on functions to anon, authenticated, service_role';
    execute $ddl$create function public.a13_control_hosted_default_rpc() returns integer
      language sql immutable as 'select 1'$ddl$;
    -- 0237:355-356's shape.
    execute 'revoke all on function public.a13_control_hosted_default_rpc() from public';
    execute 'grant execute on function public.a13_control_hosted_default_rpc() to service_role';
  exception when others then
    raise exception 'A-13 UNPROVEN (control leg 4): could not stand up the hosted-default control (% : %)', sqlstate, sqlerrm;
  end;

  if not has_function_privilege('authenticated', ctl, 'EXECUTE') or not has_function_privilege('anon', ctl, 'EXECUTE') then
    raise exception 'A-13 UNPROVEN (control leg 4): under hosted function defaults, 0237''s `revoke all … from public` already closed anon and authenticated on a throwaway function — the refusal predicate cannot tell 0237''s shape from 0292''s, so it would not see a revert to it';
  end if;

  begin
    -- 0292's shape.
    execute 'revoke all on function public.a13_control_hosted_default_rpc() from public, anon, authenticated';
    execute 'grant execute on function public.a13_control_hosted_default_rpc() to service_role';
  exception when others then
    raise exception 'A-13 UNPROVEN (control leg 4): could not replay 0292''s statements on the hosted-default control (% : %)', sqlstate, sqlerrm;
  end;

  if has_function_privilege('authenticated', ctl, 'EXECUTE') then
    still := array_append(still, 'authenticated');
  end if;
  if has_function_privilege('anon', ctl, 'EXECUTE') then
    still := array_append(still, 'anon');
  end if;
  if array_length(still, 1) is not null then
    raise exception 'A-13 UNPROVEN (control leg 4): under hosted function defaults, 0292''s revoke left EXECUTE with %', array_to_string(still, ' and ');
  end if;
  if not has_function_privilege('service_role', ctl, 'EXECUTE') then
    raise exception 'A-13 UNPROVEN (control leg 4): under hosted function defaults, 0292''s grant left service_role without EXECUTE';
  end if;

  raise notice 'A-13 control leg 4 OK: under hosted function defaults the predicate reads TRUE after 0237''s revoke-from-public and FALSE after 0292''s; this database itself % function EXECUTE to anon/authenticated directly, so 0292''s anon/authenticated half % by the five checks below',
    case when v_models_hosted then 'DOES grant' else 'does NOT grant' end,
    case when v_models_hosted then 'IS exercised' else 'is NOT exercised' end;
end $$;

-- Neither control function nor the default-privilege change outlives the control.
rollback;

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
