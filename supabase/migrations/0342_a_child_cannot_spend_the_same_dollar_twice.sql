-- Bubaly :: 0342 - a child cannot spend the same dollar twice
--
-- ── The defect (Q-01) ───────────────────────────────────────────────────────
--
-- `debitSpendBucket` (lib/wallet/server.ts) is the single place spend leaves a
-- wallet, and it decided with a read and then wrote with an insert — two
-- separate PostgREST round trips from a Node process, with nothing held in
-- between:
--
--   const { bucketId, available } = await bucketBalanceCents(supabase, …);  -- READ
--   if (!params.requiresApproval && amount > available) return …;           -- DECIDE
--   await supabase.from('wallet_transactions').insert({ … });               -- WRITE
--
-- Two spends of $8 arriving together against $10 — one parent with two tabs,
-- two parents in the same minute, a double-submitted form — both read
-- `available = 1000`, both pass `amount > available`, and both insert a
-- `completed` debit. The ledger ends at **-$6.00**, permanently, because the
-- ledger is immutable: a correction is a new credit, never an edit.
--
-- Nothing else was standing behind that check, and each half was confirmed
-- against the replayed database rather than assumed:
--
--   * no unique index applies. The only partial unique index on
--     `wallet_transactions` is `uq_wallet_txn_chore_payout` (0316), scoped
--     `where related_type = 'chore_assignments'`;
--   * no trigger. The only non-internal trigger on the table is
--     `trg_wallet_transactions_updated_at`;
--   * no CHECK constrains the balance. `wallet_transactions_amount_cents_check`
--     is `amount_cents >= 0` and the sign lives in `direction`, so a negative
--     balance is perfectly representable.
--
-- The paging half of this read was already repaired — `bucketBalanceCents` goes
-- through `readAll` — and that is a different property. Paging makes the read
-- complete; it does not make it a decision. `readAll` issues N independent HTTP
-- requests in N snapshots, so even the number it returns is not a consistent
-- read of the ledger, and by the time the insert is sent it is a memory.
--
-- ── Why this is the last one ────────────────────────────────────────────────
--
-- Every other money mutation in this database already decides under a lock, and
-- this was the single path still writing the ledger from TypeScript:
--
--   wallet_credit_child_ledger  0205  child_wallets, then all four buckets
--   wallet_transfer             0205  both wallets `order by id`, then spend
--   wallet_approve_gift         0205  gift_payments, then the credit helper
--   wallet_decide_spend         0205  approval, held txn, then the spend bucket
--   wallet_decide_allowance     0205  approval, then the credit helper
--   wallet_fund_goal            0208  goal, wallet, then the save bucket
--   wallet_reserve_card_auth    0155  the spend bucket
--
-- So the APPROVAL half of a spend request was already safe: `wallet_decide_spend`
-- re-sums under the bucket lock and returns `insufficient_funds`. It was the
-- ADMISSION half — the direct spend, and the held debit's insert — that ran
-- outside one.
--
-- ── The fix ────────────────────────────────────────────────────────────────
--
-- `wallet_debit_spend_bucket` is modelled on `wallet_reserve_card_auth` (0155),
-- which has solved exactly this problem for card authorizations since PAY-1:
--
--   1. take `FOR UPDATE` on the child's `spend` bucket row — one row, the
--      natural per-child mutex, and the FIRST statement after the guards, so
--      everything after it is serialized per child;
--   2. total the ledger INSIDE that lock;
--   3. refuse if the spend does not fit;
--   4. insert the debit;
--   5. return a result that says which of those happened.
--
-- The bucket row is not where the money is. It is a sentinel every concurrent
-- spender for that child has to queue on, which is the whole mechanism: the
-- second caller's sum is taken after the first caller's debit is in its
-- transaction, so it sees it.
--
-- **The total counts `('completed', 'processing')`, exactly as 0155 does.** That
-- is not a detail — `bucketBalanceCents` counts `completed` only, so a live card
-- hold was invisible to it, and a child could tap their card at a shop for $8
-- and have an $8 in-app spend approved against the same $10 in the same second.
-- Two paths that spend the same money now read the same number.
--
-- `requires_parent_approval` is deliberately NOT counted, and the held branch is
-- deliberately NOT refused on balance. A held debit has moved nothing; it is an
-- inert row that `wallet_decide_spend` promotes later, under its own lock,
-- re-summing then. Counting it here would mean a second request a parent has not
-- yet seen blocks a first one they may be about to decline — a product rule
-- nobody has made, made silently inside money code. The application's own
-- admission check (app/(app)/wallet/actions.ts) is unchanged and still bounds
-- what may be asked for.
--
-- ── Authorization: this RESTATES the table's policy, it does not invent one ──
--
-- `SECURITY DEFINER` bypasses RLS, so a function that writes this table has to
-- say for itself what RLS would have said. `wallet_transactions` carries
-- `wallet_transactions_mng_insert` and the restrictive
-- `wallet_transactions_manager_insert_guard` (0254/0275/0290), both
-- `with check (can_manage_family(family_id))` — and `can_manage_family` is
-- role-aware here (`role in ('parent','adult') and is_active`), the same set as
-- `isManager` in lib/constants/roles.ts. So the opening guard is
-- `wallet_decide_spend`'s, character for character:
--
--   auth.uid() is null or p_actor_id is distinct from auth.uid()
--     or not public.can_manage_family(p_family_id)  -> 'forbidden'
--
-- which is membership, the manager rule the table already enforces, and 0333's
-- actor honesty (the row says who actually filed it) in one line.
--
-- **What that does NOT do, stated plainly so it is not mistaken for an
-- oversight:** a CHILD filing a spend request is refused by this function, and
-- is refused by RLS today for the same reason. `requestSpendAction` is written
-- as though a child can ask — "they can always *ask*, which is the whole point
-- of a spend request" — but the manager-only INSERT policy has meant otherwise
-- since 0254, so on this schema the child's held debit already comes back
-- 42501. Making the definer function let it through would be a real product
-- decision (which non-manager may create which held ledger rows), with its own
-- approval, and it is not this migration's to make. This one closes a race
-- without moving a boundary. The refusal does get an honest message instead of
-- a raw policy error.
--
-- ── Idempotency ────────────────────────────────────────────────────────────
--
-- 0155 keys on `stripe_ref` with an in-lock `exists`, and that works there only
-- because every authorization for a child passes through the same bucket row —
-- there is no unique index on `stripe_ref` at all. Two caveats came out of
-- reading it: the `exists` is scoped by NEITHER `family_id` NOR `bucket_id` (it
-- is a cross-family read, safe only because Stripe ids are globally unique), and
-- it is scoped to `status = 'processing'`, so a replay after capture places a
-- fresh hold.
--
-- The spend path has no Stripe ref. It has `related_type` / `related_id`, which
-- for a caller that supplies both IS a natural key — one debit per related row.
-- So the same in-lock approach is taken, with the scoping 0155 lacks: the
-- lookup is `family_id = p_family_id and bucket_id = v_bucket`, and it counts
-- `requires_parent_approval`, `processing` and `completed` so a replay cannot
-- slip past a held or captured twin. A `cancelled` or `failed` predecessor is
-- correctly not a match — that debit did not happen.
--
-- `requestSpendAction` passes `related_type = 'spend_request'` and NO
-- `related_id`, so the key is incomplete and this branch is inert on the path
-- this migration was written for. It is stated rather than skipped because a
-- caller-supplied key with an unscoped lookup is how a cross-family defect gets
-- copied, and the next caller to pass a `related_id` should find the rule here.
--
-- ── The audit row moves into the transaction ────────────────────────────────
--
-- `debitSpendBucket` wrote its `wallet_audit_logs` row from TypeScript after the
-- insert — a second network call that could fail on its own, leaving money moved
-- with no trail. It is written here instead, in the same transaction as the
-- debit, with the same `debit_<type>` action string and the same detail text, so
-- the trail reads identically and the TypeScript call is removed rather than
-- duplicated. This is what 0205's header means by committing "the complete
-- operation as one transaction".
--
-- ── Grants ──────────────────────────────────────────────────────────────────
--
-- `authenticated` only, matching every 0205/0208 money RPC. NOT `service_role`:
-- the one caller is a cookie-bound server action, the guard refuses a session
-- with no `auth.uid()` anyway, and the webhook already has its own pair
-- (`wallet_reserve_card_auth`, `debitCardSpend`). NOT `anon`, NOT `public`.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).
--
-- Additive and idempotent: one `create or replace function`, its comment, its
-- grants, and a verification block that fails loudly rather than reporting a
-- success it did not achieve.

create or replace function public.wallet_debit_spend_bucket(
  p_family_id uuid,
  p_child_wallet_id uuid,
  p_amount bigint,
  p_type public.wallet_txn_type,
  p_description text,
  p_actor_id uuid,
  p_requires_approval boolean default false,
  p_approved_by uuid default null,
  p_related_type text default null,
  p_related_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_held      boolean := coalesce(p_requires_approval, false);
  v_status    public.wallet_txn_status;
  v_bucket    uuid;
  v_spendable bigint;
  v_existing  uuid;
  v_existing_status public.wallet_txn_status;
  v_txn       uuid;
  v_metadata  jsonb;
  v_description text;
begin
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  end if;

  -- Restates wallet_transactions' own INSERT policy (see the header): a family
  -- manager, acting as themselves. SECURITY DEFINER skips RLS, so this has to
  -- say what RLS would have said.
  if auth.uid() is null
     or p_actor_id is distinct from auth.uid()
     or not public.can_manage_family(p_family_id) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  -- The wallet has to be this family's. Without this the family id and the
  -- wallet id are two unrelated parameters and a manager of A could debit B.
  perform 1 from public.child_wallets
   where id = p_child_wallet_id and family_id = p_family_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'wallet_not_found');
  end if;

  v_status := case when v_held then 'requires_parent_approval' else 'completed' end;
  v_metadata := case when jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) = 'object'
                     then coalesce(p_metadata, '{}'::jsonb) else '{}'::jsonb end;
  v_description := coalesce(nullif(trim(coalesce(p_description, '')), ''), 'Spend');

  -- THE LOCK. The child's spend bucket is one row and the natural per-child
  -- mutex: every concurrent spender for this child queues here, so the total
  -- below is taken after any debit already in flight, not beside it.
  select id into v_bucket
    from public.wallet_buckets
   where family_id = p_family_id and child_wallet_id = p_child_wallet_id and kind = 'spend'
   for update;
  if v_bucket is null then
    return jsonb_build_object('ok', false, 'reason', 'spend_bucket_missing');
  end if;

  -- Idempotency, in the lock and scoped to this family's bucket. Only when the
  -- caller gave a COMPLETE key; a cancelled or failed predecessor is not a
  -- match, because that debit did not happen.
  if p_related_type is not null and p_related_id is not null then
    select id, status into v_existing, v_existing_status
      from public.wallet_transactions
     where family_id = p_family_id
       and bucket_id = v_bucket
       and related_type = p_related_type
       and related_id = p_related_id
       and direction = 'debit'
       and status in ('requires_parent_approval', 'processing', 'completed')
     order by created_at
     limit 1;
    if found then
      return jsonb_build_object(
        'ok', true, 'transaction_id', v_existing, 'status', v_existing_status, 'idempotent', true);
    end if;
  end if;

  -- The total, INSIDE the lock, over money that is committed or held. 0155
  -- counts the same two statuses, so a live card hold and an in-app spend can no
  -- longer each be approved against the same dollar.
  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0)
    into v_spendable
    from public.wallet_transactions
   where family_id = p_family_id
     and bucket_id = v_bucket
     and status in ('completed', 'processing');

  -- A held debit moves nothing and is re-checked by wallet_decide_spend under
  -- this same lock before it posts, so it is admitted; a debit that posts NOW
  -- has to fit now.
  if not v_held and p_amount > v_spendable then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_funds', 'available', v_spendable);
  end if;

  insert into public.wallet_transactions
    (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents,
     description, related_type, related_id, created_by, approved_by, metadata)
  values
    (p_family_id, p_child_wallet_id, v_bucket, p_type, v_status, 'debit', p_amount,
     v_description, p_related_type, p_related_id, p_actor_id,
     case when v_held then null else coalesce(p_approved_by, p_actor_id) end,
     v_metadata)
  returning id into v_txn;

  -- In the same transaction as the debit, so money cannot move without a trail.
  insert into public.wallet_audit_logs
    (family_id, actor_user_id, action, entity_type, entity_id, detail)
  values
    (p_family_id, p_actor_id, 'debit_' || p_type::text, 'child_wallets', p_child_wallet_id,
     v_description || ' (' || p_amount::text || 'c)'
       || case when v_held then ' — pending approval' else '' end);

  return jsonb_build_object(
    'ok', true,
    'transaction_id', v_txn,
    'status', v_status,
    'available', v_spendable,
    'idempotent', false);
end;
$$;

comment on function public.wallet_debit_spend_bucket(uuid, uuid, bigint, public.wallet_txn_type, text, uuid, boolean, uuid, text, uuid, jsonb) is
  'The one place a spend leaves a wallet (0342, Q-01). Locks the child''s spend bucket FOR UPDATE, totals the committed and held ledger (status in completed, processing — the same two 0155 counts, so a live card hold is visible to an in-app spend) INSIDE that lock, refuses an immediate debit that does not fit with reason insufficient_funds and the available cents, inserts the debit and its wallet_audit_logs row in one transaction, and returns jsonb {ok, reason, transaction_id, status, available, idempotent}. Replaces a read-then-insert in lib/wallet/server.ts where two concurrent $8 spends against $10 both posted. A held (requires_parent_approval) debit is admitted without a balance refusal because it moves nothing and wallet_decide_spend re-sums under this same lock before it posts. Authorization RESTATES wallet_transactions'' manager-only INSERT policy rather than inventing one: an authenticated family manager acting as themselves. Idempotent per (family, spend bucket, related_type, related_id) when the caller supplies a complete key — unlike 0155''s stripe_ref check, the lookup is family- and bucket-scoped.';

revoke all on function public.wallet_debit_spend_bucket(uuid, uuid, bigint, public.wallet_txn_type, text, uuid, boolean, uuid, text, uuid, jsonb) from public, anon;
grant execute on function public.wallet_debit_spend_bucket(uuid, uuid, bigint, public.wallet_txn_type, text, uuid, boolean, uuid, text, uuid, jsonb) to authenticated;

-- A migration that silently created something weaker than it describes is worse
-- than one that failed: the probe would be asserting a boundary that is only
-- half there.
do $$
declare
  v_oid oid;
  v_src text;
begin
  select p.oid into v_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'wallet_debit_spend_bucket';
  if v_oid is null then
    raise exception '0342: public.wallet_debit_spend_bucket was not created';
  end if;

  if not (select prosecdef from pg_proc where oid = v_oid) then
    raise exception '0342: wallet_debit_spend_bucket is not SECURITY DEFINER — it cannot restate the policy it bypasses';
  end if;

  -- Read out of the catalogue, not out of this file, so a later definition that
  -- drops the lock cannot pass by having once been correct.
  --
  -- AND WITH THE `--` COMMENTS STRIPPED, which is not fussiness. The first
  -- version of this block scanned `prosrc` whole, and
  -- docs/audit/a-child-cannot-spend-the-same-dollar-twice-check.sql caught what
  -- that costs: a body whose `for update` had been deleted, leaving the WORDS
  -- `for update` behind in the comment that said the guard was removed, applied
  -- cleanly and printed the success line below — "a spend is decided and
  -- written under one lock" — over a function that does not lock. Two
  -- connections then both spent the same $10. A shape check that reads comments
  -- is not checking the code, and this repo has now made that mistake in a
  -- source-shape test, in a document guard and in a probe's own restore
  -- assertion. Stripping is still only a shape check: the RACE in that probe is
  -- what actually proves the lock, and this is here to stop a migration
  -- CLAIMING what only the probe can establish.
  v_src := regexp_replace(
             (select prosrc from pg_proc where oid = v_oid), '--[^\n]*', '', 'g');

  if v_src not like '%for update%' then
    raise exception '0342: wallet_debit_spend_bucket no longer takes FOR UPDATE — the race it exists to close is open again';
  end if;
  if v_src not like '%''completed'', ''processing''%' then
    raise exception '0342: wallet_debit_spend_bucket no longer totals completed + processing — a live card hold would be invisible to an in-app spend';
  end if;
  if v_src not like '%can_manage_family%' or v_src not like '%auth.uid()%' then
    raise exception '0342: wallet_debit_spend_bucket no longer restates the manager-only INSERT policy it bypasses';
  end if;
  if v_src not like '%insufficient_funds%' then
    raise exception '0342: wallet_debit_spend_bucket no longer refuses an overdraw';
  end if;

  if not has_function_privilege('authenticated', v_oid, 'EXECUTE') then
    raise exception '0342: authenticated cannot execute wallet_debit_spend_bucket — the spend path is broken';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_function_privilege('anon', v_oid, 'EXECUTE') then
    raise exception '0342: anon can execute wallet_debit_spend_bucket';
  end if;

  raise notice '0342 OK: a spend is decided and written under one lock over the committed and held ledger, by a manager acting as themselves.';
end
$$;
