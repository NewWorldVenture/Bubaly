#!/usr/bin/env bash
# ── 0472's installation window, raced for real (review 5373272320) ───────────
#
# A guard installed over a row it would have refused leaves that row in place
# for good. 0472 checks existing rows before installing its triggers, and a
# check alone cannot see a write that is not yet committed: the writer's row
# is invisible to it, the trigger creation then waits for the writer, and the
# row survives once the writer commits. So 0472 takes SHARE ROW EXCLUSIVE on
# its three tables BEFORE the check and holds it until the triggers exist.
#
# This proves that with two real sessions, twice per ordering:
#
#   payment   a writer inserts A's payment naming B's babysitter, uncommitted
#   parent    a writer moves a babysitter A has paid to B, uncommitted
#
# then runs the migration as its own session. The migration must be observed
# WAITING on a table lock inside its install block, before it scans, and once
# the writer commits it must refuse with no trigger installed and the row left
# exactly as it is. The negative control is the same migration with only its
# LOCK TABLE removed: it must install all three triggers over the invalid row.
#
# Throwaway databases only. Connects with the PG* variables (as pg-bootstrap.sh
# does) to a database that already has every migration applied, and works on
# copies of it, dropped first. Never point it at production.
#
#   PGHOST=… PGPORT=… PGUSER=postgres PGDATABASE=bubaly bash docs/audit/0472-installation-race.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$ROOT/supabase/migrations/0472_a_babysitter_payment_names_its_own_familys_sitter_and_event.sql"
SRC_DB=${PGDATABASE:?PGDATABASE names the replayed database to copy}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
grep -v '^  lock table public.babysitter_payments' "$MIG" | grep -v '^    in share row exclusive mode;' > "$WORK/unlocked.sql"
if cmp -s "$MIG" "$WORK/unlocked.sql"; then echo "FAIL: could not remove the lock for the negative control"; exit 1; fi

A=04720000-0000-4000-8000-0000000002fa
B=04720000-0000-4000-8000-0000000002fb
SITTER=04720000-0000-4000-8000-0000000002c1
PAYMENT=04720000-0000-4000-8000-0000000002d1

race() { # <db> <migration> <ordering> -> prints "<waited-on> <migration exit> <triggers> <crossing rows>"
  local db=$1 mig=$2 ordering=$3 seed write
  if [ "$ordering" = payment ]; then
    seed="insert into public.babysitter_profiles (id, family_id, name) values ('$SITTER', '$B', 'B sitter');"
    write="insert into public.babysitter_payments (id, family_id, babysitter_id, amount_cents, status) values ('$PAYMENT', '$A', '$SITTER', 100, 'completed')"
  else
    seed="insert into public.babysitter_profiles (id, family_id, name) values ('$SITTER', '$A', 'A sitter');
          insert into public.babysitter_payments (id, family_id, babysitter_id, amount_cents, status) values ('$PAYMENT', '$A', '$SITTER', 100, 'completed');"
    write="update public.babysitter_profiles set family_id = '$B' where id = '$SITTER'"
  fi
  psql -d postgres -q -c "drop database if exists $db" -c "create database $db template $SRC_DB" || return 1
  # The database as it stood before 0472.
  psql -d "$db" -q -v ON_ERROR_STOP=1 <<SQL || return 1
drop trigger if exists trg_babysitter_payments_reference_family on public.babysitter_payments;
drop trigger if exists trg_babysitter_profiles_keep_paid_family on public.babysitter_profiles;
drop trigger if exists trg_calendar_events_keep_paid_family on public.calendar_events;
drop function if exists public.babysitter_payment_references_own_family();
drop function if exists public.babysitter_payment_parent_keeps_its_family();
create extension if not exists dblink;
insert into public.families (id, name) values ('$A', 'install A'), ('$B', 'install B');
$seed
SQL
  psql -d "$db" -At -v ON_ERROR_STOP=1 > "$WORK/$db.controller" 2>&1 <<SQL
select dblink_connect('w', 'dbname=$db host=${PGHOST:-} port=${PGPORT:-5432} user=${PGUSER:-postgres} application_name=p0472_writer');
select dblink_exec('w', 'begin');
select dblink_exec('w', \$w\$$write\$w\$);
\! (PGAPPNAME=p0472_migration psql -d $db -q -v ON_ERROR_STOP=1 -f $mig > $WORK/$db.migration 2>&1; echo "exit=\$?" >> $WORK/$db.migration) &
do \$\$
declare rel text; q text; i int := 0;
begin
  loop
    perform pg_stat_clear_snapshot();
    select l.relation::regclass::text, a.query into rel, q
      from pg_stat_activity a join pg_locks l on l.pid = a.pid and not l.granted
     where a.application_name = 'p0472_migration' and l.locktype = 'relation' limit 1;
    exit when rel is not null or i > 600;
    perform pg_sleep(0.025); i := i + 1;
  end loop;
  -- Waiting inside the block that installs, which in the fixed file is also the
  -- block that scans: so it waited BEFORE scanning.
  raise notice 'WAITED %', coalesce(rel || case when q ilike '%cross_sitter%' then ':install-block' else ':elsewhere' end, 'never');
end \$\$;
select dblink_exec('w', 'commit');
select dblink_disconnect('w');
SQL
  for _ in $(seq 1 200); do grep -q '^exit=' "$WORK/$db.migration" 2>/dev/null && break; sleep 0.05; done
  local waited exit_code triggers crossing
  waited=$(grep -o 'WAITED [^ ]*' "$WORK/$db.controller" | cut -d' ' -f2)
  exit_code=$(grep -o '^exit=[0-9]*' "$WORK/$db.migration" | cut -d= -f2)
  triggers=$(psql -d "$db" -Atc "select count(*) from pg_trigger where tgname in ('trg_babysitter_payments_reference_family','trg_babysitter_profiles_keep_paid_family','trg_calendar_events_keep_paid_family')")
  crossing=$(psql -d "$db" -Atc "select count(*) from public.babysitter_payments p join public.babysitter_profiles s on s.id = p.babysitter_id where p.id = '$PAYMENT' and s.family_id <> p.family_id")
  psql -d postgres -q -c "drop database if exists $db"
  echo "$waited $exit_code $triggers $crossing"
}

failures=0
for ordering in payment parent; do
  read -r waited code triggers crossing < <(race "p0472_race_fixed_$ordering" "$MIG" "$ordering")
  echo "0472 as written, $ordering-first writer: waited on ${waited:-?}, migration exit ${code:-?}, triggers installed ${triggers:-?}, crossing rows kept ${crossing:-?}"
  if [ "${waited%%:*}" = never ] || [ "${waited#*:}" != install-block ] || [ "${code:-0}" = 0 ] || [ "${triggers:-1}" != 0 ] || [ "${crossing:-0}" != 1 ]; then
    echo "  FAIL: expected a wait inside the install block, a refused migration, 0 triggers and the writer's row left as it was"; failures=$((failures + 1))
  fi
  read -r waited code triggers crossing < <(race "p0472_race_unlocked_$ordering" "$WORK/unlocked.sql" "$ordering")
  echo "negative control (LOCK TABLE removed), $ordering-first writer: migration exit ${code:-?}, triggers installed ${triggers:-?}, crossing rows kept ${crossing:-?}"
  if [ "${code:-1}" != 0 ] || [ "${triggers:-0}" != 3 ] || [ "${crossing:-0}" != 1 ]; then
    echo "  UNPROVEN: without the lock the guard should have installed over the crossing row"; failures=$((failures + 1))
  fi
done

if [ "$failures" -gt 0 ]; then echo "0472 installation race: $failures check(s) failed"; exit 1; fi
echo "0472 installation race: OK — the migration waits before it scans and refuses a row committed meanwhile; without the lock it installs over it"
