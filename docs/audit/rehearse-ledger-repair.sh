#!/usr/bin/env bash
# ── Rehearse the LB-016 §4 ledger repair against production's actual condition ─
#
# LB-016 §4.1 rests on one claim:
#
#   "the ledger does not need to be *told* what is applied; it repairs itself by
#    letting `supabase db push` run from 0004, where the already-applied
#    migrations no-op and the genuinely missing ones land."
#
# That claim has never been tested. It is the whole basis of the repair, it is
# executed against production in a maintenance window, and if it is wrong the
# operator discovers that mid-window with the app down.
#
# This rehearses it. It reproduces production's condition exactly — a database
# carrying the FULL schema but a ledger holding only 0001-0003 — and then
# replays every migration from 0004 the way `supabase db push` does: in version
# order, each in its own transaction, recording a ledger row for each success.
#
# It answers three questions with evidence rather than assertion:
#   1. Does every already-applied migration genuinely no-op?
#   2. Where exactly would the operator's push stop, if anywhere?
#   3. Is the end state the one the guard wants (requiresBaselineReview: false)?
#
# It NEVER touches production: it refuses any PGHOST that is not a unix socket
# or the loopback interface, neither of which can reach a remote database.
#
# CI runs it as the last step of the Database job, against that job's own
# service container, so every pull request re-proves the repair still works.
#
#   bash docs/audit/verify-pg.sh up          # full schema, as production has
#   bash docs/audit/rehearse-ledger-repair.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

: "${PGHOST:=/tmp/pgaudit_db}"
: "${PGPORT:=54399}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=bubaly}"
export PGHOST PGPORT PGUSER PGDATABASE

# Refuse to run anywhere that could be real. This rewrites the migration ledger
# and replays 300+ migrations, so being pointed at production would be a
# catastrophe rather than a mistake.
#
# The test is not a name allowlist — it is reachability. Production is a REMOTE
# Postgres (db.<ref>.supabase.co, pooler.supabase.com, :5432 over TLS). A unix
# socket and the loopback interface cannot reach it from anywhere, so accepting
# exactly those two, and nothing else, is a guarantee rather than a convention:
#
#   /tmp/pgaudit_db:54399   the local harness (docs/audit/verify-pg.sh)
#   localhost:5432          the job-owned service container in ci.yml
#
# A hostname that resolves off-box fails here regardless of what it is called.
case "$PGHOST" in
  /*)                          where="unix socket $PGHOST" ;;
  localhost|127.0.0.1|::1)     where="loopback $PGHOST:$PGPORT" ;;
  *)
    echo "REFUSING: this rehearsal rewrites the migration ledger and only runs"
    echo "  against a throwaway database reachable over a unix socket or loopback."
    echo "  PGHOST=$PGHOST is a remote host. Refusing to continue."
    exit 1
    ;;
esac

if ! psql -tAc 'select 1' >/dev/null 2>&1; then
  echo "no database on $where — run: bash docs/audit/verify-pg.sh up"
  exit 1
fi

tables_before=$(psql -tAc "select count(*) from information_schema.tables where table_schema='public';")
echo "== harness carries $tables_before public tables (production's condition: schema ahead of ledger) =="

# ── Production's condition: the full schema, a ledger holding only 0001-0003 ──
psql -q <<'SQL'
create schema if not exists supabase_migrations;
drop table if exists supabase_migrations.schema_migrations;
create table supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);
insert into supabase_migrations.schema_migrations (version) values ('0001'), ('0002'), ('0003');
SQL
echo "== ledger seeded with 0001-0003 only, exactly as production reports =="
echo

# ── Replay from 0004, the way `supabase db push` does ────────────────────────
applied=0; noop_ok=0; failed=0
first_failure=""
declare -a failures=()

for f in "$ROOT"/supabase/migrations/*.sql; do   # glob is lexicographic = apply order
  base=$(basename "$f")
  version="${base%%_*}"

  # Already in the ledger → db push skips it. 0001-0003 only.
  if psql -tAc "select 1 from supabase_migrations.schema_migrations where version='$version'" | grep -q 1; then
    continue
  fi

  # Each migration in its own transaction, as db push runs them.
  if out=$(psql -v ON_ERROR_STOP=1 --single-transaction -f "$f" 2>&1); then
    psql -q -c "insert into supabase_migrations.schema_migrations (version, name) values ('$version', '$base') on conflict (version) do nothing;"
    applied=$((applied+1))
    noop_ok=$((noop_ok+1))
  else
    failed=$((failed+1))
    failures+=("$base")
    [ -z "$first_failure" ] && first_failure="$base :: $(echo "$out" | grep -E '^psql.*ERROR' | head -1)"
    # db push would STOP here. Keep going so the rehearsal reports every
    # migration that cannot be replayed, not just the first one.
  fi
done

echo "== replay from 0004 against an already-populated schema =="
echo "   re-applied cleanly (no-op as claimed): $noop_ok"
echo "   FAILED:                               $failed"
if [ "$failed" -ne 0 ]; then
  echo
  echo "   The operator's push would STOP at:"
  echo "     $first_failure"
  echo
  echo "   Every migration that could not be replayed:"
  printf '     %s\n' "${failures[@]}"
fi
echo

# ── The end state the guard cares about ──────────────────────────────────────
ledger_count=$(psql -tAc "select count(*) from supabase_migrations.schema_migrations;")
high_water=$(psql -tAc "select max(version) from supabase_migrations.schema_migrations;")
has_0004=$(psql -tAc "select count(*) from supabase_migrations.schema_migrations where version='0004';")
has_policy=$(psql -tAc "select count(*) from pg_policies where schemaname='public' and tablename='profiles' and policyname='profiles_insert_self';")
tables_after=$(psql -tAc "select count(*) from information_schema.tables where table_schema='public';")

echo "== end state =="
echo "   ledger rows:        $ledger_count (high-water $high_water)"
echo "   0004 recorded:      $has_0004   <- what hasUnrecordedBaseline looks for"
echo "   profiles_insert_self present: $has_policy"
echo "   public tables:      $tables_before -> $tables_after"
if [ "$has_policy" -eq 1 ] && [ "$has_0004" -eq 0 ]; then
  echo "   requiresBaselineReview would still be TRUE — repair did NOT clear the guard"
  exit 1
fi
echo "   requiresBaselineReview would now be FALSE — the guard clears on its own"
[ "$failed" -eq 0 ] || exit 1
