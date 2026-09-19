-- Bubaly :: 0316 - a chore is paid once, and the database is what says so
--
-- `payChoreRewardAction` states the invariant in its own comment:
--
--     // Already paid? (one wallet credit per assignment)
--     const { data: existing } = await supabase.from('wallet_transactions')
--       .select('id')
--       .eq('family_id', familyId)
--       .eq('related_type', 'chore_assignments')
--       .eq('related_id', assignment.id).limit(1);
--     if ((existing ?? []).length > 0) return { ok: false, error: '…already paid' };
--
-- and then enforces it with a SELECT followed by an INSERT. Nothing in the
-- schema backs it: `wallet_transactions` carries no unique index on those
-- columns at all. Two "Pay" clicks that arrive together both read zero rows and
-- both credit the child's wallet. Real money, minted twice.
--
-- ── the key is not the obvious one ──────────────────────────────────────────
--
-- A unique index on (family_id, related_type, related_id) is the shape this
-- looks like, and it is wrong twice over. Both were found by reading the
-- writers rather than the guard:
--
--   1. `related_type = 'allowance_rules'` is RECURRING. A rule credits every
--      week carrying the same related_id, so that index would break allowances
--      on the second payment. This index is therefore scoped to
--      chore_assignments, the one related_type that is genuinely once-per-row.
--
--   2. `creditChildWallet` writes ONE ROW PER BUCKET for a single credit — all
--      of them carrying the same related_type and related_id. Measured, for a
--      4,000c chore payout under the default 40/40/10/10 split:
--
--        parts: {"spend":1600,"save":1600,"give":400,"invest":400}
--        ledger rows written: 4
--
--      So even scoped to chore_assignments, a three-column index would reject
--      the FIRST payout, not the second. `bucket_id` is what tells the four
--      rows of one credit apart from a second credit.
--
-- The rows of one payout go in through a single multi-row INSERT, so a second
-- payout collides on its first bucket and the whole statement is refused —
-- there is no half-credited wallet.
--
-- Nothing else is changed. `spend_request` debits pass no related_id at all and
-- fall outside the partial index; allowance credits are excluded by the
-- related_type predicate.

do $$
declare
  dupes int;
begin
  if to_regclass('public.wallet_transactions') is null then
    return;
  end if;

  -- A unique index cannot be created over rows that already violate it, and
  -- silently repairing a money ledger is not this migration's business. Count
  -- first and say exactly what is in the way.
  select count(*) into dupes from (
    select 1 from public.wallet_transactions
    where related_type = 'chore_assignments' and related_id is not null and bucket_id is not null
    group by family_id, related_id, bucket_id
    having count(*) > 1
  ) d;

  if dupes > 0 then
    raise exception
      'wallet_transactions already holds % chore payout(s) credited more than once into the same bucket; that is the very defect this index prevents and the rows need a decision before it can be created',
      dupes;
  end if;

  create unique index if not exists uq_wallet_txn_chore_payout
    on public.wallet_transactions (family_id, related_id, bucket_id)
    where related_type = 'chore_assignments'
      and related_id is not null
      and bucket_id is not null;
end
$$;

comment on index public.uq_wallet_txn_chore_payout is
  'One wallet credit per chore assignment per bucket. payChoreRewardAction states this invariant and checked it with a SELECT before its INSERT; this is what makes two simultaneous "Pay" clicks impossible rather than merely unlikely. Keyed on bucket_id because creditChildWallet writes one row per bucket for a single credit (0316).';
