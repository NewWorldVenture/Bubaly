-- Bubaly :: 0341 - two approvals for one kid both land
--
-- `applyCompletionRewards` (lib/chores/server.ts) is a read-modify-write with
-- neither a lock nor a condition:
--
--   const progress = await ensureProgress(supabase, opts.familyId, opts.memberId);
--   const xp = progress.xp + gainedXp;                         -- <- READ
--   const level = levelForXp(xp);
--   const streak = nextStreak(progress.current_streak, progress.last_activity, today);
--   const longest = Math.max(progress.longest_streak, streak);
--   await supabase.from('kid_progress')
--     .update({ xp, level, current_streak: streak, longest_streak: longest, last_activity: today })
--     .eq('id', progress.id).eq('family_id', opts.familyId);   -- <- blind WRITE
--
-- Two chores approved for one child at the same moment — two parents, one
-- parent with two tabs, or the auto-approve path landing while a parent presses
-- Approve — both read xp=100 and both write 120. One award is silently lost and
-- the child is told 120 twice.
--
-- `level`, `current_streak` and `longest_streak` are computed from the SAME
-- stale read and go out in the same statement, so all four are lost together.
-- That is why this migration moves all four and not just the XP: a fix that
-- made only `xp` relative would leave `level` decided from a total the row no
-- longer holds — the halves would then disagree with each other, which is worse
-- than the defect, because a wrong level looks deliberate.
--
-- The engine's own docstring says idempotency is the CALLER's responsibility
-- ("call once per approval"). That is about one approval being submitted twice
-- and it stays true — this is TWO DIFFERENT approvals arriving together, which
-- no caller-side rule can prevent and which the caller is right to make. That
-- contract is unchanged by this migration.
--
-- ── measured, with two real concurrent sessions ────────────────────────────
--
-- `docs/audit/two-approvals-for-one-kid-both-land-race.sh` approves two medium
-- chores (20 XP each) for one child on two connections with two seconds of
-- deliberate overlap. Measured against a replay of 352 migrations:
--
--   -- a child on 100 XP, two medium chores (20 XP each) --
--     BLIND  shape — read, then UPDATE by id (the defect)
--       xp=120  level=2  current_streak=2  longest_streak=2
--     LOCKED shape — kid_progress_apply_completion (0341)
--       xp=140  level=2  current_streak=2  longest_streak=2
--
--   -- a child on 270 XP, where the lost award is also a lost level-up --
--     BLIND  shape — read, then UPDATE by id (the defect)
--       xp=290  level=2  current_streak=2  longest_streak=2
--     LOCKED shape — kid_progress_apply_completion (0341)
--       xp=310  level=3  current_streak=2  longest_streak=2
--
-- Same two sessions, same seconds, same row. The lock is the whole difference,
-- and the second pair is why "it is only XP" is not a fair summary: at 270 the
-- lost award is the level the child was shown they had reached.
--
-- ── the fix ────────────────────────────────────────────────────────────────
--
-- The same shape `0317` used for the listing state machine and `0208` uses for
-- goal funding: the row is read FOR UPDATE, so the values the arithmetic is
-- done from are the values that will be written. The award becomes RELATIVE to
-- the locked row rather than absolute against a snapshot taken before it.
--
-- `kid_progress_level_for_xp` mirrors `levelForXp` in lib/chores/logic.ts
-- exactly — same curve, same loop, same answer — because the level has to be
-- recomputed inside the lock and the app's copy is outside it. The two are
-- pinned against each other by one table of values asserted on both sides —
-- `docs/audit/two-approvals-for-one-kid-both-land-check.sql` against this
-- function, tests/two-approvals-for-one-kid-both-land.test.ts against
-- `levelForXp` — so a change made to one copy and not the other fails on one
-- side or the other, rather than quietly paying a different level in the
-- database than the UI celebrates.
--
-- The streak arm is the same three cases `nextStreak` decides — no activity
-- yet, already active today, the next day, or a gap — decided from the locked
-- row for the same reason.
--
-- A NOTE ON WHAT THIS IS NOT: this is not a new authorization boundary.
-- `kid_progress` carries `00430`'s single role-blind policy
-- (`is_family_member(family_id)` FOR ALL), so any family member could already
-- write this row directly. SECURITY DEFINER bypasses RLS, so the function
-- RESTATES that policy rather than inventing one — it grants nothing the table
-- did not already grant, and tightening it to managers is a separate decision
-- with its own call sites to check (the auto-approve path runs as the service
-- role, the parent path as the approving manager). What the function DOES add
-- is the cross-family guard the table never had: `kid_progress` is not one of
-- `0311`'s family-scoped references, so nothing stopped a row naming this
-- family beside another family's member. A definer function must not be looser
-- than the policy it replaces.

-- ── the level curve, mirrored from lib/chores/logic.ts ──────────────────────
-- levelForXp: level N is reached at 100 * (N-1) * N / 2 cumulative XP — 100,
-- 300, 600, 1000, … The loop is the app's loop, not a closed form, because a
-- closed form here would round differently at the boundaries and the two copies
-- have to agree on EVERY value, not nearly all of them.
create or replace function public.kid_progress_level_for_xp(p_xp integer)
returns integer
language plpgsql
immutable
as $$
declare
  v_level integer := 1;
begin
  if p_xp is null then
    return 1;
  end if;
  -- xpForLevel(v_level + 1) = 100 * v_level * (v_level + 1) / 2 = 50 * n * (n+1).
  -- bigint, so the multiply cannot overflow before the comparison decides.
  while 50::bigint * v_level * (v_level + 1) <= p_xp loop
    v_level := v_level + 1;
  end loop;
  return v_level;
end;
$$;

comment on function public.kid_progress_level_for_xp(integer) is
  'XP -> level, the same curve as levelForXp in lib/chores/logic.ts (level N at 100*(N-1)*N/2). Exists because kid_progress_apply_completion has to recompute the level inside the row lock, where the applications copy cannot reach (0341).';

-- ── the award itself ────────────────────────────────────────────────────────
create or replace function public.kid_progress_apply_completion(
  p_family_id uuid,
  p_member_id uuid,
  p_gained_xp integer,
  p_today date
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row     public.kid_progress%rowtype;
  v_xp      integer;
  v_level   integer;
  v_streak  integer;
  v_longest integer;
begin
  if p_family_id is null or p_member_id is null or p_today is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_arguments');
  end if;
  if p_gained_xp is null or p_gained_xp < 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_xp');
  end if;

  -- 00430's policy, restated: SECURITY DEFINER does not consult it.
  if not (current_user = 'service_role'
          or coalesce(auth.role(), '') = 'service_role'
          or auth.uid() is null
          or public.is_family_member(p_family_id)) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  -- The guard the table never had: the member must be in the family named.
  if not exists (
    select 1 from public.family_members
     where id = p_member_id and family_id = p_family_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'member_not_in_family');
  end if;

  -- Get-or-create, then LOCK. `on conflict do nothing` waits for a concurrent
  -- inserter to commit, so the select that follows it sees the row either way —
  -- which is what makes the very first two approvals for a new child safe too.
  insert into public.kid_progress (family_id, member_id)
  values (p_family_id, p_member_id)
  on conflict (member_id) do nothing;

  select * into v_row
    from public.kid_progress
   where member_id = p_member_id and family_id = p_family_id
   for update;
  if not found then
    -- member_id is UNIQUE across families, so a row held by another family is
    -- the only way here. Say so rather than creating a second one.
    return jsonb_build_object('ok', false, 'reason', 'progress_unavailable');
  end if;

  -- Everything below decides from v_row, which is now locked: no other session
  -- can write this row until this transaction ends.
  v_xp    := v_row.xp + p_gained_xp;
  v_level := public.kid_progress_level_for_xp(v_xp);

  -- nextStreak: no history -> 1; already counted today -> unchanged (floored at
  -- 1); the very next day -> +1; any other gap, forwards or backwards -> 1.
  if v_row.last_activity is null then
    v_streak := 1;
  elsif v_row.last_activity = p_today then
    v_streak := greatest(1, v_row.current_streak);
  elsif p_today - v_row.last_activity = 1 then
    v_streak := v_row.current_streak + 1;
  else
    v_streak := 1;
  end if;
  v_longest := greatest(v_row.longest_streak, v_streak);

  update public.kid_progress
     set xp = v_xp,
         level = v_level,
         current_streak = v_streak,
         longest_streak = v_longest,
         last_activity = p_today
   where id = v_row.id;

  -- The `previous_*` half is what the caller needs to undo this ONE award if
  -- the badge work that follows it fails; see kid_progress_revert_completion.
  return jsonb_build_object(
    'ok', true,
    'xp', v_xp,
    'level', v_level,
    'current_streak', v_streak,
    'longest_streak', v_longest,
    'last_activity', p_today,
    'previous_level', v_row.level,
    'previous_streak', v_row.current_streak,
    'previous_longest_streak', v_row.longest_streak,
    'previous_last_activity', v_row.last_activity
  );
end;
$$;

comment on function public.kid_progress_apply_completion(uuid, uuid, integer, date) is
  'Applies one approved chore to kid_progress: reads the row FOR UPDATE and adds the XP to what is THERE, so two approvals landing together both count. Level and streak are recomputed inside the same lock because they come off the same read. Restates 00430s family policy (SECURITY DEFINER bypasses RLS) and adds the cross-family member guard the table never carried (0341).';

-- ── undoing one award, without undoing anybody else's ───────────────────────
--
-- The engine rolls the progress row back when the badge work after it fails. It
-- did that by writing the pre-award values back absolutely, which is the same
-- lost update pointing the other way: a concurrent award that landed in between
-- would be erased by the rollback of an unrelated one.
--
-- So the reversal is relative too. The XP this award added is taken back off
-- whatever the row now holds, and the level is recomputed from the result. The
-- STREAK fields cannot be reversed by arithmetic — a streak is a fact about
-- days, not a running total — so they are restored only while the row still
-- carries exactly what this award left behind. If another approval has since
-- decided the streak from fresher facts, it is left alone and the caller is
-- told so (`streak_restored`) rather than having it clobbered silently.
create or replace function public.kid_progress_revert_completion(
  p_family_id uuid,
  p_member_id uuid,
  p_gained_xp integer,
  p_applied_streak integer,
  p_applied_longest_streak integer,
  p_applied_last_activity date,
  p_previous_streak integer,
  p_previous_longest_streak integer,
  p_previous_last_activity date
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row      public.kid_progress%rowtype;
  v_xp       integer;
  v_level    integer;
  v_streak   integer;
  v_longest  integer;
  v_activity date;
  v_restored boolean;
begin
  if p_family_id is null or p_member_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_arguments');
  end if;
  if p_gained_xp is null or p_gained_xp < 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_xp');
  end if;

  if not (current_user = 'service_role'
          or coalesce(auth.role(), '') = 'service_role'
          or auth.uid() is null
          or public.is_family_member(p_family_id)) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  select * into v_row
    from public.kid_progress
   where member_id = p_member_id and family_id = p_family_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'progress_unavailable');
  end if;

  -- Floored at zero: a reversal larger than the row holds is a bug somewhere
  -- else, and a negative XP total would spread it into the level curve and the
  -- UI rather than leaving it where it happened.
  v_xp    := greatest(0, v_row.xp - p_gained_xp);
  v_level := public.kid_progress_level_for_xp(v_xp);

  v_restored := v_row.current_streak is not distinct from p_applied_streak
            and v_row.longest_streak is not distinct from p_applied_longest_streak
            and v_row.last_activity  is not distinct from p_applied_last_activity;

  if v_restored then
    v_streak   := p_previous_streak;
    v_longest  := p_previous_longest_streak;
    v_activity := p_previous_last_activity;
  else
    v_streak   := v_row.current_streak;
    v_longest  := v_row.longest_streak;
    v_activity := v_row.last_activity;
  end if;

  update public.kid_progress
     set xp = v_xp,
         level = v_level,
         current_streak = v_streak,
         longest_streak = v_longest,
         last_activity = v_activity
   where id = v_row.id;

  return jsonb_build_object(
    'ok', true,
    'xp', v_xp,
    'level', v_level,
    'current_streak', v_streak,
    'longest_streak', v_longest,
    'last_activity', v_activity,
    'streak_restored', v_restored
  );
end;
$$;

comment on function public.kid_progress_revert_completion(uuid, uuid, integer, integer, integer, date, integer, integer, date) is
  'Takes back ONE chore award under the same row lock: the XP is subtracted from what the row now holds rather than the pre-award total being written back, so a concurrent approval that landed in between survives the rollback. Streak fields are restored only while the row still carries what that award wrote (0341).';

revoke all on function public.kid_progress_apply_completion(uuid, uuid, integer, date) from public, anon;
revoke all on function public.kid_progress_revert_completion(uuid, uuid, integer, integer, integer, date, integer, integer, date) from public, anon;
grant execute on function public.kid_progress_apply_completion(uuid, uuid, integer, date) to authenticated, service_role;
grant execute on function public.kid_progress_revert_completion(uuid, uuid, integer, integer, integer, date, integer, integer, date) to authenticated, service_role;
