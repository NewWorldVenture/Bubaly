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
skipped=()
for f in "${probes[@]}"; do
  name=$(basename "$f")
  if out=$(psql -v ON_ERROR_STOP=1 -f "$f" 2>&1); then
    # A probe that DECLINED to run its own invariant exits zero, exactly like
    # one that ran and held. Counting it as a pass is how "64/64 passed" came to
    # be printed over a run in which the wallet concurrency invariant was never
    # exercised at all — the probe said so in its own notice, one line below a
    # PASS, and the total said otherwise. A green line that proves nothing is
    # worse than a missing one, so a skip is now its own verdict and is named in
    # the summary rather than folded into the pass count.
    # CASE-SENSITIVE, and that is the whole trick. Matching /skip/i here caught
    # three probes that had done no such thing: Postgres says `extension "dblink"
    # already exists, skipping` and `policy "…" does not exist, skipping` in the
    # course of a perfectly good run, and family-self-read's own success line
    # reads "197 empty, skipped". The engine's chatter is lowercase; a probe's
    # verdict about ITSELF is written `SKIP:` or `SKIPPED`, uppercase, which is
    # the convention every probe here already follows. Reading the engine's words
    # as the probe's verdict is the same mistake as a source-shape guard that
    # scans comments — measure what the probe SAID, not what ran past it.
    if echo "$out" | grep -qE "NOTICE:.*\bSKIP(PED)?\b"; then
      skipped+=("$name")
      echo "SKIP  $name"
    else
      echo "PASS  $name"
    fi
    # Same case-sensitivity, for the same reason: /skip/i printed three lines of
    # `… does not exist, skipping` under every probe that creates anything.
    echo "$out" | grep -E "NOTICE:.*(OK|PASSED|\bSKIP(PED)?\b)" | sed 's/^.*NOTICE:  /        /'
  else
    failed+=("$name")
    echo "FAIL  $name"
    echo "$out" | grep -iE "ERROR|FATAL" | head -5 | sed 's/^/        /'
  fi
done

echo
echo "== probes: $(( ${#probes[@]} - ${#failed[@]} - ${#skipped[@]} )) passed, ${#skipped[@]} skipped, ${#failed[@]} failed, of ${#probes[@]} =="
if [ ${#skipped[@]} -ne 0 ]; then
  echo "SKIPPED PROBES (their invariants were NOT exercised): ${skipped[*]}"
fi
if [ ${#failed[@]} -ne 0 ]; then
  echo "FAILED PROBES: ${failed[*]}"
  exit 1
fi
# A skip is a hole in the proof, not a pass, and CI is where that distinction
# has to bite: every probe here can run on a fully migrated database, so a skip
# means an absent table, a missing extension or a boundary that stopped being
# reachable — each worth a red build. PROBES_ALLOW_SKIP=1 is for a developer
# running these against a partial database on purpose.
if [ ${#skipped[@]} -ne 0 ] && [ "${PROBES_ALLOW_SKIP:-0}" != "1" ]; then
  echo "A skipped probe proves nothing. Set PROBES_ALLOW_SKIP=1 only if that is deliberate."
  exit 1
fi
