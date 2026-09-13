-- ── K-01 A member id is not a household ─────────────────────────────────────
--
-- Every family table carries family_id and its RLS reads
-- `is_family_member(family_id)`. That predicate is deliberately membership-WIDE:
-- it admits every family the caller belongs to, because a parent with a
-- household on each side of a separation is one account with two families, and
-- both must work. Nothing is wrong with the policy.
--
-- What is wrong is reading a row by member_id and calling the result "this
-- family's data". `/api/ai/health/coach` and `/api/behavior/insight` both took
-- a memberId out of the request body and filtered on it alone, so for a
-- two-household parent the answer was drawn from whichever household the named
-- member happened to be in — while the feature gate, the plan check and the
-- page around it had all been decided against the ACTIVE family.
--
-- The premise cannot be established by reading the policy: `is_family_member`
-- is a function, the policy is created inside an `execute format(...)` loop,
-- and the app-level filter is what actually scopes the query. So prove it
-- behaviourally, from both ends:
--
--   1. a two-family parent reading by member_id alone DOES cross into the
--      other household (the defect's premise),
--   2. adding `family_id = <active>` — the fix — returns nothing (the filter
--      is what scopes it, not RLS), and
--   3. a stranger reads nothing either way (so 1 is a scoping gap and not RLS
--      being off, which would be a far larger finding).
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/member-scope-crossing-check.sql

\set FA '00000000-0000-4000-8000-0000000000d1'
\set FB '00000000-0000-4000-8000-0000000000d2'
\set UD '00000000-0000-4000-8000-0000000000d3'
\set UO '00000000-0000-4000-8000-0000000000d4'

-- One transaction, rolled back at the end. A probe that seeds rows and then
-- deletes them leaves those rows behind the moment an assertion raises, and
-- every probe run.sh executes after it inherits them. A rollback cleans up on
-- both paths, including the aborting one.
begin;

-- Seed: one parent in TWO households, each with a child, and an unrelated user.
insert into auth.users (id, email) values (:'UD','d-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UO','d-stranger@example.com') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FA','Alpha House',:'UD') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FB','Beta House', :'UD') on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FA',:'UD','Parent A','parent',true) on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FB',:'UD','Parent B','parent',true) on conflict do nothing;

-- The child whose health and behaviour live in the OTHER household.
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-0000000000d5', :'FB', null, 'Beta Child', 'child', true)
  on conflict do nothing;

insert into public.symptom_logs (family_id, member_id, symptom, severity, started_at, status)
  values (:'FB','00000000-0000-4000-8000-0000000000d5','Headache',2, now(), 'active')
  on conflict do nothing;
insert into public.behavior_logs (family_id, member_id, kind, category, points, occurred_at)
  values (:'FB','00000000-0000-4000-8000-0000000000d5','concern','focus',-1, now())
  on conflict do nothing;

grant select on public.symptom_logs, public.behavior_logs to authenticated;

do $$
declare
  crossed int;
  scoped  int;
  stranger int;
  failures text[] := '{}';
  child constant uuid := '00000000-0000-4000-8000-0000000000d5';
  alpha constant uuid := '00000000-0000-4000-8000-0000000000d1';
begin
  -- ── As the two-household parent ──────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000d3', true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- 1. by member_id alone — the shape both routes used.
  select count(*) into crossed from public.symptom_logs where member_id = child;
  if crossed = 0 then
    failures := array_append(failures, 'symptom_logs: a member of both families read NOTHING by member_id — the premise of K-01 no longer holds, so re-derive the finding before trusting the fix');
  end if;

  -- 2. with the active family named — the fix.
  select count(*) into scoped
    from public.symptom_logs where member_id = child and family_id = alpha;
  if scoped <> 0 then
    failures := array_append(failures, format('symptom_logs: family_id = Alpha still returned %s row(s) for a Beta member', scoped));
  end if;

  select count(*) into crossed from public.behavior_logs where member_id = child;
  if crossed = 0 then
    failures := array_append(failures, 'behavior_logs: a member of both families read NOTHING by member_id — the premise of K-01 no longer holds');
  end if;
  select count(*) into scoped
    from public.behavior_logs where member_id = child and family_id = alpha;
  if scoped <> 0 then
    failures := array_append(failures, format('behavior_logs: family_id = Alpha still returned %s row(s) for a Beta member', scoped));
  end if;

  -- ── As someone in neither household ─────────────────────────────────────
  -- Without this control, step 1 could mean "RLS is off", which is a different
  -- and much larger finding than a missing application filter.
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000d4', true);
  select count(*) into stranger from public.symptom_logs where member_id = child;
  if stranger <> 0 then
    failures := array_append(failures, format('symptom_logs: a user in NEITHER family read %s row(s) — RLS is not holding at all', stranger));
  end if;
  select count(*) into stranger from public.behavior_logs where member_id = child;
  if stranger <> 0 then
    failures := array_append(failures, format('behavior_logs: a user in NEITHER family read %s row(s) — RLS is not holding at all', stranger));
  end if;

  perform set_config('role','postgres', true);

  if array_length(failures, 1) is not null then
    raise exception 'member-scope crossing check failed: %', array_to_string(failures, ' | ');
  end if;
  raise notice 'OK member-scope: a member id crosses households, family_id does not, and a stranger reads neither';
end $$;

-- Leave the database exactly as it was found: every row above, and the grant,
-- existed only to prove the point.
rollback;
