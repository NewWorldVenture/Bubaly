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

# wallet-concurrency-check opens a SECOND session through dblink to race two
# overlapping transactions. dblink demands a password from non-superusers, and
# Supabase's `postgres` role is not a superuser — so without this the probe
# errored rather than ran. Forwarded as a GUC so the probe never hardcodes it;
# with no PGPASSWORD set the probe skips and says so.
if [ -n "${PGPASSWORD:-}" ]; then
  export PGOPTIONS="${PGOPTIONS:-} -c bubaly.dblink_password=${PGPASSWORD}"
fi
shopt -s nullglob
probes=("$ROOT"/docs/audit/*-check.sql)

if [ ${#probes[@]} -eq 0 ]; then
  echo "no probes found in docs/audit — the boundary proofs have been deleted"
  exit 1
fi

# A probe that could not run is not a probe that passed. Two of these skip by
# design when the server cannot support them — wallet-concurrency needs a second
# dblink session, plpgsql-bodies-resolve needs the plpgsql_check extension — and
# a skip exits zero, so it used to be printed as PASS and counted as one.
#
# That is the same defect this suite exists to find, in the suite itself: a
# check that cannot fail in the environment it runs in. `circle-join-code-check`
# called a function that was dead in production and went green on every pull
# request for months, because CI's pgcrypto sat in a different schema. Reporting
# a skip as a pass is how that stays invisible.
#
# Skips are raised at WARNING so `set client_min_messages = warning` — which
# every probe sets, to keep its own progress notices quiet — cannot swallow the
# one line saying the probe did nothing.
#
# The marker is the exact token `PROBE-SKIPPED:` rather than the word "skip",
# because "skip" appears all over honest output and matching it caught two
# probes that had run perfectly:
#
#   self-read OK: … (197 empty, skipped; 1 deliberately quarantined …)
#   NOTICE: policy "wallet_transactions_drift_probe" … does not exist, skipping
#
# The first is a passing probe describing its own coverage; the second is
# Postgres narrating `drop policy if exists`. A detector that reads either as
# "this probe did nothing" is worse than no detector, because it would train
# everyone to ignore the SKIP line.
# ── the anchor family must be the same afterwards ───────────────────────────
#
# Probes are free to create their own families — several do, and their names say
# what they test ("Offer Makers", "Auction Bidders"). What they must not do is
# leave rows in the SEEDED ANCHOR FAMILY, which holds tens of thousands of rows
# across ~199 tables and is what the erasure probe deletes, what demos render,
# and what other probes assert household shape against.
#
# Two did. `wallet-concurrency-check` left a member called "Race Child" and
# `wallet-write-rls-check` left one called "Probe Kid" — the latter for a week,
# across many runs. Both cleared their fixtures at the START of a run, which
# makes a probe repeatable and does not make it clean. Neither was found by
# looking for it: a cross-family sweep counted a member in the anchor family
# that none of its own fixtures had created.
#
# So the suite notices now. Reported rather than failed, because a probe may one
# day have a good reason to seed there — but it will have to say so out loud
# instead of leaving it for someone to find a week later.
ANCHOR_FID=${ANCHOR_FID:-00000000-0000-4000-8000-0000000000f1}
anchor_snapshot() {
  psql -At -F'=' -v ON_ERROR_STOP=0 <<SQL 2>/dev/null
select c.relname, (xpath('/row/c/text()',
         query_to_xml(format('select count(*) as c from public.%I where family_id = ''%s''',
                             c.relname, '$ANCHOR_FID'), false, true, '')))[1]::text::bigint as n
from pg_class c
join pg_namespace ns on ns.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attname = 'family_id'
                    and a.attnum > 0 and not a.attisdropped
where ns.nspname = 'public' and c.relkind = 'r'
order by c.relname;
SQL
}
ANCHOR_BEFORE=$(anchor_snapshot)

failed=()
skipped=()
for f in "${probes[@]}"; do
  name=$(basename "$f")
  if out=$(psql -v ON_ERROR_STOP=1 -f "$f" 2>&1); then
    if echo "$out" | grep -q "PROBE-SKIPPED:"; then
      skipped+=("$name")
      echo "SKIP  $name"
      echo "$out" | grep "PROBE-SKIPPED:" | sed 's/^.*WARNING:  /        /'
    else
      echo "PASS  $name"
      echo "$out" | grep -iE "NOTICE:.*(OK|PASSED)" | sed 's/^.*NOTICE:  /        /'
    fi
  else
    failed+=("$name")
    echo "FAIL  $name"
    echo "$out" | grep -iE "ERROR|FATAL" | head -5 | sed 's/^/        /'
  fi
done

ANCHOR_AFTER=$(anchor_snapshot)
if [ -n "$ANCHOR_BEFORE" ] && [ "$ANCHOR_BEFORE" != "$ANCHOR_AFTER" ]; then
  echo
  echo "ANCHOR FAMILY CHANGED — a probe seeded or removed rows in the shared seeded family:"
  diff <(printf '%s\n' "$ANCHOR_BEFORE") <(printf '%s\n' "$ANCHOR_AFTER") | grep -E '^[<>]' | sed 's/^/        /'
  echo "        (probes should create their own family, or clear their fixtures at the END of the run as well as the start)"
fi

echo
echo "== probes: $(( ${#probes[@]} - ${#failed[@]} - ${#skipped[@]} ))/${#probes[@]} passed, ${#skipped[@]} skipped, ${#failed[@]} failed =="
if [ ${#skipped[@]} -ne 0 ]; then
  echo "SKIPPED PROBES (ran nothing — the environment could not support them): ${skipped[*]}"
  # Skipping is legitimate for someone reproducing a failure by hand on a
  # server without dblink or plpgsql_check. It is NOT legitimate in CI, which
  # exists to prove these boundaries hold — a suite that quietly runs 44 of 45
  # is how a dead feature stays green. CI sets PROBES_REQUIRE_ALL=1 and the
  # workflow installs what the skipping probes need.
  if [ -n "${PROBES_REQUIRE_ALL:-}" ]; then
    echo "PROBES_REQUIRE_ALL is set: a skipped probe is a failure here."
    exit 1
  fi
fi
if [ ${#failed[@]} -ne 0 ]; then
  echo "FAILED PROBES: ${failed[*]}"
  exit 1
fi
