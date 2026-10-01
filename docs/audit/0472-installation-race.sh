#!/usr/bin/env bash
# ── 0472's installation window, raced for real (reviews 5373272320, 5373431112) ─
#
# A guard installed over a row it would have refused leaves that row in place
# for good. 0472 checks existing rows before installing its triggers, and a
# check alone cannot see a write that is not yet committed: the writer's row
# is invisible to it, the trigger creation then waits for the writer, and the
# row survives once the writer commits. So 0472 takes SHARE ROW EXCLUSIVE on
# its three tables BEFORE the check and holds it until the triggers exist.
#
# This proves that with two real sessions, once per ordering:
#
#   payment   a writer inserts A's payment naming B's babysitter, uncommitted
#   parent    a writer moves a babysitter A has paid to B, uncommitted
#
# then runs the migration as its own session. The migration must be observed
# WAITING on a table lock inside its install block, and once the writer
# commits it must refuse with no trigger installed and the row left exactly as
# it is. The negative control is the same migration with only its LOCK TABLE
# removed: it must install all three triggers over the invalid row.
#
# It also measures the install block's own lock modes, in a rolled-back
# transaction, on first application and on re-application: neither may take
# ACCESS EXCLUSIVE (which would block readers and upgrade the lock mid-block).
# The negative control is the same file with each CREATE OR REPLACE TRIGGER
# turned back into DROP TRIGGER IF EXISTS + CREATE TRIGGER: on re-application
# it must take ACCESS EXCLUSIVE.
#
# Safety (reviews 5373431112, 5374783683):
#   * The target must be a disposable LOCAL cluster, checked before any psql
#     runs. PGDATABASE, P0472_MAINTENANCE_DB and PGUSER must be plain names and
#     PGPORT a number (psql -d would take a conninfo string or URI and connect
#     wherever it says); PGHOST must be unset, one socket directory or one
#     loopback name or address; PGSERVICE and PGHOSTADDR must be unset; the
#     caller must confirm with P0472_DISPOSABLE_CLUSTER=yes. Then the server
#     must report a Unix-socket or loopback connection (inet_server_addr()).
#   * It works only on databases it creates, each a copy of $PGDATABASE named
#     p0472_<64 random bits>_<case>. The random part is what makes a name this
#     run's: nobody else can have chosen it. It refuses a name that already
#     exists, and never drops one whose CREATE said it already existed.
#   * Each name is written to a run manifest BEFORE its CREATE is sent, so a
#     run stopped between the server committing a CREATE and the shell hearing
#     back still knows it. On any exit the shell can trap (not SIGKILL), it
#     drops every name it attempted and has not dropped, and deletes the
#     manifest only when none is left. After a SIGKILL, or a drop that failed,
#     the manifest (printed at start, in $P0472_MANIFEST_DIR or $TMPDIR) names
#     what to drop by hand.
#   * Every wait is finite: connect_timeout, statement_timeout, lock_timeout
#     and idle_in_transaction_session_timeout on every session, including the
#     writer opened through dblink; timeout(1) with a hard --kill-after on
#     every psql it starts, cleanup included; and a bounded poll. On exit it
#     kills only the processes it started, and DROP DATABASE … WITH (FORCE)
#     ends only backends connected to its own databases.
#
# Connects with the PG* variables (as pg-bootstrap.sh does) to a database that
# already has every migration applied. Never point it at production.
#
#   P0472_DISPOSABLE_CLUSTER=yes PGHOST=/tmp/pg0472 PGPORT=55472 PGUSER=postgres \
#     PGDATABASE=bubaly bash docs/audit/0472-installation-race.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$ROOT/supabase/migrations/0472_a_babysitter_payment_names_its_own_familys_sitter_and_event.sql"
SRC_DB=${PGDATABASE:?PGDATABASE names the replayed database to copy}
MAINT_DB=${P0472_MAINTENANCE_DB:-postgres}
RUN=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
PSQL_DEADLINE=90 # seconds, for every psql this starts

refuse() { echo "refusing: $*" >&2; exit 2; }

# ── the target, checked before any psql runs ─────────────────────────────────
NAME='^[A-Za-z_][A-Za-z0-9_]{0,62}$'
[[ $RUN =~ ^[0-9a-f]{16}$ ]] || refuse "could not draw this run's random name"
[ "${P0472_DISPOSABLE_CLUSTER:-}" = yes ] || refuse "set P0472_DISPOSABLE_CLUSTER=yes to confirm the PG* target is a throwaway local cluster"
[ -z "${PGSERVICE:-}" ] && [ -z "${PGHOSTADDR:-}" ] || refuse "PGSERVICE and PGHOSTADDR are not supported; name the target with PGHOST"
[[ $SRC_DB =~ $NAME ]] || refuse "PGDATABASE must be a plain database name, not a connection string or URI"
[[ $MAINT_DB =~ $NAME ]] || refuse "P0472_MAINTENANCE_DB must be a plain database name, not a connection string or URI"
[ -z "${PGUSER:-}" ] || [[ $PGUSER =~ $NAME ]] || refuse "PGUSER must be a plain role name"
[ -z "${PGPORT:-}" ] || [[ $PGPORT =~ ^[0-9]{1,5}$ ]] || refuse "PGPORT must be a port number"
case "${PGHOST:-}" in
  '' | localhost | 127.0.0.1 | ::1) ;;
  /*) [[ $PGHOST =~ ^/[A-Za-z0-9._/-]+$ ]] || refuse "PGHOST must be one plain socket directory" ;;
  *) refuse "PGHOST=$PGHOST is neither a socket directory nor a loopback address" ;;
esac
[ "$MAINT_DB" != "$SRC_DB" ] || refuse "the maintenance database cannot be the one copied (a template must have no other session)"

export PGCONNECT_TIMEOUT=5
export PGOPTIONS="-c statement_timeout=60s -c lock_timeout=30s -c idle_in_transaction_session_timeout=60s"
q() { timeout --kill-after=5 "$PSQL_DEADLINE" psql -X -v ON_ERROR_STOP=1 "$@"; }

where=$(q -d "$MAINT_DB" -At -c "select coalesce(host(inet_server_addr()), 'socket')") || refuse "cannot reach $MAINT_DB"
case "$where" in
  socket | 127.* | ::1) ;;
  *) refuse "the server reports address $where, which is not local" ;;
esac
tables=$(q -d "$SRC_DB" -At -c "select count(to_regclass(t)) from unnest(array['public.babysitter_payments','public.babysitter_profiles','public.calendar_events']) t") || refuse "cannot read $SRC_DB"
[ "$tables" = 3 ] || refuse "$SRC_DB does not hold the three tables 0472 guards; replay the migrations into it first"

# ── what this run owns ───────────────────────────────────────────────────────
WORK=$(mktemp -d)
MANIFEST="${P0472_MANIFEST_DIR:-${TMPDIR:-/tmp}}/p0472-race-$RUN.manifest"
( set -o noclobber; : > "$MANIFEST" ) 2>/dev/null || refuse "cannot start the run manifest at $MANIFEST"
echo "run $RUN; manifest $MANIFEST"
declare -A ATTEMPTED=() # names whose CREATE was sent and that are not yet dropped
PIDS=()
cleanup() {
  local pid db
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null; done
  for db in "${!ATTEMPTED[@]}"; do
    if timeout --kill-after=5 30 psql -X -q -d "$MAINT_DB" -c "drop database if exists \"$db\" with (force)" >/dev/null 2>&1; then
      echo "dropped $db" >> "$MANIFEST"; unset 'ATTEMPTED[$db]'
    fi
  done
  if [ "${#ATTEMPTED[@]}" -eq 0 ]; then
    rm -f "$MANIFEST"
  else
    echo "WARNING: could not drop ${!ATTEMPTED[*]}, which this run created; drop by hand (see $MANIFEST)" >&2
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

new_db() { # <name>: a copy of $SRC_DB that this run owns; refuses an existing name
  local db=$1 exists err
  [[ $db == "p0472_${RUN}_"* ]] || { echo "refusing: $db is not a name of this run" >&2; return 1; }
  exists=$(q -d "$MAINT_DB" -At -c "select count(*) from pg_database where datname = '$db'") || return 1
  if [ "$exists" != 0 ]; then echo "refusing: database $db already exists and is not this run's" >&2; return 1; fi
  # Recorded BEFORE the CREATE is sent: if this shell is stopped after the
  # server commits it but before the answer arrives, the name is still known.
  echo "attempted $db" >> "$MANIFEST" || return 1
  ATTEMPTED[$db]=1
  if ! err=$(q -d "$MAINT_DB" -q -c "create database \"$db\" template \"$SRC_DB\"" 2>&1); then
    echo "$err" >&2
    # Someone else's, however unlikely with a random name: never claim it.
    if [[ $err == *"already exists"* ]]; then echo "foreign $db" >> "$MANIFEST"; unset 'ATTEMPTED[$db]'; fi
    return 1
  fi
  echo "created $db" >> "$MANIFEST"
}
drop_db() { # <name>: only one this run attempted
  [ -n "${ATTEMPTED[$1]:-}" ] || { echo "refusing to drop $1: not created by this run" >&2; return 1; }
  q -d "$MAINT_DB" -q -c "drop database if exists \"$1\" with (force)" && { echo "dropped $1" >> "$MANIFEST"; unset 'ATTEMPTED[$1]'; }
}
pre_0472() { # <db>: the database as it stood before 0472
  q -d "$1" -q <<'SQL'
drop trigger if exists trg_babysitter_payments_reference_family on public.babysitter_payments;
drop trigger if exists trg_babysitter_profiles_keep_paid_family on public.babysitter_profiles;
drop trigger if exists trg_calendar_events_keep_paid_family on public.calendar_events;
drop function if exists public.babysitter_payment_references_own_family();
drop function if exists public.babysitter_payment_parent_keeps_its_family();
SQL
}

unlocked="$WORK/unlocked.sql"
grep -v '^  lock table public.babysitter_payments' "$MIG" | grep -v '^    in share row exclusive mode;' > "$unlocked"
cmp -s "$MIG" "$unlocked" && { echo "FAIL: could not remove the lock for the negative control"; exit 1; }
dropping="$WORK/drop-and-create.sql"
perl -0pe 's/create or replace trigger (\w+)(\s+before[^;]*? on (public\.\w+))/drop trigger if exists $1 on $3;\n  create trigger $1$2/g' "$MIG" > "$dropping"
[ "$(grep -c '^  drop trigger if exists ' "$dropping")" = 3 ] || { echo "FAIL: could not build the DROP + CREATE negative control"; exit 1; }

WRITER_CONN="dbname=%s ${PGHOST:+host=$PGHOST }port=${PGPORT:-5432} user=${PGUSER:-postgres} connect_timeout=5 options='-c statement_timeout=30s -c lock_timeout=30s -c idle_in_transaction_session_timeout=60s' application_name=p0472_writer_$RUN"

A=04720000-0000-4000-8000-0000000002fa
B=04720000-0000-4000-8000-0000000002fb
SITTER=04720000-0000-4000-8000-0000000002c1
PAYMENT=04720000-0000-4000-8000-0000000002d1

race() { # <db> <migration> <ordering>  ->  $WORK/<db>.result: "<waited-on> <migration exit> <triggers> <crossing rows>"
  local db=$1 mig=$2 ordering=$3 seed write ctrl mpid code waited triggers crossing
  if [ "$ordering" = payment ]; then
    seed="insert into public.babysitter_profiles (id, family_id, name) values ('$SITTER', '$B', 'B sitter');"
    write="insert into public.babysitter_payments (id, family_id, babysitter_id, amount_cents, status) values ('$PAYMENT', '$A', '$SITTER', 100, 'completed')"
  else
    seed="insert into public.babysitter_profiles (id, family_id, name) values ('$SITTER', '$A', 'A sitter');
          insert into public.babysitter_payments (id, family_id, babysitter_id, amount_cents, status) values ('$PAYMENT', '$A', '$SITTER', 100, 'completed');"
    write="update public.babysitter_profiles set family_id = '$B' where id = '$SITTER'"
  fi
  new_db "$db" || return 1
  pre_0472 "$db" || return 1
  q -d "$db" -q <<SQL || return 1
create extension if not exists dblink;
insert into public.families (id, name) values ('$A', 'install A'), ('$B', 'install B');
$seed
SQL

  # The writer: opened, written and left uncommitted until the migration is
  # seen waiting (or the bounded poll gives up), then committed.
  q -d "$db" -At > "$WORK/$db.controller" 2>&1 <<SQL &
select dblink_connect('w', format(\$c\$$WRITER_CONN\$c\$, '$db'));
select dblink_exec('w', 'begin');
select dblink_exec('w', \$w\$$write\$w\$);
\! touch "$WORK/$db.written"
do \$\$
declare rel text; q text; i int := 0;
begin
  loop
    perform pg_stat_clear_snapshot();
    select l.relation::regclass::text, a.query into rel, q
      from pg_stat_activity a join pg_locks l on l.pid = a.pid and not l.granted
     where a.application_name = 'p0472_migration_$RUN' and a.datname = current_database()
       and l.locktype = 'relation' limit 1;
    exit when rel is not null or i > 600;
    perform pg_sleep(0.025); i := i + 1;
  end loop;
  raise notice 'WAITED %', coalesce(rel || case when q ilike '%cross_sitter%' then ':install-block' else ':elsewhere' end, 'never');
end \$\$;
select dblink_exec('w', 'commit');
select dblink_disconnect('w');
SQL
  ctrl=$!; PIDS+=("$ctrl")
  for _ in $(seq 1 100); do [ -e "$WORK/$db.written" ] && break; sleep 0.1; done
  if [ ! -e "$WORK/$db.written" ]; then
    echo "  the writer never wrote:" >&2; cat "$WORK/$db.controller" >&2
    wait "$ctrl"; PIDS=(); drop_db "$db"; return 1
  fi

  PGAPPNAME="p0472_migration_$RUN" q -d "$db" -q -f "$mig" > "$WORK/$db.migration" 2>&1 &
  mpid=$!; PIDS+=("$mpid")
  wait "$mpid"; code=$?
  wait "$ctrl"
  PIDS=()

  waited=$(grep -o 'WAITED [^ ]*' "$WORK/$db.controller" | cut -d' ' -f2)
  triggers=$(q -d "$db" -Atc "select count(*) from pg_trigger where tgname in ('trg_babysitter_payments_reference_family','trg_babysitter_profiles_keep_paid_family','trg_calendar_events_keep_paid_family')")
  crossing=$(q -d "$db" -Atc "select count(*) from public.babysitter_payments p join public.babysitter_profiles s on s.id = p.babysitter_id where p.id = '$PAYMENT' and s.family_id <> p.family_id")
  drop_db "$db"
  echo "${waited:-?} $code ${triggers:-?} ${crossing:-?}" > "$WORK/$db.result"
}

lock_modes() { # <db> <migration>  ->  the lock modes it holds on the three tables at its end, rolled back
  q -d "$1" -At -q <<SQL
begin;
\i $2
select coalesce(string_agg(distinct mode, ',' order by mode), 'none') from pg_locks
 where pid = pg_backend_pid() and locktype = 'relation'
   and relation in ('public.babysitter_payments'::regclass, 'public.babysitter_profiles'::regclass, 'public.calendar_events'::regclass);
rollback;
SQL
}

failures=0
fail() { echo "  FAIL: $*"; failures=$((failures + 1)); }

for ordering in payment parent; do
  db="p0472_${RUN}_${ordering}_fixed"
  if race "$db" "$MIG" "$ordering"; then
    read -r waited code triggers crossing < "$WORK/$db.result"
    echo "0472 as written, $ordering-first writer: waited on $waited, migration exit $code, triggers installed $triggers, crossing rows kept $crossing"
    if [ "${waited%%:*}" = never ] || [ "${waited#*:}" != install-block ] || [ "$code" = 0 ] || [ "$triggers" != 0 ] || [ "$crossing" != 1 ]; then
      fail "expected a wait inside the install block, a refused migration, 0 triggers and the writer's row left as it was"
    fi
  else
    fail "the $ordering-first race against 0472 as written could not be run"
  fi

  db="p0472_${RUN}_${ordering}_unlocked"
  if race "$db" "$unlocked" "$ordering"; then
    read -r waited code triggers crossing < "$WORK/$db.result"
    echo "negative control (LOCK TABLE removed), $ordering-first writer: migration exit $code, triggers installed $triggers, crossing rows kept $crossing"
    if [ "$code" != 0 ] || [ "$triggers" != 3 ] || [ "$crossing" != 1 ]; then
      fail "UNPROVEN: without the lock the guard should have installed over the crossing row"
    fi
  else
    fail "the $ordering-first negative control could not be run"
  fi
done

db="p0472_${RUN}_locks"
if new_db "$db"; then
  again=$(lock_modes "$db" "$MIG")
  again_dropping=$(lock_modes "$db" "$dropping")
  if pre_0472 "$db"; then first=$(lock_modes "$db" "$MIG"); else first=; fi
  drop_db "$db"
  echo "0472's lock modes on its tables: first application ${first:-?}; re-application ${again:-?}"
  echo "negative control (DROP + CREATE TRIGGER), re-application: ${again_dropping:-?}"
  case ",$first," in *,ShareRowExclusiveLock,*) ;; *) fail "the first application did not hold SHARE ROW EXCLUSIVE" ;; esac
  case ",$first,$again," in *AccessExclusiveLock*) fail "0472 takes ACCESS EXCLUSIVE" ;; esac
  [ -n "$again" ] || fail "the re-application could not be measured"
  case ",$again_dropping," in *,AccessExclusiveLock,*) ;; *) fail "UNPROVEN: DROP + CREATE should have taken ACCESS EXCLUSIVE on re-application" ;; esac
else
  fail "the lock-mode database could not be created"
fi

if [ "$failures" -gt 0 ]; then echo "0472 installation race: $failures check(s) failed"; exit 1; fi
echo "0472 installation race: OK — the migration waits before it scans and refuses a row committed meanwhile; without the lock it installs over it; it never takes ACCESS EXCLUSIVE, where DROP + CREATE would on re-application"
