#!/usr/bin/env bash
# ── Which of the role-blind-open tables are DEFECTS, and which are open on purpose? ──
#
# `role-blind-write-census.sh` answers "how many tables take a write from any
# household member". That number is NOT a defect count, and this audit has been
# burned once already for reading it as one (CENSUS-002). This script is the
# second half: it splits the census list into the three buckets the audit
# reasons about, by reading the CODE rather than the catalogue.
#
#   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly bash docs/audit/role-blind-write-triage.sh
#
# ── It does NOT re-derive the list, and that is the point ───────────────────
# The first version of this file carried its own copy of the census query with a
# looser definition of "bare", and reported 251 open tables where the census
# reported 248 — it counted `marketplace_listings`, `marketplace_stores` and
# `notifications`, whose write predicates pin a column beyond
# `is_family_member` (`member_id = marketplace_member_id(family_id)`,
# `user_id = auth.uid()`). Those are role-blind but CONSTRAINED, which the
# census excludes on purpose. Two derivations disagreeing by three is exactly
# CENSUS-001/-002/-003 repeating, so the list now comes from ONE place:
#
#   role-blind-write-census.sh --tables
#
# ── The buckets, and exactly what each claim rests on ───────────────────────
#
#   SUSPECT      A file that writes this table ALSO carries a manager gate
#                (isManager / requireManager / can_manage_family / canManage).
#                That is the AUTHZ-011 shape: the application gates on role and
#                the database does not, so a JWT holder walks around the server
#                action. Every name here needs its call sites read one at a
#                time — the gate may belong to a DIFFERENT operation in the same
#                file, which is precisely how CENSUS-002 happened. This bucket
#                is a QUESTION LIST, never a verdict.
#
#   NO-WRITER    Nothing under app/, lib/, components/ or hooks/ writes it.
#                Client DML is granted on a table the product never writes from
#                the client. Not exploitable on its own; it is unused surface
#                area, tracked as AUTHZ-020.
#
#   CONSISTENT   A writer exists and no manager gate sits near it. Database and
#                application AGREE. This is the large bucket and it is mostly
#                correct by design: a shared grocery list is MEANT to take a
#                write from a child. "Consistent" is a statement about the two
#                layers agreeing, NOT a clean bill of health — a table both
#                layers wrongly leave open lands here too.
#
# The grep is deliberately coarse and deliberately over-inclusive on SUSPECT: a
# false positive costs one file read, a false negative hides a defect. It
# matches the table name as a PostgREST resource — `from('<table>')` — which is
# how every client-side write in this codebase names its table, so a table
# written ONLY through a SECURITY DEFINER RPC reads as NO-WRITER here. That is a
# known limit of the method, stated rather than papered over, and it is why
# NO-WRITER is a question for a human and not a verdict.
#
# Exits 0 whichever way the counts fall. This measures; it does not gate.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

tables=$(bash docs/audit/role-blind-write-census.sh --tables)
if [ -z "$tables" ]; then
  echo "the census returned no open tables — either every write boundary is closed, or PG* is pointing somewhere unexpected"
  exit 0
fi

SRC=(app lib components hooks)
GATE='isManager|requireManager|canManage|can_manage_family|assertManager|managerOnly'

suspect=(); nowriter=(); consistent=()
for t in $tables; do
  writers=$(grep -rl --include=*.ts --include=*.tsx -E "from\((['\"])${t}\1\)" "${SRC[@]}" 2>/dev/null || true)
  if [ -z "$writers" ]; then
    nowriter+=("$t"); continue
  fi
  if echo "$writers" | xargs -r grep -lE "$GATE" 2>/dev/null | grep -q .; then
    suspect+=("$t")
  else
    consistent+=("$t")
  fi
done

total=$(( ${#suspect[@]} + ${#nowriter[@]} + ${#consistent[@]} ))
printf '\n== AUTHZ-011 triage of %d role-blind-open tables (list from role-blind-write-census.sh --tables) ==\n\n' "$total"
printf '  SUSPECT    %4d  a writer file also carries a manager gate — read each one\n' "${#suspect[@]}"
printf '  NO-WRITER  %4d  no client writer at all (AUTHZ-020 surface area)\n' "${#nowriter[@]}"
printf '  CONSISTENT %4d  writer exists, no manager gate near it — both layers agree\n' "${#consistent[@]}"

printf '\n-- SUSPECT (%d) ------------------------------------------------\n' "${#suspect[@]}"
printf '%s\n' "${suspect[@]:-(none)}" | paste -sd' ' -
printf '\n-- NO-WRITER (%d) ----------------------------------------------\n' "${#nowriter[@]}"
printf '%s\n' "${nowriter[@]:-(none)}" | paste -sd' ' -
printf '\n-- CONSISTENT (%d) ---------------------------------------------\n' "${#consistent[@]}"
printf '%s\n' "${consistent[@]:-(none)}" | paste -sd' ' -
echo
