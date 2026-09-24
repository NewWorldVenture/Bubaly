-- A SECURITY DEFINER function a client can call checks who is calling.
-- (SEC-024, DB-FN-003)
--
-- A definer function runs as its owner and bypasses RLS, so the only thing
-- between a caller and what it writes is the function's own check. Two had
-- none, because they were only meant for the server, and both were callable
-- with nothing but the public anon key:
--
--   wallet_reserve_card_auth         a child's spendable 2000 -> 0 (forged hold)
--   marketplace_place_bid_unchecked  a leading bid in another family's name
--
-- Their migrations revoked EXECUTE from PUBLIC, which is how vanilla Postgres
-- is locked down. Supabase's default privileges grant EXECUTE on every new
-- function DIRECTLY to anon and authenticated, and a revoke from PUBLIC does not
-- touch a direct grant. privileged-rpc-grants-check.sql names five functions;
-- this scans all of them, so the next one is checked without anyone listing it.
--
-- The scan is deliberately coarse: a body that names a caller check at all
-- (auth.uid(), a membership helper, …) passes. What it catches is a function
-- that names none — the exact shape of both breaches.
--
-- A third rule: inside a definer function current_user is the OWNER. A caller
-- check written against current_user refuses everyone — marketplace_close_auction
-- did exactly that from 0185 until 0334, so no auction ever closed.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $probe$
declare
  unchecked text;
  open_service_only text;
  owner_tests text;
  refused boolean;
  answer jsonb;
begin
  -- ── 1. the scan ────────────────────────────────────────────────────────────
  select string_agg(p.oid::regprocedure::text, ', ' order by p.proname) into unchecked
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and p.prorettype <> 'trigger'::regtype
     and has_function_privilege('anon', p.oid, 'execute')
     and p.prosrc !~* '(auth\.(uid|role|jwt)\(\)|is_family_member|can_manage_family|is_family_admin|is_self_member|marketplace_member_id|family_role|is_super_admin|social_has_permission)'
     -- Deliberately public: platform-wide counts for the marketing site.
     and p.proname not in ('public_stats', 'public_handled_stats');
  if unchecked is not null then
    raise exception 'BREACH: anon can execute definer function(s) that check no caller: %', unchecked;
  end if;

  -- ── 2. the server's functions are the server's ─────────────────────────────
  select string_agg(fn, ', ') into open_service_only
    from unnest(array[
      'public.wallet_reserve_card_auth(uuid,uuid,bigint,text,text)',
      'public.marketplace_place_bid_unchecked(uuid,uuid,uuid,bigint)',
      'public.marketplace_close_auction(uuid,timestamp with time zone)'
    ]) fn
   where has_function_privilege('anon', fn, 'execute')
      or has_function_privilege('authenticated', fn, 'execute')
      or not has_function_privilege('service_role', fn, 'execute');
  if open_service_only is not null then
    raise exception 'BREACH: a service-only function is open to a client role, or closed to service_role: %', open_service_only;
  end if;

  -- ── 3. no caller check against the owner ───────────────────────────────────
  select string_agg(p.proname, ', ' order by p.proname) into owner_tests
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and p.prosrc ~* 'current_user\s*(<>|!=|is distinct from)\s*''service_role'''
     and p.prosrc !~* 'auth\.role\(\)';
  if owner_tests is not null then
    raise exception 'BREACH: definer function(s) test current_user, which is the owner, so they refuse everyone: %', owner_tests;
  end if;

  -- ── 4. behaviour: anon is refused at the door ──────────────────────────────
  refused := false;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.role', 'anon', true);
  set local role anon;
  begin
    perform public.wallet_reserve_card_auth(gen_random_uuid(), gen_random_uuid(), 1, 'probe', 'probe');
  exception when insufficient_privilege then refused := true;
  end;
  reset role;
  if not refused then
    raise exception 'BREACH: anon could call wallet_reserve_card_auth';
  end if;

  -- ── 5. CONTROL: the settlement cron can close an auction ───────────────────
  -- A random id is enough: a refusal raises 'forbidden', a working caller check
  -- lets it through to 'not_found'.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  set local role service_role;
  begin
    answer := public.marketplace_close_auction(gen_random_uuid(), now());
  exception when others then
    reset role;
    raise exception 'CONTROL FAILED: the service role cannot close an auction: %', sqlerrm;
  end;
  reset role;
  if answer->>'reason' is distinct from 'not_found' then
    raise exception 'CONTROL FAILED: expected not_found for an unknown listing, got %', answer;
  end if;

  raise notice 'OK: every definer function anon can call checks its caller; the server''s are the server''s; the cron can close an auction.';
end
$probe$;

rollback;
