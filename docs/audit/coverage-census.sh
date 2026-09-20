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
# Exits 0 either way.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

section() { printf '\n== %s ==\n' "$1"; }

# ── API routes, by their URL path ───────────────────────────────────────────
section "API routes"
named=0; unnamed=(); 
while read -r r; do
  [ -z "$r" ] && continue
  if grep -rqF "$r" tests/ 2>/dev/null; then named=$((named+1)); else unnamed+=("$r"); fi
done < <(find app/api -name route.ts 2>/dev/null | sed 's|^app||; s|/route.ts$||' | sort)
total=$(( named + ${#unnamed[@]} ))
printf '  named by a test: %d / %d\n' "$named" "$total"
if [ ${#unnamed[@]} -gt 0 ]; then
  printf '  NOT named by anything under tests/:\n'
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
probed=0; unprobed=(); tested=0; untested=0
while read -r tb; do
  [ -z "$tb" ] && continue
  if grep -rqw "$tb" docs/audit/*-check.sql 2>/dev/null; then probed=$((probed+1)); else unprobed+=("$tb"); fi
  if grep -rqw "$tb" tests/ 2>/dev/null; then tested=$((tested+1)); else untested=$((untested+1)); fi
done < <(psql -tAq -c "select tablename from pg_tables where schemaname='public' order by 1")
total=$(( probed + ${#unprobed[@]} ))
printf '  named by a BOUNDARY PROBE: %d / %d\n' "$probed" "$total"
printf '  named by any test:         %d / %d\n' "$tested" "$(( tested + untested ))"
printf '  (RLS enabled on %s of them)\n' "$(psql -tAq -c "select count(*) from pg_tables t join pg_class c on c.relname = t.tablename join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public' where t.schemaname = 'public' and c.relrowsecurity")"

echo
echo "The unprobed tables are NOT a defect list. Most need no probe: a probe is"
echo "for a boundary someone reasoned about and could get wrong. This number is"
echo "here so that 'we have 61 probes' is never mistaken for 'the schema is"
echo "covered' — 61 probes name ${probed} of ${total} tables, and that ratio is the"
echo "honest shape of the proof this repository carries."
