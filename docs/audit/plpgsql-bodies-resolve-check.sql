-- Every plpgsql body resolves against the real catalogue.
--
-- A plpgsql function binds its SQL at CALL time. `create or replace` checks
-- syntax and stops there, so a body can be catastrophically wrong and still
-- install cleanly, deploy cleanly, and fail only when a user reaches the line.
-- Two features in this repository were dead on arrival for exactly that reason,
-- and neither was visible to review, CI or the type checker:
--
--   marketplace_create_circle  pinned `search_path = public` while calling
--                              gen_random_bytes, which lives in `extensions`
--                              → 42883 on every call since 0176 (fixed in 0318)
--
--   invest_decide_order        wrote `direction` from a CASE over two string
--                              literals, which is `text` and does not cast to
--                              wallet_txn_direction
--                              → 42804 on every APPROVAL since 0196 (fixed in 0321)
--
-- Both hid behind an early return — a membership check, a reject branch — so a
-- probe calling the function with dummy arguments would have reported success
-- without ever reaching the broken line. What finds this class is not calling
-- the function, it is resolving the body.
--
-- `plpgsql_check` does that: it walks each statement and binds every relation,
-- column, function and cast against the catalogue as it actually stands. It
-- reported exactly one error across every non-trigger plpgsql function in
-- `public`, and that error was a feature nobody could use.
--
-- Trigger functions are checked against each table that actually fires them,
-- because a trigger body's NEW and OLD are typed by the relation and the
-- checker cannot resolve them without one.
--
-- Where the extension is unavailable the probe SKIPS with a notice rather than
-- failing: a check that cannot run is not a check that found a problem.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  r        record;
  msg      text;
  failures int := 0;
  checked  int := 0;
begin
  if not exists (select 1 from pg_available_extensions where name = 'plpgsql_check') then
    raise warning 'PROBE-SKIPPED: plpgsql-bodies-resolve — plpgsql_check is not available on this server';
    return;
  end if;
  begin
    create extension if not exists plpgsql_check;
  exception when others then
    raise warning 'PROBE-SKIPPED: plpgsql-bodies-resolve — plpgsql_check could not be installed (% %)', sqlstate, sqlerrm;
    return;
  end;

  -- ── ordinary functions ───────────────────────────────────────────────────
  for r in
    select p.oid, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
     where n.nspname = 'public'
       and l.lanname = 'plpgsql'
       and p.prorettype <> 'pg_catalog.trigger'::regtype
     order by p.proname
  loop
    checked := checked + 1;
    for msg in
      select m from plpgsql_check_function(r.oid, fatal_errors => false) as m
    loop
      if msg like 'error:%' then
        raise warning 'UNRESOLVABLE: %() — %', r.proname, msg;
        failures := failures + 1;
      end if;
    end loop;
  end loop;

  -- ── trigger functions, against the relations that fire them ─────────────
  for r in
    select distinct p.oid, p.proname, t.tgrelid, c.relname
      from pg_trigger t
      join pg_proc p on p.oid = t.tgfoid
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = p.pronamespace
      join pg_namespace cn on cn.oid = c.relnamespace
      join pg_language l on l.oid = p.prolang
     where n.nspname = 'public' and cn.nspname = 'public'
       and l.lanname = 'plpgsql' and not t.tgisinternal
     order by p.proname, c.relname
  loop
    checked := checked + 1;
    for msg in
      select m from plpgsql_check_function(r.oid, relid => r.tgrelid, fatal_errors => false) as m
    loop
      if msg like 'error:%' then
        raise warning 'UNRESOLVABLE: %() on % — %', r.proname, r.relname, msg;
        failures := failures + 1;
      end if;
    end loop;
  end loop;

  -- A vacuous pass is the failure mode this probe is most exposed to: if the
  -- selection ever matches nothing, every body "resolves".
  if checked < 50 then
    raise exception 'plpgsql-bodies-resolve: only % function(s) checked — the selection is wrong, not the schema', checked;
  end if;

  if failures > 0 then
    raise exception 'plpgsql-bodies-resolve: % function body/bodies cannot resolve against this schema', failures;
  end if;
  raise notice 'plpgsql-bodies-resolve: OK — % plpgsql bodies resolve against the live catalogue', checked;
end
$probe$;
