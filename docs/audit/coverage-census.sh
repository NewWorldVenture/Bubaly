#!/usr/bin/env bash
# ── How much of the surface is NAMED by something that tests it? ────────────
#
# The Audit Status block reports "Overall Completion: 0.01%", which is a
# percentage of the Codex cycle's enumeration of the whole target space. It is
# not wrong, and it is nearly useless for deciding what to look at next: it
# cannot distinguish a route with four tests from one nothing has ever
# mentioned.
#
#   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly bash docs/audit/coverage-census.sh
#
# ── What "named by" means, and what it does NOT ─────────────────────────────
#
# This script asks one cheap, checkable question per surface: does the string
# that identifies it appear anywhere under `tests/`, or in a boundary probe?
#
# That is an UPPER BOUND on coverage and a LOWER BOUND on neglect. A test may
# name `/api/blog/like` in a route-inventory array and assert nothing about it;
# this script counts that as named. So a high number does not mean "tested" —
# it means "not invisible". The number that carries real information is the
# complement: a route, table or action that NOTHING under tests/ so much as
# mentions has certainly never been exercised, and those names are printed.
#
# It is deliberately not a gate and not a threshold. A repo can be made to
# score 100% here by adding one array of strings, which is exactly why the
# output lists the unnamed rather than just counting them: the list is the
# useful artefact and it cannot be gamed without actually writing something.
#
# ── The false negative this had, and now does not ───────────────────────────
# The first cut reported /api/cron/automations as named by nothing. It is not:
# tests/cron-auth.test.ts:11 does `readdirSync('app/api/cron', …)` and asserts
# the auth gate on EVERY route it finds, so it covers that route thoroughly
# while never containing its path as a string. A test can cover a surface
# without naming it, and a metric that only looks for names calls that
# uncovered.
#
# So the route pass now also asks whether any ancestor directory is enumerated
# by a test, and counts that as covered. Over the six routes the name test
# missed, exactly one — that cron route — turned out to be covered this way;
# the other five are genuinely untouched. The check is narrow on purpose: it
# recognises `readdirSync('<dir>')` and `glob('<dir>…')` over a path under
# `app/api`, which is the shape this repo uses. A cleverer enumerator would
# slip past it, and that would be another false negative of the same kind.
#
# Exits 0 either way.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

section() { printf '\n== %s ==\n' "$1"; }

# ── API routes, by their URL path ───────────────────────────────────────────
section "API routes"

# Directories a test walks with readdirSync/glob. A route inside one is covered
# by whatever that test asserts, without its path appearing anywhere.
mapfile -t ENUMERATED < <(grep -rhoE "(readdirSync|glob|globSync)\(['\"][^'\"]*app/api[^'\"]*['\"]" tests/*.ts 2>/dev/null \
  | grep -oE "app/api[^'\"]*" | sed 's|/$||' | sort -u)

covered_by_enumerator() {
  local path="app$1/"
  local d
  for d in "${ENUMERATED[@]:-}"; do
    [ -z "$d" ] && continue
    case "$path" in "$d"/*) return 0;; esac
  done
  return 1
}

named=0; enumerated=0; unnamed=()
while read -r r; do
  [ -z "$r" ] && continue
  if grep -rqF "$r" tests/ 2>/dev/null; then named=$((named+1))
  elif covered_by_enumerator "$r"; then enumerated=$((enumerated+1))
  else unnamed+=("$r"); fi
done < <(find app/api -name route.ts 2>/dev/null | sed 's|^app||; s|/route.ts$||' | sort)
total=$(( named + enumerated + ${#unnamed[@]} ))
printf '  named by a test:                %d / %d\n' "$named" "$total"
printf '  not named but inside a walked directory: %d\n' "$enumerated"
printf '  reached by neither:             %d\n' "${#unnamed[@]}"
if [ ${#ENUMERATED[@]} -gt 0 ]; then
  printf '  (directories a test walks: %s)\n' "$(printf '%s ' "${ENUMERATED[@]}")"
fi
if [ ${#unnamed[@]} -gt 0 ]; then
  printf '  REACHED BY NEITHER — these have certainly never been exercised:\n'
  printf '    %s\n' "${unnamed[@]}"
fi

# ── Server-action files ─────────────────────────────────────────────────────
section "Server-action files ('use server')"
named=0; unnamed=()
while read -r f; do
  [ -z "$f" ] && continue
  base=$(basename "$f"); dir=$(basename "$(dirname "$f")")
  if grep -rqF "$dir/$base" tests/ 2>/dev/null || grep -rqF "$f" tests/ 2>/dev/null; then
    named=$((named+1))
  else unnamed+=("$f"); fi
done < <(grep -rl "^'use server'" --include=*.ts app lib 2>/dev/null | sort)
total=$(( named + ${#unnamed[@]} ))
printf '  named by a test: %d / %d\n' "$named" "$total"
if [ ${#unnamed[@]} -gt 0 ]; then
  printf '  NOT named by anything under tests/ (first 40):\n'
  printf '    %s\n' "${unnamed[@]:0:40}"
  [ ${#unnamed[@]} -gt 40 ] && printf '    … and %d more\n' $(( ${#unnamed[@]} - 40 ))
fi

# ── Tables, against the boundary probes and against tests/ ──────────────────
# Two different questions. A probe is the only thing that proves an RLS
# boundary; a unit test naming a table usually means a service writes it.
section "Public tables"

# A failed CONNECTION is not a measurement of zero, and this section used to
# report it as one. `psql` would fail, the loop below would read nothing, and
# the counters would print "named by a BOUNDARY PROBE: 0 / 0" with an empty
# "(RLS enabled on  of them)" underneath — after which the closing paragraph
# called that ratio "the honest shape of the proof this repository carries".
#
# That is the empty-vs-failed defect this census exists to help find, committed
# by the census itself. So the connection is proved FIRST, and a failure is
# fatal to the section rather than silent inside it.
#
# The two cases are kept distinct on purpose: a database that answers with zero
# tables is a real (if strange) measurement and prints as one; a database that
# does not answer is not a measurement at all and says so.
if ! db_probe=$(psql -tAq -c 'select 1' 2>&1); then
  printf '  DATABASE UNAVAILABLE — the table census did NOT run.\n'
  printf '  psql said: %s\n' "$(printf '%s' "$db_probe" | head -2 | tr '\n' ' ')"
  printf '  This is NOT "0 of 0 tables". No table figure is reported below,\n'
  printf '  because none was measured. Point PGHOST/PGUSER/PGDATABASE at the\n'
  printf '  replayed database and re-run.\n'
  exit 2
fi

probed=0; unprobed=(); tested=0; untested=0
while read -r tb; do
  [ -z "$tb" ] && continue
  if grep -rqw "$tb" docs/audit/*-check.sql 2>/dev/null; then probed=$((probed+1)); else unprobed+=("$tb"); fi
  if grep -rqw "$tb" tests/ 2>/dev/null; then tested=$((tested+1)); else untested=$((untested+1)); fi
done < <(psql -tAq -c "select tablename from pg_tables where schemaname='public' order by 1")
total=$(( probed + ${#unprobed[@]} ))
if [ "$total" -eq 0 ]; then
  printf '  The database answered, and reported NO public tables.\n'
  printf '  That is a measurement, not a failure — but it almost certainly means\n'
  printf '  the migrations were never replayed into this database.\n'
  exit 2
fi
printf '  named by a BOUNDARY PROBE: %d / %d\n' "$probed" "$total"
printf '  named by any test:         %d / %d\n' "$tested" "$(( tested + untested ))"
printf '  (RLS enabled on %s of them)\n' "$(psql -tAq -c "select count(*) from pg_tables t join pg_class c on c.relname = t.tablename join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public' where t.schemaname = 'public' and c.relrowsecurity")"

echo
echo "The unprobed tables are NOT a defect list. Most need no probe: a probe is"
echo "for a boundary someone reasoned about and could get wrong. This number is"
echo "here so that 'we have 61 probes' is never mistaken for 'the schema is"
echo "covered' — 61 probes name ${probed} of ${total} tables, and that ratio is the"
echo "honest shape of the proof this repository carries."
