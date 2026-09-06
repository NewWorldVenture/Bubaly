#!/usr/bin/env bash
# ── Run every boundary probe against a bootstrapped database ─────────────────
# Each docs/audit/*-check.sql asserts its invariants with RAISE EXCEPTION, so
# `psql -v ON_ERROR_STOP=1` turns a broken boundary into a non-zero exit. This
# runner GLOBS rather than listing: a probe added tomorrow is run tomorrow,
# without anyone remembering to register it here or in the workflow.
#
#   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly bash docs/audit/run-probes.sh
#
# Every probe runs even after one fails, so a red build names every broken
# boundary rather than only the first.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
shopt -s nullglob
probes=("$ROOT"/docs/audit/*-check.sql)

if [ ${#probes[@]} -eq 0 ]; then
  echo "no probes found in docs/audit — the boundary proofs have been deleted"
  exit 1
fi

failed=()
for f in "${probes[@]}"; do
  name=$(basename "$f")
  if out=$(psql -v ON_ERROR_STOP=1 -f "$f" 2>&1); then
    echo "PASS  $name"
    echo "$out" | grep -iE "NOTICE:.*(OK|PASSED)" | sed 's/^.*NOTICE:  /        /'
  else
    failed+=("$name")
    echo "FAIL  $name"
    echo "$out" | grep -iE "ERROR|FATAL" | head -5 | sed 's/^/        /'
  fi
done

echo
echo "== probes: $(( ${#probes[@]} - ${#failed[@]} ))/${#probes[@]} passed =="
if [ ${#failed[@]} -ne 0 ]; then
  echo "FAILED PROBES: ${failed[*]}"
  exit 1
fi
