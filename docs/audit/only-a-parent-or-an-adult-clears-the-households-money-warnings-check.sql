-- ── Only a parent or an adult clears the household's money warnings (m26, 0352)
--
-- `public.money_timeline_insights` holds the Financial Copilot's advisories and,
-- per row, whether the family has acknowledged or DISMISSED them. 0168 carries
-- `unique (family_id, dedupe_key)`, so there is ONE status row per family per
-- advisory and /dashboard/money-timeline renders every member's page from it:
-- whoever taps Dismiss decides what the parents see. Refresh never rewrites
-- `status` and the module has no dismissed-items view, so a cleared warning is
-- gone for good.
--
-- 0168 gated all four commands on `is_family_member` — membership, no role — so
-- a 'child' could flip the `urgent` low_balance warning to 'dismissed' for the
-- whole household, and a 'guest' could delete the row outright.
--
-- `0352_a_child_cannot_clear_the_households_money_warnings.sql` narrows INSERT,
-- UPDATE and DELETE to `can_manage_family` (parent / adult), keeps SELECT on
-- `is_family_member`, and adds three RESTRICTIVE manager guards so that a stray
-- permissive policy added later cannot reopen the write. This file is the
-- behavioural proof of that, executed as `authenticated` with a real
-- `auth.uid()`; the vitest that shipped with 0352
-- (tests/a-child-cannot-clear-the-households-money-warnings.test.ts) runs
-- without a database and can only check a model.
--
-- WHAT IS ASSERTED, in this order:
--
--   A. NEGATIVE CONTROL (first). One actor, one family, one row. As postgres,
--      the actor's `family_members.role` is set to 'parent', then 'adult'; as
--      that actor the four household-wide writes are run —
--        S1  the exact upsert the Dismiss button sends (PostgREST's
--            `on conflict (family_id, dedupe_key) do update set <every column
--            in the payload>`), against the live urgent warning;
--        S2  a plain UPDATE of `status`;
--        S3  the same Dismiss upsert for a week that has not surfaced yet
--            (the pure INSERT path: pre-dismissing a future warning);
--        S4  a DELETE of the warning;
--      and ALL FOUR MUST LAND. If any does not, the probe raises "UNPROVEN"
--      right there and says why.
--   B. THE REFUSALS. The SAME actor, the SAME row, the SAME four statements,
--      the SAME columns; the only thing changed is that actor's role — 'child',
--      'teen', 'guest', 'caregiver'. S1 and S3 must be refused with 42501; S2
--      and S4 must touch zero rows; the actor must still READ the warning
--      (0267's read decision, restated in 0352), and the PARENT must still see
--      it 'active' with nothing pre-dismissed beside it.
--   C. THE BACKSTOP. As postgres, a permissive `FOR ALL TO authenticated USING
--      (true) WITH CHECK (true)` policy is planted — the "convenience grant"
--      0352's header names — and B is run again. It must still refuse: that is
--      the restrictive guards, and nothing else, holding the line. (The policy
--      is dropped after C, and the whole file rolls back regardless.)
--   D. The legitimate writers still write: the real parent's Dismiss lands and
--      the child's page reads back 'dismissed'; the real adult can restore it.
--   E. A non-member can neither write nor read, so RLS is live at all.
--
-- WHY THE CONTROL IS SHAPED THIS WAY
-- ----------------------------------
-- The guard's whole question is `can_manage_family(family_id)` — the caller's
-- ROLE in the row's family — where 0168 asked only `is_family_member`. So the
-- control flips exactly that one input (the actor's role, same member row,
-- same auth user) and holds everything else still. Without it every refusal in
-- B and C is unattributed:
--
--   * S1/S3 credit a 42501 to the WITH CHECK, but a revoked table GRANT, a
--     column-level revoke of `status`, a dead `auth.uid()` (both helpers then
--     answer false) and a guard trigger all raise 42501 too;
--   * S2/S4 assert ZERO ROWS, and a row the session simply cannot see or
--     cannot write for any reason reports zero rows just as readily as a USING
--     clause does.
--   Every one of those also refuses the control — same actor, same row, same
--   statements, same SET list — so the probe goes red on "UNPROVEN" instead of
--   printing a boundary it cannot see. The control's S1 names every column the
--   Dismiss payload names, so a column revoke cannot slip past a narrower
--   control and then kill S1 with a bare "permission denied".
--
-- Run against throwaway clones before this file was committed:
--   * with 0352 applied (and replayed)            -> exit 0, four OK lines;
--   * without 0352                                -> red, "boundary failed:
--     [guarded] a child DISMISSED the household's urgent low-balance warning";
--   * 0352 + `revoke insert, update, delete … from authenticated`, 0352 +
--     a column revoke of UPDATE(status), 0352 + `auth.uid()` returning null,
--     and 0352 + a trigger raising 42501 for `authenticated`
--                                                 -> red, "UNPROVEN" on the
--     control, each naming its real cause;
--   * 0352 with its three restrictive guards dropped -> the control and the
--     guarded refusals hold, and it goes red on phase C alone.
--
-- The probe does NOT grant anything to `authenticated`: the grants it runs
-- against are the database's own, which is what makes the revoked-grant
-- mutation of this probe go red on the control.
--
-- Everything runs in one transaction and ends in ROLLBACK, so a re-run is
-- idempotent. Every UUID below is prefixed 03520352- and unique across
-- docs/audit and supabase/migrations.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/only-a-parent-or-an-adult-clears-the-households-money-warnings-check.sql

\set FH '03520352-0000-4000-8000-000000000001'
\set UP '03520352-0000-4000-8000-000000000002'
\set UA '03520352-0000-4000-8000-000000000003'
\set UK '03520352-0000-4000-8000-000000000004'
\set UX '03520352-0000-4000-8000-000000000005'
\set MA '03520352-0000-4000-8000-000000000006'
\set MK '03520352-0000-4000-8000-000000000007'

begin;

insert into auth.users (id, email) values (:'UP','mw0352-parent@example.com')   on conflict do nothing;
insert into auth.users (id, email) values (:'UA','mw0352-adult@example.com')    on conflict do nothing;
insert into auth.users (id, email) values (:'UK','mw0352-kid@example.com')      on conflict do nothing;
insert into auth.users (id, email) values (:'UX','mw0352-stranger@example.com') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FH','Money Warning House',:'UP') on conflict do nothing;
-- on_family_created files the creator as a 'parent'; re-assert rather than
-- assume, because a seed whose roles are wrong proves nothing.
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FH',:'UP','Parent','parent',true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values (:'MA',:'FH',:'UA','Other Adult','adult',true)
  on conflict (family_id, user_id) do update set role = 'adult', is_active = true;
-- The actor. Starts as a 'child'; the loop below sets the role per case.
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values (:'MK',:'FH',:'UK','Kid','child',true)
  on conflict (family_id, user_id) do update set role = 'child', is_active = true;

do $$
declare
  fam        constant uuid := '03520352-0000-4000-8000-000000000001';
  parent_u   constant uuid := '03520352-0000-4000-8000-000000000002';
  adult_u    constant uuid := '03520352-0000-4000-8000-000000000003';
  actor_u    constant uuid := '03520352-0000-4000-8000-000000000004';
  stranger_u constant uuid := '03520352-0000-4000-8000-000000000005';
  actor_m    constant uuid := '03520352-0000-4000-8000-000000000007';
  warning    constant uuid := '03520352-0000-4000-8000-000000000008';
  warn_key   constant text := 'low_balance:2026-03-02';
  next_key   constant text := 'low_balance:2026-03-09';

  -- Phase A first; B and C only once A has held.
  phases text[] := array['control','control',
                         'guarded','guarded','guarded','guarded',
                         'open-door','open-door','open-door','open-door'];
  roles  text[] := array['parent','adult',
                         'child','teen','guest','caregiver',
                         'child','teen','guest','caregiver'];

  phase    text;
  r        text;
  who      text;
  n        int;
  s        text;
  outcome  text;
  door_open boolean := false;
  control_failures text[] := '{}';
  failures text[] := '{}';
begin
  -- The seed, checked as postgres before anything is measured against it.
  if not exists (select 1 from public.family_members
                 where family_id = fam and user_id = parent_u and role = 'parent' and is_active) then
    raise exception 'seed broken: the parent of Money Warning House is not an active parent';
  end if;
  if not exists (select 1 from public.family_members
                 where id = actor_m and family_id = fam and user_id = actor_u and is_active) then
    raise exception 'seed broken: the actor is not an active member of Money Warning House';
  end if;

  for i in 1 .. array_length(roles, 1) loop
    phase := phases[i];
    r     := roles[i];
    who   := format('[%s] a %s', phase, r);

    -- Leaving the control. A failed control makes every refusal below
    -- unreadable, so say WHY the probe cannot speak while the reason is in
    -- hand. The boundary is reported neither as holding nor as broken: it is
    -- reported as unproven, and the build is red either way.
    if phase <> 'control' and array_length(control_failures, 1) is not null then
      raise exception 'money-warning write boundary UNPROVEN (the control this probe rests on did not hold): %',
        array_to_string(control_failures, ' | ');
    end if;

    -- ── Reset, as postgres ───────────────────────────────────────────────
    perform set_config('role', 'postgres', true);
    if phase = 'open-door' and not door_open then
      -- The convenience grant 0352's header warns about. Permissive policies
      -- OR together, so on its own this reopens every write; only the
      -- restrictive guards, which AND, can keep phase C refused.
      create policy probe_0352_stray_open_door on public.money_timeline_insights
        as permissive for all to authenticated using (true) with check (true);
      door_open := true;
    end if;
    delete from public.money_timeline_insights where family_id = fam;
    insert into public.money_timeline_insights
      (id, family_id, kind, title, detail, severity, week_start, amount, status, dedupe_key)
    values
      (warning, fam, 'low_balance', 'Balance runs thin the week of Mar 2',
       'At the current pace your balance dips to -$140 the week of Mar 2.',
       'urgent', '2026-03-02', -140, 'active', warn_key);
    -- The ONE thing that differs between the control and the refusals.
    update public.family_members set role = r::public.member_role where id = actor_m;

    -- ── As the actor ─────────────────────────────────────────────────────
    -- Set OUTSIDE the exception blocks below: a caught error rolls back its
    -- subtransaction, and a local GUC set inside one would roll back with it.
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', actor_u::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    perform set_config('request.jwt.claims',
      json_build_object('sub', actor_u, 'role', 'authenticated')::text, true);

    -- S1: the Dismiss button's upsert, on the live urgent warning. Every
    -- column of the payload is in the SET list, as PostgREST writes it.
    begin
      insert into public.money_timeline_insights
        (family_id, kind, title, detail, severity, week_start, amount, status, dedupe_key)
      values
        (fam, 'low_balance', 'Balance runs thin the week of Mar 2',
         'At the current pace your balance dips to -$140 the week of Mar 2.',
         'urgent', '2026-03-02', -140, 'dismissed', warn_key)
      on conflict (family_id, dedupe_key) do update set
        family_id  = excluded.family_id,
        kind       = excluded.kind,
        title      = excluded.title,
        detail     = excluded.detail,
        severity   = excluded.severity,
        week_start = excluded.week_start,
        amount     = excluded.amount,
        status     = excluded.status,
        dedupe_key = excluded.dedupe_key;
      get diagnostics n = row_count;
      outcome := 'landed ' || n;
    exception when others then
      outcome := sqlstate || ' ' || sqlerrm;
    end;
    if phase = 'control' then
      if outcome <> 'landed 1' then
        control_failures := array_append(control_failures, format(
          '%s was not able to Dismiss the warning in a family they manage (%s), so a refused Dismiss below would prove nothing about the manager gate — only that something said no', who, outcome));
      else
        select status into s from public.money_timeline_insights where id = warning;
        if s is distinct from 'dismissed' then
          control_failures := array_append(control_failures, format(
            '%s''s Dismiss reported a row but the warning reads back %s, not dismissed', who, coalesce(s, 'no row')));
        end if;
      end if;
    elsif outcome like 'landed%' then
      failures := array_append(failures, format(
        '%s DISMISSED the household''s urgent low-balance warning (%s) — it is gone from the parents'' page too', who, outcome));
    elsif outcome not like '42501 %' then
      failures := array_append(failures, format(
        '%s''s Dismiss was refused, but not with insufficient_privilege: %s', who, outcome));
    end if;

    -- S2: a plain UPDATE of the family-wide status.
    begin
      update public.money_timeline_insights set status = 'acknowledged' where id = warning;
      get diagnostics n = row_count;
      outcome := 'rows ' || n;
    exception when others then
      outcome := sqlstate || ' ' || sqlerrm;
    end;
    if phase = 'control' then
      if outcome <> 'rows 1' then
        control_failures := array_append(control_failures, format(
          '%s''s UPDATE of status on a warning in a family they manage gave %s, so the zero-row refusals below would prove nothing: a row this session cannot write reports zero either way', who, outcome));
      end if;
    elsif outcome <> 'rows 0' then
      failures := array_append(failures, format(
        '%s''s UPDATE of the warning''s status gave %s, expected rows 0', who, outcome));
    end if;

    -- S3: the same Dismiss upsert for a week that has not surfaced yet — the
    -- pure INSERT path, pre-dismissing a warning before a parent ever sees it.
    begin
      insert into public.money_timeline_insights
        (family_id, kind, title, detail, severity, week_start, amount, status, dedupe_key)
      values
        (fam, 'low_balance', 'Balance runs thin the week of Mar 9',
         'At the current pace your balance dips to -$260 the week of Mar 9.',
         'urgent', '2026-03-09', -260, 'dismissed', next_key)
      on conflict (family_id, dedupe_key) do update set
        family_id  = excluded.family_id,
        kind       = excluded.kind,
        title      = excluded.title,
        detail     = excluded.detail,
        severity   = excluded.severity,
        week_start = excluded.week_start,
        amount     = excluded.amount,
        status     = excluded.status,
        dedupe_key = excluded.dedupe_key;
      get diagnostics n = row_count;
      outcome := 'landed ' || n;
    exception when others then
      outcome := sqlstate || ' ' || sqlerrm;
    end;
    if phase = 'control' then
      if outcome <> 'landed 1' then
        control_failures := array_append(control_failures, format(
          '%s could not INSERT a new advisory in a family they manage (%s)', who, outcome));
      end if;
    elsif outcome like 'landed%' then
      failures := array_append(failures, format(
        '%s PRE-DISMISSED a warning for a week that has not surfaced yet (%s)', who, outcome));
    elsif outcome not like '42501 %' then
      failures := array_append(failures, format(
        '%s''s INSERT was refused, but not with insufficient_privilege: %s', who, outcome));
    end if;

    -- S4: DELETE the warning, taking the family's acknowledge/dismiss record
    -- with it.
    begin
      delete from public.money_timeline_insights where id = warning;
      get diagnostics n = row_count;
      outcome := 'rows ' || n;
    exception when others then
      outcome := sqlstate || ' ' || sqlerrm;
    end;
    if phase = 'control' then
      if outcome <> 'rows 1' then
        control_failures := array_append(control_failures, format(
          '%s''s DELETE of a warning in a family they manage gave %s, so the zero-row refusal below would prove nothing', who, outcome));
      end if;
    elsif outcome <> 'rows 0' then
      failures := array_append(failures, format(
        '%s DELETED the household''s warning (%s, expected rows 0)', who, outcome));
    end if;

    -- In the BREACH case S4 has already removed the row and said so; the read
    -- checks below would only repeat it as "missing", so they run on a row S4
    -- did not delete.
    if phase <> 'control' and outcome = 'rows 0' then
      -- Reads stay open, deliberately (0267's decision, restated in 0352).
      -- Recorded so a change of that decision is made on purpose.
      s := null;
      select status into s from public.money_timeline_insights where id = warning;
      if s is null then
        failures := array_append(failures, format(
          '%s can no longer READ the warning — reads were meant to stay open; update 0352''s header and this probe if that changed on purpose', who));
      end if;

      -- And the question the finding is about: is the shortfall warning still
      -- in front of the parents, and nothing pre-dismissed beside it?
      perform set_config('request.jwt.claim.sub', parent_u::text, true);
      perform set_config('request.jwt.claims',
        json_build_object('sub', parent_u, 'role', 'authenticated')::text, true);
      s := null;
      select status into s from public.money_timeline_insights where id = warning;
      if s is distinct from 'active' then
        failures := array_append(failures, format(
          'after %s had a go, the PARENT reads the urgent warning as %s, not active', who, coalesce(s, 'missing')));
      end if;
      select count(*) into n from public.money_timeline_insights where family_id = fam and dedupe_key = next_key;
      if n <> 0 then
        failures := array_append(failures, format(
          'after %s had a go, the PARENT finds %s pre-dismissed advisory row(s) for a week not yet surfaced', who, n));
      end if;
    end if;
  end loop;

  -- ── Back to the household as it really is ─────────────────────────────
  perform set_config('role', 'postgres', true);
  if door_open then
    drop policy probe_0352_stray_open_door on public.money_timeline_insights;
  end if;
  update public.family_members set role = 'child' where id = actor_m;
  delete from public.money_timeline_insights where family_id = fam;
  insert into public.money_timeline_insights
    (id, family_id, kind, title, detail, severity, week_start, amount, status, dedupe_key)
  values
    (warning, fam, 'low_balance', 'Balance runs thin the week of Mar 2',
     'At the current pace your balance dips to -$140 the week of Mar 2.',
     'urgent', '2026-03-02', -140, 'active', warn_key);

  -- ── D. The legitimate writers still write ──────────────────────────────
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', parent_u, 'role', 'authenticated')::text, true);
  begin
    insert into public.money_timeline_insights
      (family_id, kind, title, detail, severity, week_start, amount, status, dedupe_key)
    values
      (fam, 'low_balance', 'Balance runs thin the week of Mar 2',
       'At the current pace your balance dips to -$140 the week of Mar 2.',
       'urgent', '2026-03-02', -140, 'dismissed', warn_key)
    on conflict (family_id, dedupe_key) do update set
      family_id  = excluded.family_id,
      kind       = excluded.kind,
      title      = excluded.title,
      detail     = excluded.detail,
      severity   = excluded.severity,
      week_start = excluded.week_start,
      amount     = excluded.amount,
      status     = excluded.status,
      dedupe_key = excluded.dedupe_key;
    get diagnostics n = row_count;
    if n <> 1 then
      failures := array_append(failures, format('the PARENT''s Dismiss wrote %s rows, expected 1 — the guard refuses a legitimate writer', n));
    end if;
  exception when others then
    failures := array_append(failures, format('the PARENT could not Dismiss the warning (%s %s) — the guard refuses a legitimate writer', sqlstate, sqlerrm));
  end;

  -- The child's page renders from the same row, so it shows the parent's call.
  perform set_config('request.jwt.claim.sub', actor_u::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', actor_u, 'role', 'authenticated')::text, true);
  s := null;
  select status into s from public.money_timeline_insights where id = warning;
  if s is distinct from 'dismissed' then
    failures := array_append(failures, format('after the parent dismissed it, the child reads the warning as %s, not dismissed', coalesce(s, 'missing')));
  end if;

  -- The other adult can put it back.
  perform set_config('request.jwt.claim.sub', adult_u::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', adult_u, 'role', 'authenticated')::text, true);
  begin
    update public.money_timeline_insights set status = 'active' where id = warning;
    get diagnostics n = row_count;
    if n <> 1 then
      failures := array_append(failures, format('the ADULT''s restore of the warning changed %s rows, expected 1', n));
    end if;
  exception when others then
    failures := array_append(failures, format('the ADULT could not restore the warning (%s %s)', sqlstate, sqlerrm));
  end;

  -- ── E. A non-member: RLS is live at all ────────────────────────────────
  perform set_config('request.jwt.claim.sub', stranger_u::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', stranger_u, 'role', 'authenticated')::text, true);
  select count(*) into n from public.money_timeline_insights where family_id = fam;
  if n <> 0 then
    failures := array_append(failures, format('a NON-MEMBER can read %s of this family''s money warnings', n));
  end if;
  begin
    insert into public.money_timeline_insights
      (family_id, kind, title, detail, severity, week_start, amount, status, dedupe_key)
    values
      (fam, 'all_clear', 'All clear', 'Nothing to worry about.', 'info', null, null, 'active', 'all_clear:general');
    failures := array_append(failures, 'a NON-MEMBER inserted an advisory into this family');
  exception when insufficient_privilege then null;
  end;

  perform set_config('role', 'postgres', true);

  if array_length(failures, 1) is not null then
    raise exception 'money-warning write boundary failed: %', array_to_string(failures, ' | ');
  end if;
  raise notice 'OK money_timeline_insights control: the same actor, promoted to parent and to adult, CAN dismiss, update, pre-dismiss and delete the family''s warning';
  raise notice 'OK money_timeline_insights: as child, teen, guest and caregiver the same actor cannot dismiss, update, pre-dismiss or delete it, still reads it, and the parent still sees it active';
  raise notice 'OK money_timeline_insights backstop: with a stray permissive FOR ALL policy planted, the restrictive manager guards still refuse all four writes';
  raise notice 'OK money_timeline_insights: a parent dismisses and an adult restores; a non-member can neither read nor write';
end $$;

rollback;
