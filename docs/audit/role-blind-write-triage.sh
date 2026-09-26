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
# false positive costs one file read, a false negative hides a defect.
#
# An earlier version used `from('<table>')` for BOTH tests and published
# 46 / 22 / 180 on that basis. The NO-WRITER figure was wrong. Four of those 22
# — auto_insurance_policies, rental_cars, vehicle_inspections and
# vehicle_registrations — are written by
# `saveRow(supabase, 'auto_insurance_policies', …)` and
# `softDelete(supabase, 'vehicle_registrations', …)` in
# app/(app)/dashboard/auto/actions.ts, which passes the table as an ARGUMENT and
# reaches PostgREST as `from(table as 'vehicles')`. No `from('<table>')` regex
# can see it, and the repo has ~200 such non-literal `.from(` call sites. The
# corrected split is 46 / 18 / 184; see the two tests above. (Those four are not
# defects either — that file contains no manager gate at all — but "nothing
# writes this table" was a false statement about a live feature.)
#
# A table written ONLY through a SECURITY DEFINER RPC, naming itself nowhere in
# TypeScript, still reads as NO-WRITER. That limit remains, and it is why
# NO-WRITER is a question for a human and not a verdict.
#
# ── The proximity pass, and why it is reported but NOT used to narrow ───────
# SUSPECT is file-level co-occurrence, which over-approximates badly. The
# obvious refinement is proximity: does a manager gate appear within N lines of
# an actual write? Run over the 46 SUSPECT tables it reduced them to FIVE —
# wallet_cards, wallet_passes, wallet_rewards, subscriptions_tracked and
# dashboard_layout_events — and every one of the five was read and every one is
# NOT a defect. Three different mechanisms produced those five false positives,
# and they are written down because each would have produced a wrong verdict on
# its own:
#
#   1. THE NEIGHBOURING FUNCTION. `app/(app)/wallet/hub-actions.ts` gates
#      `addAccountAction` with isManager and then defines addCardAction,
#      addPassAction and addRewardAction directly beneath it with NO gate. The
#      window caught the gate above. Worse, the file makes the intent explicit:
#      `MANAGER_ONLY_DELETES` is narrowed to financial_accounts and
#      transactions, with the comment "a teen tidying their own wallet cards,
#      passes and rewards is not what 0267 is about". The application does not
#      claim the rule the census inferred. This is CENSUS-002 one level finer.
#
#   2. THE IMPORT LINE. `components/modules/subscriptions-module.tsx` writes
#      subscriptions_tracked at lines 82-83; the only thing matching the gate
#      pattern inside the window is `import { isManager }` on line 24. The real
#      gate is `canReview` on line 218, and it governs an AI candidate-review
#      feature in a DIFFERENT component.
#
#   3. THE GATE GOVERNS A DIFFERENT TABLE. `app/(app)/dashboard/customize-
#      actions.ts` guards saving a layout with canCustomizeDashboard(); the
#      write the window found is `logEvent`, a telemetry insert into
#      dashboard_layout_events. The guarded resource is dashboard_layouts,
#      closed separately by 0325. (The event row's `user_id` is still forgeable
#      by any member — that is the AUDIT-002 attribution class, not this one,
#      and it is recorded there rather than counted here.)
#
# So proximity is printed as EVIDENCE and never used to shrink the list. A
# narrowing heuristic whose every hit was a false positive has no business
# deciding which names a human reads. Equally, zero hits is not absolution:
# `calendar_events` has 18 write sites and no gate within 60 lines of any of
# them, and AUTHZ-021 is a real, reproduced finding on it — because AUTHZ-021 is
# an ATTRIBUTION defect, not a role-gate mismatch. This instrument answers one
# question and its silence on the others means nothing.
#
# ── The enclosing-function pass, also reported, also not used to narrow ────
# Proximity's weakness is obvious: sixty lines is an arbitrary window. The
# principled version asks whether a manager gate appears anywhere in the
# top-level function CONTAINING the write. Run over the same 46 it finds SEVEN
# — the three wallet tables plus medication_doses, daily_insights,
# maintenance_tasks and routine_templates. It correctly drops
# subscriptions_tracked, whose only nearby match was an import line.
#
# All seven were read. None is a defect. That is twelve distinct candidate hits
# across two independent heuristics and zero findings, and it adds a FOURTH
# false-positive mechanism to the three above — the most interesting one:
#
#   4. THE GATE IS A DIFFERENT CODE PATH WITH A DIFFERENT INTENT.
#      `routine_templates` looked like the real thing: `forgetRoutine`
#      (lib/services/memory/index.ts:607) is documented "Family-scoped and
#      manager-only" and enforces `if (!canManage(scope)) return fail('Only a
#      parent or adult can forget a routine.')`, while the table's DELETE policy
#      is bare `is_family_member`. A textbook AUTHZ-011 shape.
#      It is not one. `components/modules/routines-panel.tsx:177` — the panel
#      the family actually uses — deletes the same rows through
#      `createClient()` with NO role gate, and that file contains no isManager,
#      canManage, manager or role check at all. The application does not claim
#      the rule: `forgetRoutine` is the Settings → Bubaly AI "forget what you
#      learned" path, manager-only because it is an AI-memory action, not
#      because routine templates belong to parents. Restricting the table would
#      refuse every child and teen on the routines panel.
#      Its component-scale variant produced the other three: a gate anywhere in
#      a 700-line React component flags every write in it, which is how
#      medication_doses (AUTHZ-017 already recorded it as a false positive for
#      this class), daily_insights (a system-generated insight upsert; the
#      `manager` there is passed as a prop to a child component) and
#      maintenance_tasks (`completeTask` — a teen marking a chore done is the
#      point) arrived.
#
# The conclusion both passes support: these heuristics do not find the real
# ones. The ten real findings this audit has made on this list were all found by
# READING the call sites, and the list is what says which sites to read.
#
# Exits 0 whichever way the counts fall. This measures; it does not gate.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# The census exits 2 when it cannot reach the database. That status used to be
# discarded here, so an unreachable database and a genuinely clean schema both
# arrived as an empty `tables` and both exited 0 — and the message below offers
# the flattering reading first. "Exits 0 whichever way the counts fall" is the
# right design for a measurement, but a census that could not RUN has no counts
# to fall either way, so it is not covered by that sentence.
tables=$(bash docs/audit/role-blind-write-census.sh --tables); census_status=$?
if [ "$census_status" -ne 0 ]; then
  echo "the census FAILED (exit ${census_status}) — it could not read the database, so nothing below was measured."
  echo "this is NOT 'every write boundary is closed'. point PGHOST/PGUSER/PGDATABASE at the replayed database and re-run."
  exit "$census_status"
fi
if [ -z "$tables" ]; then
  echo "the census ran and returned no open tables — every role-blind write boundary is closed on this schema"
  exit 0
fi

SRC=(app lib components hooks)
GATE='isManager|requireManager|canManage|can_manage_family|assertManager|managerOnly'

# ── Two tests, each used where its error is the SAFE one ────────────────────
# NARROW is `from('<table>')`. It is precise about writes and it MISSES a
# writer that passes the table name as an argument —
# `saveRow(supabase, 'auto_insurance_policies', …)` in
# app/(app)/dashboard/auto/actions.ts is exactly that shape, and there are ~200
# `.from(<non-literal>)` call sites in this repo.
#
# WIDE is "the name appears as a string literal anywhere under app/, lib/ or
# components/", excluding the generated database.types.ts (which names every
# table with an unquoted key, so it would match everything). It catches the
# parameterised writers and also catches mere mentions — a table listed in
# lib/ai/context/policy.ts for redaction is not a write.
#
# So: NO-WRITER uses WIDE, because "nothing in the application writes this" is
# the claim that must not over-reach, and a false NO-WRITER is the one that
# would send someone to revoke DML on a live feature. SUSPECT uses NARROW,
# because it is a list of call sites for a human to READ and the wide test
# inflates it from 46 to 99 with files that only mention the name.
# The two are disjoint — a table with no literal anywhere cannot have a
# `from('t')` — so CONSISTENT is the remainder and the three still partition.
suspect=(); nowriter=(); consistent=()
for t in $tables; do
  mentions=$(grep -rl --include=*.ts --include=*.tsx "['\"]${t}['\"]" "${SRC[@]}" 2>/dev/null | grep -v 'database.types.ts' || true)
  if [ -z "$mentions" ]; then
    nowriter+=("$t"); continue
  fi
  writers=$(grep -rl --include=*.ts --include=*.tsx -E "from\((['\"])${t}\1\)" "${SRC[@]}" 2>/dev/null || true)
  if [ -n "$writers" ] && echo "$writers" | xargs -r grep -lE "$GATE" 2>/dev/null | grep -q .; then
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

# ── Proximity: evidence for the reader, never a filter ──────────────────────
# Read the header before acting on a number here. Every hit this pass has ever
# produced was a false positive, and a table with zero hits can still be a
# defect of another class.
printf '\n-- PROXIMITY over the %d SUSPECT names (evidence only; see header) -----\n' "${#suspect[@]}"
printf '%-30s %-8s %s\n' 'table' 'writes' 'gate within 60 lines above / 20 below'
for t in "${suspect[@]:-}"; do
  [ -z "$t" ] && continue
  hits=0; near=0
  while IFS=: read -r f ln _; do
    [ -z "$f" ] && continue
    hits=$((hits+1))
    lo=$((ln>60?ln-60:1)); hi=$((ln+20))
    if sed -n "${lo},${hi}p" "$f" 2>/dev/null | grep -qE "$GATE"; then near=$((near+1)); fi
  done < <(grep -rn --include=*.ts --include=*.tsx -E "from\\((['\"])${t}\\1\\)[^;]*\\.(insert|upsert|update|delete)\\(" "${SRC[@]}" 2>/dev/null)
  printf '%-30s %-8s %s\n' "$t" "$hits" "$near"
done
# `writes=0` means the one-line regex above found nothing, NOT that the table is
# unwritten: a call chained across lines, or built through a variable, is
# invisible to it. Six of the SUSPECT names read that way and each still has a
# writer that put it in this bucket.
echo

# ── Enclosing-function pass: evidence for the reader, never a filter ────────
printf '\n-- ENCLOSING FUNCTION over the %d SUSPECT names (evidence only; see header) -----\n' "${#suspect[@]}"
SUSPECT_LIST="${suspect[*]:-}"
[ -n "$SUSPECT_LIST" ] && python3 - $SUSPECT_LIST <<'ENCLOSING'
import re, subprocess, sys

GATE = re.compile(r'\b(isManager|requireManager|canManage|can_manage_family|assertManager|managerOnly)\b')
IMPORT = re.compile(r'^\s*import\b')
# Every top-level declaration in this codebase starts at column 0.
TOPLEVEL = re.compile(r'^(export\s+)?(default\s+)?(async\s+)?(function|const|class|type|interface)\b')

def enclosing(lines, idx):
    start = 0
    for i in range(idx, -1, -1):
        if TOPLEVEL.match(lines[i]):
            start = i
            break
    end = len(lines)
    for i in range(idx + 1, len(lines)):
        if TOPLEVEL.match(lines[i]):
            end = i
            break
    return start, end

rows = []
for t in sys.argv[1:]:
    out = subprocess.run(
        ['grep', '-rn', '--include=*.ts', '--include=*.tsx', '-E',
         rf"from\((['\"]){re.escape(t)}\1\)", 'app', 'lib', 'components', 'hooks'],
        capture_output=True, text=True).stdout
    sites, hits = 0, []
    for line in out.splitlines():
        try:
            f, ln, _ = line.split(':', 2)
        except ValueError:
            continue
        sites += 1
        try:
            src = open(f, encoding='utf-8').read().split('\n')
        except OSError:
            continue
        i = int(ln) - 1
        # A PostgREST call is chained across lines here, so look ahead a little
        # before calling it a write.
        if not re.search(r'\.(insert|upsert|update|delete)\(', '\n'.join(src[i:i + 4])):
            continue
        a, b = enclosing(src, i)
        if any(GATE.search(l) for l in src[a:b] if not IMPORT.match(l)):
            hits.append(f'{f}:{ln}  in  {src[a][:66]}')
    rows.append((t, sites, hits))

rows.sort(key=lambda r: (-len(r[2]), r[0]))
for t, sites, hits in rows:
    print(f"{'GATED' if hits else '  -  '} {t:<28} sites={sites:<4} gated_fns={len(hits)}")
    for h in hits:
        print(f'          {h}')
ENCLOSING
echo
