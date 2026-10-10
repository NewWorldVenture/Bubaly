-- 0496 — A child's XP is awarded by a parent, not by the child.
-- Found and reproduced 2026-10-09 on a replay of every runnable migration.
--
-- 0354 made kid_progress (chore XP, level and streaks) a manager's to write,
-- because "a child could simply write their own level 50 and every badge". The
-- direct write is closed: a child's UPDATE now changes nothing. But 0341 had
-- already moved every award into two SECURITY DEFINER functions, and SECURITY
-- DEFINER does not consult RLS. Their own caller check restated the policy of
-- the day, 00430's `is_family_member`, and 0354 never revisited them. So the
-- same child called
--
--   kid_progress_apply_completion(family, their own member id, 999999, today)
--
-- and was answered ok: true, xp 999999, level 141. kid_progress_revert_completion
-- likewise let a child write their own streaks. No money moves (XP is the chore
-- game, not the wallet), but levels and streaks are what the next real
-- approval awards badges from.
--
-- Both functions are 0341's, copied unchanged except for that one predicate,
-- which is now 0354's: `can_manage_family`, beside the service-role branch the
-- auto-approve payout uses. Their only caller is lib/chores/server.ts, reached
-- from finalizeApproval in app/(app)/missions/actions.ts: with the service
-- client on auto-approval, and with a manager's session in
-- approveSubmissionAction after isManager. So no legitimate award changes. The row lock,
-- the level curve, the cross-family refusal and the grants are untouched;
-- `create or replace` keeps the existing EXECUTE grants.
--
-- HELD: proposed as 0496 (the first number above 0495; requested on #771 in
-- comment 6089394563, not yet confirmed) in supabase/reserved/ until every
-- number below it has landed. Proven by
-- docs/audit/reserved/a-childs-xp-is-awarded-by-a-parent-check.sql and
-- .github/workflows/kid-progress-award-runtime.yml. Not applied to production
-- by an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md for the owner.

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

  -- 0354's policy, restated: SECURITY DEFINER does not consult it. Writes to
  -- kid_progress are a manager's (or the server's), not any member's.
  if not (current_user = 'service_role'
          or coalesce(auth.role(), '') = 'service_role'
          or auth.uid() is null
          or public.can_manage_family(p_family_id)) then
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
          or public.can_manage_family(p_family_id)) then
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

do $$
begin
  if exists (
    select 1 from pg_proc
     where oid in ('public.kid_progress_apply_completion(uuid,uuid,integer,date)'::regprocedure,
                   'public.kid_progress_revert_completion(uuid,uuid,integer,integer,integer,date,integer,integer,date)'::regprocedure)
       and (not prosecdef or position('can_manage_family(p_family_id)' in prosrc) = 0
            or position('is_family_member(p_family_id)' in prosrc) > 0)
  ) then
    raise exception '0496: both kid_progress award functions must be SECURITY DEFINER and admit only a manager or the service role';
  end if;
end $$;
