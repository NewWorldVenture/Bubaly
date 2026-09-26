-- ── A-16 Blanket-policy probe ───────────────────────────────────────────────
-- Every table has RLS enabled (A-03 asserts that). RLS with a policy whose
-- USING or WITH CHECK is literally `true` is RLS that permits everything, so
-- "RLS is on" is not by itself the property anyone cares about.
--
-- wallet-write-rls-check.sql already forbids a stray permissive write policy on
-- the MONEY tables. This asks the same question of all of them, because the next
-- blanket policy will not necessarily be written on a money table.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/blanket-policy-check.sql
--
-- Exit is non-zero (via RAISE EXCEPTION) if any invariant fails.

-- Reference data: catalogues with no family in them, deliberately readable by
-- everyone. Each is listed by name so that ADDING one is a decision someone
-- makes here, not a side effect of writing a policy somewhere.
create temporary table blanket_allowlist (relname text primary key, why text);
insert into blanket_allowlist values
  ('badges',               'the badge catalogue — the same badges for every family'),
  ('feature_flags',        'flag names and states; read-only to authenticated, no family column'),
  ('meal_ideas',           'the seeded recipe catalogue, shared by every household'),
  ('service_descriptions', 'public marketing copy, served by the public /api/services/descriptions route');

-- ONE definition of the rule, used by the invariant and by the self-test below,
-- so the two can never drift apart.
create or replace function pg_temp.blanket_policies()
returns table (relname text, polname text, cmd "char", roles text, expr text)
language sql as $fn$
  select c.relname::text,
         p.polname::text,
         p.polcmd,
         coalesce((select string_agg(r.rolname, ',' order by r.rolname)
                   from pg_roles r where r.oid = any(p.polroles)), 'PUBLIC'),
         coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' / '
           || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and (pg_get_expr(p.polqual, p.polrelid) = 'true'
      or pg_get_expr(p.polwithcheck, p.polrelid) = 'true')
    -- service_role bypasses RLS entirely, so a `true` policy naming only it
    -- grants nothing it did not already have.
    and not (not (0 = any(p.polroles))
             and not exists (select 1 from pg_roles r
                             where r.oid = any(p.polroles) and r.rolname <> 'service_role'))
    and c.relname not in (select relname from blanket_allowlist)
$fn$;

-- ── Invariant: no blanket policy outside the allowlist ──────────────────────
do $$
declare n int; detail text;
begin
  select count(*), string_agg(format('%s.%s (%s) %s', relname, polname, roles, expr), E'\n  ')
    into n, detail from pg_temp.blanket_policies();
  if n > 0 then
    raise exception 'A-16 FAIL: % policy(ies) permit every row to a non-service role:%  %',
      n, E'\n  ', detail;
  end if;
  raise notice 'A-16 OK: no table outside the reference-data allowlist has an unconditional policy';
end $$;

-- Report what the allowlist is actually holding, so a reviewer sees the
-- exemptions rather than trusting that they are still the four intended ones.
do $$
declare n int;
begin
  select count(*) into n from blanket_allowlist a
  join pg_class c on c.relname = a.relname
  join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'public';
  raise notice 'A-16 OK: % reference table(s) exempt, each named with a reason', n;
end $$;

-- ── The probe detects the state it forbids ─────────────────────────────────
-- A check that cannot fail is decoration. Plant a blanket policy on a real
-- family-scoped table, confirm the rule above finds it, and roll back.
begin;
do $$
declare n int;
begin
  if to_regclass('public.calendar_events') is null then
    raise notice 'A-16 SKIP: calendar_events absent, self-test not run';
    return;
  end if;
  execute 'create policy a16_planted_blanket on public.calendar_events for select to authenticated using (true)';
  select count(*) into n from pg_temp.blanket_policies() where polname = 'a16_planted_blanket';
  if n <> 1 then
    raise exception 'A-16 FAIL: a planted blanket policy was NOT detected — this probe proves nothing';
  end if;
  raise notice 'A-16 OK: a planted blanket policy on calendar_events was detected — not decoration';
end $$;
rollback;

-- And it is really gone, so the probe leaves no trace.
do $$
declare n int;
begin
  select count(*) into n from pg_policy where polname = 'a16_planted_blanket';
  if n <> 0 then
    raise exception 'A-16 FAIL: the planted policy survived the rollback';
  end if;
  raise notice 'A-16 OK: the planted policy was rolled back';
end $$;
