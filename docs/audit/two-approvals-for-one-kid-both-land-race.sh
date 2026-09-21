#!/usr/bin/env bash
# ── Two chores approved for one kid at the same time, on two connections ─────
#
# `applyCompletionRewards` (lib/chores/server.ts) read `kid_progress`, added the
# XP in TypeScript, and wrote the total back by id — no lock, no predicate. Two
# approvals arriving together both read xp=100 and both wrote 120: one award
# silently lost. `level`, `current_streak` and `longest_streak` were computed
# from the same stale read and went out in the same statement.
#
# 0341 moves all four sums behind `select … for update` inside
# `kid_progress_apply_completion`. This script measures the difference the way
# the defect actually happens: two real sessions, overlapping on purpose.
#
# This is a RACE, not a boundary check, so it is deliberately NOT in the
# `*-check.sql` set that `run-probes.sh` globs — it needs two connections and
# four seconds of overlap per shape. The assertions a race would need are in
# `docs/audit/two-approvals-for-one-kid-both-land-check.sql`, which does run in
# CI. Run this one by hand against the throwaway harness:
#
#   bash docs/audit/verify-pg.sh up
#   bash docs/audit/two-approvals-for-one-kid-both-land-race.sh
#   bash docs/audit/verify-pg.sh down
#
# Measured 2026-09-21 against a replay of 352 migrations:
#
#   -- a child on 100 XP, two medium chores (20 XP each) --
#   BLIND  shape — read, then UPDATE by id (the defect)
#     xp=120  level=2  current_streak=2  longest_streak=2
#   LOCKED shape — kid_progress_apply_completion (0341)
#     xp=140  level=2  current_streak=2  longest_streak=2
#
#   -- a child on 270 XP, where the lost award is also a lost level-up --
#   BLIND  shape — read, then UPDATE by id (the defect)
#     xp=290  level=2  current_streak=2  longest_streak=2
#   LOCKED shape — kid_progress_apply_completion (0341)
#     xp=310  level=3  current_streak=2  longest_streak=2
#
# Same two sessions, same seconds, same row. The lock is the whole difference,
# and the second pair is why "it is only XP" is not a fair summary of it: at 270
# the lost award is the level the child was shown they had reached.
#
# Agents must NOT apply migrations to production (human-owned; see
# docs/PENDING_PROD_MIGRATIONS.md). This touches a throwaway database only.
set -u
export PGHOST=${PGHOST:-/tmp/pgaudit_db} PGPORT=${PGPORT:-54399} PGUSER=${PGUSER:-postgres} PGDATABASE=${PGDATABASE:-bubaly}

FAM=00000000-0000-4000-8000-0000000c6c01
PARENT=00000000-0000-4000-8000-0000000c6c0a
KIDUSER=00000000-0000-4000-8000-0000000c6c0b
MEMBER=

seed() {
  psql -q -v ON_ERROR_STOP=1 <<SQL
insert into auth.users (id, email) values ('$PARENT','race-progress-parent@example.com') on conflict (id) do nothing;
insert into auth.users (id, email) values ('$KIDUSER','race-progress-kid@example.com') on conflict (id) do nothing;
insert into public.families (id, name, created_by) values ('$FAM','Progress Race House','$PARENT') on conflict (id) do nothing;
-- A SECOND auth user for the child: the creator already has a member row from
-- \`on_family_created\`, and reusing it would collide on (family_id, user_id).
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values ('$FAM','$KIDUSER','Kid','child',true) on conflict do nothing;
SQL
  MEMBER=$(psql -qAt -c "select id from public.family_members where family_id = '$FAM' and user_id = '$KIDUSER'")
}

# \$1 = the XP the child starts on. Yesterday's activity, so the streak arm has
# something to decide from (1 -> 2) rather than defaulting.
reset() {
  psql -q -v ON_ERROR_STOP=1 <<SQL
delete from public.kid_progress where member_id = '$MEMBER';
insert into public.kid_progress (family_id, member_id, xp, level, current_streak, longest_streak, last_activity)
values ('$FAM','$MEMBER',$1, public.kid_progress_level_for_xp($1), 1, 1, current_date - 1);
SQL
}

# The defect, exactly: read the row with no lock, spend two seconds doing what
# the server action does between the read and the write, then write the total
# back by id. Every column is computed from the snapshot, as the application did.
run_blind() {
  psql -q -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<SQL
begin;
do \$do\$
declare snap public.kid_progress%rowtype; v_streak int;
begin
  select * into snap from public.kid_progress where member_id = '$MEMBER';
  perform pg_sleep(2);
  if snap.last_activity is null then v_streak := 1;
  elsif snap.last_activity = current_date then v_streak := greatest(1, snap.current_streak);
  elsif current_date - snap.last_activity = 1 then v_streak := snap.current_streak + 1;
  else v_streak := 1; end if;
  update public.kid_progress
     set xp = snap.xp + 20,
         level = public.kid_progress_level_for_xp(snap.xp + 20),
         current_streak = v_streak,
         longest_streak = greatest(snap.longest_streak, v_streak),
         last_activity = current_date
   where id = snap.id;
end
\$do\$;
commit;
SQL
}

# The fix: the same two seconds, spent holding the row lock the award was
# decided under, so the second session reads what the first one wrote.
run_locked() {
  psql -q -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<SQL
begin;
select public.kid_progress_apply_completion('$FAM','$MEMBER',20,current_date);
select pg_sleep(2);
commit;
SQL
}

report() {
  psql -qAt -c "select 'xp='||xp||'  level='||level||'  current_streak='||current_streak||'  longest_streak='||longest_streak
                 from public.kid_progress where member_id = '$MEMBER'" | sed 's/^/    /'
}

race() { # $1 = shape, $2 = starting xp
  reset "$2"
  if [ "$1" = blind ]; then run_blind & run_blind & else run_locked & run_locked & fi
  wait
  report
}

seed
if [ -z "$MEMBER" ]; then echo "could not seed the race member — is this a bootstrapped Bubaly database?"; exit 1; fi

for start in 100 270; do
  echo "-- a child on $start XP, two medium chores (20 XP each) --"
  echo "  BLIND  shape — read, then UPDATE by id (the defect)"
  race blind "$start"
  echo "  LOCKED shape — kid_progress_apply_completion (0341)"
  race locked "$start"
done

psql -q -c "delete from public.kid_progress where member_id = '$MEMBER'" >/dev/null 2>&1
