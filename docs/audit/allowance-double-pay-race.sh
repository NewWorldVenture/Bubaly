#!/usr/bin/env bash
# ── The allowance period is paid once, by whichever run gets there first ──────
#
# Two code paths advance `allowance_rules.next_run_on` and credit a child's
# wallet: the nightly cron (`app/api/cron/wallet-allowance/route.ts`) and the
# parent's "Run now" button (`runDueAllowancesAction`). The exclusivity comes from
# CLAIMING the schedule — an update predicated on `next_run_on <= today`, so when
# two runs overlap only one matches a row; the first flips `next_run_on` into the
# future and the loser matches none and skips the credit.
#
# The cron always had that predicate. The action did not: it advanced by id alone,
# so both overlapping runs got a row back from `RETURNING` and both credited.
#
# This is a RACE, not a boundary check, so it is not in the `*-check.sql` set that
# `run-probes.sh` globs: it needs two connections and four seconds of deliberate
# overlap. Run it by hand against the throwaway harness:
#
#   bash docs/audit/verify-pg.sh up
#   bash docs/audit/allowance-double-pay-race.sh
#   bash docs/audit/verify-pg.sh down
#
# Measured 2026-09-14 against a replay of 313 migrations:
#
#   == BLIND shape — UPDATE by id only (the defect) ==
#   ledger_rows=2  cents_credited=2000
#   == CLAIMED shape — UPDATE carries next_run_on <= current_date (the fix) ==
#   ledger_rows=1  cents_credited=1000
#
# Same rule, same seconds, same ledger. The predicate is the entire difference.
# The child is paid twice from the family's money, and `wallet_transactions` is
# append-only (0088), so the correction is a manual reversal row, not a delete.
set -u
export PGHOST=${PGHOST:-/tmp/pgaudit_db} PGPORT=${PGPORT:-54399} PGUSER=${PGUSER:-postgres} PGDATABASE=${PGDATABASE:-bubaly}

FAM=00000000-0000-4000-8000-0000000000a1
WALLET=00000000-0000-4000-8000-0000000000a2
RULE=00000000-0000-4000-8000-0000000000a3
PARENT=00000000-0000-4000-8000-0000000000a4
MEMBER=00000000-0000-4000-8000-0000000000a5
KID=00000000-0000-4000-8000-0000000000a6

seed() {
  psql -q -v ON_ERROR_STOP=1 <<SQL
insert into auth.users (id, email) values ('$PARENT','race-parent@example.com') on conflict do nothing;
insert into public.families (id, name, created_by) values ('$FAM','Race House','$PARENT') on conflict do nothing;
-- A SECOND auth user for the child. Using the creator's would collide on
-- (family_id, user_id) with the member \`on_family_created\` already provisions;
-- \`on conflict do nothing\` then swallows it, the member id never exists, and both
-- shapes report 0 rows — a comparison that says nothing while looking like a pass.
insert into auth.users (id, email) values ('$KID','race-kid@example.com') on conflict do nothing;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('$MEMBER','$FAM','$KID','Kid','child',true) on conflict (id) do nothing;
delete from public.wallet_transactions where family_id = '$FAM';
delete from public.allowance_rules where id = '$RULE';
delete from public.child_wallets where id = '$WALLET';
insert into public.child_wallets (id, family_id, member_id) values ('$WALLET','$FAM','$MEMBER');
insert into public.allowance_rules (id, family_id, child_wallet_id, amount_cents, cadence, next_run_on, is_active)
  values ('$RULE','$FAM','$WALLET',1000,'weekly', current_date - 1, true);
SQL
}

# One run. \$1 is the extra predicate on the claim ('' for the blind shape). The
# 2-second sleep stands in for the creditChildWallet round trip, and the credit is
# gated on the claim's own RETURNING exactly as the code gates it on
# \`claimed\` / \`advancedRule\`.
run_one() {
  psql -q -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<SQL
do \$\$
declare claimed uuid;
begin
  perform 1 from public.allowance_rules where id = '$RULE' and next_run_on <= current_date;
  if not found then return; end if;
  perform pg_sleep(2);
  update public.allowance_rules set next_run_on = current_date + 7, last_run_on = current_date
    where id = '$RULE' and family_id = '$FAM' $1
    returning id into claimed;
  if claimed is null then return; end if;
  insert into public.wallet_transactions (family_id, child_wallet_id, direction, amount_cents, type, description, status)
    values ('$FAM','$WALLET','credit',1000,'allowance','Allowance (race)','completed');
end \$\$;
SQL
}

report() {
  psql -tA -c "select 'ledger_rows=' || count(*) || '  cents_credited=' || coalesce(sum(amount_cents),0) from public.wallet_transactions where family_id = '$FAM';"
}

echo "== BLIND shape — UPDATE by id only (the defect) =="
seed; run_one "" & run_one "" & wait; report

echo "== CLAIMED shape — UPDATE carries next_run_on <= current_date (the fix) =="
seed; run_one "and next_run_on <= current_date" & run_one "and next_run_on <= current_date" & wait; report

psql -q -c "delete from public.wallet_transactions where family_id = '$FAM'; delete from public.allowance_rules where id = '$RULE'; delete from public.child_wallets where id = '$WALLET';"
