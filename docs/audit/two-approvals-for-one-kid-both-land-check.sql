-- Two approvals for one kid both land — the database half of 0341.
--
-- `applyCompletionRewards` read `kid_progress`, added the XP in TypeScript, and
-- wrote the total back by id. Two chores approved for one child at the same
-- moment both read xp=100 and both wrote 120: one award silently lost. `level`,
-- `current_streak` and `longest_streak` came off the same stale read and went
-- out in the same statement, so all four were lost together.
--
-- This probe does not race two sessions — it cannot, inside one psql script.
-- `docs/audit/two-approvals-for-one-kid-both-land-race.sh` does that on two
-- connections. What this asserts is what a race would need to be true:
--
--   * the award ACCUMULATES against the stored row rather than a snapshot, so
--     two of them make 140 and not 120 (with the old blind shape performed in
--     the same script, on the same row, as the negative control that shows the
--     comparison can still say 120);
--   * the mechanism is still there, read out of `pg_get_functiondef` rather
--     than out of a file, so it cannot pass against a definition some later
--     migration replaced;
--   * the reversal takes back ONE award relatively, and leaves the streak alone
--     when somebody else has written since;
--   * the level curve in SQL is the curve in lib/chores/logic.ts. That table is
--     duplicated, deliberately, in
--     tests/two-approvals-for-one-kid-both-land.test.ts against `levelForXp` —
--     one table, asserted on both sides, because two copies of a curve drift
--     silently and the drift pays one level while the UI celebrates another.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam       uuid := '00000000-0000-4000-8000-0000000c6b01';
  other_fam uuid := '00000000-0000-4000-8000-0000000c6b02';
  parent_u  uuid := '00000000-0000-4000-8000-0000000c6b0a';
  kid_u     uuid := '00000000-0000-4000-8000-0000000c6b0b';
  other_u   uuid := '00000000-0000-4000-8000-0000000c6b0c';
  kid       uuid;
  other_kid uuid;
  today     date := date '2026-09-21';
  snapshot  public.kid_progress%rowtype;
  r         jsonb;
  n         int;
  def       text;
  xps       int[] := array[0, 1, 99, 100, 140, 299, 300, 599, 600, 999, 1000, 1499, 1500];
  levels    int[] := array[1, 1,  1,   2,   2,   2,   3,   3,   4,   4,    5,    5,    6];
  i         int;
  failures  int := 0;
begin
  -- ── seed, re-runnably ─────────────────────────────────────────────────────
  insert into auth.users (id, email) values (parent_u, 'kid-progress-parent@example.com') on conflict (id) do nothing;
  insert into auth.users (id, email) values (kid_u,    'kid-progress-kid@example.com')    on conflict (id) do nothing;
  insert into auth.users (id, email) values (other_u,  'kid-progress-other@example.com')  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Progress family', parent_u) on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (other_fam, 'Other family', other_u) on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, kid_u, 'Kid', 'child', true) on conflict do nothing;
  select id into kid from public.family_members where family_id = fam and user_id = kid_u;
  select id into other_kid from public.family_members where family_id = other_fam and user_id = other_u;

  delete from public.kid_progress where member_id in (kid, other_kid);

  -- ── 1. two awards accumulate: 100 + 20 + 20 = 140 ────────────────────────
  insert into public.kid_progress (family_id, member_id, xp, level, current_streak, longest_streak, last_activity)
    values (fam, kid, 100, 2, 1, 1, today - 1);

  r := public.kid_progress_apply_completion(fam, kid, 20, today);
  if coalesce(r->>'ok', 'false') <> 'true' then
    raise warning 'CONTROL FAILED: the first award was refused (%)', r->>'reason';
    failures := failures + 1;
  elsif (r->>'xp')::int <> 120 or (r->>'current_streak')::int <> 2
     or (r->>'longest_streak')::int <> 2 or (r->>'previous_streak')::int <> 1 then
    raise warning 'CONTROL FAILED: the first award reported % rather than xp=120 streak=2 longest=2 previous_streak=1', r;
    failures := failures + 1;
  end if;

  r := public.kid_progress_apply_completion(fam, kid, 20, today);
  if (r->>'xp')::int <> 140 then
    raise warning 'BREACH: the second award reported xp=%, so it was computed from a total the row no longer held', r->>'xp';
    failures := failures + 1;
  end if;

  select * into snapshot from public.kid_progress where member_id = kid;
  if snapshot.xp <> 140 then
    raise warning 'BREACH: two 20 XP awards from 100 stored xp=% — one of them was lost', snapshot.xp;
    failures := failures + 1;
  end if;
  -- The three columns off the same read. A fix that moved only the XP leaves
  -- these decided from a total the row no longer holds.
  if snapshot.level <> public.kid_progress_level_for_xp(140) or snapshot.current_streak <> 2
     or snapshot.longest_streak <> 2 or snapshot.last_activity <> today then
    raise warning 'BREACH: level/streak/longest/last_activity are % % % % after two awards',
      snapshot.level, snapshot.current_streak, snapshot.longest_streak, snapshot.last_activity;
    failures := failures + 1;
  end if;

  -- ── 2. negative control: the blind shape, on the same row ────────────────
  -- Read once, then write the total back twice — what the application used to
  -- do when two approvals overlapped. If this does NOT land 120, assertion 1 is
  -- measuring nothing.
  update public.kid_progress set xp = 100, level = 2, current_streak = 1, longest_streak = 1,
    last_activity = today - 1 where member_id = kid;
  select * into snapshot from public.kid_progress where member_id = kid;
  update public.kid_progress set xp = snapshot.xp + 20 where id = snapshot.id;
  update public.kid_progress set xp = snapshot.xp + 20 where id = snapshot.id;
  select xp into n from public.kid_progress where member_id = kid;
  if n <> 120 then
    raise warning 'CONTROL FAILED: the blind read-modify-write stored xp=% rather than 120 — this probe is not measuring what it claims', n;
    failures := failures + 1;
  end if;

  -- ── 3. the mechanism, read out of the catalog ────────────────────────────
  def := lower(pg_get_functiondef('public.kid_progress_apply_completion(uuid,uuid,integer,date)'::regprocedure));
  if position('for update' in def) = 0 then
    raise warning 'BREACH: kid_progress_apply_completion no longer reads the row FOR UPDATE';
    failures := failures + 1;
  end if;
  if position('for update' in lower(pg_get_functiondef('public.kid_progress_revert_completion(uuid,uuid,integer,integer,integer,date,integer,integer,date)'::regprocedure))) = 0 then
    raise warning 'BREACH: kid_progress_revert_completion no longer reads the row FOR UPDATE';
    failures := failures + 1;
  end if;
  -- Negative control for the reader itself: a function that genuinely has no
  -- lock must come back without one, or `position(...)` is matching anything.
  if position('for update' in lower(pg_get_functiondef('public.kid_progress_level_for_xp(integer)'::regprocedure))) <> 0 then
    raise warning 'CONTROL FAILED: the definition reader claims a lock in kid_progress_level_for_xp, which has none';
    failures := failures + 1;
  end if;

  -- ── 4. the reversal takes back one award, relatively ─────────────────────
  update public.kid_progress set xp = 140, level = 2, current_streak = 2, longest_streak = 2,
    last_activity = today where member_id = kid;
  r := public.kid_progress_revert_completion(fam, kid, 20, 2, 2, today, 1, 1, today - 1);
  select * into snapshot from public.kid_progress where member_id = kid;
  if snapshot.xp <> 120 or coalesce(r->>'streak_restored', 'false') <> 'true'
     or snapshot.current_streak <> 1 or snapshot.last_activity <> today - 1 then
    raise warning 'BREACH: reverting one award left xp=% streak=% last_activity=% (restored=%)',
      snapshot.xp, snapshot.current_streak, snapshot.last_activity, r->>'streak_restored';
    failures := failures + 1;
  end if;

  -- And when somebody else has written since, the streak is LEFT ALONE rather
  -- than clobbered — the lost update pointing the other way.
  update public.kid_progress set xp = 160, current_streak = 5, longest_streak = 5,
    last_activity = today where member_id = kid;
  r := public.kid_progress_revert_completion(fam, kid, 20, 2, 2, today, 1, 1, today - 1);
  select * into snapshot from public.kid_progress where member_id = kid;
  if snapshot.xp <> 140 then
    raise warning 'BREACH: the reversal wrote a pre-award total back instead of subtracting: xp=%', snapshot.xp;
    failures := failures + 1;
  end if;
  if snapshot.current_streak <> 5 or coalesce(r->>'streak_restored', 'true') <> 'false' then
    raise warning 'BREACH: the reversal erased a streak another approval had decided (streak=%, restored=%)',
      snapshot.current_streak, r->>'streak_restored';
    failures := failures + 1;
  end if;

  -- ── 5. the level curve is the application's curve ────────────────────────
  for i in 1 .. array_length(xps, 1) loop
    if public.kid_progress_level_for_xp(xps[i]) <> levels[i] then
      raise warning 'BREACH: kid_progress_level_for_xp(%) = %, levelForXp says %',
        xps[i], public.kid_progress_level_for_xp(xps[i]), levels[i];
      failures := failures + 1;
    end if;
  end loop;

  -- ── 6. the function is not looser than the policy it replaced ────────────
  -- SECURITY DEFINER bypasses RLS, and kid_progress is not one of 0311's
  -- family-scoped references, so this is the only thing standing between a
  -- family and another family's child.
  r := public.kid_progress_apply_completion(fam, other_kid, 20, today);
  if coalesce(r->>'ok', 'false') <> 'false' or r->>'reason' <> 'member_not_in_family' then
    raise warning 'BREACH: a family could award XP to another family''s member (%)', r;
    failures := failures + 1;
  end if;
  select count(*) into n from public.kid_progress where member_id = other_kid;
  if n <> 0 then
    raise warning 'BREACH: the refused cross-family award still created a progress row';
    failures := failures + 1;
  end if;

  r := public.kid_progress_apply_completion(fam, kid, -20, today);
  if coalesce(r->>'ok', 'false') <> 'false' or r->>'reason' <> 'invalid_xp' then
    raise warning 'BREACH: a negative award was accepted (%)', r;
    failures := failures + 1;
  end if;

  -- ── 7. control: a child with no row yet gets one, and it counts ──────────
  delete from public.kid_progress where member_id = kid;
  r := public.kid_progress_apply_completion(fam, kid, 20, today);
  if coalesce(r->>'ok', 'false') <> 'true' or (r->>'xp')::int <> 20 or (r->>'current_streak')::int <> 1 then
    raise warning 'CONTROL FAILED: the first ever award for a child did not land (%)', r;
    failures := failures + 1;
  end if;

  delete from public.kid_progress where member_id in (kid, other_kid);

  if failures > 0 then
    raise exception '0341 FAILED: % assertion(s)', failures;
  end if;
  raise notice '0341 OK: two approvals for one kid both land (16 assertions)';
end
$probe$;
