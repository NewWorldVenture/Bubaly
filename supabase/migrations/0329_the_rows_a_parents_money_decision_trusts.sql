-- The rows a parent's money decision trusts are written by parents. (SEC-017)
--
-- 0217 locked the money tables to managers after a child minted wallet credit
-- through PostgREST. It took five of the tables 0088 created —
-- family_wallets, child_wallets, wallet_buckets, wallet_transactions,
-- wallet_rules — and left the rest of 0088's "Members manage <t>" FOR ALL
-- policies in place. Four of those are rows a parent's money decision is made
-- FROM, so whoever writes them decides where the money goes:
--
--   gift_payments  `wallet_approve_gift` credits the wallet and amount the
--                  pending row names at the moment a parent approves it
--   gift_links     decide which child a pledge from the public page is for
--   pay_handles    route a public Pay-ID to a child's gift link
--   wallet_goals   `saved_cents` and `status` are what a parent reads to decide
--                  a goal is reached; `child_wallet_id` is whose savings
--                  `wallet_fund_goal` debits
--
-- Measured with real sessions, a parent and two children:
--
--   Grandma pledges $50.00 to Sister                  (public path, service role)
--   Brother updates it to $500.00, to his own wallet  -> allowed
--   Brother inserts "Uncle Joe", $20,000.00, to him   -> allowed
--   Brother repoints Sister's gift link at himself    -> allowed
--   the parent approves the queue                     -> both credited
--
--   Sister: $0.00    Brother: $20,500.00
--
-- The invented gift is twenty times the $1,000 cap the public path enforces,
-- because a direct insert never meets that clamp, and nothing in the approval
-- queue distinguishes a pledge a relative made from one a child typed in.
-- Separately, a child set a $300 goal to saved_cents 30000, status 'reached',
-- with zero ledger rows behind it.
--
-- ── the rule ────────────────────────────────────────────────────────────────
--
-- Writes are managers-only, in 0217's shape: RESTRICTIVE insert/update/delete
-- guards that AND with the existing family policy, so nothing a manager could
-- do changes. SELECT is untouched — a child still sees the gifts sent to them
-- and the goals they are saving for. Managers-only is not an over-correction:
-- every product writer is already parent-only (createGoalAction, fundGoalAction,
-- claimPayHandleAction, releasePayHandleAction, the create-link and dismiss
-- actions) or runs as the service role (the public pledge) or SECURITY DEFINER
-- (the approval and funding RPCs). The probe asserts those paths as controls.
--
-- Deliberately NOT here: the other 0088-pattern tables. Most are collaborative
-- by design (trips, polls, meal votes, plans) and OPEN-001 records that as an
-- owner decision; babysitter_payments records payments made to a sitter and
-- never credits a wallet.

do $$
declare
  t text;
begin
  foreach t in array array['gift_links', 'gift_payments', 'pay_handles', 'wallet_goals'] loop
    if to_regclass(format('public.%I', t)) is null then continue; end if;
    execute format('drop policy if exists %1$s_manager_insert_guard on public.%1$I', t);
    execute format('drop policy if exists %1$s_manager_update_guard on public.%1$I', t);
    execute format('drop policy if exists %1$s_manager_delete_guard on public.%1$I', t);
    execute format('create policy %1$s_manager_insert_guard on public.%1$I as restrictive for insert to authenticated with check (public.can_manage_family(family_id))', t);
    execute format('create policy %1$s_manager_update_guard on public.%1$I as restrictive for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t);
    execute format('create policy %1$s_manager_delete_guard on public.%1$I as restrictive for delete to authenticated using (public.can_manage_family(family_id))', t);
    -- anon has no business writing any of these; the public pages write through the service role.
    execute format('revoke insert, update, delete on public.%I from anon', t);
  end loop;
end $$;

-- ── self-check ──────────────────────────────────────────────────────────────
do $$
declare
  n int;
begin
  select count(*) into n
    from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname in ('gift_links', 'gift_payments', 'pay_handles', 'wallet_goals')
     and p.polname like '%\_manager\_%\_guard' and not p.polpermissive;
  if n <> 12 then
    raise exception '0329: expected 12 restrictive manager guards on the four tables, found %', n;
  end if;
end $$;
